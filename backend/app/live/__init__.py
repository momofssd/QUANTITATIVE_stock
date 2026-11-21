"""Live market data over WebSockets.

hub - LiveHub: one upstream Alpaca stream connection, fanned out to browser sockets; reconnects with exactly
      the watched symbols whenever that set changes (switching ticker closes the old connection).
"""
from .hub import LiveHub, hub

__all__ = ["LiveHub", "hub"]
