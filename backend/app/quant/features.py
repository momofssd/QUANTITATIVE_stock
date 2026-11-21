"""Model inputs. Every value at bar t uses only data available at bar t's close (no look-ahead).

Two kinds of features:
  stock features   computed on the bars of the analysed interval (lengths in bars)
  market features  computed per DAY from the stock's daily closes and the Yahoo factors (SPY, QQQ, VIX, oil,
                   gasoline, T-bill rate), then attached to each bar with `align()`:
                     "same"      daily bars    -> that day's values (known at the bar's close)
                     "week_end"  weekly bars   -> values at the end of that week (the bar closes on the last day)
                     "previous"  intraday bars -> the PREVIOUS day's values (today's close is not known yet)
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .targets import atr as atr_fn

# Feature -> group shown in the "what drives the model" breakdown.
GROUPS: dict[str, str] = {}

ALIGN_MODES = ("same", "week_end", "previous")


def _g(group: str, **cols: pd.Series) -> dict[str, pd.Series]:
    for name in cols:
        GROUPS[name] = group
    return cols


def _logret(s: pd.Series, n: int) -> pd.Series:
    s = s.where(s > 0)  # e.g. WTI crude settled below zero in April 2020; a log return is undefined there
    return np.log(s / s.shift(n))


def _rsi(close: pd.Series, n: int = 14) -> pd.Series:
    d = close.diff()
    gain = d.clip(lower=0).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    loss = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    return 100 - 100 / (1 + gain / loss.replace(0, np.nan))


def _zscore(s: pd.Series, n: int) -> pd.Series:
    return (s - s.rolling(n).mean()) / s.rolling(n).std()


def stock_features(stock: pd.DataFrame) -> pd.DataFrame:
    """Trend, momentum, volatility and volume of the stock on its own bars (any interval)."""
    o, h, l, c, v = (stock[k] for k in ("open", "high", "low", "close", "volume"))
    a = atr_fn(h, l, c)
    r1 = _logret(c, 1)
    sma = {n: c.rolling(n).mean() for n in (20, 50, 200)}
    macd = c.ewm(span=12, adjust=False).mean() - c.ewm(span=26, adjust=False).mean()
    std20 = c.rolling(20).std()
    cols: dict[str, pd.Series] = {}
    cols |= _g("Stock momentum",
               ret_1=r1, ret_5=_logret(c, 5), ret_20=_logret(c, 20), ret_60=_logret(c, 60),
               rsi_14=_rsi(c), macd_hist_atr=(macd - macd.ewm(span=9, adjust=False).mean()) / a,
               gap=o / c.shift(1) - 1, close_in_range=(c - l) / (h - l).replace(0, np.nan))
    cols |= _g("Stock trend",
               dist_sma20=(c - sma[20]) / a, dist_sma50=(c - sma[50]) / a, dist_sma200=(c - sma[200]) / a,
               sma50_slope=sma[50].pct_change(10), sma200_slope=sma[200].pct_change(20),
               dist_52w_high=(c - h.rolling(252, min_periods=60).max()) / a,
               dist_52w_low=(c - l.rolling(252, min_periods=60).min()) / a,
               bb_pctb=(c - (sma[20] - 2 * std20)) / (4 * std20))
    cols |= _g("Stock volatility & volume",
               atr_pct=a / c, vol_ratio=r1.rolling(10).std() / r1.rolling(60).std(),
               volume_z=_zscore(np.log(v.replace(0, np.nan)), 20))
    return pd.DataFrame(cols, index=stock.index)


def market_features(daily_close: pd.Series, factors: pd.DataFrame) -> pd.DataFrame:
    """Per trading day: market / macro regime and the stock's relation to each factor (daily returns)."""
    f = factors.reindex(daily_close.index).ffill()
    c = daily_close
    r1 = _logret(c, 1)
    spy_r1, qqq_r1 = _logret(f["spy"], 1), _logret(f["qqq"], 1)
    cols: dict[str, pd.Series] = {}
    cols |= _g("SPY (market)",
               spy_ret_5=_logret(f["spy"], 5), spy_ret_20=_logret(f["spy"], 20),
               spy_vs_sma200=f["spy"] / f["spy"].rolling(200).mean() - 1,
               rel_strength_spy_20=_logret(c, 20) - _logret(f["spy"], 20),
               beta_spy_60=r1.rolling(60).cov(spy_r1) / spy_r1.rolling(60).var(),
               corr_spy_60=r1.rolling(60).corr(spy_r1))
    cols |= _g("QQQ (tech)",
               qqq_ret_5=_logret(f["qqq"], 5), qqq_ret_20=_logret(f["qqq"], 20),
               rel_strength_qqq_20=_logret(c, 20) - _logret(f["qqq"], 20),
               corr_qqq_60=r1.rolling(60).corr(qqq_r1))
    cols |= _g("VIX (fear)",
               vix=f["vix"], vix_chg_5=_logret(f["vix"], 5), vix_z_60=_zscore(f["vix"], 60),
               corr_vix_60=r1.rolling(60).corr(_logret(f["vix"], 1)))
    cols |= _g("Oil & gasoline",
               oil_ret_5=_logret(f["oil"], 5), oil_ret_20=_logret(f["oil"], 20),
               gasoline_ret_20=_logret(f["gasoline"], 20),
               corr_oil_60=r1.rolling(60).corr(_logret(f["oil"], 1)))
    cols |= _g("Interest rate",
               rate=f["rate"], rate_chg_20=f["rate"].diff(20), rate_chg_60=f["rate"].diff(60))
    return pd.DataFrame(cols, index=daily_close.index)


def align(daily: pd.DataFrame, bar_dates: pd.DatetimeIndex, mode: str) -> pd.DataFrame:
    """Attach per-day rows to bars (bar_dates = each bar's ET calendar date, ascending). See module docstring."""
    if mode not in ALIGN_MODES:
        raise ValueError(f"unknown align mode {mode!r}")
    key = bar_dates + pd.Timedelta(days=6) if mode == "week_end" else bar_dates
    left = pd.DataFrame({"_k": np.asarray(key, dtype="datetime64[ns]")})
    right = daily.rename_axis("_k").reset_index()
    right["_k"] = right["_k"].astype("datetime64[ns]")
    out = pd.merge_asof(left, right.sort_values("_k"), on="_k", direction="backward",
                        allow_exact_matches=(mode != "previous"))
    return out.drop(columns="_k")


def build_features(stock: pd.DataFrame, factors: pd.DataFrame, daily_close: pd.Series | None = None,
                   bar_dates: pd.DatetimeIndex | None = None, mode: str = "same") -> pd.DataFrame:
    """All model inputs for `stock`'s bars.

    Daily analysis: pass only (stock, factors) with a naive-date index. Other intervals: also pass the stock's daily
    closes, each bar's ET date and the alignment mode.
    """
    if daily_close is None:
        daily_close = stock["close"]
    if bar_dates is None:
        bar_dates = pd.DatetimeIndex(stock.index)
    own = stock_features(stock)
    market = align(market_features(daily_close, factors), bar_dates, mode)
    market.index = stock.index
    return pd.concat([own, market], axis=1).replace([np.inf, -np.inf], np.nan)
