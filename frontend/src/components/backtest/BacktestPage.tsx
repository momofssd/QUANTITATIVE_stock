/**
 * Backtests page: scenarios on the CURRENT training (the last "Find entry points" run, see useAnalysis).
 *   settings   most recent N BUY decisions (1-100, default 30) · strategy rebound / trend / both ·
 *              buy when the model's P >= threshold (default 60%) · $100 or 1 share per BUY · sell rule
 *   results    Overall · YTD · per transaction · by setup · rebound vs trend vs both · trades
 * The server picks the decisions from that training's out-of-sample probabilities and simulates them
 * (quant/backtest.py + quant/portfolio.py); nothing is retrained here.
 */
import { useEffect, useState } from "react";
import { MARK, SETUP_LABEL } from "../../chart/markers";
import { TF_LABEL } from "../../config/timeframes";
import type { AnalysisApi } from "../../hooks/useAnalysis";
import { N_RANGE, useBacktest, validN, validProb, type SellRule } from "../../hooks/useBacktest";
import { price } from "../../lib/format";
import type { ApiError } from "../../services/api";
import type {
  BacktestResult, BacktestScenario, BacktestSetups, BacktestVariant, SetupName, SimRun, SimSizing,
} from "../../types/api";
import { Elapsed } from "../analysis/AnalysisPanel";
import { BySetup, EXIT_BY, SIM_LABEL, SIM_RULE, SIZING_LABEL } from "../analysis/SimulationPanel";
import { TrainingDates } from "../analysis/TrainingDates";
import { dirCls, pct, span, usd } from "../analysis/util";

