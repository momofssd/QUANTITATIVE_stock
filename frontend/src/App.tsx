/**
 * Page composition and the wiring between hooks:
 *   settings -> bars (REST) -> chart + history table
 *   symbol   -> quote (REST) + live stream (WebSocket) -> quote header, chart's live candle
 *   timers   -> slow REST reconciliation (fast fallback polling when the stream is down)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildMarkers, buildPriceLines, buySetupCounts, type EntryMarker, type PriceLineDef,
} from "./chart/markers";
import { AnalysisPanel } from "./components/analysis/AnalysisPanel";
import { BacktestPage } from "./components/backtest/BacktestPage";
import { ChartCard } from "./components/chart/ChartCard";
import type { PriceChartHandle } from "./components/chart/PriceChart";
import { HistoryTable } from "./components/history/HistoryTable";
import { Banner } from "./components/layout/Banner";
import { SiteFooter } from "./components/layout/SiteFooter";
import { SiteHeader } from "./components/layout/SiteHeader";
import { SubNav } from "./components/layout/SubNav";
import { QuoteHeader } from "./components/quote/QuoteHeader";
import { RecentSymbols } from "./components/quote/RecentSymbols";
import { DataSource } from "./components/sidebar/DataSource";
import { KeyStatistics } from "./components/sidebar/KeyStatistics";
import { useAnalysis } from "./hooks/useAnalysis";
import { useBanner } from "./hooks/useBanner";
import { isLiveRange, useBars } from "./hooks/useBars";
import { useChartSettings } from "./hooks/useChartSettings";
import { useClock } from "./hooks/useClock";
import { useHealth } from "./hooks/useHealth";
import { useLiveStream } from "./hooks/useLiveStream";
import { usePolling } from "./hooks/usePolling";
import { useQuote } from "./hooks/useQuote";
import { useRecentSymbols } from "./hooks/useRecentSymbols";
import { useRoute } from "./hooks/useRoute";
import { etEpoch } from "./lib/format";
import type { LiveMessage } from "./types/api";

const POLL_TICK_MS = 2500;
const NO_MARKERS: EntryMarker[] = [];
const NO_LINES: PriceLineDef[] = [];
const MINUTE_BAR_REFRESH_DELAY = 1500;

export default function App() {
  const page = useRoute(); // "#/backtests" -> Backtests; otherwise Quote & Chart
  const settings = useChartSettings();
  const { symbol, range, timeframe, from, to, extended, params } = settings;
  const banner = useBanner();
  const health = useHealth(banner.showApiError);
  const ready = !!health?.configured;
  const clock = useClock(ready);
  const recent = useRecentSymbols(symbol);

  const quote = useQuote(symbol, ready, banner.showApiError, banner.clear);
  const barsApi = useBars({ symbol, range, timeframe, from, to, extended, params }, ready, banner.showApiError);

  // Entry / take-profit analysis: retrained on exactly the chart being viewed (range, interval, extended hours).
  const analysis = useAnalysis(symbol, banner.showApiError);
  const runAnalysis = analysis.run;
  const bracket = analysis.bracket;
  const onAnalyze = useCallback(() => {
    void runAnalysis({
      symbol, range, timeframe, extended,
      ...(range === "CUSTOM" ? { start: from, end: to || undefined } : {}),
    }, bracket);
  }, [runAnalysis, bracket, symbol, range, timeframe, extended, from, to]);
  const ar = analysis.result && analysis.result.symbol === symbol ? analysis.result : null;
  // Markers belong to the bars they were computed on: same symbol, interval and extended-hours setting.
  // The range is only the view - switching it keeps the markers (drawn for what is in view) and price lines.
  const q = analysis.query;
  const sameBars = !!ar && ar.timeframe === timeframe && (!ar.intraday || ar.extended === extended);
  const sameRange = !!q && q.range === range && (range !== "CUSTOM" || (q.start === from && (q.end ?? "") === (to ?? "")));
  const mismatch = !ar ? null : !sameBars ? "bars" as const : !sameRange ? "range" as const : null;
  // A range that starts before the trained window (MAX / 10Y after a 1Y training) needs signals the training
  // does not have: retrain for it automatically (the old markers stay until the new ones arrive). Ranges inside the
  // trained window remain a pure view change.
  // The chart's real start: only once its bars belong to the selected range (not the previous range's while the new
  // ones load), and never before the first loaded bar (MAX's view starts at Jan 1, the data on the first trading day).
  const payload = barsApi.bars?.payload;
  const firstBar = payload && "time" in payload.columns ? payload.columns.time[0] : undefined;
  const viewStart = payload && payload.range === range && payload.view_start !== undefined
    ? Math.max(payload.view_start, firstBar ?? payload.view_start) : undefined;
  const autoKey = useRef("");
  useEffect(() => {
    if (!ar || !sameBars || analysis.loading || viewStart === undefined || ar.window.start_time === undefined) return;
    if (viewStart >= ar.window.start_time) return;
    const key = `${symbol}|${range}|${from}|${to}|${timeframe}|${viewStart}`;
    if (autoKey.current === key) return;   // once per range (no loop if a retrain cannot reach further back)
    autoKey.current = key;
    onAnalyze();
  }, [ar, sameBars, analysis.loading, viewStart, symbol, range, from, to, timeframe, onAnalyze]);
  const markers = useMemo(
    () => (ar && sameBars ? buildMarkers(ar, analysis.visible) : NO_MARKERS),
    [ar, sameBars, analysis.visible],
  );
  const priceLines = useMemo(
    () => (ar && sameBars ? buildPriceLines(ar, analysis.visible) : NO_LINES),
    [ar, sameBars, analysis.visible],
  );
  // BUY setup filter on the chart card (only while the analysis' markers are drawn)
  const setupCounts = useMemo(() => (ar ? buySetupCounts(ar) : null), [ar]);
  const buyFilter = useMemo(
    () => (setupCounts && sameBars && !analysis.loading
      ? { value: analysis.visible.setups, counts: setupCounts, onToggle: analysis.toggleSetup } : null),
    [setupCounts, sameBars, analysis.loading, analysis.visible.setups, analysis.toggleSetup],
  );

  const chartRef = useRef<PriceChartHandle>(null);
  const [tickVersion, setTickVersion] = useState(0);
  const minuteTimer = useRef(0);
  const live = useRef({ timeframe, extended, range, to });
  live.current = { timeframe, extended, range, to };

  const onLive = useCallback((m: LiveMessage) => {
    if (m.type === "tick") {
      quote.applyTick(m);
      const s = live.current;
      if (isLiveRange(s.range, s.to)
        && chartRef.current?.applyTick({ time: etEpoch(m.t), price: m.p, hi: m.hi, lo: m.lo }, s.timeframe, s.extended)) {
        setTickVersion((v) => v + 1);
      }
    } else if (m.type === "quote") {
      quote.applyLiveQuote(m);
    } else if (m.type === "bar" && m.kind === "minute" && isLiveRange(live.current.range, live.current.to)) {
      // A minute bar just closed: pull bars so indicators and volume include it.
      window.clearTimeout(minuteTimer.current);
      minuteTimer.current = window.setTimeout(() => void barsApi.load("silent"), MINUTE_BAR_REFRESH_DELAY);
    }
  }, [quote.applyTick, quote.applyLiveQuote, barsApi.load]);

  const stream = useLiveStream(ready ? symbol : null, onLive);
  const marketOpen = !!clock?.is_open;

  useEffect(() => {
    if (stream.state === "limit" || stream.state === "error") {
      banner.show({ kind: "warn", title: "Live stream:", message: stream.detail });
    }
  }, [stream.state, stream.detail, banner.show]);

  // With the stream up, polling is only a slow reconciliation (SIP volume, day stats, indicators).
  usePolling(() => {
    if (document.hidden) return;
    const streaming = stream.state === "live";
    const now = Date.now();
    const quoteEvery = streaming ? 30000 : marketOpen ? 5000 : 30000;
    const barsEvery = streaming ? 60000 : marketOpen ? 10000 : 60000;
    if (now - quote.lastLoadAt.current > quoteEvery) void quote.refresh(true);
    if (isLiveRange(range, to) && now - barsApi.lastLoadAt.current > barsEvery) void barsApi.load("silent");
  }, POLL_TICK_MS, ready);

  const bars = barsApi.bars;
  const fitKey = bars && bars.mode === "fit" ? `${bars.key}#${bars.seq}` : bars?.key ?? "";

  return (
    <>
      <header className="site-header">
        <SiteHeader page={page} onPickSymbol={settings.actions.setSymbol} />
        <SubNav page={page} clock={clock} />
      </header>

      <main className="wrap">
        <Banner banner={banner.banner} />
        {health && !health.configured && !banner.banner && (
          <Banner banner={{ kind: "error", title: "Alpaca credentials missing.", message: "", envHint: true }} />
        )}

        {page === "backtests" && (
          <BacktestPage a={analysis} chart={{ symbol, range, timeframe }} stale={mismatch !== null}
            onTrain={onAnalyze} onError={banner.showApiError} />
        )}
        {/* The chart page stays mounted (live stream, chart state, training) while Backtests is shown. */}
        <div hidden={page !== "chart"}>
        <QuoteHeader symbol={symbol} quote={quote.quote} stream={stream} marketOpen={marketOpen} />
        <RecentSymbols symbols={recent} current={symbol} onPick={settings.actions.setSymbol} />

        <div className="layout">
          <ChartCard
            ref={chartRef} settings={settings} bars={bars}
            overlay={health && !health.configured ? { kind: "message", text: "Waiting for Alpaca credentials in .env." } : barsApi.overlay}
            busyNote={barsApi.busyNote} onNeedOlder={barsApi.loadOlder}
            onDateError={(msg) => (msg ? banner.show({ kind: "warn", message: msg }) : banner.clear())}
            markers={markers} priceLines={priceLines}
            analyzing={analysis.loading} onAnalyze={onAnalyze} buyFilter={buyFilter}
          />
          <aside className="side">
            <KeyStatistics quote={quote.quote} />
            <DataSource quote={quote.quote} health={health} clock={clock} stream={stream} />
          </aside>
        </div>

        <AnalysisPanel
          a={analysis} mismatch={mismatch} chartRange={range} onRetrain={onAnalyze}
          livePrice={quote.quote?.price ?? null}
        />
        <HistoryTable payload={bars?.payload ?? null} version={tickVersion} resetKey={fitKey} />
        </div>
        <SiteFooter />
      </main>
    </>
  );
}
