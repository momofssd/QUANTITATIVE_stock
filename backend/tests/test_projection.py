import numpy as np
import pandas as pd
import pytest

from backend.app.quant import features as qf
from backend.app.quant import projection as qp
from backend.app.yahoo_api.client import FACTORS


def market():
    idx = pd.bdate_range("2022-01-03", periods=700)
    rng = np.random.default_rng(5)
    c = pd.Series(100 + np.cumsum(rng.normal(0, 0.5, len(idx))), index=idx)
    c.iloc[-1] = 100.0
    c.iloc[-2] = 100.0                          # current close = previous close -> 1-bar return 0
    df = pd.DataFrame({"open": c.shift(1).fillna(c.iloc[0]), "high": c + 1, "low": c - 1, "close": c,
                       "volume": 1000.0})
    f = pd.DataFrame({k: 50 + np.cumsum(rng.normal(0, 0.5, len(idx) + 300)) for k in FACTORS},
                     index=pd.bdate_range(idx[0] - pd.Timedelta(days=420), periods=len(idx) + 300))
    return df, f[f.index <= idx[-1]]


class Stub:
    """P = 1 when the 1-bar log return passes a level (buy: <= level, sell: >= level)."""
    def __init__(self, col: int, level: float, below: bool):
        self.col, self.level, self.below = col, level, below

    def predict_proba(self, x):
        r = x[0, self.col]
        p = float(r <= self.level if self.below else r >= self.level)
        return np.array([[1 - p, p]])


def run(monkeypatch, now=None):
    df, f = market()
    names = list(qf.build_features(df.iloc[-qp.TAIL:], f, daily_close=df["close"].iloc[-qp.TAIL:],
                                   bar_dates=df.index[-qp.TAIL:], mode="same").columns)
    col = names.index("ret_1")
    # every bar is in a rebound (BUY) setup and an interim-top (SELL) setup: only the models decide
    monkeypatch.setattr(qp, "compute_setups", lambda b: pd.DataFrame(
        {"rebound": True, "trend": False, "top": True}, index=b.index))
    return qp.project(df, df["close"], f, df.index, "same", 2.0,
                      qp.Side(Stub(col, -0.02, True), 0.5), qp.Side(Stub(col, 0.03, False), 0.5),
                      now or {"buy": False, "sell": False},
                      lambda b, setup: {"target": 110.0, "stop": 90.0}, lambda p: {"target": p - 3, "stop": p + 2})


def test_projected_prices_are_the_nearest_trigger(monkeypatch):
    pj = run(monkeypatch)
    buy_at, sell_at = 100 * np.exp(-0.02), 100 * np.exp(0.03)          # 98.02 / 103.05
    b, s = pj["buy"], pj["sell"]
    assert b["price"] <= buy_at < b["price"] + qp.FINE_ATR * 2.0 + 1e-9  # within one fine step (0.1)
    assert s["price"] >= sell_at > s["price"] - qp.FINE_ATR * 2.0 - 1e-9
    assert b["move_atr"] < 0 < s["move_atr"] and b["setup"] == "rebound"
    assert b["zone_open"] and b["zone"][0] < b["price"]                  # still a BUY further down
    assert pj["closer"] == "buy"                                         # -2% is nearer than +3%
    assert b["target"] == 110.0 and s["target"] == pytest.approx(s["price"] - 3)


def test_current_signal_is_reported_as_now(monkeypatch):
    pj = run(monkeypatch, now={"buy": False, "sell": True})
    assert pj["sell"]["now"] and pj["sell"]["price"] == 100.0 and pj["closer"] == "sell"
    assert not pj["buy"]["now"]
