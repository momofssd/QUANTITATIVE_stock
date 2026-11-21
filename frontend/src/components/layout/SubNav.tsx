/** Secondary tabs plus the market open/closed indicator. */
import { etWeekdayTime } from "../../lib/format";
import type { Clock } from "../../types/api";

export function SubNav({ clock }: { clock: Clock | null }) {
  const status = clock
    ? clock.is_open
      ? `Market Open · closes ${etWeekdayTime(clock.next_close)} ET`
      : `Market Closed · opens ${etWeekdayTime(clock.next_open)} ET`
    : "Market status…";
  return (
    <div className="sub-nav">
      <div className="wrap sub-row">
        <a href="#" className="active">Quote &amp; Chart</a>
        <a href="#hist">Historical Data</a>
        <a href="#" className="muted" title="Coming later">Signals</a>
        <a href="#" className="muted" title="Coming later">Model</a>
        <span className="spacer" />
        <span className={`mkt-status ${clock ? (clock.is_open ? "open" : "closed") : ""}`}>
          <i className="dot" /><span>{status}</span>
        </span>
      </div>
    </div>
  );
}
