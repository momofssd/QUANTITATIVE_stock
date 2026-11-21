"""FastAPI app: Alpaca market-data proxy + indicator calculation + static frontend.

Run from the project root:
    python -m uvicorn backend.app.main:app --reload --port 8000
"""
from __future__ import annotations

import math
import re
import time
from contextlib import asynccontextmanager

import numpy as np
import pandas as pd
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import alpaca_client as alpaca
from .alpaca_client import AlpacaError
from .config import FRONTEND_DIR, get_settings
from .indicators import compute_all, parse_params

ET = "America/New_York"

TIMEFRAME_MINUTES = {
    "1Min": 1, "5Min": 5, "15Min": 15, "30Min": 30, "1Hour": 60, "4Hour": 240,
    "1Day": 1440, "1Week": 10080, "1Month": 43200,
}
RANGE_DEFAULT_TF = {
    "1D": "1Min", "5D": "5Min", "1M": "1Hour", "3M": "1Day", "6M": "1Day",
    "YTD": "1Day", "1Y": "1Day", "5Y": "1Week", "MAX": "1Week",
}
SESSION_RANGES = {"1D": 1, "5D": 5}  # ranges measured in trading sessions, not calendar time
EARLIEST = pd.Timestamp("2016-01-01", tz=ET)  # Alpaca history begins Jan 2016 (SIP) / Jul 2020 (IEX)
SYMBOL_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")
MAX_BARS = 20000


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await alpaca.close()


app = FastAPI(title="Quant Trading Model V3", lifespan=lifespan)


@app.exception_handler(AlpacaError)
async def _alpaca_error(_, exc: AlpacaError):
    return JSONResponse(status_code=exc.status, content={"detail": exc.message})


def _error(status: int, msg: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"detail": msg})


def _clean_symbol(symbol: str) -> str | None:
    sym = symbol.strip().upper()
    return sym if SYMBOL_RE.match(sym) else None


def _iso(ts: pd.Timestamp) -> str:
    return ts.tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")


