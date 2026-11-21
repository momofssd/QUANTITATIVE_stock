"""Indicator maths on a bars DataFrame. Display only: no signals, no model logic.

All lengths are in bars of the requested interval (e.g. SMA 20 on weekly bars = 20 weeks).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .params import IndicatorParams


def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).mean()


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False, min_periods=n).mean()


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    avg_loss = loss.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    # No losses in the window means RSI = 100.
    return out.where(~(avg_loss == 0) | avg_gain.isna(), 100.0)


def vwap(df: pd.DataFrame, session_key: pd.Series) -> pd.Series:
    """Session VWAP that resets each trading day."""
    typical = (df["high"] + df["low"] + df["close"]) / 3
    pv = (typical * df["volume"]).groupby(session_key).cumsum()
    vol = df["volume"].groupby(session_key).cumsum()
    return pv / vol.replace(0, np.nan)


def compute_all(
    df: pd.DataFrame, intraday: bool, session_key: pd.Series | None = None, p: IndicatorParams | None = None,
) -> pd.DataFrame:
    """Return a frame of indicator columns aligned to df's index.

    Column names are positional (sma1..sma3, ema1..ema2) so they stay stable when lengths change;
    the lengths themselves are reported alongside the data.
    """
    p = p or IndicatorParams()
    c = df["close"]
    out = pd.DataFrame(index=df.index)
    for i, n in enumerate(p.sma, 1):
        out[f"sma{i}"] = sma(c, n)
    for i, n in enumerate(p.ema, 1):
        out[f"ema{i}"] = ema(c, n)

    mid = sma(c, p.bb_len)
    std = c.rolling(p.bb_len, min_periods=p.bb_len).std(ddof=0)
    out["bb_mid"] = mid
    out["bb_upper"] = mid + p.bb_mult * std
    out["bb_lower"] = mid - p.bb_mult * std

    out["rsi"] = rsi(c, p.rsi)

    fast, slow, sig = p.macd
    macd = ema(c, fast) - ema(c, slow)
    signal = macd.ewm(span=sig, adjust=False, min_periods=sig).mean()
    out["macd"] = macd
    out["macd_signal"] = signal
    out["macd_hist"] = macd - signal

    if intraday and session_key is not None:
        out["vwap"] = vwap(df, session_key)
    else:
        out["vwap"] = np.nan
    return out
