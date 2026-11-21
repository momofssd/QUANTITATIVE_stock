/**
 * One analysis target - an entry (short / long) or a take-profit (short / long):
 * reliability verdict, today's signal, out-of-sample record, trade results (entries), recent signals, drivers.
 *   short-term entry: profit-take / stop-loss editor (daily ATR), "justified" wording, bracket-order backtest
 *   long-term entry:  average cost of all long-term buys vs SMA 60 (validation)
 */
import { useEffect, useState } from "react";
import { COST_COLOR, EXIT_LABEL, MARK, OUTCOME_COLOR, outcomeLabel, SMA_CHECK_COLOR } from "../../chart/markers";
import type { Bracket } from "../../hooks/useAnalysis";
import { price } from "../../lib/format";
import type { CostCheck, ExitReason, TargetResult, TradeSummary, TradeView } from "../../types/api";

const pct = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(d)}%`);
const signedPct = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`;
const cls = (v: number | null | undefined) => (v === null || v === undefined || v === 0 ? "" : v > 0 ? "up" : "down");

export interface BracketEditor {
  value: Bracket;               // what the next retrain will use
  used: Bracket;                // what this result was trained with
  ranges: { tp: [number, number]; sl: [number, number] };
  onChange: (b: Bracket) => void;
  onRetrain: () => void;
  busy: boolean;
}

interface Props {
  t: TargetResult;
  barUnit: string; // "trading days", "hourly bars", ...
  showMarkers: boolean;
  onToggle: (on: boolean) => void;
  bracket?: BracketEditor;                                    // short-term entry only
  costLines?: { shown: boolean; onToggle: (on: boolean) => void }; // long-term entry only
}

function rule(t: TargetResult, unit: string): string {
  const s = t.spec;
  const atrName = s.atr_basis === "daily" ? "daily ATR" : "ATR";
  const window = s.horizon_mode === "sessions"
    ? `${s.horizon} trading sessions`
    : unit.endsWith("bars") ? `${s.horizon} × ${unit}` : `${s.horizon} ${unit}`;
  if (t.spec.key === "short") {
    return `Profit-take +${s.target_atr}× ${atrName} before stop-loss −${s.stop_atr}× ${atrName} within ${window}`;
  }
  return s.direction === "up"
    ? `+${s.target_atr} ${atrName} before −${s.stop_atr} ${atrName} within ${window}`
    : `−${s.target_atr} ${atrName} (pullback) before +${s.stop_atr} ${atrName} within ${window}`;
}

/** "3d" on daily, "3w" on weekly, "3 bars" on intraday intervals. */
function span(n: number, unit: string): string {
  if (unit === "trading days") return `${n}d`;
  if (unit === "weeks") return `${n}w`;
  return `${n} bar${n === 1 ? "" : "s"}`;
}

function left(tr: TradeView, unit: string): string {
  const n = tr.days_left ?? 0;
  return tr.left_unit === "sessions" ? `${n} session${n === 1 ? "" : "s"}` : span(n, unit);
}

function TradeCell({ tr, unit }: { tr?: TradeView; unit: string }) {
  if (!tr) return <td className="l">—</td>;
  if (tr.status === "open") {
    return <td className="l">Open <span className={cls(tr.return_pct)}>{signedPct(tr.return_pct, 1)}</span> · {left(tr, unit)} left</td>;
  }
  return (
    <td className="l">
      <span className={cls(tr.return_pct)}><b>{signedPct(tr.return_pct, 1)}</b></span>{" "}
      {EXIT_LABEL[tr.reason as ExitReason]} ({span(tr.days, unit)})
    </td>
  );
}

