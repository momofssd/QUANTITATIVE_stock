"""Long-term validation: after buying at every long-term entry, is the position's average cost below the SMA 60?

Each entry buys the same dollar amount (dollar-cost averaging), so the average cost per share is the harmonic mean
of the entry prices. The check is made after every entry (running) and against the latest SMA 60 (final verdict).
For context, the same is computed for buying an equal amount on EVERY bar of the window.
"""
from __future__ import annotations

import numpy as np

SMA_LEN = 60


def sma(close: np.ndarray, n: int = SMA_LEN) -> np.ndarray:
    out = np.full(len(close), np.nan)
    if len(close) >= n:
        c = np.cumsum(np.insert(close.astype(float), 0, 0.0))
        out[n - 1:] = (c[n:] - c[:-n]) / n
    return out


def harmonic_mean(prices: np.ndarray) -> float:
    return float(len(prices) / np.sum(1.0 / prices))


def average_cost_check(entry_idx: list[int], close: np.ndarray, w0: int, sma_len: int = SMA_LEN) -> dict:
    s = sma(close, sma_len)
    n = len(close)
    sma_now = float(s[-1]) if np.isfinite(s[-1]) else None
    dca = harmonic_mean(close[w0:n]) if n > w0 else None
    if not entry_idx:
        return {"sma_len": sma_len, "entries": 0, "avg_cost": None, "sma_now": sma_now, "validated": None,
                "discount_pct": None, "dca_avg_cost": dca, "checkpoints": [],
                "verdict": "No long-term entries in this window, so there is no position to validate."}

    prices = close[entry_idx].astype(float)
    checkpoints = []
    for k, i in enumerate(entry_idx, start=1):
        avg = harmonic_mean(prices[:k])
        checkpoints.append({"index": i, "avg_cost": avg, "sma": float(s[i]) if np.isfinite(s[i]) else None})
    avg_cost = checkpoints[-1]["avg_cost"]
    validated = sma_now is not None and avg_cost < sma_now
    discount = (sma_now - avg_cost) / sma_now * 100 if sma_now else None
    held_below = sum(1 for c in checkpoints if c["sma"] is not None and c["avg_cost"] < c["sma"])

    if sma_now is None:
        verdict = "Not enough bars for a 60-bar average yet."
    elif validated:
        verdict = (f"Validated: after all {len(entry_idx)} long-term entries the average cost {avg_cost:,.2f} is "
                   f"{discount:.1f}% below the SMA {sma_len} ({sma_now:,.2f}).")
    else:
        verdict = (f"Not validated: after all {len(entry_idx)} long-term entries the average cost {avg_cost:,.2f} is "
                   f"{-discount:.1f}% above the SMA {sma_len} ({sma_now:,.2f}).")
    return {
        "sma_len": sma_len, "entries": len(entry_idx), "avg_cost": avg_cost, "sma_now": sma_now,
        "validated": validated if sma_now is not None else None, "discount_pct": discount,
        "held_below": held_below, "dca_avg_cost": dca,
        "vs_dca_pct": (avg_cost / dca - 1) * 100 if dca else None,
        "checkpoints": checkpoints, "verdict": verdict, "sma_series": s,
    }
