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
  nCustom: number | null; // most recent BUY decisions (1-100); null = all available (default, max 100)
  setups: BacktestSetups; // rebound / trend / both
  minProb: number | null;     // BUY when P >= this, in % (0-100); null = the model's own threshold (default)
  sellMinProb: number | null; // SELL when P >= this, in %; null = the model's own threshold (default)
  sizing: SimSizing;      // $100 or 1 share per BUY
  sell: SellRule;         // sell rule shown
  maxShares: number | null; // sell-signal strategy: most shares held at once; null = no limit (default)
}

export const DEFAULT_BACKTEST: BacktestSettings = {
  nCustom: null, setups: "both", minProb: null, sellMinProb: null, sizing: "usd", sell: "sell_only", maxShares: null,
};
export const MAX_SHARES_LIMIT = 1_000_000;
export const validMaxShares = (v: number | null) =>
  v === null || (Number.isFinite(v) && v > 0 && v <= MAX_SHARES_LIMIT);
export const N_RANGE: [number, number] = [1, 100];
const DEBOUNCE_MS = 250;

export const validN = (n: number) => Number.isInteger(n) && n >= N_RANGE[0] && n <= N_RANGE[1];
export const validProb = (p: number | null) => p === null || (Number.isFinite(p) && p >= 0 && p <= 100);

export function useBacktest(runId: string | null, onError: (e: ApiError) => void) {
  const [settings, setSettingsState] = useState<BacktestSettings>(
    () => {
      const { n: _old, ...saved } = load<Partial<BacktestSettings> & { n?: number }>("backtest", {});
      const s = { ...DEFAULT_BACKTEST, ...saved };   // an old fixed count ("n") starts as "all available"
      // 60% was the old fixed default, not a user choice: use the model's threshold instead
      return s.minProb === 60 ? { ...s, minProb: null } : s;
    });
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

  const { nCustom, setups, minProb, sellMinProb, sizing, maxShares } = settings;
  const n = nCustom ?? N_RANGE[1];   // all available = the most recent 100 at most
  useEffect(() => {
    if (!runId) {
      setResult(null);
      return;
    }
    if (!validN(n) || !validProb(minProb) || !validProb(sellMinProb) || !validMaxShares(maxShares)) return;
    const id = window.setTimeout(async () => {
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      setLoading(true);
      setError(null);
      try {
        setResult(await api.backtest(runId, {
          n, setups, sizing,
          min_prob: minProb === null ? undefined : minProb / 100,
          sell_min_prob: sellMinProb === null ? undefined : sellMinProb / 100,
          max_shares: maxShares ?? undefined,
        }, c.signal));
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
  }, [runId, n, setups, minProb, sellMinProb, sizing, maxShares, onError]);

  return { settings, setSettings, result, loading, error };
}
