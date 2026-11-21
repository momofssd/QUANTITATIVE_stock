/** The "Chart" card: title + status note, toolbar, chart. */
import { forwardRef } from "react";
import type { EntryMarker, PriceLineDef } from "../../chart/markers";
import { feedName } from "../../config/feeds";
import { TF_LABEL } from "../../config/timeframes";
import type { BarsState, ChartOverlay } from "../../hooks/useBars";
import type { ChartSettings } from "../../hooks/useChartSettings";
import { barTime } from "../../lib/format";
import { ChartToolbar } from "./ChartToolbar";
import { PriceChart, type PriceChartHandle } from "./PriceChart";

interface Props {
  settings: ChartSettings;
  bars: BarsState | null;
  overlay: ChartOverlay;
  busyNote: string | null;
  onNeedOlder: () => void;
  onDateError: (msg: string | null) => void;
  markers: EntryMarker[];
  priceLines: PriceLineDef[];
  analyzing: boolean;
  onAnalyze: () => void;
}

function chartNote(bars: BarsState | null): string {
  const d = bars?.payload;
  if (!d || !d.count || !d.columns.time) return "";
  const parts = [
    `${d.count.toLocaleString()} bars since ${barTime(d.columns.time[0], false)}`,
    TF_LABEL[d.timeframe], feedName(d.feed), "ET",
  ];
  if (d.has_more) parts.push("scroll left for more");
  if (d.truncated) parts.push("bar limit reached");
  return parts.join(" · ");
}

export const ChartCard = forwardRef<PriceChartHandle, Props>(function ChartCard(
  { settings, bars, overlay, busyNote, onNeedOlder, onDateError, markers, priceLines, analyzing, onAnalyze },
  ref,
) {
  const p = bars?.payload.params;
  return (
    <section className="card chart-card">
      <div className="card-title">
        <h2>Chart</h2>
        <div className="ct-right">
          <span className="note">{busyNote ?? chartNote(bars)}</span>
          <button
            className="btn btn-primary btn-analyze" onClick={onAnalyze} disabled={analyzing}
            title="Retrain the quant analysis on this chart's K-lines and mark short-term entry / take-profit points"
          >
            {analyzing ? <><span className="spinner spinner-sm" /> Analyzing…</> : "Find entry points"}
          </button>
        </div>
      </div>
      <ChartToolbar s={settings} onDateError={onDateError} />
      <PriceChart
        ref={ref} bars={bars} chartType={settings.chartType} enabled={settings.enabledSet} overlay={overlay}
        rsiLabel={`RSI (${p?.rsi ?? settings.params.rsi})`}
        macdLabel={`MACD (${(p?.macd ?? settings.params.macd).join(", ")})`}
        markers={markers} priceLines={priceLines}
        onNeedOlder={onNeedOlder}
      />
    </section>
  );
});
