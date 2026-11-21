/** Open, previous close, day / 52-week ranges, volumes, VWAP. */
import { isNum, price, volume } from "../../lib/format";
import type { Quote } from "../../types/api";
import { RangeBar } from "./RangeBar";

export function KeyStatistics({ quote: q }: { quote: Quote | null }) {
  const rows: [string, string][] = [
    ["Open", price(q?.open)],
    ["Previous Close", price(q?.prev_close)],
    ["Day's Range", q && isNum(q.low) ? `${price(q.low)} – ${price(q.high)}` : "—"],
    ["52-Week Range", q && isNum(q.week52_low) ? `${price(q.week52_low)} – ${price(q.week52_high)}` : "—"],
    ["Volume", volume(q?.volume)],
    ["Avg Volume (10-day)", volume(q?.avg_volume_10d)],
    ["Avg Volume (3-month)", volume(q?.avg_volume_3m)],
    ["Day VWAP", price(q?.day_vwap)],
  ];
  return (
    <section className="card">
      <div className="card-title"><h2>Key Statistics</h2></div>
      <table className="kv">
        <tbody>{rows.map(([k, v]) => <tr key={k}><th>{k}</th><td>{v}</td></tr>)}</tbody>
      </table>
      <RangeBar label="Day" low={q?.low ?? null} high={q?.high ?? null} value={q?.price ?? null} />
      <RangeBar label="52-wk" low={q?.week52_low ?? null} high={q?.week52_high ?? null} value={q?.price ?? null} />
    </section>
  );
}
