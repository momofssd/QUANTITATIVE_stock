"""HTTP + WebSocket layer: thin routes that validate input and call services."""
from fastapi import APIRouter

from .routes import analysis, bars, live, quote, search, system

api_router = APIRouter()
for _module in (system, search, quote, bars, analysis, live):
    api_router.include_router(_module.router)

__all__ = ["api_router"]
