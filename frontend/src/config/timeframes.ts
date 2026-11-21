/** Ranges, intervals and how they relate. Mirrors backend/app/services/bars_service.py. */
import type { RangeKey, Timeframe } from "../types/api";

export const TIMEFRAMES: Timeframe[] = ["1Min", "5Min", "15Min", "30Min", "1Hour", "4Hour", "1Day", "1Week", "1Month"];

export const TF_LABEL: Record<Timeframe, string> = {
  "1Min": "1 min", "5Min": "5 min", "15Min": "15 min", "30Min": "30 min", "1Hour": "1 hour",
  "4Hour": "4 hour", "1Day": "Daily", "1Week": "Weekly", "1Month": "Monthly",
};

/** What one bar means, shown in the indicator menu ("1 bar = 1 week"). */
export const TF_UNIT: Record<Timeframe, string> = {
  "1Min": "1 minute", "5Min": "5 minutes", "15Min": "15 minutes", "30Min": "30 minutes", "1Hour": "1 hour",
  "4Hour": "4 hours", "1Day": "1 trading day", "1Week": "1 week", "1Month": "1 month",
};

export const RANGE_BUTTONS: { key: Exclude<RangeKey, "CUSTOM">; label: string }[] = [
  { key: "1D", label: "1D" }, { key: "5D", label: "5D" }, { key: "1M", label: "1M" }, { key: "3M", label: "3M" },
  { key: "6M", label: "6M" }, { key: "YTD", label: "YTD" }, { key: "1Y", label: "1Y" }, { key: "5Y", label: "5Y" },
  { key: "MAX", label: "Max" },
];

/** Intervals offered for each range. */
export const RANGE_TFS: Record<RangeKey, Timeframe[]> = {
  "1D": ["1Min", "5Min", "15Min", "30Min", "1Hour"],
  "5D": ["1Min", "5Min", "15Min", "30Min", "1Hour"],
  "1M": ["5Min", "15Min", "30Min", "1Hour", "4Hour", "1Day"],
  "3M": ["1Hour", "4Hour", "1Day", "1Week"],
  "6M": ["1Hour", "4Hour", "1Day", "1Week"],
  "YTD": ["1Hour", "4Hour", "1Day", "1Week"],
  "1Y": ["4Hour", "1Day", "1Week"],
  "5Y": ["1Day", "1Week", "1Month"],
  "MAX": ["1Day", "1Week", "1Month"],
  "CUSTOM": TIMEFRAMES,
};

export const RANGE_DEFAULT_TF: Record<Exclude<RangeKey, "CUSTOM">, Timeframe> = {
  "1D": "1Min", "5D": "5Min", "1M": "1Hour", "3M": "1Day", "6M": "1Day",
  "YTD": "1Day", "1Y": "1Day", "5Y": "1Week", "MAX": "1Week",
};

/** Calendar days of older intraday data requested each time the chart is scrolled past its left edge. */
export const OLDER_STEP_DAYS: Partial<Record<Timeframe, number>> = {
  "1Min": 3, "5Min": 10, "15Min": 20, "30Min": 30, "1Hour": 60, "4Hour": 180,
};

export const isIntraday = (tf: Timeframe) => !["1Day", "1Week", "1Month"].includes(tf);

/** Sensible interval for a custom date span. */
export function customDefaultTf(from: string, to: string): Timeframe {
  const a = new Date(from).getTime();
  const b = to ? new Date(to).getTime() : Date.now();
  const days = (b - a) / 864e5;
  if (days <= 5) return "5Min";
  if (days <= 60) return "1Hour";
  if (days <= 1100) return "1Day";
  return "1Week";
}

/** The interval actually used: the user's pick if valid for the range, else the range default. */
export function effectiveTimeframe(range: RangeKey, picked: Timeframe | null, from: string, to: string): Timeframe {
  if (picked && RANGE_TFS[range].includes(picked)) return picked;
  if (range === "CUSTOM") return customDefaultTf(from, to);
  return RANGE_DEFAULT_TF[range];
}
