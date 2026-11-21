"""Entry and take-profit analysis on the chart's own K-lines (any range, any interval except monthly).

Pipeline (per request = symbol + range + interval + short-term TP/SL):
  1. the interval's bars from Alpaca (same bars as the chart, regular hours unless extended), the stock's daily
     bars, and Yahoo factors (SPY, QQQ, VIX, oil, gasoline, T-bill rate)
  2. features: stock features on the interval's bars + daily market features aligned without look-ahead
     (quant.features). Labels (quant.targets):
       short-term  profit-take +tp x daily ATR before stop-loss -sl x daily ATR within 5 trading SESSIONS
       long-term   +3 ATR before -2 ATR within 60 bars of the interval
  3. walk-forward: across the evaluation window (the chart's range, at least MIN_EVAL_BARS bars) a model is
     re-trained every few bars on the preceding TRAIN_BARS bars whose outcome was already known, and predicts
     the next block  ->  out-of-sample probabilities; clicking "Find entry points" retrains everything
  4. signals = bars where P(success) >= threshold (base rate + 15 pts), thinned by a cooldown
  5. short-term entries are traded as bracket orders (TP / SL / end of 5 sessions); long-term entries with stop,
     target, trailing stop, take-profit signal and time limit (quant.trades); both vs an entry on every bar
  6. long-term validation: after all long-term entries, is the average cost below the SMA 60? (quant.cost_check)
  7. stats + verdict, today's signal, factor relations (daily, 5y), which factor groups drive each model
CPU work runs in a worker thread; results are cached per request for a few minutes.
"""
from __future__ import annotations

import asyncio
import dataclasses
import math
import time
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

from ..alpaca_api import feeds
from ..core.errors import ApiError
from ..core.timeutil import EARLIEST, ET, et_epoch, iso, now_et
from ..quant import features as qf
from ..quant import model as qm
from ..quant.cost_check import average_cost_check
from ..quant.relations import factor_relations
from ..quant.targets import SHORT, TARGETS, TargetSpec, atr, bar_horizon, session_horizon, triple_barrier
from ..quant.trades import simulate, summarize
from ..yahoo_api import client as yahoo
from .bars_service import SESSION_RANGES, display_window, fetch_frame, resolve_range, warmup_days
from .frames import bars_frame

TRAIN_BARS = 1260        # rolling training window in bars (= 5 years of daily K-lines)
MIN_EVAL_BARS = 1260     # evaluate signals over at least this many recent bars (enough history for a verdict)
WARMUP_BARS = 260        # bars before the training window so 200-bar / 52-week features exist
MIN_RETRAIN_EVERY = 21   # bars between re-trainings ...
MAX_FOLDS = 60           # ... widened so no more than this many re-trainings per target
IMPORTANCE_BARS = 252    # last bars used to measure which factors matter
RELATION_YEARS = 5
MIN_BARS = 400
CACHE_TTL = 600          # seconds
TP_RANGE = (0.5, 5.0)    # allowed short-term profit-take, in daily ATR
SL_RANGE = (0.25, 5.0)   # allowed short-term stop-loss, in daily ATR

ALIGN_MODE = {"1Day": "same", "1Week": "week_end"}  # intraday -> "previous"
BAR_UNIT = {
    "1Min": "1-minute bars", "5Min": "5-minute bars", "15Min": "15-minute bars", "30Min": "30-minute bars",
    "1Hour": "hourly bars", "4Hour": "4-hour bars", "1Day": "trading days", "1Week": "weeks",
}

_cache: dict[tuple, tuple[float, dict]] = {}


@dataclass(frozen=True)
class AnalysisRequest:
    symbol: str
    range: str = "5Y"
    timeframe: str | None = "1Day"
    start: str | None = None
    end: str | None = None
    extended: bool = False
    tp_atr: float = SHORT.target_atr   # short-term profit-take, x daily ATR
    sl_atr: float = SHORT.stop_atr     # short-term stop-loss, x daily ATR


