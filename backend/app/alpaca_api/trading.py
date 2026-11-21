"""Trading-API endpoints used for reference data (no orders are placed anywhere in this app)."""
from __future__ import annotations

import time

from ..core.config import get_settings
from . import http


async def get_clock() -> dict:
    """Market open/closed and next open/close times."""
    return await http.get(f"{get_settings().trading_url}/v2/clock")


async def get_asset(symbol: str) -> dict:
    """Name, exchange and tradability flags for one symbol."""
    return await http.get(f"{get_settings().trading_url}/v2/assets/{symbol}")


_assets_cache: dict = {"at": 0.0, "assets": []}


async def list_assets() -> list[dict]:
    """All active, tradable US equities (cached for 12 hours), used for ticker search."""
    if _assets_cache["assets"] and time.time() - _assets_cache["at"] < 12 * 3600:
        return _assets_cache["assets"]
    raw = await http.get(f"{get_settings().trading_url}/v2/assets", {"status": "active", "asset_class": "us_equity"})
    assets = [
        {"symbol": a["symbol"], "name": a.get("name") or "", "exchange": a.get("exchange") or ""}
        for a in raw
        if a.get("tradable")
    ]
    _assets_cache.update(at=time.time(), assets=assets)
    return assets
