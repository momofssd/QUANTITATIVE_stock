/** Low–high track with a marker at the current price. */
import { isNum, price } from "../../lib/format";

export function RangeBar({ label, low, high, value }: { label: string; low: number | null; high: number | null; value: number | null }) {
  const ok = isNum(low) && isNum(high) && isNum(value) && high > low;
  const pos = ok ? Math.max(0, Math.min(1, (value - low) / (high - low))) : 0;
  return (
    <div className="range-bar">
      <label>{label}</label>
      <div className="track">
        {ok && <i style={{ left: `calc(${(pos * 100).toFixed(1)}% - 1px)` }} />}
      </div>
      <span className="lo">{price(low)}</span>
      <span className="hi">{price(high)}</span>
    </div>
  );
}
