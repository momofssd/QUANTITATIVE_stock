/** Shapes of the backend's JSON responses and live WebSocket messages. */

export type Timeframe = "1Min" | "5Min" | "15Min" | "30Min" | "1Hour" | "4Hour" | "1Day" | "1Week" | "1Month";
export type RangeKey = "1D" | "5D" | "1M" | "3M" | "6M" | "YTD" | "1Y" | "3Y" | "5Y" | "10Y" | "MAX" | "CUSTOM";
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
  /** Last bar before the selected range: its close is the base of the range's gain / loss (null = none loaded). */
  range_base?: { time: number; close: number; daily?: boolean } | null;  // daily: an official (daily bar) close
  /** Intraday, regular hours: the session's official close - the end of the range's gain / loss until a live tick. */
  range_last?: { time: number; close: number; daily?: boolean } | null;
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

/** short = BUY (profit-take / stop-loss), accum = BUY for the sell-signal strategy, tp_short = SELL. */
export type TargetKey = "short" | "accum" | "tp_short";
export type Outcome = "target" | "stop" | "expired" | "pending";
export type ExitReason = "target" | "trailing stop" | "take-profit signal" | "sell decision" | "time limit" | "stop";

export type BracketMode = "fixed" | "optimal";

/** Optimized ATR (bracket "optimal", quant/optimize.py). Returns are totals of $100-per-trade BUY trades, in %. */
export interface Optimization {
  tp_values: number[];
  sl_values: number[];
  default: { tp: number; sl: number };
  lookback: number;       // bars of closed trades that score a combination
  min_trades: number;
  step: number;           // bars between re-optimizations (= retrains)
  combos: number;
  folds_per_combo: number;
  grid: { tp: number; sl: number; trades: number; total_return_pct: number; avg_return_pct: number | null;
    win_rate: number | null }[];
  choices: { start: string; end: string; tp: number; sl: number; score_pct: number; trades: number; fallback: boolean }[];
  current: { tp: number; sl: number; as_of: string; score_pct: number; trades: number; fallback: boolean };
  strategy?: { trades: number; total_return_pct: number; avg_return_pct: number | null; win_rate: number | null };
}

/** Rows (bars) one model learned from. */
export interface TrainSpan {
  start: string;
  end: string;
  rows: number;      // bars with a known outcome inside the rolling window
  sessions: number;  // trading days they cover
  days: number;      // calendar days from start to end
}

export interface TrainingInfo {
  trained_at: string;   // "YYYY-MM-DD HH:MM ET"
  train_bars: number;   // rolling window (bars)
  min_train: number;
  data: { start: string; end: string; bars: number };     // the interval's bars
  daily: { start: string; end: string; bars: number };    // the stock's daily bars
  factors: { start: string; end: string };                // Yahoo factors
  targets: Record<TargetKey, {
    folds: number;
    retrain_every: number;
    first: (TrainSpan & { predicts_from: string }) | null;  // the oldest walk-forward model
    current: TrainSpan | null;                              // today's model (current K decision, projection)
  }>;
}

/** One projected scenario for the current K line. "now" = the K line already is a BUY / SELL. */
export interface ProjectedSide {
  now: boolean;
  price: number;         // projected BUY entry / selling price (the close that would trigger it)
  move_atr: number;      // from the current close, x daily ATR
  move_pct: number;
  zone?: [number, number];   // closes in this range trigger it ...
  zone_open?: boolean;       // ... and it still holds at the end of the searched range
  prob?: number;
  threshold?: number;
  setup?: SetupName;         // BUY: rebound / trend at that price
  target?: number;           // BUY: profit-take; SELL: pullback to
  stop?: number;             // BUY: stop-loss; SELL: invalid above
  tp_atr?: number; sl_atr?: number; target_basis?: string; stop_basis?: string;
}

export interface Projection {
  close: number;
  atr: number;
  range_atr: number;     // searched: close +/- this x ATR
  step_atr: number;
  buy: ProjectedSide | null;
  sell: ProjectedSide | null;
  closer: "buy" | "sell" | null;   // relative to the analysed close (the UI re-checks against the live price)
}

