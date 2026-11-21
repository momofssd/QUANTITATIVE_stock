/** Shapes of the backend's JSON responses and live WebSocket messages. */

export type Timeframe = "1Min" | "5Min" | "15Min" | "30Min" | "1Hour" | "4Hour" | "1Day" | "1Week" | "1Month";
export type RangeKey = "1D" | "5D" | "1M" | "3M" | "6M" | "YTD" | "1Y" | "5Y" | "MAX" | "CUSTOM";
export type FeedLabel = "iex" | "sip" | "sip+iex";

export interface Health {
  configured: boolean;
  account: "paper" | "live";
  trading_url: string;
  feed: FeedLabel;
}

export interface Clock {
  is_open: boolean;
  next_open: string;
  next_close: string;
  timestamp?: string;
}

export interface Asset {
  symbol: string;
  name: string;
  exchange: string;
}

export interface Quote {
  symbol: string;
  name: string | null;
  exchange: string | null;
  asset_class: string | null;
  tradable: boolean | null;
  shortable: boolean | null;
  marginable: boolean | null;
  fractionable: boolean | null;
  easy_to_borrow: boolean | null;
  price: number | null;
  trade_time: string | null;
  bid: number | null;
  bid_size: number | null;
  ask: number | null;
  ask_size: number | null;
  quote_time: string | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  day_vwap: number | null;
  prev_close: number | null;
  change: number | null;
  change_pct: number | null;
  week52_high: number | null;
  week52_low: number | null;
  avg_volume_10d: number | null;
  avg_volume_3m: number | null;
  feed: FeedLabel;
}

/** Indicator lengths as echoed back by the server. */
export interface ServerIndicatorParams {
  sma: [number, number, number];
  ema: [number, number];
  bb_len: number;
  bb_mult: number;
  rsi: number;
  macd: [number, number, number];
}

/** Column-oriented bars. `time` = epoch seconds of New York wall-clock time. */
export interface BarColumns {
  time: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  bar_vwap: (number | null)[];
  trades: (number | null)[];
  sma1: (number | null)[];
  sma2: (number | null)[];
  sma3: (number | null)[];
  ema1: (number | null)[];
  ema2: (number | null)[];
  bb_mid: (number | null)[];
  bb_upper: (number | null)[];
  bb_lower: (number | null)[];
  rsi: (number | null)[];
  macd: (number | null)[];
  macd_signal: (number | null)[];
  macd_hist: (number | null)[];
  vwap: (number | null)[];
  [col: string]: (number | null)[];
}

export interface BarsPayload {
  symbol: string;
  range: RangeKey;
  timeframe: Timeframe;
  intraday: boolean;
  extended: boolean;
  feed: FeedLabel;
  params: ServerIndicatorParams;
  count: number;
  truncated: boolean;
  has_more: boolean;
  view_start?: number;
  load_from?: string;
  start?: string | null;
  end?: string | null;
  columns: BarColumns | Record<string, never>;
}

// ---------------------------------------------------------------- live stream messages

export type StreamState = "idle" | "connecting" | "live" | "reconnecting" | "offline" | "limit" | "error";

export interface StreamStatus {
  type: "status";
  state: StreamState;
  detail: string;
  feed?: string | null;
  symbols?: string[];
}

export interface TickMessage {
  type: "tick";
  S: string;
  p: number;
  hi: number;
  lo: number;
  v: number;
  t: string;
  n: number;
}

export interface QuoteMessage {
  type: "quote";
  S: string;
  bp: number;
  bs: number;
  ap: number;
  as: number;
  t: string;
}

export interface BarMessage {
  type: "bar";
  kind: "minute" | "minute_update" | "daily";
  S: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  t: string;
}

export type LiveMessage = StreamStatus | TickMessage | QuoteMessage | BarMessage;

// ---------------------------------------------------------------- entry-point analysis (GET /api/analysis/{symbol})

export type TargetKey = "short" | "long" | "tp_short" | "tp_long";
export type EntryKey = "short" | "long";
export type Outcome = "target" | "stop" | "expired" | "pending";
export type ExitReason = "target" | "trailing stop" | "take-profit signal" | "time limit" | "stop";

