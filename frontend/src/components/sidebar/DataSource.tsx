/** Provider, feed, live-stream state, account type, next market open/close. */
import { feedDescription } from "../../config/feeds";
import { etDateTime } from "../../lib/format";
import { streamView } from "../../lib/stream";
import type { Clock, Health, Quote, StreamStatus } from "../../types/api";

interface Props {
  quote: Quote | null;
  health: Health | null;
  clock: Clock | null;
  stream: StreamStatus;
}

export function DataSource({ quote, health, clock, stream }: Props) {
  const rows: [string, string][] = [
    ["Provider", "Alpaca Market Data"],
    ["Feed", feedDescription(quote?.feed ?? health?.feed)],
    ["Live stream", streamView(stream, !!clock?.is_open).detail || "—"],
    ["Account", health?.configured ? (health.account === "paper" ? "Paper" : "Live") : "—"],
    ["Next open", clock ? etDateTime(clock.next_open, false) : "—"],
    ["Next close", clock ? etDateTime(clock.next_close, false) : "—"],
  ];
  return (
    <section className="card">
      <div className="card-title"><h2>Data Source</h2></div>
      <table className="kv">
        <tbody>{rows.map(([k, v]) => <tr key={k}><th>{k}</th><td>{v}</td></tr>)}</tbody>
      </table>
    </section>
  );
}
