/**
 * The swings behind the points (quant/swings.py): today's adaptive swing size (in % and points), the interim lows /
 * highs of the chart's range, the typical rise from a low to the next high, and the latest turns with the day each
 * became known.
 */
import { price } from "../../lib/format";
import type { AnalysisResult } from "../../types/api";

const short = (d: string) => d.slice(5).replace("-", "/");   // "2026-11-05" -> "11/05" (keeps intraday times)

export function SwingBox({ r }: { r: AnalysisResult }) {
  const s = r.swing;
  if (s.size_pct === null) return null;
  const latest = s.turns.slice(-6).reverse();
  return (
    <div className="swing-box">
      <div className="swing-h">
        <b>Swings</b>
        <span>the yardstick of the points: gain to the next interim high, risk on the way</span>
      </div>
      <div className="swing-stats">
        <div>
          <label>Swing size now</label><b>{s.size_pct.toFixed(1)}%{s.size_pts !== null && <small> = {s.size_pts.toFixed(2)} pts</small>}</b>
          <small>median {s.size_median_pct?.toFixed(1) ?? "—"}% · adapts to {r.symbol}</small>
        </div>
        <div>
          <label>Interim lows / highs</label><b>{s.lows} / {s.highs}</b>
          <small>in this chart range{s.lows_per_year !== null ? ` · ~${s.lows_per_year.toFixed(0)} lows a year` : ""}</small>
        </div>
        <div>
          <label>Typical rise, low → high</label>
          <b className="up">{s.median_rise_pct !== null ? `+${s.median_rise_pct.toFixed(1)}%` : "—"}</b>
          <small>median in this range</small>
        </div>
      </div>
      <p className="ta-note">
        A swing is a reversal of at least {s.size_pct.toFixed(1)}% ({s.mult}× {r.symbol}'s median {s.span}-bar high-low range
        over the last {s.lookback} bars, so a volatile stock gets bigger swings). An interim low is the lowest point between
        two swing highs; it is only <i>confirmed</i> once price has risen a full swing from it (an interim high once it
        has fallen a swing). For every past bar the app measures, in points, the <b>gain</b> to the next interim high
        and the <b>risk</b> - the lowest point on the way there - and two models learn to expect both from the bar's
        features. A BUY needs at least one swing of expected gain, a SELL at least one swing of expected risk.
      </p>
      {latest.length > 0 && (
        <div className="swing-turns">
          Latest turns:{" "}
          {latest.map((t) => (
            <span key={t.time} className={`swing-turn ${t.kind}`} title={`confirmed ${t.confirmed}`}>
              {t.kind === "low" ? "Low" : "High"} {short(t.date)} · {price(t.price)}
              <small> (known {short(t.confirmed)})</small>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
