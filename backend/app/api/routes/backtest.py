"""GET /api/backtest/{run_id} : backtest scenarios on a training run (the Backtests page)."""
from __future__ import annotations

from fastapi import APIRouter, Query

from ...services import analysis_service

router = APIRouter(prefix="/api", tags=["backtest"])


@router.get("/backtest/{run_id}")
async def backtest(
    run_id: str,
    n: int = Query(30, description="most recent BUY decisions to simulate (1-100)"),
    setups: str = Query("both", description="rebound | trend | both"),
    min_prob: float = Query(0.6, description="buy only when the model's P >= this (0-1)"),
    sizing: str = Query("usd", description="usd ($100 per BUY) | share (1 share per BUY)"),
):
    """run_id comes from /api/analysis (the current training)."""
    return analysis_service.run_backtest(run_id, n=n, setups=setups, min_prob=min_prob, sizing=sizing)
