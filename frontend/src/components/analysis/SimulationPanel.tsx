/**
 * Simulation over the most recent decisions (computed by the server, quant/portfolio.py):
 * every BUY buys a lot - $100 worth or 1 share (switch, default $100) - also while already holding; the next SELL
 * decision sells everything held (variant "with_bracket": each lot is also sold at its own profit-take / stop-loss
 * if that comes first). Win rate and P&L are per lot, split by the setup of the BUY (rebound / trend).
 */
import { SETUP_LABEL } from "../../chart/markers";
import { price } from "../../lib/format";
import type { SetupName, SimBook, SimRun, SimSizing, SimTally, SimTrade, Simulation } from "../../types/api";
import { dirCls, pct, span, usd } from "./util";

export type SimVariant = "sell_only" | "with_bracket";

export const SIM_LABEL: Record<SimVariant, string> = {
  sell_only: "Sell everything at the next SELL decision",
  with_bracket: "… or each lot earlier at its profit-take / stop-loss",
};

export const SIZING_LABEL: Record<SimSizing, string> = { usd: "$100 per BUY", share: "1 share per BUY" };

export const EXIT_BY: Record<SimTrade["reason"], string> = {
  sell: "SELL decision", target: "Profit-take", stop: "Stop-loss", open: "Still holding",
};

