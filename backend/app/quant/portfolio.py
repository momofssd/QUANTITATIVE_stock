"""Simulation over the most recent decisions: buy a lot at every BUY, sell everything at the next SELL.

Rules (long only, before costs):
  - every BUY decision buys a new lot at that bar's close, also while already holding:
      sizing "usd"    $100 worth (fractional shares)
      sizing "share"  1 share
  - the next SELL decision sells everything held (all open lots) at that bar's close
  - variant "with_bracket": each lot is also sold on its own at its BUY's profit-take / stop-loss if that is hit
    first (intrabar, so before a SELL at the same bar's close; filled at the level or at the open on a gap)
  - lots still held at the end are valued at the last close ("open")
A SELL and a BUY on the same bar: the SELL sells what was held before; the BUY then opens a new lot.
Win rate and P&L are counted per lot, so they split exactly by the setup of the BUY that bought the lot.
"""
from __future__ import annotations

STAKE = 100.0
LISTED = 30            # the simulation covers the 30 most recent BUY decisions
SETUPS = ("rebound", "trend")
SIZINGS = ("usd", "share")

SELL, TARGET, STOP, OPEN = "sell", "target", "stop", "open"


def _qty(price: float, sizing: str) -> float:
    return STAKE / price if sizing == "usd" else 1.0


def _lot(b: dict, sells: list[dict], last: dict, use_bracket: bool, sizing: str) -> dict:
    """One lot bought at BUY `b`: sold at the first SELL after it, or (use_bracket) at its own profit-take /
    stop-loss if that comes first; otherwise still open."""
    sell = next((s for s in sells if s["i"] > b["i"]), None)       # sells are sorted by bar
    ex = b.get("exit") if use_bracket else None
    if ex is not None and (sell is None or ex["i"] <= sell["i"]):
        at, reason, status = ex, ex["reason"], "closed"
    elif sell is not None:
        at, reason, status = sell, SELL, "closed"
    else:
        at, reason, status = last, OPEN, "open"
    qty = _qty(b["price"], sizing)
    cost = qty * b["price"]
    pnl = qty * at["price"] - cost
    return {
        "status": status, "reason": reason, "setup": b.get("setup", ""),
        "qty": round(qty, 6), "cost": round(cost, 2),
        "buy_time": b["time"], "buy_date": b["date"], "buy_price": round(b["price"], 2),
        "sell_time": at["time"], "sell_date": at["date"], "sell_price": round(at["price"], 2),
        "bars": at["i"] - b["i"], "pnl": round(pnl, 2), "pnl_pct": round(pnl / cost * 100, 2),
        "_buy_i": b["i"], "_exit_i": at["i"],
    }


def _tally(lots: list[dict]) -> dict:
    closed = [t for t in lots if t["status"] == "closed"]
    still = [t for t in lots if t["status"] == "open"]
    wins = sum(t["pnl"] > 0 for t in closed)
    realized = sum(t["pnl"] for t in closed)
    open_pnl = sum(t["pnl"] for t in still)
    invested = sum(t["cost"] for t in lots)
    return {
        "lots": len(lots), "closed": len(closed), "open": len(still), "wins": wins, "losses": len(closed) - wins,
        "win_rate": round(wins / len(closed), 3) if closed else None,
        "realized_pnl": round(realized, 2), "open_pnl": round(open_pnl, 2), "total_pnl": round(realized + open_pnl, 2),
        "invested": round(invested, 2),
        "return_on_invested_pct": round((realized + open_pnl) / invested * 100, 2) if invested else None,
        "avg_pnl": round(realized / len(closed), 2) if closed else None,
        "best_pnl": max((t["pnl"] for t in closed), default=None),
        "worst_pnl": min((t["pnl"] for t in closed), default=None),
        "avg_bars": round(sum(t["bars"] for t in closed) / len(closed), 1) if closed else None,
    }


def _peak(lots: list[dict]) -> tuple[int, float]:
    """Most lots / most money held at once (exits on a bar happen before a BUY at that bar's close)."""
    events = [(t["_buy_i"], 1, 1, t["cost"]) for t in lots]
    events += [(t["_exit_i"], 0, -1, -t["cost"]) for t in lots if t["status"] == "closed"]
    held = peak = 0
    money = peak_money = 0.0
    for _, _, d, c in sorted(events):
        held += d
        money += c
        peak = max(peak, held)
        peak_money = max(peak_money, money)
    return peak, round(peak_money, 2)


def run(buys: list[dict], sells: list[dict], last: dict, use_bracket: bool, sizing: str = "usd") -> dict:
    """buys:  {i, time, date, price, setup, exit: {i, time, date, price, reason} | None}  (exit = first
              profit-take / stop-loss hit after the entry, no time limit)
    sells: {i, time, date, price}
    last:  {i, time, date, price} = the last bar
    """
    sells = sorted(sells, key=lambda s: s["i"])
    lots = [_lot(b, sells, last, use_bracket, sizing) for b in buys]
    peak, peak_money = _peak(lots)
    summary = _tally(lots)
    summary |= {
        "max_lots": peak, "max_capital": peak_money,
        # return on the most money that was ever at work at the same time
        "return_pct": round(summary["total_pnl"] / peak_money * 100, 2) if peak_money else None,
        "sells_used": len({t["sell_time"] for t in lots if t["reason"] == SELL}),
    }
    by_setup = {name: _tally([t for t in lots if t["setup"] == name]) for name in SETUPS}
    for t in lots:
        del t["_buy_i"], t["_exit_i"]
    return {"trades": lots[::-1], "summary": summary, "by_setup": by_setup}   # newest lot first


def _book(buys: list[dict], sells: list[dict], last: dict, sizing: str) -> dict:
    start = buys[0]
    q0 = _qty(start["price"], sizing)
    first = q0 * (last["price"] - start["price"])
    cost_all = sum(_qty(b["price"], sizing) * b["price"] for b in buys)
    never = sum(_qty(b["price"], sizing) * (last["price"] - b["price"]) for b in buys)
    return {
        "sell_only": run(buys, sells, last, use_bracket=False, sizing=sizing),
        "with_bracket": run(buys, sells, last, use_bracket=True, sizing=sizing),
        # Baselines: the same BUYs never sold; one lot bought at the first BUY and held.
        "hold_all": {"pnl": round(never, 2), "pnl_pct": round(never / cost_all * 100, 2)},
        "buy_hold": {"pnl": round(first, 2), "pnl_pct": round(first / (q0 * start["price"]) * 100, 2)},
    }


def simulate_decisions(buys: list[dict], sells: list[dict], last: dict) -> dict | None:
    """Both variants and both sizings over the period that starts at the oldest of the LISTED most recent BUYs."""
    if not buys:
        return None
    buys = buys[-LISTED:]
    start = buys[0]
    sells = [s for s in sells if s["i"] >= start["i"]]
    return {
        "stake": STAKE, "listed": LISTED,
        "start_time": start["time"], "start_date": start["date"], "end_date": last["date"],
        "buys": len(buys), "sells": len(sells),
        **{sz: _book(buys, sells, last, sz) for sz in SIZINGS},
    }
