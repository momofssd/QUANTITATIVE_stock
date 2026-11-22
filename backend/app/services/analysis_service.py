"""Entry and take-profit analysis on the chart's own K-lines (any range, any interval except monthly).

Pipeline (per request = symbol + range + interval + short-term TP/SL):
  1. the interval's bars from Alpaca (same bars as the chart, regular hours unless extended), the stock's daily
     bars, and Yahoo factors (SPY, QQQ, VIX, oil, gasoline, T-bill rate)
  2. features: stock features on the interval's bars + daily market features aligned without look-ahead
     (quant.features). Labels (quant.targets):
       short-term entry        profit-take +tp x daily ATR before stop-loss -sl x daily ATR within 20 trading SESSIONS
       short-term take-profit  -1.5 daily ATR (pullback) before +1 daily ATR within 5 trading sessions
  3. walk-forward: across the evaluation window (the chart's range, at least MIN_EVAL_BARS bars) a model is
     re-trained every few bars on the preceding TRAIN_BARS bars whose outcome was already known, and predicts
     the next block  ->  out-of-sample probabilities; clicking "Find entry points" retrains everything
  4. signals = bars where P(success) >= threshold (base rate + 15 pts), thinned by a cooldown
  5. short-term entries are traded as bracket orders (TP / SL / end of 20 sessions) (quant.trades), compared with
     the same order placed on every bar
  6. stats + verdict, today's signal, factor relations (daily, 5y), which factor groups drive each model
CPU work runs in a worker thread; results are cached per request for a few minutes.
"""
from __future__ import annotations

import asyncio
import dataclasses
import math
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score
from threadpoolctl import threadpool_limits

from ..alpaca_api import feeds
from ..core.errors import ApiError
from ..core.timeutil import EARLIEST, ET, et_epoch, iso, now_et
from ..quant import accum as qa
from ..quant import backtest as qbt
from ..quant import brackets as qb
from ..quant import explain as qe
from ..quant import features as qf
from ..quant import model as qm
from ..quant import optimize as qo
from ..quant import portfolio
from ..quant import projection as qp
from ..quant.intraday import intraday_check
from ..quant.relations import factor_relations
from ..quant.setups import BUY_SETUPS, buy_setup_names, compute_setups, explain
from ..quant.targets import SHORT, TARGETS, TargetSpec, atr, bar_horizon, session_horizon, triple_barrier
from ..quant.trades import simulate, summarize
from ..yahoo_api import client as yahoo
from .bars_service import (SESSION_RANGES, TIMEFRAME_MINUTES, display_window, fetch_frame, resolve_range,
                           warmup_days)
from .frames import bars_frame

TRAIN_BARS = 1260        # rolling training window in bars (= 5 years of daily K-lines)
MIN_EVAL_BARS = 1260     # evaluate signals over at least this many recent bars (enough history for a verdict)
WARMUP_BARS = 260        # bars before the training window so 200-bar / 52-week features exist
MIN_RETRAIN_EVERY = 21   # bars between re-trainings ...
MAX_FOLDS = 60           # ... widened so no more than this many re-trainings per target
IMPORTANCE_BARS = 252    # last bars used to measure which factors matter
MOMENTUM_BARS = 10       # K lines before (and incl.) the current one scored by today's models (momentum panel)
RELATION_YEARS = 5
MIN_BARS = 400
CACHE_TTL = 600          # seconds
CHASE_ATR = 0.25         # BUY entry stays valid up to entry + this x daily ATR (don't chase further)
TP_RANGE = (0.5, 5.0)    # allowed short-term profit-take, in daily ATR
SL_RANGE = (0.25, 5.0)   # allowed short-term stop-loss, in daily ATR
BRACKETS = ("fixed", "optimal")  # BUY profit-take / stop-loss: user's ATR multiples, or optimized by backtest

ALIGN_MODE = {"1Day": "same", "1Week": "week_end"}  # intraday -> "previous"
BAR_WORD = {"1Day": "day", "1Week": "week"}  # intraday -> "bar"
BAR_UNIT = {
    "1Min": "1-minute bars", "5Min": "5-minute bars", "15Min": "15-minute bars", "30Min": "30-minute bars",
    "1Hour": "hourly bars", "4Hour": "4-hour bars", "1Day": "trading days", "1Week": "weeks",
}

_cache: dict[tuple, tuple[float, dict]] = {}
# Training runs kept for the Backtests page (run_id -> candidates, SELL decisions, ...); the most recent MAX_RUNS.
_runs: OrderedDict[str, dict] = OrderedDict()
MAX_RUNS = 30


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
    bracket: str = "fixed"             # "fixed" (tp_atr / sl_atr) or "optimal" (best profit, quant/optimize)


