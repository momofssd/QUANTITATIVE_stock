/**
 * Analysis result -> chart markers and price lines.
 *   entries        S / L   green-or-red-or-blue up-arrows below the bar (outcome of the ATR target)
 *   trade exits    small dot above the bar on the exit day, labelled with the trade's return
 *   take-profits   TS / TL down-arrows above the bar (green = the pullback came, red = price kept rising)
 *   price lines    today's entry target/stop; open trades' current stop and target
 */
import type { AnalysisResult, ExitReason, Outcome, TargetKey, TargetSpec } from "../types/api";

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

/** What the user has switched on. `cost` = long-term average-cost line + SMA 60. */
export type MarkerVisibility = Record<TargetKey, boolean> & { exits: boolean; cost: boolean };

/** Extra line series on the price pane (long-term cost check). */
export interface AnalysisLineDef {
  key: string;
  color: string;
  style: 0 | 1 | 2;
  width: 1 | 2;
  step: boolean;
  title: string;
  data: { time: number; value: number }[];
}

export const COST_COLOR = "#d35400";
export const SMA_CHECK_COLOR = "#8e44ad";

export const GREEN = "#368727";
export const RED = "#c8102e";
export const BLUE = "#2a6ebb";

/** Green = the signal turned out right, red = wrong, blue = undecided. Same for entries and take-profits. */
export const OUTCOME_COLOR: Record<Outcome, string> = { target: GREEN, stop: RED, expired: RED, pending: BLUE };

export function outcomeLabel(spec: TargetSpec, o: Outcome): string {
  if (spec.key === "short") {
    return {
      target: "Justified · TP hit", stop: "Not justified · SL hit", expired: "Not justified · expired", pending: "Open",
    }[o];
  }
  if (spec.kind === "take_profit") {
    return { target: "Pullback came", stop: "Kept rising", expired: "Expired", pending: "Open" }[o];
  }
  return { target: "Target hit", stop: "Stopped out", expired: "Expired", pending: "Open" }[o];
}

export const EXIT_LABEL: Record<ExitReason, string> = {
  target: "Target", "trailing stop": "Trailing stop", "take-profit signal": "Take-profit signal",
  "time limit": "Time limit", stop: "Stop",
};

export const MARK: Record<TargetKey, { text: string; size: number }> = {
  short: { text: "S", size: 1 },
  long: { text: "L", size: 1.6 },
  tp_short: { text: "TS", size: 1 },
  tp_long: { text: "TL", size: 1.6 },
};

const fmtPct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;

export const DECISION_COLOR = "#1a1a1a";
export const NO_DECISION_COLOR = "#9a9a9a";

export interface Decision {
  key: TargetKey;
  tag: string;      // "S", "L", "TS", "TL"
  action: "BUY" | "SELL" | "NO ENTRY" | "HOLD";
  active: boolean;  // BUY / SELL
  reliable: boolean;
  prob: number;
  threshold: number;
  date: string;
  time: number;
}

/** The model's decision for the latest analysed K line, per target (independent of the marker cooldown). */
export function latestDecisions(r: AnalysisResult): Decision[] {
  return (Object.keys(r.targets) as TargetKey[]).flatMap((key) => {
    const t = r.targets[key];
    const c = t.current;
    if (!c) return [];
    const entry = t.spec.kind === "entry";
    return [{
      key, tag: MARK[key].text, active: c.signal, reliable: t.stats.reliable, prob: c.prob, threshold: c.threshold,
      action: c.signal ? (entry ? "BUY" : "SELL") : (entry ? "NO ENTRY" : "HOLD"), date: c.date, time: c.time,
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
      // Latest K line: always show the decision (BUY / SELL, or "–" for no entry / hold); "?" = no reliable edge.
      const mark = d.reliable ? "" : "?";
      out.push(d.active
        ? { time: d.time, position: up ? "belowBar" : "aboveBar", shape: up ? "arrowUp" : "arrowDown",
          color: DECISION_COLOR, text: `${d.tag} ${d.action}${mark}`, size: MARK[key].size + 0.4 }
        : { time: d.time, position: up ? "belowBar" : "aboveBar", shape: "circle",
          color: NO_DECISION_COLOR, text: `${d.tag} –${mark}`, size: 0.6 });
    }
    for (const s of t.signals) {
      if (d && s.time === d.time) continue; // the decision marker above replaces it
      out.push({
        time: s.time, position: up ? "belowBar" : "aboveBar", shape: up ? "arrowUp" : "arrowDown",
        color: OUTCOME_COLOR[s.outcome], ...MARK[key],
      });
      const tr = s.trade;
      if (vis.exits && tr?.status === "closed" && tr.exit_time !== undefined) {
        out.push({
          time: tr.exit_time, position: "aboveBar", shape: "circle", size: 0.6,
          color: tr.return_pct > 0 ? GREEN : RED, text: `${MARK[key].text} ${fmtPct(tr.return_pct)}`,
        });
      }
    }
  });
  return out.sort((a, b) => a.time - b.time);
}

export function buildPriceLines(r: AnalysisResult, vis: MarkerVisibility): PriceLineDef[] {
  const out: PriceLineDef[] = [];
  (["short", "long"] as const).forEach((key) => {
    if (!vis[key]) return;
    const t = r.targets[key];
    const tag = MARK[key].text;
    const ot = t.open_trade?.trade;
    if (ot?.status === "open" && ot.stop !== undefined && ot.target !== undefined) {
      out.push({ price: ot.target, color: GREEN, title: `${tag} open target`, style: 1 });
      out.push({ price: ot.stop, color: RED, title: `${tag} ${ot.trailing ? "trailing stop" : "open stop"}`, style: 1 });
    }
    const c = t.current;
    if (c?.signal) {
      out.push({ price: c.target, color: GREEN, title: `${tag} ${key === "short" ? "TP" : "target"}`, style: 2 });
      out.push({ price: c.stop, color: RED, title: `${tag} ${key === "short" ? "SL" : "stop"}`, style: 2 });
    }
  });
  return out;
}

/** Long-term check on the chart: SMA 60 (dashed) and the running average cost of the long-term buys (steps). */
export function buildAnalysisLines(r: AnalysisResult, vis: MarkerVisibility): AnalysisLineDef[] {
  if (!vis.cost || !r.lines?.sma?.length) return [];
  const out: AnalysisLineDef[] = [{
    key: "sma", color: SMA_CHECK_COLOR, style: 2, width: 1, step: false,
    title: `SMA ${r.lines.sma_len ?? 60}`, data: r.lines.sma,
  }];
  if (r.lines.avg_cost?.length) {
    out.push({ key: "avg", color: COST_COLOR, style: 0, width: 2, step: true, title: "L avg cost", data: r.lines.avg_cost });
  }
  return out;
}
