"""Optimized ATR profit-take / stop-loss for BUY: chosen by backtested profit, walk-forward (no look-ahead).

For every profit-take x stop-loss combination of the grid (multiples of the daily ATR):
  1. label every bar with that combination (profit-take before stop-loss within the holding window, 20 sessions),
  2. retrain the BUY model walk-forward on those labels (one retrain per block of `step` bars),
  3. trade its BUY decisions (setup AND P >= threshold, one per cooldown) with that bracket (the usual trade:
     profit-take / stop-loss / SELL signal while in profit / close at the end of the holding window).
Then, at the start of every block, the combination with the best TOTAL RETURN over the trades that had already
CLOSED in the previous LOOKBACK bars is chosen for that block (the default 1.5 / 1.0 until a combination has
MIN_TRADES such trades). The composite BUY model uses, in each block, the probabilities / levels / outcomes of the
combination chosen for it, so every decision and every choice uses only outcomes known at that time.
Today's decision uses the combination that is best today (all trades closed so far, same rule).

Cost: one full walk-forward retrain per combination (len(GRID_TP) x len(GRID_SL)).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import model as qm
from .brackets import Levels, fixed_levels
from .targets import TargetSpec, triple_barrier
from .trades import simulate

GRID_TP = (1.0, 1.5, 2.0, 3.0)    # profit-take, x daily ATR
GRID_SL = (0.75, 1.0, 1.5)        # stop-loss, x daily ATR
DEFAULT = (1.5, 1.0)
LOOKBACK = 252                    # bars of closed trades that score a combination
MIN_TRADES = 3                    # closed trades a combination needs before it can be chosen
FOLDS = 20                        # walk-forward retrains per combination (cheaper than the normal 60)
WARMUP = 252                      # bars before the evaluation window, so the first choice has trades to score
BASIS = "optimized"


@dataclass
class Combo:
    tp: float
    sl: float
    lv: Levels
    label: np.ndarray
    resolved: np.ndarray
    outcome: np.ndarray
    wf: qm.WalkForward
    trades: list[tuple[int, int, float]]   # (entry bar, exit bar, return %) of its closed BUY trades


def signal_bars(prob, threshold, setup, start: int, end: int, cooldown: int) -> list[int]:
    """BUY decisions: in a setup, P >= threshold, at most one per cooldown (same rule as the analysis)."""
    out, last = [], -10**9
    for i in range(start, end):
        p, t = prob[i], threshold[i]
        if not setup[i] or not (np.isfinite(p) and np.isfinite(t)) or p < t or i - last <= cooldown:
            continue
        last = i
        out.append(i)
    return out


def score(trades: list[tuple[int, int, float]], s: int, lookback: int = LOOKBACK) -> tuple[float, int]:
    """Total return (%) and count of the trades that entered in the last `lookback` bars and CLOSED before bar s."""
    sel = [r for i, j, r in trades if j < s and i >= s - lookback]
    return float(sum(sel)), len(sel)


def choose(trades_by_combo: list[list[tuple[int, int, float]]], s: int, default: int,
           lookback: int = LOOKBACK, min_trades: int = MIN_TRADES) -> tuple[int, float, int, bool]:
    """(combination, its score %, its trades, fallback?) for a block starting at bar s - only past outcomes."""
    best, best_score, best_n = default, None, 0
    for k, tr in enumerate(trades_by_combo):
        total, count = score(tr, s, lookback)
        if count < min_trades:
            continue
        if best_score is None or total > best_score + 1e-9:
            best, best_score, best_n = k, total, count
    if best_score is None:
        total, count = score(trades_by_combo[default], s, lookback)
        return default, total, count, True
    return best, best_score, best_n, False


def run_combo(tp: float, sl: float, X, open_, high, low, close, a, spec: TargetSpec, hz, setup, tps,
              start: int, window: int, step: int) -> Combo:
    lv = fixed_levels(close, a, tp, sl)
    lv.target_basis[:] = BASIS
    lv.stop_basis[:] = BASIS
    label, resolved, outcome = triple_barrier(high, low, close, a, spec, hz.end, hz.complete,
                                              levels=(lv.target, lv.stop))
    wf = qm.walk_forward(X, label, resolved, start=start, window=window, step=step, kind=spec.model, keep=True)
    trades = []
    for i in signal_bars(wf.prob, wf.threshold, setup, start, len(close), hz.cooldown):
        t = simulate(i, open_, high, low, close, a[i], spec, tps, int(hz.end[i]), bool(hz.complete[i]), lv.at(i))
        if t["status"] == "closed":
            trades.append((i, int(t["exit_index"]), float(t["return_pct"]) * 100))
    return Combo(tp, sl, lv, label, resolved, outcome, wf, trades)


def compose(combos: list[Combo], blocks: list[tuple[int, int]], picks: list[tuple[int, float, int, bool]],
            default: int):
    """One composite BUY model: in each block the arrays of the combination chosen for it."""
    base = combos[default]
    n = len(base.label)
    label, resolved, outcome = base.label.copy(), base.resolved.copy(), base.outcome.copy()
    prob, brate, thr = np.full(n, np.nan), np.full(n, np.nan), np.full(n, np.nan)
    target, stop = base.lv.target.copy(), base.lv.stop.copy()
    models = []
    for (s, e), (k, *_rest) in zip(blocks, picks):
        c = combos[k]
        part = slice(s, e)
        label[part], resolved[part], outcome[part] = c.label[part], c.resolved[part], c.outcome[part]
        prob[part], brate[part], thr[part] = c.wf.prob[part], c.wf.base[part], c.wf.threshold[part]
        target[part], stop[part] = c.lv.target[part], c.lv.stop[part]
        fold = c.wf.fold_at(s)
        if fold is not None:
            models.append(fold)
    wf = qm.WalkForward(prob, brate, thr, len(models), models)
    lv = Levels(target, stop, np.full(n, BASIS, dtype=object), np.full(n, BASIS, dtype=object))
    return label, resolved, outcome, wf, lv


def _stats(trades: list[tuple[int, int, float]]) -> dict:
    r = [x for _, _, x in trades]
    return {"trades": len(r), "total_return_pct": round(sum(r), 2),
            "avg_return_pct": round(sum(r) / len(r), 2) if r else None,
            "win_rate": round(sum(x > 0 for x in r) / len(r), 3) if r else None}


def optimize(X, open_, high, low, close, a, spec: TargetSpec, hz, setup, tps, *, w0: int, window: int,
             min_step: int, stamps: list[str]) -> dict:
    n = len(close)
    start = max(0, w0 - WARMUP)
    step = max(min_step, int(np.ceil((n - start) / FOLDS)))
    combos = [run_combo(tp, sl, X, open_, high, low, close, a, spec, hz, setup, tps, start, window, step)
              for tp in GRID_TP for sl in GRID_SL]
    default = next(k for k, c in enumerate(combos) if (c.tp, c.sl) == DEFAULT)
    trades = [c.trades for c in combos]
    blocks = [(s, min(s + step, n)) for s in range(start, n, step)]
    picks = [choose(trades, s, default) for s, _ in blocks]
    label, resolved, outcome, wf, lv = compose(combos, blocks, picks, default)

    # today's choice: the same rule with every trade closed so far
    now_k, now_score, now_n, now_fb = choose(trades, n, default)
    cur = combos[now_k]
    info = {
        "tp_values": list(GRID_TP), "sl_values": list(GRID_SL), "default": {"tp": DEFAULT[0], "sl": DEFAULT[1]},
        "lookback": LOOKBACK, "min_trades": MIN_TRADES, "step": step, "combos": len(combos),
        "folds_per_combo": combos[default].wf.folds,
        # each combination traded on its own over the evaluation window (hindsight reference: picking the best of
        # these afterwards would be optimistic)
        "grid": [{"tp": c.tp, "sl": c.sl, **_stats([t for t in c.trades if t[0] >= w0])} for c in combos],
        "choices": [{"start": stamps[s], "end": stamps[e - 1], "tp": combos[k].tp, "sl": combos[k].sl,
                     "score_pct": round(sc, 2), "trades": cnt, "fallback": fb}
                    for (s, e), (k, sc, cnt, fb) in zip(blocks, picks) if e > w0],
        "current": {"tp": cur.tp, "sl": cur.sl, "as_of": stamps[-1], "score_pct": round(now_score, 2),
                    "trades": now_n, "fallback": now_fb},
    }
    return {"label": label, "resolved": resolved, "outcome": outcome, "wf": wf, "lv": lv, "step": step,
            "current": cur, "info": info}
