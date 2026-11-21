"""Alpaca bar dicts -> pandas DataFrame."""
from __future__ import annotations

import numpy as np
import pandas as pd

COLUMNS = ["open", "high", "low", "close", "volume", "bar_vwap", "trades"]


def bars_frame(bars: list[dict]) -> pd.DataFrame:
    """UTC-indexed OHLCV frame (deduplicated, sorted). Columns: open high low close volume bar_vwap trades."""
    df = pd.DataFrame(bars).rename(columns={
        "t": "ts", "o": "open", "h": "high", "l": "low", "c": "close", "v": "volume", "vw": "bar_vwap", "n": "trades",
    })
    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    df = df.drop_duplicates("ts").set_index("ts").sort_index()
    for col in ("bar_vwap", "trades"):
        if col not in df:
            df[col] = np.nan
    return df[COLUMNS]
