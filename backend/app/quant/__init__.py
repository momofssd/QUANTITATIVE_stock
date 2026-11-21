"""Quantitative entry-point analysis (pure computation; data is passed in).

targets   - TargetSpec (SHORT entry: profit-take / stop-loss in daily ATR within 20 sessions; TP_SHORT pullback),
            ATR, session / bar horizons, triple-barrier labels
trades    - bracket-order (and optional trailing-stop) trade simulation
features  - model inputs from the stock + SPY / QQQ / VIX / oil / gasoline / rate, grouped for reporting
model     - walk-forward HistGradientBoosting, latest model, grouped permutation importance
relations - correlation / beta / lead correlation of the stock with each factor
"""