def _et_epoch(index: pd.DatetimeIndex) -> np.ndarray:
    """Epoch seconds of the *New York wall-clock* time, so the chart's axis reads in ET."""
    return (index.tz_convert(ET).tz_localize(None).asi8 // 10**9).astype("int64")


def _bars_frame(bars: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(bars)
    df = df.rename(columns={"t": "ts", "o": "open", "h": "high", "l": "low", "c": "close",
                            "v": "volume", "vw": "bar_vwap", "n": "trades"})
    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    df = df.drop_duplicates("ts").set_index("ts").sort_index()
    for col in ("bar_vwap", "trades"):
        if col not in df:
            df[col] = np.nan
    return df[["open", "high", "low", "close", "volume", "bar_vwap", "trades"]]


# --------------------------------------------------------------------------- routes

@app.get("/api/health")
async def health():
    s = get_settings()
    return {
        "configured": s.configured,
        "account": "paper" if s.is_paper else "live",
        "trading_url": s.trading_url,
        "feed": alpaca.feed_label(),
    }


@app.get("/api/clock")
async def clock():
    return await alpaca.get_clock()


@app.get("/api/search")
async def search(q: str = Query("", max_length=40)):
    q = q.strip().upper()
    if not q:
        return []
    assets = await alpaca.list_assets()
    exact, prefix, name_hits = [], [], []
    for a in assets:
        sym, name = a["symbol"], a["name"].upper()
        if sym == q:
            exact.append(a)
        elif sym.startswith(q):
            prefix.append(a)
        elif len(q) >= 2 and q in name:
            name_hits.append(a)
    prefix.sort(key=lambda a: (len(a["symbol"]), a["symbol"]))
    return (exact + prefix + name_hits)[:10]


_daily_cache: dict[str, tuple[float, list[dict]]] = {}


async def _daily_bars(symbol: str) -> list[dict]:
    """~1 year of daily bars (deepest feed + live tail), cached briefly."""
    hit = _daily_cache.get(symbol)
    if hit and time.time() - hit[0] < 15:
        return hit[1]
    start = pd.Timestamp.now(tz="UTC") - pd.Timedelta(days=366)
    bars = await alpaca.get_bars_smart(symbol, "1Day", _iso(start))
    _daily_cache[symbol] = (time.time(), bars)
    return bars


@app.get("/api/quote/{symbol}")
async def quote(symbol: str):
    sym = _clean_symbol(symbol)
    if not sym:
        return _error(400, f"'{symbol}' is not a valid ticker symbol.")
    try:
        asset = await alpaca.get_asset(sym)
    except AlpacaError as exc:
        if exc.status in (404, 422):
            return _error(404, f"No US equity found for symbol '{sym}'.")
        raise
    snap = await alpaca.get_snapshot(sym)
    daily = await _daily_bars(sym)

    trade = snap.get("latestTrade") or {}
    q = snap.get("latestQuote") or {}
    minute = snap.get("minuteBar") or {}

    # Day stats / previous close come from daily bars (SIP history when available: official volume & closes).
    day: dict = daily[-1] if daily else {}
    prev: dict = daily[-2] if len(daily) > 1 else {}
    if trade.get("t") and day.get("t"):
        trade_date = pd.Timestamp(trade["t"]).tz_convert(ET).date()
        if pd.Timestamp(day["t"]).tz_convert(ET).date() < trade_date:
            # Pre-market: the latest daily bar is yesterday's session, so it *is* the previous close.
            prev, day = day, {}

    price = trade.get("p") or day.get("c") or prev.get("c")
    prev_close = prev.get("c")
    day_fields = {"open": day.get("o"), "high": day.get("h"), "low": day.get("l"),
                  "volume": day.get("v"), "day_vwap": day.get("vw")}

    stats: dict = {"week52_high": None, "week52_low": None, "avg_volume_10d": None, "avg_volume_3m": None}
    if daily:
        df = _bars_frame(daily)
        stats = {
            "week52_high": float(df["high"].max()),
            "week52_low": float(df["low"].min()),
            "avg_volume_10d": float(df["volume"].tail(10).mean()),
            "avg_volume_3m": float(df["volume"].tail(63).mean()),
        }

    change = (price - prev_close) if (price is not None and prev_close) else None
    return {
        "symbol": sym,
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
        "minute_bar": minute or None,
        **day_fields,
        "prev_close": prev_close,
        "change": change,
        "change_pct": (change / prev_close * 100) if change is not None else None,
        **stats,
        "feed": alpaca.feed_label(),
    }


def _warmup_days(tf_min: int, bars: int, extended: bool) -> int:
    """Calendar days of history to fetch before the view so `bars` earlier bars exist."""
    if tf_min >= 1440:
        return 0  # daily and longer always load the full history anyway
    per_day = math.ceil((960 if extended else 390) / tf_min)  # bars per trading day
    trading_days = math.ceil(bars / per_day)
    return math.ceil(trading_days * 7 / 5) + 4  # weekends + holiday slack


@app.get("/api/bars/{symbol}")
async def bars(
    symbol: str,
    range: str = Query("1D", alias="range"),
    timeframe: str | None = None,
    start: str | None = None,
    end: str | None = None,
    extended: bool = False,
    load_from: str | None = None,
    sma: str | None = None,
    ema: str | None = None,
    bb: str | None = None,
    rsi: str | None = None,
    macd: str | None = None,
):
    """Bars + indicators.

    Daily/weekly/monthly: always the full history Alpaca has; `range` only sets the initial view (`view_start`).
    Intraday: the range window, extended back to `load_from` (YYYY-MM-DD) when the chart scrolls left.
    """
    sym = _clean_symbol(symbol)
    if not sym:
        return _error(400, f"'{symbol}' is not a valid ticker symbol.")
    rng = range.upper()
    if rng != "CUSTOM" and rng not in RANGE_DEFAULT_TF:
        return _error(400, f"Unknown range '{range}'.")
    tf = timeframe or RANGE_DEFAULT_TF.get(rng, "1Day")
    if tf not in TIMEFRAME_MINUTES:
        return _error(400, f"Unsupported timeframe '{tf}'.")
    tf_min = TIMEFRAME_MINUTES[tf]
    intraday = tf_min < 1440
    try:
        params = parse_params(sma, ema, bb, rsi, macd)
    except ValueError as exc:
        return _error(400, str(exc))

    now = pd.Timestamp.now(tz=ET)
    display_end: pd.Timestamp | None = None
    if rng == "CUSTOM":
        if not start:
            return _error(400, "A custom range needs a start date.")
        try:
            display_start = pd.Timestamp(start, tz=ET)
            if end:
                display_end = pd.Timestamp(end, tz=ET) + pd.Timedelta(days=1)  # inclusive end date
        except ValueError:
            return _error(400, "Dates must be YYYY-MM-DD.")
        if display_end is not None and display_end <= display_start:
            return _error(400, "End date must be after start date.")
    elif rng in SESSION_RANGES:
        # Enough calendar days to cover N sessions across weekends/holidays; trimmed below.
        display_start = (now - pd.Timedelta(days=SESSION_RANGES[rng] + 6)).normalize()
    elif rng == "YTD":
        display_start = pd.Timestamp(year=now.year, month=1, day=1, tz=ET)
    elif rng == "MAX":
        display_start = EARLIEST
    else:
        offsets = {"1M": pd.DateOffset(months=1), "3M": pd.DateOffset(months=3), "6M": pd.DateOffset(months=6),
                   "1Y": pd.DateOffset(years=1), "5Y": pd.DateOffset(years=5)}
        display_start = (now - offsets[rng]).normalize()

    if intraday:
        load_start = display_start
        if load_from:
            try:
                load_start = min(load_start, max(pd.Timestamp(load_from, tz=ET), EARLIEST))
            except ValueError:
                return _error(400, "load_from must be YYYY-MM-DD.")
    else:
        load_start = EARLIEST
    fetch_start = load_start - pd.Timedelta(days=_warmup_days(tf_min, params.warmup_bars(), extended))
    raw = await alpaca.get_bars_smart(
        sym, tf, _iso(fetch_start), _iso(display_end) if display_end is not None else None, max_bars=MAX_BARS,
    )
    base = {"symbol": sym, "range": rng, "timeframe": tf, "intraday": intraday,
            "extended": extended, "feed": alpaca.feed_label(), "params": params.to_dict()}
    if not raw:
        return {**base, "count": 0, "truncated": False, "columns": {}}

    df = _bars_frame(raw)
    et_naive = df.index.tz_convert(ET).tz_localize(None)
    session = pd.Series(et_naive.normalize(), index=df.index)

    if intraday and not extended:
        mins = et_naive.hour * 60 + et_naive.minute
        regular = (mins < 16 * 60) & (mins + tf_min > 9 * 60 + 30)
        df, session = df[regular], session[regular]
        if df.empty:
            return {**base, "count": 0, "truncated": False, "columns": {}}

    ind = compute_all(df, intraday, session, params)
    full = pd.concat([df, ind], axis=1)

    # Trim warm-up bars off the front; work out where the initial view starts.
    if rng in SESSION_RANGES:
        sessions = pd.unique(session.values)
        keep_from = pd.Timestamp(sessions[-SESSION_RANGES[rng]:][0])
        view_start = int(keep_from.value // 10**9)
        mask = (session >= keep_from).values if load_start >= display_start else full.index >= load_start
    else:
        view_start = int(display_start.tz_localize(None).value // 10**9)
        mask = full.index >= load_start
    full = full[mask]
    truncated = len(raw) >= MAX_BARS

    full = full.astype(float).round(4)
    cols = {"time": _et_epoch(full.index).tolist()}
    for name in full.columns:
        values = full[name].to_numpy()
        cols[name] = [None if np.isnan(v) else float(v) for v in values]

    return {
        **base,
        "count": len(full),
        "truncated": truncated,
        "view_start": view_start,
        "load_from": load_start.strftime("%Y-%m-%d"),
        "has_more": bool(intraday and load_start > EARLIEST and not truncated),
        "start": _iso(full.index[0]) if len(full) else None,
        "end": _iso(full.index[-1]) if len(full) else None,
        "columns": cols,
    }


# Frontend (mounted last so /api/* wins).
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