async def run_analysis(req: AnalysisRequest, refresh: bool = False) -> dict:
    rng, tf, tf_min = resolve_range(req.range, req.timeframe)
    if tf not in BAR_UNIT:
        raise ApiError(422, "Monthly bars are too few for this analysis (Alpaca history starts in 2016). "
                            "Switch the chart to Weekly or Daily and try again.")
    if not (TP_RANGE[0] <= req.tp_atr <= TP_RANGE[1]) or not (SL_RANGE[0] <= req.sl_atr <= SL_RANGE[1]):
        raise ApiError(400, f"Profit-take must be {TP_RANGE[0]}-{TP_RANGE[1]} ATR and stop-loss "
                            f"{SL_RANGE[0]}-{SL_RANGE[1]} ATR.")
    if req.bracket not in BRACKETS:
        raise ApiError(400, "bracket must be 'fixed' or 'optimal'.")
    intraday = tf_min < 1440
    key = (req.symbol, rng, tf, req.start, req.end, req.extended and intraday, req.tp_atr, req.sl_atr, req.bracket)
    hit = _cache.get(key)
    if hit and not refresh and time.time() - hit[0] < CACHE_TTL:
        return hit[1]

    display_start, display_end = display_window(rng, req.start, req.end, now_et())
    if intraday:
        # + the BUY holding window: outcomes of the last HOLD_SESSIONS sessions are not known yet
        per_session = (960 if req.extended else 390) / tf_min
        need = TRAIN_BARS + WARMUP_BARS + MIN_EVAL_BARS + int(SHORT.horizon * per_session)
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
        tp_atr=req.tp_atr, sl_atr=req.sl_atr, bracket=req.bracket)
    result["extended"] = bool(req.extended and intraday)
    result["intraday_check"] = await intraday_snapshot(req.symbol)
    run = result.pop("_backtest")
    run_id = uuid.uuid4().hex[:12]
    _runs[run_id] = {**run, "symbol": req.symbol, "timeframe": tf, "range": rng}
    while len(_runs) > MAX_RUNS:
        _runs.popitem(last=False)
    result["run_id"] = run_id
    _cache[key] = (time.time(), result)
    return result


def run_backtest(run_id: str, n: int, setups: str, min_prob: float | None, sizing: str,
                 sell_min_prob: float | None = None, max_shares: float | None = None) -> dict:
    """Backtest scenarios on a training run (quant/backtest.py)."""
    run = _runs.get(run_id)
    if run is None:
        raise ApiError(404, "This training is no longer on the server (it was restarted or the training is old). "
                            "Run Find entry points again.")
    if not 1 <= n <= qbt.MAX_DECISIONS:
        raise ApiError(422, f"Number of decisions must be 1-{qbt.MAX_DECISIONS}.")
    if setups not in qbt.SETUP_CHOICES:
        raise ApiError(422, "setups must be rebound, trend or both.")
    for v in (min_prob, sell_min_prob):
        if v is not None and not 0.0 <= v <= 1.0:
            raise ApiError(422, "A probability threshold must be between 0 and 100%.")
    if sizing not in portfolio.SIZINGS:
        raise ApiError(422, "sizing must be usd or share.")
    if max_shares is not None and not 0 < max_shares <= 1e6:
        raise ApiError(422, "Max shares held must be more than 0.")
    _runs.move_to_end(run_id)
    return {"run_id": run_id, "symbol": run["symbol"], "timeframe": run["timeframe"], "range": run["range"],
            "bar_unit": run["bar_unit"], "cooldown": run["cooldown"], "window": run["window"],
            **qbt.backtest(run, n=n, setups=setups, min_prob=min_prob, sell_min_prob=sell_min_prob, sizing=sizing,
                           max_shares=max_shares)}


async def intraday_snapshot(symbol: str) -> dict:
    """Today's (latest session's) 5-minute bars, regular hours -> does the day's action support BUY / SELL?"""
    try:
        start, _ = display_window("1D", None, None, now_et())
        df, session, _ = await fetch_frame(symbol, "5Min", start, None, False)
    except ApiError as exc:
        return {"available": False, "reason": exc.message}
    if df.empty:
        return {"available": False, "reason": "No 5-minute bars available."}
    last_session = session.iloc[-1]
    today = df[(session == last_session).to_numpy()]
    before = df[(session < last_session).to_numpy()]
    out = intraday_check(today, float(before["close"].iloc[-1]) if len(before) else None)
    et_last = today.index[-1].tz_convert(ET)
    return {**out, "session": last_session.strftime("%Y-%m-%d"), "asof": et_last.strftime("%Y-%m-%d %H:%M"),
            "interval": "5Min"}


def _num(v, nd: int = 4):
    return None if v is None or not np.isfinite(v) else round(float(v), nd)


