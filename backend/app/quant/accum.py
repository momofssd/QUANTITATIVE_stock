"""BUY model for the sell-signal strategy ("accumulate: every BUY adds a lot, the next SELL sells everything").

That strategy has no profit-take, stop-loss or time limit, so its BUY model learns a different outcome than the
profit-take / stop-loss BUY model:

  label of bar t = 1 if a lot bought at t's close is sold at a PROFIT at the close of the NEXT SELL decision
                   0 if at a loss
                   NaN while no SELL (or, before the SELL model exists, no interim-top setup) has come yet
  resolved_at    = that SELL bar (the outcome is known at its close; training only uses outcomes known before
                   the bars it predicts - same rule as everywhere else)

The SELL decisions are the SELL model's own out-of-sample walk-forward decisions (interim top AND P >= threshold,
one per cooldown), so the labels never use hindsight. Before the SELL model makes its first decision (it needs its
own training history first - years on weekly bars), the interim-top SETUP (a rule on past prices only, same
cooldown) stands in for SELL in these labels, so BUY S can start learning as early as the other models. Trades and
simulations always exit at real SELL decisions.
"""
from __future__ import annotations

import numpy as np

from .brackets import Levels
from .targets import PENDING, STOP, TARGET
from .trades import SELL_DECISION

BASIS = "next SELL"


def label_sells(model_sells: np.ndarray, top_setup: np.ndarray, cooldown: int, active_from: int) -> np.ndarray:
    """SELL points for the labels: interim-top setup bars (one per cooldown) before `active_from` (the SELL model's
    first decision bar), the SELL model's decisions from then on."""
    proxy, last = [], -10**9
    for i in range(min(active_from, len(top_setup))):
        if top_setup[i] and i - last > cooldown:
            last = i
            proxy.append(i)
    model = model_sells[model_sells >= active_from]
    return np.concatenate([np.asarray(proxy, dtype=np.int64), model.astype(np.int64)])


def next_sell_labels(close: np.ndarray, sell_idx: np.ndarray, active_from: int):
    """(label, resolved_at, outcome) per bar for "profit at the next SELL decision"."""
    n = len(close)
    label = np.full(n, np.nan)
    resolved = np.full(n, n, dtype=np.int64)
    outcome = np.full(n, PENDING, dtype=object)
    if len(sell_idx) == 0:
        return label, resolved, outcome
    t = np.arange(n)
    pos = np.searchsorted(sell_idx, t, side="right")        # first SELL strictly after t
    ok = (pos < len(sell_idx)) & (t >= active_from)
    tt = t[ok]
    j = sell_idx[pos[ok]]
    win = close[j] > close[tt]
    label[tt] = win.astype(float)
    resolved[tt] = j
    outcome[tt] = np.where(win, TARGET, STOP)
    return label, resolved, outcome


def trade(i: int, close: np.ndarray, atr_i: float, sell_idx: np.ndarray) -> dict:
    """Buy at bar i's close, sell at the close of the next SELL decision (simulate()-compatible result)."""
    n = len(close)
    entry = float(close[i])
    unit = atr_i if np.isfinite(atr_i) and atr_i > 0 else float("nan")
    pos = int(np.searchsorted(sell_idx, i, side="right"))
    if pos < len(sell_idx):
        j = int(sell_idx[pos])
        price = float(close[j])
        return {"status": "closed", "exit_index": j, "price": price, "reason": SELL_DECISION,
                "return_pct": price / entry - 1, "r": (price - entry) / unit, "days": j - i}
    price = float(close[-1])
    return {"status": "open", "price": price, "stop": float("nan"), "target": float("nan"), "trailing": False,
            "return_pct": price / entry - 1, "r": (price - entry) / unit, "days": n - 1 - i}


def no_levels(n: int) -> Levels:
    """This strategy has no profit-take / stop-loss."""
    return Levels(np.full(n, np.nan), np.full(n, np.nan), np.full(n, BASIS, dtype=object),
                  np.full(n, BASIS, dtype=object))
