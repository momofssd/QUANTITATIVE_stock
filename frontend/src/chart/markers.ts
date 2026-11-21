/**
 * Analysis result -> chart markers and price lines.
 *   BUY            up-arrows below the bar, coloured by outcome (green = profit-take hit first, red = not)
 *   SELL           down-arrows above the bar (green = the pullback came, red = price kept rising)
 *   trade exits    small dot above the bar on the exit day, labelled with the trade's return
 *   current K      the latest decision on the newest candle: BUY / SELL (black) or "–" (grey, no signal)
 *   price lines    current BUY: entry / profit-take / stop-loss; an open trade's levels
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
  style: 0 | 1 | 2; // solid, dotted, dashed
}

/** What the user has switched on. */
export type MarkerVisibility = Record<TargetKey, boolean> & { exits: boolean };

export const GREEN = "#368727";
export const RED = "#c8102e";
export const BLUE = "#2a6ebb";
export const DECISION_COLOR = "#1a1a1a";
export const NO_DECISION_COLOR = "#9a9a9a";

/** Green = the signal turned out right, red = wrong, blue = undecided. */
export const OUTCOME_COLOR: Record<Outcome, string> = { target: GREEN, stop: RED, expired: RED, pending: BLUE };

export function outcomeLabel(spec: TargetSpec, o: Outcome): string {
  if (spec.kind === "take_profit") {
    return { target: "Pullback came", stop: "Kept rising", expired: "Expired", pending: "Open" }[o];
  }
  return {
    target: "Justified · TP hit", stop: "Not justified · SL hit", expired: "Not justified · expired", pending: "Open",
  }[o];
}

export const EXIT_LABEL: Record<ExitReason, string> = {
  target: "Profit-take", "trailing stop": "Trailing stop", "take-profit signal": "SELL signal",
  "time limit": "Time limit", stop: "Stop-loss",
};

export const SETUP_LABEL: Record<Exclude<SetupName, "">, string> = {
  rebound: "Rebound", trend: "Trend", top: "Interim top",
};

/** On-chart label per target. */
export const MARK: Record<TargetKey, { text: string; size: number }> = {
  short: { text: "BUY", size: 1 },
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

export function buildMarkers(r: AnalysisResult, vis: MarkerVisibility): EntryMarker[] {
  const out: EntryMarker[] = [];
  const decided = new Map(latestDecisions(r).map((d) => [d.key, d]));
  (Object.keys(r.targets) as TargetKey[]).forEach((key) => {
    if (!vis[key]) return;
    const t = r.targets[key];
    const up = t.spec.direction === "up";
    const d = decided.get(key);
    if (d) {
      // Current K line: always show the decision; grey "–" when there is no BUY / SELL.
      out.push(d.active
        ? { time: d.time, position: up ? "belowBar" : "aboveBar", shape: up ? "arrowUp" : "arrowDown",
          color: DECISION_COLOR, text: d.action, size: 1.4 }
        : { time: d.time, position: up ? "belowBar" : "aboveBar", shape: "circle",
          color: NO_DECISION_COLOR, text: up ? "BUY –" : "SELL –", size: 0.6 });
    }
    for (const s of t.signals) {
      if (!s.in_range) continue;            // only the chart's own range (older ones are in the decision tables)
      if (d && s.time === d.time) continue; // the current-K marker above replaces it
      out.push({
        time: s.time, position: up ? "belowBar" : "aboveBar", shape: up ? "arrowUp" : "arrowDown",
        color: OUTCOME_COLOR[s.outcome], ...MARK[key],
      });
      const tr = s.trade;
      if (vis.exits && tr?.status === "closed" && tr.exit_time !== undefined) {
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
  if (!vis.short) return out;
  const t = r.targets.short;
  const ot = t.open_trade?.trade;
  if (ot?.status === "open" && ot.stop !== undefined && ot.target !== undefined) {
    out.push({ price: ot.target, color: GREEN, title: "Open trade TP", style: 1 });
    out.push({ price: ot.stop, color: RED, title: "Open trade SL", style: 1 });
  }
  const c = t.current;
  if (c?.signal) {
    out.push({ price: c.entry, color: BLUE, title: "BUY entry", style: 2 });
    out.push({ price: c.target, color: GREEN, title: "Profit-take", style: 2 });
    out.push({ price: c.stop, color: RED, title: "Stop-loss", style: 2 });
  }
  return out;
}