def _signals(spec: TargetSpec, cooldown: int, stamps, times, close, atr_v, wf, resolved, outcome,
             w0: int, w1: int, setup: np.ndarray, lv: qb.Levels) -> list[dict]:
    """Bars in [w0, w1) inside a setup (setup[i] != "") where P(success) >= threshold, one per cooldown period."""
    out, last = [], -10**9
    for i in range(w0, w1):
        p, thr = wf.prob[i], wf.threshold[i]
        if not setup[i] or not (np.isfinite(p) and np.isfinite(thr)) or p < thr or i - last <= cooldown:
            continue
        last = i
        r = int(resolved[i])
        out.append({
            "i": i, "time": int(times[i]), "date": stamps[i], "setup": str(setup[i]), "in_range": False,
            "prob": _num(p, 3), "threshold": _num(thr, 3),
            "entry": _num(close[i], 2), "atr": _num(atr_v[i], 2),
            **_level_view(lv, i, close, atr_v),
            "outcome": outcome[i], "resolved_date": stamps[r] if r < len(stamps) else None,
            "days": (r - i) if r < len(stamps) else None,
        })
    return out


def _level_view(lv: qb.Levels, i: int, close, atr_v) -> dict:
    """Target / stop prices at bar i, their distance in ATR and what set them."""
    target, stop = lv.at(i)
    a = atr_v[i]
    return {"target": _num(target, 2), "stop": _num(stop, 2),
            "tp_atr": _num(abs(target - close[i]) / a, 2), "sl_atr": _num(abs(close[i] - stop) / a, 2),
            "target_basis": str(lv.target_basis[i]), "stop_basis": str(lv.stop_basis[i])}


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


def _stats(wf, label, signals, w0: int, w1: int, setup: np.ndarray) -> dict:
    y, p = label[w0:w1], wf.prob[w0:w1]
    in_setup = setup[w0:w1] != ""
    ys = y[in_setup & ~np.isnan(y)]
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
        # Rule only (every bar in the setup, no model): does the model add anything on top of the setup?
        "setup_bars": int(in_setup.sum()), "setup_rate": _num(float(ys.mean()), 3) if len(ys) else None,
        "by_setup": {name: _by_setup([s for s in done if s["setup"] == name])
                     for name in sorted({s["setup"] for s in signals})},
    }


def _train_span(label, resolved, cutoff: int, stamps, session_ord: np.ndarray, days: np.ndarray) -> dict | None:
    """The rows a model trained for `cutoff` learned from (rolling window, outcomes known before cutoff)."""
    idx = np.flatnonzero(qm.train_mask(label, resolved, cutoff, TRAIN_BARS))
    if len(idx) == 0:
        return None
    return {"start": stamps[idx[0]], "end": stamps[idx[-1]], "rows": int(len(idx)),
            "sessions": int(len(np.unique(session_ord[idx]))),
            "days": int((days[idx[-1]] - days[idx[0]]) / np.timedelta64(1, "D"))}


def _training(fitted: dict, stamps, session_ord: np.ndarray, days: np.ndarray, n: int, steps: dict,
              latest_for: dict) -> dict:
    """Actual training dates per target: the first walk-forward model and today's model."""
    out = {}
    for key, (_, _, label, resolved, _, wf, _) in fitted.items():
        first = wf.models[0][0] if wf.models else None
        span = _train_span(label, resolved, first, stamps, session_ord, days) if first is not None else None
        lab_now, res_now, _ = latest_for.get(key, (label, resolved, None))
        out[key] = {
            "folds": wf.folds, "retrain_every": steps[key],
            "first": {**span, "predicts_from": stamps[first]} if span else None,
            "current": _train_span(lab_now, res_now, n, stamps, session_ord, days),
        }
    return out


def _sell_signal(f: tuple, setup: np.ndarray) -> np.ndarray:
    """Out-of-sample signal per bar of a fitted target (model AND setup)."""
    wf = f[5]
    return (np.nan_to_num(wf.prob, nan=-1.0) >= np.nan_to_num(wf.threshold, nan=2.0)) & (setup != "")


def _range_stats(label, signals, r0: int, w1: int, setup: np.ndarray) -> dict:
    """Outcomes for the chart's own range only (what the user is looking at)."""
    y = label[r0:w1]
    known = ~np.isnan(y)
    in_setup = setup[r0:w1] != ""
    ys = y[in_setup & known]
    sig = [s for s in signals if s["in_range"]]
    done = [s for s in sig if s["outcome"] != "pending"]
    hits = sum(s["outcome"] == "target" for s in done)
    return {
        "bars": w1 - r0, "signals": len(sig), "resolved": len(done), "hits": hits,
        "hit_rate": round(hits / len(done), 3) if done else None,
        "base_rate": _num(float(np.nanmean(y)), 3) if known.any() else None, "decided_bars": int(known.sum()),
        "setup_bars": int(in_setup.sum()), "setup_rate": _num(float(ys.mean()), 3) if len(ys) else None,
    }


