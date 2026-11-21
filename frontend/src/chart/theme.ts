/** Chart colors and the overlay series definitions. */
import type { IndicatorKey } from "../config/indicators";
import type { ServerIndicatorParams } from "../types/api";

export const COLORS = {
  up: "#368727", down: "#c8102e",
  upVol: "rgba(54,135,39,0.42)", downVol: "rgba(200,16,46,0.38)",
  line: "#2b6c1f",
  sma1: "#f39c12", sma2: "#2a6ebb", sma3: "#8e44ad",
  ema1: "#16a085", ema2: "#c0392b", bb: "#0097a7", bbFill: "rgba(0, 151, 167, 0.10)", vwap: "#e84393",
  rsi: "#2a6ebb", macd: "#2a6ebb", signal: "#f39c12",
  grid: "#f1f1f1", rule: "#d8d8d8", text: "#555",
  histUpStrong: "rgba(54,135,39,0.75)", histUpWeak: "rgba(54,135,39,0.35)",
  histDownStrong: "rgba(200,16,46,0.7)", histDownWeak: "rgba(200,16,46,0.32)",
} as const;

export interface OverlayDef {
  key: IndicatorKey;     // which menu toggle shows it
  col: string;           // column in the bars payload
  label: (p: ServerIndicatorParams) => string;
  color: string;
  style?: 0 | 1 | 2;     // LineStyle: solid, dotted, dashed
  width?: 1 | 2;
  legend?: boolean;      // show in legend (default true)
}

/** Labels are functions of the lengths the server actually used. */
export const OVERLAYS: OverlayDef[] = [
  { key: "sma1", col: "sma1", label: (p) => `SMA${p.sma[0]}`, color: COLORS.sma1 },
  { key: "sma2", col: "sma2", label: (p) => `SMA${p.sma[1]}`, color: COLORS.sma2 },
  { key: "sma3", col: "sma3", label: (p) => `SMA${p.sma[2]}`, color: COLORS.sma3 },
  { key: "ema1", col: "ema1", label: (p) => `EMA${p.ema[0]}`, color: COLORS.ema1 },
  { key: "ema2", col: "ema2", label: (p) => `EMA${p.ema[1]}`, color: COLORS.ema2 },
  // Bollinger: bold solid bands + dashed middle; the area between them is shaded (bandSeries.ts).
  { key: "bb", col: "bb_upper", label: (p) => `BB${p.bb_len} Up`, color: COLORS.bb, width: 2 },
  { key: "bb", col: "bb_mid", label: () => "Mid", color: COLORS.bb, style: 2 },
  { key: "bb", col: "bb_lower", label: () => "Lo", color: COLORS.bb, width: 2 },
  { key: "vwap", col: "vwap", label: () => "VWAP", color: COLORS.vwap, width: 2, style: 2 },
];

export const FONT_FAMILY = '"Helvetica Neue", Helvetica, Arial, sans-serif';
