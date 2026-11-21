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
                   model, trailing-stop settings, exit_with). SHORT / LONG entries, TP_SHORT / TP_LONG take-profits;
                   Wilder atr(); triple_barrier() -> label (1/0/NaN), resolved_at (bar on which the outcome became
                   known), outcome (target / stop / expired / pending). Direction-aware.
    trades.py      simulate(): trade one entry (stop, target, optional trailing stop, optional take-profit signal,
                   time limit; gap fills at the open; conservative same-bar rule); short-term entries run as plain
                   bracket orders. summarize(): win rate, avg/median return, R, profit factor, holding bars, reasons.
    cost_check.py  average_cost_check(): long-term validation - equal-dollar buys at every long-term entry, average
                   cost (harmonic mean) vs the SMA 60, running checkpoints, comparison with buying every bar.
    features.py    stock_features() on the analysed interval's bars + market_features() per day (stock daily closes +
                   Yahoo factors), attached to bars by align(): "same" (daily), "week_end" (weekly), "previous"
                   (intraday - previous day's values only). build_features() combines them; ~40 features, each
                   tagged with a group in GROUPS (Stock momentum, Stock trend, Stock volatility & volume, SPY, QQQ,
                   VIX, Oil & gasoline, Interest rate).
    model.py       make_model(kind), train_mask() (no-look-ahead rule), walk_forward(), fit_latest(),
                   threshold_for(), reliability() verdict, group_importance() (permutation importance by group).
    relations.py   factor_relations(): correlation (5y, 60d), beta (SPY/QQQ), 5-day lead correlation per factor.

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
    routes/analysis.py GET /api/analysis/{symbol}?range=&timeframe=&start=&end=&extended=&refresh=
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
    theme.ts              colours and OVERLAYS (series definitions with labels from params).
    markers.ts            analysis -> markers: entries S / L (up-arrows below), take-profits TS / TL (down-arrows
                          above), trade exits (dots labelled with the return); green = signal right, red = wrong,
                          blue = open. Price lines: today's entry target/stop and open trades' stop/target. ChartEngine.setMarkers / setPriceLines draw them (markers only on bars that
                          exist in the loaded data, re-applied after data or chart-type changes).

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
    useAnalysis.ts        runs /api/analysis on demand; cleared on symbol change; per-target marker visibility
                          (targets judged unreliable start hidden).
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
    analysis/AnalysisPanel.tsx  "Entry & Take-Profit Analysis" card: progress, marker legend (+ exits toggle),
                                reading guide, entry cards, take-profit cards, relations, method
    analysis/TargetCard.tsx     one target (entry or take-profit): verdict, today's signal, open trade, 5-year
                                record, trade backtest vs any-day entry (entries), marker toggle, latest signals
                                with outcome + trade exit, factor-group importance
    analysis/ReadingGuide.tsx   plain-language explanation of every number in the panel
    analysis/FactorRelations.tsx correlation / beta / lead table for SPY, QQQ, VIX, oil, gasoline, rate
    analysis/DecisionStrip.tsx   one-line decision per target for the latest analysed K line
    ("Find entry points" button lives in chart/ChartCard.tsx; it switches the chart to 5Y Daily and runs the analysis)

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


8. ENTRY & TAKE-PROFIT ANALYSIS (Find entry points)
---------------------------------------------------
Runs on the chart AS SHOWN: same symbol, range, interval and extended-hours setting. Every click retrains.
Works on 1-minute to weekly bars; monthly is refused (Alpaca history since 2016 = ~130 monthly bars).

Definitions (price = the bar's close; a bar touching both levels counts as a stop; neither in time = expired):
    Short-term entry (S)        JUSTIFIED if the profit-take (+1.5 x DAILY ATR, adjustable 0.5-5) is reached before the
                                stop-loss (-1 x DAILY ATR, adjustable 0.25-5) within 5 TRADING SESSIONS - on every
                                interval (intraday: through the same time of day 5 sessions later; weekly: next bar).
                                Daily ATR is the one known at the bar (previous day's on intraday bars).
    Short-term take-profit (TS) -1.5 daily ATR (pullback) before +1 daily ATR within 5 trading sessions.
    Long-term entry (L)         +3 ATR before -2 ATR within 60 bars of the interval (interval ATR).
    Long-term take-profit (TL)  -3 ATR (pullback) before +2 ATR within 60 bars.
    Outcome names in the UI: S Justified / Not justified (SL hit / expired); L Target hit / Stopped out / Expired;
    take-profits Pullback came / Kept rising.
    TP / SL multiples come from the short-term card (query tp_atr / sl_atr); changing them retrains the models.

Long-term validation (quant/cost_check.py): the model picks the L entries; each is treated as buying the same dollar
amount. The logic is VALIDATED if the overall average cost of all those buys is below the current SMA 60 of the
interval. Shown with running checkpoints, "bought X% cheaper/dearer than buying every bar", and on the chart as the
average-cost step line + dashed SMA 60 (lines never rescale the price axis).

Trade exits (quant/trades.py):
    S: bracket order - profit-take, stop-loss, or the close at the end of 5 sessions.
    L: first of stop -2 ATR | target +3 ATR | trailing stop 2 ATR below the highest close once the close is +1 ATR up |
       TL take-profit signal while in profit | 60 bars.
    Gaps through stop/target fill at the open. ATR fixed at entry. Returns before costs. Compared with "any-bar
    entry" (the same exits on every bar); the panel states whether trading the signals beat it.

Data: the interval's Alpaca bars (same as the chart), the stock's Alpaca daily closes (for market-relation features
and the relations table), Yahoo Finance daily closes for SPY, QQQ, ^VIX, CL=F (WTI crude), RB=F (RBOB gasoline),
^IRX (13-week T-bill yield - Yahoo has no Fed funds series; ^IRX tracks it).
Factor alignment (no look-ahead): daily bars use that day's values, weekly bars the values at the end of the week,
intraday bars the PREVIOUS day's values.

Model and validation:
    - ~40 features per bar, all computable at that bar's close (tested, including the alignment modes).
    - Evaluation window = the chart's range, widened to at least 1,260 bars (5 years on Daily) so the verdict has
      enough history. Data fetched: daily/weekly since 2016; intraday enough bars for warm-up + training + window.
    - Walk-forward: every max(21, window/60) bars a model is trained on the preceding 1,260 bars whose outcome was
      ALREADY KNOWN (train_mask: resolved strictly before the prediction bar) and predicts the next block. Every
      chart marker is an out-of-sample prediction.
    - 5-bar targets use gradient-boosted trees, 60-bar targets a regularised logistic regression (chosen from an
      out-of-sample comparison on SPY, QQQ, AAPL, MSFT, NVDA, JPM daily: short 0.55 trees; long 0.49 trees vs
      0.52 logistic).
    - Signal: P(success) >= training base rate + 15 pts (bounded 0.30-0.85), max one per cooldown (5 / 20 bars).
    - Verdict per target: "reliable" only if out-of-sample AUC >= 0.53 AND signals hit more often than the base rate
      (AUC < 0.47 is reported as worse than chance).
    - Markers by default: S and L always on; TS / TL on only when that model is reliable; trade-exit dots on.
    - Latest K line: every target's current decision is drawn on the newest analysed candle regardless of the
      cooldown - "S BUY" / "L BUY" (black up-arrow), "TS SELL" / "TL SELL" (black down-arrow), "S –" (grey dot) for
      no entry / hold, "?" when the model has no reliable edge - and summarised in the panel's decision strip
      (chart/markers.ts latestDecisions(), components/analysis/DecisionStrip.tsx).
      Markers are drawn only while the chart shows the analysed interval (otherwise the panel flags the result
      as stale with a one-click retrain).
    - "Today": a model trained on all outcomes known now scores the latest bar; entry/target/stop shown and,
      when it signals, drawn as dashed price lines; an entry still inside its horizon shows as an open trade.
    - Factor groups: permutation importance (ROC-AUC drop) on the last 252 bars of the window, summed per group.
    - Relations: daily correlations (5y and 60d), beta to SPY/QQQ, and 5-day lead correlation (always daily).
Observed (SPY, Nov 2026): short-term edge on Daily (AUC ~0.59) and 4-hour (~0.59); near or below chance on 1- and
5-minute bars, where moves are mostly noise. Cost: 5-30 s per click. Research output, not advice.

Next phase - suggested placement for more models / strategies
    backend/app/quant/         new pure modules (features, labels, models)
    backend/app/services/      orchestration (fetch -> features -> model -> result)
    backend/app/api/routes/    endpoints exposing results
    frontend: new hooks + components; the "Signals" / "Model" tabs in SubNav are placeholders for them.
