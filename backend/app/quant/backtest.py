"""Backtest scenarios on top of one training run (the Backtests page).

The analysis keeps, for its model-check window, every bar that was in a BUY setup with the out-of-sample probability
each BUY model gave it and that model's own threshold there - the profit-take / stop-loss BUY model ("candidates",
with each bar's first profit-take / stop-loss / time-limit exit) and the sell-signal BUY model ("accum_candidates")
- and every interim-top bar with the SELL model's probability and threshold. Per strategy:

  sell-signal strategy ("sell_only")       BUYs from the sell-signal BUY model; every BUY adds a lot; the next SELL
                                           sells everything
  profit-take / stop-loss ("with_bracket") BUYs from the profit-take / stop-loss BUY model; each lot also sold at its
                                           own profit-take / stop-loss / time limit if that comes before the next SELL

  BUY   setup in the chosen setups (rebound / trend / both) AND P >= threshold, one per cooldown, most recent N
  SELL  interim-top setup AND P >= threshold, one per cooldown

threshold = the model's own (training base rate + 10 pts, per retrain) unless the user sets a number - so by default
the backtest uses exactly the decisions shown in the analysis.
"""
from __future__ import annotations

from . import portfolio

MAX_DECISIONS = 100
SETUP_CHOICES = {"rebound": ("rebound",), "trend": ("trend",), "both": ("rebound", "trend")}
VARIANTS = {"sell_only": ("accum_candidates", False), "with_bracket": ("candidates", True)}


def _passes(c: dict, min_prob: float | None) -> bool:
    return c["prob"] >= (c["threshold"] if min_prob is None else min_prob)


def select(candidates: list[dict], setups: tuple[str, ...], min_prob: float | None, cooldown: int,
           n: int) -> list[dict]:
    """BUY decisions under the rules (chronological), the most recent n. min_prob None = the model's threshold."""
    out, last = [], -10**9
    for c in candidates:
        if c["setup"] not in setups or not _passes(c, min_prob) or c["i"] - last <= cooldown:
            continue
        last = c["i"]
        out.append(c)
    return out[-n:]


def select_sells(candidates: list[dict], min_prob: float | None, cooldown: int) -> list[dict]:
    """SELL decisions over the whole window (chronological). min_prob None = the model's threshold."""
    out, last = [], -10**9
    for c in candidates:
        if not _passes(c, min_prob) or c["i"] - last <= cooldown:
            continue
        last = c["i"]
        out.append(c)
    return out


def _scenario(run: dict, cands: list[dict], setups: tuple[str, ...], min_prob: float | None, sells_all: list[dict],
              n: int, sizing: str, use_bracket: bool) -> dict | None:
    buys = select(cands, setups, min_prob, run["cooldown"], n)
    if not buys:
        return None
    sc = portfolio._variant(buys, sells_all, run["last"], use_bracket, sizing, run.get("year_start"), limit=None)
    return {**sc, "decisions": len(buys), "end_date": run["last"]["date"],
            "probs": [round(b["prob"], 3) for b in buys]}


def _range(values: list[float]) -> list[float] | None:
    return [round(min(values), 3), round(max(values), 3)] if values else None


def backtest(run: dict, n: int = 30, setups: str = "both", min_prob: float | None = None,
             sell_min_prob: float | None = None, sizing: str = "usd") -> dict:
    """Per strategy: the chosen scenario in full + a rebound / trend / both comparison (same N, thresholds, sizing)."""
    chosen = SETUP_CHOICES[setups]
    sells_all = select_sells(run["sell_candidates"], sell_min_prob, run["sell_cooldown"])
    variants = {}
    for v, (key, use_bracket) in VARIANTS.items():
        cands = run[key]
        result = _scenario(run, cands, chosen, min_prob, sells_all, n, sizing, use_bracket)
        compare = []
        for name, sel in SETUP_CHOICES.items():
            sc = result if name == setups else _scenario(run, cands, sel, min_prob, sells_all, n, sizing, use_bracket)
            compare.append({"setups": name, "decisions": sc["decisions"] if sc else 0,
                            "summary": sc["summary"] if sc else None})
        variants[v] = {
            "pool": {name: {"setup_bars": sum(c["setup"] in sel for c in cands),
                            "qualified": len(select(cands, sel, min_prob, run["cooldown"], MAX_DECISIONS * 1000)),
                            "max_prob": round(max((c["prob"] for c in cands if c["setup"] in sel), default=0.0), 3)}
                     for name, sel in SETUP_CHOICES.items()},
            "model_thresholds": _range([c["threshold"] for c in cands if c["setup"] in chosen]),
            "result": result,
            "compare": compare,
        }
    return {
        "params": {"n": n, "setups": setups, "min_prob": min_prob, "sell_min_prob": sell_min_prob, "sizing": sizing},
        "variants": variants,
        "sell_model_thresholds": _range([c["threshold"] for c in run["sell_candidates"]]),
        "sell_decisions": len(sells_all),
        "year_start": run.get("year_start"),
    }
