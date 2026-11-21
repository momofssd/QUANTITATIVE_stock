"""Standard chart indicators. Display only: no signals, no model logic.

All lengths are in bars of the requested interval (e.g. SMA 20 on weekly bars = 20 weeks).
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np
import pandas as pd

MAX_PERIOD = 500


@dataclass(frozen=True)
class IndicatorParams:
    sma: tuple[int, int, int] = (20, 50, 200)
    ema: tuple[int, int] = (12, 26)
    bb_len: int = 20
    bb_mult: float = 2.0
    rsi: int = 14
    macd: tuple[int, int, int] = (12, 26, 9)  # fast, slow, signal

    def warmup_bars(self) -> int:
        """Bars needed before the first visible bar for every line to be fully formed.

        Exponential averages need ~3x their length to converge, simple ones exactly their length.
        """
        simple = max(*self.sma, self.bb_len)
        expo = 3 * max(*self.ema, self.rsi, self.macd[1] + self.macd[2])
        return max(simple, expo)

    def to_dict(self) -> dict:
        return asdict(self)


def _ints(raw: str | None, n: int, default: tuple[int, ...], name: str) -> tuple[int, ...]:
    if not raw:
        return default
    try:
        vals = tuple(int(v) for v in raw.split(","))
    except ValueError:
        raise ValueError(f"{name} must be {n} comma-separated whole numbers.") from None
    if len(vals) != n or not all(1 <= v <= MAX_PERIOD for v in vals):
        what = "a whole number" if n == 1 else f"{n} whole numbers"
        raise ValueError(f"{name} must be {what} between 1 and {MAX_PERIOD}.")
    return vals


def parse_params(sma: str | None, ema: str | None, bb: str | None, rsi: str | None, macd: str | None) -> IndicatorParams:
    d = IndicatorParams()
    bb_len, bb_mult = d.bb_len, d.bb_mult
    if bb:
        parts = bb.split(",")
        try:
            bb_len, bb_mult = int(parts[0]), float(parts[1]) if len(parts) > 1 else d.bb_mult
        except ValueError:
            raise ValueError("bb must be 'length,multiplier', e.g. 20,2") from None
        if not (2 <= bb_len <= MAX_PERIOD and 0.1 <= bb_mult <= 5):
            raise ValueError(f"Bollinger length must be 2-{MAX_PERIOD} and multiplier 0.1-5.")
    macd_v = _ints(macd, 3, d.macd, "macd")
    if macd_v[0] >= macd_v[1]:
        raise ValueError("MACD fast length must be shorter than slow length.")
    return IndicatorParams(
        sma=_ints(sma, 3, d.sma, "sma"),
        ema=_ints(ema, 2, d.ema, "ema"),
        bb_len=bb_len,
        bb_mult=bb_mult,
        rsi=_ints(rsi, 1, (d.rsi,), "rsi")[0],
        macd=macd_v,
    )


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
