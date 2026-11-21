"""Profit-take / stop-loss levels for a BUY (or SELL) at each bar's close: entry +/- multiples of the daily ATR.

The multiples are the user's ("Fixed ATR") or chosen by backtested profit ("Optimized ATR", quant/optimize.py).
Levels carry a short "basis" text per bar for the UI ("1.5 ATR", "optimized").
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class Levels:
    """Per-bar levels (prices) and what set them."""
    target: np.ndarray
    stop: np.ndarray
    target_basis: np.ndarray   # short text per bar
    stop_basis: np.ndarray

    def at(self, i: int) -> tuple[float, float]:
        return float(self.target[i]), float(self.stop[i])


def fixed_levels(close: np.ndarray, atr_v: np.ndarray, tp_atr: float, sl_atr: float, sign: int = 1) -> Levels:
    n = len(close)
    return Levels(close + sign * tp_atr * atr_v, close - sign * sl_atr * atr_v,
                  np.full(n, f"{tp_atr:g} ATR", dtype=object), np.full(n, f"{sl_atr:g} ATR", dtype=object))
