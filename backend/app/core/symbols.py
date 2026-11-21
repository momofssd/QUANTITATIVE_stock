"""Ticker validation."""
from __future__ import annotations

import re

from .errors import ApiError

SYMBOL_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")


def clean_symbol(symbol: str) -> str | None:
    sym = symbol.strip().upper()
    return sym if SYMBOL_RE.match(sym) else None


def require_symbol(symbol: str) -> str:
    sym = clean_symbol(symbol)
    if not sym:
        raise ApiError(400, f"'{symbol}' is not a valid ticker symbol.")
    return sym
