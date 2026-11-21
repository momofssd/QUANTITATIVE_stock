/**
 * Imperative wrapper around TradingView Lightweight Charts v4: a price pane (candles/OHLC/line + overlays +
 * volume) and RSI / MACD panes whose scrolling and crosshair are kept in sync.
 *
 * React owns layout and state; this class owns the canvases. It never touches React state directly:
 * it reports back through callbacks (legend model, "need older bars").
 */
import {
  type AutoscaleInfo,
  createChart,
  CrosshairMode,
  type DeepPartial,
  type ChartOptions,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LogicalRange,
  type MouseEventParams,
  type SeriesType,
  type Time,
} from "lightweight-charts";
import type { IndicatorKey } from "../config/indicators";
import { barTime } from "../lib/format";
import type { BarColumns, BarsPayload, ServerIndicatorParams, Timeframe } from "../types/api";
import { bucketFor, inRegularSession } from "./buckets";
import { buildLegend, type LegendModel } from "./legend";
import { BandFillSeries } from "./bandSeries";
import type { EntryMarker, PriceLineDef } from "./markers";
import { COLORS, FONT_FAMILY, OVERLAYS, type OverlayDef } from "./theme";

export type ChartType = "candles" | "bars" | "line";
type AnySeries = ISeriesApi<SeriesType>;
type PointKind = "price" | "vol" | "macdHist" | string;
/* eslint-disable @typescript-eslint/no-explicit-any */
type Point = any; // series data items differ per series type; built by point()

export interface ChartEngineCallbacks {
  onLegend: (model: LegendModel | null) => void;
  onNeedOlder: () => void;
}

export interface SetDataOptions {
  /** New view (symbol/range/interval changed): jump to the range's start. */
  fit?: boolean;
  /** Values changed for existing bars (new indicator lengths): redraw everything, keep the view. */
  replace?: boolean;
  /** Identity of the request (symbol|range|interval|...): same key = same series, live refresh. */
  key: string;
}

function baseOptions(): DeepPartial<ChartOptions> {
  return {
    autoSize: true,
    layout: {
      background: { color: "#ffffff" }, textColor: COLORS.text, fontSize: 11, fontFamily: FONT_FAMILY,
      attributionLogo: false, // attribution is given as text in the page footer instead
    },
    grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
    rightPriceScale: { borderColor: COLORS.rule, minimumWidth: 78 },
    timeScale: { borderColor: COLORS.rule, timeVisible: true, secondsVisible: false, rightOffset: 3, minBarSpacing: 0.5 },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: "#9a9a9a", labelBackgroundColor: "#333" },
      horzLine: { color: "#9a9a9a", labelBackgroundColor: "#333" },
    },
  };
}

export class ChartEngine {
  private readonly main: IChartApi;
  private readonly rsiChart: IChartApi;
  private readonly macdChart: IChartApi;
  private readonly charts: IChartApi[];

  private type: ChartType = "candles";
  private enabled = new Set<IndicatorKey>();
  private data: BarColumns | null = null;
  private params: ServerIndicatorParams | null = null;
  private meta: { key: string; symbol: string; intraday: boolean } | null = null;
  private timeIndex = new Map<number, number>();
  private hoverTime: number | undefined;
  private markers: EntryMarker[] = [];
  private lineDefs: PriceLineDef[] = [];
  private priceLines: IPriceLine[] = [];
  /** Price-axis zoom of the price pane (1 = normal auto-scale; < 1 zoomed in, > 1 out), always centred. */
  private yZoom = 1;
  /** Start of the selected range (chart time) - what "fit" returns to. */
  private viewStart: number | undefined;

  /**
   * Auto-scale of every series on the price pane's right scale. Unzoomed: the library's own range (candles and
   * overlays). Zoomed: the visible candles' low-high range scaled by yZoom around its middle - the same range for
   * every series, so the candles stay vertically centred.
   */
  private readonly autoscale = (original: () => AutoscaleInfo | null): AutoscaleInfo | null => {
    if (this.yZoom === 1) return original();
    const ext = this.visibleExtent();
    if (!ext) return original();
    const mid = (ext.min + ext.max) / 2;
    const half = Math.max((ext.max - ext.min) / 2, Math.abs(mid) * 1e-4) * this.yZoom;
    return { priceRange: { minValue: mid - half, maxValue: mid + half } };
  };

