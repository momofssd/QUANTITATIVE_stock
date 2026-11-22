"""Simulation over the most recent decisions: buy a lot at every BUY, sell everything at the next SELL.

Rules (long only, before costs):
  - every BUY decision buys a new lot at that bar's close, also while already holding:
      sizing "usd"    $100 worth (fractional shares)
      sizing "share"  1 share
  - the next SELL decision sells everything held (all open lots) at that bar's close
  - variant "with_bracket": each lot is also sold on its own at its BUY's profit-take / stop-loss, or at the close
    when its holding window (20 sessions) ends - whichever comes first, if before the next SELL (a profit-take /
    stop-loss is intrabar, so before a SELL at the same bar's close; filled at the level or at the open on a gap)
  - lots still held at the end are valued at the last close ("open")
  - optional cap (max_shares): a BUY that would take the shares held above the cap is skipped (logged in
    "skipped"); holdings drop when lots are sold, so BUYs resume after the next SELL
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
        "status": status, "reason": reason, "setup": b.get("setup", ""), "prob": b.get("prob"),
        "qty": round(qty, 6), "cost": round(cost, 2),
        "buy_time": b["time"], "buy_date": b["date"], "buy_price": round(b["price"], 2),
        "sell_time": at["time"], "sell_date": at["date"], "sell_price": round(at["price"], 2),
        "bars": at["i"] - b["i"], "pnl": round(pnl, 2), "pnl_pct": round(pnl / cost * 100, 2),
        "_buy_i": b["i"], "_exit_i": at["i"],
    }


def admit(buys: list[dict], sells: list[dict], last: dict, use_bracket: bool, sizing: str,
          max_shares: float | None) -> tuple[list[dict], list[dict]]:
    """The BUYs actually bought under a cap on shares held at once (None = no cap), and the ones skipped
    (chronological). Lots sold on a bar (SELL at its close, profit-take / stop-loss intrabar) are gone before a
    BUY at that bar's close."""
    if max_shares is None:
        return list(buys), []
    sells = sorted(sells, key=lambda s: s["i"])
    taken, skipped, held = [], [], []          # held: (exit bar, still open at the end, qty)
    for b in buys:
        lot = _lot(b, sells, last, use_bracket, sizing)
        on_hand = sum(q for x, still, q in held if still or x > b["i"])
        if on_hand + lot["qty"] > max_shares + 1e-9:
            skipped.append({"time": b["time"], "date": b["date"], "price": round(b["price"], 2),
                            "setup": b.get("setup", ""), "prob": b.get("prob"), "qty": lot["qty"],
                            "held": round(on_hand, 6)})
            continue
        taken.append(b)
        held.append((lot["_exit_i"], lot["status"] == "open", lot["qty"]))
    return taken, skipped


def _tally(lots: list[dict]) -> dict:
    closed = [t for t in lots if t["status"] == "closed"]
    still = [t for t in lots if t["status"] == "open"]
    wins = sum(t["pnl"] > 0 for t in closed)
    realized = sum(t["pnl"] for t in closed)
    open_pnl = sum(t["pnl"] for t in still)
    invested = sum(t["cost"] for t in lots)
    won = [t for t in closed if t["pnl"] > 0]
    lost = [t for t in closed if t["pnl"] <= 0]
    shares = sum(t["qty"] for t in lots)
    open_shares, open_cost = sum(t["qty"] for t in still), sum(t["cost"] for t in still)

    def mean(v):
        return round(sum(v) / len(v), 2) if v else None
    return {
        "lots": len(lots), "closed": len(closed), "open": len(still), "wins": wins, "losses": len(closed) - wins,
        "win_rate": round(wins / len(closed), 3) if closed else None,
        "realized_pnl": round(realized, 2), "open_pnl": round(open_pnl, 2), "total_pnl": round(realized + open_pnl, 2),
        "invested": round(invested, 2),
        # average cost per share: of every share bought, and of the shares still held
        "shares": round(shares, 6), "avg_cost": round(invested / shares, 2) if shares else None,
        "open_shares": round(open_shares, 6), "open_cost": round(open_cost, 2),
        "open_avg_cost": round(open_cost / open_shares, 2) if open_shares else None,
        "return_on_invested_pct": round((realized + open_pnl) / invested * 100, 2) if invested else None,
        "avg_pnl": round(realized / len(closed), 2) if closed else None,
        "best_pnl": max((t["pnl"] for t in closed), default=None),
        "worst_pnl": min((t["pnl"] for t in closed), default=None),
        "avg_bars": round(sum(t["bars"] for t in closed) / len(closed), 1) if closed else None,
        # per transaction (sold lots): average return, average gain of winners, average loss of losers
        "avg_return_pct": mean([t["pnl_pct"] for t in closed]),
        "avg_win_pct": mean([t["pnl_pct"] for t in won]), "avg_loss_pct": mean([t["pnl_pct"] for t in lost]),
        "avg_win_pnl": mean([t["pnl"] for t in won]), "avg_loss_pnl": mean([t["pnl"] for t in lost]),
    }


