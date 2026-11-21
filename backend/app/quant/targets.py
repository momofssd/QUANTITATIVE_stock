"""What counts as an entry point or a take-profit point, and how outcomes are labelled (ATR "triple barrier")."""
from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np
import pandas as pd

ATR_LEN = 14


@dataclass(frozen=True)
class TargetSpec:
    """A signal at day t's close succeeds if, within `horizon` trading days, price moves `target_atr` x ATR in the
    signal's direction before moving `stop_atr` x ATR against it.

      direction "up"   (entry):       high >= close + target_atr*ATR  before  low  <= close - stop_atr*ATR
      direction "down" (take-profit): low  <= close - target_atr*ATR  before  high >= close + stop_atr*ATR
    """
    key: str
    label: str
    kind: str          # "entry" or "take_profit"
    direction: str     # "up" or "down"
    horizon: int
    target_atr: float
    stop_atr: float
    cooldown: int      # bars after a marked signal before another one of this kind is marked
    model: str         # "hgb" (gradient-boosted trees) or "logistic" - see quant/model.py
    # Trade exits (entries only): once the close is trail_after_atr x ATR above the entry, a stop follows the
    # highest close at trail_atr x ATR (see quant/trades.py).
    trail_after_atr: float = 0.0  # 0 = no trailing stop (plain bracket: target / stop / time)
    trail_atr: float = 0.0
    exit_with: str = ""  # key of the take-profit target whose signal can close this entry's trade ("" = none)
    # "bars": horizon counts bars of the analysed interval; "sessions": trading sessions (days) on every interval.
    horizon_mode: str = "bars"
    # "bar": ATR(14) of the analysed interval; "daily": daily ATR(14) known at the bar (previous day intraday).
    atr_basis: str = "bar"
    # BUY levels: "fixed" = target_atr / stop_atr x ATR; "dynamic" = set per decision from the chart
    # (quant/brackets.py; target_atr / stop_atr are then unused).
    bracket: str = "fixed"

    @property
    def sign(self) -> int:
        return 1 if self.direction == "up" else -1

    def levels(self, price: float, atr_value: float) -> tuple[float, float]:
        """(target, stop) prices for a signal at `price`."""
        return (price + self.sign * self.target_atr * atr_value, price - self.sign * self.stop_atr * atr_value)

    def to_dict(self) -> dict:
        return asdict(self)


# Model choice from an out-of-sample comparison on SPY, QQQ, AAPL, MSFT, NVDA, JPM: for 5-day outcomes
# gradient-boosted trees found a modest edge (mean AUC 0.55). (Long-term entries are being redesigned separately.)
# BUY (short-term entry): justified when price reaches the profit-take (+1.5 daily ATR, adjustable) before the
# stop-loss (-1 daily ATR, adjustable) within 5 trading sessions, on any candle interval. Only marked in a
# "rebound" or "trend" setup (quant/setups.py). Traded as a bracket order that also exits on a SELL while in profit.
SHORT = TargetSpec("short", "BUY - short-term entry", "entry", "up", horizon=5, target_atr=1.5, stop_atr=1.0,
                   cooldown=5, model="hgb", horizon_mode="sessions", atr_basis="daily", exit_with="tp_short")
# SELL (take profit): a pullback of 1.5 daily ATR comes before a 1 ATR rise within 5 sessions; only marked in an
# "interim top" setup (bullish momentum easing).
TP_SHORT = TargetSpec("tp_short", "SELL - take profit", "take_profit", "down", horizon=5, target_atr=1.5,
                      stop_atr=1.0, cooldown=5, model="hgb", horizon_mode="sessions", atr_basis="daily")
TARGETS = (SHORT, TP_SHORT)

# outcome codes
PENDING, TARGET, STOP, EXPIRED = "pending", "target", "stop", "expired"


def atr(high: pd.Series, low: pd.Series, close: pd.Series, n: int = ATR_LEN) -> pd.Series:
    """Wilder's Average True Range."""
    prev = close.shift(1)
    tr = pd.concat([high - low, (high - prev).abs(), (low - prev).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def bar_horizon(n: int, bars: int) -> tuple[np.ndarray, np.ndarray]:
    """(end, complete) for a horizon of `bars` bars: end = last bar inside the horizon, complete = all of it exists."""
    t = np.arange(n)
    return np.minimum(t + bars, n - 1), t + bars <= n - 1


def session_horizon(session_ord: np.ndarray, minute: np.ndarray, sessions: int) -> tuple[np.ndarray, np.ndarray]:
    """(end, complete) for a horizon of `sessions` trading sessions on bars of any interval.

    A bar in session s at minute m of the day may look ahead through session s + sessions up to the same time of
    day. session_ord = trading-session number of each bar (ascending), minute = minute of the day (ET).
    """
    key = session_ord.astype(np.int64) * 2000 + minute.astype(np.int64)  # sortable (session, minute) key
    pos = np.searchsorted(key, (session_ord.astype(np.int64) + sessions) * 2000 + minute, side="right")
    return pos - 1, pos < len(key)


def triple_barrier(high: np.ndarray, low: np.ndarray, close: np.ndarray, atr_v: np.ndarray, spec: TargetSpec,
                   end: np.ndarray | None = None, complete: np.ndarray | None = None,
                   levels: tuple[np.ndarray, np.ndarray] | None = None):
    """Label every bar.

    Returns (label, resolved_at, outcome):
      label        1.0 target hit first, 0.0 stop hit first or horizon expired, NaN still open (not enough future bars)
      resolved_at  index of the bar on which the outcome became known (n for unresolved) - training may only use
                   samples resolved strictly before the first day it predicts (no look-ahead)
      outcome      TARGET / STOP / EXPIRED / PENDING
    `end` / `complete` give each bar's horizon (default: spec.horizon bars). A bar that touches both barriers counts
    as a stop (conservative: the order inside the bar is unknown). `levels` = per-bar (target, stop) prices
    instead of spec's ATR multiples (dynamic BUY levels).
    """
    n = len(close)
    if end is None or complete is None:
        end, complete = bar_horizon(n, spec.horizon)
    up = spec.direction == "up"
    label = np.full(n, np.nan)
    resolved = np.full(n, n, dtype=np.int64)
    outcome = np.full(n, PENDING, dtype=object)
    for t in range(n):
        a = atr_v[t]
        if not np.isfinite(a) or a <= 0:
            continue
        tgt, stp = spec.levels(close[t], a) if levels is None else (levels[0][t], levels[1][t])
        if not (np.isfinite(tgt) and np.isfinite(stp)):
            continue
        last = int(end[t])
        for j in range(t + 1, last + 1):
            stopped = low[j] <= stp if up else high[j] >= stp
            if stopped:
                label[t], resolved[t], outcome[t] = 0.0, j, STOP
                break
            reached = high[j] >= tgt if up else low[j] <= tgt
            if reached:
                label[t], resolved[t], outcome[t] = 1.0, j, TARGET
                break
        else:
            if complete[t]:
                label[t], resolved[t], outcome[t] = 0.0, last, EXPIRED
    return label, resolved, outcome
