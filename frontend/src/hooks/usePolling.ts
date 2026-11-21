/** setInterval that always calls the latest callback and stops on unmount. */
import { useEffect, useRef } from "react";

export function usePolling(callback: () => void, intervalMs: number, enabled = true): void {
  const saved = useRef(callback);
  saved.current = callback;
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => saved.current(), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, enabled]);
}
