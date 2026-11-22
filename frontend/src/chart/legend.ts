/** Pure computation of the legend shown at the top-left of the chart. */
import type { IndicatorKey } from "../config/indicators";
import { barTime, isNum, price } from "../lib/format";
import type { BarColumns, ServerIndicatorParams } from "../types/api";
import { COLORS, OVERLAYS } from "./theme";

export interface LegendItem {
  label: string;
  value: string;
  color?: string;
}

export interface LegendModel {
  symbol: string;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  change: number;
  changePct: number | null;
  volume: number;
  items: LegendItem[];
}

/** Gain / loss over the selected range: the latest close vs the close just before the range started (the open of
 *  its first bar when no earlier bar is loaded, e.g. Max). */
export interface RangeChange {
  label: string;      // "1Y", "Max", "Custom range"
  base: number;
  baseLabel: string;  // what the base is: "close 11/20/2025" / "open 01/04/2016"
  last: number;
  change: number;
  changePct: number | null;
}

const RANGE_NAME: Record<string, string> = { MAX: "Max", CUSTOM: "Custom range" };

export function buildRangeChange(
  d: BarColumns, range: string, viewStart: number | undefined,
  base: { time: number; close: number; daily?: boolean } | null | undefined, intraday: boolean,
  officialLast?: number,   // intraday: the session's official close (until a live tick moves the last bar)
): RangeChange | null {
  const n = d.time.length;
  if (!n) return null;
  let from: number;
  let baseLabel: string;
  if (base && isNum(base.close)) {
    from = base.close;
    // an official (daily) close is labelled by its date; a bar's close by its bar time
    baseLabel = `close ${barTime(base.time, intraday && !base.daily)}`;
  } else {
    const i0 = Math.max(0, viewStart == null ? 0 : d.time.findIndex((t) => t >= viewStart));
    from = d.open[i0];
    baseLabel = `open ${barTime(d.time[i0], intraday)}`;
  }
  const last = isNum(officialLast) ? officialLast : d.close[n - 1];
  if (!isNum(from) || !isNum(last)) return null;
  const change = last - from;
  return { label: RANGE_NAME[range] ?? range, base: from, baseLabel, last, change,
    changePct: from ? (change / from) * 100 : null };
}

export function buildLegend(
  d: BarColumns, i: number, symbol: string, intraday: boolean,
  params: ServerIndicatorParams, enabled: Set<IndicatorKey>,
): LegendModel {
  const prevClose = i > 0 ? d.close[i - 1] : d.open[i];
  const change = d.close[i] - prevClose;
  const items: LegendItem[] = [];
  const seen = new Set<string>();
  for (const o of OVERLAYS) {
    if (!enabled.has(o.key) || o.legend === false || seen.has(o.col)) continue;
    seen.add(o.col);
    items.push({ label: o.label(params), value: price(d[o.col][i]), color: o.color });
  }
  if (enabled.has("vix") && d.vix) {
    const v = d.vix[i];
    items.push({ label: "VIX", value: isNum(v) ? v.toFixed(2) : "—", color: COLORS.vixText });
  }
  if (enabled.has("rsi")) {
    const v = d.rsi[i];
    items.push({ label: `RSI${params.rsi}`, value: isNum(v) ? v.toFixed(2) : "—", color: COLORS.rsi });
  }
  if (enabled.has("macd")) {
    const f = (v: number | null) => (isNum(v) ? v.toFixed(3) : "—");
    items.push({ label: "MACD", value: f(d.macd[i]), color: COLORS.macd });
    items.push({ label: "Sig", value: f(d.macd_signal[i]), color: COLORS.signal });
    items.push({ label: "Hist", value: f(d.macd_hist[i]) });
  }
  return {
    symbol, time: barTime(d.time[i], intraday),
    open: d.open[i], high: d.high[i], low: d.low[i], close: d.close[i],
    change, changePct: prevClose ? (change / prevClose) * 100 : null,
    volume: d.volume[i], items,
  };
}
