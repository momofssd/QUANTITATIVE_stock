/** OHLC + indicator values for the hovered (or latest) bar. */
import type { LegendModel } from "../../chart/legend";
import { compact, dirClass, pct, price, signed } from "../../lib/format";

function KV({ k, v, color }: { k: string; v: string; color?: string }) {
  return <span><span className="k" style={color ? { color } : undefined}>{k}</span> {v}</span>;
}

export function ChartLegend({ model }: { model: LegendModel | null }) {
  if (!model) return <div className="legend" />;
  return (
    <div className="legend">
      <div className="l1">
        <b>{model.symbol}</b>
        <span className="k">{model.time}</span>
        <KV k="O" v={price(model.open)} />
        <KV k="H" v={price(model.high)} />
        <KV k="L" v={price(model.low)} />
        <KV k="C" v={price(model.close)} />
        <span className={dirClass(model.change)}>{signed(model.change)} ({pct(model.changePct)})</span>
        <KV k="Vol" v={compact(model.volume)} />
      </div>
      {model.items.length > 0 && (
        <div className="l2">
          {model.items.map((it) => <KV key={it.label} k={it.label} v={it.value} color={it.color} />)}
        </div>
      )}
    </div>
  );
}
