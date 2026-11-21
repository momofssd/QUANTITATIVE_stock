/** The page-level message bar: errors (red) and warnings (amber), including friendly API error text. */
import { useCallback, useState } from "react";
import type { ApiError } from "../services/api";

export type BannerKind = "error" | "warn";
export interface BannerState {
  kind: BannerKind;
  title?: string;
  message: string;
  /** Show the .env setup hint. */
  envHint?: boolean;
}

export function useBanner() {
  const [banner, setBanner] = useState<BannerState | null>(null);

  const show = useCallback((b: BannerState | null) => setBanner(b), []);
  const clear = useCallback(() => setBanner(null), []);

  const showApiError = useCallback((e: ApiError | { status: number; message?: string }) => {
    if (e.status === 503) {
      setBanner({ kind: "error", title: "Alpaca credentials missing.", message: "", envHint: true });
    } else if (e.status === 401 || e.status === 403) {
      setBanner({
        kind: "error", title: "Alpaca rejected the request.",
        message: `${e.message ?? ""} Check that the key/secret in .env are correct and match the endpoint (paper vs live).`,
      });
    } else if (e.status === 404) {
      setBanner({ kind: "warn", message: e.message ?? "Not found" });
    } else {
      setBanner({ kind: "error", message: e.message ?? "Request failed" });
    }
  }, []);

  return { banner, show, clear, showApiError };
}

export type BannerApi = ReturnType<typeof useBanner>;
