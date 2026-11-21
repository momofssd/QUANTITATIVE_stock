"""Time-zone helpers. All market times are US Eastern; the chart encodes ET wall-clock time as epoch seconds."""
from __future__ import annotations

import numpy as np
import pandas as pd

ET = "America/New_York"
EARLIEST = pd.Timestamp("2016-01-01", tz=ET)  # Alpaca history begins Jan 2016 (SIP) / Jul 2020 (IEX)


def now_et() -> pd.Timestamp:
    return pd.Timestamp.now(tz=ET)


def iso(ts: pd.Timestamp) -> str:
    """UTC ISO-8601 string Alpaca accepts, e.g. 2026-01-02T14:30:00Z."""
    return ts.tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")


def et_epoch(index: pd.DatetimeIndex) -> np.ndarray:
    """Epoch seconds of the *New York wall-clock* time, so a chart that renders UTC shows ET."""
    return (index.tz_convert(ET).tz_localize(None).asi8 // 10**9).astype("int64")


def et_date(iso_ts: str):
    return pd.Timestamp(iso_ts).tz_convert(ET).date()
