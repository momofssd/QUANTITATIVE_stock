"""Yahoo Finance daily closes for the market / macro factors used by the entry-point analysis.

yfinance is synchronous, so callers run fetch_factors() in a worker thread. Results are cached in memory
(daily data only changes once a day; a few hours is plenty).
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
            raw = yf.download(tickers, start=start, interval="1d", auto_adjust=True, progress=False, threads=True)
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
