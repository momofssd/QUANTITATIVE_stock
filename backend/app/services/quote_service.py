"""Quote page data: last trade, bid/ask, day stats, previous close, 52-week range, average volumes."""
from __future__ import annotations

import time

import pandas as pd

from ..alpaca_api import feeds, trading
from ..alpaca_api.http import AlpacaError
from ..core.errors import ApiError
from ..core.timeutil import et_date, iso
from .frames import bars_frame

DAILY_TTL = 15  # seconds
_daily_cache: dict[str, tuple[float, list[dict]]] = {}


async def daily_bars(symbol: str) -> list[dict]:
    """~1 year of daily bars (deepest feed + live tail), cached briefly."""
    hit = _daily_cache.get(symbol)
    if hit and time.time() - hit[0] < DAILY_TTL:
        return hit[1]
    start = pd.Timestamp.now(tz="UTC") - pd.Timedelta(days=366)
    bars = await feeds.get_bars(symbol, "1Day", iso(start))
    _daily_cache[symbol] = (time.time(), bars)
    return bars


def year_stats(daily: list[dict]) -> dict:
    if not daily:
        return {"week52_high": None, "week52_low": None, "avg_volume_10d": None, "avg_volume_3m": None}
    df = bars_frame(daily)
    return {
        "week52_high": float(df["high"].max()),
        "week52_low": float(df["low"].min()),
        "avg_volume_10d": float(df["volume"].tail(10).mean()),
        "avg_volume_3m": float(df["volume"].tail(63).mean()),
    }


def day_and_prev(daily: list[dict], trade: dict) -> tuple[dict, dict]:
    """(today's bar, previous session's bar). Pre-market, the latest daily bar *is* the previous session."""
    day: dict = daily[-1] if daily else {}
    prev: dict = daily[-2] if len(daily) > 1 else {}
    if trade.get("t") and day.get("t") and et_date(day["t"]) < et_date(trade["t"]):
        prev, day = day, {}
    return day, prev


async def build_quote(symbol: str) -> dict:
    try:
        asset = await trading.get_asset(symbol)
    except AlpacaError as exc:
        if exc.status in (404, 422):
            raise ApiError(404, f"No US equity found for symbol '{symbol}'.") from None
        raise
    snap = await feeds.get_snapshot(symbol)
    daily = await daily_bars(symbol)

    trade = snap.get("latestTrade") or {}
    q = snap.get("latestQuote") or {}
    day, prev = day_and_prev(daily, trade)  # SIP daily bars when available: official volume & closes

    price = trade.get("p") or day.get("c") or prev.get("c")
    prev_close = prev.get("c")
    change = (price - prev_close) if (price is not None and prev_close) else None
    return {
        "symbol": symbol,
        "name": asset.get("name"),
        "exchange": asset.get("exchange"),
        "asset_class": asset.get("class"),
        "tradable": asset.get("tradable"),
        "shortable": asset.get("shortable"),
        "marginable": asset.get("marginable"),
        "fractionable": asset.get("fractionable"),
        "easy_to_borrow": asset.get("easy_to_borrow"),
        "price": price,
        "trade_time": trade.get("t"),
        "trade_size": trade.get("s"),
        "bid": q.get("bp"), "bid_size": q.get("bs"),
        "ask": q.get("ap"), "ask_size": q.get("as"),
        "quote_time": q.get("t"),
        "open": day.get("o"), "high": day.get("h"), "low": day.get("l"),
        "volume": day.get("v"), "day_vwap": day.get("vw"),
        "prev_close": prev_close,
        "change": change,
        "change_pct": (change / prev_close * 100) if change is not None else None,
        **year_stats(daily),
        "feed": feeds.feed_label(),
    }
