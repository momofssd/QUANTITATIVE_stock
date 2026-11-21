/** Badge next to the price: LIVE / CONNECTING / RECONNECTING / STREAM BUSY / STREAM OFF. */
import { streamView } from "../../lib/stream";
import type { StreamStatus } from "../../types/api";

export function LivePill({ status, marketOpen }: { status: StreamStatus; marketOpen: boolean }) {
  const v = streamView(status, marketOpen);
  return (
    <span className={`live-pill ${v.tone}`} title={status.detail || ""}>
      <i />{v.badge}
    </span>
  );
}
