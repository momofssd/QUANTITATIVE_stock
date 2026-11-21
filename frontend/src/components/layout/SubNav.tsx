/** Secondary tabs (per page) plus the market open/closed indicator. */
import type { Page } from "../../hooks/useRoute";
import { etWeekdayTime } from "../../lib/format";
import type { Clock } from "../../types/api";

export function SubNav({ page, clock }: { page: Page; clock: Clock | null }) {
  const status = clock
    ? clock.is_open
      ? `Market Open · closes ${etWeekdayTime(clock.next_close)} ET`
      : `Market Closed · opens ${etWeekdayTime(clock.next_open)} ET`
    : "Market status…";
  return (
    <div className="sub-nav">
      <div className="wrap sub-row">
        {page === "chart" ? (
          <>
            <a href="#/" className="active">Quote &amp; Chart</a>
            <a href="#hist">Historical Data</a>
          </>
        ) : (
          <>
            <a href="#/">Quote &amp; Chart</a>
            <a href="#/backtests" className="active">Backtest scenarios</a>
          </>
        )}
        <span className="spacer" />
        <span className={`mkt-status ${clock ? (clock.is_open ? "open" : "closed") : ""}`}>
          <i className="dot" /><span>{status}</span>
        </span>
      </div>
    </div>
  );
}
