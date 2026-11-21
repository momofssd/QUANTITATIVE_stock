/** The most recent decisions (BUY or SELL), newest first; rows inside the chart range are highlighted. */
import { EXIT_LABEL, MARK, OUTCOME_COLOR, outcomeLabel, SETUP_LABEL } from "../../chart/markers";
import { price } from "../../lib/format";
import type { ExitReason, SetupName, TargetResult, TradeView } from "../../types/api";
import { dirCls, left, pct, signedPct, span } from "./util";

const LIMIT = 30;

function TradeCell({ tr, unit }: { tr?: TradeView; unit: string }) {
  if (!tr) return <td className="l">—</td>;
  if (tr.status === "open") {
    return <td className="l">Open <span className={dirCls(tr.return_pct)}>{signedPct(tr.return_pct, 1)}</span> · {left(tr, unit)} left</td>;
  }
  return (
    <td className="l">
      <span className={dirCls(tr.return_pct)}><b>{signedPct(tr.return_pct, 1)}</b></span>{" "}
      {EXIT_LABEL[tr.reason as ExitReason]} ({span(tr.days, unit)})
    </td>
  );
}

interface Props {
  t: TargetResult;
  barUnit: string;
  rangeStart: string;
}

export function DecisionTable({ t, barUnit, rangeStart }: Props) {
  const { spec } = t;
  const isBuy = spec.kind === "entry";
  const rows = t.signals.slice(-LIMIT).reverse();
  const inRange = t.signals.filter((s) => s.in_range).length;
  return (
    <div className="ta-dec-table">
      <div className="ta-dec-h">
        <span className={`mark-chip mark-${spec.key}`}>{MARK[spec.key].text}</span>
        <b>{isBuy ? "BUY decisions" : "SELL (take-profit) decisions"}</b>
        <span className="ta-dec-sub">
          most recent {Math.min(LIMIT, t.signals.length)} of {t.signals.length} · {inRange} inside the chart range
          (from {rangeStart}) · older rows are dimmed
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="ta-note">No {isBuy ? "BUY" : "SELL"} decisions in the analysed window.</p>
      ) : (
        <div className="table-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th className="l">Date</th><th className="l">Setup</th><th>P</th>
                <th>{isBuy ? "Entry" : "Price"}</th>
                <th>{isBuy ? "Profit-take" : "Pullback to"}</th>
                <th>{isBuy ? "Stop-loss" : "Invalid above"}</th>
                <th className="l">{isBuy ? "Justified?" : "Outcome"}</th>
                {isBuy && <th className="l">Trade exit</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.time} className={e.in_range ? "in-range" : "out-range"}>
                  <td className="l">
                    {e.date}
                    {!e.in_range && <small className="ta-out-tag">before chart range</small>}
                  </td>
                  <td className="l">{e.setup ? SETUP_LABEL[e.setup as Exclude<SetupName, "">] : "—"}</td>
                  <td>{pct(e.prob)}</td>
                  <td>{price(e.entry)}</td>
                  <td className={isBuy ? "up" : "down"}>{price(e.target)}</td>
                  <td className={isBuy ? "down" : "up"}>{price(e.stop)}</td>
                  <td className="l">
                    <i className="dot-o" style={{ background: OUTCOME_COLOR[e.outcome] }} />
                    {outcomeLabel(spec, e.outcome)}{e.days !== null && e.outcome !== "pending" ? ` (${span(e.days, barUnit)})` : ""}
                  </td>
                  {isBuy && <TradeCell tr={e.trade} unit={barUnit} />}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
