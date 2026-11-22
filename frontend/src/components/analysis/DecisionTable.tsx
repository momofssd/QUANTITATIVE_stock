/**
 * The most recent decisions (BUY or SELL), newest first; rows inside the chart range are highlighted.
 * Click a row to expand what supported that decision (DecisionWhy). The sim column shows what the analysis
 * simulation (quant/portfolio.py) did with each decision.
 */
import { Fragment, useState } from "react";
import { EXIT_LABEL, MARK, OUTCOME_COLOR, outcomeLabel, SETUP_LABEL } from "../../chart/markers";
import { price } from "../../lib/format";
import type { EntrySignal, ExitReason, SetupName, SimRun, SimSizing, TargetResult, TradeView } from "../../types/api";
import { DecisionWhy } from "./DecisionWhy";
import { EXIT_BY } from "./SimulationPanel";
import { dirCls, left, pct, signedPct, span, usd } from "./util";

const LIMIT = 30;
const money = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function TradeCell({ tr, unit }: { tr?: TradeView; unit: string }) {
  if (!tr) return <td className="l">—</td>;
  if (tr.status === "open") {
    return (
      <td className="l">Open <span className={dirCls(tr.return_pct)}>{signedPct(tr.return_pct, 1)}</span> ·{" "}
        {tr.days_left === null || tr.days_left === undefined ? "until the next SELL" : `${left(tr, unit)} left`}</td>
    );
  }
  return (
    <td className="l">
      <span className={dirCls(tr.return_pct)}><b>{signedPct(tr.return_pct, 1)}</b></span>{" "}
      {EXIT_LABEL[tr.reason as ExitReason]} ({span(tr.days, unit)})
    </td>
  );
}

/** A level with its distance in ATR and what set it (e.g. "+1.8 ATR · 50% retracement"). */
function LevelCell({ value, atr, basis, cls, sign }: { value: number; atr: number; basis: string; cls: string; sign: string }) {
  return (
    <td className={cls} title={basis}>
      {price(value)}
      {/* fixed mode's basis ("1.5 ATR") repeats the distance; "optimized" says where the multiple came from */}
      <small className="lvl-basis">{sign}{atr?.toFixed(2)} ATR{basis && !/^[\d.]+ ATR$/.test(basis) ? ` · ${basis}` : ""}</small>
    </td>
  );
}

function SimCell({ e, isBuy, sim, simStart, sizing }: {
  e: EntrySignal; isBuy: boolean; sim?: SimRun; simStart?: number; sizing: SimSizing;
}) {
  if (!sim || simStart === undefined) return <td className="l">—</td>;
  if (e.time < simStart) return <td className="l sim-na">before period</td>;
  if (isBuy) {
    const t = sim.trades.find((x) => x.buy_time === e.time);
    if (!t) return <td className="l sim-na">—</td>;
    return (
      <td className="l">
        Bought {sizing === "usd" ? "$100" : `1 share (${money(t.cost)})`} →{" "}
        <span className={dirCls(t.pnl)}><b>{usd(t.pnl)}</b></span>{" "}
        <small>{t.status === "open" ? "still holding" : `sold at ${EXIT_BY[t.reason].toLowerCase()}`}</small>
      </td>
    );
  }
  // A SELL sells every lot held at that moment.
  const sold = sim.trades.filter((x) => x.sell_time === e.time && x.reason === "sell");
  if (sold.length === 0) return <td className="l sim-na">nothing held</td>;
  const pnl = sold.reduce((a, x) => a + x.pnl, 0);
  const cost = sold.reduce((a, x) => a + x.cost, 0);
  const n = sold.length;
  const what = `${n === 1 ? "" : "all "}${n} ${sizing === "usd" ? "lot" : "share"}${n === 1 ? "" : "s"}`;
  return (
    <td className="l">
      Sold {what} ({money(cost)}) → <span className={dirCls(pnl)}><b>{usd(pnl)}</b></span>
    </td>
  );
}

/** A simulation column: what one strategy's simulation did with each decision. */
export interface SimColumn {
  label: string;       // e.g. "sell-signal"
  sim?: SimRun;
  simStart?: number;
}

interface Props {
  t: TargetResult;
  barUnit: string;
  barWord: string;     // "day" / "week" / "bar"
  rangeStart: string;
  sim?: SimRun;
  simStart?: number;
  sizing: SimSizing;
  /** Title override (e.g. "SELL decisions (sell-signal strategy)"). */
  title?: string;
  /** Names the main sim column's strategy when the table has more than one. */
  simLabel?: string;
  /** Extra sim column (another strategy), shown after the main one. */
  extraSim?: SimColumn;
}

