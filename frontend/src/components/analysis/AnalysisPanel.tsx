/** "Entry & Take-Profit Analysis" card: progress, marker legend, entry + take-profit targets, relations, guide. */
import { useEffect, useState } from "react";
import { BLUE, GREEN, RED } from "../../chart/markers";
import type { AnalysisApi } from "../../hooks/useAnalysis";
import { TF_LABEL } from "../../config/timeframes";
import type { TargetKey } from "../../types/api";
import { DecisionStrip } from "./DecisionStrip";
import { FactorRelations } from "./FactorRelations";
import { ReadingGuide } from "./ReadingGuide";
import { TargetCard } from "./TargetCard";

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);
  return <>{Math.max(0, Math.round((now - since) / 1000))} s</>;
}

interface Props {
  a: AnalysisApi;
  /** The chart now shows another interval than the one analysed. */
  stale: boolean;
  onRetrain: () => void;
}

export function AnalysisPanel({ a, stale, onRetrain }: Props) {
  const r = a.result;
  if (!r && !a.loading) return null;
  const card = (k: TargetKey) => (
    <TargetCard
      t={r!.targets[k]} barUnit={r!.bar_unit} showMarkers={a.visible[k]} onToggle={(on) => a.toggle(k, on)}
      bracket={k === "short" ? {
        value: a.bracket,
        used: { tp: r!.params.tp_atr, sl: r!.params.sl_atr },
        ranges: { tp: r!.params.tp_range, sl: r!.params.sl_range },
        onChange: a.setBracket, onRetrain, busy: a.loading,
      } : undefined}
      costLines={k === "long" ? { shown: a.visible.cost, onToggle: (on) => a.toggle("cost", on) } : undefined}
    />
  );

  return (
    <section className="card analysis-card" id="analysis">
      <div className="card-title">
        <h2>
          Entry &amp; Take-Profit Analysis{" "}
          <small>
            {r ? `${r.symbol} · ${TF_LABEL[r.timeframe]} K-lines · ${r.window.bars.toLocaleString()} bars ${r.window.start} → ${r.window.end} · as of ${r.asof}` : ""}
          </small>
        </h2>
        <div className="ct-right">
          {r && (
            <>
              <button className="btn btn-ghost" onClick={onRetrain} disabled={a.loading}>Retrain</button>
              <button className="btn btn-ghost" onClick={a.clear}>Clear</button>
            </>
          )}
        </div>
      </div>

      {a.loading && (
        <div className="ta-loading">
          <div className="spinner" />
          Retraining walk-forward models on this chart's K-lines + Yahoo factors… {a.startedAt && <Elapsed since={a.startedAt} />}
          <small>Usually 5–30 seconds depending on the interval.</small>
        </div>
      )}

      {r && !a.loading && (
        <>
          <div className="ta-legend">
            Chart:
            <span><b className="mark-chip mark-short">S</b><b className="mark-chip mark-long">L</b> entry ▲ below the bar</span>
            <span><b className="mark-chip mark-tp_short">TS</b><b className="mark-chip mark-tp_long">TL</b> take-profit ▼ above the bar</span>
            <span><i className="dot-o" style={{ background: GREEN }} />signal was right</span>
            <span><i className="dot-o" style={{ background: RED }} />wrong / expired</span>
            <span><i className="dot-o" style={{ background: BLUE }} />still open</span>
            <label className="check">
              <input type="checkbox" checked={a.visible.exits} onChange={(e) => a.toggle("exits", e.target.checked)} />
              trade exits (● with return)
            </label>
          </div>
          {stale && (
            <div className="ta-stale">
              These results were trained on <b>{TF_LABEL[r.timeframe]}</b> bars{r.extended ? " (extended hours)" : ""}, so
              their markers are hidden on this chart.
              <button className="link" onClick={onRetrain}>Retrain for the current chart</button>
            </div>
          )}
          <DecisionStrip r={r} />
          <ReadingGuide />
          <div className="ta-group">Entries</div>
          <div className="ta-grid">{card("short")}{card("long")}</div>
          <div className="ta-group">Take-profit</div>
          <div className="ta-grid">{card("tp_short")}{card("tp_long")}</div>
          <FactorRelations relations={r.relations} years={r.window.years} />
          <details className="ta-method">
            <summary>Method</summary>
            <ul>
              <li><b>Data:</b> {r.sources.stock} ({TF_LABEL[r.timeframe]}) for {r.symbol}; {r.sources.factors} for{" "}
                {Object.values(r.sources.factor_tickers).join(", ")} (^IRX, the 13-week T-bill yield, stands in for the Fed rate).
                Factors are daily; each bar uses {r.method.factor_alignment}.</li>
              <li><b>Labels:</b> {r.method.atr}. A signal at a day's close succeeds if price moves the ATR target in its direction
                before moving the ATR stop against it within the horizon; a day touching both counts as a stop.</li>
              <li><b>Model:</b> {r.method.model}; {r.method.features} features (stock trend, momentum, volatility, and its
                relation to SPY, QQQ, VIX, oil, gasoline and rates).</li>
              <li><b>Validation:</b> {r.method.training}</li>
              <li><b>Signals:</b> {r.method.signal_rule}</li>
              <li>A model is called reliable only if its AUC is at least 0.53 and its hit rate beats the base rate.</li>
            </ul>
            <p className="ta-note">Statistical research output, not investment advice. Past results do not guarantee future results.</p>
          </details>
        </>
      )}
    </section>
  );
}
