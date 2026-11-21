/** Exchange and tradability flags from Alpaca's asset record. */
import { yesNo } from "../../lib/format";
import type { Quote } from "../../types/api";

export function SecurityDetails({ quote: q }: { quote: Quote | null }) {
  const rows: [string, string][] = [
    ["Exchange", q?.exchange || "—"],
    ["Tradable", yesNo(q?.tradable)],
    ["Shortable", yesNo(q?.shortable)],
    ["Easy to Borrow", yesNo(q?.easy_to_borrow)],
    ["Marginable", yesNo(q?.marginable)],
    ["Fractional", yesNo(q?.fractionable)],
  ];
  return (
    <section className="card">
      <div className="card-title"><h2>Security Details</h2></div>
      <table className="kv">
        <tbody>{rows.map(([k, v]) => <tr key={k}><th>{k}</th><td>{v}</td></tr>)}</tbody>
      </table>
    </section>
  );
}
