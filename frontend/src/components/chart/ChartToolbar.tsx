/** Range buttons, interval select, chart type, indicators menu, extended hours, custom date range. */
import { useEffect, useState } from "react";
import { isIntraday, RANGE_BUTTONS, RANGE_TFS, TF_LABEL } from "../../config/timeframes";
import type { ChartType } from "../../chart/ChartEngine";
import type { ChartSettings } from "../../hooks/useChartSettings";
import type { Timeframe } from "../../types/api";
import { IndicatorMenu } from "./IndicatorMenu";

const TYPES: { key: ChartType; label: string; title: string }[] = [
  { key: "candles", label: "Candle", title: "Candlestick (K-line)" },
  { key: "bars", label: "OHLC", title: "OHLC bars" },
  { key: "line", label: "Line", title: "Line" },
];

export function ChartToolbar({ s, onDateError }: { s: ChartSettings; onDateError: (msg: string | null) => void }) {
  const [from, setFrom] = useState(s.from);
  const [to, setTo] = useState(s.to);
  useEffect(() => {
    setFrom(s.from);
    setTo(s.to);
  }, [s.from, s.to]);

  const intraday = isIntraday(s.timeframe);
  const applyDates = () => {
    if (!from) return;
    if (to && to <= from) {
      onDateError("End date must be after the start date.");
      return;
    }
    onDateError(null);
    s.actions.setCustomRange(from, to);
  };

  return (
    <div className="toolbar">
      <div className="seg" role="group" aria-label="Range">
        {RANGE_BUTTONS.map((r) => (
          <button key={r.key} className={s.range === r.key ? "on" : ""} onClick={() => s.range !== r.key && s.actions.setRange(r.key)}>
            {r.label}
          </button>
        ))}
      </div>

      <label className="field">
        <span>Interval</span>
        <select value={s.timeframe} onChange={(e) => s.actions.setTimeframe(e.target.value as Timeframe)}>
          {RANGE_TFS[s.range].map((tf) => <option key={tf} value={tf}>{TF_LABEL[tf]}</option>)}
        </select>
      </label>

      <div className="seg seg-sm" role="group" aria-label="Chart type">
        {TYPES.map((t) => (
          <button key={t.key} title={t.title} className={s.chartType === t.key ? "on" : ""} onClick={() => s.actions.setChartType(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      <IndicatorMenu
        timeframe={s.timeframe} params={s.params} enabled={s.enabledSet}
        onToggle={s.actions.toggleIndicator} onAllOff={s.actions.allIndicatorsOff}
        onParams={s.actions.setParams} onReset={s.actions.resetParams}
      />

      <label className="check" title="Include pre-market and after-hours bars on intraday charts" style={{ opacity: intraday ? 1 : 0.5 }}>
        <input type="checkbox" checked={s.extended} disabled={!intraday} onChange={(e) => s.actions.setExtended(e.target.checked)} />
        Extended hours
      </label>

      <div className="custom-range">
        <input type="date" aria-label="From date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span>to</span>
        <input type="date" aria-label="To date" value={to} onChange={(e) => setTo(e.target.value)} />
        <button className="btn btn-ghost" onClick={applyDates} disabled={!from}>Apply</button>
      </div>
    </div>
  );
}
