"""GET /api/bars/{symbol} : OHLCV + indicator columns for the chart and historical table."""
from __future__ import annotations

from fastapi import APIRouter, Query

from ...core.errors import ApiError
from ...core.symbols import require_symbol
from ...indicators import parse_params
from ...services.bars_service import BarsRequest, build_bars

router = APIRouter(prefix="/api", tags=["bars"])


@router.get("/bars/{symbol}")
async def bars(
    symbol: str,
    range: str = Query("1D", description="1D 5D 1M 3M 6M YTD 1Y 3Y 5Y 10Y MAX CUSTOM"),
    timeframe: str | None = Query(None, description="1Min 5Min 15Min 30Min 1Hour 4Hour 1Day 1Week 1Month"),
    start: str | None = Query(None, description="CUSTOM range start, YYYY-MM-DD"),
    end: str | None = Query(None, description="CUSTOM range end (inclusive), YYYY-MM-DD"),
    extended: bool = Query(False, description="intraday: include pre/post-market bars"),
    load_from: str | None = Query(None, description="intraday: extend history back to YYYY-MM-DD"),
    sma: str | None = Query(None, description="three SMA lengths, e.g. 20,50,200"),
    ema: str | None = Query(None, description="two EMA lengths, e.g. 12,26"),
    bb: str | None = Query(None, description="Bollinger length,multiplier, e.g. 20,2"),
    rsi: str | None = Query(None, description="RSI length, e.g. 14"),
    macd: str | None = Query(None, description="MACD fast,slow,signal, e.g. 12,26,9"),
):
    try:
        params = parse_params(sma, ema, bb, rsi, macd)
    except ValueError as exc:
        raise ApiError(400, str(exc)) from None
    return await build_bars(BarsRequest(
        symbol=require_symbol(symbol), range=range, timeframe=timeframe, start=start, end=end,
        extended=extended, load_from=load_from, params=params,
    ))
