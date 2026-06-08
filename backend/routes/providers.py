"""
EditFlow AI - Provider Management API Routes
CRUD operations for LLM providers, model discovery, and testing.
"""
import logging
from typing import List, Optional

from fastapi import APIRouter, HTTPException

from ..models.schemas import (
    APIResponse, ModelInfo, ProviderConfig, ProviderInfo, ProviderTestResult,
    SetActiveModelRequest,
)
from ..services.provider_service import provider_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/providers", tags=["providers"])


# ── Provider CRUD ──

@router.get("", response_model=List[ProviderInfo])
async def list_providers():
    """List all configured providers with their status."""
    providers = await provider_service.list_providers()
    return [
        ProviderInfo(
            id=p["id"],
            name=p.get("name", ""),
            type=p.get("type", "openai_compatible"),
            base_url=p.get("base_url", ""),
            api_key_set=bool(p.get("api_key")),
            timeout=p.get("timeout", 10),
            enabled=p.get("enabled", True),
            is_default=p.get("is_default", False),
            status=p.get("status", "unknown"),
            last_checked=p.get("last_checked"),
            error=p.get("error"),
            models=p.get("models", []),
            chat_model=p.get("chat_model", ""),
            vision_model=p.get("vision_model", ""),
            is_active_chat=p.get("is_active_chat", False),
            is_active_vision=p.get("is_active_vision", False),
        )
        for p in providers
    ]


@router.get("/{provider_id}", response_model=ProviderInfo)
async def get_provider(provider_id: str):
    """Get a specific provider's configuration and status."""
    p = await provider_service.get_provider(provider_id)
    if not p:
        raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")
    return ProviderInfo(
        id=p["id"],
        name=p.get("name", ""),
        type=p.get("type", "openai_compatible"),
        base_url=p.get("base_url", ""),
        api_key_set=bool(p.get("api_key")),
        timeout=p.get("timeout", 10),
        enabled=p.get("enabled", True),
        is_default=p.get("is_default", False),
        status=p.get("status", "unknown"),
        last_checked=p.get("last_checked"),
        error=p.get("error"),
        models=p.get("models", []),
        chat_model=p.get("chat_model", ""),
        vision_model=p.get("vision_model", ""),
        is_active_chat=p.get("is_active_chat", False),
        is_active_vision=p.get("is_active_vision", False),
    )


@router.post("", response_model=ProviderInfo)
async def add_provider(config: ProviderConfig):
    """Add a new LLM provider.

    Supported provider types:
    - ollama: Local or remote Ollama instance
    - openai_compatible: Any OpenAI-compatible API (OpenAI, Groq, Together, etc.)
    - custom: Custom provider with manual configuration
    """
    try:
        p = await provider_service.add_provider(config.model_dump())
        return ProviderInfo(
            id=p["id"],
            name=p.get("name", ""),
            type=p.get("type", "openai_compatible"),
            base_url=p.get("base_url", ""),
            api_key_set=bool(p.get("api_key")),
            timeout=p.get("timeout", 10),
            enabled=p.get("enabled", True),
            is_default=p.get("is_default", False),
            status=p.get("status", "unknown"),
            last_checked=p.get("last_checked"),
            error=p.get("error"),
            models=p.get("models", []),
            chat_model=p.get("chat_model", ""),
            vision_model=p.get("vision_model", ""),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/{provider_id}", response_model=ProviderInfo)
async def update_provider(provider_id: str, config: ProviderConfig):
    """Update a provider's configuration.

    Only the fields provided in the config will be updated.
    The API key is never returned but can be updated.
    """
    try:
        updates = config.model_dump(exclude_unset=True, exclude_none=True)
        # Don't clear api_key if not provided
        if "api_key" not in updates and config.api_key is not None:
            updates["api_key"] = config.api_key
        p = await provider_service.update_provider(provider_id, updates)
        return ProviderInfo(
            id=p["id"],
            name=p.get("name", ""),
            type=p.get("type", "openai_compatible"),
            base_url=p.get("base_url", ""),
            api_key_set=bool(p.get("api_key")),
            timeout=p.get("timeout", 10),
            enabled=p.get("enabled", True),
            is_default=p.get("is_default", False),
            status=p.get("status", "unknown"),
            last_checked=p.get("last_checked"),
            error=p.get("error"),
            models=p.get("models", []),
            chat_model=p.get("chat_model", ""),
            vision_model=p.get("vision_model", ""),
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.delete("/{provider_id}")
async def remove_provider(provider_id: str):
    """Remove a provider configuration."""
    try:
        success = await provider_service.remove_provider(provider_id)
        if success:
            return {"success": True, "removed": provider_id}
        raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ── Health & Discovery ──

@router.get("/health/all")
async def check_all_health():
    """Check health of all providers concurrently. Never blocks."""
    return await provider_service.health_check()


@router.get("/{provider_id}/health")
async def check_provider_health(provider_id: str):
    """Check health of a specific provider."""
    result = await provider_service.health_check(provider_id)
    return result


@router.post("/{provider_id}/discover", response_model=List[ModelInfo])
async def discover_models(provider_id: str, force: bool = False):
    """Discover available models from a provider.

    Uses cached results by default. Set force=True to bypass cache.
    """
    try:
        models = await provider_service.discover_models(provider_id, force=force)
        p = await provider_service.get_provider(provider_id) or {}
        active = provider_service.get_active_chat()

        return [
            ModelInfo(
                id=m.get("id", ""),
                name=m.get("name", m.get("id", "")),
                provider_id=provider_id,
                provider_name=p.get("name", provider_id),
                provider_type=m.get("provider_type", p.get("type", "unknown")),
                size=m.get("size", ""),
                is_vision=m.get("is_vision", False),
                is_local=m.get("is_local", False),
                is_active_chat=(provider_id == active["provider_id"] and m.get("id") == active["model"]),
            )
            for m in models
        ]
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/{provider_id}/test", response_model=ProviderTestResult)
async def test_provider(provider_id: str, prompt: str = "Hello, respond with 'EditFlow AI is working!'"):
    """Test a provider by sending a simple chat prompt."""
    result = await provider_service.test_provider(provider_id, prompt)
    return ProviderTestResult(**result)


# ── Active Model Selection ──

@router.post("/set-active")
async def set_active_model(request: SetActiveModelRequest):
    """Set the active chat or vision model."""
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


# ── Model Pull/Delete (Ollama only) ──

@router.post("/{provider_id}/pull/{model_name}")
async def pull_model(provider_id: str, model_name: str):
    """Pull/download a model from an Ollama provider."""
    progress_updates = []
    try:
        async for update in provider_service.pull_model(provider_id, model_name):
            progress_updates.append(update)
        return {"success": True, "model": model_name, "updates": progress_updates[-5:]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to pull model: {e}")


@router.delete("/{provider_id}/models/{model_name}")
async def delete_model(provider_id: str, model_name: str):
    """Delete a model from an Ollama provider."""
    success = await provider_service.delete_model(provider_id, model_name)
    if success:
        return {"success": True, "deleted": model_name}
    raise HTTPException(status_code=500, detail=f"Failed to delete model {model_name}")
