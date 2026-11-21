/**
 * Chart bars for the current settings, with four load modes:
 *   fit     - new view (symbol / range / interval / dates / extended changed): spinner, jump to range start
 *   replace - indicator lengths changed: redraw values, keep the view
 *   silent  - live refresh (polling or a closed minute bar): update the tail quietly
 *   older   - chart scrolled past its left edge: prepend older intraday history
 * Stale responses (settings changed meanwhile) are dropped; a new load aborts the previous request.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { paramQuery, type IndicatorParams } from "../config/indicators";
import { OLDER_STEP_DAYS, TF_LABEL } from "../config/timeframes";
import { api, isAbort, type ApiError } from "../services/api";
import type { BarsPayload, RangeKey, Timeframe } from "../types/api";

export interface BarsInputs {
  symbol: string;
  range: RangeKey;
  timeframe: Timeframe;
  from: string;
  to: string;
  extended: boolean;
  params: IndicatorParams;
}

export type LoadMode = "fit" | "replace" | "silent" | "older";

export interface BarsState {
  payload: BarsPayload;
  key: string;        // identity of the series (symbol|range|tf|extended|dates)
  mode: LoadMode;     // how it was loaded -> how the chart applies it
  seq: number;        // increments on every applied load
}

export type ChartOverlay =
  | { kind: "loading"; text: string }
  | { kind: "message"; text: string; sub?: string }
  | null;

const seriesKey = (i: BarsInputs) => [i.symbol, i.range, i.timeframe, i.extended, i.from, i.to].join("|");
const requestKey = (i: BarsInputs) => seriesKey(i) + "|" + JSON.stringify(i.params);

export function isLiveRange(range: RangeKey, to: string): boolean {
  return range !== "CUSTOM" || !to || to >= new Date().toISOString().slice(0, 10);
}

export function useBars(inputs: BarsInputs, enabled: boolean, onError: (e: ApiError) => void) {
  const [bars, setBars] = useState<BarsState | null>(null);
  const [overlay, setOverlay] = useState<ChartOverlay>(null);
  const [busyNote, setBusyNote] = useState<string | null>(null);

  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  const barsRef = useRef<BarsState | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  const loadingRef = useRef(false);
  const inflightMode = useRef<LoadMode | null>(null);
  const loadFromRef = useRef<string | null>(null);
  const lastLoadAt = useRef(0);
  const seqRef = useRef(0);

  const load = useCallback(async (requested: LoadMode) => {
    if ((requested === "silent" || requested === "older") && loadingRef.current) return;
    // Lengths changed while a new view is still loading: the replacement must still be a new view.
    const mode: LoadMode = requested === "replace" && inflightMode.current === "fit" ? "fit" : requested;
    inflightMode.current = mode;
    if (mode === "fit") loadFromRef.current = null;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    loadingRef.current = true;

    const inp = inputsRef.current;
    const key = seriesKey(inp);
    const rkey = requestKey(inp);
    if (mode === "older") setBusyNote("Loading older bars…");
    else if (mode === "replace") setBusyNote("Updating indicators…");
    else if (mode === "fit") setOverlay({ kind: "loading", text: `Loading ${inp.symbol} · ${TF_LABEL[inp.timeframe]}…` });

    try {
      const payload = await api.bars(inp.symbol, {
        range: inp.range, timeframe: inp.timeframe, extended: inp.extended || undefined,
        ...(inp.range === "CUSTOM" ? { start: inp.from, end: inp.to || undefined } : {}),
        ...(loadFromRef.current ? { load_from: loadFromRef.current } : {}),
        ...paramQuery(inp.params),
      }, ctrl.signal);
      if (rkey !== requestKey(inputsRef.current)) return; // settings changed while loading
      const next: BarsState = { payload, key, mode, seq: ++seqRef.current };
      barsRef.current = next;
      setBars(next);
      setOverlay(payload.count ? null : {
        kind: "message", text: `No bars returned for ${inp.symbol} in this range.`,
        sub: "Try a longer range or enable extended hours.",
      });
    } catch (e) {
      if (isAbort(e)) return;
      if (mode === "fit") {
        setOverlay({ kind: "message", text: (e as Error).message });
        onError(e as ApiError);
      } else if (mode === "replace") {
        onError(e as ApiError);
      }
    } finally {
      lastLoadAt.current = Date.now();
      if (ctrlRef.current === ctrl) {
        loadingRef.current = false;
        inflightMode.current = null;
        ctrlRef.current = null;
        setBusyNote(null);
      }
    }
  }, [onError]);

  /** Scroll-back: ask for `step` more calendar days before the oldest loaded bar. */
  const loadOlder = useCallback(() => {
    const b = barsRef.current?.payload;
    if (!b || !b.has_more || loadingRef.current || !b.columns.time) return;
    const first = new Date(b.columns.time[0] * 1000); // ET wall-clock encoded as UTC
    first.setUTCDate(first.getUTCDate() - (OLDER_STEP_DAYS[b.timeframe] ?? 30));
    loadFromRef.current = first.toISOString().slice(0, 10);
    void load("older");
  }, [load]);

  // Decide how to reload when inputs change: a new series -> fit; only lengths changed -> replace.
  const key = seriesKey(inputs);
  const paramsSig = JSON.stringify(inputs.params);
  const prev = useRef<{ key: string; paramsSig: string } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const p = prev.current;
    prev.current = { key, paramsSig };
    if (!p || p.key !== key) void load("fit");
    else if (p.paramsSig !== paramsSig) void load("replace");
  }, [enabled, key, paramsSig, load]);

  useEffect(() => () => ctrlRef.current?.abort(), []);

  return { bars, overlay, busyNote, load, loadOlder, lastLoadAt };
}