function BracketForm({ b }: { b: BracketEditor }) {
  const [tp, setTp] = useState(String(b.value.tp));
  const [sl, setSl] = useState(String(b.value.sl));
  useEffect(() => {
    setTp(String(b.value.tp));
    setSl(String(b.value.sl));
  }, [b.value.tp, b.value.sl]);
  const tpN = parseFloat(tp), slN = parseFloat(sl);
  const tpOk = Number.isFinite(tpN) && tpN >= b.ranges.tp[0] && tpN <= b.ranges.tp[1];
  const slOk = Number.isFinite(slN) && slN >= b.ranges.sl[0] && slN <= b.ranges.sl[1];
  const changed = tpOk && slOk && (tpN !== b.used.tp || slN !== b.used.sl);
  const commit = (ntp: string, nsl: string) => {
    const a = parseFloat(ntp), c = parseFloat(nsl);
    if (Number.isFinite(a) && Number.isFinite(c) && a >= b.ranges.tp[0] && a <= b.ranges.tp[1]
      && c >= b.ranges.sl[0] && c <= b.ranges.sl[1]) b.onChange({ tp: a, sl: c });
  };
  const breakeven = tpOk && slOk ? slN / (tpN + slN) : null;
  return (
    <div className="ta-bracket">
      <label>Profit-take
        <input type="number" step={0.25} min={b.ranges.tp[0]} max={b.ranges.tp[1]} value={tp} className={tpOk ? "" : "bad"}
          onChange={(e) => { setTp(e.target.value); commit(e.target.value, sl); }} /> × ATR
      </label>
      <label>Stop-loss
        <input type="number" step={0.25} min={b.ranges.sl[0]} max={b.ranges.sl[1]} value={sl} className={slOk ? "" : "bad"}
          onChange={(e) => { setSl(e.target.value); commit(tp, e.target.value); }} /> × ATR
      </label>
      <span className="ta-bracket-info">
        reward : risk {tpOk && slOk ? (tpN / slN).toFixed(2) : "—"} · break-even win rate {pct(breakeven)}
      </span>
      <button className="btn btn-primary" disabled={!changed || b.busy} onClick={b.onRetrain}
        title={changed ? "Retrain with these levels" : "Change a level to retrain"}>
        Retrain
      </button>
    </div>
  );
}

function TradeResults({ t, unit }: { t: TargetResult; unit: string }) {
  const tb = t.trades;
  if (!tb) return null;
  const a: TradeSummary = tb.signals;
  const e: TradeSummary = tb.every_day;
  const r = tb.rules;
  const bracketOnly = r.trail_after_atr <= 0 && !r.exit_with;
  const reasons = a.reasons ? (Object.entries(a.reasons) as [ExitReason, number][]).filter(([, n]) => n > 0) : [];
  const beat = a.avg_return_pct !== undefined && e.avg_return_pct !== undefined ? a.avg_return_pct > e.avg_return_pct : null;
  const window = r.horizon_mode === "sessions" ? `${r.horizon} trading sessions` : `${r.horizon} ${unit}`;
  return (
    <>
      <div className="ta-section">Trading these entries · backtest</div>
      <div className="ta-exit-rule">
        {bracketOnly
          ? <>Bracket order: sell at the profit-take (+{r.target_atr}× ATR), at the stop-loss (−{r.stop_atr}× ATR), or at the
            close after {window}.</>
          : <>Exit at the first of: stop −{r.stop_atr} ATR · target +{r.target_atr} ATR · trailing stop {r.trail_atr} ATR
            below the highest close once up {r.trail_after_atr} ATR · take-profit signal while in profit · {window}.</>}
      </div>
      {a.trades > 0 ? (
        <table className="grid ta-trades">
          <thead>
            <tr><th className="l" /><th>Trades</th><th>Win rate</th><th>Avg / trade</th><th>Profit factor</th><th>Avg bars held</th></tr>
          </thead>
          <tbody>
            <tr>
              <td className="l"><b>Signal entries</b></td><td>{a.trades}</td><td>{pct(a.win_rate)}</td>
              <td className={cls(a.avg_return_pct)}><b>{signedPct(a.avg_return_pct)}</b></td>
              <td>{a.profit_factor?.toFixed(2) ?? "—"}</td><td>{a.avg_days}</td>
            </tr>
            <tr className="muted-row">
              <td className="l" title="Same exit rules, entering at every bar's close">Any-bar entry</td><td>{e.trades}</td>
              <td>{pct(e.win_rate)}</td><td className={cls(e.avg_return_pct)}>{signedPct(e.avg_return_pct)}</td>
              <td>{e.profit_factor?.toFixed(2) ?? "—"}</td><td>{e.avg_days}</td>
            </tr>
          </tbody>
        </table>
      ) : <p className="ta-note">No closed trades yet.</p>}
      {beat !== null && a.trades > 0 && (
        <div className={`ta-tradecheck ${beat ? "ok" : "warn"}`}>
          {beat
            ? "Trading the signals beat entering on any bar with the same exits."
            : "Trading the signals did NOT beat entering on any bar with the same exits - the timing added no profit here."}
        </div>
      )}
      {reasons.length > 0 && (
        <div className="ta-reasons">Exits: {reasons.map(([k, n]) => <span key={k}>{EXIT_LABEL[k]} <b>{n}</b></span>)}</div>
      )}
      <p className="ta-note">Per-trade returns before commissions and slippage. Buy &amp; hold over the same window: {signedPct(tb.buy_hold_pct, 1)}.</p>
    </>
  );
}

