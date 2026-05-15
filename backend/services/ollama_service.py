"""
EditFlow AI - Ollama Service (Compatibility Layer)
Delegates to the multi-provider service for backward compatibility.
The actual provider logic is now in provider_service.py.
"""
import asyncio
import logging
from typing import Any, AsyncGenerator, Dict, List, Optional

from ..config import Settings
from ..models.schemas import OllamaModel

logger = logging.getLogger(__name__)





class OllamaService:
    """Compatibility wrapper that delegates to ProviderService.

    This class maintains the same API as the original OllamaService
    but routes all calls through the multi-provider service.
    """

    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or Settings()

    @property
    def _provider_service(self):
        """Lazy import to avoid circular dependencies."""
        from .provider_service import provider_service
        return provider_service

    # ── Health Check ──

    async def health_check(self) -> Dict[str, Any]:
        """Check if any LLM provider is running and responsive."""
        result = await self._provider_service.health_check()
        # Map to old format for backward compatibility
        has_local = False
        has_cloud = False
        for pid, info in result.items():
            if info.get("connected"):
                p = await self._provider_service.get_provider(pid)
                if p and p.get("type") == "ollama":
                    has_local = True
                else:
                    has_cloud = True
        return {"local": has_local, "cloud": has_cloud}

    # ── Chat (non-streaming) ──

    async def chat(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        system: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        use_cloud: bool = False,
    ) -> str:
        """Send a chat completion request via the active provider."""
        result = await self._provider_service.chat(
            messages=messages,
            model=model,
            system=system,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        response = result.get("response", "")
        if not response and result.get("error"):
            raise ConnectionError(result["error"])
        return response

    # ── Streaming Chat ──

    async def chat_stream(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        system: Optional[str] = None,
        temperature: float = 0.7,
    ) -> AsyncGenerator[str, None]:
        """Stream chat response token by token."""
        async for token in self._provider_service.chat_stream(
            messages=messages,
            model=model,
            system=system,
            temperature=temperature,
        ):
            yield token

    # ── Vision ──

    async def analyze_images(
        self,
        images_b64: List[str],
        prompt: str,
        model: Optional[str] = None,
    ) -> str:
        """Analyze images with a vision model."""
        return await self._provider_service.analyze_images(
            images_b64=images_b64,
            prompt=prompt,
            model=model,
        )

    # ── Model Management ──

    async def list_local_models(self) -> List[OllamaModel]:
        """List all locally available Ollama models."""
        try:
            models = await self._provider_service.discover_models("ollama-local")
            return [
                OllamaModel(
                    name=m.get("id", ""),
                    size=m.get("size", ""),
                    modified_at=m.get("modified_at", ""),
                    is_local=True,
                    is_vision=m.get("is_vision", False),
                    is_downloaded=True,
                    status="ready",
                )
                for m in models
            ]
        except Exception as e:
            logger.error(f"Failed to list local models: {e}")
            return []

    async def list_cloud_models(self) -> List[OllamaModel]:
        """List available cloud models from non-Ollama providers."""
        try:
            all_models = await self._provider_service.discover_all_models()
            result = []
            for pid, models in all_models.items():
                if pid == "ollama-local":
                    continue
                for m in models:
                    result.append(OllamaModel(
                        name=m.get("id", ""),
                        size=m.get("size", ""),
                        modified_at=m.get("modified_at", ""),
                        is_local=False,
                        is_vision=m.get("is_vision", False),
                        is_downloaded=False,
                        status="available",
                    ))
            return result
        except Exception as e:
            logger.error(f"Failed to list cloud models: {e}")
            return []

    async def pull_model(self, model_name: str) -> AsyncGenerator[Dict, None]:
        """Pull/download a model from Ollama registry."""
        async for update in self._provider_service.pull_model("ollama-local", model_name):
            yield update

    async def delete_model(self, model_name: str) -> bool:
        """Delete a local model."""
        return await self._provider_service.delete_model("ollama-local", model_name)

    # ── Active Model Management ──

    def set_active_chat_model(self, model_name: str):
        """Set the active chat model (on the ollama-local provider)."""
        self._provider_service.set_active_chat("ollama-local", model_name)

    def set_active_vision_model(self, model_name: str):
        """Set the active vision model (on the ollama-local provider)."""
        self._provider_service.set_active_vision("ollama-local", model_name)

    def get_active_chat_model(self) -> str:
        """Get the active chat model name."""
        return self._provider_service.get_active_chat().get("model", "")

    def get_active_vision_model(self) -> str:
        """Get the active vision model name."""
        return self._provider_service.get_active_vision().get("model", "")

    # ── Fallback Chat ──

    async def chat_with_fallback(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        system: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: int = 4096,
    ) -> Dict[str, Any]:
        """Chat with automatic fallback through all configured providers.

        Returns:
            Dict with 'response', 'source' ('local', 'cloud', or 'rule_based'),
            and 'error' if any
        """
        result = await self._provider_service.chat(
            messages=messages,
            model=model,
            system=system,
            temperature=temperature,
            max_tokens=max_tokens,
        )

        # Map to old response format
        source = result.get("source", "rule_based")
        if source == "ollama":
            source = "local"
        elif source == "openai_compatible":
            source = "cloud"

        return {
            "response": result.get("response", ""),
            "source": source,
            "error": result.get("error"),
        }


# Global service instance (compatibility)
ollama_service = OllamaService()
