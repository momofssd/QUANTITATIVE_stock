"""Interim lows / highs: adaptive swing size, zigzag turns, the gain / risk points the models learn, when known."""
import numpy as np

from backend.app.quant import swings as qs


def bars(prices):
    """Close = the given path; high / low a hair around it."""
    c = np.array(prices, float)
    return c * 1.001, c * 0.999, c


def test_swing_size_is_causal_and_adapts_to_volatility():
    rng = np.random.default_rng(1)
    calm = 100 * np.exp(np.cumsum(rng.normal(0, 0.005, 400)))
    wild = 100 * np.exp(np.cumsum(rng.normal(0, 0.03, 400)))
    s_calm = qs.swing_size(*bars(calm))
    s_wild = qs.swing_size(*bars(wild))
    assert np.isnan(s_calm[:62]).all() and np.isfinite(s_calm[100:]).all()       # needs a quarter-year first
    assert np.nanmedian(s_wild) > 4 * np.nanmedian(s_calm)                       # a volatile stock: bigger swings
    # causal: the size at bar 200 is the same with or without the bars after it
    h, lo, c = bars(wild)
    assert qs.swing_size(h[:201], lo[:201], c[:201])[200] == s_wild[200]


def test_zigzag_finds_alternating_turns_confirmed_after_the_move():
    path = [100, 96, 92, 90, 93, 97, 101, 104, 100, 95, 91, 94, 99]       # low 90, high 104, low 91
    h, lo, c = bars(path)
    size = np.full(len(path), 0.05)                                           # 5% swings
    turns = qs.zigzag(h, lo, size)
    # the start (100) is a high once price has fallen 5% below it; then low 90, high 104, low 91
    assert [(t.kind, t.i) for t in turns] == [("high", 0), ("low", 3), ("high", 7), ("low", 10)]
    # each turn is known only once price has moved 5% away from it
    assert [t.confirmed for t in turns] == [2, 5, 9, 12]
    assert all(t.confirmed > t.i for t in turns)


def test_gain_and_risk_are_the_points_to_the_next_interim_high_and_the_drawdown_before_it():
    from backend.app.quant.targets import met
    path = [100, 96, 92, 90, 93, 97, 101, 104, 102, 100, 95, 91, 94, 99]
    h, lo, c = bars(path)
    rr = qs.risk_reward(h, lo, c, size=np.full(len(path), 0.05))
    # turns: high 0, low 3 (89.91), high 7 (104.104, confirmed at bar 10), low 11; one swing = 5% of the close
    assert rr.high_at[:7].tolist() == [7] * 7 and rr.resolved[:7].tolist() == [10] * 7
    # bar 0 (close 100): gain to 104.104 = 0.82 swing, risk = down to the low 89.91 on the way = 2.02 swings
    assert abs(rr.gain[0] - 4.104 / 5) < 1e-9 and abs(rr.risk[0] - 10.09 / 5) < 1e-9
    # bar 3 (close 90, the low): gain 3.13 swings, no lower low before the high -> risk 0
    assert abs(rr.gain[3] - 14.104 / 4.5) < 1e-9 and rr.risk[3] == 0
    # bar 6 (close 101, rising): little left to gain, no drawdown
    assert abs(rr.gain[6] - 3.104 / 5.05) < 1e-9 and rr.risk[6] == 0
    # from the high on, the next interim high is not confirmed yet: pending
    assert np.isnan(rr.gain[7:]).all() and (rr.resolved[7:] == len(path)).all()
    # what each decision would have needed: BUY at the low met its bar, SELL at the start (risk 2.02 > 1.5 x 0.82)
    assert met("entry", rr.gain, rr.risk)[3] == 1 and met("entry", rr.gain, rr.risk)[0] == 0
    assert met("take_profit", rr.gain, rr.risk)[0] == 1 and met("take_profit", rr.gain, rr.risk)[3] == 0
    assert np.isnan(met("entry", rr.gain, rr.risk)[8])


def test_points_never_known_before_their_bar():
    rng = np.random.default_rng(3)
    c = 100 * np.exp(np.cumsum(rng.normal(0, 0.02, 800)))
    rr = qs.risk_reward(*bars(c))
    known = ~np.isnan(rr.gain)
    assert known.sum() > 300 and (known == ~np.isnan(rr.risk)).all()
    assert (rr.resolved[known] > np.flatnonzero(known)).all()                 # never known at its own bar
    assert (rr.high_at[known] > np.flatnonzero(known)).all()                  # the high is after the bar
    assert (rr.risk[known] >= 0).all() and 0.3 < np.nanmedian(rr.gain) < 3
