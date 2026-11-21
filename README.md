# Quant Trading Model V3 — Web

A quote and chart research view built on Alpaca market data: historical plus live (today) K-line candles with standard indicators.
No quantitative model logic yet.

## Run

```powershell
pip install -r requirements.txt
.\run.ps1            # or run.bat
```

Then open <http://127.0.0.1:8000/?symbol=AAPL>.

## Configure `.env` (project root)

```
ALPACA_API_KEY=...
ALPACA_SECRET_KEY=...
ALPACA_ENDPOINT=https://paper-api.alpaca.markets
ALPACA_DATA_FEED=iex        # iex (free) or sip (paid plan)
```

Common alternative names (`APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`, `APCA_API_BASE_URL`, `ALPACA_BASE_URL`, …) are also accepted.
The server re-reads `.env` when the file changes, so you don't need to restart it after editing.

## Layout

```
backend/app/
  config.py         .env loading (hot-reload), endpoint normalisation
  alpaca_client.py  async REST client: bars (paginated), snapshot, clock, assets
  indicators.py     SMA/EMA/Bollinger/RSI/MACD/VWAP (pandas), display only
  main.py           FastAPI routes + serves frontend/
frontend/
  index.html, css/styles.css
  js/format.js  js/api.js  js/chart.js (Lightweight Charts v4)  js/app.js
  vendor/lightweight-charts.standalone.production.js
```

## API

| Route | Purpose |
|---|---|
| `GET /api/health` | credentials present? paper/live, feed |
| `GET /api/clock` | market open/closed, next open/close |
| `GET /api/search?q=` | ticker autocomplete (active US equities) |
| `GET /api/quote/{sym}` | last trade, bid/ask, day OHLCV, prev close, 52-week range, average volumes |
| `GET /api/bars/{sym}?range=1D\|5D\|1M\|3M\|6M\|YTD\|1Y\|5Y\|MAX\|CUSTOM&timeframe=&start=&end=&extended=` | OHLCV and indicator columns |
|  ↳ indicator settings (optional) | `sma=20,50,200&ema=12,26&bb=20,2&rsi=14&macd=12,26,9`, lengths in bars (1–500); used values echoed back in `params` |
|  ↳ `load_from=YYYY-MM-DD` | intraday only: extend history back (used when the chart is scrolled left) |

Bars come back as columns. `time` is epoch seconds of **New York wall-clock time**, so the chart axis reads in ET.
Extra warm-up history is fetched and then trimmed, so long indicators (e.g. SMA 200) are valid from the first visible bar.

## Indicators

Lengths are counted in **bars**, so each interval has its own defaults (e.g. SMA 9/20/50 on 1-minute, 20/50/200 on daily,
10/20/40 on weekly). They can be edited in the Indicators menu, and edits are saved per interval in the browser.
Changing the interval recalculates every indicator. Changing the range only changes the view, because an indicator's
value at a bar never depends on how much of the chart is visible. Daily and longer intervals always load the full history
(Alpaca data starts Jan 2016), and the server fetches enough earlier bars that every line is fully formed from the first visible bar.

## Live updates

While a tab is visible, the quote refreshes every 5 s and bars every 10 s during market hours (every 30–60 s otherwise).
New bars are appended in place without resetting the chart zoom.

## Notes

- The free `iex` feed is real-time but only covers IEX-exchange trades, so its volume is much lower than consolidated (SIP) volume.
- Prices are split-adjusted.
