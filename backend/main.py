"""
EditFlow AI - FastAPI Application
Simplified video editing pipeline: analyze, cut, place visuals.
"""
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

import os

from .config import init_dirs
from .routes import agent, chat, diag, edit, external_plan, media, models_routes, pipeline, preflight, premiere, providers, review, script_extract, subtitles, whisper_admin


def _bridge_enabled() -> bool:
    """AE agent bridge is opt-in: eval-over-HTTP must never ship on by default."""
    return os.environ.get("EDITFLOW_AGENT_BRIDGE") == "1"

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup/shutdown."""
    logger.info("EditFlow AI starting up...")
    init_dirs()

    # Attach the rotating file handler so relayed panel/jsx events actually
    # land in data/logs/editflow.log (diag /log/tail reads that file).
    from .utils.logsink import init_file_logging
    init_file_logging()

    from .models.sqlite_registry import sqlite_registry
    sqlite_registry.initialize()
    logger.info("SQLite registry initialized")

    # Initialize the multi-provider service
    from .services.provider_service import provider_service
    await provider_service.initialize()
    logger.info("Provider service initialized")

    # Check provider health
    health = await provider_service.health_check()
    for pid, info in health.items():
        status = "connected" if info.get("connected") else f"unavailable ({info.get('error', 'unknown')})"
        logger.info(f"Provider '{pid}': {status}")

    # Background model discovery â€” keep a strong reference so the task
    # isn't garbage-collected and so we can cancel it on shutdown.
    import asyncio
    discovery_task = asyncio.create_task(_background_discover())
    app.state.discovery_task = discovery_task

    # Dev-only agent loop: file watcher pushing dev_reload to the panel.
    watch_task = None
    if _bridge_enabled():
        from .services.dev_watch import watch_panel_files
        watch_task = asyncio.create_task(
            watch_panel_files(Path(__file__).parent.parent)
        )
        app.state.dev_watch_task = watch_task
        logger.info("AE agent bridge enabled (/api/ae-bridge) + panel file watcher")

    yield

    for task in (discovery_task, watch_task):
        if task and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    try:
        await provider_service.shutdown()
    except Exception as e:
        logger.warning(f"Provider service shutdown error: {e}")

    logger.info("EditFlow AI shutting down...")


async def _background_discover():
    """Discover models from all providers in the background."""
    try:
        from .services.provider_service import provider_service
        results = await provider_service.discover_all_models()
        total = sum(len(models) for models in results.values())
        logger.info(f"Background model discovery complete: {total} models found across {len(results)} provider(s)")
    except Exception as e:
        logger.warning(f"Background model discovery failed: {e}")


# Create FastAPI app
app = FastAPI(
    title="EditFlow AI",
    description="AI-powered video editing: analyze, cut, and place visuals",
    version="2.0.0",
    lifespan=lifespan,
)

# CORS â€” allow local browser tooling and Adobe CEP's local-file origin.
# CEP loads the panel from the extension folder, so fetch() requests can arrive
# with Origin: null. Without this, the Scan Project button can fail at /api/ping
# before it ever reaches the Premiere project scanner.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8765", "http://127.0.0.1:8765", "null"],
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Client-Id"],
)

# Register routes
app.include_router(chat.router, prefix="/api")
app.include_router(models_routes.router, prefix="/api")
app.include_router(media.router, prefix="/api")
app.include_router(providers.router, prefix="/api")
app.include_router(pipeline.router, prefix="/api")
app.include_router(premiere.router, prefix="/api")
app.include_router(preflight.router, prefix="/api")
app.include_router(edit.router, prefix="/api")
app.include_router(agent.router, prefix="/api")
app.include_router(external_plan.router, prefix="/api")
app.include_router(review.router, prefix="/api")
app.include_router(script_extract.router)
app.include_router(whisper_admin.router, prefix="/api")
app.include_router(subtitles.router, prefix="/api")
app.include_router(diag.router, prefix="/api")
if _bridge_enabled():
    from .routes import ae_bridge
    app.include_router(ae_bridge.router, prefix="/api")

panel_dir = Path(__file__).parent.parent / "cep-panel" / "client"
if panel_dir.exists():
    # Subclass StaticFiles to set no-cache headers on panel assets.
    # The CEP runtime (CEF/Chromium) caches ES module imports aggressively â€”
    # `import { foo } from './bar.js'` has no version query, so once bar.js
    # is fetched it's reused indefinitely. That meant every backend code
    # fix that touched a non-main.js module silently failed to reach the
    # panel until users blew away CEF cache manually. With no-store +
    # must-revalidate, a panel close+reopen always pulls the latest code.
    class _NoCacheStatic(StaticFiles):
        async def get_response(self, path, scope):
            response = await super().get_response(path, scope)
            # Set on 200/206 responses; let 304/404 etc. pass through unchanged.
            if response.status_code in (200, 206):
                response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
                response.headers["Pragma"] = "no-cache"
                response.headers["Expires"] = "0"
                response.headers["Access-Control-Allow-Origin"] = "*"
                response.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
                response.headers["Access-Control-Allow-Headers"] = "Content-Type"
            return response
    app.mount("/panel", _NoCacheStatic(directory=panel_dir, html=True), name="panel")
# Serve the After Effects CEP panel client (cep-panel-ae/client)
panel_ae_dir = Path(__file__).parent.parent / "cep-panel-ae" / "client"
if panel_ae_dir.exists():
    app.mount("/panel-ae", _NoCacheStatic(directory=panel_ae_dir, html=True), name="panel-ae")


@app.get("/")
async def root():
    return {
        "name": "EditFlow AI",
        "version": "2.0.0",
        "description": "AI-powered video editing pipeline",
        "features": [
            "Video analysis (transcription, filler detection)",
            "Script-based auto-cutting (Urdu video + English script)",
            "Visual placement from mapping documents",
            "Multi-provider LLM management",
            "AI chat for editing decisions",
            "Premiere Pro CEP panel integration",
        ],
        "docs": "/docs",
    }


@app.get("/api/ping")
async def ping():
    """Cheap liveness check."""
    return {
        "server": "running",
        "version": "2.0.0",
    }


@app.get("/api/status")
async def status():
    """Full system status check."""
    from .services.provider_service import provider_service
    from .services.whisper_service import whisper_service

    provider_health = await provider_service.health_check()
    any_connected = any(h.get("connected") for h in provider_health.values())

    active_chat = provider_service.get_active_chat()
    active_vision = provider_service.get_active_vision()

    providers_summary = {}
    for pid, info in provider_health.items():
        p = await provider_service.get_provider(pid)
        providers_summary[pid] = {
            "name": p.get("name", pid) if p else pid,
            "type": p.get("type", "") if p else "",
            "connected": info.get("connected", False),
            "error": info.get("error"),
        }

    whisper_loaded = whisper_service._model is not None

    return {
        "server": "running",
        "version": "2.0.0",
        "any_provider_connected": any_connected,
        "providers": providers_summary,
        "active_chat": active_chat,
        "active_vision": active_vision,
        "whisper_loaded": whisper_loaded,
    }


def run_server():
    """Run the development server."""
    import uvicorn
    from .config import get_settings
    settings = get_settings()
    uvicorn.run(
        "backend.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=settings.DEBUG,
        reload_dirs=["backend"] if settings.DEBUG else None,
        reload_excludes=["data/*", "data/**", "*.json"] if settings.DEBUG else None,
    )


if __name__ == "__main__":
    run_server()
