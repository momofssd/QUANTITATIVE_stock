import numpy as np
import pandas as pd

from backend.app.quant import model as qm
from backend.app.quant.cost_check import average_cost_check, harmonic_mean, sma
from backend.app.quant.targets import (EXPIRED, PENDING, STOP, TARGET, TargetSpec, atr, session_horizon,
                                       triple_barrier)

SPEC = TargetSpec("t", "test", "entry", "up", horizon=3, target_atr=1.0, stop_atr=1.0, cooldown=1, model="hgb")


def run(high, low, close, a=1.0):
    n = len(close)
    return triple_barrier(np.array(high, float), np.array(low, float), np.array(close, float), np.full(n, a), SPEC)


def test_target_hit_first():
    label, resolved, outcome = run([10, 10.5, 11.2, 10], [10, 9.5, 10.5, 9], [10, 10, 11, 10])
    assert label[0] == 1.0 and resolved[0] == 2 and outcome[0] == TARGET


def test_stop_hit_first():
    label, resolved, outcome = run([10, 10.2, 12, 10], [10, 8.9, 10, 10], [10, 10, 11, 10])
    assert label[0] == 0.0 and resolved[0] == 1 and outcome[0] == STOP


def test_both_barriers_same_day_counts_as_stop():
    label, _, outcome = run([10, 11.5, 10, 10], [10, 8.5, 10, 10], [10, 10, 10, 10])
    assert label[0] == 0.0 and outcome[0] == STOP


def test_expired_and_pending():
    label, resolved, outcome = run([10] * 6, [10] * 6, [10] * 6)
    assert outcome[0] == EXPIRED and label[0] == 0.0 and resolved[0] == 3
    assert outcome[-1] == PENDING and np.isnan(label[-1]) and resolved[-1] == 6  # n = unresolved


def test_train_mask_excludes_outcomes_not_yet_known():
    y = np.array([1, 0, 1, 0, 1, np.nan], float)
    resolved = np.array([3, 4, 5, 6, 7, 6])
    m = qm.train_mask(y, resolved, cutoff=5, window=10)
    # rows 0 and 1 resolved before bar 5; row 2 resolves exactly at 5 -> not yet known when predicting bar 5
    assert m.tolist() == [True, True, False, False, False, False]
    assert qm.train_mask(y, resolved, cutoff=5, window=4).tolist() == [False, True, False, False, False, False]


def test_threshold_and_reliability():
    assert abs(qm.threshold_for(0.30) - 0.45) < 1e-9
    assert qm.threshold_for(0.0) == qm.THRESHOLD_BOUNDS[0]
    assert qm.threshold_for(0.95) == qm.THRESHOLD_BOUNDS[1]
    assert qm.reliability(0.60, 0.40, 0.30)[0] is True
    assert qm.reliability(0.50, 0.40, 0.30)[0] is False          # AUC near chance
    assert qm.reliability(0.60, 0.25, 0.30)[0] is False          # entries no better than base rate
    assert qm.reliability(None, None, None)[0] is False


def test_walk_forward_finds_planted_signal():
    rng = np.random.default_rng(0)
    n = 900
    x = rng.normal(size=(n, 3))
    y = (x[:, 0] + 0.3 * rng.normal(size=n) > 0).astype(float)
    resolved = np.arange(n) + 1
    for kind in ("hgb", "logistic"):
        wf = qm.walk_forward(x, y, resolved, start=400, window=400, step=50, kind=kind)
        p = wf.prob[400:]
        assert np.isnan(wf.prob[:400]).all() and not np.isnan(p).any()
        assert ((p > 0.5) == (y[400:] == 1)).mean() > 0.8


def test_atr_is_wilder_smoothed_true_range():
    idx = pd.RangeIndex(30)
    h, l, c = pd.Series(11.0, idx), pd.Series(9.0, idx), pd.Series(10.0, idx)
    a = atr(h, l, c)
    assert a.isna().sum() == 13 and abs(a.iloc[-1] - 2.0) < 1e-9


def test_take_profit_direction_is_mirrored():
    spec = TargetSpec("tp", "tp", "take_profit", "down", horizon=3, target_atr=1.0, stop_atr=1.0, cooldown=1, model="hgb")
    h, l, c = (np.array(x, float) for x in ([10, 10.2, 10, 10], [10, 8.9, 10, 10], [10, 10, 10, 10]))
    label, _, outcome = triple_barrier(h, l, c, np.ones(4), spec)
    assert label[0] == 1.0 and outcome[0] == TARGET           # fell 1 ATR first -> take-profit was right
    h2 = np.array([10, 11.1, 10, 10], float)
    label, _, outcome = triple_barrier(h2, l, c, np.ones(4), spec)
    assert label[0] == 0.0 and outcome[0] == STOP              # touched both on the same day -> conservative


def test_session_horizon_counts_trading_sessions_not_bars():
    # 3 sessions x 4 bars (minutes 570, 600, 630, 660); 1-session horizon from each bar
    ordinal = np.repeat([0, 1, 2], 4)
    minute = np.tile([570, 600, 630, 660], 3)
    end, complete = session_horizon(ordinal, minute, 1)
    assert end[1] == 5                       # bar at 10:00 day 0 -> through 10:00 day 1
    assert end[0] == 4 and complete[0]
    assert end[9] == 11 and not complete[9]  # day 2 has no next session yet


def test_average_cost_check():
    close = np.array([100.0] * 60 + [80.0, 120.0, 130.0])
    c = average_cost_check([60, 61], close, w0=0)
    assert abs(c["avg_cost"] - harmonic_mean(np.array([80.0, 120.0]))) < 1e-9   # equal dollars per buy
    assert c["sma_now"] == sma(close)[-1] and c["validated"] is True and c["entries"] == 2
    bad = average_cost_check([62], close, w0=0)
    assert bad["validated"] is False and bad["verdict"].startswith("Not validated")
    assert average_cost_check([], close, w0=0)["entries"] == 0
