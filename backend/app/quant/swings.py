"""Interim lows and highs (swing turns) and what the models learn from them: points of gain and risk.

Swing size - adaptive per stock and interval, known at bar t (no look-ahead):
    size_t = MULT x median, over the last LOOKBACK bars, of the stock's SPAN-bar range (highest high - lowest low)
             / close, clipped to [MIN_SIZE, MAX_SIZE]
  On daily bars: half the typical two-week high-low range of the last year - TSLA ~7%, AAPL ~3.5%, SPY ~2% - which
  gives ~20 interim lows a year (a turn every 2-3 weeks). One swing = size_t x close_t price points.

Zigzag (hindsight, for the labels only): a swing LOW is the lowest low between two swing highs, confirmed once price
has risen `size` above it (the size at the low); a swing HIGH is the highest high between two lows, confirmed once
price has fallen `size` below it. Each turn becomes known at its confirmation bar.

The y the models learn, per bar t (risk_reward), with H = the first interim high after t:
    gain_t = H's high - close_t                         the points to be gained by holding to the next interim high
                                                        (negative when that high is below today's close)
    risk_t = close_t - the lowest low in (t, H]          the points that can be lost on the way (>= 0)
  both divided by one swing (size_t x close_t), so volatile and quiet stocks, cheap and expensive ones, are on one
  scale; known at H's confirmation. Near an interim low the gain is large and the risk small; in a rising leg the
  risk is a pullback of less than a swing; at an interim high the risk is the coming drop and the gain only what the
  next high adds.
The walk-forward trains on a bar only once its y is known (quant/model.py train_mask), so the hindsight in the labels
never reaches a prediction.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

SPAN = 10            # bars of the range that measures a swing (two weeks of daily bars)
LOOKBACK = 252       # bars over which its typical (median) size is taken (a year of daily bars)
MULT = 0.5           # a turn = a reversal of half the typical SPAN-bar range
MIN_SIZE, MAX_SIZE = 0.003, 0.5


@dataclass(frozen=True)
class Turn:
    i: int           # bar of the interim low / high
    kind: str        # "low" or "high"
    price: float     # its low / high
    confirmed: int   # bar at which it became known (price moved `size` away from it)


def swing_size(high: np.ndarray, low: np.ndarray, close: np.ndarray, span: int = SPAN,
               lookback: int = LOOKBACK, mult: float = MULT) -> np.ndarray:
    """Per bar: MULT x the typical SPAN-bar range as a fraction of price over the last LOOKBACK bars (NaN until
    known)."""
    h = pd.Series(high).rolling(span, min_periods=span).max()
    lo = pd.Series(low).rolling(span, min_periods=span).min()
    rng = (h - lo) / pd.Series(close).where(lambda s: s > 0)
    size = mult * rng.rolling(lookback, min_periods=max(3 * span, lookback // 4)).median()
    return size.clip(MIN_SIZE, MAX_SIZE).to_numpy(dtype=float)


def zigzag(high: np.ndarray, low: np.ndarray, size: np.ndarray) -> list[Turn]:
    """Alternating interim lows / highs, each with the bar at which it was confirmed."""
    n = len(high)
    ok = np.flatnonzero(np.isfinite(size))
    if not len(ok):
        return []
    start = int(ok[0])
    turns: list[Turn] = []
    direction = 0                    # 0 undecided, +1 rising (last turn a low), -1 falling (last turn a high)
    hi_i = lo_i = start
    for i in range(start + 1, n):
        if direction == 0:
            if high[i] > high[hi_i]:
                hi_i = i
            if low[i] < low[lo_i]:
                lo_i = i
            if lo_i < i and high[i] >= low[lo_i] * (1 + size[lo_i]):
                turns.append(Turn(lo_i, "low", float(low[lo_i]), i))
                direction = 1
                hi_i = lo_i + 1 + int(np.argmax(high[lo_i + 1:i + 1]))
            elif hi_i < i and low[i] <= high[hi_i] * (1 - size[hi_i]):
                turns.append(Turn(hi_i, "high", float(high[hi_i]), i))
                direction = -1
                lo_i = hi_i + 1 + int(np.argmin(low[hi_i + 1:i + 1]))
        elif direction == 1:
            if high[i] > high[hi_i]:
                hi_i = i
            elif low[i] <= high[hi_i] * (1 - size[hi_i]):
                turns.append(Turn(hi_i, "high", float(high[hi_i]), i))
                direction = -1
                lo_i = hi_i + 1 + int(np.argmin(low[hi_i + 1:i + 1]))
        else:
            if low[i] < low[lo_i]:
                lo_i = i
            elif high[i] >= low[lo_i] * (1 + size[lo_i]):
                turns.append(Turn(lo_i, "low", float(low[lo_i]), i))
                direction = 1
                hi_i = lo_i + 1 + int(np.argmax(high[lo_i + 1:i + 1]))
    return turns


@dataclass
class RiskReward:
    """What the models learn, per bar t, in swing units (x size_t x close_t = price points):
    gain  = next interim high - close_t                    (< 0 if that high is below the close)
    risk  = close_t - the lowest low before that high      (>= 0: the drawdown endured on the way)
    known at that high's confirmation bar (`resolved`; n = not known yet)."""
    gain: np.ndarray
    risk: np.ndarray
    resolved: np.ndarray
    high_at: np.ndarray      # bar of that interim high (-1 = not known yet)
    turns: list[Turn]
    size: np.ndarray


def risk_reward(high: np.ndarray, low: np.ndarray, close: np.ndarray, size: np.ndarray | None = None) -> RiskReward:
    n = len(close)
    size = swing_size(high, low, close) if size is None else size
    turns = zigzag(high, low, size)
    gain = np.full(n, np.nan)
    risk = np.full(n, np.nan)
    resolved = np.full(n, n, dtype=np.int64)
    high_at = np.full(n, -1, dtype=np.int64)
    prev = 0
    for h in (t for t in turns if t.kind == "high"):
        seg = slice(prev, h.i)                     # the bars whose next interim high is h
        if h.i > prev:
            lows_after = np.minimum.accumulate(low[prev + 1:h.i + 1][::-1])[::-1]   # min low over (t, h.i]
            unit = size[seg] * close[seg]
            gain[seg] = (h.price - close[seg]) / unit
            risk[seg] = np.maximum(close[seg] - lows_after, 0.0) / unit
            resolved[seg] = h.confirmed
            high_at[seg] = h.i
        prev = h.i
    return RiskReward(gain, risk, resolved, high_at, turns, size)
