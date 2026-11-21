/** Paged OHLCV table of the loaded bars (newest first) with CSV export. */
import { memo, useEffect, useState } from "react";
import { TF_LABEL } from "../../config/timeframes";
import { downloadBarsCsv } from "../../lib/csv";
import { barTime, dirClass, pct, price, signed, volume } from "../../lib/format";
import type { BarColumns, BarsPayload } from "../../types/api";

const PAGE_SIZE = 25;

interface Props {
  payload: BarsPayload | null;
  /** Bumped when live ticks mutate the loaded columns, so the table re-reads them. */
  version: number;
  /** Changes on every new view (fit load): go back to the first page. */
  resetKey: string;
}

export const HistoryTable = memo(function HistoryTable({ payload, resetKey }: Props) {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [resetKey]);

  const d = payload?.columns.time ? (payload.columns as BarColumns) : null;
  const n = d ? d.time.length : 0;
  const intraday = !!payload?.intraday;
  const pages = Math.max(1, Math.ceil(n / PAGE_SIZE));
  const pg = Math.min(page, pages - 1);

  const rows = [];
  if (d) {
    const start = n - 1 - pg * PAGE_SIZE;
    for (let i = start; i > start - PAGE_SIZE && i >= 0; i--) {
      const prev = i > 0 ? d.close[i - 1] : null;
      const chg = prev !== null ? d.close[i] - prev : null;
      const chgPct = prev ? (chg! / prev) * 100 : null;
      const cls = dirClass(chg);
      rows.push(
        <tr key={d.time[i]}>
          <td className="l">{barTime(d.time[i], intraday)}</td>
          <td>{price(d.open[i])}</td><td>{price(d.high[i])}</td><td>{price(d.low[i])}</td>
          <td><b>{price(d.close[i])}</b></td>
          <td className={cls}>{signed(chg)}</td><td className={cls}>{pct(chgPct)}</td>
          <td>{volume(d.volume[i])}</td><td>{price(d.bar_vwap[i])}</td>
        </tr>,
      );
    }
  }
  const first = pg * PAGE_SIZE + 1;
  const last = Math.min(n, first + PAGE_SIZE - 1);

  return (
    <section className="card hist-card" id="hist">
      <div className="card-title">
        <h2>Historical Data <small>{n && payload ? `${payload.symbol} · ${TF_LABEL[payload.timeframe]} · newest first` : ""}</small></h2>
        <div className="ct-right">
          <button className="btn btn-ghost" disabled={!n} onClick={() => payload && downloadBarsCsv(payload)}>Download CSV</button>
        </div>
      </div>
      <div className="table-scroll">
        <table className="grid">
          <thead>
            <tr>
              <th className="l">{intraday ? "Date / Time (ET)" : "Date"}</th><th>Open</th><th>High</th><th>Low</th><th>Close</th>
              <th>Change</th><th>Change %</th><th>Volume</th><th>VWAP</th>
            </tr>
          </thead>
          <tbody>{n ? rows : <tr><td className="empty" colSpan={9}>No data</td></tr>}</tbody>
        </table>
      </div>
      <div className="pager">
        <span>{n ? `Showing ${first.toLocaleString()}–${last.toLocaleString()} of ${n.toLocaleString()} bars` : ""}</span>
        <div>
          <button className="btn btn-ghost" disabled={pg === 0} onClick={() => setPage(pg - 1)}>&lsaquo; Prev</button>
          <button className="btn btn-ghost" disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>Next &rsaquo;</button>
        </div>
      </div>
    </section>
  );
});
