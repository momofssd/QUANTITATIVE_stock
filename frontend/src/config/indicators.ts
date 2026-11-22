/** Indicator presets per interval, the indicator menu layout, and helpers to edit/serialize lengths. */
import type { Timeframe } from "../types/api";

export type IndicatorKey =
  | "sma1" | "sma2" | "sma3" | "ema1" | "ema2" | "bb" | "vwap" | "vix" | "volume" | "rsi" | "macd";

/** Lengths in bars. bb = [length, multiplier]. */
export interface IndicatorParams {
  sma: [number, number, number];
  ema: [number, number];
  bb: [number, number];
  rsi: number;
  macd: [number, number, number];
}

export const DEFAULT_ENABLED: IndicatorKey[] = ["volume", "sma1", "sma2", "vwap", "vix", "rsi", "macd"];
/** Lines added to the defaults later: switched on once for indicator settings saved before they existed. */
export const NEW_DEFAULTS: IndicatorKey[] = ["vix", "vwap"];

const STD: IndicatorParams = { sma: [20, 50, 200], ema: [12, 26], bb: [20, 2], rsi: 14, macd: [12, 26, 9] };

/** Lengths are counted in bars, so each interval gets its own sensible defaults. */
export const PRESETS: Record<Timeframe, IndicatorParams> = {
  "1Min": { ...STD, sma: [9, 20, 50], ema: [9, 21] },
  "5Min": { ...STD, sma: [9, 20, 50], ema: [9, 21] },
  "15Min": { ...STD, sma: [20, 50, 100], ema: [9, 21] },
  "30Min": { ...STD, sma: [20, 50, 100], ema: [9, 21] },
  "1Hour": STD,
  "4Hour": STD,
  "1Day": STD,
  "1Week": { ...STD, sma: [10, 20, 40] },
  "1Month": { ...STD, sma: [6, 12, 24] },
};

/** A field inside IndicatorParams: [name, index?, isDecimal?]. */
export type ParamField = [keyof IndicatorParams, number?, boolean?];

export type IndicatorRow =
  | { section: string }
  | { key: IndicatorKey; label: string; color?: string; fields?: ParamField[]; hint?: string };

export const INDICATOR_ROWS: IndicatorRow[] = [
  { section: "Overlays" },
  { key: "sma1", label: "SMA", color: "#f39c12", fields: [["sma", 0]] },
  { key: "sma2", label: "SMA", color: "#2a6ebb", fields: [["sma", 1]] },
  { key: "sma3", label: "SMA", color: "#8e44ad", fields: [["sma", 2]] },
  { key: "ema1", label: "EMA", color: "#16a085", fields: [["ema", 0]] },
  { key: "ema2", label: "EMA", color: "#c0392b", fields: [["ema", 1]] },
  { key: "bb", label: "Bollinger", color: "#0097a7", fields: [["bb", 0], ["bb", 1, true]], hint: "length, σ" },
  { key: "vwap", label: "VWAP", color: "#e84393", hint: "per session · daily+: from range start" },
  { section: "Lower panes" },
  { key: "volume", label: "Volume" },
  { key: "vix", label: "VIX", color: "#ffb6c1", hint: "volatility index · daily close" },
  { key: "rsi", label: "RSI", fields: [["rsi"]] },
  { key: "macd", label: "MACD", fields: [["macd", 0], ["macd", 1], ["macd", 2]], hint: "fast, slow, signal" },
];

/** Old (v1) stored indicator names -> current keys. */
export const LEGACY_KEYS: Record<string, IndicatorKey> = {
  sma20: "sma1", sma50: "sma2", sma200: "sma3", ema12: "ema1", ema26: "ema2",
};

export const cloneParams = (p: IndicatorParams): IndicatorParams => JSON.parse(JSON.stringify(p));

export function getField(p: IndicatorParams, [name, i]: ParamField): number {
  const v = p[name];
  return Array.isArray(v) ? v[i ?? 0] : v;
}

export function setField(p: IndicatorParams, [name, i]: ParamField, value: number): IndicatorParams {
  const next = cloneParams(p);
  const v = next[name];
  if (Array.isArray(v)) v[i ?? 0] = value;
  else (next as unknown as Record<string, number>)[name] = value;
  return next;
}

/** Range checks for one input, then cross-field rules. Returns an error message or null. */
export function validateField(field: ParamField, value: number, whole: IndicatorParams): string | null {
  const dec = field[2];
  if (!Number.isFinite(value)) return "Enter a number";
  if (dec ? value < 0.1 || value > 5 : !Number.isInteger(value) || value < 1 || value > 500) {
    return dec ? "0.1 – 5" : "Whole number 1 – 500";
  }
  if (field[0] === "bb" && field[1] === 0 && value < 2) return "Length must be at least 2";
  if (whole.macd[0] >= whole.macd[1]) return "MACD fast must be shorter than slow";
  return null;
}

/** Query-string form expected by GET /api/bars. */
export function paramQuery(p: IndicatorParams): Record<string, string> {
  return { sma: p.sma.join(","), ema: p.ema.join(","), bb: p.bb.join(","), rsi: String(p.rsi), macd: p.macd.join(",") };
}