export function DecisionTable({ t, barUnit, barWord, rangeStart, sim, simStart, sizing, title, simLabel, extraSim }: Props) {
  const { spec } = t;
  const isBuy = spec.kind === "entry";
  const rows = t.signals.slice(-LIMIT).reverse();
  const inRange = t.signals.filter((s) => s.in_range).length;
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const toggle = (time: number) => setOpen((o) => {
    const n = new Set(o);
    if (n.has(time)) n.delete(time);
    else n.add(time);
    return n;
  });
  const accum = spec.label_rule === "next_sell";   // sell-signal BUY model: no levels, sold at the next SELL
  const cols = (accum ? 7 : isBuy ? 9 : 8) + (extraSim ? 1 : 0);
  const simHead = (label?: string) => `${sizing === "usd" ? "$100" : "1-share"} sim${label ? ` · ${label}` : ""}`;
  return (
    <div className="ta-dec-table">
      <div className="ta-dec-h">
        <span className={`mark-chip mark-${spec.key}`}>{MARK[spec.key].text}</span>
        <b>{title ?? (spec.label_rule === "next_sell" ? "BUY S decisions (sell-signal strategy)"
          : isBuy ? "BUY decisions (profit-take / stop-loss)" : "SELL (take-profit) decisions")}</b>
        <span className="ta-dec-sub">
          most recent {Math.min(LIMIT, t.signals.length)} of {t.signals.length} · {inRange} inside the chart range
          (from {rangeStart}) · older rows are dimmed · click a row for what supported the decision
          {isBuy && spec.bracket === "optimal" && " · profit-take / stop-loss multiples chosen by backtested profit"}
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
                {!accum && <th>{isBuy ? "Profit-take" : "Pullback to"}</th>}
                {!accum && <th>{isBuy ? "Stop-loss" : "Invalid above"}</th>}
                <th className="l">{accum ? "Profit at next SELL?" : isBuy ? "Justified?" : "Outcome"}</th>
                {isBuy && <th className="l">{accum ? "Sold at next SELL" : `Trade exit (${spec.horizon} sessions)`}</th>}
                <th className="l">{simHead(simLabel)}</th>
                {extraSim && <th className="l">{simHead(extraSim.label)}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const expanded = open.has(e.time);
                return (
                  <Fragment key={e.time}>
                    <tr className={`dec-row ${e.in_range ? "in-range" : "out-range"} ${expanded ? "expanded" : ""}`}
                      onClick={() => toggle(e.time)} tabIndex={0} aria-expanded={expanded}
                      onKeyDown={(k) => { if (k.key === "Enter" || k.key === " ") { k.preventDefault(); toggle(e.time); } }}>
                      <td className="l">
                        <span className="dec-chev">{expanded ? "▾" : "▸"}</span>
                        {e.date}
                        {!e.in_range && <small className="ta-out-tag">before chart range</small>}
                      </td>
                      <td className="l">{e.setup ? SETUP_LABEL[e.setup as Exclude<SetupName, "">] : "—"}</td>
                      <td>{pct(e.prob)}</td>
                      <td>{price(e.entry)}</td>
                      {accum ? null : isBuy ? (
                        <>
                          <LevelCell value={e.target} atr={e.tp_atr} basis={e.target_basis} cls="up" sign="+" />
                          <LevelCell value={e.stop} atr={e.sl_atr} basis={e.stop_basis} cls="down" sign="−" />
                        </>
                      ) : (
                        <>
                          <td className="down">{price(e.target)}</td>
                          <td className="up">{price(e.stop)}</td>
                        </>
                      )}
                      <td className="l">
                        <i className="dot-o" style={{ background: OUTCOME_COLOR[e.outcome] }} />
                        {outcomeLabel(spec, e.outcome)}{e.days !== null && e.outcome !== "pending" ? ` (${span(e.days, barUnit)})` : ""}
                      </td>
                      {isBuy && <TradeCell tr={e.trade} unit={barUnit} />}
                      <SimCell e={e} isBuy={isBuy} sim={sim} simStart={simStart} sizing={sizing} />
                      {extraSim && <SimCell e={e} isBuy={isBuy} sim={extraSim.sim} simStart={extraSim.simStart} sizing={sizing} />}
                    </tr>
                    {expanded && (
                      <tr className="dec-why">
                        <td colSpan={cols}><DecisionWhy e={e} isBuy={isBuy} accum={accum} barWord={barWord} /></td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
