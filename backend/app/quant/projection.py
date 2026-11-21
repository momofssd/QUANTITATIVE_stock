"""Projected BUY entry / SELL price for the current K line.

The current K line's decision depends on its close. This module re-evaluates the decision (setup AND model, the
same as the real one) as if the current bar closed at other prices, from -3 to +3 daily ATR around the current
close, and reports the price nearest to the current one at which the bar would become a BUY and the one at which
it would become a SELL. The UI shows the closer scenario.

  - the current bar is rebuilt with close = p, high = max(high, p), low = min(low, p) (open and volume kept);
    on daily / weekly bars the stock's latest daily close is p as well (intraday bars use yesterday's daily data)
  - features are computed on the last TAIL bars only (identical to the full history for the last bar; tested)
  - coarse grid every 0.2 ATR, then refined to 0.05 ATR between the nearest hit and the price next to it
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
import pandas as pd

from . import features as qf
from .setups import buy_setup_names, compute_setups

TAIL = 600
RANGE_ATR = 3.0
COARSE_ATR = 0.2
FINE_ATR = 0.05


@dataclass
class Side:
    """One scenario's model: fitted classifier (or None) and its signal threshold."""
    model: object | None
    threshold: float


def _scenario(df: pd.DataFrame, daily_close: pd.Series, p: float, same_day: bool):
    b = df.copy()
    last = b.index[-1]
    b.loc[last, "close"] = p
    b.loc[last, "high"] = max(float(b.loc[last, "high"]), p)
    b.loc[last, "low"] = min(float(b.loc[last, "low"]), p)
    dc = daily_close
    if same_day:
        dc = daily_close.copy()
        dc.iloc[-1] = p
    return b, dc


def project(df: pd.DataFrame, daily_close: pd.Series, factors: pd.DataFrame, bar_dates: pd.DatetimeIndex,
            mode: str, atr_now: float, buy: Side, sell: Side, now: dict[str, bool],
            buy_levels: Callable[[pd.DataFrame, str], dict], sell_levels: Callable[[float], dict]) -> dict | None:
    """now = {"buy": current K is a BUY, "sell": current K is a SELL}.
    buy_levels(bars_tail, setup) -> {target, stop, ...} for a BUY on the scenario's last bar; sell_levels(price)."""
    if not np.isfinite(atr_now) or atr_now <= 0:
        return None
    df = df.iloc[-TAIL:]
    dates = bar_dates[-TAIL:]
    dclose = daily_close.iloc[-TAIL:]
    close = float(df["close"].iloc[-1])
    same_day = mode != "previous"
    cache: dict[float, dict] = {}

    def evaluate(k: float) -> dict:
        k = round(k, 2)
        if k in cache:
            return cache[k]
        p = close + k * atr_now
        if p <= 0:
            cache[k] = {"k": k, "price": p, "buy": False, "sell": False}
            return cache[k]
        b, dc = _scenario(df, dclose, p, same_day)
        x = qf.build_features(b, factors, daily_close=dc, bar_dates=dates, mode=mode).iloc[-1:].to_numpy(dtype=float)
        s = compute_setups(b)
        setup = str(buy_setup_names(s.iloc[-1:])[0])
        top = bool(s["top"].iloc[-1])
        pb = float(buy.model.predict_proba(x)[0, 1]) if buy.model is not None else float("nan")
        ps = float(sell.model.predict_proba(x)[0, 1]) if sell.model is not None else float("nan")
        cache[k] = {"k": k, "price": p, "bars": b, "setup": setup, "p_buy": pb, "p_sell": ps,
                    "buy": bool(setup) and pb >= buy.threshold, "sell": top and ps >= sell.threshold}
        return cache[k]

    steps = int(round(RANGE_ATR / COARSE_ATR))
    coarse = [i * COARSE_ATR for i in range(-steps, steps + 1) if i != 0]
    for k in coarse:
        evaluate(k)

    def nearest(side: str) -> dict | None:
        if now[side]:
            return {"k": 0.0, "price": close, "now": True}
        hits = [cache[round(k, 2)] for k in coarse if cache[round(k, 2)][side]]
        if not hits:
            return None
        best = min(hits, key=lambda h: (abs(h["k"]), h["k"]))
        # refine between the hit and the coarse price next to it, towards the current price
        sign = 1 if best["k"] > 0 else -1
        for j in range(1, int(round(COARSE_ATR / FINE_ATR))):
            r = evaluate(best["k"] - sign * j * FINE_ATR)
            if r[side] and abs(r["k"]) < abs(best["k"]):
                best = r
        # the zone: contiguous coarse prices beyond it that are still a hit
        edge = best["k"]
        k = best["k"]
        while True:
            k = round(k + sign * COARSE_ATR, 2)
            if abs(k) > RANGE_ATR + 1e-9 or not evaluate(k)[side]:
                break
            edge = k
        return {**best, "now": False, "edge_k": edge}

    out = {"close": round(close, 2), "atr": round(atr_now, 2), "range_atr": RANGE_ATR, "step_atr": FINE_ATR}
    for side in ("buy", "sell"):
        h = nearest(side)
        if h is None:
            out[side] = None
            continue
        if h["now"]:
            out[side] = {"now": True, "price": round(close, 2), "move_atr": 0.0, "move_pct": 0.0}
            continue
        p = h["price"]
        edge_p = close + h["edge_k"] * atr_now
        v = {
            "now": False, "price": round(p, 2), "move_atr": round(h["k"], 2), "move_pct": round((p / close - 1) * 100, 2),
            "zone": [round(min(p, edge_p), 2), round(max(p, edge_p), 2)],
            "zone_open": abs(h["edge_k"]) >= RANGE_ATR - 1e-9,   # still a hit at the edge of the searched range
            "prob": round(h["p_buy" if side == "buy" else "p_sell"], 3),
            "threshold": round(buy.threshold if side == "buy" else sell.threshold, 3),
        }
        if side == "buy":
            v["setup"] = h["setup"]
            v |= buy_levels(h["bars"], h["setup"])
        else:
            v |= sell_levels(p)
        out[side] = v
    dist = {s: abs(out[s]["price"] - close) for s in ("buy", "sell") if out[s]}
    out["closer"] = min(dist, key=dist.get) if dist else None
    return out
