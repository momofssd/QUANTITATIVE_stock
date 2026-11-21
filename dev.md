QUANT TRADING MODEL V3 (WEB) - DEVELOPER GUIDE
=============================================

What it is: a quote & chart research app on Alpaca market data. Historical + live K-line (candlestick) charts
with indicators, plus an on-demand quantitative "entry point" analysis (section 8). No trading.

  Backend   Python 3.11+  FastAPI, httpx, pandas, websockets          backend/
  Frontend  React 18 + TypeScript, Vite 5, Lightweight Charts 4.2.0    frontend/


1. RUNNING
----------
First time:
    pip install -r requirements.txt
    cd frontend && npm install

Development (hot reload on both sides):
    .\dev.ps1     (or dev.bat if PowerShell scripts are blocked)
      - opens a window running the backend on http://127.0.0.1:8000 (auto-reload on .py changes)
      - runs Vite on http://127.0.0.1:5173  <- open this. Vite proxies /api and /ws to :8000.
    or by hand, in two terminals:
      python -m uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
      cd frontend && npm run dev

Production-style (one server):
    .\run.ps1   (or run.bat)     builds frontend/dist if missing, then serves UI + API on :8000
    .\run.ps1 -Build             force a rebuild first
    FastAPI checks for frontend/dist on every request, so `npm run build` while the server runs just works.

Tests and checks:
    python -m pytest                     backend tests (fake Alpaca, no network)
    cd frontend && npm run typecheck     TypeScript
    cd frontend && npm run build         typecheck + production bundle

Configuration (.env in the project root, re-read automatically when it changes):
    ALPACA_API_KEY=...
    ALPACA_SECRET_KEY=...
    ALPACA_ENDPOINT=https://paper-api.alpaca.markets
    ALPACA_DATA_FEED=auto        auto | iex | sip   (see 4.2)
  Other common names (APCA_API_KEY_ID, APCA_API_SECRET_KEY, APCA_API_BASE_URL, ...) are accepted.
  .env is git-ignored; .env.example documents the variables.


2. REPOSITORY LAYOUT
--------------------
  .env / .env.example     credentials (never committed) / template
  requirements.txt        Python dependencies
  pytest.ini              test discovery (backend/tests)
  run.ps1, run.bat        production-style run (build if needed + serve)
  dev.ps1                 development run (backend window + Vite)
  README.md               short overview
  dev.md                  this file (developer guide)
  backend/                Python API (section 3)
  frontend/               React app (section 5)


3. BACKEND  (backend/app)
-------------------------
Layering - imports only point downwards:

    api/routes   HTTP/WebSocket only: parse + validate input, call a service, return JSON
        |
    services     business logic (no HTTP types); unit-testable with a fake Alpaca
    live         live-stream hub (WebSocket fan-out)
        |
    indicators   pure pandas maths (chart indicators)
    quant        pure entry-point analysis maths (labels, features, models, relations)
    alpaca_api   everything that talks to Alpaca
    yahoo_api    everything that talks to Yahoo Finance
        |
    core         settings, errors, time + symbol helpers (imports nothing from the app)

Rule of thumb: a route never calls Alpaca directly, and only alpaca_api/ knows Alpaca URLs and field names.

main.py
    create_app(): installs error handlers, includes api_router, adds the catch-all that serves the built React
    app from frontend/dist (index.html for unknown paths, real files for assets; /api and /ws paths are never
    swallowed). Lifespan shutdown closes the live hub and the shared HTTP client.
    `app = create_app()` is what uvicorn loads.

core/
    config.py      Settings dataclass from .env (hot-reloaded by file mtime). Accepts many variable names.
                   Normalises the trading URL (adds https, strips /v2). Paths: PROJECT_ROOT, ENV_PATH, FRONTEND_DIST.
    errors.py      ApiError(status, message) and install_error_handlers() -> {"detail": message} JSON.
                   Raise ApiError anywhere in a request to return a clean HTTP error.
    timeutil.py    ET zone, EARLIEST (2016-01-01, start of Alpaca history), iso() for Alpaca timestamps,
                   et_epoch() for the chart time encoding (see 6.1), et_date().
    symbols.py     clean_symbol() / require_symbol() - ticker validation ([A-Z][A-Z0-9.-]{0,9}).

