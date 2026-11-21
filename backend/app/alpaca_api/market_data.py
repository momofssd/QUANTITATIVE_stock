"""Raw market-data endpoints (one feed per call). Feed selection lives in feeds.py."""
from __future__ import annotations

from typing import Any

from . import http


async def fetch_bars(
    symbol: str,
    timeframe: str,
    start: str,
    end: str | None = None,
    *,
    feed: str,
    max_bars: int = 20000,
    adjustment: str = "split",
    sip_fallback: bool = True,
) -> list[dict]:
    """Bars from one feed, newest-first pagination (so a cap keeps the latest data), returned oldest-first."""
    params: dict[str, Any] = {
        "timeframe": timeframe, "start": start, "limit": 10000,
        "adjustment": adjustment, "feed": feed, "sort": "desc",
    }
    if end:
        params["end"] = end
    bars: list[dict] = []
    while True:
        data = await http.data_get(f"/v2/stocks/{symbol}/bars", params, sip_fallback=sip_fallback)
        bars.extend(data.get("bars") or [])
        token = data.get("next_page_token")
        if not token or len(bars) >= max_bars:
            break
        params["page_token"] = token
    bars = bars[:max_bars]
    bars.reverse()
    return bars


async def fetch_snapshot(symbol: str, *, feed: str) -> dict:
    """Latest trade, quote, minute bar, daily bar and previous daily bar."""
    return await http.data_get(f"/v2/stocks/{symbol}/snapshot", {"feed": feed})
