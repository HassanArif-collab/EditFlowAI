"""
EditFlow AI - FastAPI Application
Main entry point for the backend server.
"""
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import Settings, init_dirs
from .routes import chat, models_routes, media, catalog, sequence
from .routes import providers, premiere, cleanspeech, v2

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
    from .models.sqlite_registry import sqlite_registry
    sqlite_registry.initialize()
    logger.info("SQLite v2 registry initialized")

    # Initialize the multi-provider service (non-blocking)
    from .services.provider_service import provider_service
    await provider_service.initialize()
    logger.info("Provider service initialized")

    # Check provider health (non-blocking, with timeouts)
    health = await provider_service.health_check()
    for pid, info in health.items():
        status = "connected" if info.get("connected") else f"unavailable ({info.get('error', 'unknown')})"
        logger.info(f"Provider '{pid}': {status}")

    # Trigger background model discovery (don't await - let it run in background)
    import asyncio
    asyncio.create_task(_background_discover())

    yield

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
    description="AI-powered video editing assistant for Adobe Premiere Pro",
    version="0.2.0",
    lifespan=lifespan,
)

# CORS - allow CEP panel to communicate
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8765", "http://127.0.0.1:8765", "null"],
    allow_origin_regex=r"^(https?://(localhost|127\.0\.0\.1)(:\d+)?|file://.*|cep-extension://.*)$",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routes
app.include_router(chat.router, prefix="/api")
app.include_router(models_routes.router, prefix="/api")
app.include_router(media.router, prefix="/api")
app.include_router(catalog.router, prefix="/api")
app.include_router(sequence.router, prefix="/api")
app.include_router(providers.router, prefix="/api")
app.include_router(premiere.router, prefix="/api/project")
app.include_router(cleanspeech.router, prefix="/api")
app.include_router(v2.router, prefix="/api")


@app.get("/")
async def root():
    return {
        "name": "EditFlow AI",
        "version": "0.2.0",
        "status": "running",
        "docs": "/docs",
        "multi_provider": True,
    }


@app.get("/api/status")
async def status():
    """Full system status check."""
    from .services.provider_service import provider_service
    from .services.whisper_service import whisper_service

    # Provider health (non-blocking with timeout)
    provider_health = await provider_service.health_check()

    # Check if any provider is connected
    any_connected = any(h.get("connected") for h in provider_health.values())

    active_chat = provider_service.get_active_chat()
    active_vision = provider_service.get_active_vision()

    # Build provider summary
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
        "version": "0.2.0",
        "multi_provider": True,
        "any_provider_connected": any_connected,
        "providers": providers_summary,
        "active_chat": active_chat,
        "active_vision": active_vision,
        "whisper_loaded": whisper_loaded,
        # Legacy compat
        "ollama_local": providers_summary.get("ollama-local", {}).get("connected", False),
        "ollama_cloud": any(
            v.get("connected") and v.get("type") != "ollama"
            for v in providers_summary.values()
        ),
        "active_chat_model": active_chat.get("model", ""),
        "active_vision_model": active_vision.get("model", ""),
    }


def run_server():
    """Run the development server."""
    import uvicorn
    settings = Settings()
    uvicorn.run(
        "backend.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=settings.DEBUG,
        reload_dirs=["backend", "cep-panel"] if settings.DEBUG else None,
        reload_excludes=["data/*", "data/**", "*.json"] if settings.DEBUG else None,
    )


if __name__ == "__main__":
    run_server()