/** One $100 lot of the simulation (every BUY buys one). */
export interface SimTrade {
  status: "closed" | "open";
  reason: "sell" | "target" | "stop" | "time limit" | "open";
  setup: SetupName;  // setup of the BUY that bought the lot
  prob?: number | null; // the model's P on that BUY (backtests)
  qty: number;       // shares ($100 / price, or 1)
  cost: number;      // dollars paid
  buy_time: number; buy_date: string; buy_price: number;
  sell_time: number; sell_date: string; sell_price: number; // open: the last close
  bars: number;
  pnl: number;       // dollars
  pnl_pct: number;
}

/** Win rate and P&L over a set of lots (all, or one setup). */
export interface SimTally {
  lots: number; closed: number; open: number; wins: number; losses: number; win_rate: number | null;
  realized_pnl: number; open_pnl: number; total_pnl: number;
  invested: number; return_on_invested_pct: number | null;
  // average cost per share: of every share bought, and of the shares still held
  shares: number; avg_cost: number | null; open_shares: number; open_cost: number; open_avg_cost: number | null;
  avg_pnl: number | null; best_pnl: number | null; worst_pnl: number | null; avg_bars: number | null;
  // per transaction (sold lots)
  avg_return_pct: number | null; avg_win_pct: number | null; avg_loss_pct: number | null;
  avg_win_pnl: number | null; avg_loss_pnl: number | null;
}

/** P&L earned since Jan 1 of the last bar's year (lots held over the year end count from the previous close). */
export interface SimYtd {
  since: string;
  lots_held: number;
  lots_sold: number;
  wins: number;
  win_rate: number | null;
  pnl: number;
  return_pct: number | null;
  avg_return_pct: number | null;
}

export type BacktestSetups = "rebound" | "trend" | "both";

export interface BacktestScenario extends SimStrategy {
  decisions: number;
  end_date: string;
  probs: number[];
}

/** One strategy on the Backtests page. */
export interface BacktestVariant {
  /** BUY-setup bars in the window and how many qualify at the threshold, per setup choice. */
  pool: Record<BacktestSetups, { setup_bars: number; qualified: number; max_prob: number }>;
  model_thresholds: [number, number] | null;   // this BUY model's own thresholds over the window
  result: BacktestScenario | null;
  compare: { setups: BacktestSetups; decisions: number; summary: SimRun["summary"] | null }[];
}

export interface BacktestResult {
  run_id: string;
  symbol: string;
  timeframe: string;
  range: string;
  bar_unit: string;
  cooldown: number;
  window: { start: string; end: string; bars: number };
  /** min_prob / sell_min_prob null = the model's own threshold (training base rate + 10 pts, per retrain). */
  params: {
    n: number; setups: BacktestSetups; min_prob: number | null; sell_min_prob: number | null; sizing: SimSizing;
    max_shares: number | null;   // sell-signal strategy: most shares held at once (null = no limit)
  };
  /** sell_only = sell-signal strategy (its own BUY model); with_bracket = profit-take / stop-loss strategy. */
  variants: Record<"sell_only" | "with_bracket", BacktestVariant>;
  sell_model_thresholds: [number, number] | null;   // the SELL model's own thresholds over the window
  sell_decisions: number;   // SELL decisions in the window under the SELL threshold
  year_start: { i: number; date: string; prev_close: number | null } | null;
}

export interface SimRun {
  trades: SimTrade[]; // newest lot first
  summary: SimTally & {
    max_lots: number;          // most lots held at the same time
    max_capital: number;       // ... in dollars
    return_pct: number | null; // total P&L on max_capital
    sells_used: number;        // SELL decisions that sold something
    ytd?: SimYtd;              // backtests only
    max_shares_held?: number;  // most shares held at the same time
    max_shares?: number | null; // the cap on shares held (null = no limit)
    skipped?: number;          // BUYs skipped because they would go over the cap
  };
  by_setup: { rebound: SimTally; trend: SimTally };
  /** BUYs skipped at the cap (newest first), with the shares held at that moment. */
  skipped?: SimSkipped[];
}

