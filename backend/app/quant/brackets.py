"""Profit-take / stop-loss levels for a BUY at each bar's close.

  fixed    entry + tp x daily ATR / entry - sl x daily ATR (the user's multiples, the same for every decision)
  dynamic  set from the chart at the decision (everything known at that bar's close):
             stop-loss    just below the 5-session swing low (low - 0.2 daily ATR), kept 0.75-2.5 ATR below the
                          entry (if that low breaks, the setup has failed)
             profit-take  rebound setup  -> a 50% retracement of the fall (from the 10-session high down to the
                                            5-session low), at least 1x the risk and at most 3 ATR above the entry
                          trend / other  -> 1.5x the risk (the fixed default's reward:risk), at most 3.5 ATR
"Sessions" are trading days on every interval (intraday: today so far + the previous sessions; weekly: the
weekly bars covering them), matching the 5-session outcome window and the daily ATR.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

SWING_SESSIONS = 5         # stop below the lowest low of the last 5 sessions
HIGH_SESSIONS = 10         # rebound: the fall is measured from the highest high of the last 10 sessions
REBOUND_RETRACE = 0.5      # ... and the target is this share of it, measured up from the 5-session low
STOP_BUFFER_ATR = 0.2
STOP_MIN_ATR, STOP_MAX_ATR = 0.75, 2.5
TREND_RR = 1.5
REBOUND_MIN_RR = 1.0
REBOUND_MAX_ATR = 3.0
TREND_MAX_ATR = 3.5

RULES = {
    "stop": f"just below the {SWING_SESSIONS}-session low (-{STOP_BUFFER_ATR} ATR), kept {STOP_MIN_ATR}-"
            f"{STOP_MAX_ATR} ATR below the entry",
    "rebound": f"{REBOUND_RETRACE:.0%} retracement of the fall from the {HIGH_SESSIONS}-session high to the "
               f"{SWING_SESSIONS}-session low, {REBOUND_MIN_RR:g}x risk to {REBOUND_MAX_ATR:g} ATR above the entry",
    "trend": f"{TREND_RR:g}x the risk (at most {TREND_MAX_ATR:g} ATR)",
}


def session_extreme(values: np.ndarray, ordinal: np.ndarray, sessions: int, how: str) -> np.ndarray:
    """Per bar: the lowest (how="min") / highest ("max") value of the current session so far and the
    `sessions - 1` sessions before it. ordinal = 0, 1, 2 ... per session, ascending (one per bar on daily)."""
    s = pd.Series(values, dtype=float)
    g = s.groupby(ordinal)
    today = (g.cummin() if how == "min" else g.cummax()).to_numpy()
    if sessions <= 1:
        return today
    per = g.min() if how == "min" else g.max()            # full sessions, indexed by ordinal
    roll = per.shift(1).rolling(sessions - 1, min_periods=1)
    prev = (roll.min() if how == "min" else roll.max()).reindex(ordinal).to_numpy()
    return np.fmin(today, prev) if how == "min" else np.fmax(today, prev)


@dataclass
class Levels:
    """Per-bar BUY levels (prices) and what set them."""
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


def dynamic_levels(close: np.ndarray, high: np.ndarray, low: np.ndarray, atr_v: np.ndarray, ordinal: np.ndarray,
                   setup: np.ndarray, bars_per_session: float = 1.0) -> Levels:
    """bars_per_session < 1 on weekly bars (one bar = 5 sessions)."""
    def n_sessions(k: int) -> int:
        return max(1, math.ceil(k * bars_per_session))

    lo = session_extreme(low, ordinal, n_sessions(SWING_SESSIONS), "min")
    hi = session_extreme(high, ordinal, n_sessions(HIGH_SESSIONS), "max")
    with np.errstate(invalid="ignore"):
        raw_risk = close - (lo - STOP_BUFFER_ATR * atr_v)
        risk = np.clip(raw_risk, STOP_MIN_ATR * atr_v, STOP_MAX_ATR * atr_v)
        stop_basis = np.where(raw_risk < STOP_MIN_ATR * atr_v, f"min {STOP_MIN_ATR} ATR",
                              np.where(raw_risk > STOP_MAX_ATR * atr_v, f"max {STOP_MAX_ATR} ATR",
                                       f"{SWING_SESSIONS}-session low")).astype(object)

        rebound = setup == "rebound"
        room = lo + REBOUND_RETRACE * (hi - lo) - close
        reb_lo, reb_hi = REBOUND_MIN_RR * risk, REBOUND_MAX_ATR * atr_v
        reb = np.minimum(np.maximum(room, reb_lo), reb_hi)
        reb_basis = np.where(room > reb_hi, f"cap {REBOUND_MAX_ATR:g} ATR",
                             np.where(room < reb_lo, f"{REBOUND_MIN_RR:g}x risk", f"{REBOUND_RETRACE:.0%} retracement"))
        trend_raw = TREND_RR * risk
        trend = np.minimum(trend_raw, TREND_MAX_ATR * atr_v)
        trend_basis = np.where(trend_raw > TREND_MAX_ATR * atr_v, f"cap {TREND_MAX_ATR:g} ATR", f"{TREND_RR:g}x risk")
        reward = np.where(rebound, reb, trend)
        target_basis = np.where(rebound, reb_basis, trend_basis).astype(object)
    return Levels(close + reward, close - risk, target_basis, stop_basis)
