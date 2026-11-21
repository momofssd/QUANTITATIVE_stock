/** Correlation / beta of the stock with SPY, QQQ, VIX, oil, gasoline and the T-bill rate (Yahoo Finance). */
import type { FactorRelation } from "../../types/api";

function Corr({ v }: { v: number | null }) {
  if (v === null) return <td>—</td>;
  const strength = Math.abs(v) >= 0.6 ? "strong" : Math.abs(v) >= 0.3 ? "moderate" : "weak";
  return <td className={`corr ${v > 0 ? "pos" : "neg"} ${strength}`}>{v > 0 ? "+" : ""}{v.toFixed(2)}</td>;
}

export function FactorRelations({ relations, years }: { relations: FactorRelation[]; years: number }) {
  return (
    <div className="ta-card ta-rel">
      <div className="ta-head">
        <h3>Relation to market &amp; macro factors</h3>
        <div className="ta-rule">Daily changes · source: Yahoo Finance</div>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th className="l">Factor</th>
            <th title={`Correlation of daily stock returns with daily factor changes over ${years} years`}>Corr {years}y</th>
            <th title="Same, last 60 trading days (current regime)">Corr 60d</th>
            <th title="Stock move per 1% move in the factor (market ETFs only)">Beta</th>
            <th title="Correlation of the factor's 5-day change with the stock's NEXT 5-day return">Lead 5d</th>
          </tr>
        </thead>
        <tbody>
          {relations.map((r) => (
            <tr key={r.factor}>
              <td className="l"><b>{r.ticker}</b> <small>{r.description}</small></td>
              <Corr v={r.corr_window} /><Corr v={r.corr_60d} />
              <td>{r.beta === null ? "—" : r.beta.toFixed(2)}</td>
              <Corr v={r.lead_corr} />
            </tr>
          ))}
        </tbody>
      </table>
      <p className="ta-note">
        Corr = how closely daily moves line up (−1 to +1). Lead 5d hints whether a factor's recent move tended to
        precede the stock's next week; values near 0 mean no usable lead.
      </p>
    </div>
  );
}
