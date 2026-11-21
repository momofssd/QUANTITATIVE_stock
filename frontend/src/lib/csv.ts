/** Export the loaded bars (with indicator columns named by their lengths) as CSV. */
import type { BarColumns, BarsPayload } from "../types/api";
import { barTimeISO } from "./format";

function columnNames(p: BarsPayload["params"]): Record<string, string> {
  return {
    sma1: `sma_${p.sma[0]}`, sma2: `sma_${p.sma[1]}`, sma3: `sma_${p.sma[2]}`,
    ema1: `ema_${p.ema[0]}`, ema2: `ema_${p.ema[1]}`,
    bb_mid: `bb${p.bb_len}_mid`, bb_upper: `bb${p.bb_len}_upper`, bb_lower: `bb${p.bb_len}_lower`,
    rsi: `rsi_${p.rsi}`, macd: `macd_${p.macd[0]}_${p.macd[1]}`, macd_signal: `macd_signal_${p.macd[2]}`,
    macd_hist: "macd_hist",
  };
}

export function barsToCsv(b: BarsPayload): string {
  const d = b.columns as BarColumns;
  const cols = Object.keys(d).filter((c) => c !== "time");
  const names = columnNames(b.params);
  const lines = [["datetime_et", ...cols.map((c) => names[c] ?? c)].join(",")];
  for (let i = 0; i < d.time.length; i++) {
    lines.push([barTimeISO(d.time[i], b.intraday), ...cols.map((c) => d[c][i] ?? "")].join(","));
  }
  return lines.join("\n");
}

export function downloadBarsCsv(b: BarsPayload): void {
  const blob = new Blob([barsToCsv(b)], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${b.symbol}_${b.range}_${b.timeframe}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
