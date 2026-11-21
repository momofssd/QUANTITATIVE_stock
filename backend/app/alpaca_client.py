"""Thin async wrapper around the Alpaca Market Data and Trading REST APIs."""
from __future__ import annotations

import time
from typing import Any

import httpx
import pandas as pd

from .config import Settings, get_settings


class AlpacaError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=10.0))
    return _client


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _headers(s: Settings) -> dict[str, str]:
    return {"APCA-API-KEY-ID": s.api_key, "APCA-API-SECRET-KEY": s.secret_key, "Accept": "application/json"}


async def _get(url: str, params: dict[str, Any] | None = None) -> Any:
    s = get_settings()
    if not s.configured:
        raise AlpacaError(
            503,
            "Alpaca credentials not found. Add ALPACA_API_KEY and ALPACA_SECRET_KEY to the .env file in the project root.",
        )
    try:
        resp = await client().get(url, params=params, headers=_headers(s))
    except httpx.HTTPError as exc:
        raise AlpacaError(502, f"Could not reach Alpaca: {exc}") from exc
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("message") or resp.text
        except ValueError:
            detail = resp.text
        raise AlpacaError(resp.status_code, f"Alpaca {resp.status_code}: {detail}")
    return resp.json()


async def _data_get(path: str, params: dict[str, Any]) -> Any:
    """GET from the market-data API; if the plan does not allow SIP, fall back to IEX."""
    s = get_settings()
    try:
        return await _get(f"{s.data_url}{path}", params)
    except AlpacaError as exc:
        if exc.status == 403 and params.get("feed") in ("sip", "delayed_sip"):
            return await _get(f"{s.data_url}{path}", {**params, "feed": "iex"})
        raise


# --------------------------------------------------------------------------- market data

async def get_bars(
    symbol: str,
    timeframe: str,
    start: str,
    end: str | None = None,
    max_bars: int = 20000,
    adjustment: str = "split",
    feed: str = "iex",
    strict: bool = False,
) -> list[dict]:
    """Fetch bars newest-first (so a cap keeps the most recent data) and return them oldest-first.

    strict=True raises on a SIP permission error instead of silently falling back to IEX.
    """
    s = get_settings()
    params: dict[str, Any] = {
        "timeframe": timeframe,
        "start": start,
        "limit": 10000,
        "adjustment": adjustment,
        "feed": feed,
        "sort": "desc",
    }
    if end:
        params["end"] = end
    bars: list[dict] = []
    while True:
        if strict:
            data = await _get(f"{s.data_url}/v2/stocks/{symbol}/bars", params)
        else:
            data = await _data_get(f"/v2/stocks/{symbol}/bars", params)
        bars.extend(data.get("bars") or [])
        token = data.get("next_page_token")
        if not token or len(bars) >= max_bars:
            break
        params["page_token"] = token
    bars = bars[:max_bars]
    bars.reverse()
    return bars


SIP_DELAY = pd.Timedelta(minutes=16)  # free plans can't query the most recent 15 min of SIP
_feed_mode: dict = {"setting": None, "mode": None}  # mode: "sip" | "hybrid" | "iex"


def feed_mode() -> str:
    s = get_settings()
    if s.feed == "iex":
        return "iex"
    return _feed_mode["mode"] if _feed_mode["setting"] == s.feed and _feed_mode["mode"] else "hybrid"


async def resolve_feed_mode() -> str:
    """One-time probe: can this plan query the most recent minutes of SIP? Yes -> 'sip', no -> 'hybrid'."""
    s = get_settings()
    if s.feed == "iex":
        return "iex"
    if _feed_mode["setting"] == s.feed and _feed_mode["mode"]:
        return _feed_mode["mode"]
    start = (pd.Timestamp.now(tz="UTC") - pd.Timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        await _get(f"{s.data_url}/v2/stocks/SPY/bars", {"timeframe": "1Min", "start": start, "limit": 1, "feed": "sip"})
        mode = "sip"
    except AlpacaError as exc:
        if exc.status != 403:
            raise
        mode = "hybrid"
    _feed_mode.update(setting=s.feed, mode=mode)
    return mode


def feed_label() -> str:
    return {"iex": "iex", "sip": "sip", "hybrid": "sip+iex"}[feed_mode()]


def live_feed() -> str:
    """Feed for snapshots / latest trades."""
    return "sip" if feed_mode() == "sip" else "iex"


def _merge_tail(hist: list[dict], live: list[dict]) -> list[dict]:
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


async def get_bars_smart(
    symbol: str, timeframe: str, start: str, end: str | None = None, max_bars: int = 20000, adjustment: str = "split",
) -> list[dict]:
    """Bars with the deepest history the plan allows, plus live data up to now."""
    mode = await resolve_feed_mode()
    if mode == "iex":
        return await get_bars(symbol, timeframe, start, end, max_bars, adjustment, feed="iex")
    if mode == "sip":
        return await get_bars(symbol, timeframe, start, end, max_bars, adjustment, feed="sip")

    # Hybrid: SIP up to the delay cutoff, IEX after it.
    cutoff = pd.Timestamp.now(tz="UTC") - SIP_DELAY
    end_ts = pd.Timestamp(end) if end else None
    if end_ts is not None and end_ts <= cutoff:
        return await get_bars(symbol, timeframe, start, end, max_bars, adjustment, feed="sip", strict=True)
    hist: list[dict] = []
    if pd.Timestamp(start) < cutoff:
        hist = await get_bars(symbol, timeframe, start, cutoff.strftime("%Y-%m-%dT%H:%M:%SZ"),
                              max_bars, adjustment, feed="sip", strict=True)
    live_start = hist[-1]["t"] if hist else start
    live = await get_bars(symbol, timeframe, live_start, end, max_bars, adjustment, feed="iex")
    return _merge_tail(hist, live)[-max_bars:]


async def get_snapshot(symbol: str) -> dict:
    await resolve_feed_mode()
    return await _data_get(f"/v2/stocks/{symbol}/snapshot", {"feed": live_feed()})


# --------------------------------------------------------------------------- trading API

async def get_clock() -> dict:
    return await _get(f"{get_settings().trading_url}/v2/clock")


async def get_asset(symbol: str) -> dict:
    return await _get(f"{get_settings().trading_url}/v2/assets/{symbol}")


_assets_cache: dict = {"at": 0.0, "assets": []}


async def list_assets() -> list[dict]:
    """All active, tradable US equities (cached for 12 hours) — used for ticker search."""
    if _assets_cache["assets"] and time.time() - _assets_cache["at"] < 12 * 3600:
        return _assets_cache["assets"]
    raw = await _get(
        f"{get_settings().trading_url}/v2/assets", {"status": "active", "asset_class": "us_equity"}
    )
    assets = [
        {"symbol": a["symbol"], "name": a.get("name") or "", "exchange": a.get("exchange") or ""}
        for a in raw
        if a.get("tradable")
    ]
    _assets_cache.update(at=time.time(), assets=assets)
    return assets
