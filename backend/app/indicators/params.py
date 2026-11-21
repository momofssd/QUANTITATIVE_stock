"""Indicator settings (lengths in bars) and their validation from query-string values."""
from __future__ import annotations

from dataclasses import asdict, dataclass

MAX_PERIOD = 500


@dataclass(frozen=True)
class IndicatorParams:
    sma: tuple[int, int, int] = (20, 50, 200)
    ema: tuple[int, int] = (12, 26)
    bb_len: int = 20
    bb_mult: float = 2.0
    rsi: int = 14
    macd: tuple[int, int, int] = (12, 26, 9)  # fast, slow, signal

    def warmup_bars(self) -> int:
        """Bars needed before the first visible bar for every line to be fully formed.

        Exponential averages need ~3x their length to converge, simple ones exactly their length.
        """
        simple = max(*self.sma, self.bb_len)
        expo = 3 * max(*self.ema, self.rsi, self.macd[1] + self.macd[2])
        return max(simple, expo)

    def to_dict(self) -> dict:
        return asdict(self)


def _ints(raw: str | None, n: int, default: tuple[int, ...], name: str) -> tuple[int, ...]:
    if not raw:
        return default
    try:
        vals = tuple(int(v) for v in raw.split(","))
    except ValueError:
        raise ValueError(f"{name} must be {n} comma-separated whole numbers.") from None
    if len(vals) != n or not all(1 <= v <= MAX_PERIOD for v in vals):
        what = "a whole number" if n == 1 else f"{n} whole numbers"
        raise ValueError(f"{name} must be {what} between 1 and {MAX_PERIOD}.")
    return vals


def parse_params(sma: str | None, ema: str | None, bb: str | None, rsi: str | None, macd: str | None) -> IndicatorParams:
    d = IndicatorParams()
    bb_len, bb_mult = d.bb_len, d.bb_mult
    if bb:
        parts = bb.split(",")
        try:
            bb_len, bb_mult = int(parts[0]), float(parts[1]) if len(parts) > 1 else d.bb_mult
        except ValueError:
            raise ValueError("bb must be 'length,multiplier', e.g. 20,2") from None
        if not (2 <= bb_len <= MAX_PERIOD and 0.1 <= bb_mult <= 5):
            raise ValueError(f"Bollinger length must be 2-{MAX_PERIOD} and multiplier 0.1-5.")
    macd_v = _ints(macd, 3, d.macd, "macd")
    if macd_v[0] >= macd_v[1]:
        raise ValueError("MACD fast length must be shorter than slow length.")
    return IndicatorParams(
        sma=_ints(sma, 3, d.sma, "sma"),
        ema=_ints(ema, 2, d.ema, "ema"),
        bb_len=bb_len,
        bb_mult=bb_mult,
        rsi=_ints(rsi, 1, (d.rsi,), "rsi")[0],
        macd=macd_v,
    )
