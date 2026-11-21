"""GET /api/health, GET /api/clock."""
from __future__ import annotations

from fastapi import APIRouter

from ...alpaca_api import feeds, trading
from ...core.config import get_settings

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/health")
async def health():
    """Are credentials configured? Paper or live account? Which feed is in use?"""
    s = get_settings()
    return {
        "configured": s.configured,
        "account": "paper" if s.is_paper else "live",
        "trading_url": s.trading_url,
        "feed": feeds.feed_label(),
    }


@router.get("/clock")
async def clock():
    """Market open/closed and next open/close (Alpaca clock)."""
    return await trading.get_clock()