async def run_analysis(req: AnalysisRequest, refresh: bool = False) -> dict:
    rng, tf, tf_min = resolve_range(req.range, req.timeframe)
    if tf not in BAR_UNIT:
        raise ApiError(422, "Monthly bars are too few for this analysis (Alpaca history starts in 2016). "
                            "Switch the chart to Weekly or Daily and try again.")
    if not (TP_RANGE[0] <= req.tp_atr <= TP_RANGE[1]) or not (SL_RANGE[0] <= req.sl_atr <= SL_RANGE[1]):
        raise ApiError(400, f"Profit-take must be {TP_RANGE[0]}-{TP_RANGE[1]} ATR and stop-loss "
                            f"{SL_RANGE[0]}-{SL_RANGE[1]} ATR.")
    intraday = tf_min < 1440
    key = (req.symbol, rng, tf, req.start, req.end, req.extended and intraday, req.tp_atr, req.sl_atr)
    hit = _cache.get(key)
    if hit and not refresh and time.time() - hit[0] < CACHE_TTL:
        return hit[1]

    display_start, display_end = display_window(rng, req.start, req.end, now_et())
    if intraday:
        need = TRAIN_BARS + WARMUP_BARS + MIN_EVAL_BARS
        fetch_start = max(display_start - pd.Timedelta(days=warmup_days(tf_min, need, req.extended)), EARLIEST)
    else:
        fetch_start = EARLIEST
    # Fetch through today even for a custom range that ends earlier: outcomes need the bars after it.
    df, session, _ = await fetch_frame(req.symbol, tf, fetch_start, None, req.extended)
    if len(df) < MIN_BARS:
        raise ApiError(422, f"{req.symbol} has only {len(df)} {BAR_UNIT[tf]} available here; the analysis needs "
                            f"at least {MIN_BARS}. Try a longer range or a shorter interval.")
    daily = df if tf == "1Day" else bars_frame(await feeds.get_bars(req.symbol, "1Day", iso(EARLIEST)))
    daily = daily.copy()
    daily.index = daily.index.tz_convert(ET).tz_localize(None).normalize()
    daily = daily[~daily.index.duplicated(keep="last")]
    factors = await asyncio.to_thread(
        yahoo.fetch_factors, (daily.index[0] - pd.Timedelta(days=400)).strftime("%Y-%m-%d"))

    result = await asyncio.to_thread(
        compute, req.symbol, df, session, daily, factors,
        rng=rng, tf=tf, intraday=intraday, display_start=display_start, display_end=display_end,
        tp_atr=req.tp_atr, sl_atr=req.sl_atr)
    result["extended"] = bool(req.extended and intraday)
    _cache[key] = (time.time(), result)
    return result


def _num(v, nd: int = 4):
    return None if v is None or not np.isfinite(v) else round(float(v), nd)


def _signals(spec: TargetSpec, cooldown: int, stamps, times, close, atr_v, wf, resolved, outcome,
             w0: int, w1: int) -> list[dict]:
    """Bars in [w0, w1) where P(success) >= threshold, at most one per cooldown period."""
    out, last = [], -10**9
    for i in range(w0, w1):
        p, thr = wf.prob[i], wf.threshold[i]
        if not (np.isfinite(p) and np.isfinite(thr)) or p < thr or i - last <= cooldown:
            continue
        last = i
        r = int(resolved[i])
        target, stop = spec.levels(close[i], atr_v[i])
        out.append({
            "i": i, "time": int(times[i]), "date": stamps[i],
            "prob": _num(p, 3), "threshold": _num(thr, 3),
            "entry": _num(close[i], 2), "atr": _num(atr_v[i], 2),
            "target": _num(target, 2), "stop": _num(stop, 2),
            "outcome": outcome[i], "resolved_date": stamps[r] if r < len(stamps) else None,
            "days": (r - i) if r < len(stamps) else None,
        })
    return out


def _trade_view(t: dict, stamps, times, left: int | None, left_unit: str) -> dict:
    """Simulator output -> JSON (dates instead of indices, percentages, rounded numbers)."""
    v = {"status": t["status"], "price": _num(t["price"], 2), "return_pct": _num(t["return_pct"] * 100, 2),
         "r": _num(t["r"], 2), "days": t["days"]}
    if t["status"] == "closed":
        j = t["exit_index"]
        v |= {"reason": t["reason"], "exit_date": stamps[j], "exit_time": int(times[j])}
    else:
        v |= {"stop": _num(t["stop"], 2), "target": _num(t["target"], 2), "trailing": t["trailing"],
              "days_left": left, "left_unit": left_unit}
    return v


