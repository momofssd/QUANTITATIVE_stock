import numpy as np
import pytest

from backend.app.quant import brackets as qb
from backend.app.quant import portfolio


# ---------------------------------------------------------------- profit-take / stop-loss levels
def test_fixed_levels():
    lv = qb.fixed_levels(np.array([100.0]), np.array([2.0]), 1.5, 1.0)
    assert lv.at(0) == (103.0, 98.0)
    lv = qb.fixed_levels(np.array([100.0]), np.array([2.0]), 1.5, 1.0, sign=-1)
    assert lv.at(0) == (97.0, 102.0)


# ---------------------------------------------------------------- $100 simulation
def ev(i, price, exit_=None, setup="rebound"):
    return {"i": i, "time": i * 100, "date": f"d{i}", "price": price, "exit": exit_, "setup": setup}


def test_every_buy_adds_a_lot_and_the_sell_sells_all():
    buys = [ev(1, 100.0), ev(3, 80.0, setup="trend"), ev(6, 50.0)]
    sells = [ev(0, 1.0), ev(5, 110.0), ev(7, 40.0)]
    r = portfolio.run(buys, sells, ev(9, 45.0), use_bracket=False)
    s = r["summary"]
    # lots d1 @100 and d3 @80 both sold at the d5 SELL @110 (+$10, +$37.50); lot d6 @50 sold d7 @40 (-$20)
    assert [t["pnl"] for t in r["trades"]] == [-20.0, 37.5, 10.0]            # newest lot first
    assert r["trades"][1]["sell_date"] == r["trades"][2]["sell_date"] == "d5"
    assert s["lots"] == 3 and s["closed"] == 3 and s["wins"] == 2 and s["win_rate"] == 0.667
    assert s["realized_pnl"] == 27.5 and s["total_pnl"] == 27.5 and s["invested"] == 300
    assert s["max_lots"] == 2 and s["max_capital"] == 200 and s["return_pct"] == 13.75 and s["sells_used"] == 2
    reb, tr = r["by_setup"]["rebound"], r["by_setup"]["trend"]
    assert (reb["lots"], reb["wins"], reb["win_rate"], reb["realized_pnl"]) == (2, 1, 0.5, -10.0)
    assert (tr["lots"], tr["wins"], tr["win_rate"], tr["realized_pnl"]) == (1, 1, 1.0, 37.5)


def test_open_lots_are_marked_to_the_last_close():
    r = portfolio.run([ev(1, 100.0), ev(2, 50.0)], [], ev(9, 120.0), use_bracket=False)
    s = r["summary"]
    assert s["closed"] == 0 and s["open"] == 2 and s["win_rate"] is None
    assert s["open_pnl"] == 160.0 and s["realized_pnl"] == 0 and s["max_lots"] == 2
    assert all(t["status"] == "open" and t["reason"] == "open" for t in r["trades"])


def test_bracket_exit_comes_before_a_later_sell():
    stop_hit = {"i": 3, "time": 300, "date": "d3", "price": 95.0, "reason": "stop"}
    buys = [ev(1, 100.0, stop_hit), ev(4, 96.0)]
    sells = [ev(5, 99.0)]
    with_b = portfolio.run(buys, sells, ev(9, 99.0), use_bracket=True)
    assert [t["reason"] for t in with_b["trades"]] == ["sell", "stop"]        # lot d1 stopped out on d3
    assert with_b["summary"]["realized_pnl"] == pytest.approx(-5 + 100 / 96 * 99 - 100, abs=0.01)
    assert with_b["summary"]["max_lots"] == 1                                 # stopped before the d4 BUY
    without = portfolio.run(buys, sells, ev(9, 99.0), use_bracket=False)
    assert [t["reason"] for t in without["trades"]] == ["sell", "sell"]       # both sold at the d5 SELL
    assert without["trades"][1]["pnl"] == -1.0 and without["summary"]["max_lots"] == 2


def test_one_share_sizing():
    buys = [ev(1, 100.0), ev(3, 80.0, setup="trend")]
    r = portfolio.run(buys, [ev(5, 110.0)], ev(9, 45.0), use_bracket=False, sizing="share")
    assert [t["pnl"] for t in r["trades"]] == [30.0, 10.0] and [t["cost"] for t in r["trades"]] == [80.0, 100.0]
    s = r["summary"]
    assert s["invested"] == 180.0 and s["max_capital"] == 180.0 and s["return_pct"] == round(40 / 180 * 100, 2)
    assert r["by_setup"]["trend"]["realized_pnl"] == 30.0 and r["trades"][0]["pnl_pct"] == 37.5


def test_same_bar_sell_then_buy_and_period_start():
    buys = [ev(i, 100.0) for i in range(40)]
    sim = portfolio.simulate_decisions({"sell_only": buys, "with_bracket": buys[:5]}, [ev(5, 1.0), ev(20, 110.0)],
                                       ev(50, 100.0))
    so = sim["usd"]["sell_only"]
    assert so["buys"] == portfolio.LISTED and so["start_date"] == "d10"     # the 30 most recent BUYs
    assert so["sells"] == 1                                                 # the SELL before the period is ignored
    wb = sim["usd"]["with_bracket"]                                         # each strategy has its own BUYs / period
    assert wb["buys"] == 5 and wb["start_date"] == "d0" and wb["sells"] == 2
    assert set(sim) >= {"usd", "share"}
    lots = sim["usd"]["sell_only"]["trades"]
    assert sum(t["sell_date"] == "d20" and t["reason"] == "sell" for t in lots) == 10   # d10..d19 sold on d20
    d20 = next(t for t in lots if t["buy_date"] == "d20")
    assert d20["status"] == "open"                                          # bought after the d20 SELL
    assert so["hold_all"]["pnl"] == 0.0 and so["summary"]["max_lots"] == 20
    assert so["hold_all"]["shares"] == 30.0 and so["hold_all"]["cost"] == 3000.0 and so["hold_all"]["value"] == 3000.0
    sh = sim["share"]["sell_only"]["hold_all"]                                 # 1 share per BUY: 30 shares at $100
    assert (sh["shares"], sh["cost"], sh["value"]) == (30.0, 3000.0, 3000.0)
    assert sim["share"]["sell_only"]["summary"]["max_capital"] == 2000.0          # 20 shares at $100


def test_sell_signal_labels_use_the_setup_before_the_sell_model_exists():
    from backend.app.quant import accum as qa
    top = np.zeros(40, dtype=bool)
    top[[3, 4, 12, 30, 35]] = True
    model = np.array([25, 33], dtype=np.int64)          # the SELL model decides from bar 20 on
    sells = qa.label_sells(model, top, cooldown=2, active_from=20)
    assert sells.tolist() == [3, 12, 25, 33]            # setup bars (cooldown 2) before 20, model decisions after
    close = np.linspace(100, 139, 40)
    label, resolved, _ = qa.next_sell_labels(close, sells, 0)
    assert resolved[0] == 3 and resolved[5] == 12 and resolved[15] == 25 and np.isnan(label[34])
