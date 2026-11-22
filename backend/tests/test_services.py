import pandas as pd
import pytest

from backend.app.core.errors import ApiError
from backend.app.indicators import IndicatorParams
from backend.app.services import search_service
from backend.app.services.bars_service import BarsRequest, build_bars, display_window, warmup_days
from backend.app.services.quote_service import day_and_prev

pytestmark = pytest.mark.anyio


def test_warmup_days_scales_with_interval():
    assert warmup_days(1440, 200, False) == 0                 # daily loads full history anyway
    assert warmup_days(1, 200, False) == 6                    # 1 session -> 2 calendar days + 4 slack
    assert warmup_days(60, 200, False) > warmup_days(5, 200, False)
    assert warmup_days(1, 200, True) <= warmup_days(1, 200, False)


def test_display_window_custom_validation():
    now = pd.Timestamp("2026-11-20 12:00", tz="America/New_York")
    with pytest.raises(ApiError):
        display_window("CUSTOM", None, None, now)
    with pytest.raises(ApiError):
        display_window("CUSTOM", "2024-03-01", "2024-01-01", now)
    s, e = display_window("CUSTOM", "2024-01-01", "2024-01-31", now)
    assert str(s.date()) == "2024-01-01" and str(e.date()) == "2024-02-01"  # inclusive end


def test_3y_and_10y_ranges():
    from backend.app.services.bars_service import resolve_range
    now = pd.Timestamp("2026-11-20 12:00", tz="America/New_York")
    assert str(display_window("3Y", None, None, now)[0].date()) == "2023-11-20"
    assert str(display_window("10Y", None, None, now)[0].date()) == "2016-11-20"
    assert resolve_range("3y", None)[:2] == ("3Y", "1Day") and resolve_range("10Y", None)[:2] == ("10Y", "1Week")


async def test_daily_loads_full_history_and_sets_view(fake_alpaca):
    out = await build_bars(BarsRequest(symbol="AAPL", range="1Y"))
    first = pd.Timestamp(out["columns"]["time"][0], unit="s")
    assert out["timeframe"] == "1Day" and first.year == 2016
    assert out["view_start"] > out["columns"]["time"][0]       # view opens at 1 year ago
    assert out["has_more"] is False


async def test_intraday_1d_is_one_regular_session_with_formed_indicators(fake_alpaca):
    out = await build_bars(BarsRequest(symbol="AAPL", range="1D"))
    t = pd.to_datetime(out["columns"]["time"], unit="s")
    assert t.normalize().nunique() == 1
    assert t.min().strftime("%H:%M") == "09:30" and t.max().strftime("%H:%M") == "15:59"
    assert None not in out["columns"]["sma3"]                   # warm-up fetched before the session
    assert out["has_more"] is True


async def test_extended_hours_and_custom_params(fake_alpaca):
    p = IndicatorParams(sma=(9, 20, 500))
    out = await build_bars(BarsRequest(symbol="AAPL", range="1D", extended=True, params=p))
    t = pd.to_datetime(out["columns"]["time"], unit="s")
    assert t.min().strftime("%H:%M") == "04:00"
    assert out["params"]["sma"] == (9, 20, 500)
    assert None not in out["columns"]["sma3"]


@pytest.mark.parametrize("rng, step_days", [("1D", 3), ("1D", 10), ("5D", 3), ("1M", 30)])
async def test_load_from_extends_intraday_history(fake_alpaca, rng, step_days):
    # The frontend asks for `first bar - step_days`; every step must add older bars.
    base = await build_bars(BarsRequest(symbol="AAPL", range=rng))
    first = pd.Timestamp(base["columns"]["time"][0], unit="s")
    more = await build_bars(BarsRequest(symbol="AAPL", range=rng,
                                        load_from=(first - pd.Timedelta(days=step_days)).strftime("%Y-%m-%d")))
    assert more["count"] > base["count"]
    assert more["columns"]["time"][0] < base["columns"]["time"][0]
    assert more["view_start"] == base["view_start"]


async def test_bad_range_and_timeframe(fake_alpaca):
    with pytest.raises(ApiError):
        await build_bars(BarsRequest(symbol="AAPL", range="XX"))
    with pytest.raises(ApiError):
        await build_bars(BarsRequest(symbol="AAPL", range="1D", timeframe="2Min"))


def test_day_and_prev_premarket_uses_latest_bar_as_previous_close():
    daily = [{"t": "2026-11-19T05:00:00Z", "c": 1}, {"t": "2026-11-20T05:00:00Z", "c": 2}]
    day, prev = day_and_prev(daily, {"t": "2026-11-20T18:00:00Z"})
    assert day["c"] == 2 and prev["c"] == 1
    day, prev = day_and_prev(daily, {"t": "2026-11-23T12:00:00Z"})  # next Monday pre-market
    assert day == {} and prev["c"] == 2


def test_search_ranking():
    assets = [{"symbol": "AAPL", "name": "Apple", "exchange": ""}, {"symbol": "AAP", "name": "Advance Auto", "exchange": ""},
              {"symbol": "XYZ", "name": "Apple Hospitality", "exchange": ""}]
    assert [a["symbol"] for a in search_service.rank(assets, "aap")] == ["AAP", "AAPL"]
    assert [a["symbol"] for a in search_service.rank(assets, "apple")] == ["AAPL", "XYZ"]
    assert search_service.rank(assets, "  ") == []


