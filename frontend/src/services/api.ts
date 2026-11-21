/** REST client for the FastAPI backend. Errors carry the HTTP status and the server's `detail` message. */
import type { AnalysisResult, Asset, BarsPayload, Clock, Health, IntradayCheck, Quote } from "../types/api";

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

type Params = Record<string, string | number | boolean | undefined | null>;

async function get<T>(path: string, params?: Params, signal?: AbortSignal): Promise<T> {
  const qs = params
    ? "?" + new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, String(v)]),
    ).toString()
    : "";
  let resp: Response;
  try {
    resp = await fetch(path + qs, { signal, headers: { Accept: "application/json" } });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError("Cannot reach the local server. Is the backend running?", 0);
  }
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    /* non-JSON body */
  }
  if (!resp.ok) {
    const detail = (body as { detail?: string } | null)?.detail;
    throw new ApiError(detail || `Request failed (${resp.status})`, resp.status);
  }
  return body as T;
}

export interface BarsQuery {
  range: string;
  timeframe: string;
  extended?: boolean;
  start?: string;
  end?: string;
  load_from?: string;
  sma?: string;
  ema?: string;
  bb?: string;
  rsi?: string;
  macd?: string;
}

export interface AnalysisQuery {
  range: string;
  timeframe: string;
  start?: string;
  end?: string;
  extended?: boolean;
  tp_atr?: number;   // short-term profit-take, x daily ATR
  sl_atr?: number;   // short-term stop-loss, x daily ATR
  bracket?: "fixed" | "dynamic"; // BUY levels: fixed multiples or set per decision
  refresh?: boolean;
}

export const api = {
  health: () => get<Health>("/api/health"),
  clock: () => get<Clock>("/api/clock"),
  search: (q: string, signal?: AbortSignal) => get<Asset[]>("/api/search", { q }, signal),
  quote: (symbol: string) => get<Quote>(`/api/quote/${encodeURIComponent(symbol)}`),
  bars: (symbol: string, query: BarsQuery, signal?: AbortSignal) =>
    get<BarsPayload>(`/api/bars/${encodeURIComponent(symbol)}`, { ...query }, signal),
  /** Entry / take-profit analysis retrained on the chart's range + interval (~5-30 s). */
  analysis: (symbol: string, query: AnalysisQuery, signal?: AbortSignal) =>
    get<AnalysisResult>(`/api/analysis/${encodeURIComponent(symbol)}`, { ...query }, signal),
  /** Today's 5-minute check for the current K line (cheap). */
  intraday: (symbol: string) => get<IntradayCheck>(`/api/analysis/${encodeURIComponent(symbol)}/intraday`),
};

export const isAbort = (e: unknown) => (e as Error)?.name === "AbortError";
