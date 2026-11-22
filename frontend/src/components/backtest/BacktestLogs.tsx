/**
 * Decision logs of the backtest scenario (Backtests page), newest first, in points. They follow every setting above:
 *   BUY   bars whose expected gain was at least the BUY bar x the expected risk (optionally only bars in a setup), the
 *         most recent N - each one bought (with its lot's result) or halted while the max-shares cap was reached
 *   SELL  the period's bars whose expected risk was at least the SELL bar x the expected gain, and what each sold
 * Click a row for what supported the decision: the analysis' own explanation when it made that decision, otherwise
 * computed on demand by the server (/api/backtest/{run_id}/why - decisions of a setup filter or a custom bar).
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { MARK, OUTCOME_COLOR, outcomeLabel, SETUP_LABEL } from "../../chart/markers";
import { price } from "../../lib/format";
import { api, isAbort, type ApiError } from "../../services/api";
import type {
  AnalysisResult, BacktestResult, BacktestScenario, BacktestSetups, BtLogBuy, BtLogSell, DecisionWhy as Why,
  EntrySignal, Outcome, SetupName, SimSizing, TargetSpec,
} from "../../types/api";
import { DecisionWhy, type WhyDecision } from "../analysis/DecisionWhy";
import { EXIT_BY } from "../analysis/SimulationPanel";
import { dirCls, pts, ratioX, span, usd } from "../analysis/util";
import { capText, money, shares, signedPct } from "./format";

const SETUPS_TEXT: Record<BacktestSetups, string> = {
  any: "any bar", rebound: "rebound setup", trend: "trend setup", both: "rebound or trend setup",
};
const setupName = (s?: SetupName) => (s ? SETUP_LABEL[s as Exclude<SetupName, "">] : "—");
const barWordOf = (tf: string) => (tf === "1Day" ? "day" : tf === "1Week" ? "week" : "bar");

function useOpenRows() {
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const toggle = (t: number) => setOpen((o) => {
    const next = new Set(o);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    return next;
  });
  return [open, toggle] as const;
}

/** Props that make a table row expandable (click, Enter or Space). */
const rowToggle = (time: number, expanded: boolean, toggle: (t: number) => void) => ({
  onClick: () => toggle(time), tabIndex: 0, "aria-expanded": expanded,
  onKeyDown: (k: React.KeyboardEvent) => {
    if (k.key === "Enter" || k.key === " ") {
      k.preventDefault();
      toggle(time);
    }
  },
});

function OutcomeCell({ spec, o, days, unit }: { spec: TargetSpec; o: Outcome; days: number | null; unit: string }) {
  return (
    <td className="l" title={o === "pending" ? "Known once the next interim high is confirmed" : `known ${days !== null ? span(days, unit) : ""} later`}>
      <i className="dot-o" style={{ background: OUTCOME_COLOR[o] }} />{outcomeLabel(spec, o)}
    </td>
  );
}

type WhyData = { why: Why; gain_pts: number | null; risk_pts: number | null; ratio: number | null };
/** Explanations fetched on demand, per training / side / bar (re-opening a row does not ask again). */
const whyCache = new Map<string, WhyData>();

function WhyRow({ runId, side, row, e, cols, barWord, rr }: {
  runId: string; side: "buy" | "sell"; row: BtLogBuy | BtLogSell; e: EntrySignal | undefined; cols: number;
  barWord: string; rr: { bar: number; default: number };
}) {
  const key = `${runId}|${side}|${row.time}`;
  const [data, setData] = useState<WhyData | null>(() => whyCache.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (e || whyCache.has(key)) return;
    const c = new AbortController();
    api.why(runId, side, row.time, c.signal)
      .then((d) => { whyCache.set(key, d); setData(d); })
      .catch((err) => { if (!isAbort(err)) setError((err as ApiError).message); });
    return () => c.abort();
  }, [e, key, runId, side, row.time]);
  // the analysis' own explanation, or the one computed now (same models, same bar)
  const dec: WhyDecision | undefined = e ?? (data ? {
    date: row.date, entry: row.price, setup: row.setup, ratio: data.ratio, outcome: row.outcome,
    real_gain_pts: row.real_gain_pts, real_risk_pts: row.real_risk_pts, why: data.why,
  } : undefined);
  const custom = row.ratio !== null && row.ratio < rr.default;
  return (
    <tr className="dec-why">
      <td colSpan={cols}>
        {custom && (
          <p className="ta-note why-custom">
            {side === "buy" ? "Gain / risk" : "Risk / gain"} {ratioX(row.ratio)} is below the analysis' {rr.default}×: this{" "}
            {side === "buy" ? "BUY" : "SELL"} comes from your custom bar ({rr.bar}×).
          </p>
        )}
        {dec ? <DecisionWhy e={dec} isBuy={side === "buy"} barWord={barWord} rr={rr.bar} />
          : error ? <p className="ta-note">{error}</p>
            : <div className="why-loading"><span className="spinner spinner-sm dark" /> Explaining this decision…</div>}
      </td>
    </tr>
  );
}

