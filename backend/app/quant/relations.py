"""How the stock moves with SPY, QQQ, VIX, oil, gasoline and short-term rates."""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..yahoo_api.client import FACTORS

LEAD_DAYS = 5


def _changes(s: pd.Series, key: str, n: int = 1) -> pd.Series:
    # Rates are already in percent: use differences; everything else: log returns.
    if key == "rate":
        return s.diff(n)
    s = s.where(s > 0)  # negative futures prices (oil, April 2020) have no log return
    return np.log(s / s.shift(n))


def _corr(a: pd.Series, b: pd.Series) -> float | None:
    d = pd.concat([a, b], axis=1).dropna()
    if len(d) < 30 or d.iloc[:, 0].std() == 0 or d.iloc[:, 1].std() == 0:
        return None
    return round(float(d.iloc[:, 0].corr(d.iloc[:, 1])), 3)


def factor_relations(close: pd.Series, factors: pd.DataFrame, window_start: pd.Timestamp) -> list[dict]:
    """Per factor over the analysis window:
      corr_window  correlation of daily changes (stock return vs factor change)
      corr_60d     the same over the last 60 trading days (current regime)
      beta         stock return per 1 unit of factor return (SPY / QQQ only)
      lead_corr    correlation of the factor's 5-day change with the stock's NEXT 5-day return (predictive hint)
    """
    f = factors.reindex(close.index).ffill()
    r = np.log(close / close.shift(1))
    fwd = np.log(close.shift(-LEAD_DAYS) / close)
    win = close.index >= window_start
    out = []
    for key, (ticker, desc) in FACTORS.items():
        fc = _changes(f[key], key)
        beta = None
        if key in ("spy", "qqq"):
            d = pd.concat([r[win], fc[win]], axis=1).dropna()
            if len(d) > 30 and d.iloc[:, 1].var() > 0:
                beta = round(float(d.iloc[:, 0].cov(d.iloc[:, 1]) / d.iloc[:, 1].var()), 3)
        out.append({
            "factor": key, "ticker": ticker, "description": desc,
            "corr_window": _corr(r[win], fc[win]),
            "corr_60d": _corr(r.iloc[-60:], fc.iloc[-60:]),
            "beta": beta,
            "lead_corr": _corr(_changes(f[key], key, LEAD_DAYS)[win], fwd[win]),
        })
    return out
