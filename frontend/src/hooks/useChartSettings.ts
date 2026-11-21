/**
 * Everything the user chooses about the chart: symbol, range, interval, custom dates, chart type, extended hours,
 * which indicators are on, and per-interval indicator lengths. Persisted to the URL and localStorage.
 */
import { useCallback, useEffect, useMemo, useReducer } from "react";
import {
  cloneParams, DEFAULT_ENABLED, LEGACY_KEYS, PRESETS,
  type IndicatorKey, type IndicatorParams,
} from "../config/indicators";
import { effectiveTimeframe, RANGE_TFS } from "../config/timeframes";
import { load, save } from "../lib/storage";
import type { ChartType } from "../chart/ChartEngine";
import type { RangeKey, Timeframe } from "../types/api";

/** Ticker shown when the URL does not name one (?symbol=...). */
export const DEFAULT_SYMBOL = "SPY";

export interface ChartSettingsState {
  symbol: string;
  range: RangeKey;
  picked: Timeframe | null; // interval chosen by the user (null = range default)
  from: string;
  to: string;
  chartType: ChartType;
  extended: boolean;
  enabled: IndicatorKey[];
  overrides: Partial<Record<Timeframe, IndicatorParams>>;
}

type Action =
  | { type: "symbol"; symbol: string }
  | { type: "range"; range: Exclude<RangeKey, "CUSTOM"> }
  | { type: "custom"; from: string; to: string }
  | { type: "timeframe"; tf: Timeframe }
  | { type: "chartType"; chartType: ChartType }
  | { type: "extended"; extended: boolean }
  | { type: "toggle"; key: IndicatorKey; on: boolean }
  | { type: "allOff" }
  | { type: "params"; tf: Timeframe; params: IndicatorParams }
  | { type: "resetParams"; tf: Timeframe };

function initial(): ChartSettingsState {
  const url = new URLSearchParams(location.search);
  let range = (url.get("range") || load<string>("range", "1D")).toUpperCase() as RangeKey;
  const from = url.get("from") || "";
  if (!RANGE_TFS[range] || (range === "CUSTOM" && !from)) range = "1D";
  return {
    symbol: (url.get("symbol") || DEFAULT_SYMBOL).toUpperCase(),
    range,
    picked: (url.get("tf") as Timeframe) || null,
    from,
    to: url.get("to") || "",
    chartType: load<ChartType>("type", "candles"),
    extended: load("extended", false),
    enabled: [...new Set(load<string[]>("indicators", DEFAULT_ENABLED).map((k) => LEGACY_KEYS[k] ?? (k as IndicatorKey)))],
    overrides: load("indParams", {}),
  };
}

function reducer(s: ChartSettingsState, a: Action): ChartSettingsState {
  switch (a.type) {
    case "symbol": return { ...s, symbol: a.symbol.toUpperCase() };
    case "range": {
      // A range is a view: keep the interval shown now if the new range offers it (1Y Daily -> 5Y stays Daily, so
      // the same bars and the trained markers stay); otherwise the new range's default interval.
      const now = effectiveTimeframe(s.range, s.picked, s.from, s.to);
      const keep = RANGE_TFS[a.range].includes(now) ? now : null;
      return { ...s, range: a.range, picked: keep, from: "", to: "" };
    }
    case "custom": return { ...s, range: "CUSTOM", from: a.from, to: a.to, picked: null };
    case "timeframe": return { ...s, picked: a.tf };
    case "chartType": return { ...s, chartType: a.chartType };
    case "extended": return { ...s, extended: a.extended };
    case "toggle": {
      const set = new Set(s.enabled);
      if (a.on) set.add(a.key); else set.delete(a.key);
      return { ...s, enabled: [...set] };
    }
    case "allOff": return { ...s, enabled: [] };
    case "params": return { ...s, overrides: { ...s.overrides, [a.tf]: cloneParams(a.params) } };
    case "resetParams": {
      const overrides = { ...s.overrides };
      delete overrides[a.tf];
      return { ...s, overrides };
    }
  }
}

export function useChartSettings() {
  const [state, dispatch] = useReducer(reducer, undefined, initial);
  const timeframe = effectiveTimeframe(state.range, state.picked, state.from, state.to);
  const params = useMemo<IndicatorParams>(
    () => cloneParams(state.overrides[timeframe] ?? PRESETS[timeframe]),
    [state.overrides, timeframe],
  );
  const enabledSet = useMemo(() => new Set(state.enabled), [state.enabled]);

  // URL (shareable) + localStorage (remembered between visits).
  useEffect(() => {
    const p = new URLSearchParams({ symbol: state.symbol, range: state.range });
    if (state.picked) p.set("tf", state.picked);
    if (state.range === "CUSTOM") {
      p.set("from", state.from);
      if (state.to) p.set("to", state.to);
    }
    history.replaceState(null, "", "?" + p.toString() + location.hash); // keep the page (#/backtests)
    if (state.range !== "CUSTOM") save("range", state.range);
  }, [state.symbol, state.range, state.picked, state.from, state.to]);
  useEffect(() => save("type", state.chartType), [state.chartType]);
  useEffect(() => save("extended", state.extended), [state.extended]);
  useEffect(() => save("indicators", state.enabled), [state.enabled]);
  useEffect(() => save("indParams", state.overrides), [state.overrides]);

  const actions = {
    setSymbol: useCallback((symbol: string) => dispatch({ type: "symbol", symbol }), []),
    setRange: useCallback((range: Exclude<RangeKey, "CUSTOM">) => dispatch({ type: "range", range }), []),
    setCustomRange: useCallback((from: string, to: string) => dispatch({ type: "custom", from, to }), []),
    setTimeframe: useCallback((tf: Timeframe) => dispatch({ type: "timeframe", tf }), []),
    setChartType: useCallback((chartType: ChartType) => dispatch({ type: "chartType", chartType }), []),
    setExtended: useCallback((extended: boolean) => dispatch({ type: "extended", extended }), []),
    toggleIndicator: useCallback((key: IndicatorKey, on: boolean) => dispatch({ type: "toggle", key, on }), []),
    allIndicatorsOff: useCallback(() => dispatch({ type: "allOff" }), []),
    setParams: useCallback((tf: Timeframe, p: IndicatorParams) => dispatch({ type: "params", tf, params: p }), []),
    resetParams: useCallback((tf: Timeframe) => dispatch({ type: "resetParams", tf }), []),
  };

  return { ...state, timeframe, params, enabledSet, actions };
}

export type ChartSettings = ReturnType<typeof useChartSettings>;