/** Expected (and, once known, real) points of a decision. */
function PointsCells({ x }: { x: BtLogBuy | BtLogSell }) {
  const real = x.outcome !== "pending" && x.real_gain_pts !== null && x.real_risk_pts !== null;
  return (
    <>
      <td className="up" title={real ? `really followed: +${pts(x.real_gain_pts)}` : "not known yet"}>
        {pts(x.gain_pts, true)}{real && <small className="bt-real"> {pts(x.real_gain_pts, true)}</small>}</td>
      <td className="down" title={real ? `really followed: −${pts(x.real_risk_pts)}` : "not known yet"}>
        −{pts(x.risk_pts)}{real && <small className="bt-real"> −{pts(x.real_risk_pts)}</small>}</td>
      <td>{ratioX(x.ratio, true)}</td>
    </>
  );
}

function LotCells({ row, sizing, cap, unit }: { row: BtLogBuy; sizing: SimSizing; cap: number | null; unit: string }) {
  if (row.status === "halted") {
    return (
      <td className="l bt-halt" colSpan={6} title={`Max shares held: ${cap !== null ? capText(cap) : "—"}`}>
        Halted · already holding {shares(row.held ?? 0, sizing)} sh (max {cap !== null ? capText(cap) : "—"}) - not bought
      </td>
    );
  }
  const t = row.trade;
  if (!t) return <td className="l" colSpan={6}>—</td>;
  return (
    <>
      <td title={`${t.qty} shares for ${money(t.cost)}`}>{sizing === "usd" ? `${t.qty.toFixed(3)} sh` : `1 sh · ${money(t.cost)}`}</td>
      <td className="l">{t.status === "open" ? <i>still held</i> : <>{t.sell_date} · {price(t.sell_price)}</>}</td>
      <td className="l">{EXIT_BY[t.reason]}</td>
      <td>{span(t.bars, unit)}</td>
      <td className={dirCls(t.pnl)}><b>{usd(t.pnl)}</b></td>
      <td className={dirCls(t.pnl_pct)}>{signedPct(t.pnl_pct)}</td>
    </>
  );
}

