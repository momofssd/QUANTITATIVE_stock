/** Market clock (open/closed, next open/close), refreshed every minute. */
import { useCallback, useEffect, useState } from "react";
import { api } from "../services/api";
import type { Clock } from "../types/api";
import { usePolling } from "./usePolling";

export function useClock(enabled: boolean): Clock | null {
  const [clock, setClock] = useState<Clock | null>(null);
  const refresh = useCallback(async () => {
    try {
      setClock(await api.clock());
    } catch {
      /* surfaced by other requests */
    }
  }, []);
  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);
  usePolling(refresh, 60000, enabled);
  return clock;
}
