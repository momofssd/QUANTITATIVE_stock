"""GET /api/search?q= : ticker autocomplete."""
from __future__ import annotations

from fastapi import APIRouter, Query

from ...services import search_service

router = APIRouter(prefix="/api", tags=["search"])


@router.get("/search")
async def search(q: str = Query("", max_length=40)):
    return await search_service.search(q)
