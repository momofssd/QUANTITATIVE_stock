"""Rule-based market setups that BUY / SELL signals must match, computed on the analysed interval's bars.
Every value at bar t uses only bars up to t.

rebound  falling momentum is easing:
           under pressure  = close < SMA20 and (5-bar return < 0 or RSI(14) was < 40 within the last 5 bars)
           easing (>= 2)   = MACD histogram < 0 but rising | RSI turning up from a low (< 40 recently)
                             | higher low, or a bullish rejection candle (long lower wick, close in the upper half)
trend    clear bullish trend that can continue:
           close > SMA20 > SMA50, SMA20 and SMA50 rising, ADX(14) >= 20, close > SMA200 when it exists
top      bullish momentum easing / interim top (SELL):
           extended        = close > SMA20 and (10-bar return > 0 or RSI was > 65 within the last 5 bars)
           fading (>= 2)   = MACD histogram > 0 but falling | RSI turning down from a high (> 65 recently)
                             | lower high, or a bearish rejection candle (long upper wick, close in the lower half)
                             | close below the prior close within 2 bars of a new 20-bar high
"""
from __future__ import annotations

import numpy as np
import pandas as pd

ADX_TREND = 20.0
RSI_LOW, RSI_HIGH = 40.0, 65.0


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    d = close.diff()
    gain = d.clip(lower=0).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    loss = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    return 100 - 100 / (1 + gain / loss.replace(0, np.nan))


def adx(high: pd.Series, low: pd.Series, close: pd.Series, n: int = 14) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Wilder's ADX, +DI, -DI."""
    up, down = high.diff(), -low.diff()
    plus_dm = pd.Series(np.where((up > down) & (up > 0), up, 0.0), index=high.index)
    minus_dm = pd.Series(np.where((down > up) & (down > 0), down, 0.0), index=high.index)
    prev = close.shift(1)
    tr = pd.concat([high - low, (high - prev).abs(), (low - prev).abs()], axis=1).max(axis=1)
    sm = lambda s: s.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()  # noqa: E731
    atr_ = sm(tr).replace(0, np.nan)
    pdi, mdi = 100 * sm(plus_dm) / atr_, 100 * sm(minus_dm) / atr_
    dx = 100 * (pdi - mdi).abs() / (pdi + mdi).replace(0, np.nan)
    return sm(dx), pdi, mdi


def _streak(cond: pd.Series) -> pd.Series:
    """Length of the run of True values ending at each bar."""
    c = cond.astype(int)
    return c.groupby((c != c.shift()).cumsum()).cumsum() * c


