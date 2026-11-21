/**
 * The current K line: model + setup decision for BUY and SELL, the BUY entry plan checked against the live price,
 * the setup checklists, and today's 5-minute action (refreshed every minute) as confirmation.
 */
import { SETUP_LABEL } from "../../chart/markers";
import { TF_LABEL } from "../../config/timeframes";
import { isNum, price } from "../../lib/format";
import type { AnalysisResult, CurrentSignal, IntradayCheck, SetupExplain } from "../../types/api";

const pct = (v: number | null | undefined) => (isNum(v) ? `${Math.round(v * 100)}%` : "—");
type Tone = "ok" | "soft" | "warn" | "bad" | "none";

function Checklist({ title, s }: { title: string; s: SetupExplain }) {
  return (
    <div className={`ck-setup ${s.active ? "on" : ""}`}>
      <div className="ck-setup-h"><b>{title}</b> {s.active ? "✓ in setup" : "not in setup"} <small>({s.rule})</small></div>
      <ul>{s.checks.map((c) => <li key={c.label} className={c.ok ? "ok" : ""}>{c.ok ? "✓" : "✗"} {c.label}</li>)}</ul>
    </div>
  );
}

/** Where the live price stands relative to a BUY plan. */
function liveStatus(c: CurrentSignal, live: number): { tone: Tone; text: string } {
  const a = c.atr || 1;
  const chase = c.chase_limit ?? c.entry;
  if (live >= c.target) return { tone: "warn", text: `Live ${price(live)} is already at/above the profit-take — the move happened; don't chase.` };
  if (live <= c.stop) return { tone: "bad", text: `Live ${price(live)} is at/below the stop-loss — this BUY is invalidated.` };
  if (live > chase) {
    return { tone: "warn", text: `Live ${price(live)} is ${((live - c.entry) / a).toFixed(2)} ATR above the entry, beyond the chase limit ${price(chase)} — wait for a pullback.` };
  }
  if (live >= c.entry) return { tone: "ok", text: `Live ${price(live)} is inside the entry zone (${price(c.entry)} – ${price(chase)}).` };
  return {
    tone: "ok",
    text: `Live ${price(live)} is below the entry — a better price. Reward : risk from here ${((c.target - live) / (live - c.stop)).toFixed(2)}.`,
  };
}

function decisionText(kind: "buy" | "sell", c: CurrentSignal, iv: IntradayCheck | null): { tone: Tone; title: string; sub: string } {
  const v = iv?.available ? (kind === "buy" ? iv.buy?.verdict : iv.sell?.verdict) : undefined;
  if (!c.signal) {
    const why = [
      !c.ml_signal && `model ${pct(c.prob)} is below its ${pct(c.threshold)} threshold`,
      !c.setup && (kind === "buy" ? "no rebound or trend setup on this bar" : "no interim-top setup on this bar"),
    ].filter(Boolean).join("; ");
    return { tone: "none", title: kind === "buy" ? "NO BUY" : "HOLD — no take-profit signal", sub: why };
  }
  const setup = c.setup ? SETUP_LABEL[c.setup] : "";
  if (kind === "buy") {
    if (v === "supports") return { tone: "ok", title: "BUY — confirmed", sub: `${setup} setup; today's 5-minute action supports it` };
    if (v === "against") return { tone: "warn", title: "WAIT — 5-minute action is against the BUY", sub: `${setup} setup; the model says BUY but today's tape disagrees` };
    if (v === "mixed") return { tone: "soft", title: "BUY — unconfirmed", sub: `${setup} setup; today's 5-minute action is mixed` };
    return { tone: "soft", title: "BUY", sub: `${setup} setup; no 5-minute check available` };
  }
  if (v === "supports") return { tone: "bad", title: "SELL / take profit — confirmed", sub: "Interim top; today's 5-minute action is weakening" };
  if (v === "against") return { tone: "warn", title: "HOLD for now — 5-minute action still strong", sub: "Interim-top signal, but today's tape is not weakening yet" };
  if (v === "mixed") return { tone: "soft", title: "SELL / take profit — unconfirmed", sub: "Interim top; today's 5-minute action is mixed" };
  return { tone: "soft", title: "SELL / take profit", sub: "Interim top; no 5-minute check available" };
}