function CostCheckBlock({ c, lines }: { c: CostCheck; lines?: Props["costLines"] }) {
  const cheaper = c.vs_dca_pct !== null && c.vs_dca_pct !== undefined ? c.vs_dca_pct < 0 : null;
  return (
    <>
      <div className="ta-section">Validation · average cost vs SMA {c.sma_len}</div>
      <div className={`ta-verdict ${c.validated ? "ok" : "warn"}`}>
        <b>{c.validated === null ? "Not checked" : c.validated ? "Validated" : "Not validated"}</b>
        {" — "}{c.verdict.replace(/^(Validated|Not validated): /, "")}
      </div>
      {c.entries > 0 && (
        <>
          <div className="ta-stats">
            <div><label>Long-term buys</label><b>{c.entries}</b></div>
            <div><label>Average cost</label><b style={{ color: COST_COLOR }}>{price(c.avg_cost)}</b></div>
            <div><label>SMA {c.sma_len} now</label><b style={{ color: SMA_CHECK_COLOR }}>{price(c.sma_now)}</b></div>
            <div><label>Cost vs SMA</label><b className={c.validated ? "up" : "down"}>{signedPct(c.discount_pct !== null ? -c.discount_pct : null, 1)}</b></div>
          </div>
          <p className="ta-note">
            Equal dollars per buy. The running average cost was below that day's SMA {c.sma_len} after {c.held_below ?? 0} of {c.entries} buys.
            {cheaper !== null && (
              <> Buying the same amount on every bar would average {price(c.dca_avg_cost)}: the long-term signals bought{" "}
                <b className={cheaper ? "up" : "down"}>{Math.abs(c.vs_dca_pct!).toFixed(1)}% {cheaper ? "cheaper" : "dearer"}</b>.</>
            )}
          </p>
        </>
      )}
      {lines && (
        <label className="check ta-toggle">
          <input type="checkbox" checked={lines.shown} onChange={(e) => lines.onToggle(e.target.checked)} />
          Show average cost (<span style={{ color: COST_COLOR }}>━</span>) and SMA {c.sma_len} (<span style={{ color: SMA_CHECK_COLOR }}>┅</span>) on the chart
        </label>
      )}
    </>
  );
}

