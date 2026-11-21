"""Alpaca REST access.

http        - transport, auth headers, AlpacaError
market_data - raw bars / snapshot calls for a given feed
feeds       - feed selection (auto/iex/sip) and the SIP+IEX hybrid
trading     - clock, asset lookup, asset list (reference data only)
"""
from .http import AlpacaError

__all__ = ["AlpacaError"]
