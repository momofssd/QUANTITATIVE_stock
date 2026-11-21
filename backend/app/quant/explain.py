"""Why a BUY / SELL decision was made (shown when a decision row is expanded in the UI).

For one decision bar:
  - model     P(success) of the walk-forward model that made the decision, its threshold and training base rate
  - factors   how much each factor group moved P: P with the bar's real values minus P with that group's features
              set to typical values (the medians of that model's training data). Positive = pushed towards the
              decision. Occlusion effects; they do not add up exactly to P - base rate.
  - setup     which conditions of the setup(s) held on that bar (quant/setups.explain)
  - values    a few readable indicator values at that bar
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .model import WalkForward
from .setups import explain as explain_setups

# (feature, label, kind): kind "logret" -> % (simple return), "frac" -> %, "atr" -> x ATR, "num0/1/2" -> number,
# "rate" -> % (already in percent)
VALUES = (
    ("rsi_14", "RSI(14)", "num0"),
    ("macd_hist_atr", "MACD histogram", "atr"),
    ("ret_5", "Return, last 5 {bars}", "logret"),
    ("ret_20", "Return, last 20 {bars}", "logret"),
    ("dist_sma20", "Close vs SMA20", "atr"),
    ("dist_sma50", "Close vs SMA50", "atr"),
    ("dist_sma200", "Close vs SMA200", "atr"),
    ("dist_52w_high", "From the 252-{bar} high", "atr"),
    ("adx", "ADX(14)", "num0"),
    ("volume_z", "Volume vs 20-{bar} average (z)", "num1"),
    ("spy_ret_20", "SPY, 20-day return", "logret"),
    ("spy_vs_sma200", "SPY vs its 200-day average", "frac"),
    ("vix", "VIX", "num1"),
    ("vix_chg_5", "VIX, 5-day change", "logret"),
    ("rate", "13-week T-bill yield", "rate"),
)


def _value(v: float, kind: str) -> tuple[float | None, str, int]:
    if v is None or not np.isfinite(v):
        return None, "", 0
    if kind == "logret":
        return round(float(np.expm1(v)) * 100, 2), "%", 1
    if kind == "frac":
        return round(float(v) * 100, 2), "%", 1
    if kind == "rate":
        return round(float(v), 2), "%", 2
    if kind == "atr":
        return round(float(v), 2), "ATR", 2
    digits = int(kind[-1])
    return round(float(v), digits), "", digits


def group_effects(model, medians: np.ndarray, x: np.ndarray, names: list[str], groups: dict[str, str]) -> list[dict]:
    """P(real values) - P(this group's features at typical values), per factor group, largest first."""
    order = list(dict.fromkeys(groups[n] for n in names if n in groups))
    rows = np.repeat(x[None, :], len(order), axis=0)
    for gi, g in enumerate(order):
        cols = [j for j, n in enumerate(names) if groups.get(n) == g]
        rows[gi, cols] = medians[cols]
    p = float(model.predict_proba(x[None, :])[0, 1])
    ps = model.predict_proba(rows)[:, 1]
    out = [{"group": g, "delta": round((p - float(ps[gi])) * 100, 1)} for gi, g in enumerate(order)]
    return sorted(out, key=lambda r: -abs(r["delta"]))


def explain_decision(wf: WalkForward, i: int, X: np.ndarray, names: list[str], groups: dict[str, str],
                     setups: pd.DataFrame, setup_names: tuple[str, ...], bar_word: str) -> dict:
    x = X[i]
    feat = dict(zip(names, x))
    values = []
    for key, label, kind in VALUES:
        if key not in feat:
            continue
        v, unit, digits = _value(feat[key], kind)
        if v is not None:
            values.append({"label": label.format(bars=f"{bar_word}s", bar=bar_word), "value": v, "unit": unit,
                           "digits": digits, "signed": kind in ("logret", "frac", "atr")})
    ex = explain_setups(setups, i)
    fold = wf.fold_at(i)
    return {
        "base_rate": None if not np.isfinite(wf.base[i]) else round(float(wf.base[i]), 3),
        "factors": group_effects(fold[2], fold[3], x, names, groups) if fold is not None else [],
        "setups": {k: ex[k] for k in setup_names if k in ex},
        "values": values,
    }
