"""Full analysis pipeline on synthetic data (no network). Retraining is made sparse to keep the test fast."""
import numpy as np
import pandas as pd
import pytest

from backend.app.quant.features import GROUPS, align, build_features
from backend.app.services import analysis_service as svc
from backend.app.services.frames import bars_frame
from backend.app.yahoo_api.client import FACTORS

from .conftest import synthetic_bars

ET = "America/New_York"


def factors_for(start, end):
    rng = np.random.default_rng(3)
    idx = pd.bdate_range(start - pd.Timedelta(days=400), end)
    f = pd.DataFrame({k: 50 + np.cumsum(rng.normal(0, 0.5, len(idx))) for k in FACTORS}, index=idx)
    f["rate"] = 2 + np.cumsum(rng.normal(0, 0.01, len(idx)))
    return f


def frame(tf, start):
    df = bars_frame(synthetic_bars(tf, start))
    session = pd.Series(df.index.tz_convert(ET).tz_localize(None).normalize(), index=df.index)
    return df, session


def daily_frame():
    d, s = frame("1Day", "2016-01-04T00:00:00Z")
    d.index = pd.DatetimeIndex(s.to_numpy())
    return d


def daily_close():
    return daily_frame()["close"]


def test_features_have_groups_and_no_lookahead():
    dc = daily_close()
    df = pd.DataFrame({"open": dc, "high": dc + 1, "low": dc - 1, "close": dc, "volume": 1000.0})
    factors = factors_for(dc.index[0], dc.index[-1])
    full = build_features(df, factors)
    cut = build_features(df.iloc[:-50], factors)
    assert set(full.columns) <= set(GROUPS)
    # Values on a past day must not change when later bars are added.
    pd.testing.assert_frame_equal(full.iloc[:-50], cut, check_exact=False, rtol=1e-9)


def test_align_modes():
    daily = pd.DataFrame({"x": [1.0, 2.0, 3.0]}, index=pd.to_datetime(["2026-11-16", "2026-11-17", "2026-11-20"]))
    bars = pd.to_datetime(["2026-11-17", "2026-11-18", "2026-11-20"])
    assert align(daily, pd.DatetimeIndex(bars), "same")["x"].tolist() == [2.0, 2.0, 3.0]
    assert align(daily, pd.DatetimeIndex(bars), "previous")["x"].tolist() == [1.0, 2.0, 2.0]  # never same day
    week = pd.DatetimeIndex(pd.to_datetime(["2026-11-16"]))  # weekly bar stamped Monday, closes Friday
    assert align(daily, week, "week_end")["x"].tolist() == [3.0]


@pytest.mark.parametrize("tf, rng, start, bracket", [("1Day", "5Y", "2016-01-04T00:00:00Z", "fixed"),
                                                      ("1Day", "1Y", "2016-01-04T00:00:00Z", "optimal"),
                                                      ("1Hour", "1M", "2025-06-01T00:00:00Z", "optimal")])
