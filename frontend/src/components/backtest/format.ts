/** Formatting shared by the Backtests page and its decision logs. */
import type { SimSizing } from "../../types/api";

/** Shares: whole shares with "1 share per BUY", fractional with "$100 per BUY". */
export const shares = (v: number, sizing: SimSizing) =>
  sizing === "share" ? v.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : v.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 });

export const money = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const signedPct = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`;

/** A share cap as typed ("10", "2.5"). */
export const capText = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 3 });