def _ytd(lots: list[dict], year_start: dict) -> dict:
    """P&L earned since Jan 1 of the last bar's year. A lot held over the year end counts from the last close of
    the previous year; lots sold before the year count nothing. year_start = {i, date, prev_close | None}."""
    ys, prev = year_start["i"], year_start.get("prev_close")
    pnl = basis = 0.0
    held = 0
    sold = []
    for t in lots:
        if t["status"] == "closed" and t["_exit_i"] < ys:
            continue
        held += 1
        start = t["buy_price"] if t["_buy_i"] >= ys or prev is None else prev
        pnl += t["qty"] * (t["sell_price"] - start)
        basis += t["qty"] * start
        if t["status"] == "closed":
            sold.append(t)
    wins = sum(t["pnl"] > 0 for t in sold)
    return {
        "since": year_start["date"], "lots_held": held, "lots_sold": len(sold), "wins": wins,
        "win_rate": round(wins / len(sold), 3) if sold else None,
        "pnl": round(pnl, 2), "return_pct": round(pnl / basis * 100, 2) if basis else None,
        "avg_return_pct": round(sum(t["pnl_pct"] for t in sold) / len(sold), 2) if sold else None,
    }


def _peak(lots: list[dict]) -> tuple[int, float, float]:
    """Most lots / money / shares held at once (exits on a bar happen before a BUY at that bar's close)."""
    events = [(t["_buy_i"], 1, 1, t["cost"], t["qty"]) for t in lots]
    events += [(t["_exit_i"], 0, -1, -t["cost"], -t["qty"]) for t in lots if t["status"] == "closed"]
    held = peak = 0
    money = peak_money = shares = peak_shares = 0.0
    for _, _, d, c, q in sorted(events):
        held += d
        money += c
        shares += q
        peak = max(peak, held)
        peak_money = max(peak_money, money)
        peak_shares = max(peak_shares, shares)
    return peak, round(peak_money, 2), round(peak_shares, 6)


def run(buys: list[dict], sells: list[dict], last: dict, use_bracket: bool, sizing: str = "usd",
        year_start: dict | None = None, max_shares: float | None = None) -> dict:
    """buys:  {i, time, date, price, setup, exit: {i, time, date, price, reason} | None}  (exit = first
              profit-take / stop-loss hit after the entry, no time limit)
    sells: {i, time, date, price}
    last:  {i, time, date, price} = the last bar
    max_shares: most shares held at once (None = no cap); BUYs over it are skipped
    """
    sells = sorted(sells, key=lambda s: s["i"])
    taken, skipped = admit(buys, sells, last, use_bracket, sizing, max_shares)
    lots = [_lot(b, sells, last, use_bracket, sizing) for b in taken]
    peak, peak_money, peak_shares = _peak(lots)
    summary = _tally(lots)
    summary |= {
        "max_lots": peak, "max_capital": peak_money, "max_shares_held": peak_shares,
        "max_shares": max_shares, "skipped": len(skipped),
        # return on the most money that was ever at work at the same time
        "return_pct": round(summary["total_pnl"] / peak_money * 100, 2) if peak_money else None,
        "sells_used": len({t["sell_time"] for t in lots if t["reason"] == SELL}),
    }
    if year_start is not None:
        summary["ytd"] = _ytd(lots, year_start)
    by_setup = {name: _tally([t for t in lots if t["setup"] == name]) for name in SETUPS}
    for t in lots:
        del t["_buy_i"], t["_exit_i"]
    # newest first
    return {"trades": lots[::-1], "summary": summary, "by_setup": by_setup, "skipped": skipped[::-1]}


