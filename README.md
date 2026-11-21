# Quant Trading Model V3 — Web

A quote and chart research app on Alpaca market data. It shows historical and live candlestick (K-line) charts with indicators.
A **Find entry points** button retrains a quantitative analysis on the chart's own K-lines, for any range and interval. It marks short-term BUY (entry) and SELL (take-profit) points, with an entry plan for the current K line, using factors from Yahoo Finance and validated walk-forward. The app does not place trades.

- **Backend:** Python / FastAPI (`backend/`)
- **Frontend:** React 18 + TypeScript + Vite (`frontend/`)
- **Developer guide:** [`dev.md`](dev.md) covers the structure of every module and file, the API, the live-stream design, conventions, and how to extend.

## Quick start

```powershell
pip install -r requirements.txt
cd frontend; npm install; cd ..

.\dev.ps1     # development: backend :8000 + Vite :5173 with hot reload -> open http://127.0.0.1:5173
.\run.ps1     # production-style: builds frontend/dist if needed, serves everything on http://127.0.0.1:8000
```

Put your Alpaca credentials in `.env` in the project root (see `.env.example`). The server re-reads the file when it changes.

```
ALPACA_API_KEY=...
ALPACA_SECRET_KEY=...
ALPACA_ENDPOINT=https://paper-api.alpaca.markets
ALPACA_DATA_FEED=auto
```

## Tests

```powershell
python -m pytest                    # backend, no network needed
cd frontend; npm run typecheck      # frontend types
```
