"""Quantitative entry-point analysis (pure computation; data is passed in).

targets   - TargetSpec (SHORT: +1.5 ATR / -1 ATR in 5 days, LONG: +3 ATR / -2 ATR in 60 days), ATR, triple-barrier labels
features  - model inputs from the stock + SPY / QQQ / VIX / oil / gasoline / rate, grouped for reporting
model     - walk-forward HistGradientBoosting, latest model, grouped permutation importance
relations - correlation / beta / lead correlation of the stock with each factor
"""
