import numpy as np
import pandas as pd
import pytest

from backend.app.indicators import IndicatorParams, compute_all, parse_params
from backend.app.indicators.compute import rsi, sma


def frame(n=300):
    c = pd.Series(100 + np.cumsum(np.random.default_rng(1).normal(0, 1, n)))
    return pd.DataFrame({"open": c, "high": c + 1, "low": c - 1, "close": c, "volume": 1000.0})


def test_sma_matches_rolling_mean():
    s = pd.Series(range(10), dtype=float)
    assert sma(s, 3).iloc[-1] == pytest.approx((7 + 8 + 9) / 3)
    assert sma(s, 3).isna().sum() == 2


def test_rsi_bounds_and_all_gains():
    r = rsi(frame()["close"], 14).dropna()
    assert ((r >= 0) & (r <= 100)).all()
    assert rsi(pd.Series(range(30), dtype=float), 14).iloc[-1] == 100.0


def test_compute_all_columns_follow_params():
    p = IndicatorParams(sma=(5, 10, 20), ema=(3, 6), bb_len=10, bb_mult=1.5, rsi=7, macd=(5, 13, 4))
    out = compute_all(frame(), intraday=False, p=p)
    assert {"sma1", "sma2", "sma3", "ema1", "ema2", "bb_upper", "bb_lower", "rsi", "macd", "macd_signal",
            "macd_hist", "vwap"} <= set(out.columns)
    assert out["sma3"].isna().sum() == 19            # 20-bar SMA
    assert out["vwap"].isna().all()                  # VWAP is intraday only
    bands = out[["bb_upper", "bb_lower"]].dropna()
    assert (bands["bb_upper"] >= bands["bb_lower"]).all()


def test_warmup_bars_covers_longest_length():
    assert IndicatorParams().warmup_bars() == 200
    assert IndicatorParams(sma=(5, 10, 20), macd=(12, 100, 9)).warmup_bars() == 3 * 109


@pytest.mark.parametrize("kwargs, msg", [
    ({"sma": "10,20"}, "sma must be 3"),
    ({"rsi": "0"}, "rsi must be a whole number"),
    ({"macd": "26,12,9"}, "fast length must be shorter"),
    ({"bb": "1,2"}, "Bollinger length"),
    ({"sma": "a,b,c"}, "comma-separated"),
])
def test_parse_params_rejects_bad_input(kwargs, msg):
    args = {"sma": None, "ema": None, "bb": None, "rsi": None, "macd": None, **kwargs}
    with pytest.raises(ValueError, match=msg):
        parse_params(**args)


def test_parse_params_defaults_and_custom():
    assert parse_params(None, None, None, None, None) == IndicatorParams()
    p = parse_params("9,20,50", "9,21", "20,2.5", "7", "5,35,5")
    assert p.sma == (9, 20, 50) and p.bb_mult == 2.5 and p.rsi == 7 and p.macd == (5, 35, 5)
