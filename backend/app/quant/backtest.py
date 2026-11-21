"""Backtest scenarios on top of one training run (the Backtests page).

The analysis keeps, for its model-check window, every bar that was in a BUY setup with the out-of-sample probability
the walk-forward model gave it, the model's own threshold there, and the first profit-take / stop-loss / time-limit
exit after it - and every interim-top bar with the SELL model's probability and threshold. A backtest chooses:

  BUY   setup in the chosen setups (rebound / trend / both) AND P >= threshold, at most one per cooldown,
        the most recent N (1-100, default 30)
  SELL  interim-top setup AND P >= threshold, at most one per cooldown (the next SELL sells everything held)

threshold = the model's own (training base rate + 10 pts, per retrain) unless the user sets a number - so by
default the backtest uses exactly the decisions shown in the analysis. Then it simulates them with
quant/portfolio.py (a lot of $100 or 1 share per BUY; sell everything at the next SELL, or each lot earlier at its
profit-take / stop-loss / time limit).
"""
from __future__ import annotations

from . import portfolio

MAX_DECISIONS = 100
SETUP_CHOICES = {"rebound": ("rebound",), "trend": ("trend",), "both": ("rebound", "trend")}


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


def _scenario(run: dict, setups: tuple[str, ...], min_prob: float | None, sells_all: list[dict], n: int,
              sizing: str) -> dict | None:
    buys = select(run["candidates"], setups, min_prob, run["cooldown"], n)
    if not buys:
        return None
    start = buys[0]["i"]
    sells = [s for s in sells_all if s["i"] >= start]
    last = run["last"]
    q0 = portfolio.STAKE / buys[0]["price"] if sizing == "usd" else 1.0
    cost_all = sum((portfolio.STAKE if sizing == "usd" else b["price"]) for b in buys)
    never = sum((portfolio.STAKE / b["price"] if sizing == "usd" else 1.0) * (last["price"] - b["price"]) for b in buys)
    out = {
        "decisions": len(buys), "start_date": buys[0]["date"], "end_date": last["date"], "sells": len(sells),
        "hold_all": {"pnl": round(never, 2), "pnl_pct": round(never / cost_all * 100, 2)},
        "buy_hold": {"pnl": round(q0 * (last["price"] - buys[0]["price"]), 2),
                     "pnl_pct": round((last["price"] / buys[0]["price"] - 1) * 100, 2)},
        "probs": [round(b["prob"], 3) for b in buys],
    }
    for variant, use_bracket in (("sell_only", False), ("with_bracket", True)):
        out[variant] = portfolio.run(buys, sells, last, use_bracket, sizing, run.get("year_start"))
    return out


def _range(values: list[float]) -> list[float] | None:
    return [round(min(values), 3), round(max(values), 3)] if values else None


def backtest(run: dict, n: int = 30, setups: str = "both", min_prob: float | None = None,
             sell_min_prob: float | None = None, sizing: str = "usd") -> dict:
    """The chosen scenario in full + a comparison of rebound / trend / both with the same N, thresholds and sizing."""
    chosen = SETUP_CHOICES[setups]
    cands = run["candidates"]
    sells_all = select_sells(run["sell_candidates"], sell_min_prob, run["sell_cooldown"])
    pool = {name: {"setup_bars": sum(c["setup"] in sel for c in cands),
                   "qualified": len(select(cands, sel, min_prob, run["cooldown"], MAX_DECISIONS * 1000)),
                   "max_prob": round(max((c["prob"] for c in cands if c["setup"] in sel), default=0.0), 3)}
            for name, sel in SETUP_CHOICES.items()}
    result = _scenario(run, chosen, min_prob, sells_all, n, sizing)
    compare = []
    for name, sel in SETUP_CHOICES.items():
        sc = result if name == setups else _scenario(run, sel, min_prob, sells_all, n, sizing)
        compare.append({"setups": name, "decisions": sc["decisions"] if sc else 0,
                        **({v: {"summary": sc[v]["summary"]} for v in ("sell_only", "with_bracket")} if sc else {})})
    return {
        "params": {"n": n, "setups": setups, "min_prob": min_prob, "sell_min_prob": sell_min_prob, "sizing": sizing},
        # the model's own thresholds over the window (what "model" means), and the SELL decisions they give
        "model_thresholds": {"buy": _range([c["threshold"] for c in cands if c["setup"] in chosen]),
                             "sell": _range([c["threshold"] for c in run["sell_candidates"]])},
        "sell_decisions": len(sells_all),
        "pool": pool,
        "result": result,
        "compare": compare,
        "year_start": run.get("year_start"),
    }
