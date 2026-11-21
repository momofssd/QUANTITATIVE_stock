/** Small formatting helpers shared by the analysis cards and tables. */
import type { TargetResult, TradeView } from "../../types/api";

export const pct = (v: number | null | undefined, d = 0) =>
  v === null || v === undefined ? "—" : `${(v * 100).toFixed(d)}%`;

export const signedPct = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`;

/** "+$12.40" / "−$3.10". */
export const usd = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}`;

export const dirCls =(v: number | null | undefined) =>
  v === null || v === undefined || v === 0 ? "" : v > 0 ? "up" : "down";

/** "3d" on daily, "3w" on weekly, "3 bars" on intraday intervals. */
export function span(n: number, unit: string): string {
  if (unit === "trading days") return `${n}d`;
  if (unit === "weeks") return `${n}w`;
  return `${n} bar${n === 1 ? "" : "s"}`;
}

/** Time left on an open trade. */
export function left(tr: TradeView, unit: string): string {
  const n = tr.days_left ?? 0;
  return tr.left_unit === "sessions" ? `${n} session${n === 1 ? "" : "s"}` : span(n, unit);
}

/** The target's rule in words. */
export function rule(t: TargetResult, unit: string): string {
  const s = t.spec;
  const atrName = s.atr_basis === "daily" ? "daily ATR" : "ATR";
  const window = s.horizon_mode === "sessions"
    ? `${s.horizon} trading sessions`
    : unit.endsWith("bars") ? `${s.horizon} × ${unit}` : `${s.horizon} ${unit}`;
  if (s.key === "short") {
    if (s.bracket === "optimal") {
      return `Profit-take +${s.target_atr}× / stop-loss −${s.stop_atr}× ${atrName} (optimized by backtested profit) within ${window}`;
    }
    return `Profit-take +${s.target_atr}× ${atrName} before stop-loss −${s.stop_atr}× ${atrName} within ${window}`;
  }
  return s.direction === "up"
    ? `+${s.target_atr} ${atrName} before −${s.stop_atr} ${atrName} within ${window}`
    : `−${s.target_atr} ${atrName} (pullback) before +${s.stop_atr} ${atrName} within ${window}`;
}
