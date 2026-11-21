/**
 * "Optimized ATR" section of the BUY card (bracket mode "optimal", quant/optimize.py): the profit-take / stop-loss
 * combination in use now, the walk-forward optimized result vs fixed 1.5 / 1.0 and vs the best combination in
 * hindsight, every combination's backtested profit, and when the choice changed.
 */
import type { Optimization } from "../../types/api";
import { dirCls, pct } from "./util";

const sp = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);
const combo = (tp: number, sl: number) => `${tp} / ${sl}`;

export function OptimizationPanel({ o, barUnit, hold }: { o: Optimization; barUnit: string; hold: number }) {
  const cur = o.current;
  const def = o.grid.find((g) => g.tp === o.default.tp && g.sl === o.default.sl);
  const best = o.grid.reduce((a, g) => (g.trades > 0 && g.total_return_pct > a.total_return_pct ? g : a), o.grid[0]);
  const cell = (tp: number, sl: number) => o.grid.find((g) => g.tp === tp && g.sl === sl);
  const unit = barUnit === "trading days" ? "days" : barUnit;
  return (
    <div className="opt">
      <div className="ta-section">Optimized ATR · {o.combos} combinations retrained</div>
      <div className="opt-now">
        In use now: profit-take <b>{cur.tp} × ATR</b> · stop-loss <b>{cur.sl} × ATR</b>
        <small>
          {cur.fallback
            ? ` - default: no combination has ${o.min_trades} closed trades in the last ${o.lookback} ${unit} yet`
            : ` - best total return over the trades closed in the last ${o.lookback} ${unit} (${cur.trades} trades, ${sp(cur.score_pct)})`}
        </small>
      </div>

      <table className="grid opt-compare">
        <tbody>
          {o.strategy && (
            <tr>
              <td className="l"><b>Optimized, walk-forward</b><small>re-chosen every {o.step} bars from past trades only</small></td>
              <td>{o.strategy.trades} trades</td><td>win {pct(o.strategy.win_rate)}</td>
              <td className={dirCls(o.strategy.total_return_pct)}><b>{sp(o.strategy.total_return_pct)}</b></td>
            </tr>
          )}
          {def && (
            <tr className="muted-row">
              <td className="l">Fixed {combo(def.tp, def.sl)}<small>same retraining, never changed</small></td>
              <td>{def.trades} trades</td><td>win {pct(def.win_rate)}</td>
              <td className={dirCls(def.total_return_pct)}>{sp(def.total_return_pct)}</td>
            </tr>
          )}
          <tr className="muted-row">
            <td className="l">Best in hindsight: {combo(best.tp, best.sl)}<small>picked after the fact - optimistic</small></td>
            <td>{best.trades} trades</td><td>win {pct(best.win_rate)}</td>
            <td className={dirCls(best.total_return_pct)}>{sp(best.total_return_pct)}</td>
          </tr>
        </tbody>
      </table>

      <div className="table-scroll">
        <table className="grid opt-grid">
          <thead>
            <tr><th className="l">Profit-take ↓ · Stop-loss →</th>{o.sl_values.map((sl) => <th key={sl}>{sl} × ATR</th>)}</tr>
          </thead>
          <tbody>
            {o.tp_values.map((tp) => (
              <tr key={tp}>
                <td className="l">{tp} × ATR</td>
                {o.sl_values.map((sl) => {
                  const g = cell(tp, sl);
                  const isCur = tp === cur.tp && sl === cur.sl;
                  return (
                    <td key={sl} className={`${dirCls(g?.total_return_pct)} ${isCur ? "opt-cur" : ""}`}
                      title={g ? `${g.trades} trades · win ${pct(g.win_rate)} · avg ${sp(g.avg_return_pct)}` : ""}>
                      {g ? <><b>{sp(g.total_return_pct, 1)}</b><small>{g.trades} tr</small></> : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="ta-note">
        Total return of each combination's own BUY trades over the model-check window ($100 per trade; sold at the
        profit-take, the stop-loss, a SELL in profit or after {hold} sessions). Outlined: in use now. Each combination was retrained walk-forward on its own labels
        ({o.folds_per_combo} retrains each).
      </p>

      <details className="opt-hist">
        <summary>When the choice changed ({o.choices.length} re-optimizations)</summary>
        <table className="grid">
          <thead><tr><th className="l">From</th><th className="l">To</th><th>Used</th><th>Scored on</th></tr></thead>
          <tbody>
            {o.choices.slice().reverse().map((c) => (
              <tr key={c.start}>
                <td className="l">{c.start}</td><td className="l">{c.end}</td>
                <td><b>{combo(c.tp, c.sl)}</b>{c.fallback && <small> default</small>}</td>
                <td>{c.trades} trades, {sp(c.score_pct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
