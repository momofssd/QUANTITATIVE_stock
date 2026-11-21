import numpy as np

from backend.app.quant import model as qm
from backend.app.quant import optimize as qo
from backend.app.quant.brackets import fixed_levels


def test_score_uses_only_trades_closed_before_the_block_and_inside_the_lookback():
    trades = [(10, 15, 2.0), (20, 30, -1.0), (40, 50, 3.0), (5, 8, 9.0)]
    assert qo.score(trades, 50, lookback=100) == (10.0, 3)        # the trade closing AT bar 50 is not known yet
    assert qo.score(trades, 51, lookback=100) == (13.0, 4)
    assert qo.score(trades, 51, lookback=35) == (2.0, 2)          # entries before bar 16 are too old


def test_choose_best_profit_with_minimum_trades_and_default_fallback():
    a = [(0, 2, 1.0), (3, 5, 1.0), (6, 8, 1.0)]                   # +3 over 3 trades
    b = [(0, 2, 5.0), (3, 5, 5.0)]                                 # +10 but only 2 trades
    c = [(0, 2, 2.0), (3, 5, 2.0), (6, 8, -1.0)]                   # +3 over 3 trades (tie -> first one stays)
    k, sc, cnt, fb = qo.choose([a, b, c], 10, default=1, lookback=100, min_trades=3)
    assert (k, sc, cnt, fb) == (0, 3.0, 3, False)
    k, sc, cnt, fb = qo.choose([a, b, c], 6, default=1, lookback=100, min_trades=3)
    assert k == 1 and fb                                           # nobody has 3 closed trades yet -> default


def test_compose_takes_each_block_from_its_chosen_combination():
    n = 12
    close, a = np.full(n, 100.0), np.full(n, 2.0)

    def combo(tp, lab):
        lv = fixed_levels(close, a, tp, 1.0)
        prob = np.full(n, lab / 10)
        wf = qm.WalkForward(prob, prob, prob, 2, [(0, 6, f"m{tp}a", None), (6, 12, f"m{tp}b", None)])
        return qo.Combo(tp, 1.0, lv, np.full(n, float(lab)), np.arange(n), np.full(n, "x", dtype=object), wf, [])

    combos = [combo(1.0, 1), combo(2.0, 2)]
    label, resolved, outcome, wf, lv = qo.compose(combos, [(0, 6), (6, 12)], [(1, 0, 0, False), (0, 0, 0, False)],
                                                  default=0)
    assert label[:6].tolist() == [2.0] * 6 and label[6:].tolist() == [1.0] * 6
    assert np.allclose(lv.target[:6], 104.0) and np.allclose(lv.target[6:], 102.0)
    assert [m[2] for m in wf.models] == ["m2.0a", "m1.0b"]       # the deciding model of each block
    assert set(lv.target_basis) == {qo.BASIS}