export interface SimSkipped {
  time: number; date: string; price: number; setup: SetupName; prob: number | null;
  qty: number;   // shares the lot would have bought
  held: number;  // shares held at that moment
}

/** One sizing of the simulation: every BUY buys $100 worth ("usd") or 1 share ("share"). */
/** One strategy's simulation: the run + its own period, counts and baselines. */
export interface SimStrategy extends SimRun {
  start_time: number;
  start_date: string;
  buys: number;
  sells: number;
  last_price: number;
  /** The same BUYs, never sold: P&L, shares on hand, their cost and their value at the last close. */
  hold_all: HeldPosition;
  /** The same money, all of it at the first BUY's close and held (null when nothing was bought). */
  lump_sum: HeldPosition | null;
  /** Weekly DCA with the same money: equal amounts at the first BUY's close, then at the first close of every later
   *  week, held to the last close (Backtests page only; null in the analysis' own simulation). */
  dca: (HeldPosition & { buys: number; per_buy: number; last_buy_date: string }) | null;
  buy_hold: { pnl: number; pnl_pct: number }; // one lot bought at the first BUY and held
}

/** A position bought for `cost` and held to the last close. */
export interface HeldPosition {
  cost: number; shares: number; avg_cost: number | null; value: number; pnl: number; pnl_pct: number | null;
}

export interface SimBook {
  /** Sell-signal strategy: BUYs from the sell-signal BUY model, every BUY adds a lot, the next SELL sells all. */
  sell_only: SimStrategy | null;
  /** Profit-take / stop-loss strategy: BUYs from that BUY model, each lot also sold at its own levels / time limit. */
  with_bracket: SimStrategy | null;
}

export type SimSizing = "usd" | "share";

export interface Simulation {
  stake: number;
  listed: number;       // each strategy covers this many most recent BUYs of its BUY model
  end_date: string;
  usd: SimBook;
  share: SimBook;
}

/** What supported a decision (expanded decision row). */
export interface DecisionWhy {
  base_rate: number | null;                      // training base rate of the model that decided
  factors: { group: string; delta: number }[];   // pts of P added by the group's real values vs typical values
  setups: Partial<Record<"rebound" | "trend" | "top", SetupExplain>>;
  values: { label: string; value: number; unit: string; digits: number; signed: boolean }[];
}

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
  label_rule: "bracket" | "next_sell"; // bracket: target before stop; next_sell: profit at the next SELL decision
  horizon_mode: "bars" | "sessions"; // horizon counted in bars of the interval or in trading sessions
  atr_basis: "bar" | "daily";        // ATR of the interval's bars or daily ATR
  bracket: BracketMode;              // BUY levels: fixed ATR multiples or set per decision
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
  tp_atr: number;        // distance to the profit-take, x ATR
  sl_atr: number;        // distance to the stop-loss, x ATR
  target_basis: string;  // what set the profit-take ("1.5x risk", "50% retracement", "1.5 ATR", ...)
  stop_basis: string;    // what set the stop-loss ("1 ATR", "optimized")
  outcome: Outcome;
  resolved_date: string | null;
  days: number | null;
  trade?: TradeView; // entries only
  setup: SetupName;  // which rule-based setup the bar was in
  in_range: boolean; // inside the chart's own range (vs only in the longer model-check window)
  why?: DecisionWhy; // what supported the decision
}

export type SetupName = "rebound" | "trend" | "top" | "";

export interface CurrentSignal {
  date: string;
  time: number;
  prob: number;
  threshold: number;
  base_rate: number;
  ml_signal: boolean;   // model alone (P >= threshold)
  setup: SetupName;     // setup on the current K line
  signal: boolean;      // BUY / SELL = model AND setup
  entry: number;
  atr: number;
  target: number;
  stop: number;
  tp_atr: number;        // distance to the profit-take, x ATR
  sl_atr: number;        // distance to the stop-loss, x ATR
  target_basis: string;  // what set the profit-take ("1.5x risk", "50% retracement", "1.5 ATR", ...)
  stop_basis: string;    // what set the stop-loss ("1 ATR", "optimized")
  chase_limit: number | null; // BUY: don't enter above this
  /** Today's model on the last K lines (oldest first, the current one last): momentum toward / away from a decision. */
  recent: { date: string; prob: number; setup: SetupName; signal: boolean }[];
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
  setup_bars: number;            // bars in the setup within the window
  setup_rate: number | null;     // hit rate of ALL setup bars (rules only, no model)
  by_setup: Record<string, { resolved: number; hits: number; hit_rate: number | null }>;
}

