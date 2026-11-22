# Quant Trading Model V3 (Web): Developer Guide

A quote & chart research app on Alpaca market data: historical and live K-line (candlestick) charts with
indicators, plus an on-demand quantitative **short-term BUY & SELL analysis** ([section 8](#8-short-term-buy--sell-analysis)).
**Nothing in the app places orders.**

| Part | Stack | Folder |
|---|---|---|
| Backend | Python 3.11+, FastAPI, httpx, pandas, scikit-learn, websockets | `backend/` |
| Frontend | React 18 + TypeScript, Vite 5, Lightweight Charts 4.2.0 | `frontend/` |

## Contents

1. [Running](#1-running)
2. [Repository layout](#2-repository-layout)
3. [Backend](#3-backend)
4. [Backend behaviour worth knowing](#4-backend-behaviour-worth-knowing)
5. [Frontend](#5-frontend)
6. [Conventions](#6-conventions)
7. [How to extend](#7-how-to-extend)
8. [Short-term BUY & SELL analysis](#8-short-term-buy--sell-analysis)
9. [Backtests page](#9-backtests-page)
10. [Next phase](#10-next-phase)

---

## 1. Running

### First time

```powershell
pip install -r requirements.txt
cd frontend; npm install
```

### Development (hot reload on both sides)

```powershell
.\dev.ps1        # or dev.bat if PowerShell scripts are blocked
```

- Opens a window running the backend on <http://127.0.0.1:8000> (auto-reload on `.py` changes).
- Runs Vite on <http://127.0.0.1:5173>. **Open this one.** Vite proxies `/api` and `/ws` to `:8000`.

Or by hand, in two terminals:

```powershell
python -m uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
cd frontend; npm run dev
```

### Production-style (one server)

```powershell
.\run.ps1          # or run.bat: builds frontend/dist if missing, then serves UI + API on :8000
.\run.ps1 -Build   # force a rebuild first
```

FastAPI checks for `frontend/dist` on every request, so `npm run build` while the server runs just works.

### Tests and checks

| Command | What it checks |
|---|---|
| `python -m pytest` | backend tests (fake Alpaca, no network) |
| `cd frontend; npm run typecheck` | TypeScript |
| `cd frontend; npm run build` | typecheck + production bundle |

### Configuration

`.env` in the project root, re-read automatically when it changes:

```ini
ALPACA_API_KEY=...
ALPACA_SECRET_KEY=...
ALPACA_ENDPOINT=https://paper-api.alpaca.markets
ALPACA_DATA_FEED=auto        # auto | iex | sip  (see 4.2)
```

- Other common names (`APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`, `APCA_API_BASE_URL`, ...) are accepted.
- `.env` is git-ignored; `.env.example` documents the variables.

---

## 2. Repository layout

| Path | Purpose |
|---|---|
| `.env` / `.env.example` | credentials (never committed) / template |
| `requirements.txt` | Python dependencies |
| `pytest.ini` | test discovery (`backend/tests`) |
| `run.ps1`, `run.bat` | production-style run (build if needed + serve) |
| `dev.ps1` | development run (backend window + Vite) |
| `README.md` | short overview |
| `dev.md` | this file (developer guide) |
| `backend/` | Python API ([section 3](#3-backend)) |
| `frontend/` | React app ([section 5](#5-frontend)) |

---

## 3. Backend

All backend code is in `backend/app`. **Layering: imports only point downwards.**

```text
api/routes    HTTP / WebSocket only: parse + validate input, call a service, return JSON
    |
services      business logic (no HTTP types); unit-testable with a fake Alpaca
live          live-stream hub (WebSocket fan-out)
    |
indicators    pure pandas maths (chart indicators)
quant         pure analysis maths (labels, features, models, setups, levels, simulations)
alpaca_api    everything that talks to Alpaca
yahoo_api     everything that talks to Yahoo Finance
    |
core          settings, errors, time + symbol helpers (imports nothing from the app)
```

> **Rule of thumb:** a route never calls Alpaca directly, and only `alpaca_api/` knows Alpaca URLs and field names.

### `main.py`

`create_app()` installs the error handlers and includes `api_router`. It also adds the catch-all that serves the
built React app from `frontend/dist` (`index.html` for unknown paths, real files for assets; `/api` and `/ws` paths
are never swallowed). Lifespan shutdown closes the live hub and the shared HTTP client. `app = create_app()` is what
uvicorn loads.

### `core/`

| File | Contents |
|---|---|
| `config.py` | `Settings` dataclass from `.env` (hot-reloaded by file mtime); accepts many variable names. Normalises the trading URL (adds https, strips `/v2`). Paths: `PROJECT_ROOT`, `ENV_PATH`, `FRONTEND_DIST`. |
| `errors.py` | `ApiError(status, message)` and `install_error_handlers()` → `{"detail": message}` JSON. Raise `ApiError` anywhere in a request to return a clean HTTP error. |
| `timeutil.py` | `ET` zone, `EARLIEST` (2016-01-01, start of Alpaca history), `iso()` for Alpaca timestamps, `et_epoch()` for the chart time encoding ([6.1](#61-time-encoding)), `et_date()`. |
| `symbols.py` | `clean_symbol()` / `require_symbol()`: ticker validation (`[A-Z][A-Z0-9.-]{0,9}`). |

### `alpaca_api/`

| File | Contents |
|---|---|
| `http.py` | Shared `httpx.AsyncClient`, auth headers, `AlpacaError` (subclass of `ApiError`, so Alpaca status codes pass through), `get()`, `data_get()` with optional SIP → IEX fallback on 403. |
| `market_data.py` | `fetch_bars()`: one feed, paginated newest-first so a cap keeps the latest bars, returned oldest-first. `fetch_snapshot()`. |
| `feeds.py` | Which feed to use ([4.2](#42-data-feeds)): `resolve_feed_mode()` probes once; `feed_mode()`, `feed_label()`, `live_feed()`. `get_bars()` = deepest history + live tail (hybrid merge via `merge_tail()`). `get_snapshot()`. **Services call `feeds.*`, never `market_data.*` directly.** |
| `trading.py` | `get_clock()`, `get_asset()`, `list_assets()` (cached 12 h, for search). Reference data only. |

### `yahoo_api/`

| File | Contents |
|---|---|
| `client.py` | `FACTORS` (spy `SPY`, qqq `QQQ`, vix `^VIX`, oil `CL=F`, gasoline `RB=F`, rate `^IRX`) and `fetch_factors(start)`: daily **raw** closes via yfinance (`auto_adjust=False`: Yahoo's dividend-adjusted closes differ by ~$0.0002 on every download, which made identical trainings disagree; raw closes are identical every time), forward-filled, cached in memory for 4 h. Synchronous, so call it in a worker thread. Raises `ApiError(502)` when Yahoo fails. |

### `quant/` (pure functions, no I/O)

| File | Contents |
|---|---|
| `targets.py` | `TargetSpec` (kind `entry`/`take_profit`, direction, horizon, `target_atr`, `stop_atr`, cooldown, model, trailing-stop settings, `exit_with`, `horizon_mode`, `atr_basis`, `bracket`). `SHORT` (BUY) and `TP_SHORT` (SELL). Wilder `atr()`. `triple_barrier()` → label (1 / 0 / NaN), `resolved_at` (bar on which the outcome became known), outcome (target / stop / expired / pending); direction-aware; optional per-bar `levels`. |
| `brackets.py` | `Levels` + `fixed_levels()`: profit-take / stop-loss per bar = entry ± multiples of the daily ATR (the user's, or the optimized ones), with a short "basis" text per bar (`1.5 ATR`, `optimized`). |
| `accum.py` | BUY model for the sell-signal strategy ([8.1b](#81b-buy-s--buy-for-the-sell-signal-strategy)): `next_sell_labels()` (1 = a lot bought on the bar is sold at a profit at the next SELL decision, 0 = at a loss, NaN while no SELL yet / before the SELL model existed; resolved at that SELL), `trade()` (held until the next SELL decision), `no_levels()` (no profit-take / stop-loss). |
| `optimize.py` | Optimized ATR ([8.3](#83-profit-take--stop-loss-levels)): `run_combo()` (labels, walk-forward retrain and BUY trades for one profit-take × stop-loss combination), `score()` / `choose()` (best total return over trades closed in the last `LOOKBACK` bars, default until `MIN_TRADES`), `compose()` (one composite model: each block from the combination chosen at its start), `optimize()`. |
| `trades.py` | `simulate()`: trade one entry (stop, target, optional trailing stop, optional take-profit signal, time limit; gaps fill at the open; conservative same-bar rule; optional explicit levels). `summarize()`: win rate, avg / median return, R, profit factor, holding bars, exit reasons. |
| `backtest.py` | Backtests page ([section 9](#9-backtests-page)): `select()` / `select_sells()` (BUY / SELL decisions: setup, P ≥ threshold - the model's own per bar unless the user sets one - one per cooldown, most recent N BUYs), `backtest()` (the chosen scenario with both sell rules + YTD, a rebound / trend / both comparison, and how many decisions qualify per strategy). |
| `portfolio.py` | Simulation over the 30 most recent BUYs ([8.7](#87-100-simulation)): `run(sizing="usd"\|"share")` (every BUY buys a lot of $100 or 1 share; the next SELL sells every lot held; optionally each lot at its own profit-take / stop-loss first; totals + `by_setup` rebound / trend, max lots and money held at once), `simulate_decisions()` (both sizings × both variants + "same BUYs never sold" + one lot bought at the first BUY and held). Per transaction: `avg_return_pct`, `avg_win_pct` / `avg_loss_pct` (and $). Optional `year_start` → `summary.ytd` (P&L earned since Jan 1; lots held over the year end count from the previous year's last close). |
| `explain.py` | `explain_decision()`: what supported one decision (expanded decision row): the deciding fold's P vs threshold and base rate, `group_effects()` (P with the bar's real values minus P with one factor group at its training medians, per group), the setup checklist(s) on that bar, ~15 readable indicator values. |
| `features.py` | `stock_features()` on the analysed interval's bars + `market_features()` per day (stock daily closes + Yahoo factors), attached to bars by `align()`: `same` (daily), `week_end` (weekly), `previous` (intraday: previous day's values only). `build_features()` combines them: 54 features, each tagged with a group in `GROUPS` (Stock momentum, Stock trend, Stock volatility & volume, Momentum shift & setups, SPY, QQQ, VIX, Oil & gasoline, Interest rate). |
| `setups.py` | `compute_setups()`: rule-based setups per bar (`rebound`, `trend`, `top`), their component conditions and numeric momentum-shift values (MACD-histogram / RSI change, ADX, +DI−DI, wicks, streaks, bars since 20-bar high / low). `explain()` lists which conditions hold on a bar (the current K line in the UI). |
| `intraday.py` | `intraday_check()`: five checks on one session's 5-minute bars (VWAP, last hour, 5-min RSI direction, lows, position in the day range) → BUY / SELL score and verdict. |
| `projection.py` | `project()`: projected BUY entry / SELL price for the current K line ([8.4](#84-current-k-line)): re-evaluates setup + current models with the last bar closing at other prices (±3 daily ATR, 0.2 ATR grid refined to 0.05 ATR, features on the last 600 bars), returns the nearest trigger price per side, its zone, probability, levels and which side is closer. |
| `model.py` | `make_model(kind)`, `train_mask()` (no-look-ahead rule), `walk_forward(keep=, pre_start=, pre_step=)` - folds fitted in **parallel worker processes** (joblib, one thread each; identical results; `N_JOBS`, fewer than `PARALLEL_MIN_FOLDS` folds run in-process); `keep=True` keeps each fold's model + training medians (`WalkForward.fold_at(i)`); `pre_start` / `pre_step` add sparser folds before `start`. `fit_latest()`, `threshold_for()`, `reliability()` verdict, `group_importance()` (AUC drop when a whole factor group is shuffled together). |
| `relations.py` | `factor_relations()`: correlation (5 y, 60 d), beta (SPY / QQQ), 5-day lead correlation per factor. |

### `indicators/`

| File | Contents |
|---|---|
| `params.py` | `IndicatorParams` (frozen dataclass; lengths in bars): `sma`(3), `ema`(2), `bb_len`, `bb_mult`, `rsi`, `macd`(fast, slow, signal). `warmup_bars()` = bars needed before the first visible bar. `parse_params()` validates the query-string form (1–500, MACD fast < slow, BB length ≥ 2). |
| `compute.py` | `sma`, `ema`, `rsi` (Wilder), `vwap` (resets per session), `compute_all()` → positional columns `sma1 sma2 sma3 ema1 ema2 bb_mid bb_upper bb_lower rsi macd macd_signal macd_hist vwap`. Names are positional so they stay stable when lengths change; the lengths used are returned alongside as `params`. |

### `services/`

| File | Contents |
|---|---|
| `frames.py` | `bars_frame()`: Alpaca bar dicts → UTC-indexed DataFrame (`open high low close volume bar_vwap trades`). |
| `bars_service.py` | `build_bars(BarsRequest)`, the chart's data: range → display window (`display_window`); daily+ always loads full history from 2016; intraday loads the window (+ `load_from` for scroll-back); warm-up days from the indicator lengths (`warmup_days`); regular-session filter unless extended; indicators, trim, `view_start` / `has_more` / `truncated`, column-oriented JSON. Constants `TIMEFRAME_MINUTES`, `RANGE_DEFAULT_TF`, `SESSION_RANGES` (1D, 5D), `MAX_BARS`. Shared helpers `resolve_range()` (validate range + interval) and `fetch_frame()` (an interval's bars exactly as the chart shows them). |
| `quote_service.py` | `build_quote()`: asset + snapshot + ~1 y daily bars (cached 15 s) → price, change vs previous close, day OHLCV, 52-week range, average volumes. `day_and_prev()` handles pre-market (latest daily bar is yesterday's session). |
| `search_service.py` | `rank()`: exact symbol, then symbol prefix, then name contains. `search()`. |
| `analysis_service.py` | `run_analysis(AnalysisRequest(symbol, range, timeframe, start, end, extended, tp_atr, sl_atr, bracket))`: the chart's bars + the stock's daily bars + Yahoo factors → `compute()` in a worker thread → payload ([section 8](#8-short-term-buy--sell-analysis)). `eval_window()` → `(r0, w0, w1)` = chart range and model-check window. The UI always sends `refresh=true` (each click retrains); results are also cached 10 minutes per request. Each run gets a `run_id`; its backtest data (every BUY-setup bar of the model-check window with its out-of-sample P and first profit-take / stop-loss hit, the SELL decisions, the last bar, the year start) is kept in memory (`_runs`, the last 30 runs) for `run_backtest()`. |

### `live/` and `api/`

| File | Contents |
|---|---|
| `live/hub.py` | `LiveHub` ([4.3](#43-live-stream)); `hub` is the process-wide instance. |
| `api/__init__.py` | `api_router` = all route modules combined. |
| `api/routes/system.py` | `GET /api/health`, `GET /api/clock` |
| `api/routes/search.py` | `GET /api/search?q=` |
| `api/routes/quote.py` | `GET /api/quote/{symbol}` |
| `api/routes/bars.py` | `GET /api/bars/{symbol}` (query parameters documented in the signature; see `/docs`) |
| `api/routes/analysis.py` | `GET /api/analysis/{symbol}` and `GET /api/analysis/{symbol}/intraday` (today's 5-minute check; the UI polls it every minute) |
| `api/routes/backtest.py` | `GET /api/backtest/{run_id}` (Backtests page) |
| `api/routes/live.py` | `WS /ws/live/{symbol}`, `GET /api/live/status` |

### `backend/tests/`

| File | Covers |
|---|---|
| `conftest.py` | `fake_alpaca` fixture (monkeypatches feeds / trading with deterministic synthetic bars), `client` fixture (FastAPI `TestClient`). Async tests use `pytest.mark.anyio`. |
| `test_indicators.py` | maths + parameter validation |
| `test_feeds.py` | hybrid merge |
| `test_services.py` | ranges, warm-up, session filter, extended hours, scroll-back (`load_from`), quote logic, search ranking |
| `test_api.py` | route-level shapes and error codes |
| `test_quant.py` | triple-barrier labels, no-look-ahead training mask, walk-forward, thresholds, verdicts |
| `test_trades.py` | bracket / trailing / SELL-signal / time exits, gap fills, open trades |
| `test_setups.py` | rebound / trend / interim-top setups, `explain()`, the 5-minute check |
| `test_projection.py` | projected prices = the nearest trigger (stub models), zone, closer side, "now" case |
| `test_backtest.py` | decision selection (setup, threshold, cooldown, N), YTD accounting, per-trade averages, comparison, missing run / bad parameters |
| `test_brackets_portfolio.py` | fixed levels, simulation (lots, SELL sells all, bracket exits, same-bar order, per-setup totals, 1-share sizing) |
| `test_analysis_service.py` | full analysis pipeline on synthetic data (fixed + optimized levels, range window, simulation, projection, decision explanations); features unchanged by later bars |
| `test_vectorised.py` | the vectorised labeler (`triple_barrier`) and trade simulator (`simulate`, plain bracket) give exactly the results of the original bar-by-bar loops (random markets, horizons 5 / 20 / 80 bars) |
| `test_backtest.py` / `test_brackets_portfolio.py` | also: each strategy uses its own BUY model's decisions and period |
| `test_optimize.py` | optimizer: scores only trades closed before a block (no look-ahead) and inside the look-back, best-profit choice with minimum trades and default fallback, per-block composition |

---

## 4. Backend behaviour worth knowing

### 4.1 API

Interactive docs: <http://127.0.0.1:8000/docs>

| Endpoint | Parameters | Returns |
|---|---|---|
| `GET /api/health` | | `{configured, account: paper\|live, trading_url, feed}` |
| `GET /api/clock` | | Alpaca clock `{is_open, next_open, next_close, ...}` |
| `GET /api/search` | `q` | `[{symbol, name, exchange}]` (max 10) |
| `GET /api/quote/{sym}` | | quote header + key statistics (see `services/quote_service.py`) |
| `GET /api/bars/{sym}` | `range=1D\|5D\|1M\|3M\|6M\|YTD\|1Y\|3Y\|5Y\|10Y\|MAX\|CUSTOM`, `timeframe=1Min..1Month`, `start` / `end` (CUSTOM, `YYYY-MM-DD`, end inclusive), `extended=true`, `load_from=YYYY-MM-DD` (intraday scroll-back), `sma=20,50,200`, `ema=12,26`, `bb=20,2`, `rsi=14`, `macd=12,26,9` | `{symbol, range, timeframe, intraday, feed, params, count, truncated, has_more, view_start, load_from, start, end, columns: {time, open, ...}}` |
| `GET /api/live/status` | | hub state, watched symbols, upstream open / closed counters |
| `GET /api/analysis/{sym}` | `range`, `timeframe` (not 1Month), `start` / `end` (CUSTOM), `extended`, `tp_atr` / `sl_atr` (BUY profit-take / stop-loss, × daily ATR), `bracket=fixed\|optimal`, `refresh` | the analysis payload ([section 8](#8-short-term-buy--sell-analysis)); takes 5–30 s (optimal: 40–90 s) |
| `GET /api/analysis/{sym}/intraday` | | today's (latest session's) 5-minute check: checks, BUY / SELL verdicts |
| `GET /api/backtest/{run_id}` | `n` (1–100, default 30), `setups=rebound\|trend\|both`, `min_prob` / `sell_min_prob` (0–1; omitted = the model's own threshold), `sizing=usd\|share` | backtest scenarios on that training ([section 9](#9-backtests-page)); 404 when the run is no longer on the server |
| `WS /ws/live/{sym}` | | live messages ([4.3](#43-live-stream)) |

### 4.2 Data feeds

Logic is in `alpaca_api/feeds.py`. On free Alpaca plans:

- **SIP** (consolidated, all exchanges) has history back to 2016, but not the latest 15 minutes.
- **IEX** is real-time but covers one exchange only (history from mid-2020).

| `ALPACA_DATA_FEED` | Result | UI label |
|---|---|---|
| `auto` → recent SIP allowed | `sip`: everything from SIP | sip |
| `auto` → recent SIP blocked | `hybrid`: bars = SIP up to now − 16 min + IEX after it (merged); snapshots and the stream use IEX | sip+iex |
| `iex` | IEX only | iex |

`auto` probes once whether recent SIP is allowed.

### 4.3 Live stream

Free plans allow **one** market-data stream connection (30 symbols). The hub (`live/hub.py`):

- holds the only upstream connection and fans messages out to browser sockets per symbol;
- rebuilds the upstream (close old, then open new) whenever the set of watched symbols changes, debounced 0.3 s, so
  **switching ticker terminates the old connection**; no watchers = no connection;
- coalesces trades to ~4 pushes/s per symbol (`{p, hi, lo, v, t, n}`), quotes to the latest, and forwards minute
  bars, updated bars and daily bars as they arrive;
- reconnects with backoff (2 s .. 30 s); auth failure (402) stops; the connection limit (406) shows "limit".

Browser messages: `{type: status|tick|quote|bar, ...}` (`frontend/src/types/api.ts` has the exact shapes).
To verify closure: `/api/live/status` → `upstream.opened_total` / `closed_total` / `open.local_port`.

---

## 5. Frontend

**Layering: imports only point downwards.**

```text
App.tsx               composition + wiring between hooks
    |
components/*          presentational React components (props in, callbacks out)
    |
hooks/*               state, data loading, timers, WebSocket lifecycle
    |
chart/  services/     imperative chart engine; REST + WebSocket clients
    |
config/ lib/ types/   constants, pure helpers, API types (no React)
```

### Project files

| File | Purpose |
|---|---|
| `index.html` | Vite entry HTML (mount point `#root`, favicon) |
| `package.json` | scripts: `dev`, `build`, `typecheck`, `preview`. Versions are pinned exactly. |
| `tsconfig.json` | strict TypeScript |
| `vite.config.ts` | dev server `:5173`, proxy `/api` and `/ws` → `:8000`, build → `dist/` |
| `src/main.tsx` | `createRoot` + `StrictMode` + global CSS |
| `src/styles/global.css` | the whole look (brokerage-research style: white surfaces, `#368727` green, grey rules). Class names are used directly by components; no CSS-in-JS. |

### `src/App.tsx`: page layout and data flow

- `useChartSettings` → `useBars` → `ChartCard` / `HistoryTable`
- symbol → `useQuote` + `useLiveStream` → `QuoteHeader`, chart live candle (via ref)
- `usePolling` → slow REST reconciliation (fast fallback when the stream is down)
- `useAnalysis` → markers / price lines (while the chart shows the trained bars: same symbol, interval and
  extended hours; a range inside the trained window is only a view change) + `AnalysisPanel`. A range that starts
  **before** the trained window (e.g. MAX or 10Y after a 1Y training) retrains automatically for that range, so MAX
  shows BUY / SELL decisions over all the history (the old markers stay until the new ones arrive; once per range).
- `useRoute` → page: `#/backtests` shows `BacktestPage` (same `useAnalysis` training); the chart page stays mounted
  but hidden, so the live stream, chart state and training survive switching pages

Live ticks go to the chart through a ref (`PriceChartHandle.applyTick`) so they do not re-render React; the history
table is told to re-read via a version counter.

### `types/`, `config/`, `lib/`, `services/`

| File | Contents |
|---|---|
| `types/api.ts` | Backend response types (Quote, BarsPayload, BarColumns, Health, Clock, Asset), live message types (StreamStatus, TickMessage, QuoteMessage, BarMessage) and analysis types (AnalysisResult, TargetResult, EntrySignal, CurrentSignal, RangeStats, Simulation, ...). |
| `config/timeframes.ts` | `TF_LABEL`, `TF_UNIT`, `RANGE_BUTTONS`, `RANGE_TFS` (intervals allowed per range), `RANGE_DEFAULT_TF`, `OLDER_STEP_DAYS` (scroll-back step), `isIntraday`, `effectiveTimeframe`. |
| `config/indicators.ts` | `IndicatorKey`, `IndicatorParams`, `PRESETS` per interval, `INDICATOR_ROWS` (menu layout), `DEFAULT_ENABLED`, get/setField, `validateField`, `paramQuery` (→ `/api/bars` query). |
| `config/feeds.ts` | feed display names |
| `lib/format.ts` | price / pct / volume / compact formatting, ET date formatting, `barTime` (chart time → text), `etEpoch` (ISO → chart time) |
| `lib/storage.ts` | localStorage load / save with `qtm.` prefix, failure-safe |
| `lib/csv.ts` | bars → CSV (indicator columns named by their lengths, e.g. `sma_20`) + download |
| `lib/stream.ts` | `streamView()`: stream state → badge tone / text and detail text |
| `services/api.ts` | fetch wrapper (`ApiError` with status + server detail); endpoints `health`, `clock`, `search`, `quote`, `bars`, `analysis`, `intraday` |
| `services/liveFeed.ts` | `LiveFeed`: one WebSocket per tab; `open(symbol)` closes the previous socket first; keep-alive ping 25 s; auto-reconnect with backoff; closes on `pagehide` |

### `chart/` (imperative, no React)

| File | Contents |
|---|---|
| `ChartEngine.ts` | Lightweight Charts wrapper: price pane (candles / OHLC / line) + overlays + volume, RSI pane, MACD pane; scroll + crosshair sync; `setData` (incremental tail update, prepend-with-stable-view for scroll-back, full replace for new lengths), `applyTick` (live candle), `setType`, `setIndicators`, `onNeedOlder` when scrolled past the left edge, `onLegend` callback, `setMarkers` / `setPriceLines`. View controls: `zoom(factor)` zooms time and price around the centre of the view (price zoom = an `autoscaleInfoProvider` on every price-pane series that scales the visible candles' low–high range around its middle, so they stay vertically centred); `fitView()` returns to the selected range with auto-scaled prices on every pane (also done on every new symbol / range / interval, so a dragged price axis never carries over). Price margins are symmetric: the candles sit in the middle of the area above the volume band. |
| `legend.ts` | `buildLegend()`: pure legend model (OHLC, change, indicator values) |
| `buckets.ts` | `bucketFor()`: which bar a live trade belongs to; `inRegularSession()` |
| `theme.ts` | colours and `OVERLAYS` (series definitions with labels from params). Bollinger: bold cyan bands + dashed middle; VWAP: dashed pink. |
| `bandSeries.ts` | `BandFillSeries`: custom series that shades the area between the Bollinger bands (the library has no fill-between); created before the price series so it sits under the candles. |
| `markers.ts` | analysis → markers, for **every decision of the analysed window** (older ones appear when you scroll back or widen the range): BUY (up-arrows below), SELL (down-arrows above), trade exits (dots labelled with the return); green = signal right, red = wrong, blue = open. The current K line's decision: "BUY" / "SELL" (black) or "BUY –" / "SELL –" (grey). Price lines: the current BUY's entry / profit-take / stop-loss, an open trade's levels, and the projected "Proj. BUY" / "Proj. SELL" prices. Markers land only on bars that exist in the loaded data and are re-applied after data / type changes. |

### `hooks/`

| File | Contents |
|---|---|
| `useChartSettings.ts` | reducer for symbol, range, interval, custom dates, chart type, extended hours, enabled indicators, per-interval indicator overrides. Derives timeframe + params. Persists to the URL (`?symbol=&range=&tf=&from=&to=`) and localStorage. Opens on `DEFAULT_SYMBOL` (SPY) unless the URL names a symbol. Switching the range keeps the interval when the new range offers it (1Y Daily → 5Y / MAX stay Daily), so a range switch is a view change. |
| `useBars.ts` | loads bars with modes `fit` / `replace` / `silent` / `older`; aborts superseded requests, drops stale responses, keeps the scroll-back position (`load_from`); exposes overlay + busy note. `isLiveRange()`. |
| `useQuote.ts` | REST quote + `applyTick` / `applyLiveQuote` merges from the stream |
| `useLiveStream.ts` | owns a `LiveFeed`; reopens on symbol change; returns `StreamStatus` |
| `useHealth.ts` | `/api/health`; re-checks every 5 s until credentials are configured |
| `useClock.ts` | `/api/clock` every 60 s |
| `useBanner.ts` | page banner state + `showApiError` (friendly text per HTTP status) |
| `usePolling.ts` | interval with latest-callback semantics |
| `useAnalysis.ts` | runs `/api/analysis` on demand (always retrains) and keeps the query it was trained on (`App.tsx` hides the markers only when the chart shows other bars - another interval or extended-hours setting; another range keeps them, drawn for the new view, with a note that the "This chart range" figures are for the trained range); cleared on symbol change; marker visibility (BUY, SELL and exits all start on after every run); the BUY level mode + multiples (localStorage); refreshes the 5-minute check every minute while results are shown. |
| `useRecentSymbols.ts` | last 10 symbols in localStorage |
| `useRoute.ts` | page from the URL hash: `#/backtests` → Backtests, anything else → Quote & Chart. `useChartSettings` keeps the hash when it rewrites the query string. |
| `useBacktest.ts` | Backtests settings (N, strategy, P threshold %, lot size, sell rule; localStorage), debounced `/api/backtest/{run_id}` request whenever they or the training change; superseded requests aborted |

### `components/`

| Component | Contents |
|---|---|
| `layout/SiteHeader.tsx` | brand, primary nav (News & Research = `#/`, Backtests = `#/backtests`, active by page), SearchBox |
| `layout/SubNav.tsx` | secondary tab per page (Quote & Chart / Backtest scenarios) + market open / closed |
| `layout/Banner.tsx` | error / warning bar (with `.env` hint) |
| `layout/SiteFooter.tsx` | data notes + TradingView attribution (required by the chart library licence) |
| `search/SearchBox.tsx` | debounced autocomplete, arrow keys, Enter, click |
| `quote/QuoteHeader.tsx` | name, price (flash on change), change, as-of, bid / ask / volume |
| `quote/LivePill.tsx` | LIVE / CONNECTING / RECONNECTING / STREAM BUSY / STREAM OFF badge |
| `quote/RecentSymbols.tsx` | recent-symbol chips |
| `sidebar/KeyStatistics.tsx` | open, prev close, ranges, volumes, VWAP + RangeBar ×2 |
| `sidebar/RangeBar.tsx` | low–high track with price marker |
| `sidebar/DataSource.tsx` | provider, feed, stream state, account, next open / close |
| `chart/ChartCard.tsx` | card frame + status note, ChartToolbar, PriceChart, the **Find entry points** button (retrains on the chart as shown) |
| `chart/ChartToolbar.tsx` | ranges, interval, chart type, IndicatorMenu, extended hours, custom dates |
| `chart/IndicatorMenu.tsx` | toggles + editable lengths; per-field validation; debounced commit that captures the interval at edit time |
| `chart/PriceChart.tsx` | hosts ChartEngine (create / dispose), forwards props, exposes `applyTick` via ref, renders legend, panes, loading / empty overlay, and the view buttons on the price pane: **− / +** (zoom time and price together) and **Fit** (selected range, prices re-centred) |
| `chart/ChartLegend.tsx` | renders the legend model |
| `history/HistoryTable.tsx` | paged OHLCV table (newest first) + CSV button |
| `analysis/AnalysisPanel.tsx` | "Short-term BUY & SELL Analysis" card: progress, stale notice, marker legend, Current K panel, reading guide, BUY + SELL cards, the $100 simulation, the two decision tables, factor relations, method |
| `analysis/TrainingDates.tsx` | "Training dates for this run" (top of the results, after every retrain): BUY / SELL today's model and first walk-forward model date ranges (bars, years or sessions), retrain count, data / daily / Yahoo date ranges, model-check and chart range, short-history warning (< 1 year), disclaimer |
| `analysis/MomentumBox.tsx` | "Momentum vs previous K lines": P of BUY / BUY S / SELL on the last 10 K lines (today's models) as sparklines vs the threshold, change vs the previous K and 5 K ago, status (approaching / moving away / flat / now), overall verdict (toward BUY / toward SELL / no clear shift), RSI / MACD price momentum |
| `analysis/CurrentKPanel.tsx` | current K line: momentum box, BUY / SELL decision combined with the 5-minute check; BUY plan (entry, profit-take, stop-loss with what set them, chase limit) vs the live price; setup checklists |
| `analysis/TargetCard.tsx` | BUY or SELL: Fixed ATR / Optimized ATR level editor + exit rule (BUY), Optimized ATR section (`OptimizationPanel.tsx`: combination in use now, optimized vs fixed vs best-in-hindsight, every combination's profit, when the choice changed), open trade, **This chart range** (decisions, justified vs setup-only vs any bar, BUY trades vs any-bar entry, buy & hold), **Model check** over ≥ 1,260 bars (verdict, AUC, by setup, trade backtest), marker toggle, factor-group importance |
| `analysis/SimulationPanel.tsx` | simulation: **$100 / 1 share per BUY** switch (default $100, remembered), when-to-sell switch, lots, win rate, realized / still-held / total P&L vs the same BUYs never sold, **win rate and P&L by BUY setup** (rebound / trend / all), one ledger row per lot |
| `analysis/DecisionTable.tsx` | the 30 most recent BUY, BUY S or SELL decisions (BUY S: no level columns; "Sold at next SELL"), newest first: setup, P, entry, levels (distance in ATR + what set them), outcome, trade exit (20-session window), what the simulation did; rows inside the chart range highlighted, older ones dimmed. **Click a row** (or Enter) to expand `DecisionWhy`. |
| `analysis/DecisionWhy.tsx` | expanded decision row: P vs threshold, setup checklists on that bar (the one that fired is marked), "What moved the model" diverging bars per factor group, key indicator values |
| `analysis/ReadingGuide.tsx` | plain-language explanation of every number in the panel |
| `analysis/FactorRelations.tsx` | correlation / beta / lead table for SPY, QQQ, VIX, oil, gasoline, rate |
| `analysis/util.ts` | formatting helpers shared by the cards and tables (`pct`, `usd`, `span`, rule text, ...) |
| `backtest/BacktestPage.tsx` | Backtests page: current-training line + training dates, settings, qualifying-decisions note, Overall / YTD / Per transaction blocks, by setup, rebound vs trend vs both (click a row to switch), trades; "Train now" when there is no training |

---

## 6. Conventions

### 6.1 Time encoding

Chart times are epoch seconds of the **New York wall-clock time** (encoded as if UTC), so the chart library, which
renders UTC, shows ET without time-zone code.

- Backend: `core/timeutil.et_epoch()`
- Frontend: `lib/format.barTime()` (format with `timeZone: UTC`), `lib/format.etEpoch()` for live trades

### 6.2 Indicator lengths are in bars

Lengths are in **bars of the chosen interval**. Presets differ per interval (`config/indicators.ts` `PRESETS`);
user edits are stored per interval. Changing the interval recalculates everything; changing the range only changes
the view (daily+ always has full history loaded).

### 6.3 Positional indicator columns

`sma1..3`, `ema1..2` + `params` in the payload. Labels and CSV names are derived from `params`, never hard-coded.

### 6.4 Errors

The backend raises `ApiError` → `{"detail"}`; the frontend `ApiError` carries status + detail; `useBanner` maps the
status to friendly text (503 = missing `.env` credentials).

### 6.5 No orders

Nothing in the app places orders.

---

## 7. How to extend

### Add an indicator

1. `backend/app/indicators/params.py`: add the length(s) to `IndicatorParams` + `parse_params` + `warmup_bars`
2. `backend/app/indicators/compute.py`: add the column in `compute_all`
3. `backend/app/api/routes/bars.py`: add the query parameter
4. `frontend/src/config/indicators.ts`: add to `IndicatorKey`, `IndicatorParams`, `PRESETS`, `INDICATOR_ROWS`, `paramQuery`
5. `frontend/src/types/api.ts`: add the column / params field
6. `frontend/src/chart/theme.ts`: overlay entry (price pane), or a new pane in `ChartEngine` + `PriceChart`
7. `frontend/src/chart/legend.ts`, `lib/csv.ts`: legend item / CSV column name
8. Tests in `backend/tests/test_indicators.py`

### Add an endpoint

Service function in `services/` (logic) → route module in `api/routes/` (exposes `router`) → include it in
`api/__init__.py` → client function in `frontend/src/services/api.ts` → hook → component.

### Change the BUY / SELL definitions

- Outcome rules: `backend/app/quant/targets.py` `SHORT` / `TP_SHORT` (horizon, `target_atr`, `stop_atr`, cooldown,
  model). The UI reads the spec from the payload.
- Optimized ATR: the grid, look-back, minimum trades and retrain count at the top of `backend/app/quant/optimize.py`.
- Setups: `backend/app/quant/setups.py`.

### Add a market / macro factor

`yahoo_api/client.py` `FACTORS` → `quant/features.py` (features + group). It appears in the relations table
automatically.

---

## 8. Short-term BUY & SELL analysis

Started by **Find entry points**. It runs on the chart **as shown**: same symbol, range, interval and
extended-hours setting, and every click retrains.

- Works on 1-minute to weekly bars. Monthly is refused (Alpaca history since 2016 ≈ 130 monthly bars).
- Long-term entries were removed for now (to be redesigned); `quant/model.py` keeps the `logistic` model kind and
  `quant/trades.py` the trailing-stop exit for that work.

### 8.1 BUY = setup AND model

**Setup** (`quant/setups.py`, on the analysed bars):

| Setup | Rule |
|---|---|
| `rebound`: falling momentum easing | below SMA20 and down over 5 bars (or RSI < 40 recently), plus ≥ 2 of: MACD histogram < 0 but rising · RSI turning up from a low · higher low or long-lower-wick candle |
| `trend`: clear bullish trend | close > SMA20 > SMA50, both rising, ADX(14) ≥ 20, above SMA200 when available |

**Model:** P(profit-take before stop-loss within 20 trading sessions) ≥ training base rate + 10 pts.

**Label** (`quant/targets.py` `SHORT`, `HOLD_SESSIONS = 20`): price reaches the profit-take before the stop-loss
within **20 trading sessions** - a BUY may be held up to 20 sessions - on every interval (intraday: through the same
time of day 20 sessions later; weekly: 4 bars). Intraday analyses load 20 extra sessions of bars so the models still
learn from outcomes that are already known. A bar
touching both counts as a stop.

### 8.1b BUY S = BUY for the sell-signal strategy

A **second, separately trained BUY model** (`quant/targets.py` `ACCUM`, `quant/accum.py`) for the strategy where every
BUY adds a lot and the next SELL sells everything - no profit-take, stop-loss or time limit, so the profit-take /
stop-loss label of 8.1 does not describe its outcome.

- **Label:** a lot bought at the bar's close is sold at a **profit at the next SELL decision** (1) or at a loss (0);
  unknown until that SELL comes. The SELL decisions are the SELL model's own walk-forward decisions (interim top AND
  P ≥ its threshold, one per cooldown) - no hindsight. For that, the SELL model's walk-forward also covers 1,260 bars
  before the model-check window, retrained 3× less often there (its decisions inside the window are unchanged), so BUY S has labelled history
  over its own 1,260-bar training window. Before the SELL model's first decision (it needs its own 250 known
  outcomes first - about 5 years on weekly bars), the **interim-top setup** (rule on past prices only, same
  cooldown) stands in for SELL in BUY S's labels (`accum.label_sells`), so BUY S starts learning as early as the
  other models; payload `targets.accum.proxy_until` = that date (shown on the BUY S card). Trades and simulations
  always exit at real SELL decisions. VOO 10Y Weekly: BUY S went from 1 decision (first model Jan 2026) to 28
  (first model Nov 2020).
- **Decision:** rebound or trend setup AND P(profit at the next SELL) ≥ its own threshold (base rate + 10 pts, capped
  at 85% - on SPY Daily the base rate is ~72%, so the threshold is ~82–85%).
- **Shown:** its own card, decisions table, chart markers ("BUY S"), current-K line, row in Training dates.
- **Used by:** the sell-signal strategy of the simulation (8.7) and of the Backtests page; the profit-take / stop-loss
  strategy keeps using BUY. The projection (8.4) uses BUY.

Observed (SPY 1Y Daily, Nov 2026): 40 BUY S decisions, 74% sold at a profit vs 72% for any bar, AUC 0.44 (no edge -
in a rising market most purchases are profitable at the next SELL anyway). Sell-signal simulation: +$70.04 over 30
lots ($100 each), 90% of sold lots in profit.

### 8.2 SELL (take profit) = interim-top setup AND model

| Setup | Rule |
|---|---|
| `top`: bullish momentum easing / interim top | extended (above SMA20 and up over 10 bars, or RSI > 65 recently) plus ≥ 2 of: MACD histogram > 0 but falling · RSI turning down from a high · lower high or long-upper-wick candle · close back below the prior close right after a new 20-bar high |

**Model:** P(1.5 daily-ATR pullback before a 1 ATR rise within 5 sessions) ≥ base rate + 10 pts. The SELL's
"Pullback to" / "Invalid above" levels are always these fixed multiples.

Momentum-shift values and the setup flags are also model features (group "Momentum shift & setups").

### 8.3 Profit-take / stop-loss levels

The BUY card's **Fixed ATR / Optimized ATR** switch (remembered) selects the levels.

| Mode | Profit-take / stop-loss |
|---|---|
| **Fixed ATR** | entry + tp × daily ATR / entry − sl × daily ATR (defaults 1.5 / 1, adjustable 0.5–5 / 0.25–5) |
| **Optimized ATR** | the combination with the best backtested profit (`quant/optimize.py`), walk-forward |

**Optimized ATR, step by step:**

1. Grid: profit-take 1 / 1.5 / 2 / 3 × daily ATR × stop-loss 0.75 / 1 / 1.5 × daily ATR = 12 combinations.
2. For each one: label every bar with it, **retrain the BUY model walk-forward** on those labels (20 retrains, about
   every quarter on Daily; starting 252 bars before the model-check window), and trade its BUY decisions (the usual
   trade: profit-take / stop-loss / SELL signal in profit / close after 20 sessions).
3. At the start of every block (= retrain), choose the combination with the **best total return over the trades that
   had already closed in the previous 252 bars** (default 1.5 / 1 until one has 3 such trades). Only past outcomes
   are used, so the reported result is out-of-sample.
4. The BUY model is then one composite: in each block its probabilities, levels and outcomes come from the
   combination chosen for that block. Today's decision uses the combination that is best today (same rule, all
   trades closed so far) and that combination's latest model.

The BUY card shows the combination in use now, the optimized result vs fixed 1.5 / 1 with the same retraining vs the
best combination in hindsight (optimistic: picked after the fact), every combination's total return, and when the
choice changed. Each decision's levels say `optimized`. Cost: 12 full walk-forward retrains, so a run takes 40–90 s.

Observed (SPY 1Y Daily, Nov 2026, 5-year window): optimized −6.4% over 45 trades vs fixed 1.5 / 1 −4.6% (same
retraining) and +4.5% (normal 60 retrains); best in hindsight 2.0 / 1.0 +4.8%. The chosen combination changed at
most re-optimizations - no combination stayed best, so choosing by recent profit chased noise here.

- Each decision shows its levels' distance in ATR and what set them.
- The model is retrained on the chosen levels, so **AUC and hit rates are not comparable between the modes** (the
  labels differ). Compare trade results and the $100 simulation instead.

### 8.4 Current K line

Component: `components/analysis/CurrentKPanel.tsx`.

- **Decision** on the newest candle (model from all outcomes known now + the setup on that candle), shown even
  inside a marker cooldown; drawn on the chart as "BUY" / "SELL" (black) or "BUY –" / "SELL –" (grey).
- **BUY plan:** entry = the candle's price when the model decided; profit-take, stop-loss, chase limit (entry +
  0.25 daily ATR). The live price (quote stream) is classified as: inside the entry zone · below the entry (better
  price, reward:risk shown) · above the chase limit (wait) · at / above profit-take · at / below stop-loss. Drawn as
  dashed "BUY entry" / "Profit-take" / "Stop-loss" price lines.
- **Today's 5-minute check** (`quant/intraday.py`, refreshed every minute via `/api/analysis/{sym}/intraday`):
  VWAP, last hour, 5-min RSI direction, lows, day-range position → score.

  | Model decision | 5-minute verdict | Shown as |
  |---|---|---|
  | BUY | supports / mixed / against | confirmed / unconfirmed / WAIT |
  | SELL | supports / mixed / against (sign flipped) | confirmed / unconfirmed / HOLD |

  The 5-minute check is not part of the backtest (historical markers use setup + model only).
- **Momentum vs previous K lines** (`MomentumBox.tsx`, top of the panel; payload `current.recent`, `k_momentum`):
  each model's P on the last `MOMENTUM_BARS` (10) K lines, all scored by **today's** model (so the change comes from
  the K lines, not from a retrain), vs its threshold; change vs the previous K and vs 5 K lines ago; status per model
  (BUY / SELL now · approaching (P up ≥ 2 pts, still below the threshold) · moving away · flat). Overall verdict from
  the BUY models' average 5-K change minus the SELL model's: ≥ +3 pts **toward BUY**, ≤ −3 pts **toward SELL**, else
  no clear shift. Plus RSI(14) and MACD-histogram price momentum.
- **Projection** (`quant/projection.py`, top of the panel): the decision depends on where the K line closes, so the
  same decision (setup AND current model) is re-run as if the bar closed at other prices, from −3 to +3 daily ATR
  around the current close (bar rebuilt with close = p, high / low extended; on daily / weekly bars the latest daily
  close = p too). Per side, the price nearest to now that triggers it:

  | Side | Shown as | Details |
  |---|---|---|
  | BUY | projected entry price | zone of closes that trigger it, setup, model P vs threshold, profit-take / stop-loss at that entry (Fixed multiples, or the optimized combination in use now) |
  | SELL | projected selling price | zone, model P vs threshold, expected pullback |

  The scenario closer to the live price (else the analysed close) is shown first, the other below it; "BUY now" /
  "SELL now" when the K line already is one; a note when neither occurs within ±3 ATR. Both are drawn as dashed
  "Proj. BUY" / "Proj. SELL" price lines. It is a what-if on the close, not a forecast. Adds ~1–2 s per analysis.
- **When is a daily BUY decided?** At the **close**: features, setups and labels use the bar's close, and the backtest
  buys at that close. While the current daily K line is still forming, the panel checks the **live price** against
  the projected BUY / SELL zones on every tick; inside a zone it shows "BUY (SELL) signal reached intraday": acting then
  is an intraday entry / exit at about the live price, **provisional** (the K line becomes a BUY / SELL only if it
  closes in the zone). Zones use the bar as it was at analysis time. Intraday entries are not backtested on daily
  bars (that would need intraday history per day); for backtested decisions during the day, analyse an intraday
  interval (1 hour, 15 or 5 minutes): decisions are then made at each of those bars' closes with the same 20-session
  targets and daily ATR.
- The model decision is not re-run automatically as the live K line develops; press **Find entry points** again.

### 8.5 Chart range vs model check

`analysis_service.eval_window()` returns `(r0, w0, w1)`:

| Window | Bars | Used for |
|---|---|---|
| **Chart range** `[r0, w1)` | exactly the bars on the chart (1D = the latest session, 1Y = the last year) | chart markers, the "This chart range" block, highlighted rows in the decision tables. Payload: `range_window`, per target `range_stats` and `trades.range_*`; each signal has `in_range`. |
| **Model check** `[w0, w1)` | the chart range widened to at least 1,260 bars of the same interval (5 years on Daily, ~3 weeks on 5-minute) | verdict, AUC, by-setup results, the window backtest, so a 1D chart is not judged on a handful of decisions |

### 8.6 Trade exits (20-session backtest)

Every BUY is traded (`quant/trades.py`) and sold at the first of: profit-take · stop-loss · a SELL signal while in
profit · the close after 20 sessions. Gaps fill at the open. Compared with **any-bar entry** (the same exits on
every bar).

### 8.7 $100 simulation

`quant/portfolio.py` + `components/analysis/SimulationPanel.tsx`, over the **30 most recent BUYs**:

- **Two strategies, each with its own BUY model and its own 30 most recent BUYs (own period):**
  - **Sell-signal strategy** - BUYs from **BUY S** (8.1b); sold only at the next SELL decision.
  - **Profit-take / stop-loss strategy** - BUYs from **BUY** (8.1); sold at its own levels / time limit or the next SELL.
- **Every BUY buys a lot** at that close, also while lots are already held. Lot size (switch, default $100):
  **$100** (fractional shares) or **1 share** (cost = the price). Win rate is the same; P&L and capital differ.
- **Sell-signal strategy**: the next SELL sells every lot held, at that SELL's close (no time
  limit). A SELL and a BUY on the same bar: the SELL sells what was held before, then the BUY opens a new lot.
- **Profit-take / stop-loss strategy**: a lot is also sold on its own at its
  BUY's profit-take / stop-loss if that is hit first (intrabar, so before a SELL at the same bar's close; gaps fill
  at the open), or at the close when its 20-session window ends.
- Lots still held are valued at the last close. P&L is before costs.

| Shown | Meaning |
|---|---|
| Lots bought, max at once | every BUY = one lot; the most lots held at the same time (max money at work) |
| Win rate | sold lots with a profit / all sold lots |
| Realized / still held / total P&L | sold lots / lots valued at the last close / both; total % is on the max capital at work |
| Win rate and P&L by BUY setup | the same numbers for the lots bought by **rebound** BUYs and by **trend** BUYs, plus all BUYs (avg per sold lot, return per $ invested) |
| Same BUYs, never sold | baseline: the same lots held to the last close; also one lot bought at the first BUY and held |

Each BUY row in the decision tables shows its lot's result; each SELL row shows how many lots it sold and their P&L.

### 8.8 Data

| Source | Used for |
|---|---|
| Alpaca bars of the chart's interval | features, labels, signals (the same bars as the chart) |
| Alpaca daily bars of the stock | daily ATR, market-relation features, relations table |
| Alpaca 5-minute bars, today | the 5-minute check |
| Yahoo Finance daily closes | SPY, QQQ, ^VIX, CL=F, RB=F, ^IRX (13-week T-bill yield, the Fed-rate proxy) |

Factor alignment (no look-ahead): daily bars use that day's values, weekly bars the end of the week, intraday bars
the previous day's.

### 8.9 Model and validation

- 54 features per bar, all computable at that bar's close (tested).
- **Speed:** one Daily analysis fits ~200 models (BUY, BUY S, SELL walk-forwards). The folds run in parallel worker
  processes, one thread each, and the rest of the analysis runs single-threaded (many tiny fits / predictions lose
  more to thread start-up and contention than they gain) - same results, ~6x faster on a busy machine (SPY 1Y Daily:
  455 s -> 54-74 s while another program used ~6 of 8 cores; ~10-15 s on an idle machine). Optimized ATR adds 12
  more walk-forwards.
- **Walk-forward:** every max(21, window / 60) bars a gradient-boosted-trees model is trained on the preceding
  1,260 bars whose outcome was **already known**, and predicts the next block, so every marker is out-of-sample.
- One signal per cooldown (5 bars on Daily, one hour intraday).
- **Verdict:** "reliable" only if AUC ≥ 0.53 **and** signals hit more often than the base rate (AUC < 0.47 = worse
  than chance). Stats also show **Setup only** (every setup bar, no model) to see what the model adds over the rules.
- **Markers** (every decision of the analysed window; they stay when only the range changes) by default: BUY, SELL and trade-exit dots all on after every run (the SELL card
  still says "no reliable edge here" when that model failed its check). The current K line's decision is always drawn.
- **Training dates** (payload `training`, `components/analysis/TrainingDates.tsx`), returned and shown after every
  retrain: `trained_at`; the interval's bars, the daily bars and the Yahoo factors used (date ranges); per target the
  rows today's model learned from (`current`: start, end, bars, sessions, calendar days) and the first walk-forward
  model's rows (`first`, with `predicts_from`), number of retrains and the step. A warning is shown when today's model
  covers less than a year (e.g. ~17 sessions on 5-minute bars), plus a disclaimer that other dates give other results.
- The UI lists the 30 most recent BUY and SELL decisions (`DecisionTable.tsx`), including those before the chart
  range (dimmed, tagged "before chart range"). Clicking a row shows what supported it (`quant/explain.py`):

  | Part | How it is computed |
  |---|---|
  | Decision | P of the walk-forward fold model that made the decision vs its threshold; that model's training base rate |
  | Setup conditions | `setups.explain()` on that bar (BUY: rebound + trend, the one that fired marked; SELL: interim top) |
  | What moved the model | per factor group: P with the bar's real values − P with that group's features at the fold's training medians (occlusion, in points of P; they do not add up exactly) |
  | Key values | RSI, MACD histogram, 5 / 20-bar returns, close vs SMA20/50/200, from the 252-bar high, ADX, volume z, SPY 20-day return and vs its 200-day average, VIX and its 5-day change, T-bill yield |

### 8.10 Observed results

Daily, 5-year windows, Nov 2026; SPY, QQQ, AAPL, MSFT, NVDA, JPM; fixed levels:

- The setups alone hit at about the base rate (~30%).
- Setup + model adds a few points at best, and not consistently (SPY 32–33% vs 31% setup-only vs 30% any bar;
  MSFT worse).
- Trend BUYs beat rebound BUYs on most symbols (SPY 38% vs 24%).
- SELL is near chance for most.

*Research output, not advice.*

---

## 9. Backtests page

Opened from **Backtests** in the header (`#/backtests`). It runs scenarios on the **current training** (the last
Find entry points run, or **Train now** on the chart as shown); nothing is retrained.

| Setting | Default | Meaning |
|---|---|---|
| Decisions | All available (max 100) | all qualifying BUY decisions (the most recent 100 at most); type a number for the most recent N (the field shows what is actually used), **All** goes back |
| Strategy | Both | BUY setup: rebound, trend or both |
| Buy when P ≥ | Model | the BUY model's out-of-sample P on that bar ≥ the model's own threshold (training base rate + 10 pts, per retrain), or a custom % |
| Sell when P ≥ | Model | the same for the SELL model (interim-top bars), or a custom % |
| Each BUY | $100 | $100 worth or 1 share per BUY |
| Sell | Sell-signal | **Sell-signal strategy** (BUY S decisions, sell everything at the next SELL) or **Profit-take / stop-loss strategy** (BUY decisions, each lot also at its own levels / time limit) |

How decisions are chosen (`quant/backtest.py`): every bar of the model-check window that was in the chosen setup with
P ≥ the BUY threshold, at most one per cooldown (5 bars on Daily, one hour intraday), the most recent N; SELLs are the
interim-top bars with the SELL model's P ≥ the SELL threshold, one per cooldown. With the default **Model** thresholds
these are exactly the analysis' BUY and SELL decisions (tested); **Custom** replaces them with a fixed % (pre-filled
with today's model threshold). The page shows the model's threshold range over the window, how many BUYs qualify and how
many SELLs there are; with a high custom threshold there can be fewer BUYs than N. A longer training range (MAX) gives
more candidates. Saved settings from before (a fixed 60%) switch to Model.

Results (`quant/portfolio.py`), for the chosen sell rule:

| Block | Contents |
|---|---|
| Overall | total P&L and return on $ invested, win rate, lots (sold / held), realized / still held, max money at work, the same BUYs never sold, one lot at the first BUY held |
| YTD | P&L since Jan 1 of the last bar's year (lots held over the year end count from the previous year's last close), return on the money at work this year, lots held / sold this year, win rate, average return per sold lot |
| Per transaction | average return per trade, average gain of winners and loss of losers (% and $), best / worst, average holding time |
| By setup | the same per rebound / trend lots |
| Rebound vs trend vs both | the three strategies with the same N, threshold and lot size (click a row to show it) |
| Trades | every lot: bought, setup, P, size, prices, exit reason, holding time, P&L, return |

Training runs live in server memory (the last 30); after a server restart the page asks to retrain.

## 10. Next phase

Suggested placement for more models / strategies:

| Where | What |
|---|---|
| `backend/app/quant/` | new pure modules (features, labels, models) |
| `backend/app/services/` | orchestration (fetch → features → model → result) |
| `backend/app/api/routes/` | endpoints exposing results |
| frontend | new hooks + components; a new page can get its own tab in `layout/SubNav.tsx` |