export interface TargetSpec {
  key: TargetKey;
  label: string;
  kind: "entry" | "take_profit";
  direction: "up" | "down";  // entry: price must rise first; take-profit: price must fall first
  horizon: number;           // trading days
  target_atr: number;        // move in the signal's direction, in ATR
  stop_atr: number;          // move against it, in ATR
  cooldown: number;
  model: string;
  trail_after_atr: number;   // entries: trailing stop starts once the close is this many ATR above entry
  trail_atr: number;         // entries: trailing distance below the highest close (0 = plain bracket order)
  exit_with: string;         // entries: take-profit target whose signal can close the trade ("" = none)
  horizon_mode: "bars" | "sessions"; // horizon counted in bars of the interval or in trading sessions
  atr_basis: "bar" | "daily";        // ATR of the interval's bars or daily ATR
}

/** How an entry signal's trade ended (or where it stands if still open). Returns are % before costs. */
export interface TradeView {
  status: "closed" | "open";
  price: number;
  return_pct: number;
  r: number;
  days: number;
  reason?: ExitReason;
  exit_date?: string;
  exit_time?: number;
  stop?: number;
  target?: number;
  trailing?: boolean;
  days_left?: number | null;
  left_unit?: "bars" | "sessions";
}

export interface EntrySignal {
  time: number;      // chart time (ET date at midnight)
  date: string;
  prob: number;
  threshold: number;
  entry: number;     // close on the signal day
  atr: number;
  target: number;
  stop: number;
  outcome: Outcome;
  resolved_date: string | null;
  days: number | null;
  trade?: TradeView; // entries only
}

export interface CurrentSignal {
  date: string;
  time: number;
  prob: number;
  threshold: number;
  base_rate: number;
  signal: boolean;
  entry: number;
  atr: number;
  target: number;
  stop: number;
  horizon_days: number;
}

export interface TargetStats {
  reliable: boolean;
  verdict: string;
  base_rate: number | null;
  auc: number | null;
  signals: number;
  resolved: number;
  hits: number;
  hit_rate: number | null;
  folds: number;
}

export interface TradeSummary {
  trades: number;
  open: number;
  win_rate?: number;
  avg_return_pct?: number;
  median_return_pct?: number;
  avg_r?: number;
  profit_factor?: number | null;
  avg_days?: number;
  reasons?: Record<ExitReason, number>;
}

export interface TradesBlock {
  signals: TradeSummary;    // trading the marked entries
  every_day: TradeSummary;  // same exits, entering on every day (baseline)
  buy_hold_pct: number;
  rules: {
    stop_atr: number; target_atr: number; trail_after_atr: number; trail_atr: number; horizon: number;
    horizon_mode: "bars" | "sessions"; atr_basis: "bar" | "daily"; exit_with: string;
  };
}

/** Long-term validation: average cost of all long-term buys (equal dollars each) vs the SMA 60. */
export interface CostCheck {
  sma_len: number;
  entries: number;
  avg_cost: number | null;
  sma_now: number | null;
  validated: boolean | null;
  discount_pct: number | null;   // (SMA - avg cost) / SMA, %
  held_below?: number;           // checkpoints where the running average cost was below that day's SMA
  dca_avg_cost: number | null;   // same dollars on EVERY bar of the window
  vs_dca_pct?: number | null;    // signal average cost vs that, %
  checkpoints: { time: number; date: string; price: number; avg_cost: number; sma: number | null }[];
  verdict: string;
}

export interface TargetResult {
  spec: TargetSpec;
  current: CurrentSignal | null;
  signals: EntrySignal[];
  stats: TargetStats;
  trades: TradesBlock | null;
  cost_check: CostCheck | null;
  open_trade: EntrySignal | null;
  importance: { group: string; weight: number }[];
}

export interface FactorRelation {
  factor: string;
  ticker: string;
  description: string;
  corr_window: number | null;
  corr_60d: number | null;
  beta: number | null;
  lead_corr: number | null;
}

export interface AnalysisResult {
  symbol: string;
  range: RangeKey;
  timeframe: Timeframe;
  intraday: boolean;
  extended: boolean;
  bar_unit: string;   // "trading days", "hourly bars", ...
  asof: string;
  window: { start: string; end: string; bars: number; train_bars: number; retrain_every: number; years: number };
  method: {
    model: string; training: string; signal_rule: string; features: number; atr: string; factor_alignment: string;
  };
  sources: { stock: string; factors: string; factor_tickers: Record<string, string> };
  params: { tp_atr: number; sl_atr: number; tp_range: [number, number]; sl_range: [number, number] };
  targets: Record<TargetKey, TargetResult>;
  /** Chart lines for the long-term cost check (times = chart bar times). */
  lines: { sma?: { time: number; value: number }[]; avg_cost?: { time: number; value: number }[]; sma_len?: number };
  relations: FactorRelation[];
}
