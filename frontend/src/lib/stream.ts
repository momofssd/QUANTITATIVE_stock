/** How a live-stream state is presented (badge style, badge text, Data Source row text). */
import type { StreamStatus } from "../types/api";

export interface StreamView {
  tone: "" | "wait" | "err" | "idle";
  badge: string;
  detail: string;
}

export function streamView(s: StreamStatus, marketOpen: boolean): StreamView {
  const feed = (s.feed || "").toUpperCase();
  switch (s.state) {
    case "live": return { tone: "", badge: marketOpen ? "LIVE" : "LIVE · MARKET CLOSED", detail: `Connected · ${feed} stream` };
    case "connecting": return { tone: "wait", badge: "CONNECTING", detail: "Connecting…" };
    case "reconnecting":
    case "offline": return { tone: "wait", badge: "RECONNECTING", detail: s.detail };
    case "limit": return { tone: "err", badge: "STREAM BUSY", detail: s.detail };
    case "error": return { tone: "err", badge: "STREAM OFF", detail: s.detail };
    default: return { tone: "idle", badge: "STREAM OFF", detail: "Not connected" };
  }
}
