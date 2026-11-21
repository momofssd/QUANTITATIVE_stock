"""WS /ws/live/{symbol} : live stream for one symbol.  GET /api/live/status : hub diagnostics."""
from __future__ import annotations

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ...core.symbols import clean_symbol
from ...live import hub

router = APIRouter(tags=["live"])


@router.websocket("/ws/live/{symbol}")
async def ws_live(ws: WebSocket, symbol: str):
    """Closing this socket releases the symbol; the hub then reconnects Alpaca without it (or disconnects)."""
    await ws.accept()
    sym = clean_symbol(symbol)
    if not sym:
        await ws.close(code=1008, reason="invalid symbol")
        return
    await hub.add(sym, ws)
    try:
        while True:
            await ws.receive_text()  # browser keep-alives; nothing to do
    except WebSocketDisconnect:
        pass
    finally:
        await hub.remove(sym, ws)


@router.get("/api/live/status")
async def live_status():
    """Upstream state, watched symbols, and open/closed connection counts (to verify closure on switch)."""
    return {**hub.status, "watching": {s: len(c) for s, c in hub.clients.items()}, "upstream": hub.upstream}
