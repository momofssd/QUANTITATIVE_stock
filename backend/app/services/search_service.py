"""Ticker autocomplete over the cached list of active US equities."""
from __future__ import annotations

from ..alpaca_api import trading

LIMIT = 10


def rank(assets: list[dict], query: str, limit: int = LIMIT) -> list[dict]:
    """Exact symbol first, then symbol prefix (shortest first), then name contains (2+ chars)."""
    q = query.strip().upper()
    if not q:
        return []
    exact, prefix, name_hits = [], [], []
    for a in assets:
        sym, name = a["symbol"], a["name"].upper()
        if sym == q:
            exact.append(a)
        elif sym.startswith(q):
            prefix.append(a)
        elif len(q) >= 2 and q in name:
            name_hits.append(a)
    prefix.sort(key=lambda a: (len(a["symbol"]), a["symbol"]))
    return (exact + prefix + name_hits)[:limit]


async def search(query: str) -> list[dict]:
    if not query.strip():
        return []
    return rank(await trading.list_assets(), query)
