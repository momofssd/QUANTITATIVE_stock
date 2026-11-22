
"""Every BUY adds a lot, the next SELL sells everything ($100 or 1 share per BUY)."""
from backend.app.quant import portfolio


def ev(i, price, setup="rebound"):
    return {"i": i, "time": i * 100, "date": f"d{i}", "price": price, "setup": setup}


def test_every_buy_adds_a_lot_and_the_sell_sells_all():
    buys = [ev(1, 100.0), ev(3, 80.0, setup="trend"), ev(6, 50.0)]
    sells = [ev(0, 1.0), ev(5, 110.0), ev(7, 40.0)]
    r = portfolio.run(buys, sells, ev(9, 45.0))
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
    r = portfolio.run([ev(1, 100.0), ev(2, 50.0)], [], ev(9, 120.0))
    s = r["summary"]
    assert s["closed"] == 0 and s["open"] == 2 and s["win_rate"] is None
    assert s["open_pnl"] == 160.0 and s["realized_pnl"] == 0 and s["max_lots"] == 2
    assert all(t["status"] == "open" and t["reason"] == "open" for t in r["trades"])


def test_one_share_sizing():
    buys = [ev(1, 100.0), ev(3, 80.0, setup="trend")]
    r = portfolio.run(buys, [ev(5, 110.0)], ev(9, 45.0), sizing="share")
    assert [t["pnl"] for t in r["trades"]] == [30.0, 10.0] and [t["cost"] for t in r["trades"]] == [80.0, 100.0]
    s = r["summary"]
    assert s["invested"] == 180.0 and s["max_capital"] == 180.0 and s["return_pct"] == round(40 / 180 * 100, 2)
    assert r["by_setup"]["trend"]["realized_pnl"] == 30.0 and r["trades"][0]["pnl_pct"] == 37.5


def test_same_bar_sell_then_buy_and_period_start():
    buys = [ev(i, 100.0) for i in range(10, 40)]
    sc = portfolio.scenario(buys, [ev(5, 1.0), ev(20, 110.0)], ev(50, 100.0), "usd")
    assert sc["buys"] == 30 and sc["start_date"] == "d10"
    assert sc["sells"] == 1                                                 # the SELL before the period is ignored
    lots = sc["trades"]
    assert sum(t["sell_date"] == "d20" and t["reason"] == "sell" for t in lots) == 10   # d10..d19 sold on d20
    d20 = next(t for t in lots if t["buy_date"] == "d20")
    assert d20["status"] == "open"                                          # bought after the d20 SELL
    assert sc["hold_all"]["pnl"] == 0.0 and sc["summary"]["max_lots"] == 20
    assert sc["hold_all"]["shares"] == 30.0 and sc["hold_all"]["cost"] == 3000.0 and sc["hold_all"]["value"] == 3000.0
    sh = portfolio.scenario(buys, [ev(20, 110.0)], ev(50, 100.0), "share")
    assert (sh["hold_all"]["shares"], sh["hold_all"]["cost"], sh["hold_all"]["value"]) == (30.0, 3000.0, 3000.0)
    assert sh["summary"]["max_capital"] == 2000.0                           # 20 shares at $100
    assert portfolio.scenario(buys, [], ev(50, 100.0), "usd", limit=5)["start_date"] == "d35"   # most recent 5


def test_lots_bought_outside_a_setup_are_tallied_as_none():
    r = portfolio.run([ev(1, 100.0, setup=""), ev(2, 100.0)], [ev(3, 110.0)], ev(4, 110.0))
    assert r["by_setup"]["none"]["lots"] == 1 and r["by_setup"]["rebound"]["lots"] == 1