export function TargetCard({ t, barUnit, showMarkers, onToggle, bracket, costLines }: Props) {
  const { spec, current: c, stats: s } = t;
  const isEntry = spec.kind === "entry";
  const isShort = spec.key === "short";
  const recent = t.signals.slice(-6).reverse();
  const ot = t.open_trade?.trade;
  return (
    <div className="ta-card">
      <div className="ta-head">
        <h3>{spec.label} <span className={`mark-chip mark-${spec.key}`}>{MARK[spec.key].text}</span></h3>
        <div className="ta-rule">{rule(t, barUnit)}</div>
      </div>

      {bracket && <BracketForm b={bracket} />}

      <div className={`ta-verdict ${s.reliable ? "ok" : "warn"}`}>
        <b>{s.reliable ? "Edge found" : "No reliable edge"}</b> — {s.verdict.replace(/^(Edge found|No reliable edge): /, "")}
      </div>

      {c && (
        <div className="ta-today">
          <div className={`ta-signal ${c.signal ? (s.reliable ? "on" : "on weak") : "off"} ${isEntry ? "" : "tp"}`}>
            {c.signal ? (isEntry ? "ENTRY SIGNAL" : "TAKE PROFIT") : (isEntry ? "NO ENTRY" : "HOLD")}
            <small>as of {c.date} close</small>
          </div>
          <div className="ta-prob">
            <div className="ta-prob-bar" title={`Threshold ${pct(c.threshold)}`}>
              <i style={{ width: `${Math.min(100, c.prob * 100)}%` }} />
              <em style={{ left: `${Math.min(100, c.threshold * 100)}%` }} />
            </div>
            <div className="ta-prob-txt">
              P({isShort ? "profit-take first" : isEntry ? "rise first" : "pullback first"}) <b>{pct(c.prob)}</b> · threshold{" "}
              {pct(c.threshold)} · base rate {pct(c.base_rate)}
            </div>
          </div>
          <table className="kv ta-levels">
            <tbody>
              <tr>
                <th>{isEntry ? "Entry (close)" : "Price (close)"}</th><td>{price(c.entry)}</td>
                <th>{spec.atr_basis === "daily" ? "Daily ATR(14)" : "ATR(14)"}</th><td>{price(c.atr)}</td>
              </tr>
              <tr>
                <th>{isShort ? "Profit-take" : isEntry ? "Target" : "Pullback to"}</th><td className={isEntry ? "up" : "down"}>{price(c.target)}</td>
                <th>{isShort ? "Stop-loss" : isEntry ? "Stop" : "Invalid above"}</th><td className={isEntry ? "down" : "up"}>{price(c.stop)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {isEntry && ot?.status === "open" && t.open_trade && (
        <div className="ta-open">
          <b>Open trade</b> from {t.open_trade.date} at {price(t.open_trade.entry)}:{" "}
          <span className={cls(ot.return_pct)}>{signedPct(ot.return_pct, 1)}</span> · {ot.trailing ? "trailing stop" : isShort ? "stop-loss" : "stop"}{" "}
          {price(ot.stop)} · {isShort ? "profit-take" : "target"} {price(ot.target)} · {left(ot, barUnit)} left
        </div>
      )}

      {t.cost_check && <CostCheckBlock c={t.cost_check} lines={costLines} />}

      <div className="ta-section">Out-of-sample record (analysed window)</div>
      <div className="ta-stats">
        <div><label>Signals</label><b>{s.signals}</b></div>
        <div>
          <label>{isShort ? "Justified" : "Hit rate"}</label>
          <b className={s.hit_rate !== null && s.base_rate !== null && s.hit_rate > s.base_rate ? "up" : ""}>{pct(s.hit_rate)}</b>
        </div>
        <div><label>Base rate</label><b>{pct(s.base_rate)}</b></div>
        <div><label>AUC</label><b>{s.auc?.toFixed(2) ?? "—"}</b></div>
      </div>
      {isShort && (
        <p className="ta-note">
          Justified = the price reached the profit-take before the stop-loss within the window ({s.hits} of {s.resolved} decided
          entries). Base rate = the same for an entry on any bar.
        </p>
      )}

      {isEntry && <TradeResults t={t} unit={barUnit} />}

      <label className="check ta-toggle">
        <input type="checkbox" checked={showMarkers} onChange={(e) => onToggle(e.target.checked)} />
        Show {MARK[spec.key].text} markers on the chart{!s.reliable && " (no reliable edge here)"}
      </label>

      {recent.length > 0 && (
        <>
          <div className="ta-section">Latest signals</div>
          <table className="grid ta-recent">
            <thead>
              <tr>
                <th className="l">Date</th><th>P</th><th>{isEntry ? "Entry" : "Price"}</th>
                {isShort && <><th>Profit-take</th><th>Stop-loss</th></>}
                <th className="l">{isShort ? "Justified?" : "Signal outcome"}</th>{isEntry && <th className="l">Trade exit</th>}
              </tr>
            </thead>
            <tbody>
              {recent.map((e) => (
                <tr key={e.time}>
                  <td className="l">{e.date}</td><td>{pct(e.prob)}</td><td>{price(e.entry)}</td>
                  {isShort && <><td className="up">{price(e.target)}</td><td className="down">{price(e.stop)}</td></>}
                  <td className="l">
                    <i className="dot-o" style={{ background: OUTCOME_COLOR[e.outcome] }} />
                    {outcomeLabel(spec, e.outcome)}{e.days !== null && e.outcome !== "pending" ? ` (${span(e.days, barUnit)})` : ""}
                  </td>
                  {isEntry && <TradeCell tr={e.trade} unit={barUnit} />}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {t.importance.length > 0 && (
        <>
          <div className="ta-section">What drives this model (last 12 months of the window)</div>
          <div className="ta-imp">
            {t.importance.map((g) => (
              <div key={g.group} className="ta-imp-row">
                <span>{g.group}</span>
                <div className="ta-imp-bar"><i style={{ width: `${g.weight}%` }} /></div>
                <b>{g.weight.toFixed(0)}%</b>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
