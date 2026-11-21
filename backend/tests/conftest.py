"""Shared fixtures: a fake Alpaca (deterministic synthetic bars, snapshot, asset list) and a TestClient."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from backend.app.alpaca_api import feeds, trading
from backend.app.services import bars_service, quote_service

TF_MIN = bars_service.TIMEFRAME_MINUTES


def synthetic_bars(timeframe: str, start: str, end: str | None = None, max_bars: int = 20000) -> list[dict]:
    """Weekday bars 04:00-20:00 ET (intraday) or business days/weeks/months, random-walk prices from 2016."""
    s = max(pd.Timestamp(start), pd.Timestamp("2016-01-04", tz="UTC"))
    e = pd.Timestamp(end) if end else pd.Timestamp.now(tz="UTC")
    m = TF_MIN[timeframe]
    if m < 1440:
        idx = pd.date_range(s.floor("D"), e, freq=f"{m}min", tz="UTC") if s.tzinfo else \
            pd.date_range(s.floor("D"), e, freq=f"{m}min")
        et = idx.tz_convert("America/New_York")
        mins = et.hour * 60 + et.minute
        idx = idx[(et.dayofweek < 5) & (mins >= 240) & (mins < 1200)]
    else:
        freq = {"1Day": "B", "1Week": "W-MON", "1Month": "MS"}[timeframe]
        idx = pd.date_range(s.tz_convert(None).floor("D"), e.tz_convert(None), freq=freq)
        idx = idx.tz_localize("America/New_York").tz_convert("UTC")
    rng = np.random.default_rng(7)
    closes = 100 + np.cumsum(rng.normal(0, 0.5, len(idx)))
    bars = [{"t": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "o": float(c - 0.1), "h": float(c + 0.4), "l": float(c - 0.4),
             "c": float(c), "v": 1000 + i, "vw": float(c), "n": 10} for i, (t, c) in enumerate(zip(idx, closes))]
    return bars[-max_bars:]


@pytest.fixture
def anyio_backend():
    return "asyncio"  # run `@pytest.mark.anyio` tests on asyncio only


@pytest.fixture
def fake_alpaca(monkeypatch):
    calls: list[dict] = []

    async def get_bars(symbol, timeframe, start, end=None, max_bars=20000):
        calls.append({"symbol": symbol, "timeframe": timeframe, "start": start, "end": end})
        return synthetic_bars(timeframe, start, end, max_bars)

    async def get_snapshot(symbol):
        now = pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%dT%H:%M:%SZ")
        return {"latestTrade": {"p": 101.0, "t": now, "s": 5},
                "latestQuote": {"bp": 100.9, "bs": 2, "ap": 101.1, "as": 3, "t": now}}

    async def get_asset(symbol):
        if symbol == "NOPE":
            from backend.app.alpaca_api.http import AlpacaError
            raise AlpacaError(404, "asset not found")
        return {"name": "Test Corp", "exchange": "NASDAQ", "class": "us_equity", "tradable": True}

    async def list_assets():
        return [{"symbol": "AAPL", "name": "Apple Inc.", "exchange": "NASDAQ"},
                {"symbol": "AAP", "name": "Advance Auto Parts", "exchange": "NYSE"},
                {"symbol": "MSFT", "name": "Microsoft Corporation", "exchange": "NASDAQ"}]

    monkeypatch.setattr(feeds, "get_bars", get_bars)
    monkeypatch.setattr(feeds, "get_snapshot", get_snapshot)
    monkeypatch.setattr(feeds, "feed_label", lambda: "sip+iex")
    monkeypatch.setattr(trading, "get_asset", get_asset)
    monkeypatch.setattr(trading, "list_assets", list_assets)
    quote_service._daily_cache.clear()
    return calls


@pytest.fixture
def client(fake_alpaca):
    from backend.app.main import app
    with TestClient(app) as c:
        yield c