def compute_setups(stock: pd.DataFrame) -> pd.DataFrame:
    """Setup flags, their component conditions, and numeric 'momentum shift' values (all aligned to stock.index)."""
    o, h, l, c = (stock[k] for k in ("open", "high", "low", "close"))
    sma20, sma50, sma200 = (c.rolling(n).mean() for n in (20, 50, 200))
    macd = c.ewm(span=12, adjust=False).mean() - c.ewm(span=26, adjust=False).mean()
    hist = macd - macd.ewm(span=9, adjust=False).mean()
    r = rsi(c)
    adx_, pdi, mdi = adx(h, l, c)
    rng = (h - l).replace(0, np.nan)
    body_lo, body_hi = np.minimum(o, c), np.maximum(o, c)
    lower_wick, upper_wick = (body_lo - l) / rng, (h - body_hi) / rng
    close_pos = (c - l) / rng
    high20 = h.rolling(20, min_periods=20).max()

    out = pd.DataFrame(index=stock.index)
    # --- rebound
    out["falling"] = (c < sma20) & ((c / c.shift(5) - 1 < 0) | (r.rolling(5).min() < RSI_LOW))
    out["e_macd"] = (hist < 0) & (hist > hist.shift(1))
    out["e_rsi"] = (r > r.shift(1)) & (r.rolling(5).min() < RSI_LOW)
    out["e_candle"] = (l > l.shift(1)) | ((lower_wick >= 0.4) & (close_pos >= 0.5))
    easing = out[["e_macd", "e_rsi", "e_candle"]].sum(axis=1)
    out["rebound"] = out["falling"] & (easing >= 2)
    # --- trend
    out["t_stack"] = (c > sma20) & (sma20 > sma50)
    out["t_rising"] = (sma20 > sma20.shift(5)) & (sma50 > sma50.shift(10))
    out["t_adx"] = adx_ >= ADX_TREND
    out["t_200"] = sma200.isna() | (c > sma200)
    out["trend"] = out["t_stack"] & out["t_rising"] & out["t_adx"] & out["t_200"]
    # --- interim top
    out["extended"] = (c > sma20) & ((c / c.shift(10) - 1 > 0) | (r.rolling(5).max() > RSI_HIGH))
    out["f_macd"] = (hist > 0) & (hist < hist.shift(1))
    out["f_rsi"] = (r < r.shift(1)) & (r.rolling(5).max() > RSI_HIGH)
    out["f_candle"] = (h < h.shift(1)) | ((upper_wick >= 0.4) & (close_pos <= 0.5))
    new_high = h >= high20
    out["f_reject"] = (new_high.shift(1, fill_value=False) | new_high.shift(2, fill_value=False)) & (c < c.shift(1))
    fading = out[["f_macd", "f_rsi", "f_candle", "f_reject"]].sum(axis=1)
    out["top"] = out["extended"] & (fading >= 2)

    # --- numeric momentum-shift values (model features); scaled by ATR-like range where it matters
    atr14 = (h - l).rolling(14).mean().replace(0, np.nan)
    out["macd_hist_chg"] = (hist - hist.shift(1)) / atr14
    out["macd_hist_chg3"] = (hist - hist.shift(3)) / atr14
    out["rsi_chg_3"] = r - r.shift(3)
    out["adx"] = adx_
    out["di_diff"] = pdi - mdi
    out["lower_wick"] = lower_wick
    out["upper_wick"] = upper_wick
    out["down_streak"] = _streak(c < c.shift(1)).astype(float)
    out["up_streak"] = _streak(c > c.shift(1)).astype(float)
    out["bars_since_high20"] = h.rolling(20, min_periods=20).apply(lambda w: 19 - int(np.argmax(w)), raw=True)
    out["bars_since_low20"] = l.rolling(20, min_periods=20).apply(lambda w: 19 - int(np.argmin(w)), raw=True)
    return out


BUY_SETUPS = ("rebound", "trend")

_LABELS = {
    "rebound": [("falling", "Under pressure: below SMA20 and falling (or RSI recently < 40)"),
                ("e_macd", "MACD histogram negative but rising (selling momentum easing)"),
                ("e_rsi", "RSI turning up from a low"),
                ("e_candle", "Higher low or bullish rejection candle (long lower wick)")],
    "trend": [("t_stack", "Close > SMA20 > SMA50"),
              ("t_rising", "SMA20 and SMA50 rising"),
              ("t_adx", f"Trend strength ADX(14) >= {ADX_TREND:.0f}"),
              ("t_200", "Above SMA200 (when available)")],
    "top": [("extended", "Extended: above SMA20 and up over 10 bars (or RSI recently > 65)"),
            ("f_macd", "MACD histogram positive but falling (buying momentum easing)"),
            ("f_rsi", "RSI turning down from a high"),
            ("f_candle", "Lower high or bearish rejection candle (long upper wick)"),
            ("f_reject", "Close back below the prior close right after a new 20-bar high")],
}
RULES = {
    "rebound": "Under pressure + at least 2 of the 3 easing signs",
    "trend": "All four trend conditions",
    "top": "Extended + at least 2 of the 4 fading signs",
}


def buy_setup_names(s: pd.DataFrame) -> np.ndarray:
    """'rebound' / 'trend' / '' per bar (rebound wins when both hold)."""
    return np.where(s["rebound"], "rebound", np.where(s["trend"], "trend", ""))


def explain(s: pd.DataFrame, i: int) -> dict:
    """Which conditions of each setup hold at bar i (for the UI)."""
    row = s.iloc[i]
    return {name: {"active": bool(row[name]), "rule": RULES[name],
                   "checks": [{"label": text, "ok": bool(row[col])} for col, text in items]}
            for name, items in _LABELS.items()}
