/**
 * What supported one BUY / SELL decision (shown when its row in a decision table is expanded):
 * the model's probability vs its threshold, the setup conditions on that bar, how much each factor group moved
 * the probability (real values vs typical values), and key indicator values.
 */
import { SETUP_LABEL } from "../../chart/markers";
import { price } from "../../lib/format";
import type { EntrySignal, SetupExplain } from "../../types/api";
import { pct } from "./util";

const SETUP_TITLE: Record<string, string> = {
  rebound: "Rebound (falling momentum easing)",
  trend: "Trend (clear bullish trend)",
  top: "Interim top (bullish momentum easing)",
};

function Checks({ name, s, fired }: { name: string; s: SetupExplain; fired: boolean }) {
  return (
    <div className={`why-setup ${s.active ? "on" : ""} ${fired ? "fired" : ""}`}>
      <div className="why-setup-h">
        <b>{SETUP_TITLE[name] ?? name}</b> {s.active ? "✓ in setup" : "not in setup"}
        {fired && <span className="why-tag">this decision</span>}
      </div>
      <ul>{s.checks.map((c) => <li key={c.label} className={c.ok ? "ok" : ""}>{c.ok ? "✓" : "✗"} {c.label}</li>)}</ul>
    </div>
  );
}

/** Changes / distances get a sign ("+1.2%", "-0.4 ATR"); levels do not ("4.03%", "16.6"). */
const fmt = (v: { value: number; unit: string; digits: number; signed: boolean }) =>
  `${v.signed && v.value > 0 ? "+" : ""}${v.value.toFixed(v.digits)}${v.unit === "ATR" ? " ATR" : v.unit}`;

export function DecisionWhy({ e, isBuy, accum = false, barWord }: {
  e: EntrySignal; isBuy: boolean; accum?: boolean; barWord: string;
}) {
  const w = e.why;
  if (!w) return <p className="ta-note">No details for this decision.</p>;
  const maxAbs = Math.max(1, ...w.factors.map((f) => Math.abs(f.delta)));
  const edge = e.prob - e.threshold;
  return (
    <div className="why">
      <div className="why-col">
        <h4>Decision</h4>
        <p className="why-p">
          Model {accum ? "P(profit at the next SELL)" : isBuy ? "P(profit-take first)" : "P(pullback first)"}{" "}
          <b>{pct(e.prob)}</b> vs threshold{" "}
          <b>{pct(e.threshold)}</b> ({edge >= 0 ? "+" : ""}{(edge * 100).toFixed(0)} pts) · training base rate{" "}
          {pct(w.base_rate)}.
          {e.setup && <> Setup: <b>{SETUP_LABEL[e.setup as Exclude<typeof e.setup, "">]}</b>.</>}
        </p>
        {isBuy && !accum && (
          <p className="why-p">
            Entry {price(e.entry)} · profit-take <b className="up">{price(e.target)}</b> ({e.target_basis}) · stop-loss{" "}
            <b className="down">{price(e.stop)}</b> ({e.stop_basis}).
          </p>
        )}
        <h4>Setup conditions on that {barWord}</h4>
        {Object.entries(w.setups).map(([k, s]) => s && <Checks key={k} name={k} s={s} fired={k === e.setup} />)}
      </div>

      <div className="why-col">
        <h4>What moved the model</h4>
        <p className="ta-note why-sub">
          Points of P from each factor group's values on that {barWord}, compared with typical values. Green pushed
          towards the {isBuy ? "BUY" : "SELL"}, red against it.
        </p>
        <div className="why-factors">
          {w.factors.map((f) => (
            <div key={f.group} className="why-f">
              <span className="why-f-name">{f.group}</span>
              <div className="why-f-bar">
                <i className={f.delta >= 0 ? "pos" : "neg"} style={{ width: `${(Math.abs(f.delta) / maxAbs) * 50}%` }} />
              </div>
              <b className={f.delta > 0 ? "up" : f.delta < 0 ? "down" : ""}>{f.delta > 0 ? "+" : ""}{f.delta.toFixed(1)}</b>
            </div>
          ))}
        </div>
      </div>

      <div className="why-col">
        <h4>Key values on that {barWord}</h4>
        <table className="why-values">
          <tbody>
            {w.values.map((v) => (
              <tr key={v.label}><th>{v.label}</th><td>{fmt(v)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
