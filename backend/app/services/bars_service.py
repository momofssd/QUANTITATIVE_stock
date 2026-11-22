"""Bars + indicators for the chart: range -> fetch window, warm-up, session filter, trimming, payload.

Daily/weekly/monthly: always the full history Alpaca has; `range` only sets the initial view (`view_start`).
Intraday: the range window, extended back to `load_from` (YYYY-MM-DD) when the chart scrolls left.
Every bar also carries `vix`: the CBOE VIX daily close (Yahoo Finance) for the bar's day / week / month - fetched
in parallel with the bars; if Yahoo is unavailable the column is empty and the chart still loads.
`vwap`: per session on intraday bars; on daily+ bars anchored at the start of the selected range.
`range_base`: the last bar before the selected range - its close is the base of the range's gain / loss.
"""
from __future__ import annotations

import asyncio
import logging
import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

from ..alpaca_api import feeds
from ..core.errors import ApiError
from ..core.timeutil import EARLIEST, ET, et_epoch, iso, now_et
from ..indicators import IndicatorParams, compute_all
from ..yahoo_api import client as yahoo
from .frames import bars_frame

log = logging.getLogger(__name__)

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


async def _load_vix(start: pd.Timestamp) -> pd.Series | None:
    """Daily VIX closes from a little before `start`, or None if Yahoo is unavailable (the chart still loads)."""
    try:
        return await asyncio.to_thread(yahoo.fetch_vix, (start - pd.Timedelta(days=10)).strftime("%Y-%m-%d"))
    except Exception as exc:  # noqa: BLE001 - the VIX line is optional
        log.warning("VIX line unavailable: %s", exc)
        return None


def vix_column(vix: pd.Series | None, session: pd.Series, tf_min: int) -> np.ndarray:
    """Per bar: the VIX daily close at the end of the bar's period - its day (daily and intraday bars), its week
    (weekly) or its month (monthly); for the current period the latest close so far. NaN before the VIX data."""
    n = len(session)
    if vix is None or vix.empty or n == 0:
        return np.full(n, np.nan)
    ends = pd.DatetimeIndex(session.to_numpy())
    if tf_min >= TIMEFRAME_MINUTES["1Month"]:
        ends = ends + pd.offsets.MonthEnd(0)
    elif tf_min >= TIMEFRAME_MINUTES["1Week"]:
        ends = ends + pd.to_timedelta(6 - ends.dayofweek, unit="D")   # through that week's Sunday
    pos = vix.index.searchsorted(ends, side="right") - 1
    values = vix.to_numpy(dtype=float)
    return np.where(pos >= 0, values[np.clip(pos, 0, None)], np.nan)


async def _load_daily(symbol: str) -> list[dict]:
    """~1 year of official daily bars (shared with the quote, cached briefly), or [] on failure."""
    from . import quote_service   # local import: quote_service is a sibling service, not a dependency at import
    try:
        return await quote_service.daily_bars(symbol)
    except Exception as exc:  # noqa: BLE001 - only refines the intraday range base
        log.warning("daily bars unavailable for the range base: %s", exc)
        return []


def official_close_before(daily: list[dict], anchor: pd.Timestamp) -> dict | None:
    """The official close (daily bar) of the last session before `anchor` (naive ET date) - the base of an intraday
    chart's range gain / loss (a minute bar's close misses the closing auction)."""
    if not daily:
        return None
    df = bars_frame(daily)
    dates = df.index.tz_convert(ET).tz_localize(None).normalize()
    prior = np.flatnonzero(dates < anchor)
    if not len(prior):
        return None
    j = int(prior[-1])
    return {"time": int(et_epoch(df.index[j:j + 1])[0]), "close": round(float(df["close"].iloc[j]), 4), "daily": True}


def anchored_vwap(df: pd.DataFrame, session: pd.Series, anchor: pd.Timestamp) -> np.ndarray:
    """VWAP of every bar from `anchor` (naive ET date) on: cumulative dollar volume / cumulative volume, using each
    bar's own VWAP (Alpaca `vw`; typical price when missing). NaN before the anchor. Used on daily+ charts, where a
    per-session VWAP would just be each bar's own price."""
    typical = (df["high"] + df["low"] + df["close"]) / 3
    px = df["bar_vwap"].where(df["bar_vwap"].notna(), typical) if "bar_vwap" in df else typical
    on = (session >= anchor).to_numpy()
    vol = df["volume"].to_numpy(dtype=float) * on
    cum_v = np.cumsum(vol)
    cum_pv = np.cumsum(px.to_numpy(dtype=float) * vol)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = cum_pv / cum_v
    out[~on | (cum_v == 0)] = np.nan
    return out


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

    # in parallel with the bars: Yahoo VIX, and (intraday) the official daily closes for the range base
    side = [asyncio.ensure_future(_load_vix(fetch_start))]
    if intraday:
        side.append(asyncio.ensure_future(_load_daily(req.symbol)))
    try:
        df, session, raw_count = await fetch_frame(req.symbol, tf, fetch_start, display_end, req.extended)
    except BaseException:
        for task in side:
            task.cancel()
        raise
    vix = await side[0]
    daily = await side[1] if intraday else []
    base = {"symbol": req.symbol, "range": rng, "timeframe": tf, "intraday": intraday,
            "extended": req.extended, "feed": feeds.feed_label(), "params": params.to_dict()}
    if df.empty:
        return _empty(base)

    full = pd.concat([df, compute_all(df, intraday, session, params)], axis=1)
    full["vix"] = vix_column(vix, session, tf_min)

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

    # The selected range starts at `anchor` (naive ET date): daily+ VWAP is anchored there, and the range's gain /
    # loss is measured from the close of the last bar before it (the previous session's close on 1D).
    anchor = keep_from if rng in SESSION_RANGES else display_start.tz_localize(None).normalize()
    if not intraday:
        full["vwap"] = anchored_vwap(df, session, anchor)
    range_base = official_close_before(daily, anchor) if intraday else None
    # intraday (regular hours): the range ends at the latest official close of the last bar's session, when known
    range_last = None
    if intraday and not req.extended and len(session):
        last_day = session.iloc[-1] + pd.Timedelta(days=1)
        latest = official_close_before(daily, last_day)
        if latest and pd.Timestamp(latest["time"], unit="s").normalize() == session.iloc[-1]:
            range_last = latest
    prior = (session < anchor).to_numpy()
    if range_base is None and prior.any():
        j = int(np.flatnonzero(prior)[-1])
        range_base = {"time": int(et_epoch(full.index[j:j + 1])[0]), "close": round(float(full["close"].iloc[j]), 4),
                      "daily": not intraday}

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
        # last bar before the selected range (its close = the base of the range's gain / loss); None = no earlier bar
        "range_base": range_base,
        # intraday: the session's official close (daily bar) - the end of the range's gain / loss until a live tick
        "range_last": range_last,
        "load_from": load_start.strftime("%Y-%m-%d"),
        "has_more": bool(intraday and load_start > EARLIEST and not truncated),
        "start": iso(full.index[0]) if len(full) else None,
        "end": iso(full.index[-1]) if len(full) else None,
        "columns": cols,
    }
