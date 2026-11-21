/** Last 10 viewed symbols (most recent first), remembered in localStorage. */
import { useEffect, useState } from "react";
import { load, save } from "../lib/storage";

export function useRecentSymbols(current: string): string[] {
  const [recent, setRecent] = useState<string[]>(() => load<string[]>("recent", []));
  useEffect(() => {
    setRecent((list) => {
      const next = [current, ...list.filter((s) => s !== current)].slice(0, 10);
      save("recent", next);
      return next;
    });
  }, [current]);
  return recent;
}
