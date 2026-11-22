"""The decision rules, in points (shared by the analysis, the Backtests page, the projection and the current K line).

The two models predict, per bar, in swings (quant/swings.py risk_reward; x swing size x close = price points):
    gain = the rise to the next interim high      risk = the drawdown before it
BUY  when the expected gain is at least RR x the expected risk and at least MIN_SWINGS swing - low risk for the gain:
     a rebound near an interim low, or a trend that still has room to run.
SELL when the expected risk is at least RR x the expected gain (a negative gain counts as 0) and at least MIN_SWINGS
     swing - more to lose than to gain before the next interim high.
In between: hold. One decision per cooldown.

RR = 1.5 is the conventional minimum reward / risk; one swing (the stock's own volatility unit) is the smallest move
worth acting on - a rise of one swing is what confirms an interim low. Neither was fitted to results.
"""
from __future__ import annotations

import numpy as np

RR = 1.5             # the dominant side must be at least this many times the other
MIN_SWINGS = 1.0     # ... and at least this many swings


def buy_ok(gain, risk, rr: float = RR) -> np.ndarray:
    g, r = np.nan_to_num(gain, nan=-np.inf), np.nan_to_num(risk, nan=np.inf)
    return (g >= rr * r) & (g >= MIN_SWINGS)


def sell_ok(gain, risk, rr: float = RR) -> np.ndarray:
    g, r = np.nan_to_num(gain, nan=np.inf), np.nan_to_num(risk, nan=-np.inf)
    return (r >= rr * np.maximum(g, 0.0)) & (r >= MIN_SWINGS)


def ratio(a, b):
    """a / b for display (reward / risk or risk / reward); None when b is ~0 or a value is missing."""
    if a is None or b is None or not (np.isfinite(a) and np.isfinite(b)) or b <= 1e-9:
        return None
    return float(a / b)


def decision_bars(ok: np.ndarray, start: int, end: int, cooldown: int) -> list[int]:
    """Bars in [start, end) where `ok`, at most one per cooldown."""
    out, last = [], -10**9
    for i in range(start, end):
        if ok[i] and i - last > cooldown:
            last = i
            out.append(i)
    return out
