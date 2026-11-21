"""GET /api/analysis/{symbol} : entry / take-profit analysis retrained on the chart's range and interval."""
from __future__ import annotations

from fastapi import APIRouter, Query

from ...core.symbols import require_symbol
from ...services import analysis_service
from ...services.analysis_service import AnalysisRequest

router = APIRouter(prefix="/api", tags=["analysis"])


@router.get("/analysis/{symbol}")
async def analysis(
    symbol: str,
    range: str = Query("5Y", description="1D 5D 1M 3M 6M YTD 1Y 5Y MAX CUSTOM (same as the chart)"),
    timeframe: str | None = Query("1Day", description="1Min 5Min 15Min 30Min 1Hour 4Hour 1Day 1Week"),
    start: str | None = Query(None, description="CUSTOM range start, YYYY-MM-DD"),
    end: str | None = Query(None, description="CUSTOM range end (inclusive), YYYY-MM-DD"),
    extended: bool = Query(False, description="intraday: include pre/post-market bars"),
    tp_atr: float = Query(1.5, description="short-term profit-take, x daily ATR (0.5-5)"),
    sl_atr: float = Query(1.0, description="short-term stop-loss, x daily ATR (0.25-5)"),
    bracket: str = Query("fixed", description="BUY profit-take / stop-loss: 'fixed' (tp_atr / sl_atr) or "
                                              "'dynamic' (set per decision from the chart)"),
    refresh: bool = Query(False, description="ignore the few-minute result cache (retrain)"),
):
    req = AnalysisRequest(symbol=require_symbol(symbol), range=range, timeframe=timeframe,
                          start=start, end=end, extended=extended, tp_atr=tp_atr, sl_atr=sl_atr, bracket=bracket)
    return await analysis_service.run_analysis(req, refresh=refresh)


@router.get("/analysis/{symbol}/intraday")
async def intraday(symbol: str):
    """Today's 5-minute check for the current K line (cheap; the UI refreshes it every minute)."""
    return await analysis_service.intraday_snapshot(require_symbol(symbol))