function BuyLog({ r, res, sc }: { r: AnalysisResult; res: BacktestResult; sc: BacktestScenario }) {
  const spec = r.targets.short.spec;
  const why = useMemo(() => new Map(r.targets.short.signals.map((s) => [s.time, s])), [r]);
  const [open, toggle] = useOpenRows();
  const rows = sc.buy_log;
  const halted = rows.filter((x) => x.status === "halted").length;
  const cap = res.params.max_shares;
  const unit = res.bar_unit;
  const z = res.params.sizing;
  return (
    <div className="ta-dec-table">
      <div className="ta-dec-h">
        <span className="mark-chip mark-short">{MARK.short.text}</span>
        <b>BUY decisions (gain vs risk)</b>
        <span className="ta-dec-sub">
          {rows.length} decision{rows.length === 1 ? "" : "s"} ({SETUPS_TEXT[res.params.setups]}, expected gain ≥{" "}
          {res.rr.buy}× the expected risk, the most recent {res.params.n === 100 ? "100 at most" : res.params.n})
          {halted > 0 && <> · <b>{rows.length - halted} bought, {halted} halted</b> at the {capText(cap ?? 0)}-share cap</>}
          {" "}· newest first · click a row for what supported it
        </span>
      </div>
      <div className="table-scroll">
        <table className="grid">
          <thead>
            <tr>
              <th className="l">Date</th><th className="l">Setup</th>
              <th title="expected points to the next interim high (small: what really followed)">Gain (pts)</th>
              <th title="expected points down on the way (small: what really followed)">Risk (pts)</th>
              <th>Gain / risk</th><th>Price</th>
              <th className="l">Gain came?</th>
              <th>{z === "usd" ? "$100 lot" : "1-share lot"}</th><th className="l">Sold</th>
              <th className="l">Exit by</th><th>Held</th><th>P&amp;L</th><th>Return</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => {
              const expanded = open.has(x.time);
              return (
                <Fragment key={x.time}>
                  <tr className={`dec-row${x.status === "halted" ? " bt-halted" : ""}${expanded ? " expanded" : ""}`}
                    {...rowToggle(x.time, expanded, toggle)}>
                    <td className="l"><span className="dec-chev">{expanded ? "▾" : "▸"}</span>{x.date}</td>
                    <td className="l">{setupName(x.setup)}</td>
                    <PointsCells x={x} />
                    <td>{price(x.price)}</td>
                    <OutcomeCell spec={spec} o={x.outcome} days={x.days} unit={unit} />
                    <LotCells row={x} sizing={z} cap={cap} unit={unit} />
                  </tr>
                  {expanded && <WhyRow runId={r.run_id} side="buy" row={x} e={why.get(x.time)} cols={13}
                    barWord={barWordOf(r.timeframe)} rr={{ bar: res.rr.buy, default: res.rr.default }} />}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SellLog({ r, res, sc }: { r: AnalysisResult; res: BacktestResult; sc: BacktestScenario }) {
  const spec = r.targets.tp_short.spec;
  const why = useMemo(() => new Map(r.targets.tp_short.signals.map((s) => [s.time, s])), [r]);
  const [open, toggle] = useOpenRows();
  const rows: BtLogSell[] = sc.sell_log;
  const z = res.params.sizing;
  return (
    <div className="ta-dec-table">
      <div className="ta-dec-h">
        <span className="mark-chip mark-tp_short">{MARK.tp_short.text}</span>
        <b>SELL decisions (risk vs gain)</b>
        <span className="ta-dec-sub">
          {rows.length} SELL decision{rows.length === 1 ? "" : "s"} from {sc.start_date} (the first BUY) · expected risk ≥{" "}
          {res.rr.sell}× the expected gain · each one sells every lot held · newest first · click a row for what
          supported it
        </span>
      </div>
      {rows.length === 0 ? <p className="ta-note">No SELL decisions in this period at this bar.</p> : (
        <div className="table-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th className="l">Date</th>
                <th title="expected points to the next interim high (small: what really followed)">Gain (pts)</th>
                <th title="expected points down on the way (small: what really followed)">Risk (pts)</th>
                <th>Risk / gain</th><th>Price</th><th className="l">Risk came?</th>
                <th className="l">Sold ({z === "usd" ? "$100" : "1-share"} lots)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => {
                const expanded = open.has(x.time);
                return (
                  <Fragment key={x.time}>
                    <tr className={`dec-row${expanded ? " expanded" : ""}`} {...rowToggle(x.time, expanded, toggle)}>
                      <td className="l"><span className="dec-chev">{expanded ? "▾" : "▸"}</span>{x.date}</td>
                      <PointsCells x={x} />
                      <td>{price(x.price)}</td>
                      <OutcomeCell spec={spec} o={x.outcome} days={x.days} unit={res.bar_unit} />
                      <td className="l">
                        {x.sold ? (
                          <>Sold {x.sold.lots === 1 ? "1 lot" : `all ${x.sold.lots} lots`} ({shares(x.sold.shares, z)} sh, cost{" "}
                            {money(x.sold.cost)}) → <span className={dirCls(x.sold.pnl)}><b>{usd(x.sold.pnl)}</b></span></>
                        ) : <span className="sim-na">nothing held</span>}
                      </td>
                    </tr>
                    {expanded && <WhyRow runId={r.run_id} side="sell" row={x} e={why.get(x.time)} cols={7}
                      barWord={barWordOf(r.timeframe)} rr={{ bar: res.rr.sell, default: res.rr.default }} />}
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

export function BacktestLogs({ r, res, sc }: { r: AnalysisResult; res: BacktestResult; sc: BacktestScenario }) {
  return (
    <div className="bt-logs">
      <div className="ta-group">Decision logs</div>
      <p className="bt-logs-sub">
        The decisions of this backtest under the settings above (decisions, strategy, BUY and SELL bars, lot size, max
        shares held), with what the simulation did with each one. Gain / risk are the expected points (small grey: what
        really followed, once the next interim high is confirmed). "Gain came?" / "Risk came?" is the answer key: did the
        real points pass the same 1.5× test?
      </p>
      <div className="ta-decisions-list">
        <BuyLog r={r} res={res} sc={sc} />
        <SellLog r={r} res={res} sc={sc} />
      </div>
    </div>
  );
}
