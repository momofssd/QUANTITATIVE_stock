"""Live market data: one upstream Alpaca WebSocket, fanned out to browser WebSockets.

Free Alpaca accounts may hold a single market-data stream connection (and 30 symbols). The hub therefore:
  * opens the upstream connection only while at least one browser is watching a symbol,
  * closes it and opens a fresh one, subscribed to exactly the symbols still being watched,
    whenever that set changes (e.g. the user switches ticker), so nothing stale counts toward the quota,
  * closes it entirely when nobody is watching.

Trades are coalesced per symbol into ~4 updates a second (last price + high/low/volume in the window) so a busy
ticker can't flood the browser. Quotes are coalesced to the latest one. Bars are forwarded as they arrive.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections import defaultdict

from fastapi import WebSocket
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from ..alpaca_api import feeds
from ..core.config import get_settings

log = logging.getLogger("live")

STREAM_BASE = "wss://stream.data.alpaca.markets/v2"
MAX_SYMBOLS = 30          # free-plan subscription limit
RESTART_DEBOUNCE = 0.3    # seconds: merge "close old ticker" + "open new ticker" into one reconnect
FLUSH_EVERY = 0.25        # seconds between coalesced tick/quote pushes


class StreamError(Exception):
    def __init__(self, code: int, msg: str):
        super().__init__(msg)
        self.code = code
        self.msg = msg


class LiveHub:
    def __init__(self) -> None:
        self.clients: dict[str, set[WebSocket]] = defaultdict(set)
        self.status: dict = {"state": "idle", "detail": "", "feed": None, "symbols": []}
        self.stream_url_override: str | None = None  # tests: Alpaca's /v2/test stream
        self._symbols: tuple[str, ...] = ()
        self._task: asyncio.Task | None = None
        self._restart: asyncio.TimerHandle | None = None
        self._flusher: asyncio.Task | None = None
        self._lock = asyncio.Lock()
        self._ticks: dict[str, dict] = {}
        # Upstream connection bookkeeping, exposed at /api/live/status so closure can be verified.
        self.upstream: dict = {"open": None, "opened_total": 0, "closed_total": 0, "last_closed": None}
        self._quotes: dict[str, dict] = {}

    # ------------------------------------------------------------------ browser side
    async def add(self, symbol: str, ws: WebSocket) -> None:
        self.clients[symbol].add(ws)
        status = self.status
        if symbol not in self._symbols:  # upstream is about to be rebuilt for this symbol
            status = {**status, "state": "connecting", "detail": f"Switching stream to {symbol}…"}
        await self._send(ws, {"type": "status", **status})
        self._schedule_restart()
        if self._flusher is None or self._flusher.done():
            self._flusher = asyncio.create_task(self._flush_loop())

    async def remove(self, symbol: str, ws: WebSocket) -> None:
        self.clients[symbol].discard(ws)
        if not self.clients[symbol]:
            del self.clients[symbol]
            self._ticks.pop(symbol, None)
            self._quotes.pop(symbol, None)
        self._schedule_restart()

    def _wanted(self) -> tuple[str, ...]:
        return tuple(sorted(self.clients))[:MAX_SYMBOLS]

    def _schedule_restart(self) -> None:
        if self._restart is not None:
            self._restart.cancel()
        loop = asyncio.get_running_loop()
        self._restart = loop.call_later(RESTART_DEBOUNCE, lambda: asyncio.create_task(self._apply()))

    async def _apply(self) -> None:
        async with self._lock:
            wanted = self._wanted()
            running = self._task is not None and not self._task.done()
            if wanted == self._symbols and (running or not wanted):
                return
            await self._stop_upstream()  # terminate the old connection before opening a new one
            self._symbols = wanted
            if wanted:
                self._task = asyncio.create_task(self._run(wanted))
            else:
                await self._set_status("idle", "No symbols open: stream disconnected.")

    async def _stop_upstream(self) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
        self._task = None

    async def shutdown(self) -> None:
        if self._restart is not None:
            self._restart.cancel()
        await self._stop_upstream()
        if self._flusher is not None:
            self._flusher.cancel()

    # ------------------------------------------------------------------ upstream side
    async def _run(self, symbols: tuple[str, ...]) -> None:
        delay = 2.0
        while True:
            s = get_settings()
            if not s.configured:
                await self._set_status("error", "Alpaca credentials missing.")
                return
            try:
                mode = await feeds.resolve_feed_mode()
            except Exception:  # noqa: BLE001 - network hiccup; stream can still use IEX
                mode = "hybrid"
            feed = "sip" if mode == "sip" else "iex"
            url = self.stream_url_override or f"{STREAM_BASE}/{feed}"
            if self.status["state"] != "limit":  # while blocked by the limit, keep saying so between retries
                await self._set_status("connecting", f"Connecting to Alpaca {feed.upper()} stream…", feed)
            try:
                async with self._track(connect(url, close_timeout=2, open_timeout=10, ping_interval=20,
                                               max_size=2**22)) as up:
                    await self._expect(up, "connected")
                    await up.send(json.dumps({"action": "auth", "key": s.api_key, "secret": s.secret_key}))
                    await self._expect(up, "authenticated")
                    sub = list(symbols)
                    await up.send(json.dumps({"action": "subscribe", "trades": sub, "quotes": sub,
                                              "bars": sub, "updatedBars": sub, "dailyBars": sub}))
                    await self._set_status("live", f"Streaming {', '.join(symbols)}", feed)
                    delay = 2.0
                    async for raw in up:
                        for m in json.loads(raw):
                            await self._dispatch(m)
            except asyncio.CancelledError:
                raise
            except StreamError as exc:
                if exc.code == 402:  # bad credentials: retrying won't help
                    await self._set_status("error", f"Stream auth failed: {exc.msg}", feed)
                    return
                if exc.code == 406:
                    await self._set_status(
                        "limit", "Alpaca allows one stream connection on this plan and another app or tab is "
                                 "using it. Retrying…", feed)
                else:
                    await self._set_status("reconnecting", f"Stream error {exc.code}: {exc.msg}", feed)
            except (ConnectionClosed, OSError, asyncio.TimeoutError) as exc:
                await self._set_status("reconnecting", f"Stream dropped ({type(exc).__name__}); reconnecting…", feed)
            except Exception as exc:  # noqa: BLE001
                log.exception("live stream failure")
                await self._set_status("reconnecting", f"Stream error: {exc}", feed)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30.0)

    @contextlib.asynccontextmanager
    async def _track(self, cm):
        """Wrap websockets.connect() to record when each upstream socket opens and is fully closed."""
        up = None
        try:
            async with cm as up:
                self.upstream["opened_total"] += 1
                self.upstream["open"] = {"local_port": up.local_address[1], "remote": f"{up.remote_address[0]}:{up.remote_address[1]}",
                                         "symbols": list(self._symbols)}
                yield up
        finally:
            if up is not None:  # __aexit__ above has completed the close handshake / socket shutdown
                self.upstream["closed_total"] += 1
                self.upstream["last_closed"] = {**(self.upstream["open"] or {}), "state": up.state.name,
                                                "close_code": up.close_code}
                self.upstream["open"] = None

    @staticmethod
    async def _expect(up, msg: str) -> None:
        """Read control messages until `msg` arrives; raise on an Alpaca error message."""
        while True:
            for m in json.loads(await asyncio.wait_for(up.recv(), timeout=10)):
                if m.get("T") == "error":
                    raise StreamError(int(m.get("code", 0)), m.get("msg", "error"))
                if m.get("T") == "success" and m.get("msg") == msg:
                    return

    async def _dispatch(self, m: dict) -> None:
        kind, sym = m.get("T"), m.get("S")
        if kind == "t":
            p, v = m["p"], m.get("s", 0)
            tk = self._ticks.get(sym)
            if tk is None:
                self._ticks[sym] = {"p": p, "hi": p, "lo": p, "v": v, "t": m["t"], "n": 1}
            else:
                tk.update(p=p, hi=max(tk["hi"], p), lo=min(tk["lo"], p), v=tk["v"] + v, t=m["t"], n=tk["n"] + 1)
        elif kind == "q":
            self._quotes[sym] = {"bp": m.get("bp"), "bs": m.get("bs"), "ap": m.get("ap"), "as": m.get("as"), "t": m.get("t")}
        elif kind in ("b", "u", "d"):
            bar = {k: m.get(k) for k in ("o", "h", "l", "c", "v", "t", "vw", "n")}
            await self._broadcast(sym, {"type": "bar", "kind": {"b": "minute", "u": "minute_update", "d": "daily"}[kind],
                                        "S": sym, **bar})
        elif kind == "error":
            raise StreamError(int(m.get("code", 0)), m.get("msg", "error"))

    async def _flush_loop(self) -> None:
        while True:
            await asyncio.sleep(FLUSH_EVERY)
            ticks, self._ticks = self._ticks, {}
            quotes, self._quotes = self._quotes, {}
            for sym, tk in ticks.items():
                await self._broadcast(sym, {"type": "tick", "S": sym, **tk})
            for sym, q in quotes.items():
                await self._broadcast(sym, {"type": "quote", "S": sym, **q})

    # ------------------------------------------------------------------ helpers
    async def _set_status(self, state: str, detail: str, feed: str | None = None) -> None:
        self.status = {"state": state, "detail": detail, "feed": feed or self.status.get("feed"),
                       "symbols": list(self._symbols)}
        for sym in list(self.clients):
            await self._broadcast(sym, {"type": "status", **self.status})

    async def _broadcast(self, sym: str, msg: dict) -> None:
        for ws in list(self.clients.get(sym, ())):
            await self._send(ws, msg)

    @staticmethod
    async def _send(ws: WebSocket, msg: dict) -> None:
        with contextlib.suppress(Exception):  # a closing browser socket is cleaned up by its own handler
            await ws.send_json(msg)


hub = LiveHub()
