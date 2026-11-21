"""The vectorised labeler / trade simulator give exactly the results of the original bar-by-bar loops."""
import numpy as np

from backend.app.quant.targets import SHORT, STOP, TARGET, EXPIRED, PENDING, bar_horizon, triple_barrier
from backend.app.quant.trades import STOP as T_STOP, TARGET as T_TARGET, TIME, TP_SIGNAL, simulate


def loop_labels(high, low, close, atr_v, tp, sl, end, complete):
    n = len(close)
    label, resolved, outcome = np.full(n, np.nan), np.full(n, n), np.full(n, PENDING, dtype=object)
    for t in range(n):
        tgt, stp = close[t] + tp * atr_v[t], close[t] - sl * atr_v[t]
        for j in range(t + 1, int(end[t]) + 1):
            if low[j] <= stp:
                label[t], resolved[t], outcome[t] = 0.0, j, STOP
                break
            if high[j] >= tgt:
                label[t], resolved[t], outcome[t] = 1.0, j, TARGET
                break
        else:
            if complete[t]:
                label[t], resolved[t], outcome[t] = 0.0, int(end[t]), EXPIRED
    return label, resolved, outcome


def loop_trade(i, open_, high, low, close, target, stop, tp_signal, end, complete):
    entry = close[i]
    for j in range(i + 1, end + 1):
        if low[j] <= stop:
            return j, min(open_[j], stop), T_STOP
        if high[j] >= target:
            return j, max(open_[j], target), T_TARGET
        if tp_signal is not None and tp_signal[j] and close[j] > entry:
            return j, close[j], TP_SIGNAL
        if j == end and complete:
            return j, close[j], TIME
    return None


def market(seed, n=600):
    rng = np.random.default_rng(seed)
    close = 100 + np.cumsum(rng.normal(0, 1, n))
    open_ = close + rng.normal(0, 0.4, n)
    high = np.maximum(open_, close) + rng.random(n)
    low = np.minimum(open_, close) - rng.random(n)
    return open_, high, low, close, np.full(n, 1.5), rng.random(n) < 0.05


def test_labels_match_the_loop():
    for seed in range(5):
        open_, high, low, close, a, _ = market(seed)
        for horizon in (5, 20, 80):
            end, complete = bar_horizon(len(close), horizon)
            got = triple_barrier(high, low, close, a, SHORT, end, complete,
                                 levels=(close + 1.5 * a, close - 1.0 * a))
            exp = loop_labels(high, low, close, a, 1.5, 1.0, end, complete)
            assert np.array_equal(got[0], exp[0], equal_nan=True)
            assert np.array_equal(got[1], exp[1]) and list(got[2]) == list(exp[2])


def test_trades_match_the_loop():
    for seed in range(5):
        open_, high, low, close, a, sig = market(seed)
        n = len(close)
        for horizon in (5, 20, 80):
            end, complete = bar_horizon(n, horizon)
            for i in range(0, n - 1, 7):
                for tps in (None, sig):
                    t = simulate(i, open_, high, low, close, a[i], SHORT, tps, int(end[i]), bool(complete[i]),
                                 (close[i] + 2 * a[i], close[i] - 1 * a[i]))
                    exp = loop_trade(i, open_, high, low, close, close[i] + 2 * a[i], close[i] - 1 * a[i], tps,
                                     int(end[i]), bool(complete[i]))
                    if exp is None:
                        assert t["status"] == "open"
                    else:
                        assert (t["exit_index"], t["price"], t["reason"]) == (exp[0], float(exp[1]), exp[2])