def _stats(wf, label, signals, w0: int, w1: int) -> dict:
    y, p = label[w0:w1], wf.prob[w0:w1]
    known = ~np.isnan(y)
    scored = known & ~np.isnan(p)
    auc = None
    if scored.sum() > 50 and len(np.unique(y[scored])) == 2:
        auc = round(float(roc_auc_score(y[scored], p[scored])), 3)
    done = [s for s in signals if s["outcome"] != "pending"]
    hits = sum(s["outcome"] == "target" for s in done)
    base_rate = _num(np.nanmean(y), 3) if known.any() else None
    hit_rate = round(hits / len(done), 3) if done else None
    reliable, verdict = qm.reliability(auc, hit_rate, base_rate)
    return {
        "reliable": reliable, "verdict": verdict, "base_rate": base_rate, "auc": auc,
        "signals": len(signals), "resolved": len(done), "hits": hits, "hit_rate": hit_rate, "folds": wf.folds,
    }


def eval_window(index: pd.DatetimeIndex, session: pd.Series, rng: str, display_start, display_end) -> tuple[int, int]:
    """[w0, w1): the bars of the chart's range, widened to at least MIN_EVAL_BARS bars."""
    n = len(index)
    if rng in SESSION_RANGES:
        sessions = pd.unique(session.values)
        keep_from = sessions[-SESSION_RANGES[rng]:][0]
        w0 = int(np.argmax(session.values >= keep_from))
    else:
        w0 = int(np.searchsorted(index.values, display_start.tz_convert("UTC").to_datetime64()))
    w1 = n if display_end is None else int(np.searchsorted(index.values, display_end.tz_convert("UTC").to_datetime64()))
    w0 = max(0, min(w0, w1 - MIN_EVAL_BARS))
    return w0, max(w1, w0 + 1)


@dataclass
class Horizons:
    """Per-bar horizon (end index, complete flag) and signal cooldown for one target on this interval."""
    end: np.ndarray
    complete: np.ndarray
    cooldown: int
    unit: str            # "bars" or "sessions" (for 'N left' on open trades)
    session_ord: np.ndarray


def _horizons(spec: TargetSpec, tf: str, session: pd.Series, et_naive: pd.DatetimeIndex) -> Horizons:
    n = len(session)
    ordinal = pd.factorize(session.to_numpy())[0]
    if spec.horizon_mode != "sessions":
        end, complete = bar_horizon(n, spec.horizon)
        return Horizons(end, complete, spec.cooldown, "bars", np.arange(n))
    if tf == "1Day":
        end, complete = bar_horizon(n, spec.horizon)
        return Horizons(end, complete, spec.cooldown, "sessions", np.arange(n))
    if tf == "1Week":  # 5 sessions = the next weekly bar
        end, complete = bar_horizon(n, 1)
        return Horizons(end, complete, 1, "bars", np.arange(n))
    minute = (et_naive.hour * 60 + et_naive.minute).to_numpy()
    end, complete = session_horizon(ordinal, minute, spec.horizon)
    per_session = int(np.median(np.bincount(ordinal))) if n else 1
    return Horizons(end, complete, max(1, per_session), "sessions", ordinal)  # at most ~one entry per session


