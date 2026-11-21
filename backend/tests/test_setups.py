import numpy as np
import pandas as pd

from backend.app.quant.intraday import intraday_check
from backend.app.quant.setups import buy_setup_names, compute_setups, explain


def bars(closes, wick=0.5):
    c = pd.Series(closes, dtype=float)
    o = c.shift(1).fillna(c.iloc[0])
    return pd.DataFrame({"open": o, "high": np.maximum(o, c) + wick, "low": np.minimum(o, c) - wick, "close": c,
                         "volume": 1000.0})


def test_steady_uptrend_is_a_trend_setup_not_a_rebound():
    rng = np.random.default_rng(1)
    up = 100 + np.cumsum(0.4 + rng.normal(0, 0.3, 300))
    s = compute_setups(bars(up))
    assert s["trend"].iloc[-50:].mean() > 0.6
    assert not s["rebound"].iloc[-50:].any()
    assert buy_setup_names(s)[-1] in ("trend", "")


def test_fall_then_easing_is_a_rebound_setup():
    fall = list(np.linspace(150, 100, 60))                    # steady decline: under pressure
    ease = [99.6, 99.4, 99.3, 99.5, 99.8]                     # declines shrink, then turn up
    s = compute_setups(bars(fall + ease))
    assert s["falling"].iloc[-5:].all()
    assert s["rebound"].iloc[-3:].any()
    assert not s["trend"].iloc[-5:].any()


def test_extended_then_fading_is_an_interim_top():
    rise = list(np.linspace(100, 160, 60))
    fade = [160.3, 160.4, 160.2, 159.9, 159.7]
    s = compute_setups(bars(rise + fade))
    assert s["extended"].iloc[-5:].all()
    assert s["top"].iloc[-3:].any()


def test_explain_lists_every_condition():
    s = compute_setups(bars(np.linspace(100, 160, 80)))
    e = explain(s, len(s) - 1)
    assert set(e) == {"rebound", "trend", "top"}
    assert all({"active", "rule", "checks"} <= set(v) for v in e.values())
    assert len(e["top"]["checks"]) == 5


def session(closes):
    b = bars(closes, wick=0.05)
    b.index = pd.date_range("2026-11-20 14:30", periods=len(b), freq="5min", tz="UTC")
    return b


def test_intraday_rising_day_supports_buy_and_falling_day_supports_sell():
    up = intraday_check(session(np.linspace(100, 103, 40) + np.tile([0, 0.05], 20)), prev_close=99.5)
    assert up["available"] and up["buy"]["verdict"] == "supports" and up["sell"]["verdict"] == "against"
    down = intraday_check(session(np.linspace(103, 100, 40) + np.tile([0, 0.05], 20)), prev_close=103.5)
    assert down["buy"]["verdict"] == "against" and down["sell"]["verdict"] == "supports"
    assert len(up["checks"]) == 5 and up["day_change_pct"] > 0


def test_intraday_needs_a_few_bars():
    assert intraday_check(session([100, 101, 102]), prev_close=100)["available"] is False
