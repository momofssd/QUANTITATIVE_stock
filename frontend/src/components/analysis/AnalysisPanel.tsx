/**
 * "Short-term BUY & SELL Analysis" card: progress, marker legend, current K, BUY + SELL cards (chart range + model
 * check), the 30 most recent BUY and SELL decisions, factor relations, method.
 */
import { useEffect, useState } from "react";
import { BLUE, GREEN, RED } from "../../chart/markers";
import type { AnalysisApi } from "../../hooks/useAnalysis";
import { TF_LABEL } from "../../config/timeframes";
import { load, save } from "../../lib/storage";
import type { SimSizing, TargetKey } from "../../types/api";
import { CurrentKPanel } from "./CurrentKPanel";
import { DecisionTable } from "./DecisionTable";
import { FactorRelations } from "./FactorRelations";
import { ReadingGuide } from "./ReadingGuide";
import { SimulationPanel, type SimVariant } from "./SimulationPanel";
import { TargetCard } from "./TargetCard";
import { TrainingDates } from "./TrainingDates";

const rangeLabel = (rng: string) => (rng === "CUSTOM" ? "custom range" : `${rng} range`);

export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);
  return <>{Math.max(0, Math.round((now - since) / 1000))} s</>;
}

interface Props {
  a: AnalysisApi;
  /** How the chart differs from the training: other bars (interval / extended hours) or only another range. */
  mismatch: "bars" | "range" | null;
  /** The chart's range now. */
  chartRange: string;
  onRetrain: () => void;
  /** Live price from the quote stream (the current K line is live). */
  livePrice: number | null;
}

export function AnalysisPanel({ a, mismatch, chartRange, onRetrain, livePrice }: Props) {
  const r = a.result;
  const [simVariant, setSimVariantState] = useState<SimVariant>(() => load<SimVariant>("simVariant", "sell_only"));
  const setSimVariant = (v: SimVariant) => {
    setSimVariantState(v);
    save("simVariant", v);
  };
  // $100 per BUY (default) or 1 share per BUY
  const [simSizing, setSimSizingState] = useState<SimSizing>(() => load<SimSizing>("simSizing", "usd"));
  const setSimSizing = (z: SimSizing) => {
    setSimSizingState(z);
    save("simSizing", z);
  };
  if (!r && !a.loading) return null;
  const sim = r?.simulation ?? null;
  const barWord = r?.timeframe === "1Day" ? "day" : r?.timeframe === "1Week" ? "week" : "bar";
  const card = (k: TargetKey) => (
    <TargetCard
      t={r!.targets[k]} barUnit={r!.bar_unit} rangeWindow={r!.range_window} window={r!.window}
      showMarkers={a.visible[k]} onToggle={(on) => a.toggle(k, on)}
      optimization={k === "short" ? r!.params.optimization : null}
      bracket={k === "short" ? {
        value: a.bracket,
        used: { mode: r!.params.bracket, tp: r!.params.tp_atr, sl: r!.params.sl_atr },
        ranges: { tp: r!.params.tp_range, sl: r!.params.sl_range },
        onChange: a.setBracket, onRetrain, busy: a.loading,
      } : undefined}
    />
  );

  return (
    <section className="card analysis-card" id="analysis">
      <div className="card-title">
        <h2>
          Short-term BUY &amp; SELL Analysis{" "}
          <small>
            {r ? `${r.symbol} · ${rangeLabel(r.range)} · ${TF_LABEL[r.timeframe]} K-lines · chart range ${r.range_window.start} → ${r.range_window.end} (${r.range_window.bars.toLocaleString()} bars) · as of ${r.asof}` : ""}
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
          {a.bracket.mode === "optimal"
            ? <>Optimizing ATR: retraining the BUY model for 12 profit-take × stop-loss combinations…</>
            : <>Retraining walk-forward models on this chart's K-lines + Yahoo factors…</>}{" "}
          {a.startedAt && <Elapsed since={a.startedAt} />}
          <small>{a.bracket.mode === "optimal" ? "Usually 40–90 seconds." : "Usually 5–30 seconds depending on the interval."}</small>
        </div>
      )}

      {r && !a.loading && (
        <>
          <div className="ta-legend">
            Chart:
            <span><b className="mark-chip mark-short">BUY</b> short-term entry ▲ below the bar</span>
            <span><b className="mark-chip mark-tp_short">SELL</b> take profit ▼ above the bar</span>
            <span><i className="dot-o" style={{ background: GREEN }} />signal was right</span>
            <span><i className="dot-o" style={{ background: RED }} />wrong / expired</span>
            <span><i className="dot-o" style={{ background: BLUE }} />still open</span>
            <label className="check">
              <input type="checkbox" checked={a.visible.exits} onChange={(e) => a.toggle("exits", e.target.checked)} />
              trade exits (● with return)
            </label>
          </div>
          {mismatch === "bars" && (
            <div className="ta-stale">
              These results were trained on <b>{TF_LABEL[r.timeframe]}</b> bars{r.extended ? " (extended hours)" : ""},
              not the bars on the chart now, so their markers are hidden.
              <button className="link" onClick={onRetrain}>Retrain for the current chart</button>
            </div>
          )}
          {mismatch === "range" && (
            <div className="ta-stale soft">
              Trained on the <b>{rangeLabel(r.range)}</b>; the chart now shows the <b>{rangeLabel(chartRange)}</b>. Same{" "}
              {TF_LABEL[r.timeframe]} bars, so the markers and the current K decision still apply (drawn for the new view).
              The "This chart range" figures and highlighted rows are for the {rangeLabel(r.range)}.
              <button className="link" onClick={onRetrain}>Retrain for this range</button>
            </div>
          )}
          <TrainingDates r={r} />
          <CurrentKPanel r={r} intraday={a.intraday} livePrice={livePrice} />
          <ReadingGuide buyHold={r.targets.short.spec.horizon} sellHold={r.targets.tp_short.spec.horizon} />
          <div className="ta-group">Short-term</div>
          <div className="ta-grid">{card("short")}{card("tp_short")}</div>
          <div className="ta-group">Most recent decisions</div>
          <div className="ta-decisions-list">
            {sim && <SimulationPanel sim={sim} variant={simVariant} onVariant={setSimVariant} sizing={simSizing}
              onSizing={setSimSizing} barUnit={r.bar_unit} />}
            <DecisionTable t={r.targets.short} barUnit={r.bar_unit} barWord={barWord} rangeStart={r.range_window.start}
              sim={sim?.[simSizing][simVariant]} simStart={sim?.start_time} sizing={simSizing} />
            <DecisionTable t={r.targets.tp_short} barUnit={r.bar_unit} barWord={barWord} rangeStart={r.range_window.start}
              sim={sim?.[simSizing][simVariant]} simStart={sim?.start_time} sizing={simSizing} />
          </div>
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
