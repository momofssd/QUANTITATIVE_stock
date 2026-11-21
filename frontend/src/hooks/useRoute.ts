/** Page from the URL hash: "#/backtests" -> Backtests, anything else (incl. "#hist" anchors) -> Quote & Chart. */
import { useEffect, useState } from "react";

export type Page = "chart" | "backtests";

const pageOf = (hash: string): Page => (hash.startsWith("#/backtests") ? "backtests" : "chart");

export function useRoute(): Page {
  const [page, setPage] = useState<Page>(() => pageOf(window.location.hash));
  useEffect(() => {
    const on = () => {
      const p = pageOf(window.location.hash);
      setPage((old) => {
        if (old !== p) window.scrollTo(0, 0);
        return p;
      });
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return page;
}
