/**
 * Analysis result -> chart markers and price lines.
 *   BUY            up-arrows below the bar, coloured by outcome (green = profit-take hit first, red = not)
 *   SELL           down-arrows above the bar (green = the pullback came, red = price kept rising)
 *   trade exits    small dot above the bar on the exit day, labelled with the trade's return
 *   current K      the latest decision on the newest candle: BUY / SELL (black) or "–" (grey, no signal)
 *   price lines    current BUY: entry / profit-take / stop-loss; an open trade's levels
 *   setup filter   BUY / BUY S of a switched-off setup (rebound / trend) are left out, with their exits and lines
 */
import type { AnalysisResult, ExitReason, Outcome, SetupName, TargetKey, TargetSpec } from "../types/api";

export interface EntryMarker {
  time: number;
  position: "belowBar" | "aboveBar";
  shape: "arrowUp" | "arrowDown" | "circle" | "square";
  color: string;
  text: string;
  size: number;
}

export interface PriceLineDef {
  price: number;
  color: string;
  title: string;
  style: 0 | 1 | 2 | 3; // solid, dotted, dashed, large dashed
}

/** The rule-based setups a BUY / BUY S can be in (every BUY needs one of them). */
export type BuySetup = "rebound" | "trend";
export const BUY_SETUPS: BuySetup[] = ["rebound", "trend"];
/** Which BUY setups are drawn: switching one off filters its BUY / BUY S markers (and their exits, price lines) out. */
export type BuySetupFilter = Record<BuySetup, boolean>;
export const ALL_BUY_SETUPS: BuySetupFilter = { rebound: true, trend: true };

/** What the user has switched on. */
export type MarkerVisibility = Record<TargetKey, boolean> & { exits: boolean; setups: BuySetupFilter };

/** Is a decision of this target in this setup drawn? Only BUYs are filtered (SELL is always the interim-top setup). */
export function setupShown(spec: TargetSpec, setup: SetupName, f: BuySetupFilter): boolean {
  return spec.kind !== "entry" || !(setup === "rebound" || setup === "trend") || f[setup];
}

/** BUY + BUY S decisions per setup in the analysed window (for the filter buttons). */
export function buySetupCounts(r: AnalysisResult): Record<BuySetup, number> {
  const out: Record<BuySetup, number> = { rebound: 0, trend: 0 };
  for (const t of Object.values(r.targets)) {
    if (t.spec.kind !== "entry") continue;
    for (const s of t.signals) if (s.setup === "rebound" || s.setup === "trend") out[s.setup] += 1;
  }
  return out;
}

export const GREEN = "#368727";
export const RED = "#c8102e";
export const BLUE = "#2a6ebb";
export const DECISION_COLOR = "#1a1a1a";
export const NO_DECISION_COLOR = "#9a9a9a";

/** Green = the signal turned out right, red = wrong, blue = undecided. */
export const OUTCOME_COLOR: Record<Outcome, string> = { target: GREEN, stop: RED, expired: RED, pending: BLUE };

export function outcomeLabel(spec: TargetSpec, o: Outcome): string {
  if (spec.label_rule === "next_sell") {
    return { target: "Profit at next SELL", stop: "Loss at next SELL", expired: "Expired", pending: "Waiting for a SELL" }[o];
  }
  if (spec.kind === "take_profit") {
    return { target: "Pullback came", stop: "Kept rising", expired: "Expired", pending: "Open" }[o];
  }
  return {
    target: "Justified · TP hit", stop: "Not justified · SL hit", expired: "Not justified · expired", pending: "Open",
  }[o];
}

export const EXIT_LABEL: Record<ExitReason, string> = {
  target: "Profit-take", "trailing stop": "Trailing stop", "take-profit signal": "SELL signal",
  "time limit": "Time limit", stop: "Stop-loss", "sell decision": "SELL decision",
};

export const SETUP_LABEL: Record<Exclude<SetupName, "">, string> = {
  rebound: "Rebound", trend: "Trend", top: "Interim top",
};

/** On-chart label per target. */
export const MARK: Record<TargetKey, { text: string; size: number }> = {
  short: { text: "BUY", size: 1 },
  accum: { text: "BUY S", size: 1 },   // BUY for the sell-signal strategy
  tp_short: { text: "SELL", size: 1 },
};

const fmtPct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;

