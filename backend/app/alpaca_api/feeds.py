"""Which data feed to use, and the SIP-history + IEX-live "hybrid" for free plans.

Free Alpaca plans can read consolidated (SIP) history back to 2016 but not its most recent 15 minutes,
while IEX is real-time but only covers one exchange (history from mid-2020). With ALPACA_DATA_FEED=auto
we probe once: if recent SIP is allowed the mode is "sip", otherwise "hybrid".
"""
from __future__ import annotations

import pandas as pd

from ..core.config import get_settings
from . import http, market_data

SIP_DELAY = pd.Timedelta(minutes=16)  # free plans can't query the most recent 15 min of SIP
_state: dict = {"setting": None, "mode": None}  # mode: "sip" | "hybrid" | "iex"


def feed_mode() -> str:
    """Current mode without network access ("hybrid" until the probe has run)."""
    s = get_settings()
    if s.feed == "iex":
        return "iex"
    if _state["setting"] == s.feed and _state["mode"]:
        return _state["mode"]
    return "hybrid"


async def resolve_feed_mode() -> str:
    """One-time probe: can this plan query the most recent minutes of SIP? Yes -> 'sip', no -> 'hybrid'."""
    s = get_settings()
    if s.feed == "iex":
        return "iex"
    if _state["setting"] == s.feed and _state["mode"]:
        return _state["mode"]
    start = (pd.Timestamp.now(tz="UTC") - pd.Timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        await http.get(f"{s.data_url}/v2/stocks/SPY/bars", {"timeframe": "1Min", "start": start, "limit": 1, "feed": "sip"})
        mode = "sip"
    except http.AlpacaError as exc:
        if exc.status != 403:
            raise
        mode = "hybrid"
    _state.update(setting=s.feed, mode=mode)
    return mode


def feed_label() -> str:
    """What the UI shows: "iex", "sip" or "sip+iex"."""
    return {"iex": "iex", "sip": "sip", "hybrid": "sip+iex"}[feed_mode()]


def live_feed() -> str:
    """Feed for real-time data (snapshots, stream)."""
    return "sip" if feed_mode() == "sip" else "iex"


def merge_tail(hist: list[dict], live: list[dict]) -> list[dict]:
    """Append IEX bars after the last SIP bar; fold IEX into an overlapping (still-forming) bar."""
    if not hist:
        return live
    out = list(hist)
    last_t = pd.Timestamp(out[-1]["t"])
    for b in live:
        t = pd.Timestamp(b["t"])
        if t < last_t:
            continue
        if t == last_t:
            h = out[-1]
            out[-1] = {**h, "h": max(h["h"], b["h"]), "l": min(h["l"], b["l"]), "c": b["c"], "v": max(h["v"], b["v"])}
        else:
            out.append(b)
    return out


async def get_bars(symbol: str, timeframe: str, start: str, end: str | None = None, max_bars: int = 20000) -> list[dict]:
    """Bars with the deepest history the plan allows, plus live data up to now."""
    mode = await resolve_feed_mode()
    if mode in ("iex", "sip"):
        return await market_data.fetch_bars(symbol, timeframe, start, end, feed=mode, max_bars=max_bars)

    # Hybrid: SIP up to the delay cutoff, IEX after it.
    cutoff = pd.Timestamp.now(tz="UTC") - SIP_DELAY
    if end and pd.Timestamp(end) <= cutoff:
        return await market_data.fetch_bars(symbol, timeframe, start, end, feed="sip", max_bars=max_bars,
                                            sip_fallback=False)
    hist: list[dict] = []
    if pd.Timestamp(start) < cutoff:
        hist = await market_data.fetch_bars(symbol, timeframe, start, cutoff.strftime("%Y-%m-%dT%H:%M:%SZ"),
                                            feed="sip", max_bars=max_bars, sip_fallback=False)
    live_start = hist[-1]["t"] if hist else start
    live = await market_data.fetch_bars(symbol, timeframe, live_start, end, feed="iex", max_bars=max_bars)
    return merge_tail(hist, live)[-max_bars:]


async def get_snapshot(symbol: str) -> dict:
    await resolve_feed_mode()
    return await market_data.fetch_snapshot(symbol, feed=live_feed())
