/**
 * One analysis target - BUY (short-term entry) or SELL (take profit):
 *   This chart range  decisions + outcomes for the bars on the chart (what the markers show), trade results (BUY)
 *   Model check       reliability verdict over the longer window (>= 1,260 bars), AUC, by setup, trade backtest
 * plus the profit-take / stop-loss editor (BUY), the open trade, the marker toggle and the drivers.
 * The 30 most recent decisions are listed below the cards (DecisionTable).
 */
import { useEffect, useState } from "react";
import { EXIT_LABEL, MARK, SETUP_LABEL } from "../../chart/markers";
import type { Bracket } from "../../hooks/useAnalysis";
import { price } from "../../lib/format";
import type { AnalysisResult, ExitReason, RangeStats, TargetResult, TradeSummary } from "../../types/api";
import { dirCls, left, pct, rule, signedPct } from "./util";

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
  rangeWindow: AnalysisResult["range_window"];
  window: AnalysisResult["window"];
  showMarkers: boolean;
  onToggle: (on: boolean) => void;
  bracket?: BracketEditor;      // BUY only
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

/** Signal entries vs entering on any bar, same exits. */
function TradeTable({ a, e }: { a: TradeSummary; e: TradeSummary }) {
  if (a.trades === 0 && e.trades === 0) return <p className="ta-note">No closed trades yet.</p>;
  return (
    <div className="table-scroll">
      <table className="grid ta-trades">
        <thead>
          <tr><th className="l" /><th>Trades</th><th>Win rate</th><th>Avg / trade</th><th>Profit factor</th><th>Avg bars held</th></tr>
        </thead>
        <tbody>
          <tr>
            <td className="l"><b>BUY entries</b></td><td>{a.trades}</td><td>{pct(a.win_rate)}</td>
            <td className={dirCls(a.avg_return_pct)}><b>{signedPct(a.avg_return_pct)}</b></td>
            <td>{a.profit_factor?.toFixed(2) ?? "—"}</td><td>{a.avg_days ?? "—"}</td>
          </tr>
          <tr className="muted-row">
            <td className="l" title="Same exit rules, entering at every bar's close">Any-bar entry</td><td>{e.trades}</td>
            <td>{pct(e.win_rate)}</td><td className={dirCls(e.avg_return_pct)}>{signedPct(e.avg_return_pct)}</td>
            <td>{e.profit_factor?.toFixed(2) ?? "—"}</td><td>{e.avg_days ?? "—"}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function ExitRule({ t, unit }: { t: TargetResult; unit: string }) {
  const r = t.trades?.rules;
  if (!r) return null;
  const window = r.horizon_mode === "sessions" ? `${r.horizon} trading sessions` : `${r.horizon} ${unit}`;
  return (
    <div className="ta-exit-rule">
      Each BUY is sold at the first of: profit-take (+{r.target_atr}× ATR) · stop-loss (−{r.stop_atr}× ATR)
      {r.trail_after_atr > 0 && <> · trailing stop {r.trail_atr} ATR below the highest close once up {r.trail_after_atr} ATR</>}
      {r.exit_with && <> · a SELL signal while the trade is in profit</>} · the close after {window}.
    </div>
  );
}

/** Decisions, hit rate, setup-only and any-bar rates for a block of bars. */
function StatsRow({ isBuy, signals, hitRate, baseRate, setupRate, auc }: {
  isBuy: boolean; signals: number; hitRate: number | null; baseRate: number | null; setupRate: number | null;
  auc?: number | null;
}) {
  return (
    <div className={`ta-stats ${auc === undefined ? "four" : ""}`}>
      <div><label>{isBuy ? "BUY" : "SELL"} decisions</label><b>{signals}</b></div>
      <div>
        <label>{isBuy ? "Justified" : "Hit rate"}</label>
        <b className={hitRate !== null && baseRate !== null && hitRate > baseRate ? "up" : ""}>{pct(hitRate)}</b>
      </div>
      <div title="Every bar in the setup, without the model"><label>Setup only</label><b>{pct(setupRate)}</b></div>
      <div title="Every bar"><label>Any bar</label><b>{pct(baseRate)}</b></div>
      {auc !== undefined && <div><label>AUC</label><b>{auc?.toFixed(2) ?? "—"}</b></div>}
    </div>
  );
}

function RangeBlock({ t, rs, rw, isBuy }: { t: TargetResult; rs: RangeStats; rw: Props["rangeWindow"]; isBuy: boolean }) {
  const tb = t.trades;
  const pending = rs.signals - rs.resolved;
  const what = isBuy ? "the profit-take was reached before the stop-loss" : "the pullback came before a rise";
  return (
    <>
      <div className="ta-section">This chart range · {rw.start} → {rw.end} · {rw.bars.toLocaleString()} bars</div>
      <StatsRow isBuy={isBuy} signals={rs.signals} hitRate={rs.hit_rate} baseRate={rs.base_rate} setupRate={rs.setup_rate} />
      <p className="ta-note">
        {rs.signals === 0
          ? <>No {isBuy ? "BUY" : "SELL"} decision inside this range (a decision needs the setup <b>and</b> the model;
              at most one per cooldown).</>
          : <>{isBuy ? "Justified" : "Hit rate"} = {what} within 5 trading sessions: {rs.hits} of {rs.resolved} decided
              {pending > 0 && <> · {pending} still open (needs 5 more sessions)</>}.</>}
        {" "}Setup only / Any bar: {rs.setup_bars.toLocaleString()} setup bars / {rs.decided_bars.toLocaleString()} bars
        with a known outcome{rs.decided_bars < rs.bars && <> (the last 5 sessions are not decided yet)</>}.
      </p>
      {isBuy && tb && (
        <>
          <TradeTable a={tb.range_signals} e={tb.range_every_day} />
          <p className="ta-note">Buy &amp; hold over this range: {signedPct(tb.range_buy_hold_pct, 1)}.</p>
        </>
      )}
    </>
  );
}

function ModelBlock({ t, w, isBuy, same }: { t: TargetResult; w: Props["window"]; isBuy: boolean; same: boolean }) {
  const s = t.stats;
  const tb = t.trades;
  const a = tb?.signals;
  const e = tb?.every_day;
  const reasons = a?.reasons ? (Object.entries(a.reasons) as [ExitReason, number][]).filter(([, n]) => n > 0) : [];
  const beat = a?.avg_return_pct !== undefined && e?.avg_return_pct !== undefined && a.avg_return_pct !== null
    && e.avg_return_pct !== null ? a.avg_return_pct > e.avg_return_pct : null;
  return (
    <>
      <div className="ta-section">
        Model check · {same ? "same bars as the chart range" : <>last {w.bars.toLocaleString()} bars · {w.start} → {w.end}</>}
      </div>
      <div className={`ta-verdict ${s.reliable ? "ok" : "warn"}`}>
        <b>{s.reliable ? "Edge found" : "No reliable edge"}</b> — {s.verdict.replace(/^(Edge found|No reliable edge): /, "")}
      </div>
      {!same && <StatsRow isBuy={isBuy} signals={s.signals} hitRate={s.hit_rate} baseRate={s.base_rate}
        setupRate={s.setup_rate} auc={s.auc} />}
      <p className="ta-note">
        {same && <>AUC <b>{s.auc?.toFixed(2) ?? "—"}</b>. </>}
        {!same && <>Judged on at least 1,260 bars so the verdict is not based on a handful of decisions
          ({s.hits} of {s.resolved} decided). </>}
        {Object.keys(s.by_setup).length > 0 && (
          <>By setup: {Object.entries(s.by_setup).map(([k, v]) => (
            <span key={k} className="ta-bysetup">{SETUP_LABEL[k as keyof typeof SETUP_LABEL] ?? k} {v.hits}/{v.resolved}{" "}
              ({pct(v.hit_rate)})</span>
          ))}</>
        )}
      </p>
      {isBuy && a && e && (
        <>
          {!same && <TradeTable a={a} e={e} />}
          {beat !== null && a.trades > 0 && (
            <div className={`ta-tradecheck ${beat ? "ok" : "warn"}`}>
              {beat
                ? "Trading the BUYs beat entering on any bar with the same exits."
                : "Trading the BUYs did NOT beat entering on any bar with the same exits - the timing added no profit here."}
            </div>
          )}
          {reasons.length > 0 && (
            <div className="ta-reasons">Exits: {reasons.map(([k, n]) => <span key={k}>{EXIT_LABEL[k]} <b>{n}</b></span>)}</div>
          )}
          <p className="ta-note">
            Per-trade returns before commissions and slippage.
            {!same && <> Buy &amp; hold over this window: {signedPct(tb!.buy_hold_pct, 1)}.</>}
          </p>
        </>
      )}
    </>
  );
}

export function TargetCard({ t, barUnit, rangeWindow, window, showMarkers, onToggle, bracket }: Props) {
  const { spec } = t;
  const isBuy = spec.kind === "entry";
  const ot = t.open_trade?.trade;
  const same = rangeWindow.bars >= window.bars;
  return (
    <div className="ta-card">
      <div className="ta-head">
        <h3>{spec.label} <span className={`mark-chip mark-${spec.key}`}>{MARK[spec.key].text}</span></h3>
        <div className="ta-rule">{rule(t, barUnit)}</div>
      </div>

      {bracket && <BracketForm b={bracket} />}
      {isBuy && <ExitRule t={t} unit={barUnit} />}

      {isBuy && ot?.status === "open" && t.open_trade && (
        <div className="ta-open">
          <b>Open trade</b> from {t.open_trade.date} at {price(t.open_trade.entry)}:{" "}
          <span className={dirCls(ot.return_pct)}>{signedPct(ot.return_pct, 1)}</span> · {ot.trailing ? "trailing stop" : "stop-loss"}{" "}
          {price(ot.stop)} · profit-take {price(ot.target)} · {left(ot, barUnit)} left
        </div>
      )}

      <RangeBlock t={t} rs={t.range_stats} rw={rangeWindow} isBuy={isBuy} />
      <ModelBlock t={t} w={window} isBuy={isBuy} same={same} />

      <label className="check ta-toggle">
        <input type="checkbox" checked={showMarkers} onChange={(e) => onToggle(e.target.checked)} />
        Show {MARK[spec.key].text} markers on the chart{!t.stats.reliable && " (no reliable edge here)"}
      </label>

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
