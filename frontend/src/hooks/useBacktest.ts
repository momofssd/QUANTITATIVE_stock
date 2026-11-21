/**
 * Backtest scenarios on the current training (run_id of the analysis result): the user's settings (remembered),
 * a debounced request whenever they or the training change, superseded requests aborted.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { load, save } from "../lib/storage";
import { api, isAbort, type ApiError } from "../services/api";
import type { BacktestResult, BacktestSetups, SimSizing } from "../types/api";

export type SellRule = "sell_only" | "with_bracket";

export interface BacktestSettings {
  n: number;              // most recent BUY decisions (1-100)
  setups: BacktestSetups; // rebound / trend / both
  minProb: number;        // buy when P >= this, in % (0-100)
  sizing: SimSizing;      // $100 or 1 share per BUY
  sell: SellRule;         // sell rule shown
}

export const DEFAULT_BACKTEST: BacktestSettings = { n: 30, setups: "both", minProb: 60, sizing: "usd", sell: "sell_only" };
export const N_RANGE: [number, number] = [1, 100];
const DEBOUNCE_MS = 250;

export const validN = (n: number) => Number.isInteger(n) && n >= N_RANGE[0] && n <= N_RANGE[1];
export const validProb = (p: number) => Number.isFinite(p) && p >= 0 && p <= 100;

export function useBacktest(runId: string | null, onError: (e: ApiError) => void) {
  const [settings, setSettingsState] = useState<BacktestSettings>(
    () => ({ ...DEFAULT_BACKTEST, ...load<Partial<BacktestSettings>>("backtest", {}) }));
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  const setSettings = useCallback((patch: Partial<BacktestSettings>) => {
    setSettingsState((s) => {
      const next = { ...s, ...patch };
      save("backtest", next);
      return next;
    });
  }, []);

  const { n, setups, minProb, sizing } = settings;
  useEffect(() => {
    if (!runId) {
      setResult(null);
      return;
    }
    if (!validN(n) || !validProb(minProb)) return;
    const id = window.setTimeout(async () => {
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      setLoading(true);
      setError(null);
      try {
        setResult(await api.backtest(runId, { n, setups, min_prob: minProb / 100, sizing }, c.signal));
      } catch (e) {
        if (isAbort(e)) return;
        const err = e as ApiError;
        setResult(null);
        setError(err.message);
        if (err.status !== 404) onError(err);
      } finally {
        if (ctrl.current === c) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [runId, n, setups, minProb, sizing, onError]);

  return { settings, setSettings, result, loading, error };
}