def _by_setup(done: list[dict]) -> dict:
    hits = sum(s["outcome"] == "target" for s in done)
    return {"resolved": len(done), "hits": hits, "hit_rate": round(hits / len(done), 3) if done else None}


def eval_window(index: pd.DatetimeIndex, session: pd.Series, rng: str, display_start,
                display_end) -> tuple[int, int, int]:
    """(r0, w0, w1): [r0, w1) = the chart's own range; [w0, w1) = that range widened to at least MIN_EVAL_BARS bars
    (enough history to judge the model)."""
    n = len(index)
    if rng in SESSION_RANGES:
        sessions = pd.unique(session.values)
        keep_from = sessions[-SESSION_RANGES[rng]:][0]
        w0 = int(np.argmax(session.values >= keep_from))
    else:
        w0 = int(np.searchsorted(index.values, display_start.tz_convert("UTC").to_datetime64()))
    w1 = n if display_end is None else int(np.searchsorted(index.values, display_end.tz_convert("UTC").to_datetime64()))
    w1 = max(w1, 1)
    r0 = min(max(0, w0), w1 - 1)
    w0 = max(0, min(r0, w1 - MIN_EVAL_BARS))
    return r0, w0, w1


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
    if tf == "1Week":  # 5 sessions = one weekly bar (20 sessions = 4)
        end, complete = bar_horizon(n, max(1, round(spec.horizon / 5)))
        return Horizons(end, complete, 1, "bars", np.arange(n))
    minute = (et_naive.hour * 60 + et_naive.minute).to_numpy()
    end, complete = session_horizon(ordinal, minute, spec.horizon)
    per_hour = max(1, round(60 / TIMEFRAME_MINUTES[tf]))
    return Horizons(end, complete, per_hour, "sessions", ordinal)  # at most one decision per hour


def compute(*args, **kwargs) -> dict:
    """The analysis. Single-threaded in this process: its many small fits / predictions only lose time to thread
    start-up and to fighting for cores; the walk-forward folds run in parallel worker processes (quant/model.py)."""
    with threadpool_limits(limits=1):
        return _compute(*args, **kwargs)


