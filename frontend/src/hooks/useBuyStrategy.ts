/**
 * Which BUY decisions count - shared by the chart's BUY markers and the Backtests page (remembered):
 *   any      every bar may buy: the points rule alone (the analysis' rule, default)
 *   rebound / trend / both   only bars in that rule-based setup may buy (the cooldown then counts only those BUYs)
 */
import { useCallback, useState } from "react";
import { load, save } from "../lib/storage";
import type { BacktestSetups } from "../types/api";

const CHOICES: BacktestSetups[] = ["any", "rebound", "trend", "both"];

export const STRATEGY_LABEL: Record<BacktestSetups, string> = { any: "Any", rebound: "Rebound", trend: "Trend", both: "Both" };
export const STRATEGY_HINT: Record<BacktestSetups, string> = {
  any: "the points rule alone (the analysis' rule)", rebound: "only BUY bars in a rebound setup",
  trend: "only BUY bars in a trend setup", both: "only BUY bars in a rebound or trend setup",
};

export function useBuyStrategy(): [BacktestSetups, (s: BacktestSetups) => void] {
  const [value, setValue] = useState<BacktestSetups>(() => {
    const saved = load<string | null>("buyStrategy", null);
    if (saved && (CHOICES as string[]).includes(saved)) return saved as BacktestSetups;
    // before it was shared, the choice lived in the Backtests page settings (version 2 = interim low / high models)
    const bt = load<{ setups?: string; v?: number }>("backtest", {});
    return bt.v === 2 && bt.setups && (CHOICES as string[]).includes(bt.setups) ? bt.setups as BacktestSetups : "any";
  });
  const set = useCallback((s: BacktestSetups) => {
    setValue(s);
    save("buyStrategy", s);
  }, []);
  return [value, set];
}
