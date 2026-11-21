"""HTTP transport for Alpaca REST: shared client, auth headers, error mapping."""
from __future__ import annotations

from typing import Any

import httpx

from ..core.config import Settings, get_settings
from ..core.errors import ApiError


class AlpacaError(ApiError):
    """An Alpaca request failed; `status` is passed through to our API response."""


_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=10.0))
    return _client


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _headers(s: Settings) -> dict[str, str]:
    return {"APCA-API-KEY-ID": s.api_key, "APCA-API-SECRET-KEY": s.secret_key, "Accept": "application/json"}


async def get(url: str, params: dict[str, Any] | None = None) -> Any:
    s = get_settings()
    if not s.configured:
        raise AlpacaError(
            503,
            "Alpaca credentials not found. Add ALPACA_API_KEY and ALPACA_SECRET_KEY to the .env file in the project root.",
        )
    try:
        resp = await client().get(url, params=params, headers=_headers(s))
    except httpx.HTTPError as exc:
        raise AlpacaError(502, f"Could not reach Alpaca: {exc}") from exc
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("message") or resp.text
        except ValueError:
            detail = resp.text
        raise AlpacaError(resp.status_code, f"Alpaca {resp.status_code}: {detail}")
    return resp.json()


async def data_get(path: str, params: dict[str, Any], *, sip_fallback: bool = True) -> Any:
    """GET from the market-data API. With sip_fallback, a SIP permission error retries on IEX."""
    url = f"{get_settings().data_url}{path}"
    try:
        return await get(url, params)
    except AlpacaError as exc:
        if sip_fallback and exc.status == 403 and params.get("feed") == "sip":
            return await get(url, {**params, "feed": "iex"})
        raise
