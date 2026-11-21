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
