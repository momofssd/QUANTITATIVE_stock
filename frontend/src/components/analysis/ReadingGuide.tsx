/** Plain-language guide to the analysis panel (collapsible). */
export function ReadingGuide() {
  return (
    <details className="ta-method ta-guide">
      <summary>How to read this</summary>
      <dl>
        <dt>BUY</dt>
        <dd>
          A short-term entry. Two things must agree: the bar is in a <b>Rebound</b> setup (price has been falling and the
          selling momentum is easing - MACD histogram rising below zero, RSI turning up from a low, a higher low or long
          lower wick) or a <b>Trend</b> setup (close &gt; SMA20 &gt; SMA50, both rising, ADX ≥ 20), <b>and</b> the
          machine-learning model expects the price to reach the profit-take before the stop-loss within 5 trading days.
        </dd>
        <dt>SELL (take profit)</dt>
        <dd>
          The bar is in an <b>Interim top</b> setup (price extended and bullish momentum fading - MACD histogram falling
          above zero, RSI turning down from a high, a lower high or long upper wick, or a close back down right after a new
          20-bar high) <b>and</b> the take-profit model expects a 1.5 ATR pullback before a 1 ATR rise within 5 trading days.
          A SELL also closes an open BUY trade that is in profit.
        </dd>
        <dt>Current K line</dt>
        <dd>
          The decision for the newest candle. When it is a BUY you get the <b>entry</b> (the price when the model decided),
          <b> profit-take</b>, <b>stop-loss</b> and a <b>chase limit</b> (entry + 0.25 ATR). The K line is live, so the live
          price is compared with the plan: inside the entry zone, below it (a better price), above the chase limit (wait for
          a pullback), or already at the profit-take / stop-loss.
        </dd>
        <dt>Today's 5-minute check</dt>
        <dd>
          Confirms the decision with today's intraday action: price vs VWAP, the last hour's direction, 5-minute RSI
          direction, rising or falling lows, and position in the day's range. Each scores +1 (supports BUY), −1 (supports
          SELL) or 0; a total of +2 or more <b>supports</b>, −2 or less is <b>against</b>, anything else is <b>mixed</b>. It
          refreshes every minute. It is a sanity check, not part of the backtested model.
        </dd>
        <dt>Verdict (green / amber box)</dt>
        <dd>
          <b>Edge found</b> means the model's past signals, made without seeing the future, beat a random bar for this
          stock. <b>No reliable edge</b> means they did not - treat its signals with caution.
        </dd>
        <dt>Justified / Setup only / Any bar</dt>
        <dd>
          <b>Justified</b> = past BUY signals that reached the profit-take before the stop-loss within 5 trading days.
          <b> Setup only</b> = the same for every bar in the setup without the model; <b>Any bar</b> = for every bar. If
          Justified beats Setup only, the model adds something on top of the rules.
        </dd>
        <dt>P, threshold, AUC</dt>
        <dd>
          P is the model's probability. A signal needs P at least 10 points above the base rate. AUC measures how well the
          model ranks bars: 0.50 is a coin flip, 0.55–0.60 a modest edge.
        </dd>
        <dt>Trade exit</dt>
        <dd>
          What happened if you had bought at the BUY and sold at the first of: the profit-take, the stop-loss, a SELL signal
          while in profit, or the close after 5 trading sessions. <b>Any-bar entry</b> applies the same exits to every bar.
        </dd>
        <dt>Projection (current K line)</dt>
        <dd>
          The BUY / SELL decision depends on where the K line closes. The app re-runs the same decision (setup and model)
          for closes from −3 to +3 daily ATR around the current close and shows the price nearest to now at which the K line
          would become a <b>BUY</b> (projected entry, with its profit-take and stop-loss) and the one at which it would become
          a <b>SELL</b> (projected selling price). The scenario closer to the live price is shown first; both are drawn on the
          chart as dashed "Proj. BUY" / "Proj. SELL" lines. It is a what-if on today's close, not a price forecast.
        </dd>
        <dt>Fixed ATR vs Dynamic levels</dt>
        <dd>
          <b>Fixed ATR</b>: every BUY gets the same profit-take / stop-loss, in multiples of the daily ATR you set.
          <b> Dynamic</b>: each BUY gets its own levels from the chart at that moment - the stop-loss just below the
          5-session low, the profit-take at a 50% retracement of the recent fall (rebound) or 1.5× the risk (trend), within
          limits. The decision tables show each level's distance in ATR and what set it. Switching retrains the model on
          the new levels, so its AUC / hit rate are not comparable between the two modes - compare the $100 simulation.
        </dd>
        <dt>Simulation ($100 or 1 share)</dt>
        <dd>
          Over the 30 most recent BUYs: every BUY buys a lot, also while already holding - $100 worth (default) or 1 share
          - and the next SELL decision sells everything held (all lots at once). With the second option each lot is also
          sold earlier at its own profit-take or stop-loss. Lots still held are valued at the last close. Win rate and
          P&amp;L count each lot and are split by the BUY's setup (rebound / trend). Before commissions and slippage.
        </dd>
        <dt>Training dates</dt>
        <dd>
          The box at the top lists, for this run, the dates today's BUY and SELL models learned from, the dates of the
          first model in the walk-forward check, how often they were retrained, and the data used. Each click of
          <b> Find entry points</b> retrains and updates it. On minute / hourly charts the window can be only a few weeks
          of data - the box warns when it is under a year.
        </dd>
        <dt>Decision details (click a row)</dt>
        <dd>
          Clicking a BUY or SELL row shows what supported it: the model's probability vs its threshold, which setup
          conditions held on that bar, how much each factor group (stock momentum, trend, SPY, QQQ, VIX, oil, rates...)
          pushed the probability up or down compared with typical values, and key indicator values on that bar.
        </dd>
        <dt>Daily decisions and intraday buying</dt>
        <dd>
          A daily BUY / SELL is decided on the day's <b>close</b> and the backtest buys at that close. During the session
          the live price is compared with the projected zones: when it is inside one, the panel says the signal is
          reached intraday - you could act at the live price, but it only becomes a real BUY / SELL if the day closes
          there. For decisions made (and backtested) during the day, analyse an hourly or minute chart.
        </dd>
        <dt>Chart range vs model check</dt>
        <dd>
          <b>This chart range</b> covers exactly the bars on the chart (1D = today's session, 1Y = the last year): the
          markers, its BUY / SELL counts and outcomes, and the highlighted rows of the decision tables. A short range has
          too few decisions to judge a model, so the <b>Model check</b> (verdict, AUC) uses at least the last 1,260 bars of
          the same interval. The decision tables list the 30 most recent BUYs and SELLs; rows before the chart range are dimmed.
        </dd>
        <dt>Interval &amp; retraining</dt>
        <dd>
          Everything is computed on the chart's own candles; the 5-trading-day window and the daily ATR are the same on every
          interval. Each click of <b>Find entry points</b> retrains on the current range and interval; changing the range or
          interval afterwards hides the markers until you retrain.
        </dd>
        <dt>What drives this model</dt>
        <dd>Which factor groups carried the model's predictive power over the last year - importance, not direction.</dd>
      </dl>
    </details>
  );
}