alpaca_api/
    http.py        Shared httpx.AsyncClient, auth headers, AlpacaError (subclass of ApiError, so Alpaca status codes
                   pass through to our responses), get(), data_get() with optional SIP -> IEX fallback on 403.
    market_data.py fetch_bars() - one feed, paginated newest-first so a cap keeps the latest bars, returned
                   oldest-first. fetch_snapshot().
    feeds.py       Which feed to use (4.2): resolve_feed_mode() probes once; feed_mode(), feed_label(),
                   live_feed(). get_bars() = deepest history + live tail (hybrid merge via merge_tail()).
                   get_snapshot(). Services call feeds.*, never market_data.* directly.
    trading.py     get_clock(), get_asset(), list_assets() (cached 12 h, for search). Reference data only;
                   nothing in the app places orders.

yahoo_api/
    client.py      FACTORS (spy SPY, qqq QQQ, vix ^VIX, oil CL=F, gasoline RB=F, rate ^IRX) and fetch_factors(start):
                   daily closes via yfinance, forward-filled, cached in memory for 4 h. Synchronous - call it in a
                   worker thread. Raises ApiError(502) when Yahoo fails.

quant/   (pure functions; no I/O)
    targets.py     TargetSpec (kind entry|take_profit, direction up|down, horizon, target_atr, stop_atr, cooldown,
                   model, trailing-stop settings, exit_with, horizon_mode, atr_basis). SHORT entry and TP_SHORT
                   take-profit (long-term entries are being redesigned and are not part of the app right now);
                   Wilder atr(); triple_barrier() -> label (1/0/NaN), resolved_at (bar on which the outcome became
                   known), outcome (target / stop / expired / pending). Direction-aware.
    trades.py      simulate(): trade one entry (stop, target, optional trailing stop, optional take-profit signal,
                   time limit; gap fills at the open; conservative same-bar rule); short-term entries run as plain
                   bracket orders. summarize(): win rate, avg/median return, R, profit factor, holding bars, reasons.
    features.py    stock_features() on the analysed interval's bars + market_features() per day (stock daily closes +
                   Yahoo factors), attached to bars by align(): "same" (daily), "week_end" (weekly), "previous"
                   (intraday - previous day's values only). build_features() combines them; ~40 features, each
                   tagged with a group in GROUPS (Stock momentum, Stock trend, Stock volatility & volume, SPY, QQQ,
                   VIX, Oil & gasoline, Interest rate).
    model.py       make_model(kind), train_mask() (no-look-ahead rule), walk_forward(), fit_latest(),
                   threshold_for(), reliability() verdict, group_importance() (permutation importance by group).
    relations.py   factor_relations(): correlation (5y, 60d), beta (SPY/QQQ), 5-day lead correlation per factor.
    setups.py      compute_setups(): rule-based setups per bar - "rebound" (falling momentum easing), "trend" (clear
                   bullish trend), "top" (bullish momentum easing / interim top) - their component conditions, and
                   numeric momentum-shift values (MACD-histogram / RSI change, ADX, +DI-DI, wicks, streaks, bars since
                   20-bar high / low). explain() lists which conditions hold on a bar (current K line in the UI).
    intraday.py    intraday_check(): five checks on one session's 5-minute bars (VWAP, last hour, 5-min RSI
                   direction, lows, position in day range) -> BUY / SELL score and verdict.

