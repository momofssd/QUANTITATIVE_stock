/**
 * Entry / take-profit analysis for the chart as it is shown (symbol, range, interval, extended hours) plus the
 * short-term profit-take / stop-loss multiples. run() always retrains on the server. The result is cleared when
 * the symbol changes; when the interval changes it is kept but flagged stale (its markers belong to other bars).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MarkerVisibility } from "../chart/markers";
import { load, save } from "../lib/storage";
import { api, isAbort, type AnalysisQuery, type ApiError } from "../services/api";
import type { AnalysisResult } from "../types/api";

export interface AnalysisInputs extends AnalysisQuery {
  symbol: string;
}

export interface Bracket {
  tp: number; // profit-take, x daily ATR
  sl: number; // stop-loss, x daily ATR
}

export const DEFAULT_BRACKET: Bracket = { tp: 1.5, sl: 1.0 };

export function useAnalysis(symbol: string, onError: (e: ApiError) => void) {
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [bracket, setBracketState] = useState<Bracket>(() => load("bracket", DEFAULT_BRACKET));
  const [visible, setVisible] = useState<MarkerVisibility>({
    short: true, long: true, tp_short: true, tp_long: true, exits: true, cost: true,
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

  const run = useCallback(async ({ symbol: sym, ...query }: AnalysisInputs, b: Bracket) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setLoading(true);
    setStartedAt(Date.now());
    try {
      const r = await api.analysis(sym, { ...query, tp_atr: b.tp, sl_atr: b.sl, refresh: true }, c.signal);
      setResult(r);
      // Entries (S / L) and the cost lines are always drawn; take-profit markers only where that model is reliable.
      setVisible({
        short: true, long: true, exits: true, cost: true,
        tp_short: r.targets.tp_short.stats.reliable, tp_long: r.targets.tp_long.stats.reliable,
      });
    } catch (e) {
      if (!isAbort(e)) onError(e as ApiError);
    } finally {
      if (ctrl.current === c) setLoading(false);
    }
  }, [onError]);

  const toggle = useCallback((key: keyof MarkerVisibility, on: boolean) => setVisible((v) => ({ ...v, [key]: on })), []);

  return { result, loading, startedAt, visible, bracket, setBracket, run, clear, toggle };
}

export type AnalysisApi = ReturnType<typeof useAnalysis>;
