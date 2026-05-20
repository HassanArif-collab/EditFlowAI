"""
EditFlow AI - FastAPI Application
Simplified video editing pipeline: analyze, cut, place visuals.
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import init_dirs
from .routes import chat, media, models_routes, pipeline, premiere, providers

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

    # Background model discovery
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
    description="AI-powered video editing: analyze, cut, and place visuals",
    version="2.0.0",
    lifespan=lifespan,
)

# CORS - allow local connections
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8765", "http://127.0.0.1:8765", "null"],
    allow_origin_regex=r"^(https?://(localhost|127\.0\.0\.1)(:\d+)?|file://.*)$",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routes
app.include_router(chat.router, prefix="/api")
app.include_router(models_routes.router, prefix="/api")
app.include_router(media.router, prefix="/api")
app.include_router(providers.router, prefix="/api")
app.include_router(pipeline.router, prefix="/api")
app.include_router(premiere.router, prefix="/api")


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
    from .config import Settings
    settings = Settings()
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