def compute(symbol: str, df: pd.DataFrame, session: pd.Series, daily: pd.DataFrame, factors: pd.DataFrame, *,
            rng: str, tf: str, intraday: bool, display_start, display_end,
            tp_atr: float = SHORT.target_atr, sl_atr: float = SHORT.stop_atr) -> dict:
    n = len(df)
    mode = ALIGN_MODE.get(tf, "previous")
    bar_dates = pd.DatetimeIndex(session.to_numpy())
    feats = qf.build_features(df, factors, daily_close=daily["close"], bar_dates=bar_dates, mode=mode)
    names = list(feats.columns)
    X = feats.to_numpy(dtype=float)
    open_, high, low, close = (df[k].to_numpy(dtype=float) for k in ("open", "high", "low", "close"))
    bar_atr = atr(df["high"], df["low"], df["close"]).to_numpy()
    daily_atr = atr(daily["high"], daily["low"], daily["close"]).rename("a").to_frame()
    day_atr = qf.align(daily_atr, bar_dates, mode)["a"].to_numpy()  # daily ATR known at each bar
    times = et_epoch(df.index)  # same time encoding as the chart's bars
    et_naive = df.index.tz_convert(ET).tz_localize(None)
    stamps = list(et_naive.strftime("%Y-%m-%d %H:%M" if intraday else "%Y-%m-%d"))

    w0, w1 = eval_window(df.index, session, rng, display_start, display_end)
    step = max(MIN_RETRAIN_EVERY, math.ceil((w1 - w0) / MAX_FOLDS))
    specs = [dataclasses.replace(s, target_atr=tp_atr, stop_atr=sl_atr) if s.key == "short" else s for s in TARGETS]

    # 1) labels + walk-forward probabilities for every target (entries and take-profits)
    fitted = {}
    for spec in specs:
        a = day_atr if spec.atr_basis == "daily" else bar_atr
        hz = _horizons(spec, tf, session, et_naive)
        label, resolved, outcome = triple_barrier(high, low, close, a, spec, hz.end, hz.complete)
        wf = qm.walk_forward(X, label, resolved, start=w0, window=TRAIN_BARS, step=step, kind=spec.model)
        fitted[spec.key] = (a, hz, label, resolved, outcome, wf)
    # Out-of-sample take-profit signal per bar (used to close long-term trades). NaN probability = no signal.
    tp_signal = {k: np.nan_to_num(f[5].prob, nan=-1.0) >= np.nan_to_num(f[5].threshold, nan=2.0)
                 for k, f in fitted.items()}

    targets = {}
    lines = {}
    for spec in specs:
        a, hz, label, resolved, outcome, wf = fitted[spec.key]
        signals = _signals(spec, hz.cooldown, stamps, times, close, a, wf, resolved, outcome, w0, w1)

        def left(i: int) -> int | None:
            if hz.unit == "sessions":
                return int(max(0, hz.session_ord[i] + spec.horizon - hz.session_ord[-1]))
            return int(max(0, i + spec.horizon - (n - 1)))

        trades = cost = None
        if spec.kind == "entry":
            tps = tp_signal[spec.exit_with] if spec.exit_with else None
            sims = []
            for sgl in signals:
                i = sgl["i"]
                t = simulate(i, open_, high, low, close, a[i], spec, tps, int(hz.end[i]), bool(hz.complete[i]))
                sgl["trade"] = _trade_view(t, stamps, times, left(i), hz.unit)
                sims.append(t)
            # Baseline: the same exit rules applied to an entry on EVERY bar of the window.
            every = [simulate(i, open_, high, low, close, a[i], spec, tps, int(hz.end[i]), bool(hz.complete[i]))
                     for i in range(w0, min(w1, n - 1)) if np.isfinite(a[i]) and a[i] > 0]
            trades = {
                "signals": summarize(sims),
                "every_day": summarize(every),
                "buy_hold_pct": _num((close[w1 - 1] / close[w0] - 1) * 100, 2),
                "rules": {"stop_atr": spec.stop_atr, "target_atr": spec.target_atr,
                          "trail_after_atr": spec.trail_after_atr, "trail_atr": spec.trail_atr,
                          "horizon": spec.horizon, "horizon_mode": spec.horizon_mode, "atr_basis": spec.atr_basis,
                          "exit_with": spec.exit_with},
            }
        if spec.key == "long":
            c = average_cost_check([s["i"] for s in signals], close, w0)
            sma_s = c.pop("sma_series")
            for cp in c["checkpoints"]:
                i = cp.pop("index")
                cp |= {"time": int(times[i]), "date": stamps[i], "price": _num(close[i], 2)}
                cp["avg_cost"], cp["sma"] = _num(cp["avg_cost"], 2), _num(cp["sma"], 2)
            for k in ("avg_cost", "sma_now", "discount_pct", "dca_avg_cost", "vs_dca_pct"):
                c[k] = _num(c.get(k), 2)
            cost = c
            lines = {
                "sma": [{"time": int(times[i]), "value": round(float(sma_s[i]), 2)}
                        for i in range(w0, n) if np.isfinite(sma_s[i])],
                "avg_cost": [{"time": cp["time"], "value": cp["avg_cost"]} for cp in c["checkpoints"]]
                + ([{"time": int(times[-1]), "value": c["avg_cost"]}] if c["checkpoints"] else []),
                "sma_len": c["sma_len"],
            }
        for sgl in signals:
            sgl.pop("i")

        latest, base_now = qm.fit_latest(X, label, resolved, TRAIN_BARS, kind=spec.model)
        current = None
        if latest is not None and np.isfinite(a[-1]):
            p_now = float(latest.predict_proba(X[-1:])[0, 1])
            thr_now = qm.threshold_for(base_now)
            target, stop = spec.levels(close[-1], a[-1])
            current = {
                "date": stamps[-1], "time": int(times[-1]),
                "prob": _num(p_now, 3), "threshold": _num(thr_now, 3), "base_rate": _num(base_now, 3),
                "signal": bool(p_now >= thr_now),
                "entry": _num(close[-1], 2), "atr": _num(a[-1], 2),
                "target": _num(target, 2), "stop": _num(stop, 2),
                "horizon_days": spec.horizon,
            }
        open_trade = next((s for s in reversed(signals) if s.get("trade", {}).get("status") == "open"), None)
        targets[spec.key] = {
            "spec": spec.to_dict(),
            "current": current,
            "signals": signals,
            "stats": _stats(wf, label, signals, w0, w1),
            "trades": trades,
            "cost_check": cost,
            "open_trade": open_trade,
            "importance": qm.group_importance(X, label, resolved, TRAIN_BARS, min(IMPORTANCE_BARS, w1 - w0),
                                              names, qf.GROUPS, kind=spec.model),
        }

    rel_start = daily.index[-1] - pd.DateOffset(years=RELATION_YEARS)
    return {
        "symbol": symbol,
        "range": rng,
        "timeframe": tf,
        "intraday": intraday,
        "bar_unit": BAR_UNIT[tf],
        "asof": stamps[-1],
        "params": {"tp_atr": tp_atr, "sl_atr": sl_atr, "tp_range": TP_RANGE, "sl_range": SL_RANGE},
        "window": {"start": stamps[w0], "end": stamps[w1 - 1], "bars": w1 - w0,
                   "train_bars": TRAIN_BARS, "retrain_every": step, "years": RELATION_YEARS},
        "method": {
            "model": "Short-term (5-session) signals: gradient-boosted trees (HistGradientBoostingClassifier); "
                     "long-term (60-bar) signals: regularised logistic regression (scikit-learn)",
            "training": f"Rolling window of the {TRAIN_BARS:,} {BAR_UNIT[tf]} before each prediction, retrained "
                        f"every {step} bars on outcomes already known at that time (walk-forward, out-of-sample).",
            "signal_rule": f"Signal marked when P(success) >= training base rate + {int(qm.SIGNAL_EDGE * 100)} pts "
                           f"(bounded {qm.THRESHOLD_BOUNDS[0]:.2f}-{qm.THRESHOLD_BOUNDS[1]:.2f}); "
                           "one per cooldown period.",
            "features": len(names),
            "atr": f"short-term: daily ATR(14); long-term: ATR(14) of the {BAR_UNIT[tf]}",
            "factor_alignment": {"same": "same-day factor values (known at the daily close)",
                                 "week_end": "factor values at the end of each week",
                                 "previous": "previous day's factor values (today's are not known intraday)"}[mode],
        },
        "sources": {"stock": "Alpaca bars", "factors": "Yahoo Finance",
                    "factor_tickers": {k: t for k, (t, _) in yahoo.FACTORS.items()}},
        "targets": targets,
        "lines": lines,
        "relations": factor_relations(daily["close"], factors, rel_start),
    }
