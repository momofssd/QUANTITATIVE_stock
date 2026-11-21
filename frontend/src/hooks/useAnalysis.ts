/**
 * Entry / take-profit analysis for the chart as it is shown (symbol, range, interval, extended hours) plus the
 * short-term profit-take / stop-loss multiples. run() always retrains on the server. The result is cleared when
 * the symbol changes; when the interval changes it is kept but flagged stale (its markers belong to other bars).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MarkerVisibility } from "../chart/markers";
import { load, save } from "../lib/storage";
import { api, isAbort, type AnalysisQuery, type ApiError } from "../services/api";
import type { AnalysisResult, IntradayCheck } from "../types/api";

export interface AnalysisInputs extends AnalysisQuery {
  symbol: string;
}

export interface Bracket {
  tp: number; // profit-take, x daily ATR
  sl: number; // stop-loss, x daily ATR
}

export const DEFAULT_BRACKET: Bracket = { tp: 1.5, sl: 1.0 };
const INTRADAY_REFRESH_MS = 60_000;

export function useAnalysis(symbol: string, onError: (e: ApiError) => void) {
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [query, setQuery] = useState<AnalysisInputs | null>(null); // what `result` was trained on
  const [loading, setLoading] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [bracket, setBracketState] = useState<Bracket>(() => load("bracket", DEFAULT_BRACKET));
  const [visible, setVisible] = useState<MarkerVisibility>({
    short: true, tp_short: true, exits: true,
  });
  const ctrl = useRef<AbortController | null>(null);

  const clear = useCallback(() => {
    ctrl.current?.abort();
    setResult(null);
    setLoading(false);
  }, []);

  useEffect(() => clear, [symbol, clear]); // new symbol: drop the old result (and abort a running request)

  const setBracket = useCallback((b: Bracket) => {
    setBracketState(b);
    save("bracket", b);
  }, []);

  const run = useCallback(async (inputs: AnalysisInputs, b: Bracket) => {
    const { symbol: sym, ...query } = inputs;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setLoading(true);
    setStartedAt(Date.now());
    try {
      const r = await api.analysis(sym, { ...query, tp_atr: b.tp, sl_atr: b.sl, refresh: true }, c.signal);
      setResult(r);
      setQuery(inputs);
      // BUY markers are always drawn; SELL markers only where the take-profit model proved reliable.
      setVisible({ short: true, exits: true, tp_short: r.targets.tp_short.stats.reliable });
    } catch (e) {
      if (!isAbort(e)) onError(e as ApiError);
    } finally {
      if (ctrl.current === c) setLoading(false);
    }
  }, [onError]);

  const toggle = useCallback((key: keyof MarkerVisibility, on: boolean) => setVisible((v) => ({ ...v, [key]: on })), []);

  // The current K line is live: refresh today's 5-minute check every minute while results are shown.
  const [intraday, setIntraday] = useState<IntradayCheck | null>(null);
  useEffect(() => setIntraday(result?.intraday_check ?? null), [result]);
  useEffect(() => {
    if (!result) return;
    const sym = result.symbol;
    const id = window.setInterval(async () => {
      if (document.hidden) return;
      try {
        setIntraday(await api.intraday(sym));
      } catch {
        /* keep the last check */
      }
    }, INTRADAY_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [result]);

  return { result, query, loading, startedAt, visible, bracket, setBracket, run, clear, toggle, intraday };
}

export type AnalysisApi = ReturnType<typeof useAnalysis>;