  private priceSeries!: AnySeries;
  private readonly volSeries: AnySeries;
  private readonly bbFill: AnySeries; // shaded area between the Bollinger bands
  private readonly overlaySeries: (OverlayDef & { series: AnySeries })[];
  private readonly rsiSeries: AnySeries;
  private readonly macdHist: AnySeries;
  private readonly macdLine: AnySeries;
  private readonly macdSignal: AnySeries;

  constructor(els: { main: HTMLElement; rsi: HTMLElement; macd: HTMLElement }, private readonly cb: ChartEngineCallbacks) {
    this.main = createChart(els.main, baseOptions());
    this.rsiChart = createChart(els.rsi, baseOptions());
    this.macdChart = createChart(els.macd, baseOptions());
    this.charts = [this.main, this.rsiChart, this.macdChart];

    // Created before the price series so the shading is drawn underneath the candles.
    this.bbFill = this.main.addCustomSeries(new BandFillSeries(), {
      fillColor: COLORS.bbFill, priceLineVisible: false, lastValueVisible: false, visible: false,
      autoscaleInfoProvider: this.autoscale,
    }) as unknown as AnySeries;
    this.createPriceSeries();
    this.volSeries = this.main.addHistogramSeries({
      priceScaleId: "vol", priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false,
    });
    this.main.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    this.overlaySeries = OVERLAYS.map((o) => ({
      ...o,
      series: this.main.addLineSeries({
        color: o.color, lineWidth: o.width ?? 1, lineStyle: o.style ?? 0,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, visible: false,
        autoscaleInfoProvider: this.autoscale,
      }),
    }));

    this.rsiSeries = this.rsiChart.addLineSeries({ color: COLORS.rsi, lineWidth: 2, priceLineVisible: false });
    for (const level of [70, 30]) {
      this.rsiSeries.createPriceLine({ price: level, color: "#bbb", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "" });
    }
    this.rsiChart.priceScale("right").applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });

    this.macdHist = this.macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
    this.macdLine = this.macdChart.addLineSeries({ color: COLORS.macd, lineWidth: 2, priceLineVisible: false });
    this.macdSignal = this.macdChart.addLineSeries({ color: COLORS.signal, lineWidth: 2, priceLineVisible: false });

    this.syncCharts();
  }

  dispose(): void {
    this.charts.forEach((c) => c.remove());
  }

  // ---------------------------------------------------------------- setup
  private createPriceSeries(): void {
    if (this.priceSeries) this.main.removeSeries(this.priceSeries);
    const common = {
      priceLineVisible: true, priceLineWidth: 1 as const, priceLineStyle: 2 as const, autoscaleInfoProvider: this.autoscale,
    };
    if (this.type === "line") {
      this.priceSeries = this.main.addLineSeries({ ...common, color: COLORS.line, lineWidth: 2 });
    } else if (this.type === "bars") {
      this.priceSeries = this.main.addBarSeries({ ...common, upColor: COLORS.up, downColor: COLORS.down, thinBars: false });
    } else {
      this.priceSeries = this.main.addCandlestickSeries({
        ...common, upColor: COLORS.up, downColor: COLORS.down, borderUpColor: COLORS.up, borderDownColor: COLORS.down,
        wickUpColor: COLORS.up, wickDownColor: COLORS.down,
      });
    }
    this.applyPriceMargins();
    this.priceLines = []; // lines belonged to the removed series
    this.applyMarkers();
    this.applyPriceLines();
  }

  // ---------------------------------------------------------------- analysis overlays
  /** Entry markers (analysis). Only markers on bars that exist in the loaded data are drawn. */
  setMarkers(markers: EntryMarker[]): void {
    this.markers = markers;
    this.applyMarkers();
  }

  /** Horizontal lines on the price scale (e.g. today's target / stop). */
  setPriceLines(lines: PriceLineDef[]): void {
    this.lineDefs = lines;
    this.applyPriceLines();
  }

  private applyMarkers(): void {
    if (!this.priceSeries) return;
    const shown = this.markers.filter((m) => this.timeIndex.has(m.time));
    this.priceSeries.setMarkers(shown.map((m) => ({ ...m, time: m.time as Time })));
  }

  private applyPriceLines(): void {
    if (!this.priceSeries) return;
    this.priceLines.forEach((l) => this.priceSeries.removePriceLine(l));
    this.priceLines = this.lineDefs.map((d) => this.priceSeries.createPriceLine({
      price: d.price, color: d.color, lineWidth: 1, lineStyle: d.style, axisLabelVisible: true, title: d.title,
    }));
  }

  /** Candles centred in their own area: equal margins above and below (above the volume band when shown). */
  private applyPriceMargins(): void {
    const vol = this.enabled.has("volume");
    this.priceSeries.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: vol ? 0.28 : 0.08 } });
  }

  /** Lowest low / highest high of the bars in view. */
  private visibleExtent(): { min: number; max: number } | null {
    const d = this.data;
    const r = this.main.timeScale().getVisibleLogicalRange();
    if (!d || !r || !d.time.length) return null;
    const from = Math.max(0, Math.floor(r.from));
    const to = Math.min(d.time.length - 1, Math.ceil(r.to));
    let min = Infinity;
    let max = -Infinity;
    for (let i = from; i <= to; i++) {
      if (d.low[i] < min) min = d.low[i];
      if (d.high[i] > max) max = d.high[i];
    }
    return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
  }

  // ---------------------------------------------------------------- view controls
  /** Fit both axes: the selected range (its start -> the latest bar) with auto-scaled, centred prices on every
   *  pane - undoes zooming, scrolling and price-axis drags. */
  fitView(): void {
    this.showFrom(this.viewStart);
  }

  /** Zoom both axes around the centre of the view: factor < 1 zooms in, > 1 zooms out. */
  zoom(factor: number): void {
    const ts = this.main.timeScale();
    const r = ts.getVisibleLogicalRange();
    if (r) {
      const c = (r.from + r.to) / 2;
      const half = Math.max(5, ((r.to - r.from) / 2) * factor);
      ts.setVisibleLogicalRange({ from: c - half, to: c + half });
    }
    const z = Math.min(5, Math.max(0.2, this.yZoom * factor));
    this.yZoom = Math.abs(z - 1) < 1e-6 ? 1 : z;
    this.main.priceScale("right").applyOptions({ autoScale: true });
  }

  private syncCharts(): void {
    // Scrolled past the oldest bar (blank space on the left) -> ask for older data.
    this.main.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range && range.from < -2 && this.data) this.cb.onNeedOlder();
    });

    let syncing = false;
    this.charts.forEach((src) => {
      src.timeScale().subscribeVisibleLogicalRangeChange((range: LogicalRange | null) => {
        if (syncing || !range) return;
        syncing = true;
        this.charts.forEach((dst) => dst !== src && dst.timeScale().setVisibleLogicalRange(range));
        syncing = false;
      });
    });

    const pairs: [IChartApi, () => AnySeries, string][] = [
      [this.main, () => this.priceSeries, "close"],
      [this.rsiChart, () => this.rsiSeries, "rsi"],
      [this.macdChart, () => this.macdLine, "macd"],
    ];
    let xSyncing = false;
    pairs.forEach(([src]) => {
      src.subscribeCrosshairMove((param: MouseEventParams) => {
        if (xSyncing) return;
        xSyncing = true;
        try {
          const t = param.time as number | undefined;
          this.hoverTime = t;
          pairs.forEach(([dst, seriesFn, col]) => {
            if (dst === src) return;
            const i = t === undefined ? undefined : this.timeIndex.get(t);
            const v = i === undefined || !this.data ? null : this.data[col][i];
            if (t === undefined || v === null || v === undefined) dst.clearCrosshairPosition();
            else dst.setCrosshairPosition(v, t as Time, seriesFn());
          });
          this.emitLegend(t === undefined ? undefined : this.timeIndex.get(t));
        } finally {
          xSyncing = false;
        }
      });
    });
  }

  // ---------------------------------------------------------------- data
  private point(i: number, kind: PointKind): Point {
    const d = this.data!;
    const time = d.time[i] as Time;
    switch (kind) {
      case "price":
        return this.type === "line"
          ? { time, value: d.close[i] }
          : { time, open: d.open[i], high: d.high[i], low: d.low[i], close: d.close[i] };
      case "bbFill": {
        const u = d.bb_upper[i], l = d.bb_lower[i];
        return u === null || l === null || u === undefined || l === undefined ? { time } : { time, upper: u, lower: l };
      }
      case "vol":
        return { time, value: d.volume[i], color: d.close[i] >= d.open[i] ? COLORS.upVol : COLORS.downVol };
      case "macdHist": {
        const v = d.macd_hist[i];
        if (v === null || v === undefined) return { time };
        const prev = i > 0 ? d.macd_hist[i - 1] : null;
        const growing = prev === null || Math.abs(v) >= Math.abs(prev);
        const color = v >= 0
          ? (growing ? COLORS.histUpStrong : COLORS.histUpWeak)
          : (growing ? COLORS.histDownStrong : COLORS.histDownWeak);
        return { time, value: v, color };
      }
      default: {
        const v = d[kind]?.[i];
        return v === null || v === undefined ? { time } : { time, value: v };
      }
    }
  }

  private seriesPlan(): [AnySeries, PointKind][] {
    return [
      [this.priceSeries, "price"],
      [this.volSeries, "vol"],
      [this.bbFill, "bbFill"],
      ...this.overlaySeries.map((o): [AnySeries, PointKind] => [o.series, o.col]),
      [this.rsiSeries, "rsi"],
      [this.macdHist, "macdHist"],
      [this.macdLine, "macd"],
      [this.macdSignal, "macd_signal"],
    ];
  }

  /** Replace all data, or (if only the live tail moved) update the last few bars in place. */
  setData(payload: BarsPayload, { fit = false, replace = false, key }: SetDataOptions): void {
    const cols = (payload.columns.time ? payload.columns : null) as BarColumns | null;
    const n = cols ? cols.time.length : 0;
    const old = this.data;
    const sameKey = this.meta?.key === key;
    const canIncrement = !replace && sameKey && !!old && n > 0 && old.time.length > 0
      && cols!.time[0] === old.time[0]
      && n >= old.time.length && n - old.time.length <= 5
      && cols!.time[old.time.length - 1] === old.time[old.time.length - 1];

    this.data = cols;
    this.params = payload.params;
    this.meta = { key, symbol: payload.symbol, intraday: payload.intraday };
    this.timeIndex = new Map((cols?.time ?? []).map((t, i) => [t, i]));

    if (!cols || !n) {
      this.seriesPlan().forEach(([s]) => s.setData([]));
      this.applyMarkers();
      this.emitLegend();
      return;
    }

    this.applyFormat();

    if (canIncrement) {
      const from = old!.time.length - 1;
      this.seriesPlan().forEach(([s, kind]) => {
        for (let i = from; i < n; i++) s.update(this.point(i, kind));
      });
    } else {
      const prevRange = this.main.timeScale().getVisibleLogicalRange();
      // Older bars were prepended (scroll-back load): keep the same bars on screen.
      const shift = sameKey && old && !fit ? this.timeIndex.get(old.time[0]) : undefined;
      this.seriesPlan().forEach(([s, kind]) => {
        const arr = new Array(n);
        for (let i = 0; i < n; i++) arr[i] = this.point(i, kind);
        s.setData(arr);
      });
      if (shift && shift > 0 && prevRange) {
        this.main.timeScale().setVisibleLogicalRange({ from: prevRange.from + shift, to: prevRange.to + shift });
      } else if (fit || !sameKey || !old || cols.time[0] !== old.time[0]) {
        this.showFrom(payload.view_start);
      }
      this.applyMarkers();
    }
    this.emitLegend();
  }

  /**
   * Fold a live trade into the current candle (or open the next one). Indicators for a new bar are filled
   * in by the next REST refresh (triggered when Alpaca closes each minute bar). Returns true if drawn.
   */
  applyTick(tick: { time: number; price: number; hi: number; lo: number }, tf: Timeframe, extended: boolean): boolean {
    const d = this.data;
    if (!d || !this.meta || !Number.isFinite(tick.price)) return false;
    if (this.meta.intraday && !extended && !inRegularSession(tick.time)) return false;
    const n = d.time.length;
    const last = d.time[n - 1];
    const bucket = bucketFor(tick.time, last, tf);
    if (bucket === null || bucket < last) return false;

    if (bucket === last) {
      const i = n - 1;
      d.high[i] = Math.max(d.high[i], tick.hi);
      d.low[i] = Math.min(d.low[i], tick.lo);
      d.close[i] = tick.price;
      this.priceSeries.update(this.point(i, "price"));
    } else {
      Object.keys(d).forEach((k) => (d[k] as (number | null)[]).push(null));
      const i = n;
      d.time[i] = bucket;
      d.open[i] = tick.price;
      d.high[i] = tick.hi;
      d.low[i] = tick.lo;
      d.close[i] = tick.price;
      d.volume[i] = 0;
      this.timeIndex.set(bucket, i);
      this.seriesPlan().forEach(([s, kind]) => s.update(this.point(i, kind)));
    }
    if (this.hoverTime === undefined) this.emitLegend();
    return true;
  }

  /** Initial view: from the range's start date to the latest bar (older history stays scrollable), prices
   *  auto-scaled and centred on every pane (a dragged price axis or zoom is reset). */
  private showFrom(viewStart?: number): void {
    this.viewStart = viewStart;
    this.yZoom = 1;
    this.charts.forEach((c) => c.priceScale("right").applyOptions({ autoScale: true }));
    const t = this.data?.time;
    if (!t?.length) return;
    const i = viewStart == null ? 0 : t.findIndex((x) => x >= viewStart);
    if (i <= 0) {
      this.main.timeScale().fitContent();
      return;
    }
    this.main.timeScale().setVisibleLogicalRange({ from: i - 0.5, to: t.length - 1 + 3 });
  }

  private applyFormat(): void {
    const d = this.data!;
    const last = d.close[d.close.length - 1];
    const precision = last < 1 ? 4 : 2;
    const priceFormat = { type: "price" as const, precision, minMove: 1 / 10 ** precision };
    this.priceSeries.applyOptions({ priceFormat });
    this.overlaySeries.forEach((o) => o.series.applyOptions({ priceFormat }));
    const intraday = this.meta!.intraday;
    this.charts.forEach((c) => c.applyOptions({
      localization: { timeFormatter: (t: Time) => barTime(t as number, intraday) },
      timeScale: { timeVisible: intraday },
    }));
  }

  // ---------------------------------------------------------------- options
  setType(type: ChartType): void {
    if (type === this.type) return;
    this.type = type;
    const range = this.main.timeScale().getVisibleLogicalRange();
    this.createPriceSeries();
    if (this.data) {
      const n = this.data.time.length;
      const arr = new Array(n);
      for (let i = 0; i < n; i++) arr[i] = this.point(i, "price");
      this.priceSeries.setData(arr);
      this.applyFormat();
      if (range) this.main.timeScale().setVisibleLogicalRange(range);
    }
  }

  /** Show/hide overlays and volume; the RSI/MACD panes are shown/hidden by React. */
  setIndicators(enabled: Set<IndicatorKey>): void {
    this.enabled = new Set(enabled);
    this.overlaySeries.forEach((o) => o.series.applyOptions({ visible: this.enabled.has(o.key) }));
    this.volSeries.applyOptions({ visible: this.enabled.has("volume") });
    this.bbFill.applyOptions({ visible: this.enabled.has("bb") });
    this.applyPriceMargins();
    // Only the bottom-most visible pane shows the time axis.
    const bottom = this.enabled.has("macd") ? this.macdChart : this.enabled.has("rsi") ? this.rsiChart : this.main;
    this.charts.forEach((c) => c.applyOptions({ timeScale: { visible: c === bottom } }));
    this.emitLegend();
  }

  // ---------------------------------------------------------------- legend
  private emitLegend(idx?: number): void {
    const d = this.data;
    if (!d || !this.meta || !this.params || !d.time.length) {
      this.cb.onLegend(null);
      return;
    }
    const i = idx ?? d.time.length - 1;
    this.cb.onLegend(buildLegend(d, i, this.meta.symbol, this.meta.intraday, this.params, this.enabled));
  }
}
