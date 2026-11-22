/**
 * Hosts the ChartEngine: creates it on mount, feeds it data/type/indicator changes, and exposes
 * applyTick() to the parent through a ref so live trades bypass React re-renders.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ChartEngine, type ChartType } from "../../chart/ChartEngine";
import type { LegendModel, RangeChange } from "../../chart/legend";
import type { EntryMarker, PriceLineDef } from "../../chart/markers";
import type { IndicatorKey } from "../../config/indicators";
import type { BarsState, ChartOverlay } from "../../hooks/useBars";
import type { Timeframe } from "../../types/api";
import { ChartLegend } from "./ChartLegend";

export interface PriceChartHandle {
  applyTick: (tick: { time: number; price: number; hi: number; lo: number }, tf: Timeframe, extended: boolean) => boolean;
}

interface Props {
  bars: BarsState | null;
  chartType: ChartType;
  enabled: Set<IndicatorKey>;
  overlay: ChartOverlay;
  rsiLabel: string;
  macdLabel: string;
  markers: EntryMarker[];
  priceLines: PriceLineDef[];
  onNeedOlder: () => void;
  /** Gain / loss over the selected range (updated with live ticks). */
  onRange?: (r: RangeChange | null) => void;
}

export const PriceChart = forwardRef<PriceChartHandle, Props>(function PriceChart(
  { bars, chartType, enabled, overlay, rsiLabel, macdLabel, markers, priceLines, onNeedOlder, onRange }, ref,
) {
  const mainEl = useRef<HTMLDivElement>(null);
  const vixEl = useRef<HTMLDivElement>(null);
  const rsiEl = useRef<HTMLDivElement>(null);
  const macdEl = useRef<HTMLDivElement>(null);
  const engine = useRef<ChartEngine | null>(null);
  const needOlder = useRef(onNeedOlder);
  needOlder.current = onNeedOlder;
  const rangeCb = useRef(onRange);
  rangeCb.current = onRange;
  const [legend, setLegend] = useState<LegendModel | null>(null);

  // Create first so the effects below can use it (effects run in declaration order).
  useEffect(() => {
    engine.current = new ChartEngine(
      { main: mainEl.current!, vix: vixEl.current!, rsi: rsiEl.current!, macd: macdEl.current! },
      { onLegend: setLegend, onNeedOlder: () => needOlder.current(), onRange: (r) => rangeCb.current?.(r) },
    );
    return () => {
      engine.current?.dispose();
      engine.current = null;
    };
  }, []);

  useEffect(() => engine.current?.setType(chartType), [chartType]);
  useEffect(() => engine.current?.setIndicators(enabled), [enabled]);
  useEffect(() => {
    if (!bars) return;
    engine.current?.setData(bars.payload, { fit: bars.mode === "fit", replace: bars.mode === "replace", key: bars.key });
  }, [bars]);

  useEffect(() => engine.current?.setMarkers(markers), [markers]);
  useEffect(() => engine.current?.setPriceLines(priceLines), [priceLines]);

  const fit = () => engine.current?.fitView();
  const zoom = (f: number) => engine.current?.zoom(f);

  useImperativeHandle(ref, () => ({
    applyTick: (tick, tf, extended) => engine.current?.applyTick(tick, tf, extended) ?? false,
  }), []);

  return (
    <div className="chart-stack">
      <ChartLegend model={legend} />
      <div className="pane-main-wrap">
      <div className="pane pane-main" ref={mainEl} />
      <div className="chart-zoom" role="group" aria-label="Chart view">
        <button onClick={() => zoom(1.25)} title="Zoom out (time and price)" aria-label="Zoom out">−</button>
        <button onClick={() => zoom(0.8)} title="Zoom in (time and price)" aria-label="Zoom in">+</button>
        <button className="fit" onClick={fit}
          title="Fit: show the selected range with prices auto-scaled and centred (undoes zoom, scroll and axis drags)">
          ⤢ Fit
        </button>
      </div>
      </div>
      <div className={`pane pane-sub${enabled.has("vix") ? "" : " hidden"}`} ref={vixEl}>
        <span className="pane-label">VIX (daily close)</span>
      </div>
      <div className={`pane pane-sub${enabled.has("rsi") ? "" : " hidden"}`} ref={rsiEl}>
        <span className="pane-label">{rsiLabel}</span>
      </div>
      <div className={`pane pane-sub${enabled.has("macd") ? "" : " hidden"}`} ref={macdEl}>
        <span className="pane-label">{macdLabel}</span>
      </div>
      {overlay && (
        <div className="chart-overlay">
          {overlay.kind === "loading" ? (
            <div><div className="spinner" />{overlay.text}</div>
          ) : (
            <div>{overlay.text}{overlay.sub && <><br /><small>{overlay.sub}</small></>}</div>
          )}
        </div>
      )}
    </div>
  );
});
