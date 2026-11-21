"""Trade simulation for entry signals: where would profit have been taken (or the loss cut)?

A long trade opens at the signal bar's close. Each following bar, in this order:
  1. low  <= stop    -> exit at the stop (or at the open if it gapped below)          "stop" / "trailing stop"
  2. high >= target  -> exit at the target (or at the open if it gapped above)        "target"
     (a bar touching both counts as the stop: the order inside the bar is unknown - conservative)
  3. (only if trail_after_atr > 0) at the close: once the close is trail_after_atr x ATR above entry, the stop
     trails the highest close by trail_atr x ATR (never moves down)
  4. (only if a take-profit signal array is given) take-profit signal at the close while in profit -> exit at close
  5. last bar of the horizon -> exit at the close                                              "time limit"
Short-term entries are plain bracket orders (steps 1, 2, 5). ATR is fixed at entry. Returns are before costs.
"""
from __future__ import annotations

import numpy as np

from .targets import TargetSpec

STOP, TRAIL, TARGET, TP_SIGNAL, TIME = "stop", "trailing stop", "target", "take-profit signal", "time limit"
_NEVER = 1 << 62
REASONS = (TARGET, TRAIL, TP_SIGNAL, TIME, STOP)


def simulate(i: int, open_, high, low, close, atr_entry: float, spec: TargetSpec, tp_signal: np.ndarray | None,
             end: int, complete: bool, levels: tuple[float, float] | None = None) -> dict:
    """Simulate one trade entered at bar i's close whose horizon ends at bar `end` (`complete` = that bar exists
    as the true end of the horizon). `levels` = (target, stop) prices instead of spec's ATR multiples.
    Returns exit details, or the live state if the trade is still open."""
    n = len(close)
    entry = float(close[i])
    target, stop = spec.levels(entry, atr_entry) if levels is None else levels
    initial_stop = stop
    risk = entry - initial_stop
    best_close = entry
    trailing = False
    trail = spec.trail_after_atr > 0

    def done(j: int, price: float, reason: str) -> dict:
        return {"status": "closed", "exit_index": j, "price": float(price), "reason": reason,
                "return_pct": float(price / entry - 1), "r": float((price - entry) / risk), "days": j - i}

    if not trail:
        # Plain bracket (vectorised - horizons can be thousands of intraday bars): the first bar with a stop /
        # target / take-profit signal in profit, in that order within a bar; else the time limit.
        if end > i:
            seg = slice(i + 1, end + 1)
            hits = [low[seg] <= stop, high[seg] >= target]
            if tp_signal is not None:
                hits.append(np.asarray(tp_signal[seg], dtype=bool) & (close[seg] > entry))
            firsts = [int(h.argmax()) if h.any() else _NEVER for h in hits]
            k = min(firsts)
            if k != _NEVER:
                j = i + 1 + k
                if firsts[0] == k:
                    return done(j, min(open_[j], stop), STOP)
                if firsts[1] == k:
                    return done(j, max(open_[j], target), TARGET)
                return done(j, close[j], TP_SIGNAL)
            if complete:
                return done(end, close[end], TIME)
        price = float(close[-1])
        return {"status": "open", "price": price, "stop": float(stop), "target": float(target), "trailing": False,
                "return_pct": float(price / entry - 1), "r": float((price - entry) / risk), "days": n - 1 - i}

    for j in range(i + 1, end + 1):
        if low[j] <= stop:
            return done(j, min(open_[j], stop), TRAIL if trailing and stop > initial_stop else STOP)
        if high[j] >= target:
            return done(j, max(open_[j], target), TARGET)
        if trail:
            best_close = max(best_close, close[j])
            if not trailing and close[j] >= entry + spec.trail_after_atr * atr_entry:
                trailing = True
            if trailing:
                stop = max(stop, best_close - spec.trail_atr * atr_entry)
        if tp_signal is not None and tp_signal[j] and close[j] > entry:
            return done(j, close[j], TP_SIGNAL)
        if j == end and complete:
            return done(j, close[j], TIME)

    price = float(close[-1])
    return {"status": "open", "price": price, "stop": float(stop), "target": float(target), "trailing": trailing,
            "return_pct": float(price / entry - 1), "r": float((price - entry) / risk), "days": n - 1 - i}


def summarize(results: list[dict]) -> dict:
    """Win rate, average / median return, R multiple, profit factor, holding bars and exit-reason counts."""
    closed = [r for r in results if r["status"] == "closed"]
    if not closed:
        return {"trades": 0, "open": len(results)}
    ret = np.array([r["return_pct"] for r in closed])
    gains, losses = ret[ret > 0].sum(), -ret[ret < 0].sum()
    return {
        "trades": len(closed),
        "open": len(results) - len(closed),
        "win_rate": round(float((ret > 0).mean()), 3),
        "avg_return_pct": round(float(ret.mean()) * 100, 3),
        "median_return_pct": round(float(np.median(ret)) * 100, 3),
        "avg_r": round(float(np.mean([r["r"] for r in closed])), 3),
        "profit_factor": round(float(gains / losses), 2) if losses > 0 else None,
        "avg_days": round(float(np.mean([r["days"] for r in closed])), 1),
        "reasons": {k: sum(r["reason"] == k for r in closed) for k in REASONS},
    }
