/** Which bar a live trade belongs to. Times are ET wall-clock epochs (the chart's encoding). */
import type { Timeframe } from "../types/api";

const DAY = 86400;
const MINUTES: Partial<Record<Timeframe, number>> = { "1Min": 1, "5Min": 5, "15Min": 15, "30Min": 30, "1Hour": 60, "4Hour": 240 };

/**
 * Start time of the bar containing `t`, aligned like Alpaca's bars.
 * Intraday buckets are stepped from the last known bar so they stay aligned with the server's series.
 * Returns null when `t` is older than the last bar.
 */
export function bucketFor(t: number, last: number, tf: Timeframe): number | null {
  const minutes = MINUTES[tf];
  if (minutes) {
    const sec = minutes * 60;
    if (t < last) return null;
    return last + Math.floor((t - last) / sec) * sec;
  }
  const day = Math.floor(t / DAY);
  if (tf === "1Day") return day * DAY;
  if (tf === "1Week") return (day - ((day + 3) % 7)) * DAY; // Monday (1970-01-01 was a Thursday)
  if (tf === "1Month") {
    const d = new Date(t * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  }
  return null;
}

/** Is an ET wall-clock time inside the regular session (9:30-16:00)? */
export function inRegularSession(t: number): boolean {
  const mins = (((t % DAY) + DAY) % DAY) / 60;
  return mins >= 570 && mins < 960;
}