indicators/
    params.py      IndicatorParams (frozen dataclass; lengths in bars): sma(3), ema(2), bb_len, bb_mult, rsi,
                   macd(fast, slow, signal). warmup_bars() = bars needed before the first visible bar.
                   parse_params() validates the query-string form (1-500, MACD fast < slow, BB length >= 2).
    compute.py     sma, ema, rsi (Wilder), vwap (resets per session), compute_all() -> positional columns:
                   sma1 sma2 sma3 ema1 ema2 bb_mid bb_upper bb_lower rsi macd macd_signal macd_hist vwap.
                   Column names are positional so they stay stable when lengths change; the lengths used are
                   returned alongside as `params`.

services/
    frames.py          bars_frame(): Alpaca bar dicts -> UTC-indexed DataFrame
                       (open high low close volume bar_vwap trades).
    bars_service.py    build_bars(BarsRequest) - the chart's data:
                         range -> display window (display_window), daily+ always loads full history from 2016,
                         intraday loads the window (+ load_from for scroll-back), warm-up days from the
                         indicator lengths (warmup_days), regular-session filter unless extended,
                         indicators, trim, view_start / has_more / truncated, column-oriented JSON.
                       Constants: TIMEFRAME_MINUTES, RANGE_DEFAULT_TF, SESSION_RANGES (1D, 5D), MAX_BARS.
                       Shared helpers: resolve_range() (validate range + interval), fetch_frame() (an interval's
                       bars exactly as the chart shows them, regular hours unless extended).
    quote_service.py   build_quote(): asset + snapshot + ~1y daily bars (cached 15 s) -> price, change vs
                       previous close, day OHLCV, 52-week range, average volumes. day_and_prev() handles
                       pre-market (latest daily bar is yesterday's session).
    search_service.py  rank(): exact symbol, then symbol prefix, then name contains. search().
    analysis_service.py run_analysis(AnalysisRequest(symbol, range, timeframe, start, end, extended)): the chart's
                       bars + the stock's daily closes + Yahoo factors -> compute() in a worker thread -> payload
                       (section 8). eval_window() = the chart's range, widened to >= 1,260 bars. The UI always
                       sends refresh=true (each click retrains); results are also cached 10 minutes per request.

live/
    hub.py         LiveHub - see 4.3. `hub` is the process-wide instance.

api/
    __init__.py        api_router = all route modules combined.
    routes/system.py   GET /api/health, GET /api/clock
    routes/search.py   GET /api/search?q=
    routes/quote.py    GET /api/quote/{symbol}
    routes/bars.py     GET /api/bars/{symbol}  (query parameters documented in the signature; see /docs)
    routes/analysis.py GET /api/analysis/{symbol}?range=&timeframe=&start=&end=&extended=&tp_atr=&sl_atr=&refresh=
                       GET /api/analysis/{symbol}/intraday  (today's 5-minute check; the UI polls it every minute)
    routes/live.py     WS /ws/live/{symbol}, GET /api/live/status

backend/tests/
    conftest.py          fake_alpaca fixture (monkeypatches feeds/trading with deterministic synthetic bars),
                         client fixture (FastAPI TestClient). Async tests use `pytest.mark.anyio`.
    test_indicators.py   maths + parameter validation
    test_feeds.py        hybrid merge
    test_services.py     ranges, warm-up, session filter, extended hours, scroll-back (load_from), quote logic,
                         search ranking
    test_api.py          route-level shapes and error codes
    test_quant.py        triple-barrier labels, no-look-ahead training mask, walk-forward, thresholds, verdicts
    test_trades.py       bracket / trailing / SELL-signal / time exits, gap fills, open trades
    test_setups.py       rebound / trend / interim-top setups, explain(), the 5-minute check
    test_analysis_service.py  full analysis pipeline on synthetic data; features unchanged by later bars


4. BACKEND BEHAVIOUR WORTH KNOWING
----------------------------------
4.1 API
    GET /api/health                 {configured, account: paper|live, trading_url, feed}
    GET /api/clock                  Alpaca clock {is_open, next_open, next_close, ...}
    GET /api/search?q=              [{symbol, name, exchange}] (max 10)
    GET /api/quote/{sym}            quote header + key statistics (see services/quote_service.py)
    GET /api/bars/{sym}             range=1D|5D|1M|3M|6M|YTD|1Y|5Y|MAX|CUSTOM  timeframe=1Min..1Month
                                    start/end (CUSTOM, YYYY-MM-DD, end inclusive)  extended=true
                                    load_from=YYYY-MM-DD (intraday scroll-back)
                                    sma=20,50,200 ema=12,26 bb=20,2 rsi=14 macd=12,26,9
                                    -> {symbol, range, timeframe, intraday, feed, params, count, truncated,
                                        has_more, view_start, load_from, start, end, columns:{time, open, ...}}
    GET /api/live/status            hub state, watched symbols, upstream open/closed counters
    GET /api/analysis/{sym}         entry / take-profit analysis for a range + interval (section 8); 5-30 s;
                                    range, timeframe (not 1Month), start/end (CUSTOM), extended,
                                    tp_atr / sl_atr (short-term profit-take / stop-loss, x daily ATR), refresh
    GET /api/analysis/{sym}/intraday today's (latest session's) 5-minute check: checks, buy / sell verdicts
    WS  /ws/live/{sym}              live messages (4.3)
    Interactive docs: http://127.0.0.1:8000/docs

4.2 Data feeds (alpaca_api/feeds.py)
    Free Alpaca plans: SIP (consolidated, all exchanges) history back to 2016 but not the latest 15 minutes;
    IEX real-time but one exchange only (history from mid-2020).
    ALPACA_DATA_FEED=auto probes once whether recent SIP is allowed:
      yes -> "sip"     everything from SIP
      no  -> "hybrid"  bars = SIP up to now-16min + IEX after it (merged); snapshots and the stream use IEX
    iex -> IEX only. The UI labels these iex / sip / sip+iex.

4.3 Live stream (live/hub.py)
    Free plans allow ONE market-data stream connection (30 symbols). The hub:
      - holds the only upstream connection and fans messages out to browser sockets per symbol
      - rebuilds the upstream (close old, then open new) whenever the set of watched symbols changes, debounced
        0.3 s, so switching ticker terminates the old connection; no watchers = no connection
      - coalesces trades to ~4 pushes/s per symbol ({p, hi, lo, v, t, n}); quotes to the latest; forwards
        minute bars, updated bars and daily bars as they arrive
      - reconnects with backoff (2 s .. 30 s); auth failure (402) stops; connection-limit (406) shows "limit"
    Browser messages: {type: status|tick|quote|bar, ...}  (frontend/src/types/api.ts has the exact shapes)
    /api/live/status -> upstream.opened_total / closed_total / open.local_port to verify closure.


5. FRONTEND  (frontend/)
------------------------
Layering - imports only point downwards:

    App.tsx               composition + wiring between hooks
        |
    components/*          presentational React components (props in, callbacks out)
        |
    hooks/*               state, data loading, timers, WebSocket lifecycle
        |
    chart/ services/      imperative chart engine; REST + WebSocket clients
        |
    config/ lib/ types/   constants, pure helpers, API types (no React)

Project files
    index.html            Vite entry HTML (mount point #root, favicon)
    package.json          scripts: dev, build, typecheck, preview. Versions are pinned exactly.
    tsconfig.json         strict TypeScript
    vite.config.ts        dev server :5173, proxy /api and /ws -> :8000, build -> dist/

src/main.tsx              createRoot + StrictMode + global CSS
src/App.tsx               Page layout and data flow:
                            useChartSettings -> useBars -> ChartCard / HistoryTable
                            symbol -> useQuote + useLiveStream -> QuoteHeader, chart live candle (via ref)
                            usePolling -> slow REST reconciliation (fast fallback when the stream is down)
                          Live ticks go to the chart through a ref (PriceChartHandle.applyTick) so they do not
                          re-render React; the history table is told to re-read via a version counter.

types/
    api.ts                Backend response types (Quote, BarsPayload, BarColumns, Health, Clock, Asset) and live
                          message types (StreamStatus, TickMessage, QuoteMessage, BarMessage).

config/  (constants, no React)
    timeframes.ts         TF_LABEL, TF_UNIT, RANGE_BUTTONS, RANGE_TFS (intervals allowed per range),
                          RANGE_DEFAULT_TF, OLDER_STEP_DAYS (scroll-back step), isIntraday, effectiveTimeframe.
    indicators.ts         IndicatorKey, IndicatorParams, PRESETS per interval, INDICATOR_ROWS (menu layout),
                          DEFAULT_ENABLED, get/setField, validateField, paramQuery (-> /api/bars query).
    feeds.ts              feed display names.

lib/  (pure helpers)
    format.ts             price/pct/volume/compact formatting, ET date formatting, barTime (chart time -> text),
                          etEpoch (ISO -> chart time).
    storage.ts            localStorage load/save with "qtm." prefix, failure-safe.
    csv.ts                bars -> CSV (indicator columns named by their lengths, e.g. sma_20) + download.
    stream.ts             streamView(): stream state -> badge tone/text and detail text.

services/  (network, no React)
    api.ts                fetch wrapper (ApiError with status + server detail), endpoints: health, clock,
                          search, quote, bars.
    liveFeed.ts           LiveFeed: one WebSocket per tab; open(symbol) closes the previous socket first;
                          keep-alive ping 25 s; auto-reconnect with backoff; closes on pagehide.

chart/  (imperative, no React)
    ChartEngine.ts        Lightweight Charts wrapper: price pane (candles | OHLC | line) + overlays + volume,
                          RSI pane, MACD pane; scroll + crosshair sync; setData (incremental tail update,
                          prepend-with-stable-view for scroll-back, full replace for new lengths), applyTick
                          (live candle), setType, setIndicators, onNeedOlder when scrolled past the left edge,
                          onLegend callback.
    legend.ts             buildLegend(): pure legend model (OHLC, change, indicator values).
    buckets.ts            bucketFor(): which bar a live trade belongs to; inRegularSession().
    theme.ts              colours and OVERLAYS (series definitions with labels from params). Bollinger: bold
                          cyan bands + dashed middle; VWAP: dashed pink.
    bandSeries.ts         BandFillSeries - custom series that shades the area between the Bollinger bands (the
                          library has no built-in fill-between); created before the price series so it sits under
                          the candles.
    markers.ts            analysis -> markers: short-term entries S (up-arrows below), take-profits TS (down-arrows
                          above), trade exits (dots labelled with the return); green = signal right, red = wrong,
                          blue = open. latestDecisions() for the newest candle. Price lines: today's profit-take /
                          stop-loss and an open trade's levels. ChartEngine.setMarkers / setPriceLines draw them
                          (markers only on bars that exist in the loaded data, re-applied after data / type changes).

hooks/
    useChartSettings.ts   reducer for symbol, range, interval, custom dates, chart type, extended hours,
                          enabled indicators, per-interval indicator overrides. Derives timeframe + params.
                          Persists to the URL (?symbol=&range=&tf=&from=&to=) and localStorage.
                          Opens on DEFAULT_SYMBOL (SPY) unless the URL names a symbol.
    useBars.ts            loads bars with modes fit | replace | silent | older; aborts superseded requests,
                          drops stale responses, keeps scroll-back position (load_from); exposes overlay +
                          busy note. isLiveRange().
    useQuote.ts           REST quote + applyTick / applyLiveQuote merges from the stream.
    useLiveStream.ts      owns a LiveFeed; reopens on symbol change; returns StreamStatus.
    useHealth.ts          /api/health; re-checks every 5 s until credentials are configured.
    useClock.ts           /api/clock every 60 s.
    useBanner.ts          page banner state + showApiError (friendly text per HTTP status).
    usePolling.ts         interval with latest-callback semantics.
    useAnalysis.ts        runs /api/analysis on demand (always retrains); keeps the query it was trained on
                          (App.tsx hides the markers + shows "stale" when range / interval / extended / custom
                          dates differ); cleared on symbol change; marker visibility (SELL starts hidden when
                          unreliable); profit-take / stop-loss multiples (localStorage); refreshes the 5-minute
                          check every minute while results are shown.
    useRecentSymbols.ts   last 10 symbols in localStorage.

components/
    layout/SiteHeader.tsx       brand, primary nav, SearchBox
    layout/SubNav.tsx           secondary tabs + market open/closed
    layout/Banner.tsx           error / warning bar (with .env hint)
    layout/SiteFooter.tsx       data notes + TradingView attribution (required by the chart library licence)
    search/SearchBox.tsx        debounced autocomplete, arrow keys, Enter, click
    quote/QuoteHeader.tsx       name, price (flash on change), change, as-of, bid/ask/volume
    quote/LivePill.tsx          LIVE / CONNECTING / RECONNECTING / STREAM BUSY / STREAM OFF badge
    quote/RecentSymbols.tsx     recent-symbol chips
    sidebar/KeyStatistics.tsx   open, prev close, ranges, volumes, VWAP + RangeBar x2
    sidebar/RangeBar.tsx        low-high track with price marker
    sidebar/SecurityDetails.tsx exchange + tradability flags
    sidebar/DataSource.tsx      provider, feed, stream state, account, next open/close
    chart/ChartCard.tsx         card frame + status note, ChartToolbar, PriceChart
    chart/ChartToolbar.tsx      ranges, interval, chart type, IndicatorMenu, extended hours, custom dates
    chart/IndicatorMenu.tsx     toggles + editable lengths; per-field validation; debounced commit that
                                captures the interval at edit time
    chart/PriceChart.tsx        hosts ChartEngine (create/dispose), forwards props, exposes applyTick via ref,
                                renders legend, panes, loading/empty overlay
    chart/ChartLegend.tsx       renders the legend model
    history/HistoryTable.tsx    paged OHLCV table (newest first) + CSV button
    analysis/AnalysisPanel.tsx  "Short-term BUY & SELL Analysis" card: progress, stale notice, marker legend,
                                Current K panel, reading guide, BUY + SELL cards, the two decision tables,
                                relations, method
    analysis/CurrentKPanel.tsx  current K line: BUY / SELL decision combined with the 5-minute check, BUY entry plan
                                (entry, profit-take, stop-loss, chase limit) vs the live price, setup checklists
    analysis/TargetCard.tsx     BUY or SELL: profit-take / stop-loss editor + exit rule (BUY), open trade,
                                "This chart range" (decisions, justified vs setup-only vs any bar, BUY trades vs
                                any-bar entry, buy & hold), "Model check" over >= 1,260 bars (verdict, AUC, by
                                setup, trade backtest), marker toggle, factor-group importance
    analysis/DecisionTable.tsx  30 most recent BUY (or SELL) decisions, newest first: setup, P, entry / levels,
                                outcome, trade exit; rows inside the chart range highlighted, older ones dimmed
    analysis/util.ts            formatting helpers shared by the cards and tables (pct, span, rule text...)
    analysis/ReadingGuide.tsx   plain-language explanation of every number in the panel
    analysis/FactorRelations.tsx correlation / beta / lead table for SPY, QQQ, VIX, oil, gasoline, rate
    ("Find entry points" button lives in chart/ChartCard.tsx; it retrains on the chart as shown)

styles/global.css         the whole look (brokerage-research style: white surfaces, #368727 green, grey rules).
                          Class names are used directly by components; no CSS-in-JS.


6. CONVENTIONS
--------------
6.1 Time encoding. Chart times are epoch seconds of the *New York wall-clock* time (encoded as if UTC), so the
    chart library, which renders UTC, shows ET without time-zone code. Backend: core/timeutil.et_epoch().
    Frontend: lib/format.barTime() (format with timeZone UTC), lib/format.etEpoch() for live trades.
6.2 Indicator lengths are in BARS of the chosen interval. Presets differ per interval (config/indicators.ts
    PRESETS); user edits are stored per interval. Changing the interval recalculates everything; changing the
    range only changes the view (daily+ always has full history loaded).
6.3 Positional indicator columns (sma1..3, ema1..2) + `params` in the payload. Labels/CSV names are derived
    from params, never hard-coded.
6.4 Errors: backend raises ApiError -> {"detail"}; frontend ApiError carries status + detail; useBanner maps
    status to friendly text (503 = missing .env credentials).
6.5 Nothing in the app places orders.


7. HOW TO EXTEND
----------------
Add an indicator
    1. backend/app/indicators/params.py   add the length(s) to IndicatorParams + parse_params + warmup_bars
    2. backend/app/indicators/compute.py  add the column in compute_all
    3. backend/app/api/routes/bars.py     add the query parameter
    4. frontend/src/config/indicators.ts  add to IndicatorKey, IndicatorParams, PRESETS, INDICATOR_ROWS, paramQuery
    5. frontend/src/types/api.ts          add the column / params field
    6. frontend/src/chart/theme.ts        overlay entry (price pane) - or a new pane in ChartEngine + PriceChart
    7. frontend/src/chart/legend.ts, lib/csv.ts   legend item / CSV column name
    8. tests in backend/tests/test_indicators.py

Add an endpoint
    service function in services/ (logic) -> route module in api/routes/ (exposes `router`)
    -> include it in api/__init__.py -> client function in frontend/src/services/api.ts -> hook -> component.

Change the entry definitions
    backend/app/quant/targets.py SHORT / LONG (horizon, up_atr, down_atr, cooldown, model). Nothing else changes;
    the UI reads the spec from the payload.

Add a market / macro factor
    yahoo_api/client.py FACTORS -> quant/features.py (features + group) -> it appears in relations automatically.


8. SHORT-TERM BUY & SELL ANALYSIS (Find entry points)
-----------------------------------------------------
Runs on the chart AS SHOWN: same symbol, range, interval and extended-hours setting. Every click retrains.
Works on 1-minute to weekly bars; monthly is refused (Alpaca history since 2016 = ~130 monthly bars).
Long-term entries were removed for now (to be redesigned); quant/model.py keeps the "logistic" model kind and
quant/trades.py the trailing-stop exit for that work.

BUY = setup AND model:
    Setup (quant/setups.py, on the analysed bars):
      rebound  falling momentum easing: below SMA20 and down over 5 bars (or RSI < 40 recently), plus >= 2 of:
               MACD histogram < 0 but rising | RSI turning up from a low | higher low or long-lower-wick candle
      trend    clear bullish trend: close > SMA20 > SMA50, both rising, ADX(14) >= 20, above SMA200 when available
    Model: P(profit-take before stop-loss within 5 trading sessions) >= training base rate + 10 pts.
    Label (quant/targets.py SHORT): price reaches entry + tp x DAILY ATR (default 1.5, adjustable 0.5-5) before
    entry - sl x DAILY ATR (default 1, adjustable 0.25-5) within 5 trading sessions - on every interval (intraday:
    through the same time of day 5 sessions later; weekly: the next bar). A bar touching both counts as a stop.
SELL (take profit) = interim-top setup AND model:
    top  extended (above SMA20 and up over 10 bars, or RSI > 65 recently) plus >= 2 of: MACD histogram > 0 but
         falling | RSI turning down from a high | lower high or long-upper-wick candle | close back below the
         prior close right after a new 20-bar high
    Model: P(1.5 daily-ATR pullback before a 1 ATR rise within 5 sessions) >= base rate + 10 pts.
Momentum-shift values and the setup flags are also model features (group "Momentum shift & setups").

Current K line (components/analysis/CurrentKPanel.tsx):
    - Decision on the newest candle (model from all outcomes known now + the setup on that candle), shown even inside
      a marker cooldown; drawn on the chart as "BUY" / "SELL" (black) or "BUY –" / "SELL –" (grey).
    - BUY plan: entry = the candle's price when the model decided; profit-take, stop-loss, chase limit
      (entry + 0.25 daily ATR). The live price (quote stream) is classified: inside the entry zone, below the entry
      (better price, reward:risk shown), above the chase limit (wait), at/above profit-take, at/below stop-loss.
      Drawn as dashed "BUY entry" / "Profit-take" / "Stop-loss" price lines.
    - Today's 5-minute check (quant/intraday.py, refreshed every minute via /api/analysis/{sym}/intraday):
      VWAP, last hour, 5-min RSI direction, lows, day-range position -> score; BUY + "supports" = confirmed,
      "mixed" = unconfirmed, "against" = WAIT; same for SELL with the sign flipped. Not part of the backtest
      (historical markers use setup + model only).
    - The model decision is not re-run automatically as the live K line develops; press Find entry points again.

Trade exits for every BUY (quant/trades.py): profit-take | stop-loss | a SELL signal while in profit | the close
after 5 sessions. Gaps fill at the open. Compared with "any-bar entry" (same exits on every bar).

Data: the interval's Alpaca bars (same as the chart), the stock's Alpaca daily bars (daily ATR, market-relation
features, relations table), today's Alpaca 5-minute bars, Yahoo Finance daily closes for SPY, QQQ, ^VIX, CL=F,
RB=F, ^IRX (13-week T-bill yield, the Fed-rate proxy). Factor alignment (no look-ahead): daily bars use that day's
values, weekly bars the end of the week, intraday bars the previous day's.

Model and validation:
    - ~55 features per bar, all computable at that bar's close (tested).
    - Two windows (analysis_service.eval_window -> r0, w0, w1):
        chart range  [r0, w1) = exactly the bars on the chart (1D = the latest session, 1Y = the last year).
                     Signals carry in_range; payload range_window + per target range_stats and trades.range_*.
                     The chart markers, the "This chart range" block and the highlighted table rows use it.
        model check  [w0, w1) = the chart range widened to at least 1,260 bars of the same interval (5 years on
                     Daily, ~3 weeks on 5-minute). Verdict, AUC, by-setup and the window backtest use it, so a
                     1D chart is not judged on a handful of decisions.
    - Walk-forward: every max(21, window/60) bars a gradient-boosted-trees model is trained on the preceding 1,260
      bars whose outcome was ALREADY KNOWN and predicts the next block -> every marker is out-of-sample.
    - One signal per cooldown (5 bars on Daily, one hour intraday).
    - Verdict: "reliable" only if AUC >= 0.53 AND signals hit more often than the base rate (AUC < 0.47 = worse than
      chance). Stats also show "Setup only" (every setup bar, no model) to see what the model adds over the rules.
    - Markers (chart range only) by default: BUY always on; SELL on only when that model is reliable; trade-exit
      dots on. The current K line's decision is always drawn.
    - UI lists the 30 most recent BUY and SELL decisions (components/analysis/DecisionTable.tsx), including those
      before the chart range (dimmed, tagged "before chart range").
Observed (Daily, 5-year windows, Nov 2026; SPY QQQ AAPL MSFT NVDA JPM): the setups alone hit at about the base rate
(~30%); setup + model adds a few points at best, not consistently (SPY 32-33% vs 31% setup-only vs 30% any bar;
MSFT worse). Trend BUYs beat rebound BUYs on most symbols (SPY 38% vs 24%). SELL is near chance for most.
Research output, not advice.

Next phase - suggested placement for more models / strategies
    backend/app/quant/         new pure modules (features, labels, models)
    backend/app/services/      orchestration (fetch -> features -> model -> result)
    backend/app/api/routes/    endpoints exposing results
    frontend: new hooks + components; the "Signals" / "Model" tabs in SubNav are placeholders for them.
