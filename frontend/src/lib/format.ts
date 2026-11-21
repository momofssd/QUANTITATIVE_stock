/** Number and date formatting. All times are US Eastern. */
const ET = "America/New_York";

export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function price(v: number | null | undefined, digits?: number): string {
  if (!isNum(v)) return "—";
  const d = digits ?? (Math.abs(v) < 1 ? 4 : 2);
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function signed(v: number | null | undefined, digits = 2): string {
  if (!isNum(v)) return "—";
  return (v > 0 ? "+" : v < 0 ? "−" : "") + price(Math.abs(v), digits);
}

export function pct(v: number | null | undefined): string {
  if (!isNum(v)) return "—";
  return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + "%";
}

export const volume = (v: number | null | undefined) => (isNum(v) ? Math.round(v).toLocaleString("en-US") : "—");

export function compact(v: number | null | undefined): string {
  if (!isNum(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}

/** CSS class for a change value. */
export function dirClass(v: number | null | undefined): "up" | "down" | "flat" {
  if (!isNum(v) || v === 0) return "flat";
  return v > 0 ? "up" : "down";
}

/** ISO timestamp -> "11/20/2026 3:59:12 PM ET". */
export function etDateTime(iso: string | null | undefined, withSeconds = true): string {
  if (!iso) return "—";
  const s = new Date(iso).toLocaleString("en-US", {
    timeZone: ET, month: "2-digit", day: "2-digit", year: "numeric",
    hour: "numeric", minute: "2-digit", ...(withSeconds ? { second: "2-digit" } : {}),
  });
  return s.replace(",", "") + " ET";
}

/** ISO timestamp -> "Mon 9:30 AM". */
export const etWeekdayTime = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: ET, weekday: "short", hour: "numeric", minute: "2-digit" });

/** Chart time (ET wall-clock epoch, rendered as UTC) -> "11/20/2026" or "11/20/2026 3:59 PM". */
export function barTime(t: number, intraday: boolean): string {
  const d = new Date(t * 1000);
  const date = d.toLocaleDateString("en-US", { timeZone: "UTC", month: "2-digit", day: "2-digit", year: "numeric" });
  if (!intraday) return date;
  return `${date} ${d.toLocaleTimeString("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" })}`;
}

/** Chart time -> "2026-11-20" or "2026-11-20 15:59" (CSV). */
export function barTimeISO(t: number, intraday: boolean): string {
  const s = new Date(t * 1000).toISOString();
  return intraday ? s.slice(0, 16).replace("T", " ") : s.slice(0, 10);
}

const etParts = new Intl.DateTimeFormat("en-US", {
  timeZone: ET, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

/** ISO timestamp -> epoch seconds of the New York wall-clock time (the chart's time encoding). */
export function etEpoch(iso: string): number {
  const p = Object.fromEntries(etParts.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000;
}

export const yesNo = (v: boolean | null | undefined) => (v === true ? "Yes" : v === false ? "No" : "—");
