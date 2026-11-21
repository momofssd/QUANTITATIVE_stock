"""FastAPI application factory.

Run from the project root:
    python -m uvicorn backend.app.main:app --reload --port 8000

Serves the API (/api/*), the live WebSocket (/ws/live/*) and, in production, the built React app
from frontend/dist. During frontend development Vite serves the UI and proxies /api and /ws here.
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response

from .alpaca_api import http as alpaca_http
from .api import api_router
from .core.config import FRONTEND_DIST
from .core.errors import install_error_handlers
from .live import hub

NOT_BUILT = """<!doctype html><meta charset="utf-8"><title>Frontend not built</title>
<body style="font:15px/1.5 Helvetica,Arial,sans-serif;max-width:640px;margin:60px auto;color:#222">
<h2 style="color:#368727">The React frontend has not been built yet</h2>
<p>For development run <code>npm run dev</code> in <code>frontend/</code> and open
<a href="http://127.0.0.1:5173">http://127.0.0.1:5173</a>.</p>
<p>To serve it from this server run <code>npm run build</code> in <code>frontend/</code>, then reload this page.</p>
<p>The API is up: <a href="/api/health">/api/health</a> &middot; <a href="/docs">/docs</a></p></body>"""


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await hub.shutdown()
    await alpaca_http.close()


def create_app() -> FastAPI:
    app = FastAPI(title="Quant Trading Model V3", lifespan=lifespan)
    install_error_handlers(app)
    app.include_router(api_router)

    @app.get("/{path:path}", include_in_schema=False)
    async def frontend(path: str) -> Response:
        """Built React app (checked per request, so building while the server runs just works)."""
        if path.startswith(("api/", "ws/")):
            return JSONResponse(status_code=404, content={"detail": "Not found"})
        index = FRONTEND_DIST / "index.html"
        if not index.exists():
            return HTMLResponse(NOT_BUILT)
        file = (FRONTEND_DIST / path).resolve()
        if path and file.is_file() and FRONTEND_DIST.resolve() in file.parents:
            return FileResponse(file)
        return FileResponse(index)  # single-page app: unknown paths render the app

    return app


app = create_app()
