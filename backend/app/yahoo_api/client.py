"""Yahoo Finance daily closes for the market / macro factors used by the entry-point analysis.

yfinance is synchronous, so callers run fetch_factors() in a worker thread. Results are cached in memory
(daily data only changes once a day; a few hours is plenty).

Raw closes (auto_adjust=False), not dividend-adjusted ones: Yahoo recomputes adjusted closes on every download with
tiny float differences (~$0.0002 on SPY / QQQ), which made two trainings on the same data pick slightly different
decisions. Raw closes are identical on every download; the cost is a small drop on SPY / QQQ ex-dividend days.
"""
from __future__ import annotations

import threading
import time

import pandas as pd

from ..core.errors import ApiError

# factor key -> (Yahoo ticker, description shown in the UI)
FACTORS: dict[str, tuple[str, str]] = {
    "spy": ("SPY", "S&P 500 ETF"),
    "qqq": ("QQQ", "Nasdaq-100 ETF"),
    "vix": ("^VIX", "CBOE Volatility Index"),
    "oil": ("CL=F", "WTI crude oil futures"),
    "gasoline": ("RB=F", "RBOB gasoline futures"),
    "rate": ("^IRX", "13-week T-bill yield (Fed-rate proxy)"),
}
CACHE_TTL = 4 * 3600  # seconds

_cache: dict = {"at": 0.0, "start": None, "frame": None}
_lock = threading.Lock()


def fetch_factors(start: str) -> pd.DataFrame:
    """Daily closes, one column per factor key, indexed by (naive) trading date, forward-filled across holidays.

    `start` is YYYY-MM-DD. Raises ApiError(502) if Yahoo is unreachable or returns nothing.
    """
    with _lock:
        hit = _cache["frame"]
        if hit is not None and _cache["start"] <= start and time.time() - _cache["at"] < CACHE_TTL:
            return hit.loc[start:].copy()
        try:
            import yfinance as yf

            tickers = [t for t, _ in FACTORS.values()]
            raw = yf.download(tickers, start=start, interval="1d", auto_adjust=False, progress=False, threads=True)
        except Exception as exc:  # noqa: BLE001 - network / parsing issues inside yfinance
            raise ApiError(502, f"Yahoo Finance request failed: {exc}") from exc
        if raw is None or raw.empty or "Close" not in raw:
            raise ApiError(502, "Yahoo Finance returned no data for the market factors.")

        close = raw["Close"]
        frame = pd.DataFrame({key: close[ticker] for key, (ticker, _) in FACTORS.items() if ticker in close})
        missing = [k for k in FACTORS if k not in frame]
        if missing:
            raise ApiError(502, f"Yahoo Finance returned no data for: {', '.join(missing)}")
        frame.index = pd.to_datetime(frame.index).tz_localize(None).normalize()
        frame = frame.sort_index().ffill()
        _cache.update(at=time.time(), start=start, frame=frame)
        return frame.copy()


VIX_TTL = 15 * 60  # seconds: today's VIX close moves during the session
_vix_cache: dict = {"at": 0.0, "start": None, "series": None}
_vix_lock = threading.Lock()


def fetch_vix(start: str) -> pd.Series:
    """Daily ^VIX closes from `start` (YYYY-MM-DD), indexed by (naive) trading date - the chart's VIX line.

    Cached for VIX_TTL. Raises ApiError(502) if Yahoo is unreachable or returns nothing.
    """
    with _vix_lock:
        hit = _vix_cache["series"]
        if hit is not None and _vix_cache["start"] <= start and time.time() - _vix_cache["at"] < VIX_TTL:
            return hit.loc[start:].copy()
        try:
            import yfinance as yf

            raw = yf.download(FACTORS["vix"][0], start=start, interval="1d", auto_adjust=False, progress=False,
                              threads=False)
        except Exception as exc:  # noqa: BLE001 - network / parsing issues inside yfinance
            raise ApiError(502, f"Yahoo Finance request failed: {exc}") from exc
        if raw is None or raw.empty or "Close" not in raw:
            raise ApiError(502, "Yahoo Finance returned no VIX data.")
        close = raw["Close"]
        if isinstance(close, pd.DataFrame):  # newer yfinance: one column per ticker even for one ticker
            close = close.iloc[:, 0]
        series = close.dropna().astype(float)
        series.index = pd.to_datetime(series.index).tz_localize(None).normalize()
        series = series.sort_index()
        _vix_cache.update(at=time.time(), start=start, series=series)
        return series.copy()