function IntradayBox({ iv }: { iv: IntradayCheck | null }) {
  if (!iv) return null;
  if (!iv.available) return <div className="ck-intraday"><b>Today's 5-minute check:</b> unavailable — {iv.reason}</div>;
  const v = (x?: { score: number; verdict: string }) => (x ? `${x.verdict} (${x.score > 0 ? "+" : ""}${x.score})` : "—");
  return (
    <div className="ck-intraday">
      <div className="ck-intraday-h">
        <b>Today's 5-minute check</b> · session {iv.session}, {iv.bars} bars, as of {iv.asof} ET
        {isNum(iv.day_change_pct) && <> · day {iv.day_change_pct > 0 ? "+" : ""}{iv.day_change_pct.toFixed(2)}%</>}
        <span className="ck-scores">BUY: <b>{v(iv.buy)}</b> · SELL: <b>{v(iv.sell)}</b></span>
      </div>
      <table className="grid ck-checks">
        <tbody>
          {iv.checks!.map((c) => (
            <tr key={c.id}>
              <td className="l">{c.label}</td>
              <td>{c.detail}</td>
              <td className={`l sig ${c.signal > 0 ? "up" : c.signal < 0 ? "down" : ""}`}>
                {c.signal > 0 ? "▲ supports BUY" : c.signal < 0 ? "▼ supports SELL" : "– neutral"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="ta-note">Refreshes every minute. A sanity check on the live day; it is not part of the backtested model.</p>
    </div>
  );
}

interface Props {
  r: AnalysisResult;
  intraday: IntradayCheck | null;
  livePrice: number | null;
}

export function CurrentKPanel({ r, intraday, livePrice }: Props) {
  const buy = r.targets.short;
  const sell = r.targets.tp_short;
  const cb = buy.current;
  const cs = sell.current;
  if (!cb || !cs) return null;
  const db = decisionText("buy", cb, intraday);
  const ds = decisionText("sell", cs, intraday);
  const status = cb.signal && isNum(livePrice) ? liveStatus(cb, livePrice) : null;
  return (
    <div className="ck">
      <div className="ck-title">
        Current K line <b>{cb.date}</b> · {TF_LABEL[r.timeframe]}
        {isNum(livePrice) && <> · live price <b>{price(livePrice)}</b></>}
      </div>
      <div className="ck-grid">
        <div className="ck-box">
          <div className={`ck-decision ${db.tone}`}>
            <b>{db.title}</b><small>{db.sub}{!buy.stats.reliable && " · model had no reliable edge for this stock"}</small>
          </div>
          <div className="ck-prob">Model P(profit-take first) <b>{pct(cb.prob)}</b> vs threshold {pct(cb.threshold)} · base rate {pct(cb.base_rate)}</div>
          {cb.signal && (
            <>
              <table className="kv ck-plan">
                <tbody>
                  <tr><th>Entry</th><td>{price(cb.entry)}</td><th>Chase limit</th><td>{price(cb.chase_limit)}</td></tr>
                  <tr><th>Profit-take</th><td className="up">{price(cb.target)}</td><th>Stop-loss</th><td className="down">{price(cb.stop)}</td></tr>
                  <tr>
                    <th>Daily ATR</th><td>{price(cb.atr)}</td>
                    <th>Reward : risk</th><td>{((cb.target - cb.entry) / (cb.entry - cb.stop)).toFixed(2)}</td>
                  </tr>
                </tbody>
              </table>
              {status && <div className={`ck-live ${status.tone}`}>{status.text}</div>}
              <p className="ta-note">
                Entry = the K line's price when the model decided. Enter at or below the chase limit (entry + {r.chase_atr} ATR);
                exit at the profit-take, the stop-loss, a SELL signal while in profit, or after 5 trading sessions.
              </p>
            </>
          )}
          <Checklist title="Rebound (falling momentum easing)" s={r.setups_now.rebound} />
          <Checklist title="Trend (clear bullish trend)" s={r.setups_now.trend} />
        </div>
        <div className="ck-box">
          <div className={`ck-decision ${ds.tone}`}>
            <b>{ds.title}</b><small>{ds.sub}{!sell.stats.reliable && " · model had no reliable edge for this stock"}</small>
          </div>
          <div className="ck-prob">Model P(pullback first) <b>{pct(cs.prob)}</b> vs threshold {pct(cs.threshold)} · base rate {pct(cs.base_rate)}</div>
          {cs.signal && (
            <table className="kv ck-plan">
              <tbody>
                <tr><th>Price</th><td>{price(cs.entry)}</td><th>Pullback to</th><td className="down">{price(cs.target)}</td></tr>
              </tbody>
            </table>
          )}
          <Checklist title="Interim top (bullish momentum easing)" s={r.setups_now.top} />
        </div>
      </div>
      <IntradayBox iv={intraday} />
      <p className="ta-note">
        The model decision uses the K line as it was when you pressed <b>Find entry points</b>; press it again to re-decide
        as the live K line develops.
      </p>
    </div>
  );
}
