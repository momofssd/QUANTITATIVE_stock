/** One-line summary of the model decisions for the latest analysed K line (also drawn on that candle). */
import { latestDecisions, MARK } from "../../chart/markers";
import type { AnalysisResult } from "../../types/api";

export function DecisionStrip({ r }: { r: AnalysisResult }) {
  const ds = latestDecisions(r);
  if (!ds.length) return null;
  return (
    <div className="ta-decisions">
      <span className="ta-decisions-h">Latest K line <b>{ds[0].date}</b>:</span>
      {ds.map((d) => (
        <span
          key={d.key}
          className={`ta-dec ${d.active ? (d.key.startsWith("tp") ? "sell" : "buy") : "none"} ${d.reliable ? "" : "weak"}`}
          title={`P ${Math.round(d.prob * 100)}% vs threshold ${Math.round(d.threshold * 100)}%`
            + (d.reliable ? "" : " · this model had no reliable edge here")}
        >
          <b className={`mark-chip mark-${d.key}`}>{MARK[d.key].text}</b> {d.action}{d.reliable ? "" : "?"}
          <small>{Math.round(d.prob * 100)}% / {Math.round(d.threshold * 100)}%</small>
        </span>
      ))}
      <span className="ta-decisions-note">? = model without a reliable edge for this stock · P / threshold</span>
    </div>
  );
}
