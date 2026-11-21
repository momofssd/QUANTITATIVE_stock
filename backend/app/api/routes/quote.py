"""GET /api/quote/{symbol} : quote header + key statistics."""
from __future__ import annotations

from fastapi import APIRouter

from ...core.symbols import require_symbol
from ...services import quote_service

router = APIRouter(prefix="/api", tags=["quote"])


@router.get("/quote/{symbol}")
async def quote(symbol: str):
    return await quote_service.build_quote(require_symbol(symbol))
