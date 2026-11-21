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


@pytest.mark.parametrize("tf, rng, start", [("1Day", "5Y", "2016-01-04T00:00:00Z"),
                                             ("1Hour", "1M", "2025-06-01T00:00:00Z")])
def test_compute_payload(monkeypatch, tf, rng, start):
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
                    display_start=start_view, display_end=end_view, tp_atr=2.0, sl_atr=0.8)
    assert r["params"]["tp_atr"] == 2.0 and r["targets"]["short"]["spec"]["target_atr"] == 2.0
    cc = r["targets"]["long"]["cost_check"]
    assert cc["entries"] == r["targets"]["long"]["stats"]["signals"] and "verdict" in cc
    assert len(r["lines"]["avg_cost"]) == (cc["entries"] + 1 if cc["entries"] else 0)
    assert r["timeframe"] == tf and r["window"]["bars"] >= min(svc.MIN_EVAL_BARS, len(df) - 1)
    assert {f["factor"] for f in r["relations"]} == set(FACTORS)
    assert set(r["targets"]) == {"short", "long", "tp_short", "tp_long"}
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
