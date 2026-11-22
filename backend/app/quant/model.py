"""Walk-forward gradient-boosting classifier: every prediction comes from a model trained only on outcomes that
were already known on the prediction date, using a rolling window of the preceding years of daily bars.

Speed: the folds of a walk-forward are independent, so they are fitted in parallel worker processes (joblib), each
single-threaded - small fits do not scale across threads, and threads fight for the cores when the machine is busy.
Results are identical to fitting them one after another."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from joblib import Parallel, delayed
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from threadpoolctl import threadpool_limits

MIN_TRAIN = 250          # labelled rows needed before a fold is trained
N_JOBS = -1              # worker processes for walk-forward folds (-1 = one per CPU core)
PARALLEL_MIN_FOLDS = 4   # fewer folds than this are fitted in-process (not worth starting workers)
SIGNAL_EDGE = 0.10       # mark a signal when P(success) >= base rate + this (the setup rules already filter) ...
THRESHOLD_BOUNDS = (0.30, 0.85)  # ... clipped to these bounds
RELIABLE_AUC = 0.53      # out-of-sample AUC needed (with hit rate above base rate) to call a target reliable


def make_model(kind: str = "hgb"):
    if kind == "logistic":
        # Strongly regularised linear model on standardised features (missing values -> median).
        return make_pipeline(SimpleImputer(strategy="median"), StandardScaler(),
                             LogisticRegression(C=0.1, max_iter=500))
    # Small, regularised trees: ~1,200 rows per fit, noisy target.
    return HistGradientBoostingClassifier(
        max_iter=150, learning_rate=0.05, max_depth=3, min_samples_leaf=40,
        l2_regularization=1.0, random_state=0,
    )


def reliability(auc, hit_rate, base_rate) -> tuple[bool, str]:
    """Did the walk-forward record show a usable edge for this symbol?"""
    if auc is None:
        return False, "Not enough resolved history to evaluate."
    if auc < 0.47:
        return False, (f"No reliable edge: out-of-sample AUC {auc:.2f} is below chance (0.50) - "
                       "its signals did worse than random here.")
    if auc < RELIABLE_AUC:
        return False, f"No reliable edge: out-of-sample AUC {auc:.2f} is close to chance (0.50)."
    if hit_rate is not None and base_rate is not None and hit_rate <= base_rate:
        return False, (f"No reliable edge: marked entries hit {hit_rate:.0%}, "
                       f"no better than the {base_rate:.0%} base rate.")
    tail = (f", marked entries hit {hit_rate:.0%} vs {base_rate:.0%} base rate."
            if hit_rate is not None and base_rate is not None else ".")
    return True, f"Edge found: out-of-sample AUC {auc:.2f}" + tail


def threshold_for(base_rate: float) -> float:
    lo, hi = THRESHOLD_BOUNDS
    return float(np.clip(base_rate + SIGNAL_EDGE, lo, hi))


@dataclass
class WalkForward:
    prob: np.ndarray        # out-of-sample P(success) per bar (NaN where no model was available)
    base: np.ndarray        # training base rate of the model that produced each prediction
    threshold: np.ndarray   # signal threshold per bar
    folds: int
    # keep=True: (start, end, model, training medians per feature) for every fold - to explain single decisions
    models: list = field(default_factory=list)

    def fold_at(self, i: int):
        """The fold whose model predicted bar i (None if not kept / no model)."""
        return next((f for f in self.models if f[0] <= i < f[1]), None)


def train_mask(y: np.ndarray, resolved_at: np.ndarray, cutoff: int, window: int) -> np.ndarray:
    """Rows usable for a model that predicts from bar `cutoff` on: label known strictly before `cutoff`,
    and the row lies inside the rolling training window."""
    idx = np.arange(len(y))
    return ~np.isnan(y) & (resolved_at < cutoff) & (idx >= cutoff - window) & (idx < cutoff)


def _fit_fold(kind: str, X: np.ndarray, y: np.ndarray, m: np.ndarray, s: int, e: int):
    """One fold (runs in a worker process): fit on the rows in mask m, predict bars [s, e)."""
    with threadpool_limits(limits=1):
        model = make_model(kind).fit(X[m], y[m])
        return model, model.predict_proba(X[s:e])[:, 1]


def walk_forward(X: np.ndarray, y: np.ndarray, resolved_at: np.ndarray, start: int, window: int, step: int,
                 kind: str = "hgb", keep: bool = False, pre_start: int | None = None,
                 pre_step: int | None = None) -> WalkForward:
    """pre_start / pre_step: extra, sparser folds from pre_start up to `start` (history some other model needs);
    the folds from `start` on are unchanged by them."""
    n = len(y)
    prob = np.full(n, np.nan)
    base = np.full(n, np.nan)
    folds = 0
    kept: list = []
    bounds = []
    if pre_start is not None and pre_step:
        bounds += [(s, min(s + pre_step, start)) for s in range(pre_start, start, pre_step)]
    bounds += [(s, min(s + step, n)) for s in range(start, n, step)]
    jobs = []
    for s, e in bounds:
        m = train_mask(y, resolved_at, s, window)
        yt = y[m]
        if m.sum() < MIN_TRAIN or yt.min() == yt.max():
            continue
        jobs.append((s, e, m))
    if len(jobs) >= PARALLEL_MIN_FOLDS:
        fitted = Parallel(n_jobs=N_JOBS)(delayed(_fit_fold)(kind, X, y, m, s, e) for s, e, m in jobs)
    else:
        fitted = [_fit_fold(kind, X, y, m, s, e) for s, e, m in jobs]
    for (s, e, m), (model, p) in zip(jobs, fitted):
        prob[s:e] = p
        base[s:e] = y[m].mean()
        folds += 1
        if keep:
            with np.errstate(all="ignore"):
                kept.append((s, e, model, np.nanmedian(X[m], axis=0)))
    thr = np.array([threshold_for(b) if np.isfinite(b) else np.nan for b in base])
    return WalkForward(prob, base, thr, folds, kept)


def fit_latest(X: np.ndarray, y: np.ndarray, resolved_at: np.ndarray, window: int, kind: str = "hgb"):
    """Model trained on everything known today (rolling window); None if too little data."""
    n = len(y)
    m = train_mask(y, resolved_at, n, window)
    yt = y[m]
    if m.sum() < MIN_TRAIN or yt.min() == yt.max():
        return None, float("nan")
    return make_model(kind).fit(X[m], yt), float(yt.mean())


def group_importance(X, y, resolved_at, window: int, eval_bars: int, names: list[str], groups: dict[str, str],
                     kind: str = "hgb"):
    """Permutation importance (ROC-AUC drop) of a model trained before the last `eval_bars` bars and evaluated
    on them, per feature GROUP (all of a group's features shuffled together), normalised to percentages."""
    n = len(y)
    cut = n - eval_bars
    m = train_mask(y, resolved_at, cut, window)
    ev = np.arange(n) >= cut
    ev &= ~np.isnan(y)
    if m.sum() < MIN_TRAIN or ev.sum() < 30 or len(np.unique(y[m])) < 2 or len(np.unique(y[ev])) < 2:
        return []
    model = make_model(kind).fit(X[m], y[m])
    Xe, ye = X[ev], y[ev]
    base_auc = roc_auc_score(ye, model.predict_proba(Xe)[:, 1])
    order = list(dict.fromkeys(groups.get(nm, "Other") for nm in names))
    rng = np.random.default_rng(0)
    totals: dict[str, float] = {}
    for g in order:
        cols = [j for j, nm in enumerate(names) if groups.get(nm, "Other") == g]
        drops = []
        for _ in range(5):
            Xp = Xe.copy()
            Xp[:, cols] = Xe[rng.permutation(len(Xe))][:, cols]   # shuffle the group's rows together
            drops.append(base_auc - roc_auc_score(ye, model.predict_proba(Xp)[:, 1]))
        totals[g] = max(0.0, float(np.mean(drops)))
    s = sum(totals.values())
    if s <= 0:
        return []
    return sorted(({"group": g, "weight": round(100 * v / s, 1)} for g, v in totals.items()), key=lambda r: -r["weight"])