def _compute(symbol: str, df: pd.DataFrame, session: pd.Series, daily: pd.DataFrame, factors: pd.DataFrame, *,
            rng: str, tf: str, intraday: bool, display_start, display_end,
            tp_atr: float = SHORT.target_atr, sl_atr: float = SHORT.stop_atr, bracket: str = "fixed") -> dict:
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

    setups = compute_setups(df)
    buy_names = buy_setup_names(setups)
    setup_of = {"short": buy_names, "accum": buy_names, "tp_short": np.where(setups["top"].to_numpy(), "top", "")}

    r0, w0, w1 = eval_window(df.index, session, rng, display_start, display_end)
    step = max(MIN_RETRAIN_EVERY, math.ceil((w1 - w0) / MAX_FOLDS))
    specs = [dataclasses.replace(s, target_atr=tp_atr, stop_atr=sl_atr, bracket=bracket) if s.key == "short" else s
             for s in TARGETS]

    # 1) labels + walk-forward probabilities for every target. The SELL model first: the sell-signal BUY model learns
    #    from its decisions and the BUY trades exit on them; an optimized BUY bracket last.
    fitted: dict[str, tuple] = {}
    steps: dict[str, int] = {}
    latest_for: dict[str, tuple] = {}   # labels / levels today's model uses when they differ from the composite
    sell_bars: dict[str, np.ndarray] = {}   # SELL decision bars per take-profit target
    proxy_until: dict[str, str | None] = {}  # sell-signal BUY model: setup stood in for SELL in labels until then
    optimization = None
    for spec in sorted(specs, key=lambda sp: (sp.kind == "entry", sp.bracket == "optimal")):
        a = day_atr if spec.atr_basis == "daily" else bar_atr
        hz = _horizons(spec, tf, session, et_naive)
        if spec.label_rule == "next_sell":
            # BUY for the sell-signal strategy: profit at the next SELL decision (quant/accum.py)
            p_sell = fitted[spec.exit_with][5].prob
            active_from = int(np.argmax(np.isfinite(p_sell))) if np.isfinite(p_sell).any() else n
            # before the SELL model's first decision, its interim-top setup stands in for SELL (labels only)
            label_sell = qa.label_sells(sell_bars[spec.exit_with], setup_of[spec.exit_with] != "",
                                        fitted[spec.exit_with][1].cooldown, active_from)
            label, resolved, outcome = qa.next_sell_labels(close, label_sell, 0)
            proxy_until[spec.key] = stamps[active_from] if 0 < active_from < n else None
            wf = qm.walk_forward(X, label, resolved, start=w0, window=TRAIN_BARS, step=step, kind=spec.model,
                                 keep=True)
            fitted[spec.key] = (a, hz, label, resolved, outcome, wf, qa.no_levels(n))
            steps[spec.key] = step
            continue
        if spec.bracket == "optimal":
            # quant/optimize.py: one walk-forward retrain per profit-take x stop-loss combination; each block uses
            # the combination with the best profit over the trades closed before it.
            tps = _sell_signal(fitted[spec.exit_with], setup_of[spec.exit_with])
            opt = qo.optimize(X, open_, high, low, close, a, spec, hz, setup_of[spec.key], tps, w0=w0,
                              window=TRAIN_BARS, min_step=MIN_RETRAIN_EVERY, stamps=stamps)
            fitted[spec.key] = (a, hz, opt["label"], opt["resolved"], opt["outcome"], opt["wf"], opt["lv"])
            cur = opt["current"]
            latest_for[spec.key] = (cur.label, cur.resolved, cur.lv)
            steps[spec.key] = opt["step"]
            optimization = opt["info"]
            continue
        lv = qb.fixed_levels(close, a, spec.target_atr, spec.stop_atr, spec.sign)
        label, resolved, outcome = triple_barrier(high, low, close, a, spec, hz.end, hz.complete,
                                                  levels=(lv.target, lv.stop))
        start, pre = w0, None
        if spec.kind == "take_profit" and any(sp.label_rule == "next_sell" and sp.exit_with == spec.key for sp in specs):
            # The sell-signal BUY model learns from these SELL decisions over its own training window, so this
            # walk-forward also covers TRAIN_BARS before the window, retrained 3x less often there (the window's
            # folds - and its decisions - stay the same).
            pre = 3 * step
            start = w0 - min(math.ceil(TRAIN_BARS / pre), w0 // pre) * pre
        wf = qm.walk_forward(X, label, resolved, start=w0, window=TRAIN_BARS, step=step, kind=spec.model, keep=True,
                             pre_start=start if pre else None, pre_step=pre)
        fitted[spec.key] = (a, hz, label, resolved, outcome, wf, lv)
        steps[spec.key] = step
        if spec.kind == "take_profit":   # its decisions (same rule as the analysis), before / in / after the window
            sell_bars[spec.key] = np.array(
                [i for lo_, hi_ in ((start, w0), (w0, w1), (w1, n))
                 for i in qo.signal_bars(wf.prob, wf.threshold, setup_of[spec.key], lo_, hi_, hz.cooldown)],
                dtype=np.int64)
    if optimization:  # the BUY spec shows the combination in use now
        specs = [dataclasses.replace(sp, target_atr=optimization["current"]["tp"],
                                     stop_atr=optimization["current"]["sl"]) if sp.bracket == "optimal" else sp
                 for sp in specs]
    # Out-of-sample SELL signal per bar (model AND interim-top setup); closes BUY trades that are in profit.
    tp_signal = {k: _sell_signal(f, setup_of[k]) for k, f in fitted.items()}

    targets = {}
    now_models: dict[str, qp.Side] = {}
    k_m = min(MOMENTUM_BARS, n)
    for spec in specs:
        a, hz, label, resolved, outcome, wf, lv = fitted[spec.key]
        signals = _signals(spec, hz.cooldown, stamps, times, close, a, wf, resolved, outcome, w0, w1,
                           setup_of[spec.key], lv)
        for sgl in signals:
            sgl["in_range"] = sgl["i"] >= r0
            # what supported the decision (expanded row in the UI)
            sgl["why"] = qe.explain_decision(wf, sgl["i"], X, names, qf.GROUPS, setups,
                                             ("rebound", "trend") if spec.kind == "entry" else ("top",),
                                             BAR_WORD.get(tf, "bar"))

        def left(i: int) -> int | None:
            if hz.unit == "sessions":
                return int(max(0, hz.session_ord[i] + spec.horizon - hz.session_ord[-1]))
            return int(max(0, i + spec.horizon - (n - 1)))

        trades = None
        if spec.kind == "entry" and spec.label_rule == "next_sell":
            # sell-signal strategy: each BUY is held until the next SELL decision (no profit-take / stop-loss)
            sb = sell_bars[spec.exit_with]
            sims = []
            for sgl in signals:
                t = qa.trade(sgl["i"], close, a[sgl["i"]], sb)
                sgl["trade"] = _trade_view(t, stamps, times, None, hz.unit)
                sims.append(t)
            every_idx = [i for i in range(w0, min(w1, n - 1)) if np.isfinite(a[i]) and a[i] > 0]
            every = [qa.trade(i, close, a[i], sb) for i in every_idx]
        elif spec.kind == "entry":
            tps = tp_signal[spec.exit_with] if spec.exit_with else None
            sims = []
            for sgl in signals:
                i = sgl["i"]
                t = simulate(i, open_, high, low, close, a[i], spec, tps, int(hz.end[i]), bool(hz.complete[i]),
                             lv.at(i))
                sgl["trade"] = _trade_view(t, stamps, times, left(i), hz.unit)
                sims.append(t)
                # For the $100 simulation: the first profit-take / stop-loss hit, or the close at the end of the
                # holding window (time limit); None while still open.
                h = simulate(i, open_, high, low, close, a[i], spec, None, int(hz.end[i]), bool(hz.complete[i]),
                             lv.at(i))
                sgl["_exit"] = ({"i": h["exit_index"], "time": int(times[h["exit_index"]]),
                                 "date": stamps[h["exit_index"]], "price": h["price"], "reason": h["reason"]}
                                if h["status"] == "closed" else None)
            # Baseline: the same exit rules applied to an entry on EVERY bar of the window.
            every_idx = [i for i in range(w0, min(w1, n - 1)) if np.isfinite(a[i]) and a[i] > 0]
            every = [simulate(i, open_, high, low, close, a[i], spec, tps, int(hz.end[i]), bool(hz.complete[i]),
                              lv.at(i)) for i in every_idx]
        if spec.kind == "entry":
            trades = {
                "signals": summarize(sims),
                "every_day": summarize(every),
                "buy_hold_pct": _num((close[w1 - 1] / close[w0] - 1) * 100, 2),
                # The chart's own range
                "range_signals": summarize([t for t, sg in zip(sims, signals) if sg["in_range"]]),
                "range_every_day": summarize([t for t, i in zip(every, every_idx) if i >= r0]),
                "range_buy_hold_pct": _num((close[w1 - 1] / close[r0] - 1) * 100, 2),
                "rules": {"stop_atr": spec.stop_atr, "target_atr": spec.target_atr,
                          "trail_after_atr": spec.trail_after_atr, "trail_atr": spec.trail_atr,
                          "horizon": spec.horizon, "horizon_mode": spec.horizon_mode, "atr_basis": spec.atr_basis,
                          "exit_with": spec.exit_with, "bracket": spec.bracket, "label_rule": spec.label_rule},
            }
            if spec.bracket == "optimal" and optimization is not None:
                # the walk-forward optimized strategy itself, over the same window as the grid
                rets = [t["return_pct"] * 100 for t in sims if t["status"] == "closed"]
                optimization["strategy"] = {
                    "trades": len(rets), "total_return_pct": round(sum(rets), 2),
                    "avg_return_pct": round(sum(rets) / len(rets), 2) if rets else None,
                    "win_rate": round(sum(r > 0 for r in rets) / len(rets), 3) if rets else None,
                }

        # today's model: the composite's labels, or (optimized) the labels of the combination in use now
        lab_now, res_now, lv_now = latest_for.get(spec.key, (label, resolved, lv))
        latest, base_now = qm.fit_latest(X, lab_now, res_now, TRAIN_BARS, kind=spec.model)
        current = None
        now_models[spec.key] = qp.Side(None, float("nan"))
        if latest is not None and np.isfinite(a[-1]):
            p_now = float(latest.predict_proba(X[-1:])[0, 1])
            thr_now = qm.threshold_for(base_now)
            now_models[spec.key] = qp.Side(latest, thr_now)
            setup_now = str(setup_of[spec.key][-1])
            ml = bool(p_now >= thr_now)
            current = {
                "date": stamps[-1], "time": int(times[-1]),
                "prob": _num(p_now, 3), "threshold": _num(thr_now, 3), "base_rate": _num(base_now, 3),
                "ml_signal": ml,                       # model alone
                "setup": setup_now,                    # "rebound" / "trend" / "top" / ""
                "signal": bool(ml and setup_now),      # BUY / SELL = model AND setup
                "entry": _num(close[-1], 2), "atr": _num(a[-1], 2),
                **_level_view(lv_now, n - 1, close, a),
                "chase_limit": _num(close[-1] + CHASE_ATR * a[-1], 2) if spec.kind == "entry" else None,
                "horizon_days": spec.horizon,
                # momentum: today's model on the last K lines (same model, so the change is the K lines', not a
                # retrain's) - is P moving toward or away from the threshold?
                "recent": [{"date": stamps[i], "prob": _num(float(pr), 3), "setup": str(setup_of[spec.key][i]),
                            "signal": bool(setup_of[spec.key][i]) and bool(pr >= thr_now)}
                           for i, pr in zip(range(n - k_m, n), latest.predict_proba(X[n - k_m:])[:, 1])],
            }
        open_trade = next((s for s in reversed(signals) if s.get("trade", {}).get("status") == "open"), None)
        targets[spec.key] = {
            "spec": spec.to_dict(),
            "proxy_until": proxy_until.get(spec.key),
            "current": current,
            "signals": signals,
            "stats": _stats(wf, label, signals, w0, w1, setup_of[spec.key]),
            "range_stats": _range_stats(label, signals, r0, w1, setup_of[spec.key]),
            "trades": trades,
            "open_trade": open_trade,
            "importance": qm.group_importance(X, lab_now, res_now, TRAIN_BARS, min(IMPORTANCE_BARS, w1 - w0),
                                              names, qf.GROUPS, kind=spec.model),
        }

    # $100 per BUY (every BUY adds a lot), the next SELL sells everything (or each lot at its own profit-take /
    # stop-loss), over the 30 most recent BUYs - quant/portfolio.py.
    def event(s: dict) -> dict:
        return {"i": s["i"], "time": s["time"], "date": s["date"], "price": s["entry"], "setup": s["setup"],
                "exit": s.get("_exit")}
    simulation = portfolio.simulate_decisions(
        {"sell_only": [event(s) for s in targets["accum"]["signals"]],
         "with_bracket": [event(s) for s in targets["short"]["signals"]]},
        [event(s) for s in targets["tp_short"]["signals"]],
        {"i": n - 1, "time": int(times[-1]), "date": stamps[-1], "price": float(close[-1])})
    # Backtests page: every BUY-setup bar of the model-check window with its out-of-sample P, the model's own
    # threshold there and the first profit-take / stop-loss / time-limit exit; every interim-top bar with the SELL
    # model's P and threshold; the last bar and where the current year starts.
    a_b, hz_b, wf_b, lv_b = fitted["short"][0], fitted["short"][1], fitted["short"][5], fitted["short"][6]
    spec_b = next(sp for sp in specs if sp.key == "short")
    candidates = []
    for i in range(w0, w1):
        p_i = wf_b.prob[i]
        if not buy_names[i] or not np.isfinite(p_i) or not np.isfinite(a_b[i]) or a_b[i] <= 0:
            continue
        h = simulate(i, open_, high, low, close, a_b[i], spec_b, None, int(hz_b.end[i]), bool(hz_b.complete[i]),
                     lv_b.at(i))
        candidates.append({
            "i": i, "time": int(times[i]), "date": stamps[i], "price": float(close[i]), "setup": str(buy_names[i]),
            "prob": float(p_i), "threshold": float(wf_b.threshold[i]),
            "exit": ({"i": h["exit_index"], "time": int(times[h["exit_index"]]), "date": stamps[h["exit_index"]],
                      "price": h["price"], "reason": h["reason"]} if h["status"] == "closed" else None),
        })
    wf_a = fitted["accum"][5]
    accum_candidates = [
        {"i": i, "time": int(times[i]), "date": stamps[i], "price": float(close[i]), "setup": str(buy_names[i]),
         "prob": float(wf_a.prob[i]), "threshold": float(wf_a.threshold[i]), "exit": None}
        for i in range(w0, w1)
        if buy_names[i] and np.isfinite(wf_a.prob[i]) and np.isfinite(wf_a.threshold[i])
    ]
    wf_s, hz_s = fitted["tp_short"][5], fitted["tp_short"][1]
    sell_candidates = [
        {"i": i, "time": int(times[i]), "date": stamps[i], "price": float(close[i]),
         "prob": float(wf_s.prob[i]), "threshold": float(wf_s.threshold[i])}
        for i in range(w0, w1)
        if setup_of["tp_short"][i] and np.isfinite(wf_s.prob[i]) and np.isfinite(wf_s.threshold[i])
    ]
    year = int(et_naive[-1].year)
    ys = int(np.argmax(et_naive.year == year))
    # weekly DCA baseline: the first bar of every week (Monday-based, ET) from the model-check window on
    monday = (et_naive.normalize() - pd.to_timedelta(et_naive.weekday, unit="D")).to_numpy()
    weekly = [{"i": i, "time": int(times[i]), "date": stamps[i], "price": float(close[i])}
              for i in range(w0, n) if i == 0 or monday[i] != monday[i - 1]]
    backtest_run = {
        "weekly": weekly,
        "candidates": candidates, "cooldown": int(hz_b.cooldown), "accum_candidates": accum_candidates,
        "sell_candidates": sell_candidates, "sell_cooldown": int(hz_s.cooldown),
        "last": {"i": n - 1, "time": int(times[-1]), "date": stamps[-1], "price": float(close[-1])},
        "year_start": {"i": ys, "date": f"{year}-01-01", "prev_close": float(close[ys - 1]) if ys > 0 else None},
        "bar_unit": BAR_UNIT[tf], "window": {"start": stamps[w0], "end": stamps[w1 - 1], "bars": w1 - w0},
    }
    for t in targets.values():
        for sgl in t["signals"]:
            sgl.pop("i")
            sgl.pop("_exit", None)

    # Projected BUY entry / SELL price: at which close would the current K line become a BUY or a SELL?
    a_buy = fitted["short"][0]
    tp_spec = next(sp for sp in specs if sp.key == "tp_short")
    a_sell = fitted["tp_short"][0]

    def buy_levels(b: pd.DataFrame, setup: str) -> dict:
        m = len(b)
        c_ = b["close"].to_numpy(dtype=float)
        a_t = a_buy[-m:]
        tp_use, sl_use = ((optimization["current"]["tp"], optimization["current"]["sl"]) if optimization
                          else (tp_atr, sl_atr))
        lvx = qb.fixed_levels(c_, a_t, tp_use, sl_use)
        if optimization:
            lvx.target_basis[:] = qo.BASIS
            lvx.stop_basis[:] = qo.BASIS
        return _level_view(lvx, m - 1, c_, a_t)

    def sell_levels(price: float) -> dict:
        return {"target": _num(price - tp_spec.target_atr * a_sell[-1], 2),
                "stop": _num(price + tp_spec.stop_atr * a_sell[-1], 2)}

    def signal_now(key: str) -> bool:
        return bool((targets[key]["current"] or {}).get("signal"))

    proj = qp.project(
        df, daily["close"], factors, bar_dates, mode, float(a_buy[-1]), now_models["short"], now_models["tp_short"],
        {"buy": signal_now("short"), "sell": signal_now("tp_short")}, buy_levels, sell_levels)

    rel_start = daily.index[-1] - pd.DateOffset(years=RELATION_YEARS)
    session_ord = pd.factorize(session.to_numpy())[0]
    training = {
        "trained_at": now_et().strftime("%Y-%m-%d %H:%M ET"),
        "train_bars": TRAIN_BARS, "min_train": qm.MIN_TRAIN,
        "data": {"start": stamps[0], "end": stamps[-1], "bars": n},
        "daily": {"start": daily.index[0].strftime("%Y-%m-%d"), "end": daily.index[-1].strftime("%Y-%m-%d"),
                  "bars": len(daily)},
        "factors": {"start": factors.index[0].strftime("%Y-%m-%d"), "end": factors.index[-1].strftime("%Y-%m-%d")},
        "targets": _training(fitted, stamps, session_ord, bar_dates.to_numpy(), n, steps, latest_for),
    }
    return {
        "_backtest": backtest_run,   # kept on the server for the Backtests page (run_analysis stores it)
        "training": training,
        "symbol": symbol,
        "range": rng,
        "timeframe": tf,
        "intraday": intraday,
        "bar_unit": BAR_UNIT[tf],
        "asof": stamps[-1],
        "params": {"tp_atr": tp_atr, "sl_atr": sl_atr, "tp_range": TP_RANGE, "sl_range": SL_RANGE,
                   "bracket": bracket, "optimization": optimization},
        "simulation": simulation,
        "projection": proj,
        "range_window": {"start": stamps[r0], "end": stamps[w1 - 1], "bars": w1 - r0, "start_time": int(times[r0])},
        "window": {"start": stamps[w0], "end": stamps[w1 - 1], "bars": w1 - w0, "start_time": int(times[w0]),
                   "train_bars": TRAIN_BARS, "retrain_every": step, "years": RELATION_YEARS},
        "method": {
            "model": "Gradient-boosted trees (scikit-learn HistGradientBoostingClassifier)",
            "training": f"Rolling window of the {TRAIN_BARS:,} {BAR_UNIT[tf]} before each prediction, retrained "
                        f"every {step} bars on outcomes already known at that time (walk-forward, out-of-sample).",
            "signal_rule": f"BUY: the bar is in a rebound or trend setup AND P(success) >= training base rate + "
                           f"{int(qm.SIGNAL_EDGE * 100)} pts (bounded {qm.THRESHOLD_BOUNDS[0]:.2f}-"
                           f"{qm.THRESHOLD_BOUNDS[1]:.2f}); SELL: interim-top setup AND the take-profit model agrees; "
                           "one per cooldown period (5 bars on Daily, one hour intraday).",
            "features": len(names),
            "atr": "daily ATR(14) known at each bar (previous day's on intraday bars)",
            "factor_alignment": {"same": "same-day factor values (known at the daily close)",
                                 "week_end": "factor values at the end of each week",
                                 "previous": "previous day's factor values (today's are not known intraday)"}[mode],
        },
        "sources": {"stock": "Alpaca bars", "factors": "Yahoo Finance",
                    "factor_tickers": {k: t for k, (t, _) in yahoo.FACTORS.items()}},
        "targets": targets,
        "setups_now": explain(setups, n - 1),
        # price momentum of the last K lines (RSI, MACD histogram in ATR) for the momentum panel
        "k_momentum": [{"date": stamps[i], "close": _num(close[i], 2),
                        "rsi": _num(X[i, names.index("rsi_14")], 1) if "rsi_14" in names else None,
                        "macd_hist_atr": _num(X[i, names.index("macd_hist_atr")], 3) if "macd_hist_atr" in names else None}
                       for i in range(n - k_m, n)],   # which setup conditions hold on the current K line
        "chase_atr": CHASE_ATR,
        "relations": factor_relations(daily["close"], factors, rel_start),
    }
