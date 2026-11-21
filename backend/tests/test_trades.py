import numpy as np

from backend.app.quant.targets import TargetSpec
from backend.app.quant.trades import STOP, TARGET, TIME, TP_SIGNAL, TRAIL, simulate, summarize

# entry at 100 with ATR 1: target 102, stop 99; trailing starts at close >= 101, trails 1 below the best close
SPEC = TargetSpec("e", "entry", "entry", "up", horizon=5, target_atr=2.0, stop_atr=1.0, cooldown=1, model="hgb",
                  trail_after_atr=1.0, trail_atr=1.0)


def run(bars, tp=None):
    o, h, l, c = (np.array(x, float) for x in zip(*bars))
    tp = np.zeros(len(c), bool) if tp is None else np.array(tp, bool)
    end = min(SPEC.horizon, len(c) - 1)
    return simulate(0, o, h, l, c, 1.0, SPEC, tp, end, SPEC.horizon <= len(c) - 1)


ENTRY = (100, 100, 100, 100)


def test_target_exit():
    t = run([ENTRY, (100, 100.5, 99.5, 100.2), (100.3, 102.4, 100.1, 102)])
    assert t["reason"] == TARGET and t["price"] == 102 and t["days"] == 2 and abs(t["r"] - 2) < 1e-9


def test_gap_through_target_fills_at_open():
    t = run([ENTRY, (103, 104, 102.5, 103.5)])
    assert t["reason"] == TARGET and t["price"] == 103


def test_stop_and_gap_down_fill():
    assert run([ENTRY, (100, 100.2, 98.9, 99)])["price"] == 99
    t = run([ENTRY, (97, 98, 96, 97.5)])
    assert t["reason"] == STOP and t["price"] == 97 and t["r"] == -3


def test_trailing_stop_locks_profit():
    # close 101.5 -> trailing on, stop = 101.5 - 1 = 100.5; next day falls to 100 -> exit at 100.5
    t = run([ENTRY, (100, 101.6, 100, 101.5), (101.4, 101.5, 100, 100.2)])
    assert t["reason"] == TRAIL and t["price"] == 100.5 and t["return_pct"] > 0


def test_take_profit_signal_only_when_in_profit():
    bars = [ENTRY, (100, 100.5, 99.8, 99.9), (100, 100.8, 100, 100.6), (100.6, 100.9, 100.3, 100.5)]
    t = run(bars, tp=[0, 1, 1, 0])
    assert t["reason"] == TP_SIGNAL and t["days"] == 2 and t["price"] == 100.6  # day 1 was under water


def test_time_limit_and_open_trade():
    flat = [(100, 100.5, 99.5, 100.1)] * 5
    t = run([ENTRY] + flat)
    assert t["reason"] == TIME and t["days"] == 5
    t = run([ENTRY] + flat[:3])
    assert t["status"] == "open" and t["days"] == 3 and t["stop"] == 99


def test_summarize():
    s = summarize([run([ENTRY, (100.3, 102.4, 100.1, 102)]), run([ENTRY, (97, 98, 96, 97.5)])])
    assert s["trades"] == 2 and s["win_rate"] == 0.5 and s["reasons"][TARGET] == 1 and s["reasons"][STOP] == 1
    assert s["profit_factor"] == round(0.02 / 0.03, 2)


def test_bracket_order_has_no_trailing_or_signal_exit():
    bracket = TargetSpec("b", "b", "entry", "up", horizon=5, target_atr=2.0, stop_atr=1.0, cooldown=1, model="hgb")
    o, h, l, c = (np.array(x, float) for x in zip(*[ENTRY, (100, 101.6, 100, 101.5), (101.4, 101.5, 100, 100.2),
                                                    (100.2, 100.5, 99.5, 100), (100, 100.4, 99.6, 100.1),
                                                    (100.1, 100.3, 99.8, 100.05)]))
    t = simulate(0, o, h, l, c, 1.0, bracket, None, 5, True)
    assert t["reason"] == TIME and t["price"] == 100.05   # no trailing stop: held to the time limit