def _held(cost: float, shares: float, last: dict, **extra) -> dict:
    """A position bought for `cost` and held to the last close: average cost, value, P&L."""
    value = shares * last["price"]
    return {**extra, "cost": round(cost, 2), "shares": round(shares, 6),
            "avg_cost": round(cost / shares, 2) if shares else None, "value": round(value, 2),
            "pnl": round(value - cost, 2), "pnl_pct": round((value / cost - 1) * 100, 2) if cost else None}


def dca(start: dict, weekly: list[dict], last: dict, total: float) -> dict | None:
    """Weekly dollar-cost averaging with the same money: `total` in equal amounts, bought at the first BUY's close and
    then at the first close of every later week up to the last bar (weekly = the first bar of each week), held to the
    last close."""
    if total <= 0:
        return None
    bars = [start] + [w for w in weekly if start["i"] < w["i"] <= last["i"]]
    per = total / len(bars)
    shares = sum(per / b["price"] for b in bars)
    return _held(total, shares, last, buys=len(bars), per_buy=round(per, 2), last_buy_date=bars[-1]["date"])


def _variant(buys: list[dict], sells: list[dict], last: dict, use_bracket: bool, sizing: str,
             year_start: dict | None = None, limit: int | None = LISTED, max_shares: float | None = None,
             weekly: list[dict] | None = None) -> dict | None:
    """One strategy over the `limit` most recent BUYs (None = all given): the run + its period, counts, baselines.
    With a cap (max_shares) the baselines use the BUYs actually bought. weekly (the first bar of each week) adds the
    weekly DCA baseline."""
    if limit is not None:
        buys = buys[-limit:]
    if not buys:
        return None
    start = buys[0]
    sells = [s for s in sells if s["i"] >= start["i"]]
    taken, _ = admit(buys, sells, last, use_bracket, sizing, max_shares)
    q0 = _qty(start["price"], sizing)
    cost_all = sum(_qty(b["price"], sizing) * b["price"] for b in taken)
    shares_all = sum(_qty(b["price"], sizing) for b in taken)
    return {
        **run(buys, sells, last, use_bracket, sizing, year_start, max_shares),
        "start_time": start["time"], "start_date": start["date"], "buys": len(buys), "sells": len(sells),
        "last_price": round(last["price"], 2),
        # baselines with the same money (what the BUYs bought): the same BUYs never sold - every lot kept, shares on
        # hand, what they cost, what they are worth at the last close; all of it at the first BUY; weekly DCA
        "hold_all": _held(cost_all, shares_all, last),
        "lump_sum": _held(cost_all, cost_all / start["price"], last) if cost_all else None,
        "dca": dca(start, weekly, last, cost_all) if weekly is not None else None,
        # one lot bought at the first BUY and held
        "buy_hold": {"pnl": round(q0 * (last["price"] - start["price"]), 2),
                     "pnl_pct": round((last["price"] / start["price"] - 1) * 100, 2)},
    }


def simulate_decisions(buys_by_variant: dict[str, list[dict]], sells: list[dict], last: dict) -> dict | None:
    """Both strategies x both sizings. buys_by_variant: "sell_only" = the sell-signal BUY model's decisions (every
    BUY adds a lot, the next SELL sells everything); "with_bracket" = the profit-take / stop-loss BUY model's (each
    lot also sold at its own profit-take / stop-loss / time limit)."""
    if not any(buys_by_variant.values()):
        return None
    return {
        "stake": STAKE, "listed": LISTED, "end_date": last["date"],
        **{sz: {v: _variant(buys_by_variant.get(v, []), sells, last, v == "with_bracket", sz)
                for v in ("sell_only", "with_bracket")} for sz in SIZINGS},
    }
