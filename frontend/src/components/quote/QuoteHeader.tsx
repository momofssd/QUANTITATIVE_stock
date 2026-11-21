/** Name, last price (flashes on change), change, as-of time, bid/ask/volume box. */
import { useEffect, useRef, useState } from "react";
import { feedName, liveSource } from "../../config/feeds";
import { compact, dirClass, etDateTime, isNum, pct, price, signed } from "../../lib/format";
import type { Quote, StreamStatus } from "../../types/api";
import { LivePill } from "./LivePill";

interface Props {
  symbol: string;
  quote: Quote | null;
  stream: StreamStatus;
  marketOpen: boolean;
}

/** A zero price means no bid/offer on the book (common after hours on IEX). */
const side = (px: number | null, size: number | null): [string, string] =>
  px && px > 0 ? [price(px), isNum(size) ? `× ${size}` : ""] : ["—", ""];

function usePriceFlash(value: number | null | undefined): string {
  const prev = useRef<number | null | undefined>(value);
  const [flash, setFlash] = useState("");
  useEffect(() => {
    if (isNum(prev.current) && isNum(value) && value !== prev.current) {
      setFlash(value > prev.current ? "flash-up" : "flash-down");
      const id = window.setTimeout(() => setFlash(""), 700);
      prev.current = value;
      return () => window.clearTimeout(id);
    }
    prev.current = value;
  }, [value]);
  return flash;
}

export function QuoteHeader({ symbol, quote: q, stream, marketOpen }: Props) {
  const flash = usePriceFlash(q?.price);

  useEffect(() => {
    document.title = q ? `${q.symbol} ${price(q.price)} · Quote & Chart` : "Quote & Chart · Quant Trading Model";
  }, [q]);

  const arrow = q && isNum(q.change) ? (q.change > 0 ? "▲" : q.change < 0 ? "▼" : "") : "";
  const how = stream.state === "live" ? `${liveSource(q?.feed)} stream` : liveSource(q?.feed);
  const [bid, bidSize] = side(q?.bid ?? null, q?.bid_size ?? null);
  const [ask, askSize] = side(q?.ask ?? null, q?.ask_size ?? null);

  return (
    <section className="quote-head" aria-live="polite">
      <div className="qh-left">
        <div className="crumbs">Research &rsaquo; Stocks &rsaquo; <span>{symbol}</span></div>
        <h1>{q?.name || symbol} <span className="sym">({symbol})</span></h1>
        <div className="qh-meta">
          <span>{q?.exchange || "—"}</span> <span className="sep">|</span>{" "}
          <span>{q?.asset_class === "us_equity" ? "US Equity" : q?.asset_class || "—"}</span>
        </div>
        <div className="price-row">
          <span className={`last ${flash}`}>{q && isNum(q.price) ? "$" + price(q.price) : "—"}</span>
          <span className={`chg ${dirClass(q?.change)}`}>
            {q && isNum(q.change) ? `${arrow} ${signed(q.change)} (${pct(q.change_pct)})` : "—"}
          </span>
          <LivePill status={stream} marketOpen={marketOpen} />
        </div>
        <div className="asof">
          {q ? (q.trade_time ? `As of ${etDateTime(q.trade_time)} · Real-time (${how})` : "—") : "Loading…"}
        </div>
      </div>
      <div className="qh-right">
        <div className="bidask">
          <div><label>Bid</label><b>{bid}</b><small>{bidSize}</small></div>
          <div><label>Ask</label><b>{ask}</b><small>{askSize}</small></div>
          <div><label>Volume</label><b>{compact(q?.volume)}</b><small>{feedName(q?.feed)}</small></div>
        </div>
      </div>
    </section>
  );
}
