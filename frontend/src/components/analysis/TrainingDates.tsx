/**
 * "Training dates for this run": the actual date ranges every model of this analysis learned from (shown after each
 * retrain), the data used, and a disclaimer.
 */
import { TF_LABEL } from "../../config/timeframes";
import type { AnalysisResult, TrainSpan } from "../../types/api";

const n = (v: number) => v.toLocaleString();

/** "≈ 5.0 years" on long spans, "17 sessions (22 days)" on short ones. */
function length(s: TrainSpan): string {
  if (s.days >= 365) return `≈ ${(s.days / 365.25).toFixed(1)} years`;
  return `${s.sessions} session${s.sessions === 1 ? "" : "s"} (${s.days} days)`;
}

export function TrainingDates({ r }: { r: AnalysisResult }) {
  const t = r.training;
  if (!t) return null;
  const rows = [
    { key: "short" as const, label: "BUY", chip: "mark-short" },
    { key: "tp_short" as const, label: "SELL", chip: "mark-tp_short" },
  ];
  const cur = t.targets.short.current;
  const short = cur !== null && cur.days < 365;
  return (
    <div className="ta-train">
      <div className="ta-train-h">
        <b>Training dates for this run</b>
        <span>{r.symbol} · {TF_LABEL[r.timeframe]} bars{r.extended ? " (extended hours)" : ""} · trained {t.trained_at}</span>
      </div>
      <div className="table-scroll">
        <table className="grid ta-train-t">
          <thead>
            <tr>
              <th className="l">Model</th>
              <th className="l">Today's model learned from</th>
              <th className="l">First check model learned from</th>
              <th className="l">Retrained</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ key, label, chip }) => {
              const m = t.targets[key];
              return (
                <tr key={key}>
                  <td className="l"><span className={`mark-chip ${chip}`}>{label}</span></td>
                  <td className="l">
                    {m.current ? <><b>{m.current.start} → {m.current.end}</b>
                      <small>{n(m.current.rows)} bars · {length(m.current)}</small></> : "not enough known outcomes"}
                  </td>
                  <td className="l">
                    {m.first ? <>{m.first.start} → {m.first.end}
                      <small>{n(m.first.rows)} bars · predicts from {m.first.predicts_from}</small></> : "—"}
                  </td>
                  <td className="l">{m.folds}× <small>every {m.retrain_every} bars</small></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="ta-note">
        Data used: {r.symbol} {TF_LABEL[r.timeframe]} bars {t.data.start} → {t.data.end} ({n(t.data.bars)}) ·{" "}
        {r.symbol} daily bars {t.daily.start} → {t.daily.end} (daily ATR, market features) · Yahoo Finance factors{" "}
        {t.factors.start} → {t.factors.end}. Model check {r.window.start} → {r.window.end} ({n(r.window.bars)} bars);
        chart range {r.range_window.start} → {r.range_window.end}.
      </p>
      {short && (
        <div className="ta-train-warn">
          Short history: today's model learned from only {length(cur!)} of {TF_LABEL[r.timeframe]} bars, so it has seen few
          market conditions. Treat its decisions with extra caution.
        </div>
      )}
      <p className="ta-train-disc">
        <b>Disclaimer:</b> each model learns only from the latest {n(t.train_bars)} bars whose 5-session outcome was
        already known before the bars it predicts. Every click of <b>Find entry points</b> retrains on the dates above;
        another day, range or interval uses different dates and can give different decisions. Past results do not
        guarantee future results. Research output, not investment advice.
      </p>
    </div>
  );
}
