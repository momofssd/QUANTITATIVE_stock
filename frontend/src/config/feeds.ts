/** Display names for data feeds. */
import type { FeedLabel } from "../types/api";

const SHORT: Record<string, string> = { iex: "IEX", sip: "SIP", "sip+iex": "SIP + IEX live" };
const LONG: Record<string, string> = {
  iex: "IEX (real-time)", sip: "SIP (consolidated)", "sip+iex": "SIP history + IEX live",
};

export const feedName = (f?: FeedLabel | string | null) => (f ? SHORT[f] ?? f.toUpperCase() : "");
export const feedDescription = (f?: FeedLabel | string | null) => (f ? LONG[f] ?? f : "—");
/** Which feed real-time prices come from. */
export const liveSource = (f?: FeedLabel | string | null) => (f === "sip" ? "SIP" : "IEX");
