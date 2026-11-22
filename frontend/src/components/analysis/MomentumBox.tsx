/**
 * "Momentum vs previous K lines" (Current K panel): is the current K line moving toward a BUY or a SELL compared
 * with the K lines before it? Each model's P on the last K lines - all scored by TODAY's model, so the change comes
 * from the K lines, not from a retrain - against its threshold, plus RSI / MACD price momentum and an overall verdict.
 */
import { MARK } from "../../chart/markers";
import type { AnalysisResult, CurrentSignal, TargetKey } from "../../types/api";

const LOOK = 5;          // compare with the K line this many bars back
const MOVE = 0.02;       // a model's P must move at least 2 pts to count as moving
const VERDICT = 3;       // overall: BUY push minus SELL push of at least 3 pts

const pts = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(1)}`;
const pc = (v: number) => `${Math.round(v * 100)}%`;

interface Row { key: TargetKey; label: string; side: "buy" | "sell"; c: CurrentSignal }

function stats(c: CurrentSignal) {
  const r = c.recent;
  const now = r[r.length - 1].prob;
  const prev = r.length > 1 ? r[r.length - 2].prob : now;
  const back = r[Math.max(0, r.length - 1 - LOOK)].prob;
  return { now, d1: now - prev, d5: now - back, gap: c.threshold - now };
}

function status(row: Row): { text: string; tone: string } {
  const { c, label, side } = row;
  const s = stats(c);
  if (c.signal) return { text: `${label} now`, tone: side };
  if (s.d5 >= MOVE) {
    return s.gap > 0 ? { text: `approaching - ${(s.gap * 100).toFixed(1)} pts below the threshold`, tone: side }
      : { text: "above the threshold - waiting for the setup", tone: side };
  }
  if (s.d5 <= -MOVE) return { text: "moving away", tone: "away" };
  return { text: "flat", tone: "" };
}

/** Tiny line of P over the last K lines with the threshold dashed. */
function Spark({ c, side }: { c: CurrentSignal; side: "buy" | "sell" }) {
  const w = 96, h = 22;
  const vals = c.recent.map((x) => x.prob);
  const lo = Math.min(...vals, c.threshold) - 0.02, hi = Math.max(...vals, c.threshold) + 0.02;
  const y = (v: number) => h - 2 - ((v - lo) / (hi - lo || 1)) * (h - 4);
  const x = (i: number) => 2 + (i / Math.max(1, vals.length - 1)) * (w - 4);
  return (
    <svg className={`mom-spark ${side}`} width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <line x1={0} x2={w} y1={y(c.threshold)} y2={y(c.threshold)} className="thr" />
      <polyline points={vals.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
      <circle cx={x(vals.length - 1)} cy={y(vals[vals.length - 1])} r={2.4} />
    </svg>
  );
}

export function MomentumBox({ r }: { r: AnalysisResult }) {
  const rows: Row[] = ([
    ["short", "BUY", "buy"], ["accum", "BUY S", "buy"], ["tp_short", "SELL", "sell"],
  ] as const).flatMap(([key, label, side]) => {
    const c = r.targets[key]?.current;
    return c && c.recent?.length ? [{ key, label, side, c }] : [];
  });
  if (rows.length === 0) return null;
  const buyRows = rows.filter((x) => x.side === "buy");
  const sellRow = rows.find((x) => x.side === "sell");
  const buyPush = buyRows.reduce((a, x) => a + stats(x.c).d5, 0) / Math.max(1, buyRows.length);
  const sellPush = sellRow ? stats(sellRow.c).d5 : 0;
  const score = (buyPush - sellPush) * 100;
  const verdict = score >= VERDICT ? { tone: "buy", text: "Momentum is moving toward BUY" }
    : score <= -VERDICT ? { tone: "sell", text: "Momentum is moving toward SELL" }
      : { tone: "flat", text: "No clear shift toward BUY or SELL" };

  const km = r.k_momentum ?? [];
  const kNow = km[km.length - 1];
  const kBack = km[Math.max(0, km.length - 1 - LOOK)];
  const rsiDir = kNow?.rsi != null && kBack?.rsi != null ? kNow.rsi - kBack.rsi : null;
  const macdPrev = km.length > 1 ? km[km.length - 2].macd_hist_atr : null;
  const macdDir = kNow?.macd_hist_atr != null && macdPrev != null ? kNow.macd_hist_atr - macdPrev : null;

  return (
    <div className={`mom ${verdict.tone}`}>
      <div className="mom-h">
        <b>{verdict.text}</b>
        <small>
          compared with the previous K lines (last {rows[0].c.recent.length}, all scored by today's models) · BUY models
          {" "}{pts(buyPush)} pts vs SELL {pts(sellPush)} pts over the last {LOOK} K lines
        </small>
      </div>
      <div className="table-scroll">
        <table className="grid mom-t">
          <thead>
            <tr>
              <th className="l">Model</th><th className="l">P, last {rows[0].c.recent.length} K lines</th><th>Now</th>
              <th>Threshold</th><th>vs previous K</th><th>vs {LOOK} K ago</th><th className="l">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const s = stats(row.c);
              const st = status(row);
              return (
                <tr key={row.key}>
                  <td className="l"><span className={`mark-chip mark-${row.key}`}>{MARK[row.key].text}</span></td>
                  <td className="l"><Spark c={row.c} side={row.side} /></td>
                  <td><b>{pc(s.now)}</b></td>
                  <td>{pc(row.c.threshold)}</td>
                  <td className={s.d1 > 0 ? "up" : s.d1 < 0 ? "down" : ""}>{pts(s.d1)} pts</td>
                  <td className={s.d5 > 0 ? "up" : s.d5 < 0 ? "down" : ""}><b>{pts(s.d5)} pts</b></td>
                  <td className={`l mom-st ${st.tone}`}>{st.text}{!row.c.setup && !row.c.signal ? " · no setup now" : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {kNow && (
        <p className="ta-note mom-price">
          Price momentum: RSI(14) <b>{kNow.rsi ?? "—"}</b>
          {rsiDir !== null && <> ({rsiDir >= 0 ? "up" : "down"} {Math.abs(rsiDir).toFixed(1)} vs {LOOK} K ago)</>}
          {" "}· MACD histogram <b>{kNow.macd_hist_atr?.toFixed(2) ?? "—"} ATR</b>
          {macdDir !== null && <> ({macdDir >= 0 ? "rising" : "falling"} vs the previous K)</>}.
          {" "}For BUY / BUY S a rising P is toward buying; for SELL a rising P is toward selling. A BUY / SELL still needs
          its setup on the K line.
        </p>
      )}
    </div>
  );
}
