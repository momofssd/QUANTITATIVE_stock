/** Backend health (are Alpaca credentials configured?). While not configured, re-checks every 5 s. */
import { useCallback, useEffect, useState } from "react";
import { api, type ApiError } from "../services/api";
import type { Health } from "../types/api";
import { usePolling } from "./usePolling";

export function useHealth(onError: (e: ApiError) => void) {
  const [health, setHealth] = useState<Health | null>(null);

  const check = useCallback(async () => {
    try {
      setHealth(await api.health());
    } catch (e) {
      onError(e as ApiError);
    }
  }, [onError]);

  useEffect(() => {
    void check();
  }, [check]);
  usePolling(check, 5000, health !== null && !health.configured);

  return health;
}
