"""Settings loaded from the project-root .env file.

The .env file is re-read whenever it changes on disk, so credentials can be
edited without restarting the server.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import dotenv_values

PROJECT_ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = PROJECT_ROOT / ".env"
FRONTEND_DIR = PROJECT_ROOT / "frontend"

DATA_BASE_URL = "https://data.alpaca.markets"
DEFAULT_TRADING_URL = "https://paper-api.alpaca.markets"

# Accept the variable names people commonly use for Alpaca credentials.
KEY_NAMES = ("ALPACA_API_KEY", "ALPACA_API_KEY_ID", "APCA_API_KEY_ID", "ALPACA_KEY", "API_KEY")
SECRET_NAMES = (
    "ALPACA_SECRET_KEY",
    "ALPACA_API_SECRET",
    "ALPACA_API_SECRET_KEY",
    "APCA_API_SECRET_KEY",
    "ALPACA_SECRET",
    "API_SECRET",
    "SECRET_KEY",
)
ENDPOINT_NAMES = (
    "ALPACA_ENDPOINT",
    "ALPACA_BASE_URL",
    "ALPACA_API_BASE_URL",
    "APCA_API_BASE_URL",
    "ALPACA_URL",
    "BASE_URL",
    "ENDPOINT",
)
FEED_NAMES = ("ALPACA_DATA_FEED", "ALPACA_FEED", "DATA_FEED")


@dataclass(frozen=True)
class Settings:
    api_key: str
    secret_key: str
    trading_url: str
    data_url: str
    feed: str

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.secret_key)

    @property
    def is_paper(self) -> bool:
        return "paper" in self.trading_url


_cache: dict = {"mtime": None, "settings": None}


def _pick(values: dict, names: tuple[str, ...]) -> str:
    for name in names:
        val = values.get(name) or os.environ.get(name)
        if val:
            return val.strip().strip('"').strip("'")
    return ""


def _normalise_trading_url(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    if not url or "data.alpaca.markets" in url:
        return DEFAULT_TRADING_URL
    if not url.startswith("http"):
        url = "https://" + url
    if url.endswith("/v2"):
        url = url[:-3]
    return url


def get_settings() -> Settings:
    mtime = ENV_PATH.stat().st_mtime if ENV_PATH.exists() else None
    if _cache["settings"] is not None and _cache["mtime"] == mtime:
        return _cache["settings"]

    values = {k.upper(): v for k, v in (dotenv_values(ENV_PATH) if ENV_PATH.exists() else {}).items() if v}
    feed = (_pick(values, FEED_NAMES) or "auto").lower()
    settings = Settings(
        api_key=_pick(values, KEY_NAMES),
        secret_key=_pick(values, SECRET_NAMES),
        trading_url=_normalise_trading_url(_pick(values, ENDPOINT_NAMES)),
        data_url=DATA_BASE_URL,
        feed=feed if feed in ("iex", "sip", "auto") else "auto",
    )
    _cache.update(mtime=mtime, settings=settings)
    return settings
