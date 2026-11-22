/**
 * Shared labels and the by-setup table for the two simulated strategies (computed by the server,
 * quant/portfolio.py; shown on the Backtests page):
 *   sell-signal strategy        BUYs from the sell-signal BUY model ("BUY S"); every BUY adds a lot ($100 or 1 share,
 *                               also while holding); the next SELL decision sells everything held
 *   profit-take / stop-loss     BUYs from the profit-take / stop-loss BUY model; each lot is also sold at its own
 *                               profit-take / stop-loss / time limit if that comes before the next SELL
 * Win rate and P&L are per lot, split by the setup of the BUY (rebound / trend).
 */
import type { SimRun, SimSizing, SimTally, SimTrade } from "../../types/api";
import { dirCls, pct, usd } from "./util";

export type SimVariant = "sell_only" | "with_bracket";

export const SIM_LABEL: Record<SimVariant, string> = {
  sell_only: "Sell-signal strategy",
  with_bracket: "Profit-take / stop-loss strategy",
};

/** What each strategy does. */
export const SIM_RULE: Record<SimVariant, string> = {
  sell_only: "BUY S decisions (the sell-signal BUY model) · every BUY adds a lot · the next SELL sells everything",
  with_bracket: "BUY decisions (the profit-take / stop-loss BUY model) · each lot sold at its profit-take, stop-loss or "
    + "time limit, or at the next SELL if that comes first",
};

export const SIZING_LABEL: Record<SimSizing, string> = { usd: "$100 per BUY", share: "1 share per BUY" };

export const EXIT_BY: Record<SimTrade["reason"], string> = {
  sell: "SELL decision", target: "Profit-take", stop: "Stop-loss", "time limit": "Time limit", open: "Still holding",
};

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

export function BySetup({ run }: { run: SimRun }) {
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
