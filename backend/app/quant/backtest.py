"""Backtest scenarios on top of one training run (the Backtests page).

The analysis keeps, for its model-check window, every bar that was in a BUY setup together with the out-of-sample
probability the walk-forward model gave it (and the first profit-take / stop-loss hit after it). A backtest then
chooses BUY decisions with the user's rules instead of the model's own threshold:

  setup in the chosen setups (rebound / trend / both)  AND  P >= the user's threshold (default 60%)
  at most one decision per cooldown (as in the analysis: 5 bars on daily, one hour intraday)
  the most recent N of them (1-100, default 30)

and simulates them with quant/portfolio.py (a lot of $100 or 1 share per BUY; sell everything at the next SELL
decision of the training, or each lot earlier at its profit-take / stop-loss). SELL decisions are the training's.
"""
from __future__ import annotations

from . import portfolio

MAX_DECISIONS = 100
SETUP_CHOICES = {"rebound": ("rebound",), "trend": ("trend",), "both": ("rebound", "trend")}


def select(candidates: list[dict], setups: tuple[str, ...], min_prob: float, cooldown: int, n: int) -> list[dict]:
    """BUY decisions under the user's rules (chronological), the most recent n."""
    out, last = [], -10**9
    for c in candidates:
        if c["setup"] not in setups or c["prob"] < min_prob or c["i"] - last <= cooldown:
            continue
        last = c["i"]
        out.append(c)
    return out[-n:]


def _scenario(run: dict, setups: tuple[str, ...], min_prob: float, n: int, sizing: str) -> dict | None:
    buys = select(run["candidates"], setups, min_prob, run["cooldown"], n)
    if not buys:
        return None
    start = buys[0]["i"]
    sells = [s for s in run["sells"] if s["i"] >= start]
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


def backtest(run: dict, n: int = 30, setups: str = "both", min_prob: float = 0.6, sizing: str = "usd") -> dict:
    """The chosen scenario in full + a comparison of rebound / trend / both with the same N, threshold and sizing."""
    chosen = SETUP_CHOICES[setups]
    cands = run["candidates"]
    pool = {name: {"setup_bars": sum(c["setup"] in sel for c in cands),
                   "qualified": len(select(cands, sel, min_prob, run["cooldown"], MAX_DECISIONS * 1000)),
                   "max_prob": round(max((c["prob"] for c in cands if c["setup"] in sel), default=0.0), 3)}
            for name, sel in SETUP_CHOICES.items()}
    result = _scenario(run, chosen, min_prob, n, sizing)
    compare = []
    for name, sel in SETUP_CHOICES.items():
        sc = result if name == setups else _scenario(run, sel, min_prob, n, sizing)
        compare.append({"setups": name, "decisions": sc["decisions"] if sc else 0,
                        **({v: {"summary": sc[v]["summary"]} for v in ("sell_only", "with_bracket")} if sc else {})})
    return {
        "params": {"n": n, "setups": setups, "min_prob": min_prob, "sizing": sizing},
        "pool": pool,
        "result": result,
        "compare": compare,
        "year_start": run.get("year_start"),
    }
