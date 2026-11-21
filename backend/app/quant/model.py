"""Walk-forward gradient-boosting classifier: every prediction comes from a model trained only on outcomes that
were already known on the prediction date, using a rolling window of the preceding years of daily bars."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

MIN_TRAIN = 250          # labelled rows needed before a fold is trained
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


def walk_forward(X: np.ndarray, y: np.ndarray, resolved_at: np.ndarray, start: int, window: int, step: int,
                 kind: str = "hgb", keep: bool = False) -> WalkForward:
    n = len(y)
    prob = np.full(n, np.nan)
    base = np.full(n, np.nan)
    folds = 0
    kept: list = []
    for s in range(start, n, step):
        e = min(s + step, n)
        m = train_mask(y, resolved_at, s, window)
        yt = y[m]
        if m.sum() < MIN_TRAIN or yt.min() == yt.max():
            continue
        model = make_model(kind).fit(X[m], yt)
        prob[s:e] = model.predict_proba(X[s:e])[:, 1]
        base[s:e] = yt.mean()
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
    on them, summed per feature group and normalised to percentages."""
    n = len(y)
    cut = n - eval_bars
    m = train_mask(y, resolved_at, cut, window)
    ev = np.arange(n) >= cut
    ev &= ~np.isnan(y)
    if m.sum() < MIN_TRAIN or ev.sum() < 30 or len(np.unique(y[m])) < 2 or len(np.unique(y[ev])) < 2:
        return []
    model = make_model(kind).fit(X[m], y[m])
    res = permutation_importance(model, X[ev], y[ev], scoring="roc_auc", n_repeats=5, random_state=0)
    totals: dict[str, float] = {}
    for name, val in zip(names, res.importances_mean):
        totals[groups.get(name, "Other")] = totals.get(groups.get(name, "Other"), 0.0) + max(0.0, float(val))
    s = sum(totals.values())
    if s <= 0:
        return []
    return sorted(({"group": g, "weight": round(100 * v / s, 1)} for g, v in totals.items()), key=lambda r: -r["weight"])