const setupName = (s: SetupName) => (s ? SETUP_LABEL[s as Exclude<SetupName, "">] : "—");
const dollars = (v: number) => `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const money = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Summary({ run, book }: { run: SimRun; book: SimBook }) {
  const s = run.summary;
  return (
    <div className="ta-stats sim-stats">
      <div title={`One lot per BUY; at most ${s.max_lots} lots held at the same time`}>
        <label>Lots bought</label><b>{s.lots}</b> <small>max {s.max_lots} at once</small>
      </div>
      <div title={`${s.wins} sold at a profit, ${s.losses} at a loss`}>
        <label>Win rate (sold lots)</label>
        <b className={s.win_rate !== null && s.win_rate >= 0.5 ? "up" : ""}>{pct(s.win_rate)}</b> <small>{s.wins}/{s.closed}</small>
      </div>
      <div><label>Realized P&amp;L</label><b className={dirCls(s.realized_pnl)}>{usd(s.realized_pnl)}</b></div>
      <div title="Lots still held, valued at the last close">
        <label>Still held</label>
        <b className={dirCls(s.open_pnl)}>{s.open ? usd(s.open_pnl) : "none"}</b> {s.open > 0 && <small>{s.open} lot{s.open === 1 ? "" : "s"}</small>}
      </div>
      <div title={`Return on the most money at work at the same time (${dollars(s.max_capital)})`}>
        <label>Total P&amp;L</label>
        <b className={dirCls(s.total_pnl)}>{usd(s.total_pnl)}</b>{" "}
        {s.return_pct !== null && <small className={dirCls(s.return_pct)}>{s.return_pct > 0 ? "+" : ""}{s.return_pct.toFixed(1)}%</small>}
      </div>
      <div title="The same BUYs, never sold (valued at the last close)">
        <label>Same BUYs, never sold</label><b className={dirCls(book.hold_all.pnl)}>{usd(book.hold_all.pnl)}</b>
      </div>
    </div>
  );
}

function SetupRow({ name, t, all }: { name: string; t: SimTally; all?: boolean }) {
  return (
    <tr className={all ? "sim-all" : ""}>
      <td className="l">{all ? <b>{name}</b> : name}</td>
      <td>{t.lots}</td>
      <td>{t.closed}</td>
      <td className={t.win_rate !== null && t.win_rate >= 0.5 ? "up" : ""}><b>{pct(t.win_rate)}</b>{t.closed > 0 && <small> {t.wins}/{t.closed}</small>}</td>
      <td className={dirCls(t.realized_pnl)}>{usd(t.realized_pnl)}</td>
      <td className={dirCls(t.open_pnl)}>{t.open ? usd(t.open_pnl) : "—"}</td>
      <td className={dirCls(t.total_pnl)}><b>{usd(t.total_pnl)}</b></td>
      <td className={dirCls(t.avg_pnl)}>{usd(t.avg_pnl)}</td>
      <td className={dirCls(t.return_on_invested_pct)}>
        {t.return_on_invested_pct === null ? "—" : `${t.return_on_invested_pct > 0 ? "+" : ""}${t.return_on_invested_pct.toFixed(2)}%`}
      </td>
    </tr>
  );
}

function BySetup({ run }: { run: SimRun }) {
  return (
    <div className="table-scroll sim-setups">
      <table className="grid">
        <thead>
          <tr>
            <th className="l">BUY setup</th><th>Lots</th><th>Sold</th><th>Win rate</th><th>Realized P&amp;L</th>
            <th>Still held</th><th>Total P&amp;L</th><th>Avg / sold lot</th><th>Return / $ invested</th>
          </tr>
        </thead>
        <tbody>
          <SetupRow name="Rebound" t={run.by_setup.rebound} />
          <SetupRow name="Trend" t={run.by_setup.trend} />
          <SetupRow name="All BUYs" t={run.summary} all />
        </tbody>
      </table>
    </div>
  );
}

interface Props {
  sim: Simulation;
  variant: SimVariant;
  onVariant: (v: SimVariant) => void;
  sizing: SimSizing;
  onSizing: (s: SimSizing) => void;
  barUnit: string;
}

export function SimulationPanel({ sim, variant, onVariant, sizing, onSizing, barUnit }: Props) {
  const book = sim[sizing];
  const run = book[variant];
  const other: SimVariant = variant === "sell_only" ? "with_bracket" : "sell_only";
  const o = book[other].summary;
  const s = run.summary;
  const lot = sizing === "usd" ? "a $100 lot" : "1 share";
  return (
    <div className="ta-dec-table sim-panel">
      <div className="ta-dec-h">
        <b>{SIZING_LABEL[sizing]} · simulation</b>
        <span className="ta-dec-sub">
          {sim.start_date} → {sim.end_date} · the {sim.buys} most recent BUYs and the {sim.sells} SELLs after the first one ·
          every BUY buys {lot} (also while holding) · a SELL sells everything held · before costs
        </span>
      </div>
      <div className="sim-body">
        <div className="sim-switches">
          <div className="seg seg-sm" role="group" aria-label="Size of each purchase">
            {(Object.keys(SIZING_LABEL) as SimSizing[]).map((z) => (
              <button key={z} className={sizing === z ? "on" : ""} onClick={() => onSizing(z)}>{SIZING_LABEL[z]}</button>
            ))}
          </div>
          <div className="seg seg-sm" role="group" aria-label="When to sell">
            {(Object.keys(SIM_LABEL) as SimVariant[]).map((v) => (
              <button key={v} className={variant === v ? "on" : ""} onClick={() => onVariant(v)}>{SIM_LABEL[v]}</button>
            ))}
          </div>
        </div>
        <Summary run={run} book={book} />
        <div className="ta-section">Win rate and P&amp;L by BUY setup</div>
        <BySetup run={run} />
        <p className="ta-note">
          {money(s.invested)} invested in {s.lots} lots, at most {money(s.max_capital)} at work at the same time;{" "}
          {s.sells_used} SELL decision{s.sells_used === 1 ? "" : "s"} sold lots
          {s.avg_bars !== null && <>; sold lots were held {span(Math.round(s.avg_bars), barUnit)} on average</>}
          {s.best_pnl !== null && <> (best {usd(s.best_pnl)}, worst {usd(s.worst_pnl)})</>}.
          {" "}{variant === "sell_only" ? "With profit-take / stop-loss exits" : "Selling only at SELL decisions"}: total{" "}
          <b className={dirCls(o.total_pnl)}>{usd(o.total_pnl)}</b>, win rate {pct(o.win_rate)}.
          {" "}{sizing === "usd" ? "$100" : "1 share"} bought at the first BUY and held: {usd(book.buy_hold.pnl)}.
        </p>
      </div>
      {run.trades.length > 0 && (
        <div className="table-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th className="l">Bought</th><th className="l">Setup</th><th>Lot</th><th>at</th><th className="l">Sold</th><th>at</th>
                <th className="l">Exit by</th><th>Held</th><th>P&amp;L</th><th>Return</th>
              </tr>
            </thead>
            <tbody>
              {run.trades.map((t) => (
                <tr key={t.buy_time} className={t.status === "open" ? "sim-open" : ""}>
                  <td className="l">{t.buy_date}</td>
                  <td className="l">{setupName(t.setup)}</td>
                  <td title={`${t.qty} shares for ${money(t.cost)}`}>
                    {sizing === "usd" ? `${t.qty.toFixed(3)} sh` : `1 sh · ${money(t.cost)}`}
                  </td>
                  <td>{price(t.buy_price)}</td>
                  <td className="l">{t.status === "open" ? <i>last close {t.sell_date}</i> : t.sell_date}</td>
                  <td>{price(t.sell_price)}</td>
                  <td className="l">{EXIT_BY[t.reason]}</td>
                  <td>{span(t.bars, barUnit)}</td>
                  <td className={dirCls(t.pnl)}><b>{usd(t.pnl)}</b></td>
                  <td className={dirCls(t.pnl_pct)}>{t.pnl_pct > 0 ? "+" : ""}{t.pnl_pct.toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
