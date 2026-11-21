/** Data-source notes and the chart-library attribution. */
export function SiteFooter() {
  return (
    <footer className="site-foot">
      <p>
        Market data provided by Alpaca. History uses the consolidated SIP feed where your plan allows; the most recent
        15 minutes on free plans come from IEX, which covers IEX-exchange trades only. Times shown in US Eastern. Charts
        built with{" "}
        <a href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noopener noreferrer">
          TradingView Lightweight Charts&trade;
        </a>
        . For research and development use only. Nothing here is investment advice.
      </p>
    </footer>
  );
}