/** Outcomes inside the chart's own range. */
export interface RangeStats {
  bars: number;
  signals: number;
  resolved: number;
  hits: number;
  hit_rate: number | null;
  base_rate: number | null;
  decided_bars: number;
  setup_bars: number;
  setup_rate: number | null;
}

export interface SetupExplain {
  active: boolean;
  rule: string;
  checks: { label: string; ok: boolean }[];
}

/** Today's 5-minute action vs the BUY / SELL decision. */
export interface IntradayCheck {
  available: boolean;
  reason?: string;
  session?: string;
  asof?: string;
  bars?: number;
  last?: number;
  vwap?: number;
  day_high?: number;
  day_low?: number;
  day_change_pct?: number | null;
  checks?: { id: string; label: string; detail: string; signal: -1 | 0 | 1 }[];
  buy?: { score: number; verdict: "supports" | "mixed" | "against" };
  sell?: { score: number; verdict: "supports" | "mixed" | "against" };
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
  signals: TradeSummary;    // trading the marked entries (model-check window)
  every_day: TradeSummary;  // same exits, entering on every bar (baseline)
  buy_hold_pct: number;
  range_signals: TradeSummary;    // the same, chart range only
  range_every_day: TradeSummary;
  range_buy_hold_pct: number;
  rules: {
    stop_atr: number; target_atr: number; trail_after_atr: number; trail_atr: number; horizon: number;
    horizon_mode: "bars" | "sessions"; atr_basis: "bar" | "daily"; exit_with: string; bracket: BracketMode;
    label_rule: "bracket" | "next_sell";
  };
}

export interface TargetResult {
  spec: TargetSpec;
  current: CurrentSignal | null;
  signals: EntrySignal[];
  stats: TargetStats;
  range_stats: RangeStats;
  /** BUY S: until this date (the SELL model's first decision) the interim-top setup stood in for SELL in its labels. */
  proxy_until?: string | null;
  trades: TradesBlock | null;
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
  /** The chart's own range (what the markers, range stats and highlighted decisions cover). */
  range_window: { start: string; end: string; bars: number; start_time: number };
  /** The longer model-check window (>= 1,260 bars) used for the verdict and AUC. */
  window: { start: string; end: string; bars: number; start_time: number; train_bars: number; retrain_every: number;
    years: number };
  method: {
    model: string; training: string; signal_rule: string; features: number; atr: string; factor_alignment: string;
  };
  sources: { stock: string; factors: string; factor_tickers: Record<string, string> };
  params: {
    tp_atr: number; sl_atr: number; tp_range: [number, number]; sl_range: [number, number];
    bracket: BracketMode;
    optimization: Optimization | null;   // bracket "optimal" only
  };
  /** $100 per BUY over the most recent decisions (null when there is no BUY). */
  simulation: Simulation | null;
  /** The actual dates every model of this run learned from. */
  training: TrainingInfo;
  /** Price momentum of the last K lines (oldest first). */
  k_momentum: { date: string; close: number; rsi: number | null; macd_hist_atr: number | null }[];
  /** Server-side handle of this training for the Backtests page (/api/backtest/{run_id}). */
  run_id: string;
  /** At which close would the current K line become a BUY / a SELL (null when it cannot be computed)? */
  projection: Projection | null;
  targets: Record<TargetKey, TargetResult>;
  setups_now: Record<"rebound" | "trend" | "top", SetupExplain>;
  chase_atr: number;
  intraday_check: IntradayCheck;
  relations: FactorRelation[];
}