const STRATEGY: Record<BacktestSetups, string> = { rebound: "Rebound", trend: "Trend", both: "Both" };
/** Shares on hand: whole shares with "1 share per BUY", fractional with "$100 per BUY". */
const shares = (v: number, sizing: SimSizing) =>
  sizing === "share" ? v.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : v.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const money = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signedPct = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`;
const rangeLabel = (rng: string) => (rng === "CUSTOM" ? "custom range" : `${rng} range`);

interface Props {
  a: AnalysisApi;
  chart: { symbol: string; range: string; timeframe: string };
  stale: boolean;           // the chart now shows another range / interval than the training
  onTrain: () => void;      // train on the chart as it is shown now
  onError: (e: ApiError) => void;
}

/* ------------------------------------------------------------------ settings */

const pctRange = (r: [number, number] | null | undefined) =>
  !r ? "" : Math.round(r[0] * 100) === Math.round(r[1] * 100) ? `${Math.round(r[0] * 100)}%`
    : `${Math.round(r[0] * 100)}–${Math.round(r[1] * 100)}%`;

/** "Model" (the model's own threshold, default) or a custom % (prefilled with today's model threshold). */
function ThresholdField({ label, value, today, range, onChange }: {
  label: string; value: number | null; today: number | null; range: [number, number] | null | undefined;
  onChange: (v: number | null) => void;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => setText(value === null ? "" : String(value)), [value]);
  const ok = text.trim() !== "" && validProb(Number(text));
  return (
    <div className="bt-field">
      <span>{label}</span>
      <div className="bt-thr">
        <div className="seg seg-sm" role="group" aria-label={label}>
          <button className={value === null ? "on" : ""} onClick={() => onChange(null)}
            title="The model's own threshold: its training base rate + 10 points, recomputed at every retrain">Model</button>
          <button className={value !== null ? "on" : ""}
            onClick={() => value === null && onChange(today !== null ? Math.round(today * 100) : 50)}>Custom</button>
        </div>
        {value !== null && (
          <><input type="number" min={0} max={100} step={1} value={text} className={ok ? "" : "bad"}
            onChange={(e) => { setText(e.target.value); const v = Number(e.target.value);
              if (e.target.value.trim() !== "" && validProb(v)) onChange(v); }} /> %</>
        )}
      </div>
      <small>{value === null ? `model: ${pctRange(range) || "—"} (base rate + 10 pts)` : "your threshold"}</small>
    </div>
  );
}

function Controls({ bt, today, ranges, available }: {
  bt: ReturnType<typeof useBacktest>;
  today: { buy: number | null; sell: number | null };
  ranges: { buy: [number, number] | null; sell: [number, number] | null } | undefined;
  available: number | null;   // decisions that qualify under the current strategy / setup / threshold
}) {
  const s = bt.settings;
  // The field shows the number actually used: the setting (default 30) or all available, whichever is lower.
  const want = s.nCustom ?? N_RANGE[1];
  const used = available !== null ? Math.min(want, available) : want;
  const [editing, setEditing] = useState(false);
  const [nText, setNText] = useState(String(used));
  useEffect(() => { if (!editing) setNText(String(used)); }, [used, editing]);
  const nOk = validN(Number(nText));
  return (
    <div className="bt-controls">
      <label className="bt-field">
        <span>Decisions</span>
        <input type="number" min={N_RANGE[0]} max={N_RANGE[1]} step={1} value={nText} className={nOk ? "" : "bad"}
          onFocus={() => setEditing(true)} onBlur={() => setEditing(false)}
          onChange={(e) => { setNText(e.target.value); const v = Number(e.target.value); if (validN(v)) bt.setSettings({ nCustom: v }); }} />
        <small>
          {s.nCustom === null ? "all available (max 100)"
            : <>{available !== null && available < s.nCustom ? `all ${available} available` : "most recent"} ·{" "}
              <button type="button" className="link" onClick={() => bt.setSettings({ nCustom: null })}>All</button></>}
        </small>
      </label>
      <div className="bt-field">
        <span>Strategy</span>
        <div className="seg seg-sm" role="group" aria-label="Strategy">
          {(Object.keys(STRATEGY) as BacktestSetups[]).map((k) => (
            <button key={k} className={s.setups === k ? "on" : ""} onClick={() => bt.setSettings({ setups: k })}>{STRATEGY[k]}</button>
          ))}
        </div>
      </div>
      <ThresholdField label="Buy when P ≥" value={s.minProb} today={today.buy} range={ranges?.buy}
        onChange={(v) => bt.setSettings({ minProb: v })} />
      <ThresholdField label="Sell when P ≥" value={s.sellMinProb} today={today.sell} range={ranges?.sell}
        onChange={(v) => bt.setSettings({ sellMinProb: v })} />
      <div className="bt-field">
        <span>Each BUY</span>
        <div className="seg seg-sm" role="group" aria-label="Size of each purchase">
          {(Object.keys(SIZING_LABEL) as SimSizing[]).map((z) => (
            <button key={z} className={s.sizing === z ? "on" : ""} onClick={() => bt.setSettings({ sizing: z })}>{SIZING_LABEL[z]}</button>
          ))}
        </div>
      </div>
      <div className="bt-field">
        <span>Sell</span>
        <div className="seg seg-sm" role="group" aria-label="When to sell">
          {(Object.keys(SIM_LABEL) as SellRule[]).map((v) => (
            <button key={v} className={s.sell === v ? "on" : ""} onClick={() => bt.setSettings({ sell: v })}>{SIM_LABEL[v]}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ results */

function Stat({ label, value, cls, sub }: { label: string; value: string; cls?: string; sub?: string }) {
  return <div className="bt-stat"><label>{label}</label><b className={cls}>{value}</b>{sub && <small>{sub}</small>}</div>;
}

function Blocks({ sc, run, sizing, barUnit }: { sc: BacktestScenario; run: SimRun; sizing: SimSizing; barUnit: string }) {
  const s = run.summary;
  const y = s.ytd;
  const lot = sizing === "usd" ? "$100" : "1 share";
  return (
    <div className="bt-blocks">
      <div className="bt-block">
        <h3>Overall <small>{sc.start_date} → {sc.end_date}</small></h3>
        <div className="bt-big">
          <b className={dirCls(s.total_pnl)}>{usd(s.total_pnl)}</b>
          <span className={dirCls(s.return_on_invested_pct)}>{signedPct(s.return_on_invested_pct)} on {money(s.invested)} invested</span>
        </div>
        <div className="bt-stats">
          <Stat label="Win rate" value={pct(s.win_rate)} cls={s.win_rate !== null && s.win_rate >= 0.5 ? "up" : ""} sub={`${s.wins} won / ${s.losses} lost`} />
          <Stat label="Lots" value={String(s.lots)} sub={`${s.closed} sold · ${s.open} still held`} />
          <Stat label="Realized" value={usd(s.realized_pnl)} cls={dirCls(s.realized_pnl)} />
          <Stat label="Still held" value={s.open ? usd(s.open_pnl) : "none"} cls={dirCls(s.open_pnl)} sub="at the last close" />
          <Stat label="Max at work" value={money(s.max_capital)} sub={`${s.max_lots} lots at once · ${signedPct(s.return_pct, 1)} on it`} />
          <Stat label="Same BUYs, never sold" value={`${usd(sc.hold_all.pnl)} (${signedPct(sc.hold_all.pnl_pct, 1)})`}
            cls={dirCls(sc.hold_all.pnl)}
            sub={`${shares(sc.hold_all.shares, sizing)} shares on hand · cost ${money(sc.hold_all.cost)} · worth ${money(sc.hold_all.value)}`} />
          <Stat label="Buy & hold from the first BUY" value={usd(sc.buy_hold.pnl)} cls={dirCls(sc.buy_hold.pnl)}
            sub={`${lot} bought ${sc.start_date}, never sold`} />
        </div>
      </div>
      <div className="bt-block">
        <h3>YTD <small>since {y?.since ?? "—"}</small></h3>
        {y ? (
          <>
            <div className="bt-big">
              <b className={dirCls(y.pnl)}>{usd(y.pnl)}</b>
              <span className={dirCls(y.return_pct)}>{signedPct(y.return_pct)} on the money at work this year</span>
            </div>
            <div className="bt-stats">
              <Stat label="Win rate" value={pct(y.win_rate)} cls={y.win_rate !== null && y.win_rate >= 0.5 ? "up" : ""} sub={`${y.wins} of ${y.lots_sold} sold this year`} />
              <Stat label="Lots held this year" value={String(y.lots_held)} sub={`${y.lots_sold} sold this year`} />
              <Stat label="Avg / sold lot" value={signedPct(y.avg_return_pct)} cls={dirCls(y.avg_return_pct)} />
            </div>
            <p className="ta-note">Lots held over the year end count from the last close of the previous year.</p>
          </>
        ) : <p className="ta-note">No YTD figures.</p>}
      </div>
      <div className="bt-block">
        <h3>Per transaction <small>sold lots</small></h3>
        <div className="bt-big">
          <b className={dirCls(s.avg_return_pct)}>{signedPct(s.avg_return_pct)}</b>
          <span>average return per trade{s.avg_pnl !== null && <> ({usd(s.avg_pnl)})</>}</span>
        </div>
        <div className="bt-stats">
          <Stat label="Avg gain (winners)" value={signedPct(s.avg_win_pct)} cls="up" sub={s.avg_win_pnl !== null ? usd(s.avg_win_pnl) : undefined} />
          <Stat label="Avg loss (losers)" value={signedPct(s.avg_loss_pct)} cls="down" sub={s.avg_loss_pnl !== null ? usd(s.avg_loss_pnl) : undefined} />
          <Stat label="Best / worst" value={`${usd(s.best_pnl)} / ${usd(s.worst_pnl)}`} />
          <Stat label="Avg held" value={s.avg_bars !== null ? span(Math.round(s.avg_bars), barUnit) : "—"} />
        </div>
      </div>
    </div>
  );
}

function Compare({ r, v, onPick }: { r: BacktestResult; v: BacktestVariant; onPick: (k: BacktestSetups) => void }) {
  return (
    <div className="table-scroll">
      <table className="grid bt-compare">
        <thead>
          <tr>
            <th className="l">Strategy</th><th>Decisions</th><th>Win rate</th><th>Total P&amp;L</th><th>Return / $ invested</th>
            <th>Avg / trade</th><th>YTD P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          {v.compare.map((c) => {
            const s = c.summary;
            const active = c.setups === r.params.setups;
            return (
              <tr key={c.setups} className={`${active ? "active" : ""} clickable`} onClick={() => onPick(c.setups)}
                title="Show this strategy">
                <td className="l">{active ? <b>{STRATEGY[c.setups]}</b> : STRATEGY[c.setups]}
                  <small> · {v.pool[c.setups].qualified} qualify</small></td>
                <td>{c.decisions}</td>
                <td>{s ? pct(s.win_rate) : "—"}</td>
                <td className={dirCls(s?.total_pnl)}>{s ? <b>{usd(s.total_pnl)}</b> : "—"}</td>
                <td className={dirCls(s?.return_on_invested_pct)}>{s ? signedPct(s.return_on_invested_pct) : "—"}</td>
                <td className={dirCls(s?.avg_return_pct)}>{s ? signedPct(s.avg_return_pct) : "—"}</td>
                <td className={dirCls(s?.ytd?.pnl)}>{s?.ytd ? usd(s.ytd.pnl) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Trades({ run, barUnit, sizing }: { run: SimRun; barUnit: string; sizing: SimSizing }) {
  return (
    <div className="table-scroll">
      <table className="grid">
        <thead>
          <tr>
            <th className="l">Bought</th><th className="l">Setup</th><th>P</th><th>Lot</th><th>at</th><th className="l">Sold</th>
            <th>at</th><th className="l">Exit by</th><th>Held</th><th>P&amp;L</th><th>Return</th>
          </tr>
        </thead>
        <tbody>
          {run.trades.map((t) => (
            <tr key={t.buy_time} className={t.status === "open" ? "sim-open" : ""}>
              <td className="l">{t.buy_date}</td>
              <td className="l">{t.setup ? SETUP_LABEL[t.setup as Exclude<SetupName, "">] : "—"}</td>
              <td>{pct(t.prob)}</td>
              <td title={`${t.qty} shares for ${money(t.cost)}`}>{sizing === "usd" ? `${t.qty.toFixed(3)} sh` : `1 sh · ${money(t.cost)}`}</td>
              <td>{price(t.buy_price)}</td>
              <td className="l">{t.status === "open" ? <i>last close {t.sell_date}</i> : t.sell_date}</td>
              <td>{price(t.sell_price)}</td>
              <td className="l">{EXIT_BY[t.reason]}</td>
              <td>{span(t.bars, barUnit)}</td>
              <td className={dirCls(t.pnl)}><b>{usd(t.pnl)}</b></td>
              <td className={dirCls(t.pnl_pct)}>{signedPct(t.pnl_pct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

export function BacktestPage({ a, chart, stale, onTrain, onError }: Props) {
  const r = a.result;
  const bt = useBacktest(r?.run_id ?? null, onError);
  const res = bt.result;
  const sell = bt.settings.sell;
  // the strategy shown: sell-signal (its own BUY model) or profit-take / stop-loss
  const v = res?.variants[sell] ?? null;
  const sc = v?.result ?? null;
  const buyKey = sell === "sell_only" ? "accum" : "short";
  const tfLabel = (TF_LABEL as Record<string, string>)[chart.timeframe] ?? chart.timeframe;
  const chartText = `${chart.symbol} · ${rangeLabel(chart.range)} · ${tfLabel} bars`;
  return (
    <section className="card bt-page">
      <div className="card-title">
        <h2>Backtests <small>scenarios on the current training · research output, not advice</small></h2>
        <div className="ct-right">
          {r && <button className="btn btn-ghost" onClick={onTrain} disabled={a.loading}>Retrain on the current chart</button>}
        </div>
      </div>

      {a.loading && (
        <div className="ta-loading">
          <div className="spinner" />
          Training on {chartText}… {a.startedAt && <Elapsed since={a.startedAt} />}
          <small>Usually 5–30 seconds depending on the interval.</small>
        </div>
      )}

      {!r && !a.loading && (
        <div className="bt-empty">
          <p>No training yet. Backtests run on the BUY / SELL models trained by <b>Find entry points</b>.</p>
          <button className="btn btn-primary" onClick={onTrain}>Train now on {chartText}</button>
          <p className="ta-note">Or open <a href="#/">Quote &amp; Chart</a>, set the range and interval, and press Find entry points.</p>
        </div>
      )}

      {r && !a.loading && (
        <div className="bt-body">
          <div className="bt-training">
            Based on the current training: <b>{r.symbol} · {rangeLabel(r.range)} · {TF_LABEL[r.timeframe]} bars</b>
            {r.extended ? " (extended hours)" : ""} · trained {r.training?.trained_at} · decisions from the model-check window{" "}
            <b>{r.window.start} → {r.window.end}</b> ({r.window.bars.toLocaleString()} bars)
            {stale && <span className="bt-stale"> · the chart now shows {chartText}</span>}
          </div>
          <details className="bt-dates">
            <summary>Training dates for this run</summary>
            <TrainingDates r={r} />
          </details>

          <Controls bt={bt} ranges={res && v ? { buy: v.model_thresholds, sell: res.sell_model_thresholds } : undefined}
            available={v && res ? v.pool[res.params.setups].qualified : null}
            today={{ buy: r.targets[buyKey].current?.threshold ?? null, sell: r.targets.tp_short.current?.threshold ?? null }} />
          <p className="bt-strategy">
            <b>{SIM_LABEL[sell]}:</b> {SIM_RULE[sell]}.
          </p>

          {bt.error && (
            <div className="ta-stale">{bt.error} <button className="link" onClick={onTrain}>Retrain</button></div>
          )}

          {res && v && (
            <p className="bt-pool">
              <b>{v.pool[res.params.setups].qualified}</b> {MARK[buyKey].text} decisions qualify ({STRATEGY[res.params.setups].toLowerCase()}
              {res.params.setups === "both" ? " setups" : " setup"}, P ≥{" "}
              {res.params.min_prob === null ? `the model's threshold (${pctRange(v.model_thresholds)})`
                : `${Math.round(res.params.min_prob * 100)}%`}, one per {res.cooldown} bars) in {res.window.start} →{" "}
              {res.window.end}
              {sc ? <>; the most recent <b>{sc.decisions}</b> are simulated.</> : "."}
              {" "}SELL decisions: <b>{res.sell_decisions}</b> (P ≥{" "}
              {res.params.sell_min_prob === null ? `the model's threshold (${pctRange(res.sell_model_thresholds)})`
                : `${Math.round(res.params.sell_min_prob * 100)}%`}).
              {" "}Highest P: {pct(v.pool[res.params.setups].max_prob)}.
              {bt.settings.nCustom !== null && v.pool[res.params.setups].qualified < bt.settings.nCustom && (
                <> All available decisions are used. For more: lower the threshold, pick both setups, or train on a longer
                  range (MAX).</>
              )}
            </p>
          )}

          {bt.loading && !res && <div className="ta-loading"><div className="spinner" />Running the backtest…</div>}

          {res && !sc && <p className="bt-none">No BUY decisions match these settings.</p>}

          {res && v && sc && (
            <div className={bt.loading ? "bt-results busy" : "bt-results"}>
              <Blocks sc={sc} run={sc} sizing={res.params.sizing} barUnit={res.bar_unit} />
              <div className="ta-section">Win rate and P&amp;L by BUY setup</div>
              <BySetup run={sc} />
              <div className="ta-section">Rebound vs trend vs both (same decisions count, threshold and lot size)</div>
              <Compare r={res} v={v} onPick={(k) => bt.setSettings({ setups: k })} />
              <div className="ta-section">Trades ({sc.trades.length} lots, newest first)</div>
              <Trades run={sc} barUnit={res.bar_unit} sizing={res.params.sizing} />
              <p className="ta-note">
                How it works: P is the out-of-sample probability the walk-forward model gave each bar (it never saw that
                bar's outcome). The sell-signal strategy buys on the sell-signal BUY model ("BUY S": trained on whether
                a lot is sold at a profit at the next SELL); the profit-take / stop-loss strategy on the BUY model
                trained on its profit-take / stop-loss. A BUY is any bar in the chosen setup with that model's P at or
                above the BUY threshold, at most one per {res.cooldown} bars; the most recent N are taken. A SELL is any interim-top bar with the SELL model's P
                at or above the SELL threshold. Both thresholds are the model's own by default (its training base rate +
                10 points, recomputed at every retrain - the same decisions as the analysis) unless you set a number.
                Every BUY buys {res.params.sizing === "usd" ? "$100" : "1 share"} at that close (also while holding); the
                next SELL decision sells everything held
                {sell === "with_bracket" && `; each lot is also sold earlier at its own profit-take / stop-loss, or after ${r.targets.short.spec.horizon} sessions`}. Lots still
                held are valued at the last close. Before commissions and slippage. Past results do not guarantee future results.
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
