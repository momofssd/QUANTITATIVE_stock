/** Plain-language guide to the analysis panel (collapsible). */
export function ReadingGuide() {
  return (
    <details className="ta-method ta-guide">
      <summary>How to read this</summary>
      <dl>
        <dt>Latest K line decision</dt>
        <dd>
          What each model decides for the newest analysed candle, drawn on it: <b>S BUY / L BUY</b> (black up-arrow),
          <b> TS SELL / TL SELL</b> (black down-arrow), or <b>–</b> (grey dot) for no entry / hold. A <b>?</b> means that
          model had no reliable edge for this stock. Historical markers skip bars inside a cooldown after a signal; the
          latest decision is always shown.
        </dd>
        <dt>Verdict (green / amber box)</dt>
        <dd>
          Read this first. <b>Edge found</b> means the model's past signals, made without seeing the future, beat a random
          day for this symbol. <b>No reliable edge</b> means they did not - treat that model's signals as noise, even if
          today shows a signal (its badge is then outlined instead of solid).
        </dd>
        <dt>P(…), threshold, base rate</dt>
        <dd>
          P is the model's probability that the move happens first. Base rate is how often it happened on any day. A
          signal fires when P is at least 15 points above the base rate.
        </dd>
        <dt>Hit rate vs base rate, AUC</dt>
        <dd>
          Hit rate = how often past signals worked. Compare it with the base rate. AUC measures how well the model ranks
          days: 0.50 is a coin flip, 0.55–0.60 a modest edge, above 0.65 strong (rare in markets).
        </dd>
        <dt>Signal outcomes</dt>
        <dd>
          <b>Target hit</b>: price reached the target before the stop. <b>Stopped out</b>: it fell to the stop first (a day
          touching both counts as stopped). <b>Expired</b>: neither was reached within the time limit - counted as a miss.
          For take-profits: <b>Pullback came</b> = price fell as predicted, <b>Kept rising</b> = it rose first instead.
        </dd>
        <dt>Short-term: justified?</dt>
        <dd>
          Each S entry has a <b>profit-take</b> (default +1.5 × daily ATR) and a <b>stop-loss</b> (default −1 × daily ATR) -
          set them in the short-term card and press Retrain. The entry is <b>justified</b> if the price reached the
          profit-take before the stop-loss within the next 5 trading sessions, on any chart interval. The break-even win
          rate shown next to the inputs is the share of trades that must be justified for the bracket to break even.
        </dd>
        <dt>Long-term: validated?</dt>
        <dd>
          The model chooses the L entries. Treat each as buying the same dollar amount: if the overall <b>average cost</b>
          of all those buys is below the current <b>SMA 60</b>, the long-term logic is <b>validated</b>. The comparison with
          buying on every bar shows whether the L timing really bought cheaper.
        </dd>
        <dt>Trade exit (entries)</dt>
        <dd>
          What happened if you had bought at the signal and followed the exit rules: whichever came first of the stop, the
          target, the trailing stop (protects profit once the trade is up), a take-profit signal while in profit, or the
          time limit. <b>Any-bar entry</b> applies the same exits to every bar: if signal entries do better, the entry
          timing adds value. Durations count bars of the analysed interval (d = days, w = weeks).
        </dd>
        <dt>Take-profit signals (TS / TL)</dt>
        <dd>
          Bars when a pullback of 1.5 ATR (within 5 bars) or 3 ATR (within 60 bars) was more likely than usual before a
          rise - a cue to take profit or tighten a stop on a position you already hold. Separate models with their own
          verdicts; their markers start hidden unless that model proved reliable.
        </dd>
        <dt>Interval &amp; retraining</dt>
        <dd>
          Everything is computed on the chart's own candles: horizons and ATR are counted in bars of that interval (5 bars
          = 5 trading days on Daily, 25 minutes on 5-minute bars). Each click of <b>Find entry points</b> retrains the
          models on the current range and interval. Short-interval moves are noisier, so verdicts there are often weaker.
        </dd>
        <dt>What drives this model</dt>
        <dd>
          Which factor groups carried the model's predictive power over the last year - importance, not direction.
        </dd>
      </dl>
    </details>
  );
}
