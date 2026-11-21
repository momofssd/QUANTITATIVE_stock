/** Top bar: brand, primary navigation, quote search. */
import type { Page } from "../../hooks/useRoute";
import { SearchBox } from "../search/SearchBox";

export function SiteHeader({ page, onPickSymbol }: { page: Page; onPickSymbol: (symbol: string) => void }) {
  return (
    <div className="wrap header-row">
      <a className="brand" href="/" aria-label="Quant Trading Model home">
        <span className="brand-mark">Q</span>
        <span className="brand-text">Quant<strong>Model</strong></span>
      </a>
      <nav className="main-nav" aria-label="Primary">
        <a href="#/" className={page === "chart" ? "active" : ""}>News &amp; Research</a>
        <a href="#/backtests" className={page === "backtests" ? "active" : ""}>Backtests</a>
      </nav>
      <SearchBox onPick={onPickSymbol} />
    </div>
  );
}
