/** Quote for the current symbol: REST load + live tick/quote updates merged in. */
import { useCallback, useEffect, useRef, useState } from "react";
import { isNum } from "../lib/format";
import { api, type ApiError } from "../services/api";
import type { Quote, QuoteMessage, TickMessage } from "../types/api";

export function useQuote(symbol: string, enabled: boolean, onError: (e: ApiError) => void, onOk: () => void) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const lastLoadAt = useRef(0);
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;

  const refresh = useCallback(async (silent = false) => {
    const sym = symbolRef.current;
    try {
      const q = await api.quote(sym);
      if (sym !== symbolRef.current) return;
      setQuote(q);
      if (!silent) onOk();
    } catch (e) {
      if (sym === symbolRef.current && !silent) onError(e as ApiError);
    } finally {
      lastLoadAt.current = Date.now();
    }
  }, [onError, onOk]);

  useEffect(() => {
    setQuote(null);
    if (enabled) void refresh();
  }, [symbol, enabled, refresh]);

  /** A coalesced live trade: last price + high/low within the window. */
  const applyTick = useCallback((m: TickMessage) => {
    setQuote((q) => {
      if (!q || m.S !== q.symbol) return q;
      const next = { ...q, price: m.p, trade_time: m.t };
      if (isNum(q.high)) next.high = Math.max(q.high, m.hi);
      if (isNum(q.low)) next.low = Math.min(q.low, m.lo);
      if (isNum(q.prev_close) && q.prev_close) {
        next.change = m.p - q.prev_close;
        next.change_pct = (next.change / q.prev_close) * 100;
      }
      return next;
    });
  }, []);

  const applyLiveQuote = useCallback((m: QuoteMessage) => {
    setQuote((q) => (q && m.S === q.symbol
      ? { ...q, bid: m.bp, bid_size: m.bs, ask: m.ap, ask_size: m.as, quote_time: m.t }
      : q));
  }, []);

  return { quote, refresh, applyTick, applyLiveQuote, lastLoadAt };
}