async def test_bars_carry_the_vix_daily_close_per_bar(fake_alpaca):
    # fake VIX = 10 + day of the month, so each value names the day it came from
    daily = await build_bars(BarsRequest(symbol="AAPL", range="1Y"))
    days = pd.to_datetime(daily["columns"]["time"], unit="s")
    vix = daily["columns"]["vix"]
    assert all(v == 10 + d.day for v, d in zip(vix[-50:], days[-50:]))           # the bar's own day
    weekly = await build_bars(BarsRequest(symbol="AAPL", range="5Y", timeframe="1Week"))
    wk = pd.to_datetime(weekly["columns"]["time"], unit="s")
    friday = wk[-10] + pd.Timedelta(days=4)                                        # bars start on Monday
    assert weekly["columns"]["vix"][-10] == 10 + friday.day                        # the week's last close
    intraday = await build_bars(BarsRequest(symbol="AAPL", range="1D"))
    t = pd.to_datetime(intraday["columns"]["time"], unit="s")
    assert set(intraday["columns"]["vix"]) == {10 + t[0].day}                      # that session's close


async def test_bars_still_load_without_vix(fake_alpaca, monkeypatch):
    from backend.app.yahoo_api import client as yahoo

    def down(start):
        raise ApiError(502, "Yahoo down")
    monkeypatch.setattr(yahoo, "fetch_vix", down)
    out = await build_bars(BarsRequest(symbol="AAPL", range="1Y"))
    assert out["count"] > 0 and set(out["columns"]["vix"]) == {None}


def test_vix_column_week_and_month_ends():
    import numpy as np

    from backend.app.services.bars_service import vix_column
    vix = pd.Series([20.0, 21.0, 22.0], index=pd.to_datetime(["2026-01-05", "2026-01-09", "2026-01-12"]))
    # a week starting on Tuesday (Monday holiday) still ends that Sunday - never next Monday's close
    s = pd.Series(pd.to_datetime(["2026-01-06", "2026-01-13"]))
    assert vix_column(vix, s, 10080).tolist() == [21.0, 22.0]
    assert vix_column(vix, pd.Series(pd.to_datetime(["2026-01-01"])), 43200).tolist() == [22.0]   # month so far
    assert np.isnan(vix_column(vix, pd.Series(pd.to_datetime(["2025-12-31"])), 1440)[0])          # before data
    assert np.isnan(vix_column(None, s, 1440)).all()


async def test_daily_vwap_is_anchored_at_the_range_start(fake_alpaca):
    out = await build_bars(BarsRequest(symbol="AAPL", range="1Y"))
    c = out["columns"]
    i0 = next(i for i, t in enumerate(c["time"]) if t >= out["view_start"])
    assert all(v is None for v in c["vwap"][:i0])                       # nothing before the range
    assert c["vwap"][i0] == c["bar_vwap"][i0]                           # the first bar's own VWAP
    vw, v = c["bar_vwap"][i0:i0 + 5], c["volume"][i0:i0 + 5]
    assert abs(c["vwap"][i0 + 4] - sum(a * b for a, b in zip(vw, v)) / sum(v)) < 1e-3   # cumulative from there


async def test_range_base_is_the_close_before_the_range(fake_alpaca):
    out = await build_bars(BarsRequest(symbol="AAPL", range="1Y"))
    c, base = out["columns"], out["range_base"]
    i0 = next(i for i, t in enumerate(c["time"]) if t >= out["view_start"])
    assert base == {"time": c["time"][i0 - 1], "close": c["close"][i0 - 1], "daily": True}
    day = await build_bars(BarsRequest(symbol="AAPL", range="1D"))
    t0 = pd.Timestamp(day["columns"]["time"][0], unit="s")
    prev = pd.Timestamp(day["range_base"]["time"], unit="s")
    # intraday: the previous session's official (daily bar) close, not its last minute bar
    assert day["range_base"]["daily"] is True and prev.normalize() < t0.normalize() and prev.strftime("%H:%M") == "00:00"
    assert None not in day["columns"]["vwap"]                            # intraday: per-session VWAP as before
    assert (await build_bars(BarsRequest(symbol="AAPL", range="MAX")))["range_base"] is None


async def test_intraday_range_base_falls_back_to_the_last_minute_bar(fake_alpaca, monkeypatch):
    from backend.app.services import quote_service

    async def down(symbol):
        raise ApiError(502, "no daily bars")
    monkeypatch.setattr(quote_service, "daily_bars", down)
    day = await build_bars(BarsRequest(symbol="AAPL", range="1D"))
    prev = pd.Timestamp(day["range_base"]["time"], unit="s")
    assert day["range_base"]["daily"] is False and prev.strftime("%H:%M") == "15:59"


async def test_intraday_range_ends_at_the_sessions_official_close(fake_alpaca):
    from backend.app.services import quote_service
    day = await build_bars(BarsRequest(symbol="AAPL", range="1D"))
    last = day["range_last"]
    daily = await quote_service.daily_bars("AAPL")
    t_last = pd.Timestamp(day["columns"]["time"][-1], unit="s").normalize()
    assert last["daily"] is True and pd.Timestamp(last["time"], unit="s") == t_last
    assert last["close"] == round(daily[-1]["c"], 4)
    assert (await build_bars(BarsRequest(symbol="AAPL", range="1D", extended=True)))["range_last"] is None
    assert (await build_bars(BarsRequest(symbol="AAPL", range="1Y")))["range_last"] is None   # daily: the last bar
