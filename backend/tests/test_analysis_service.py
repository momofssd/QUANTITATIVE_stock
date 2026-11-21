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
                                                      ("1Day", "1Y", "2016-01-04T00:00:00Z", "dynamic"),
                                                      ("1Hour", "1M", "2025-06-01T00:00:00Z", "dynamic")])
def test_compute_payload(monkeypatch, tf, rng, start, bracket):
    monkeypatch.setattr(svc, "MIN_RETRAIN_EVERY", 126)
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
    assert r["params"]["tp_atr"] == 2.0 and r["targets"]["short"]["spec"]["target_atr"] == 2.0
    assert r["params"]["bracket"] == bracket and r["targets"]["short"]["spec"]["bracket"] == bracket
    buys = r["targets"]["short"]["signals"]
    for s in buys:
        assert {"tp_atr", "sl_atr", "target_basis", "stop_basis"} <= set(s)
        if bracket == "fixed":
            assert s["tp_atr"] == pytest.approx(2.0, abs=0.02) and s["sl_atr"] == pytest.approx(0.8, abs=0.02)
        else:
            assert 0.49 <= s["sl_atr"] <= 2.51 and s["tp_atr"] <= 3.51
    for key, t in r["targets"].items():         # every decision explains itself
        for s in t["signals"]:
            w = s["why"]
            assert set(w["setups"]) == ({"rebound", "trend"} if key == "short" else {"top"})
            assert w["setups"].get(s["setup"], {"active": True})["active"]       # its setup held on that bar
            assert w["factors"] and {f["group"] for f in w["factors"]} <= set(GROUPS.values())
            assert any(v["label"] == "RSI(14)" for v in w["values"])
    from backend.app.quant import backtest as qbt
    run = r["_backtest"]
    assert all(c["setup"] in ("rebound", "trend") and 0 <= c["prob"] <= 1 for c in run["candidates"])
    out = qbt.backtest(run, n=10, setups="both", min_prob=0.0, sizing="usd")
    if out["result"]:
        res = out["result"]
        assert res["decisions"] == min(10, out["pool"]["both"]["qualified"])
        sm = res["sell_only"]["summary"]
        assert sm["lots"] == res["decisions"] and "ytd" in sm
    tr = r["training"]
    assert tr["data"]["bars"] == len(df) and tr["train_bars"] == svc.TRAIN_BARS
    for key in ("short", "tp_short"):
        t = tr["targets"][key]
        cur = t["current"]
        assert cur["rows"] <= svc.TRAIN_BARS and cur["start"] <= cur["end"] <= tr["data"]["end"]
        if t["first"]:
            f = t["first"]
            assert f["end"] < f["predicts_from"] and f["predicts_from"] >= r["window"]["start"]   # no look-ahead
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
    if buys:
        assert sim["buys"] == min(len(buys), 30) and sim["start_date"] == buys[-sim["buys"]]["date"]
        for sz, v in [(sz, v) for sz in ("usd", "share") for v in ("sell_only", "with_bracket")]:
            sm = sim[sz][v]["summary"]
            assert sm["lots"] == sim["buys"] and sm["closed"] + sm["open"] == sm["lots"]
            assert sum(t["lots"] for t in sim[sz][v]["by_setup"].values()) == sm["lots"]  # every BUY has a setup
            assert sm["total_pnl"] == pytest.approx(sum(t["pnl"] for t in sim[sz][v]["trades"]), abs=0.05)
            assert all(t["buy_time"] >= sim["start_time"] for t in sim[sz][v]["trades"])
    assert r["timeframe"] == tf and r["window"]["bars"] >= min(svc.MIN_EVAL_BARS, len(df) - 1)
    assert {f["factor"] for f in r["relations"]} == set(FACTORS)
    assert set(r["targets"]) == {"short", "tp_short"}
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
        times = [s["time"] for s in t["signals"]]
        assert times == sorted(times) and set(times) <= bar_times   # markers land on the chart's bars
        up = t["spec"]["direction"] == "up"
        for s in t["signals"]:
            assert (s["target"] > s["entry"] > s["stop"]) if up else (s["target"] < s["entry"] < s["stop"])
            if t["spec"]["kind"] == "entry":
                assert s["trade"]["status"] in ("closed", "open")
        if t["spec"]["kind"] == "entry":
            assert {"signals", "every_day", "buy_hold_pct", "rules"} <= set(t["trades"])
