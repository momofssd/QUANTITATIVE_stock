import pytest

from backend.app.quant import backtest as qbt
from backend.app.quant import portfolio


def cand(i, setup, prob, price=100.0, exit_=None, thr=0.55):
    return {"i": i, "time": i * 100, "date": f"d{i:02d}", "price": price, "setup": setup, "prob": prob, "exit": exit_,
            "threshold": thr}


def sell(i, price, prob=0.9, thr=0.5):
    return {"i": i, "time": i * 100, "date": f"d{i:02d}", "price": price, "prob": prob, "threshold": thr}


def ev(i, price):
    return {"i": i, "time": i * 100, "date": f"d{i:02d}", "price": price}


def test_select_applies_setup_threshold_cooldown_and_n():
    cands = [cand(0, "rebound", 0.7), cand(2, "rebound", 0.8), cand(6, "trend", 0.65), cand(7, "trend", 0.5),
             cand(12, "rebound", 0.61), cand(20, "trend", 0.9)]
    both = qbt.select(cands, ("rebound", "trend"), 0.6, cooldown=5, n=100)
    assert [c["i"] for c in both] == [0, 6, 12, 20]          # 2 is inside the cooldown after 0; 7 below 60%
    assert [c["i"] for c in qbt.select(cands, ("trend",), 0.6, 5, 100)] == [6, 20]
    assert [c["i"] for c in qbt.select(cands, ("rebound", "trend"), 0.6, 5, 2)] == [12, 20]   # most recent 2


def test_default_threshold_is_the_models_own_per_bar():
    cands = [cand(0, "rebound", 0.50, thr=0.45), cand(6, "trend", 0.50, thr=0.55), cand(12, "trend", 0.70, thr=0.60)]
    assert [c["i"] for c in qbt.select(cands, ("rebound", "trend"), None, 5, 100)] == [0, 12]
    assert [c["i"] for c in qbt.select(cands, ("rebound", "trend"), 0.65, 5, 100)] == [12]
    sells = [sell(3, 1.0, prob=0.6, thr=0.5), sell(4, 1.0, prob=0.9, thr=0.5), sell(20, 1.0, prob=0.45, thr=0.4)]
    assert [s["i"] for s in qbt.select_sells(sells, None, 5)] == [3, 20]      # 4 inside the cooldown after 3
    assert [s["i"] for s in qbt.select_sells(sells, 0.5, 5)] == [3]          # a custom SELL threshold


def test_ytd_counts_only_this_years_pnl():
    lots_buys = [dict(cand(1, "rebound", 0.7), price=100.0), dict(cand(4, "trend", 0.7), price=100.0),
                 dict(cand(6, "trend", 0.7), price=125.0)]
    sells = [ev(3, 110.0), ev(7, 130.0)]
    ys = {"i": 5, "date": "2026-01-01", "prev_close": 120.0}
    r = portfolio.run(lots_buys, sells, ev(9, 128.0), use_bracket=False, sizing="share", year_start=ys)
    y = r["summary"]["ytd"]
    # lot d01 sold d03 (before the year) -> nothing; lot d04 held over the year end: 120 -> 130 = +10;
    # lot d06 bought this year 125, sold d07 at 130 = +5
    assert y["pnl"] == 15.0 and y["lots_held"] == 2 and y["lots_sold"] == 2
    assert y["return_pct"] == round(15 / (120 + 125) * 100, 2)
    s = r["summary"]
    assert s["avg_return_pct"] == round((10 + 30 + 4) / 3, 2)    # per-lot returns 10%, 30%, 4%
    assert s["avg_win_pct"] == s["avg_return_pct"] and s["avg_loss_pct"] is None


def test_backtest_result_and_comparison():
    cands = [cand(i, "rebound" if i % 2 else "trend", 0.55 + (i % 5) * 0.05, price=100 + i) for i in range(0, 60, 3)]
    acc = [dict(c, prob=0.9 if c["i"] % 6 == 0 else 0.1) for c in cands]
    run = {"candidates": cands, "accum_candidates": acc, "cooldown": 1,
           "sell_candidates": [sell(30, 140.0), sell(55, 120.0)], "sell_cooldown": 5,
           "last": ev(59, 150.0), "year_start": {"i": 40, "date": "2026-01-01", "prev_close": 139.0}}
    out = qbt.backtest(run, n=5, setups="both", min_prob=0.6, sizing="usd")
    br = out["variants"]["with_bracket"]
    res = br["result"]
    assert res["decisions"] == 5 and all(p >= 0.6 for p in res["probs"])
    assert {c["setups"] for c in br["compare"]} == {"rebound", "trend", "both"}
    both = next(c for c in br["compare"] if c["setups"] == "both")
    assert both["summary"]["total_pnl"] == res["summary"]["total_pnl"]
    assert "ytd" in res["summary"]
    assert br["pool"]["both"]["qualified"] >= res["decisions"]
    # the sell-signal strategy buys from its own BUY model's decisions
    so = out["variants"]["sell_only"]["result"]
    assert so["decisions"] == 5 and all(p == 0.9 for p in so["probs"])
    assert qbt.backtest(run, n=5, setups="trend", min_prob=0.99)["variants"]["with_bracket"]["result"] is None
    assert qbt.backtest(run, n=5, sell_min_prob=0.95)["sell_decisions"] == 0           # custom SELL threshold
    assert br["model_thresholds"] == [0.55, 0.55]


