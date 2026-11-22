/** The "Chart" card: title + the selected range's gain / loss + status note, toolbar, chart. */
import { forwardRef, useState } from "react";
import type { RangeChange } from "../../chart/legend";
import {
  BUY_SETUPS, SETUP_LABEL, type BuySetup, type BuySetupFilter, type EntryMarker, type PriceLineDef,
} from "../../chart/markers";
import { feedName } from "../../config/feeds";
import { TF_LABEL } from "../../config/timeframes";
import type { BarsState, ChartOverlay } from "../../hooks/useBars";
import type { ChartSettings } from "../../hooks/useChartSettings";
import { barTime, dirClass, pct, price, signed } from "../../lib/format";

/** "1Y  +$51.20 (+17.35%)  from 295.03 · close 11/20/2025" */
function RangeBadge({ rc }: { rc: RangeChange }) {
  return (
    <span className={`range-chg ${dirClass(rc.change)}`}
      title={`${rc.label}: from ${price(rc.base)} (${rc.baseLabel}) to ${price(rc.last)}`}>
      <span className="rc-k">{rc.label}</span>
      <b>{signed(rc.change)} ({pct(rc.changePct)})</b>
      <small>from {price(rc.base)} · {rc.baseLabel}</small>
    </span>
  );
}
import { ChartToolbar } from "./ChartToolbar";
import { PriceChart, type PriceChartHandle } from "./PriceChart";

export interface BuyFilterProps {
  value: BuySetupFilter;
  counts: Record<BuySetup, number>; // BUY + BUY S decisions per setup in the analysed window
  onToggle: (setup: BuySetup, on: boolean) => void;
}

const SETUP_HINT: Record<BuySetup, string> = {
  rebound: "bought while under pressure (below SMA20, falling) as selling momentum eases",
  trend: "bought in a clear uptrend (close > SMA20 > SMA50, both rising, ADX ≥ 20)",
};

/** Two toggles: switch a setup off to filter its BUY / BUY S entries off the chart. */
function BuySetupButtons({ f }: { f: BuyFilterProps }) {
  return (
    <div className="buy-filter" role="group" aria-label="BUY entries shown, by setup">
      <span className="note">BUY setups</span>
      <div className="seg seg-sm">
        {BUY_SETUPS.map((k) => {
          const on = f.value[k];
          return (
            <button key={k} className={on ? "on" : "off"} aria-pressed={on} onClick={() => f.onToggle(k, !on)}
              title={`${SETUP_LABEL[k]} BUYs (${f.counts[k]}): ${SETUP_HINT[k]}. Click to ${on ? "filter them out" : "show them again"}.`}>
              {SETUP_LABEL[k]} <small>{f.counts[k]}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}

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
  /** BUY setup filter; null while no analysis markers are on the chart. */
  buyFilter: BuyFilterProps | null;
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
  { settings, bars, overlay, busyNote, onNeedOlder, onDateError, markers, priceLines, analyzing, onAnalyze, buyFilter },
  ref,
) {
  const p = bars?.payload.params;
  const [range, setRange] = useState<RangeChange | null>(null);
  return (
    <section className="card chart-card">
      <div className="card-title">
        <h2>Chart{range && <RangeBadge rc={range} />}</h2>
        <div className="ct-right">
          <span className="note">{busyNote ?? chartNote(bars)}</span>
          {buyFilter && <BuySetupButtons f={buyFilter} />}
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
        onNeedOlder={onNeedOlder} onRange={setRange}
      />
    </section>
  );
});
