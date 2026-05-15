"""
EditFlow AI - Model Management API Routes
Updated to use the multi-provider service.
"""
import asyncio
import logging
from typing import List, Optional

from fastapi import APIRouter, HTTPException

from ..models.schemas import (
    APIResponse, ModelInfo, ModelListResponse, OllamaModel,
    ProviderInfo, SetActiveModelRequest,
)
from ..services.ollama_service import ollama_service
from ..services.provider_service import provider_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/models", tags=["models"])


@router.get("/health")
async def check_health():
    """Check health of all LLM providers. Never blocks."""
    return await provider_service.health_check()


@router.get("/list")
async def list_models():
    """List all available models from all providers.

    Returns both the legacy format (local_models, cloud_models)
    and the new multi-provider format (providers with their models).
    """
    await provider_service.initialize()

    active_chat = provider_service.get_active_chat()
    active_vision = provider_service.get_active_vision()
    providers = await _get_providers_with_models()

    # Legacy format for backward compatibility, derived from the provider list
    # without triggering a second round of network discovery.
    local = []
    cloud = []
    for provider in providers:
        target = local if provider.get("type") == "ollama" else cloud
        for model in provider.get("models", []):
            target.append({
                "name": model.get("id") or model.get("name", ""),
                "size": model.get("size", ""),
                "modified_at": model.get("modified_at", ""),
                "is_local": provider.get("type") == "ollama",
                "is_vision": model.get("is_vision", False),
                "is_downloaded": provider.get("type") == "ollama",
                "status": "ready" if provider.get("type") == "ollama" else "available",
            })

    return {
        # Legacy format
        "local_models": local,
        "cloud_models": cloud,
        "active_chat_model": active_chat.get("model", ""),
        "active_vision_model": active_vision.get("model", ""),
        # New multi-provider format
        "active_chat_provider": active_chat.get("provider_id"),
        "active_vision_provider": active_vision.get("provider_id"),
        "providers": providers,
    }


async def _get_providers_with_models() -> List[dict]:
    """Get all providers with their models for the model selector."""
    providers = await provider_service.list_providers()
    enabled_providers = [p for p in providers if p.get("enabled", True)]

    async def build_provider_info(p: dict) -> dict:
        # Prefer cached/configured models so the selector stays responsive.
        models = provider_service.get_cached_or_configured_models(p["id"])

        # If there is no cache or manual model yet, allow a short best-effort
        # discovery. Full refresh remains available via /models/refresh or the
        # provider Refresh button.
        if not models:
            try:
                timeout = min(float(p.get("timeout", 10)), 3.0)
                models = await asyncio.wait_for(
                    provider_service.discover_models(p["id"]),
                    timeout=max(timeout, 1.0),
                )
            except Exception as e:
                logger.info(f"Model discovery skipped for {p['id']}: {e}")
                models = provider_service.get_cached_or_configured_models(p["id"])

        return {
            "id": p["id"],
            "name": p.get("name", ""),
            "type": p.get("type", ""),
            "status": p.get("status", "unknown"),
            "error": p.get("error"),
            "is_active_chat": p.get("is_active_chat", False),
            "is_active_vision": p.get("is_active_vision", False),
            "models": models,
        }

    return await asyncio.gather(*(build_provider_info(p) for p in enabled_providers))


@router.post("/set-chat")
async def set_chat_model(model_name: str, provider_id: Optional[str] = None):
    """Set the active chat model.

    Args:
        model_name: Name of the model
        provider_id: Provider ID (defaults to active chat provider)
    """
    pid = provider_id or provider_service.get_active_chat().get("provider_id")
    if pid:
        provider_service.set_active_chat(pid, model_name)
    else:
        # Fallback to ollama-local for backward compat
        provider_service.set_active_chat("ollama-local", model_name)
    return {"success": True, "active_chat_model": model_name, "provider_id": pid}


@router.post("/set-vision")
async def set_vision_model(model_name: str, provider_id: Optional[str] = None):
    """Set the active vision model."""
    pid = provider_id or provider_service.get_active_vision().get("provider_id")
    if pid:
        provider_service.set_active_vision(pid, model_name)
    else:
        provider_service.set_active_vision("ollama-local", model_name)
    return {"success": True, "active_vision_model": model_name, "provider_id": pid}


@router.post("/set-active")
async def set_active_model(request: SetActiveModelRequest):
    """Set the active chat or vision model with explicit provider."""
    if request.role == "chat":
        provider_service.set_active_chat(request.provider_id, request.model)
    elif request.role == "vision":
        provider_service.set_active_vision(request.provider_id, request.model)
    else:
        raise HTTPException(status_code=400, detail="role must be 'chat' or 'vision'")

    return {
        "success": True,
        "role": request.role,
        "provider_id": request.provider_id,
        "model": request.model,
    }


@router.post("/refresh")
async def refresh_models():
    """Force refresh model lists from all providers."""
    try:
        results = await provider_service.discover_all_models(force=True)
        total = sum(len(models) for models in results.values())
        return {
            "success": True,
            "providers_refreshed": len(results),
            "total_models": total,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/pull/{model_name}")
async def pull_model(model_name: str, provider_id: str = "ollama-local"):
    """Pull/download a model from an Ollama provider."""
    progress_updates = []
    try:
        async for update in provider_service.pull_model(provider_id, model_name):
            progress_updates.append(update)
        return {"success": True, "model": model_name, "updates": progress_updates[-5:]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to pull model: {e}")


@router.delete("/delete/{model_name}")
async def delete_model(model_name: str, provider_id: str = "ollama-local"):
    """Delete a local model."""
    success = await provider_service.delete_model(provider_id, model_name)
    if success:
        return {"success": True, "deleted": model_name}
    raise HTTPException(status_code=500, detail=f"Failed to delete model {model_name}")


@router.post("/test")
async def test_model(
    model_name: Optional[str] = None,
    prompt: str = "Hello, respond with 'EditFlow AI is working!'",
    provider_id: Optional[str] = None,
):
    """Test a model with a simple prompt."""
    try:
        pid = provider_id or provider_service.get_active_chat().get("provider_id")
        if pid:
            result = await provider_service.test_provider(pid, prompt)
            return result
        else:
            # Use old fallback
            result = await ollama_service.chat_with_fallback(
                messages=[{"role": "user", "content": prompt}],
                model=model_name,
                temperature=0.3,
                max_tokens=100,
            )
            return {
                "success": bool(result["response"]),
                "response": result["response"],
                "source": result["source"],
                "error": result.get("error"),
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
