"""Does today's 5-minute action support a BUY (or a SELL) on the current K line?

Five checks on the latest session's regular-hours 5-minute bars, each scored +1 (supports BUY), -1 (against BUY)
or 0 (neutral). The SELL score is the BUY score with the sign flipped (weakness supports taking profit).
  VWAP          last price above / below the session VWAP
  Last hour     direction of the last 12 bars (close-to-close change, ignoring moves under 0.1 x bar range)
  RSI (5-min)   RSI(14) rising / falling over the last 3 bars
  Lows          lows of the last 30 min above / below those of the 30 min before (buyers / sellers stepping in)
  Day range     close in the upper half / lower third of today's range
Verdict: score >= 2 "supports", <= -2 "against", otherwise "mixed".
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .setups import rsi


def _verdict(score: int) -> str:
    return "supports" if score >= 2 else "against" if score <= -2 else "mixed"


def intraday_check(bars: pd.DataFrame, prev_close: float | None) -> dict:
    """bars: one session of 5-minute OHLCV bars (oldest first)."""
    n = len(bars)
    if n < 6:
        return {"available": False, "reason": f"Only {n} five-minute bars in the latest session so far."}
    c, h, l, v = (bars[k].astype(float) for k in ("close", "high", "low", "volume"))
    tp = (h + l + c) / 3
    vwap = float((tp * v).cumsum().iloc[-1] / v.cumsum().replace(0, np.nan).iloc[-1])
    last = float(c.iloc[-1])
    day_hi, day_lo = float(h.max()), float(l.min())
    pos = (last - day_lo) / (day_hi - day_lo) if day_hi > day_lo else 0.5
    r = rsi(c)
    r_now = float(r.iloc[-1]) if np.isfinite(r.iloc[-1]) else None
    r_prev = float(r.iloc[-4]) if n >= 4 and np.isfinite(r.iloc[-4]) else None
    k = min(12, n - 1)
    hour_chg = last - float(c.iloc[-1 - k])
    noise = 0.1 * float((h - l).tail(k).mean())
    w = min(6, n // 2)
    lows_now, lows_before = float(l.tail(w).min()), float(l.iloc[-2 * w:-w].min())

    def score(cond_up: bool, cond_down: bool) -> int:
        return 1 if cond_up else -1 if cond_down else 0

    checks = [
        {"id": "vwap", "label": "Price vs VWAP", "signal": score(last > vwap, last < vwap),
         "detail": f"{last:,.2f} vs VWAP {vwap:,.2f}"},
        {"id": "hour", "label": f"Last {k * 5} minutes", "signal": score(hour_chg > noise, hour_chg < -noise),
         "detail": f"{hour_chg:+,.2f}"},
        {"id": "rsi", "label": "RSI(14) on 5-min",
         "signal": score(r_now is not None and r_prev is not None and r_now > r_prev,
                         r_now is not None and r_prev is not None and r_now < r_prev),
         "detail": f"{r_now:.0f} (was {r_prev:.0f})" if r_now is not None and r_prev is not None else "not enough bars"},
        {"id": "lows", "label": f"Lows, last {w * 5} min vs prior {w * 5}",
         "signal": score(lows_now > lows_before, lows_now < lows_before),
         "detail": f"{lows_now:,.2f} vs {lows_before:,.2f}"},
        {"id": "range", "label": "Position in today's range", "signal": score(pos > 0.5, pos < 1 / 3),
         "detail": f"{pos * 100:.0f}% of {day_lo:,.2f}–{day_hi:,.2f}"},
    ]
    buy = int(sum(ch["signal"] for ch in checks))
    return {
        "available": True,
        "bars": n,
        "last": last,
        "vwap": round(vwap, 4),
        "day_high": day_hi,
        "day_low": day_lo,
        "day_change_pct": round((last / prev_close - 1) * 100, 2) if prev_close else None,
        "checks": checks,
        "buy": {"score": buy, "verdict": _verdict(buy)},
        "sell": {"score": -buy, "verdict": _verdict(-buy)},
    }
