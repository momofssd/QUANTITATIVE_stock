"""Bars + indicators for the chart: range -> fetch window, warm-up, session filter, trimming, payload.

Daily/weekly/monthly: always the full history Alpaca has; `range` only sets the initial view (`view_start`).
Intraday: the range window, extended back to `load_from` (YYYY-MM-DD) when the chart scrolls left.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

from ..alpaca_api import feeds
from ..core.errors import ApiError
from ..core.timeutil import EARLIEST, ET, et_epoch, iso, now_et
from ..indicators import IndicatorParams, compute_all
from .frames import bars_frame

TIMEFRAME_MINUTES = {
    "1Min": 1, "5Min": 5, "15Min": 15, "30Min": 30, "1Hour": 60, "4Hour": 240,
    "1Day": 1440, "1Week": 10080, "1Month": 43200,
}
RANGE_DEFAULT_TF = {
    "1D": "1Min", "5D": "5Min", "1M": "1Hour", "3M": "1Day", "6M": "1Day",
    "YTD": "1Day", "1Y": "1Day", "3Y": "1Day", "5Y": "1Week", "10Y": "1Week", "MAX": "1Week",
}
SESSION_RANGES = {"1D": 1, "5D": 5}  # ranges measured in trading sessions, not calendar time
RANGE_OFFSETS = {
    "1M": pd.DateOffset(months=1), "3M": pd.DateOffset(months=3), "6M": pd.DateOffset(months=6),
    "1Y": pd.DateOffset(years=1), "3Y": pd.DateOffset(years=3), "5Y": pd.DateOffset(years=5),
    "10Y": pd.DateOffset(years=10),
}
MAX_BARS = 20000
REGULAR_OPEN_MIN, REGULAR_CLOSE_MIN = 9 * 60 + 30, 16 * 60


@dataclass
class BarsRequest:
    symbol: str
    range: str = "1D"
    timeframe: str | None = None
    start: str | None = None
    end: str | None = None
    extended: bool = False
    load_from: str | None = None
    params: IndicatorParams = IndicatorParams()


def warmup_days(tf_min: int, bars: int, extended: bool) -> int:
    """Calendar days of history to fetch before the view so `bars` earlier bars exist."""
    if tf_min >= 1440:
        return 0  # daily and longer always load the full history anyway
    per_day = math.ceil((960 if extended else 390) / tf_min)  # bars per trading day
    trading_days = math.ceil(bars / per_day)
    return math.ceil(trading_days * 7 / 5) + 4  # weekends + holiday slack


def display_window(rng: str, start: str | None, end: str | None, now: pd.Timestamp) -> tuple[pd.Timestamp, pd.Timestamp | None]:
    """(view start, exclusive end or None for 'now') for a range preset or a custom range."""
    if rng == "CUSTOM":
        if not start:
            raise ApiError(400, "A custom range needs a start date.")
        try:
            d_start = pd.Timestamp(start, tz=ET)
            d_end = pd.Timestamp(end, tz=ET) + pd.Timedelta(days=1) if end else None  # inclusive end date
        except ValueError:
            raise ApiError(400, "Dates must be YYYY-MM-DD.") from None
        if d_end is not None and d_end <= d_start:
            raise ApiError(400, "End date must be after start date.")
        return d_start, d_end
    if rng in SESSION_RANGES:
        # Enough calendar days to cover N sessions across weekends/holidays; trimmed to N sessions later.
        return (now - pd.Timedelta(days=SESSION_RANGES[rng] + 6)).normalize(), None
    if rng == "YTD":
        return pd.Timestamp(year=now.year, month=1, day=1, tz=ET), None
    if rng == "MAX":
        return EARLIEST, None
    return (now - RANGE_OFFSETS[rng]).normalize(), None


def _empty(base: dict) -> dict:
    return {**base, "count": 0, "truncated": False, "has_more": False, "columns": {}}


def resolve_range(range_: str, timeframe: str | None) -> tuple[str, str, int]:
    """Validate a range + interval pair -> (RANGE, timeframe, minutes per bar)."""
    rng = range_.upper()
    if rng != "CUSTOM" and rng not in RANGE_DEFAULT_TF:
        raise ApiError(400, f"Unknown range '{range_}'.")
    tf = timeframe or RANGE_DEFAULT_TF.get(rng, "1Day")
    if tf not in TIMEFRAME_MINUTES:
        raise ApiError(400, f"Unsupported timeframe '{tf}'.")
    return rng, tf, TIMEFRAME_MINUTES[tf]


async def fetch_frame(symbol: str, tf: str, fetch_start: pd.Timestamp, end: pd.Timestamp | None,
                      extended: bool) -> tuple[pd.DataFrame, pd.Series, int]:
    """Bars for one interval exactly as the chart shows them: (frame with UTC index, ET session date per bar,
    number of raw bars fetched). Intraday bars outside 9:30-16:00 ET are dropped unless `extended`."""
    tf_min = TIMEFRAME_MINUTES[tf]
    raw = await feeds.get_bars(symbol, tf, iso(fetch_start), iso(end) if end is not None else None, max_bars=MAX_BARS)
    if not raw:
        return pd.DataFrame(), pd.Series(dtype="datetime64[ns]"), 0
    df = bars_frame(raw)
    et_naive = df.index.tz_convert(ET).tz_localize(None)
    session = pd.Series(et_naive.normalize(), index=df.index)
    if tf_min < 1440 and not extended:
        mins = et_naive.hour * 60 + et_naive.minute
        regular = (mins < REGULAR_CLOSE_MIN) & (mins + tf_min > REGULAR_OPEN_MIN)  # bar overlaps 9:30-16:00
        df, session = df[regular], session[regular]
    return df, session, len(raw)


async def build_bars(req: BarsRequest) -> dict:
    rng, tf, tf_min = resolve_range(req.range, req.timeframe)
    intraday = tf_min < 1440
    params = req.params

    display_start, display_end = display_window(rng, req.start, req.end, now_et())

    extra_from: pd.Timestamp | None = None  # intraday: older history requested by scrolling left
    if intraday:
        load_start = display_start
        if req.load_from:
            try:
                extra_from = max(pd.Timestamp(req.load_from, tz=ET), EARLIEST)
            except ValueError:
                raise ApiError(400, "load_from must be YYYY-MM-DD.") from None
            load_start = min(load_start, extra_from)
    else:
        load_start = EARLIEST
    fetch_start = load_start - pd.Timedelta(days=warmup_days(tf_min, params.warmup_bars(), req.extended))

    df, session, raw_count = await fetch_frame(req.symbol, tf, fetch_start, display_end, req.extended)
    base = {"symbol": req.symbol, "range": rng, "timeframe": tf, "intraday": intraday,
            "extended": req.extended, "feed": feeds.feed_label(), "params": params.to_dict()}
    if df.empty:
        return _empty(base)

    full = pd.concat([df, compute_all(df, intraday, session, params)], axis=1)

    # Trim warm-up bars off the front; work out where the initial view starts.
    if rng in SESSION_RANGES:
        sessions = pd.unique(session.values)
        keep_from = pd.Timestamp(sessions[-SESSION_RANGES[rng]:][0])
        view_start = int(keep_from.value // 10**9)
        if extra_from is None:
            mask = (session >= keep_from).values
        else:  # keep the requested older sessions too (the fetch window alone is not a reliable boundary)
            mask = (session >= min(keep_from, extra_from.tz_localize(None).normalize())).values
    else:
        view_start = int(display_start.tz_localize(None).value // 10**9)
        mask = full.index >= load_start
    full = full[mask]
    truncated = raw_count >= MAX_BARS

    full = full.astype(float).round(4)
    cols: dict[str, list] = {"time": et_epoch(full.index).tolist()}
    for name in full.columns:
        cols[name] = [None if np.isnan(v) else float(v) for v in full[name].to_numpy()]

    return {
        **base,
        "count": len(full),
        "truncated": truncated,
        "view_start": view_start,
        "load_from": load_start.strftime("%Y-%m-%d"),
        "has_more": bool(intraday and load_start > EARLIEST and not truncated),
        "start": iso(full.index[0]) if len(full) else None,
        "end": iso(full.index[-1]) if len(full) else None,
        "columns": cols,
    }