def test_service_validates_and_reports_missing_runs():
    from backend.app.core.errors import ApiError
    from backend.app.services import analysis_service as svc
    with pytest.raises(ApiError) as e:
        svc.run_backtest("nope", 30, "both", 0.6, "usd")
    assert e.value.status == 404
    svc._runs["t1"] = {"candidates": [], "accum_candidates": [], "cooldown": 5, "sell_candidates": [], "sell_cooldown": 5,
                       "last": ev(1, 1.0), "year_start": None,
                       "symbol": "X", "timeframe": "1Day", "range": "1Y", "bar_unit": "trading days", "window": {}}
    try:
        with pytest.raises(ApiError):
            svc.run_backtest("t1", 101, "both", 0.6, "usd")
        assert svc.run_backtest("t1", 30, "both", 0.6, "usd")["variants"]["sell_only"]["result"] is None
        assert svc.run_backtest("t1", 30, "both", None, "usd", None)["params"]["min_prob"] is None
    finally:
        svc._runs.pop("t1", None)


def test_max_shares_skips_buys_until_the_next_sell():
    buys = [dict(cand(i, "rebound", 0.9), price=100.0 + i) for i in (1, 2, 3, 4, 6, 7)]
    sells = [ev(5, 120.0), ev(9, 130.0)]
    last = ev(10, 125.0)
    r = portfolio.run(buys, sells, last, use_bracket=False, sizing="share", max_shares=2)
    bought = sorted(t["buy_date"] for t in r["trades"])
    assert bought == ["d01", "d02", "d06", "d07"]                   # 3 and 4 over the cap; the SELL at 5 frees it
    assert [s["date"] for s in r["skipped"]] == ["d04", "d03"]      # newest first, with the shares held then
    assert all(s["held"] == 2 for s in r["skipped"])
    assert r["summary"]["skipped"] == 2 and r["summary"]["max_shares_held"] == 2 and r["summary"]["max_shares"] == 2
    # no cap: every BUY is bought (unchanged behaviour)
    r0 = portfolio.run(buys, sells, last, use_bracket=False, sizing="share")
    assert r0["summary"]["lots"] == 6 and r0["summary"]["skipped"] == 0 and r0["skipped"] == []


def test_max_shares_sell_and_buy_on_the_same_bar_and_fractional_lots():
    # a SELL at bar 2's close sells first, so the BUY at bar 2 fits under a 1-share cap
    buys = [dict(cand(1, "trend", 0.9), price=100.0), dict(cand(2, "trend", 0.9), price=100.0)]
    r = portfolio.run(buys, [ev(2, 110.0)], ev(3, 105.0), use_bracket=False, sizing="share", max_shares=1)
    assert r["summary"]["lots"] == 2 and r["summary"]["skipped"] == 0
    # $100 lots at $50 are 2 shares each: a 3-share cap fits one lot
    buys = [dict(cand(i, "rebound", 0.9), price=50.0) for i in (1, 2)]
    v = portfolio._variant(buys, [], ev(3, 60.0), False, "usd", limit=None, max_shares=3)
    assert v["summary"]["lots"] == 1 and v["summary"]["skipped"] == 1
    assert v["hold_all"]["shares"] == 2 and v["hold_all"]["cost"] == 100   # baselines use the BUYs actually bought
    # a cap below one lot buys nothing
    v = portfolio._variant(buys, [], ev(3, 60.0), False, "usd", limit=None, max_shares=1)
    assert v["summary"]["lots"] == 0 and v["hold_all"]["pnl_pct"] is None


def test_backtest_cap_applies_to_the_sell_signal_strategy_only():
    cands = [cand(i, "rebound", 0.9, price=100.0) for i in range(0, 40, 2)]
    run = {"candidates": cands, "accum_candidates": cands, "cooldown": 1,
           "sell_candidates": [sell(21, 110.0)], "sell_cooldown": 5, "last": ev(40, 105.0), "year_start": None}
    out = qbt.backtest(run, n=100, sizing="share", max_shares=3)
    so, br = out["variants"]["sell_only"]["result"], out["variants"]["with_bracket"]["result"]
    assert out["params"]["max_shares"] == 3
    assert so["summary"]["max_shares_held"] == 3 and so["summary"]["skipped"] == 20 - 6   # 3 before the SELL, 3 after
    assert br["summary"]["skipped"] == 0 and br["summary"]["lots"] == 20
    both = next(c for c in out["variants"]["sell_only"]["compare"] if c["setups"] == "both")
    assert both["summary"]["skipped"] == so["summary"]["skipped"]
    from backend.app.core.errors import ApiError
    from backend.app.services import analysis_service as svc
    svc._runs["t2"] = {**run, "symbol": "X", "timeframe": "1Day", "range": "1Y", "bar_unit": "trading days", "window": {}}
    try:
        with pytest.raises(ApiError):
            svc.run_backtest("t2", 30, "both", None, "share", max_shares=0)
        assert svc.run_backtest("t2", 30, "both", None, "share", max_shares=3)["params"]["max_shares"] == 3
    finally:
        svc._runs.pop("t2", None)