export interface Decision {
  key: TargetKey;
  action: "BUY" | "SELL" | "NO BUY" | "HOLD";
  active: boolean;   // BUY / SELL
  reliable: boolean;
  prob: number;
  threshold: number;
  setup: SetupName;
  date: string;
  time: number;
}

/** The decision for the latest analysed K line, per target (independent of the marker cooldown). */
export function latestDecisions(r: AnalysisResult): Decision[] {
  return (Object.keys(r.targets) as TargetKey[]).flatMap((key) => {
    const t = r.targets[key];
    const c = t.current;
    if (!c) return [];
    const entry = t.spec.kind === "entry";
    return [{
      key, active: c.signal, reliable: t.stats.reliable, prob: c.prob, threshold: c.threshold, setup: c.setup,
      action: c.signal ? (entry ? "BUY" : "SELL") : (entry ? "NO BUY" : "HOLD"), date: c.date, time: c.time,
    }];
  });
}

/** Every decision of the analysed window is drawn (the chart only shows those on loaded bars): scroll back or
 *  widen the range to see older ones. */
export function buildMarkers(r: AnalysisResult, vis: MarkerVisibility): EntryMarker[] {
  const out: EntryMarker[] = [];
  const decided = new Map(latestDecisions(r).map((d) => [d.key, d]));
  (Object.keys(r.targets) as TargetKey[]).forEach((key) => {
    if (!vis[key]) return;
    const t = r.targets[key];
    const up = t.spec.direction === "up";
    const d = decided.get(key);
    if (d) {
      // Current K line: always show the decision; grey "–" when there is no BUY / SELL (or its setup is filtered out).
      out.push(d.active && setupShown(t.spec, d.setup, vis.setups)
        ? { time: d.time, position: up ? "belowBar" : "aboveBar", shape: up ? "arrowUp" : "arrowDown",
          color: DECISION_COLOR, text: MARK[key].text, size: 1.4 }
        : { time: d.time, position: up ? "belowBar" : "aboveBar", shape: "circle",
          color: NO_DECISION_COLOR, text: `${MARK[key].text} –`, size: 0.6 });
    }
    for (const s of t.signals) {
      if (d && s.time === d.time) continue; // the current-K marker above replaces it
      if (!setupShown(t.spec, s.setup, vis.setups)) continue; // filtered out, with its exit dot
      out.push({
        time: s.time, position: up ? "belowBar" : "aboveBar", shape: up ? "arrowUp" : "arrowDown",
        color: OUTCOME_COLOR[s.outcome], ...MARK[key],
      });
      const tr = s.trade;
      // exit dots for the profit-take / stop-loss BUYs (sell-signal BUYs exit on the SELL markers themselves)
      if (vis.exits && t.spec.label_rule !== "next_sell" && tr?.status === "closed" && tr.exit_time !== undefined) {
        out.push({
          time: tr.exit_time, position: "aboveBar", shape: "circle", size: 0.6,
          color: tr.return_pct > 0 ? GREEN : RED, text: fmtPct(tr.return_pct),
        });
      }
    }
  });
  return out.sort((a, b) => a.time - b.time);
}

export function buildPriceLines(r: AnalysisResult, vis: MarkerVisibility): PriceLineDef[] {
  const out: PriceLineDef[] = [];
  // Projected scenarios for the current K line (where it would become a BUY / a SELL).
  const pj = r.projection;
  if (pj?.buy && !pj.buy.now) out.push({ price: pj.buy.price, color: GREEN, title: "Proj. BUY", style: 3 });
  if (pj?.sell && !pj.sell.now) out.push({ price: pj.sell.price, color: "#d35400", title: "Proj. SELL", style: 3 });
  if (!vis.short) return out;
  const t = r.targets.short;
  const ot = t.open_trade?.trade;
  if (ot?.status === "open" && ot.stop !== undefined && ot.target !== undefined
    && setupShown(t.spec, t.open_trade!.setup, vis.setups)) {
    out.push({ price: ot.target, color: GREEN, title: "Open trade TP", style: 1 });
    out.push({ price: ot.stop, color: RED, title: "Open trade SL", style: 1 });
  }
  const c = t.current;
  if (c?.signal && setupShown(t.spec, c.setup, vis.setups)) {
    out.push({ price: c.entry, color: BLUE, title: "BUY entry", style: 2 });
    out.push({ price: c.target, color: GREEN, title: "Profit-take", style: 2 });
    out.push({ price: c.stop, color: RED, title: "Stop-loss", style: 2 });
  }
  return out;
}