def test_compute_payload(monkeypatch, tf, rng, start, bracket):
    monkeypatch.setattr(svc, "MIN_RETRAIN_EVERY", 126)
    from backend.app.quant import optimize as qo
    monkeypatch.setattr(qo, "GRID_TP", (1.5, 2.0))     # a small grid keeps the test fast (default 1.5 / 1.0 inside)
    monkeypatch.setattr(qo, "GRID_SL", (0.75, 1.0))
    df, session = frame(tf, start)
    if tf != "1Day":  # regular-hours bars only, like the chart
        et = df.index.tz_convert(ET)
        keep = ((et.hour * 60 + et.minute) < 960) & ((et.hour * 60 + et.minute + 60) > 570)
        df, session = df[keep], session[keep]
    daily = daily_frame()
    factors = factors_for(daily.index[0], daily.index[-1])
    now = pd.Timestamp.now(tz=ET)
    start_view, end_view = svc.display_window(rng, None, None, now)
    r = svc.compute("TEST", df, session, daily, factors, rng=rng, tf=tf, intraday=tf != "1Day",
                    display_start=start_view, display_end=end_view, tp_atr=2.0, sl_atr=0.8, bracket=bracket)
    assert r["params"]["tp_atr"] == 2.0
    if bracket == "fixed":
        assert r["targets"]["short"]["spec"]["target_atr"] == 2.0
    assert r["params"]["bracket"] == bracket and r["targets"]["short"]["spec"]["bracket"] == bracket
    buys = r["targets"]["short"]["signals"]
    for s in buys:
        assert {"tp_atr", "sl_atr", "target_basis", "stop_basis"} <= set(s)
        if bracket == "fixed":
            assert s["tp_atr"] == pytest.approx(2.0, abs=0.02) and s["sl_atr"] == pytest.approx(0.8, abs=0.02)
        else:   # every decision uses one of the grid's combinations
            assert any(abs(s["tp_atr"] - tp) < 0.02 and abs(s["sl_atr"] - sl) < 0.02
                       for tp in qo.GRID_TP for sl in qo.GRID_SL), (s["tp_atr"], s["sl_atr"])
            assert s["target_basis"] == "optimized"
    if bracket == "optimal":
        o = r["params"]["optimization"]
        assert len(o["grid"]) == len(qo.GRID_TP) * len(qo.GRID_SL) and o["choices"]
        assert (o["current"]["tp"], o["current"]["sl"]) in [(g["tp"], g["sl"]) for g in o["grid"]]
        spec = r["targets"]["short"]["spec"]
        assert (spec["target_atr"], spec["stop_atr"]) == (o["current"]["tp"], o["current"]["sl"])
        assert "strategy" in o and o["strategy"]["trades"] >= 0
        cur = r["targets"]["short"]["current"]
        assert abs(cur["tp_atr"] - o["current"]["tp"]) < 0.02 and abs(cur["sl_atr"] - o["current"]["sl"]) < 0.02
    for key, t in r["targets"].items():         # every decision explains itself
        for s in t["signals"]:
            w = s["why"]
            assert set(w["setups"]) == ({"top"} if key == "tp_short" else {"rebound", "trend"})
            assert w["setups"].get(s["setup"], {"active": True})["active"]       # its setup held on that bar
            assert w["factors"] and {f["group"] for f in w["factors"]} <= set(GROUPS.values())
            assert any(v["label"] == "RSI(14)" for v in w["values"])
    from backend.app.quant import backtest as qbt
    run = r["_backtest"]
    assert all(c["setup"] in ("rebound", "trend") and 0 <= c["prob"] <= 1 for c in run["candidates"])
    # default thresholds = the model's own: the backtest reproduces the analysis' BUY and SELL decisions exactly
    default = qbt.backtest(run, n=qbt.MAX_DECISIONS)
    buy_dates = [s["date"] for s in r["targets"]["short"]["signals"]][-qbt.MAX_DECISIONS:]
    if default["variants"]["with_bracket"]["result"]:
        assert [t["buy_date"] for t in default["variants"]["with_bracket"]["result"]["trades"]][::-1] == buy_dates
    acc_dates = [s["date"] for s in r["targets"]["accum"]["signals"]][-qbt.MAX_DECISIONS:]
    if default["variants"]["sell_only"]["result"]:
        assert [t["buy_date"] for t in default["variants"]["sell_only"]["result"]["trades"]][::-1] == acc_dates
    assert default["sell_decisions"] == len(r["targets"]["tp_short"]["signals"])
    out = qbt.backtest(run, n=10, setups="both", min_prob=0.0, sizing="usd")
    if out["variants"]["sell_only"]["result"]:
        res = out["variants"]["sell_only"]["result"]
        assert res["decisions"] == min(10, out["variants"]["sell_only"]["pool"]["both"]["qualified"])
        sm = res["summary"]
        assert sm["lots"] == res["decisions"] and "ytd" in sm
        # weekly DCA with the same money, from the first BUY to the last bar
        assert res["dca"]["cost"] == sm["invested"] and res["dca"]["buys"] >= 1
        assert all(b["i"] >= 0 for b in run["weekly"]) and len({b["date"][:10] for b in run["weekly"]}) == len(run["weekly"])
    assert len(r["k_momentum"]) == svc.MOMENTUM_BARS and r["k_momentum"][-1]["rsi"] is not None
    tr = r["training"]
    assert tr["data"]["bars"] == len(df) and tr["train_bars"] == svc.TRAIN_BARS
    for key in ("short", "tp_short"):
        t = tr["targets"][key]
        cur = t["current"]
        assert cur["rows"] <= svc.TRAIN_BARS and cur["start"] <= cur["end"] <= tr["data"]["end"]
        if t["first"]:
            f = t["first"]
            assert f["end"] < f["predicts_from"]                                   # no look-ahead
            if key == "accum" or (key == "short" and bracket == "fixed"):  # SELL / optimizer start earlier
                assert f["predicts_from"] >= r["window"]["start"]
            assert f["rows"] >= tr["min_train"]
    pj = r["projection"]
    if pj:
        assert pj["closer"] in ("buy", "sell", None)
        for side in ("buy", "sell"):
            v = pj[side]
            if v and not v["now"]:
                assert abs(v["move_atr"]) <= 3.0 + 1e-9 and v["zone"][0] <= v["price"] <= v["zone"][1]
                assert v["prob"] >= v["threshold"]
        if pj["buy"] and not pj["buy"]["now"]:
            assert pj["buy"]["target"] > pj["buy"]["price"] > pj["buy"]["stop"]
    sim = r["simulation"]
    # sell-signal BUY model: labelled by profit at the next SELL decision, traded until that SELL
    acc = r["targets"]["accum"]
    assert acc["spec"]["label_rule"] == "next_sell" and "proxy_until" in acc
    # BUY S starts learning about as early as the other models (the setup stands in for SELL before the SELL model)
    tr_t = r["training"]["targets"]
    if tr_t["accum"]["first"] and tr_t["tp_short"]["first"]:
        assert tr_t["accum"]["first"]["predicts_from"] <= r["window"]["end"]
    sell_dates = {s["date"] for s in r["targets"]["tp_short"]["signals"]}
    for s in acc["signals"]:
        assert s["target"] is None and s["stop"] is None
        if s["trade"]["status"] == "closed":
            assert s["trade"]["reason"] == "sell decision" and s["trade"]["exit_date"] in sell_dates
            assert s["outcome"] == ("target" if s["trade"]["return_pct"] > 0 else "stop")
    if buys:
        wb = sim["usd"]["with_bracket"]
        assert wb["buys"] == min(len(buys), 30) and wb["start_date"] == buys[-wb["buys"]]["date"]
        for sz, v in [(sz, v) for sz in ("usd", "share") for v in ("sell_only", "with_bracket")]:
            if sim[sz][v] is None:
                continue
            sm = sim[sz][v]["summary"]
            assert sm["lots"] == sim[sz][v]["buys"] and sm["closed"] + sm["open"] == sm["lots"]
            assert sum(t["lots"] for t in sim[sz][v]["by_setup"].values()) == sm["lots"]  # every BUY has a setup
            assert sm["total_pnl"] == pytest.approx(sum(t["pnl"] for t in sim[sz][v]["trades"]), abs=0.05)
            assert all(t["buy_time"] >= sim[sz][v]["start_time"] for t in sim[sz][v]["trades"])
    assert r["timeframe"] == tf and r["window"]["bars"] >= min(svc.MIN_EVAL_BARS, len(df) - 1)
    assert {f["factor"] for f in r["relations"]} == set(FACTORS)
    assert set(r["targets"]) == {"short", "accum", "tp_short"}
    assert r["window"]["start_time"] <= r["range_window"]["start_time"]   # the trained window covers the range
    rw = r["range_window"]
    assert 0 < rw["bars"] <= r["window"]["bars"]
    for t in r["targets"].values():
        in_range = [s for s in t["signals"] if s["in_range"]]
        assert all(s["time"] >= rw["start_time"] for s in in_range)
        assert all(s["time"] < rw["start_time"] for s in t["signals"] if not s["in_range"])
        assert t["range_stats"]["signals"] == len(in_range) and t["range_stats"]["bars"] == rw["bars"]
    bar_times = set(svc.et_epoch(df.index).tolist())
    for key, t in r["targets"].items():
        assert t["spec"]["key"] == key
        assert {"reliable", "verdict", "base_rate", "auc", "signals", "hit_rate"} <= set(t["stats"])
        assert t["current"] is not None and 0 <= t["current"]["prob"] <= 1
        rec = t["current"]["recent"]          # momentum: today's model on the last K lines, ending at the current one
        assert len(rec) == svc.MOMENTUM_BARS and rec[-1]["date"] == t["current"]["date"]
        assert rec[-1]["prob"] == t["current"]["prob"]
        times = [s["time"] for s in t["signals"]]
        assert times == sorted(times) and set(times) <= bar_times   # markers land on the chart's bars
        up = t["spec"]["direction"] == "up"
        for s in t["signals"]:
            if t["spec"]["label_rule"] == "next_sell":    # sell-signal strategy: no profit-take / stop-loss
                continue
            assert (s["target"] > s["entry"] > s["stop"]) if up else (s["target"] < s["entry"] < s["stop"])
            if t["spec"]["kind"] == "entry":
                assert s["trade"]["status"] in ("closed", "open")
        if t["spec"]["kind"] == "entry":
            assert {"signals", "every_day", "buy_hold_pct", "rules"} <= set(t["trades"])
