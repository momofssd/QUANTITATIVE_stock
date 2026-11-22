/**
 * Decision logs on the Backtests page: the models' own most recent decisions, exactly as the analysis made them
 * (model thresholds, rebound + trend, the 30 most recent per strategy) - the BUY, BUY S and SELL (sell-signal
 * strategy; also what the profit-take / stop-loss strategy sold there) tables, each with what the analysis'
 * simulation did with the decision; click a row for what supported it.
 * The backtest's Decisions / Strategy / threshold / max-shares settings do not apply here; the lot size follows
 * "Each BUY".
 */
import type { AnalysisResult, SimSizing, SimStrategy, TargetKey } from "../../types/api";
import { DecisionTable } from "../analysis/DecisionTable";

export function DecisionLogs({ r, sizing }: { r: AnalysisResult; sizing: SimSizing }) {
  const book = r.simulation?.[sizing];
  const barWord = r.timeframe === "1Day" ? "day" : r.timeframe === "1Week" ? "week" : "bar";
  const table = (k: TargetKey, run: SimStrategy | null | undefined) => (
    <DecisionTable t={r.targets[k]} barUnit={r.bar_unit} barWord={barWord} rangeStart={r.range_window.start}
      sim={run ?? undefined} simStart={run?.start_time} sizing={sizing} />
  );
  return (
    <div className="bt-logs">
      <div className="ta-group">Decision logs</div>
      <p className="bt-logs-sub">
        The models' own decisions as they were made: each model's threshold, rebound + trend setups, the 30 most
        recent per strategy. The settings above do not change them; the sim columns follow <b>Each BUY</b>.
      </p>
      <div className="ta-decisions-list">
        {/* each BUY table shows its own strategy's simulation */}
        {table("short", book?.with_bracket)}
        {table("accum", book?.sell_only)}
        {/* SELL: what the sell-signal strategy sold at each SELL (everything held), plus the profit-take / stop-loss
            strategy's lots still held at that SELL */}
        <DecisionTable t={r.targets.tp_short} barUnit={r.bar_unit} barWord={barWord} rangeStart={r.range_window.start}
          title="SELL decisions (sell-signal strategy)" sizing={sizing}
          sim={book?.sell_only ?? undefined} simStart={book?.sell_only?.start_time} simLabel="sell-signal"
          extraSim={{ label: "profit-take / stop-loss", sim: book?.with_bracket ?? undefined,
            simStart: book?.with_bracket?.start_time }} />
      </div>
    </div>
  );
}
