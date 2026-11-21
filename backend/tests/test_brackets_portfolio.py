import numpy as np
import pandas as pd
import pytest

from backend.app.quant import brackets as qb
from backend.app.quant import portfolio


# ---------------------------------------------------------------- dynamic profit-take / stop-loss
def test_session_extreme_daily_and_intraday():
    low = np.array([10, 9, 11, 12, 13, 14, 15.0])
    assert qb.session_extreme(low, np.arange(7), 3, "min").tolist() == [10, 9, 9, 9, 11, 12, 13]
    # intraday: 3 sessions of 2 bars; today so far + the previous session
    lo = np.array([5, 4, 6, 3, 7, 8.0])
    ordn = np.array([0, 0, 1, 1, 2, 2])
    assert qb.session_extreme(lo, ordn, 2, "min").tolist() == [5, 4, 4, 3, 3, 3]
    # never uses a later bar of the same session (no look-ahead)
    assert qb.session_extreme(lo[:5], ordn[:5], 2, "min").tolist() == [5, 4, 4, 3, 3]


def test_dynamic_levels_follow_the_chart():
    n = 30
    close = np.full(n, 100.0)
    high, low = close + 1, close - 1
    low[-3] = 97.0                      # swing low 3 bars ago
    high[-8] = 112.0                    # prior high 8 bars ago: the fall 112 -> 97
    a = np.full(n, 2.0)
    setup = np.array([""] * n, dtype=object)
    setup[-1] = "rebound"
    lv = qb.dynamic_levels(close, high, low, a, np.arange(n), setup)
    # stop: 5-session low 97 - 0.2 ATR = 96.6 -> risk 3.4 (1.7 ATR, inside 0.5-2.5)
    assert np.isclose(lv.stop[-1], 96.6) and lv.stop_basis[-1] == "5-session low"
    # rebound target: 50% retracement 97 + 7.5 = 104.5 (room 4.5 >= 1x risk, <= 3 ATR)
    assert np.isclose(lv.target[-1], 104.5) and lv.target_basis[-1] == "50% retracement"
    # a trend / no-setup bar: 1.5x risk
    risk = close[-2] - lv.stop[-2]
    assert np.isclose(lv.target[-2] - close[-2], 1.5 * risk) and lv.target_basis[-2] == "1.5x risk"


def test_dynamic_levels_are_clamped():
    n = 12
    close = np.full(n, 100.0)
    high, low = close + 0.01, close - 0.01      # almost no range: stop would be tiny
    a = np.full(n, 2.0)
    lv = qb.dynamic_levels(close, high, low, a, np.arange(n), np.array([""] * n, dtype=object))
    assert np.isclose(close[-1] - lv.stop[-1], 0.75 * 2.0) and lv.stop_basis[-1] == "min 0.75 ATR"
    low[-2] = 80.0                               # far-away low: stop capped at 2.5 ATR
    lv = qb.dynamic_levels(close, high, low, a, np.arange(n), np.array([""] * n, dtype=object))
    assert np.isclose(close[-1] - lv.stop[-1], 2.5 * 2.0) and lv.stop_basis[-1] == "max 2.5 ATR"
    assert np.isclose(lv.target[-1] - close[-1], 3.5 * 2.0)   # 1.5 x 5 = 7.5 > cap 3.5 ATR = 7
    assert lv.target_basis[-1] == "cap 3.5 ATR"


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
    sim = portfolio.simulate_decisions(buys, [ev(5, 1.0), ev(20, 110.0)], ev(50, 100.0))
    assert sim["buys"] == portfolio.LISTED and sim["start_date"] == "d10"   # the 30 most recent BUYs
    assert sim["sells"] == 1                                                # the SELL before the period is ignored
    assert set(sim) >= {"usd", "share"}
    lots = sim["usd"]["sell_only"]["trades"]
    assert sum(t["sell_date"] == "d20" and t["reason"] == "sell" for t in lots) == 10   # d10..d19 sold on d20
    d20 = next(t for t in lots if t["buy_date"] == "d20")
    assert d20["status"] == "open"                                          # bought after the d20 SELL
    assert sim["usd"]["hold_all"]["pnl"] == 0.0 and sim["usd"]["sell_only"]["summary"]["max_lots"] == 20
    assert sim["share"]["sell_only"]["summary"]["max_capital"] == 2000.0          # 20 shares at $100
