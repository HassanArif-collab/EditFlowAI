"""
EditFlow AI - Multi-Provider Service
Manages connections to multiple LLM providers (Ollama, OpenAI-compatible, etc.).
Inspired by opencode's lazy SDK registry and Roo-Code's factory + cache architecture.

Key patterns:
- Provider registry with persistent configuration
- Auto-discovery of models from any OpenAI-compatible /v1/models or Ollama /api/tags
- Per-provider timeouts to prevent hanging
- Health checks that don't block the event loop
- Graceful degradation when providers are unavailable
- Two-layer model cache (memory + disk)
"""
import asyncio
import base64
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncGenerator, Dict, List, Optional

import httpx

from ..config import Settings, get_settings
from ..models.schemas import ProviderStatus, ProviderType

logger = logging.getLogger(__name__)


# ── API key obfuscation ──
# This is NOT crypto-strong — it stops casual reading of provider_config.json,
# accidental git commits, and over-the-shoulder snooping. For real secret
# management on a multi-user host, replace with `keyring` or a cloud KMS.

_KEY_SECRET_ENV = "EDITFLOW_KEY_SECRET"
_KEY_SECRET_DEFAULT = b"editflow-default-key-rotate-me"


def _key_secret_bytes() -> bytes:
    raw = os.environ.get(_KEY_SECRET_ENV, "").encode("utf-8")
    return raw or _KEY_SECRET_DEFAULT


def _encrypt_api_key(value: str) -> str:
    """XOR-and-base64 an API key. Empty input returns ''."""
    if not value:
        return ""
    secret = _key_secret_bytes()
    raw = value.encode("utf-8")
    cipher = bytes(b ^ secret[i % len(secret)] for i, b in enumerate(raw))
    return base64.b64encode(cipher).decode("ascii")


def _decrypt_api_key(value: str) -> str:
    """Reverse of _encrypt_api_key. Returns '' on any decode failure."""
    if not value:
        return ""
    try:
        cipher = base64.b64decode(value.encode("ascii"))
    except (ValueError, TypeError):
        return ""
    secret = _key_secret_bytes()
    raw = bytes(b ^ secret[i % len(secret)] for i, b in enumerate(cipher))
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return ""


# ── Provider Types ──


# ── Data Models (plain dicts for JSON persistence) ──

def _default_providers() -> Dict[str, Dict]:
    """Default provider configurations."""
    return {
        "ollama-local": {
            "id": "ollama-local",
            "name": "Ollama (Local)",
            "type": ProviderType.OLLAMA.value,
            "base_url": "http://localhost:11434",
            "api_key": "",
            "is_default": True,
            "enabled": True,
            "models": [],
            "status": ProviderStatus.UNKNOWN.value,
            "last_checked": None,
            "error": None,
            "timeout": 10,
            "chat_model": "",
            "vision_model": "",
        }
    }


# ── Provider Service ──

class ProviderService:
    """Multi-provider manager with auto-discovery, health checks, and failover.

    Architecture inspired by:
    - Roo-Code: Two-layer cache (memory + disk), factory pattern, per-provider fetchers
    - opencode: Lazy loading, per-provider customization, models.dev catalog
    """

    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()
        self._providers: Dict[str, Dict] = {}
        self._model_cache: Dict[str, List[Dict]] = {}  # provider_id -> list of model dicts
        self._cache_timestamps: Dict[str, float] = {}  # provider_id -> last refresh time
        self._active_chat_provider: Optional[str] = None
        self._active_chat_model: Optional[str] = None
        self._active_vision_provider: Optional[str] = None
        self._active_vision_model: Optional[str] = None
        self._http_clients: Dict[str, httpx.AsyncClient] = {}
        self._config_path: Path = self.settings.DATA_DIR / "provider_config.json"
        self._cache_ttl: float = 300.0  # 5 minute cache TTL (like Roo-Code's NodeCache)
        self._lock = asyncio.Lock()
        self._initialized = False

    async def initialize(self):
        """Load persisted configuration and auto-discover models."""
        if self._initialized:
            return
        async with self._lock:
            if self._initialized:
                return
            self._load_config()
            # Set active provider/model from config or first available
            if not self._active_chat_provider:
                for pid, p in self._providers.items():
                    if p.get("enabled", True):
                        self._active_chat_provider = pid
                        if p.get("chat_model"):
                            self._active_chat_model = p["chat_model"]
                        break
            if not self._active_vision_provider:
                for pid, p in self._providers.items():
                    if p.get("enabled", True):
                        self._active_vision_provider = pid
                        if p.get("vision_model"):
                            self._active_vision_model = p["vision_model"]
                        break
            self._initialized = True
            logger.info(f"ProviderService initialized with {len(self._providers)} provider(s)")

    def _load_config(self):
        """Load provider configuration from disk."""
        if self._config_path.exists():
            try:
                with open(self._config_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                providers = data.get("providers", _default_providers())
                # Decrypt API keys that were persisted via api_key_encrypted.
                # Plain api_key (from older configs) is migrated on next save.
                for pid, p in providers.items():
                    enc = p.pop("api_key_encrypted", "") if isinstance(p, dict) else ""
                    if enc:
                        p["api_key"] = _decrypt_api_key(enc)
                self._providers = providers
                self._active_chat_provider = data.get("active_chat_provider")
                self._active_chat_model = data.get("active_chat_model")
                self._active_vision_provider = data.get("active_vision_provider")
                self._active_vision_model = data.get("active_vision_model")
                self._model_cache = data.get("model_cache", {})
                self._cache_timestamps = data.get("cache_timestamps", {})
                # Restore float timestamps
                for k in self._cache_timestamps:
                    self._cache_timestamps[k] = float(self._cache_timestamps[k])
                logger.info(f"Loaded {len(self._providers)} provider(s) from config")
                return
            except Exception as e:
                logger.warning(f"Failed to load provider config: {e}")

        # First run - use defaults
        self._providers = _default_providers()
        # Set default active provider
        self._active_chat_provider = "ollama-local"
        self._active_chat_model = self.settings.DEFAULT_CHAT_MODEL
        self._active_vision_provider = "ollama-local"
        self._active_vision_model = self.settings.DEFAULT_VISION_MODEL

    def _save_config(self):
        """Persist provider configuration to disk with API keys obfuscated."""
        try:
            self._config_path.parent.mkdir(parents=True, exist_ok=True)

            # Serialise providers with api_key replaced by api_key_encrypted.
            providers_to_persist: Dict[str, Dict] = {}
            for pid, p in self._providers.items():
                if not isinstance(p, dict):
                    continue
                copy = dict(p)
                api_key = copy.pop("api_key", "")
                copy.pop("api_key_encrypted", None)
                if api_key:
                    copy["api_key_encrypted"] = _encrypt_api_key(api_key)
                providers_to_persist[pid] = copy

            data = {
                "providers": providers_to_persist,
                "active_chat_provider": self._active_chat_provider,
                "active_chat_model": self._active_chat_model,
                "active_vision_provider": self._active_vision_provider,
                "active_vision_model": self._active_vision_model,
                "model_cache": self._model_cache,
                "cache_timestamps": self._cache_timestamps,
                "saved_at": datetime.now(timezone.utc).isoformat(),
            }
            # Atomic write with a small retry — Windows can transiently deny
            # the rename if another reader has the file open.
            tmp_path = self._config_path.with_suffix(".tmp")
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            for attempt in range(3):
                try:
                    tmp_path.replace(self._config_path)
                    break
                except PermissionError:
                    if attempt == 2:
                        raise
                    time.sleep(0.1)
        except Exception as e:
            logger.error(f"Failed to save provider config: {e}")

    @staticmethod
    def _normalize_base_url(base_url: str, provider_type: str) -> str:
        """Normalize base URL to avoid double path prefixes.

        For Ollama: base_url should be like http://localhost:11434 (no /v1)
        For OpenAI-compatible: base_url should be like https://api.openai.com/v1

        We store the base_url as the user provides it but normalize it for the HTTP client
        so that paths like /v1/models or /api/tags work correctly.
        """
        base_url = base_url.rstrip("/")
        if provider_type == ProviderType.OLLAMA.value:
            # Ollama base URL: remove /v1 if present (Ollama uses /api/ paths)
            if base_url.endswith("/v1"):
                base_url = base_url[:-3]
            return base_url
        else:
            # OpenAI-compatible: ensure /v1 is present
            if not base_url.endswith("/v1"):
                base_url = base_url.rstrip("/") + "/v1"
            return base_url

    async def _close_client(self, provider_id: str) -> None:
        """Close and remove the cached HTTP client for a provider.

        Forgetting to call aclose() leaves sockets and the connection pool
        thread running. Use this anywhere a provider is replaced or removed.
        """
        client = self._http_clients.pop(provider_id, None)
        if client is None:
            return
        try:
            await client.aclose()
        except Exception as e:
            logger.warning(f"Failed closing HTTP client for {provider_id}: {e}")

    async def shutdown(self) -> None:
        """Close every cached HTTP client. Call from the FastAPI lifespan shutdown."""
        for pid in list(self._http_clients.keys()):
            await self._close_client(pid)

    def _get_http_client(self, provider_id: str) -> httpx.AsyncClient:
        """Get or create an HTTP client for a provider."""
        if provider_id in self._http_clients:
            return self._http_clients[provider_id]

        provider = self._providers.get(provider_id, {})
        raw_base_url = provider.get("base_url", "")
        provider_type = provider.get("type", ProviderType.OPENAI_COMPATIBLE.value)
        api_key = provider.get("api_key", "")
        timeout = provider.get("timeout", 10)

        # Normalize base URL to avoid double /v1/v1 paths
        base_url = self._normalize_base_url(raw_base_url, provider_type)

        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        client = httpx.AsyncClient(
            base_url=base_url,
            headers=headers,
            timeout=httpx.Timeout(timeout, connect=5.0),
        )
        self._http_clients[provider_id] = client
        return client

    @staticmethod
    def _looks_vision_capable(model_name: str) -> bool:
        """Best-effort model capability hint for UI grouping/selection."""
        name = (model_name or "").lower()
        return any(v in name for v in ["vision", "gemma3", "llava", "bakllava", "moondream", "gpt-4o", "claude-3"])

    def _model_entry_from_name(self, model_name: str, provider: Dict) -> Dict:
        """Create a model entry for manually configured or persisted model names."""
        model_name = (model_name or "").strip()
        provider_type = provider.get("type", ProviderType.OPENAI_COMPATIBLE.value)
        return {
            "id": model_name,
            "name": model_name,
            "size": "",
            "size_bytes": 0,
            "provider_type": provider_type,
            "is_vision": self._looks_vision_capable(model_name),
            "is_local": provider_type == ProviderType.OLLAMA.value,
            "modified_at": "",
        }

    def _merge_manual_models(self, provider: Dict, models: List[Dict]) -> List[Dict]:
        """Include manually configured chat/vision models even when discovery fails."""
        merged = [dict(m) for m in models if m.get("id") or m.get("name")]
        seen = {(m.get("id") or m.get("name")) for m in merged}

        manual_model_names = [
            provider.get("chat_model"),
            provider.get("vision_model"),
        ]
        provider_id = provider.get("id")
        if provider_id == self._active_chat_provider:
            manual_model_names.append(self._active_chat_model)
        if provider_id == self._active_vision_provider:
            manual_model_names.append(self._active_vision_model)

        for configured_model in manual_model_names:
            model_name = (configured_model or "").strip()
            if model_name and model_name not in seen:
                merged.append(self._model_entry_from_name(model_name, provider))
                seen.add(model_name)

        return merged

    def get_cached_or_configured_models(self, provider_id: str) -> List[Dict]:
        """Return models without forcing network discovery.

        Preference order:
        1. Fresh/stale cache from successful discovery
        2. Persisted provider model names
        3. Manually configured chat/vision model names
        """
        provider = self._providers.get(provider_id)
        if not provider:
            return []

        cached = self._model_cache.get(provider_id) or []
        if cached:
            return self._merge_manual_models(provider, cached)

        stored = [
            self._model_entry_from_name(model_name, provider)
            for model_name in provider.get("models", [])
            if model_name
        ]
        return self._merge_manual_models(provider, stored)

    def _resolve_model_for_provider(
        self,
        provider_id: str,
        requested_model: Optional[str] = None,
        role: str = "chat",
    ) -> str:
        """Resolve the best model for a provider and role.

        Selection order:
        1. If requested_model is provided, return it (caller knows best).
        2. Otherwise the provider's configured chat_model / vision_model.
        3. Otherwise the first LOCALLY INSTALLED, non-:cloud model from the
           provider's model cache (Ollama-style — has a size_bytes > 0).
        4. Otherwise the first entry of any kind from the model cache.
        5. Otherwise empty string.

        Step 3 is the new behavior. Previously the first cache entry was
        picked unconditionally, which sometimes returned a `:cloud` model
        that needed Ollama-account auth or a model the user had uninstalled
        (Ollama caches model metadata even after `ollama rm`).
        """
        if requested_model:
            return requested_model.strip()

        provider = self._providers.get(provider_id) or {}
        role_key = "vision_model" if role == "vision" else "chat_model"
        configured = (provider.get(role_key) or "").strip()
        if configured:
            return configured

        known = self.get_cached_or_configured_models(provider_id)
        if known:
            # Prefer real local models (size_bytes > 0 and no ":cloud" suffix).
            for m in known:
                mid = (m.get("id") or m.get("name") or "").strip()
                if not mid:
                    continue
                if ":cloud" in mid:
                    continue
                size = m.get("size_bytes", 0) or 0
                if size > 0 or m.get("is_local"):
                    return mid
            # No "obviously local" entries — fall back to the first non-cloud.
            for m in known:
                mid = (m.get("id") or m.get("name") or "").strip()
                if mid and ":cloud" not in mid:
                    return mid
            # Last resort: whatever the first cached entry is.
            return (known[0].get("id") or known[0].get("name") or "").strip()

        return ""

    # ── Provider CRUD ──

    async def list_providers(self) -> List[Dict]:
        """List all configured providers with their current status."""
        await self.initialize()
        result = []
        for pid, p in self._providers.items():
            entry = dict(p)
            entry["id"] = pid
            entry["is_active_chat"] = (pid == self._active_chat_provider)
            entry["is_active_vision"] = (pid == self._active_vision_provider)
            result.append(entry)
        return result

    async def get_provider(self, provider_id: str) -> Optional[Dict]:
        """Get a specific provider's configuration."""
        await self.initialize()
        p = self._providers.get(provider_id)
        if not p:
            return None
        entry = dict(p)
        entry["id"] = provider_id
        entry["is_active_chat"] = (provider_id == self._active_chat_provider)
        entry["is_active_vision"] = (provider_id == self._active_vision_provider)
        return entry

    async def add_provider(self, config: Dict) -> Dict:
        """Add a new provider configuration.

        Expected config keys:
            name: Display name
            type: Provider type (ollama, openai_compatible, custom)
            base_url: API base URL
            api_key: API key (optional for Ollama)
            timeout: Request timeout in seconds (default 10)
            enabled: Whether provider is active (default True)
        """
        await self.initialize()

        provider_id = config.get("id") or f"provider-{uuid.uuid4().hex[:8]}"
        if provider_id in self._providers:
            raise ValueError(f"Provider '{provider_id}' already exists")

        provider = {
            "id": provider_id,
            "name": config.get("name", "Custom Provider"),
            "type": config.get("type", ProviderType.OPENAI_COMPATIBLE.value),
            "base_url": config.get("base_url", "").rstrip("/"),
            "api_key": config.get("api_key", ""),
            "is_default": False,
            "enabled": config.get("enabled", True),
            "models": [],
            "status": ProviderStatus.UNCONFIGURED.value,
            "last_checked": None,
            "error": None,
            "timeout": config.get("timeout", 10),
            "chat_model": config.get("chat_model", ""),
            "vision_model": config.get("vision_model", ""),
        }

        # Validate base_url
        if not provider["base_url"]:
            raise ValueError("base_url is required")

        self._providers[provider_id] = provider
        # Clear any old HTTP client (paranoid — id collision was already rejected)
        await self._close_client(provider_id)
        self._save_config()

        logger.info(f"Added provider: {provider_id} ({provider['name']})")
        return provider

    async def update_provider(self, provider_id: str, updates: Dict) -> Dict:
        """Update a provider's configuration."""
        await self.initialize()

        if provider_id not in self._providers:
            raise ValueError(f"Provider '{provider_id}' not found")

        provider = self._providers[provider_id]

        # Update allowed fields
        allowed_fields = ["name", "type", "base_url", "api_key", "timeout", "enabled", "chat_model", "vision_model"]
        for field in allowed_fields:
            if field in updates:
                # Editing forms cannot show stored API keys, so a blank key should
                # mean "keep existing key" unless there is no key yet.
                if field == "api_key" and updates[field] == "" and provider.get("api_key"):
                    continue
                provider[field] = updates[field]

        # Clean base_url
        if "base_url" in updates:
            provider["base_url"] = provider["base_url"].rstrip("/")

        # Reset status since config changed
        provider["status"] = ProviderStatus.UNKNOWN.value
        provider["error"] = None
        provider["last_checked"] = None

        # Close and discard cached HTTP client so it picks up the new config
        await self._close_client(provider_id)
        # Invalidate model cache for this provider
        self._model_cache.pop(provider_id, None)
        self._cache_timestamps.pop(provider_id, None)

        self._save_config()
        logger.info(f"Updated provider: {provider_id}")
        return provider

    async def remove_provider(self, provider_id: str) -> bool:
        """Remove a provider configuration."""
        await self.initialize()

        if provider_id not in self._providers:
            return False

        provider = self._providers[provider_id]
        if provider.get("is_default"):
            raise ValueError("Cannot remove the default provider")

        # Clear active references if this was the active provider
        if self._active_chat_provider == provider_id:
            self._active_chat_provider = None
            self._active_chat_model = None
        if self._active_vision_provider == provider_id:
            self._active_vision_provider = None
            self._active_vision_model = None

        del self._providers[provider_id]
        await self._close_client(provider_id)
        self._model_cache.pop(provider_id, None)
        self._cache_timestamps.pop(provider_id, None)
        self._save_config()

        logger.info(f"Removed provider: {provider_id}")
        return True

    # ── Health Checks ──

    async def health_check(self, provider_id: Optional[str] = None) -> Dict[str, Any]:
        """Check provider health. If provider_id is None, check all providers.

        Returns a dict mapping provider_id -> {connected: bool, error: str|None, ...}
        This method NEVER blocks - all HTTP calls have timeouts.
        """
        await self.initialize()

        if provider_id:
            return {provider_id: await self._check_single(provider_id)}

        results = {}
        tasks = []
        for pid in self._providers:
            tasks.append(self._check_single(pid))

        check_results = await asyncio.gather(*tasks, return_exceptions=True)

        for i, pid in enumerate(self._providers):
            if isinstance(check_results[i], Exception):
                results[pid] = {
                    "connected": False,
                    "error": str(check_results[i]),
                    "status": ProviderStatus.ERROR.value,
                }
            else:
                results[pid] = check_results[i]

        return results

    async def _check_single(self, provider_id: str) -> Dict[str, Any]:
        """Check a single provider's health with timeout protection."""
        if provider_id not in self._providers:
            return {"connected": False, "error": "Provider not found"}

        provider = self._providers[provider_id]
        provider_type = provider.get("type", ProviderType.OPENAI_COMPATIBLE.value)
        base_url = provider.get("base_url", "")
        timeout = provider.get("timeout", 10)

        provider["status"] = ProviderStatus.CONNECTING.value

        try:
            client = self._get_http_client(provider_id)

            if provider_type == ProviderType.OLLAMA.value:
                # Ollama uses /api/tags for health check
                resp = await client.get("/api/tags", timeout=httpx.Timeout(timeout, connect=5.0))
                if resp.status_code == 200:
                    provider["status"] = ProviderStatus.CONNECTED.value
                    provider["error"] = None
                    provider["last_checked"] = datetime.now(timezone.utc).isoformat()
                    return {"connected": True, "error": None, "status": ProviderStatus.CONNECTED.value}
                else:
                    provider["status"] = ProviderStatus.ERROR.value
                    provider["error"] = f"HTTP {resp.status_code}"
                    return {"connected": False, "error": f"HTTP {resp.status_code}"}

            else:
                # OpenAI-compatible uses /models for health check (base_url already has /v1)
                resp = await client.get("/models", timeout=httpx.Timeout(timeout, connect=5.0))
                if resp.status_code == 200:
                    provider["status"] = ProviderStatus.CONNECTED.value
                    provider["error"] = None
                    provider["last_checked"] = datetime.now(timezone.utc).isoformat()
                    return {"connected": True, "error": None, "status": ProviderStatus.CONNECTED.value}
                elif resp.status_code == 401:
                    provider["status"] = ProviderStatus.ERROR.value
                    provider["error"] = "Invalid API key"
                    return {"connected": False, "error": "Invalid API key"}
                else:
                    provider["status"] = ProviderStatus.ERROR.value
                    provider["error"] = f"HTTP {resp.status_code}"
                    return {"connected": False, "error": f"HTTP {resp.status_code}"}

        except httpx.TimeoutException:
            provider["status"] = ProviderStatus.ERROR.value
            provider["error"] = "Connection timed out"
            return {"connected": False, "error": "Connection timed out"}
        except httpx.ConnectError:
            provider["status"] = ProviderStatus.ERROR.value
            provider["error"] = "Connection refused"
            return {"connected": False, "error": "Connection refused"}
        except Exception as e:
            provider["status"] = ProviderStatus.ERROR.value
            provider["error"] = str(e)[:100]
            return {"connected": False, "error": str(e)[:100]}

    # ── Model Discovery ──

    async def discover_models(self, provider_id: str, force: bool = False) -> List[Dict]:
        """Discover available models from a provider.

        Uses a two-layer cache (memory + disk) like Roo-Code:
        - Memory cache with TTL (5 min default)
        - Disk cache persists across restarts
        - Force refresh bypasses cache
        - Empty results are never cached (prevents persisting failures)
        """
        await self.initialize()

        if provider_id not in self._providers:
            raise ValueError(f"Provider '{provider_id}' not found")

        # Check memory cache
        if not force:
            cached = self._model_cache.get(provider_id)
            cache_ts = self._cache_timestamps.get(provider_id, 0)
            if cached and (time.time() - cache_ts) < self._cache_ttl:
                logger.debug(f"Using cached models for {provider_id}")
                return cached

        provider = self._providers[provider_id]
        provider_type = provider.get("type", ProviderType.OPENAI_COMPATIBLE.value)
        base_url = provider.get("base_url", "")
        timeout = provider.get("timeout", 10)

        models = []

        try:
            client = self._get_http_client(provider_id)

            if provider_type == ProviderType.OLLAMA.value:
                models = await self._discover_ollama_models(client, timeout)
            else:
                models = await self._discover_openai_models(client, timeout)

            models = self._merge_manual_models(provider, models)

            # Cache non-empty results
            if models:
                self._model_cache[provider_id] = models
                self._cache_timestamps[provider_id] = time.time()
                provider["models"] = [m["id"] for m in models]
                self._save_config()

        except Exception as e:
            logger.warning(f"Model discovery failed for {provider_id}: {e}")
            # Return cached data if available (graceful degradation)
            cached = self._model_cache.get(provider_id)
            if cached:
                logger.info(f"Returning stale cache for {provider_id}")
                return cached

        return models

    async def _discover_ollama_models(self, client: httpx.AsyncClient, timeout: int) -> List[Dict]:
        """Discover models from an Ollama provider via /api/tags."""
        try:
            resp = await client.get("/api/tags", timeout=httpx.Timeout(timeout, connect=5.0))
            if resp.status_code != 200:
                return []

            data = resp.json()
            models = []
            for m in data.get("models", []):
                name = m.get("name", m.get("model", ""))
                if not name:
                    continue
                size_bytes = m.get("size", 0)
                size_str = f"{size_bytes / (1024**3):.1f} GB" if size_bytes else ""
                is_vision = self._looks_vision_capable(name)
                models.append({
                    "id": name,
                    "name": name,
                    "size": size_str,
                    "size_bytes": size_bytes,
                    "provider_type": "ollama",
                    "is_vision": is_vision,
                    "is_local": True,
                    "modified_at": m.get("modified_at", ""),
                })
            return models

        except Exception as e:
            logger.warning(f"Ollama model discovery failed: {e}")
            return []

    async def _discover_openai_models(self, client: httpx.AsyncClient, timeout: int) -> List[Dict]:
        """Discover models from an OpenAI-compatible provider via /models."""
        try:
            resp = await client.get("/models", timeout=httpx.Timeout(timeout, connect=5.0))
            if resp.status_code != 200:
                return []

            data = resp.json()
            models = []
            for m in data.get("data", []):
                model_id = m.get("id", "")
                if not model_id:
                    continue
                is_vision = self._looks_vision_capable(model_id)
                models.append({
                    "id": model_id,
                    "name": model_id,
                    "size": "",
                    "size_bytes": 0,
                    "provider_type": "openai_compatible",
                    "is_vision": is_vision,
                    "is_local": False,
                    "modified_at": m.get("created", ""),
                })
            return models

        except Exception as e:
            logger.warning(f"OpenAI model discovery failed: {e}")
            return []

    async def discover_all_models(self, force: bool = False) -> Dict[str, List[Dict]]:
        """Discover models from all enabled providers.

        Returns a dict mapping provider_id -> list of model dicts.
        This runs concurrently for all providers.
        """
        await self.initialize()

        tasks = {}
        for pid, p in self._providers.items():
            if p.get("enabled", True):
                tasks[pid] = self.discover_models(pid, force=force)

        results = {}
        if tasks:
            task_keys = list(tasks.keys())
            task_fns = list(tasks.values())
            task_results = await asyncio.gather(*task_fns, return_exceptions=True)

            for i, pid in enumerate(task_keys):
                if isinstance(task_results[i], Exception):
                    results[pid] = []
                else:
                    results[pid] = task_results[i]

        return results

    # ── Chat / Completion ──

    async def chat(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        provider_id: Optional[str] = None,
        system: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: int = 4096,
    ) -> Dict[str, Any]:
        """Send a chat completion request to the active provider.

        Returns: {response: str, source: str, provider_id: str, error: str|None}
        """
        await self.initialize()

        # Resolve provider and model
        pid = provider_id or self._active_chat_provider
        requested_model = model
        if not requested_model and pid == self._active_chat_provider:
            requested_model = self._active_chat_model

        if not pid:
            # No provider configured - return rule-based fallback
            return self._rule_based_response(messages)

        # Try the active provider first, then fall back to others
        provider_ids_to_try = [pid]
        for other_pid in self._providers:
            if other_pid != pid and self._providers[other_pid].get("enabled", True):
                provider_ids_to_try.append(other_pid)

        errors = []

        for try_pid in provider_ids_to_try:
            provider = self._providers.get(try_pid)
            if not provider or not provider.get("enabled", True):
                continue

            try:
                try_model = self._resolve_model_for_provider(
                    try_pid,
                    requested_model if try_pid == pid else None,
                    role="chat",
                )
                if not try_model:
                    errors.append(f"{try_pid}: no chat model configured")
                    continue

                result = await self._chat_with_provider(
                    try_pid, provider, messages, try_model, system, temperature, max_tokens
                )
                if result:
                    return result
            except Exception as e:
                # Some httpx/asyncio exceptions have an empty str() (just the
                # type name carries information). Fall back to repr / class
                # name so the log line is never blank.
                err_msg = str(e) or repr(e) or e.__class__.__name__
                errors.append(f"{try_pid}: {err_msg}")
                logger.warning(f"Chat failed with provider {try_pid}: {err_msg}")
                continue

        # All providers failed - rule-based fallback
        fallback = self._rule_based_response(messages)
        fallback["error"] = f"All providers failed: {'; '.join(errors)}"
        return fallback

    async def _chat_with_provider(
        self,
        provider_id: str,
        provider: Dict,
        messages: List[Dict[str, str]],
        model: str,
        system: Optional[str],
        temperature: float,
        max_tokens: int,
    ) -> Optional[Dict[str, Any]]:
        """Execute a chat request against a specific provider."""
        provider_type = provider.get("type", ProviderType.OPENAI_COMPATIBLE.value)
        timeout = provider.get("timeout", 10)
        client = self._get_http_client(provider_id)

        # Prepend system message if provided
        chat_messages = list(messages)
        if system and (not chat_messages or chat_messages[0].get("role") != "system"):
            chat_messages = [{"role": "system", "content": system}] + chat_messages

        if provider_type == ProviderType.OLLAMA.value:
            return await self._ollama_chat(client, provider_id, model, chat_messages, temperature, timeout)
        else:
            return await self._openai_chat(client, provider_id, model, chat_messages, temperature, max_tokens, timeout)

    async def _ollama_chat(
        self, client: httpx.AsyncClient, provider_id: str, model: str,
        messages: List[Dict], temperature: float, timeout: int
    ) -> Optional[Dict[str, Any]]:
        """Chat via Ollama's /api/chat endpoint.

        If the requested model returns 404 (not installed), auto-fall back to
        the first locally-installed model from this provider's cache. The
        active model is updated in memory so subsequent calls skip the retry.
        """
        models_tried: List[str] = []
        last_error: Optional[Exception] = None

        # Candidate models: requested first, then any local fallbacks.
        candidates = [model] + self._local_ollama_fallbacks(provider_id, exclude=model)

        for m in candidates:
            if m in models_tried:
                continue
            models_tried.append(m)
            payload = {
                "model": m,
                "messages": messages,
                "stream": False,
                # keep_alive: 30m keeps the model resident in Ollama after the
                # response so subsequent calls skip the cold-load. Default is
                # 5m which is fine for chat but means every >5min gap pays the
                # full load cost again — for a 4B model on CPU that's 20-40s.
                "keep_alive": "30m",
                "options": {"temperature": temperature},
            }
            try:
                resp = await client.post(
                    "/api/chat",
                    json=payload,
                    # 180s is long enough for a cold-load + first-token on a 4B
                    # model on CPU. The provider's configured `timeout` (default 10)
                    # was multiplied to 30s — far too short — and produced opaque
                    # "Server disconnected" errors when httpx canceled the call
                    # mid-load.
                    timeout=httpx.Timeout(180.0, connect=5.0),
                )
                if resp.status_code == 404:
                    # Model not installed — log once and try the next candidate.
                    logger.warning(
                        f"Ollama returned 404 for model '{m}'. Trying next local model."
                    )
                    last_error = httpx.HTTPStatusError(
                        f"model '{m}' not installed", request=resp.request, response=resp
                    )
                    continue
                resp.raise_for_status()
                data = resp.json()
                content = data.get("message", {}).get("content", "")
                if content:
                    # If we recovered with a fallback model, update the active
                    # chat model so the rest of the session uses it directly.
                    if m != model and provider_id == self._active_chat_provider:
                        logger.info(
                            f"Auto-switched active chat model: '{model}' -> '{m}' (original not installed)"
                        )
                        self._active_chat_model = m
                        try:
                            self._save_config()
                        except Exception:
                            pass
                    return {
                        "response": content,
                        "source": "ollama",
                        "provider_id": provider_id,
                        "error": None,
                    }
            except httpx.HTTPStatusError as e:
                last_error = e
                if e.response.status_code != 404:
                    # Non-404 errors are not "missing model" — bubble up.
                    raise
            except Exception as e:
                last_error = e
                raise

        if last_error:
            raise last_error
        return None

    def _local_ollama_fallbacks(self, provider_id: str, exclude: str = "") -> List[str]:
        """Return Ollama model IDs that are locally installed (not :cloud).

        Cloud-suffixed models require an Ollama account; if the user is offline
        or hasn't authenticated, they 404. Local models are the safest fallback.
        """
        cache = self._model_cache.get(provider_id, [])
        names: List[str] = []
        for entry in cache:
            mid = entry.get("id") if isinstance(entry, dict) else None
            if not mid or mid == exclude:
                continue
            if ":cloud" in mid:
                continue
            # Heuristic: real local models have non-zero size_bytes.
            size = entry.get("size_bytes", 0) if isinstance(entry, dict) else 0
            if size and size > 0:
                names.append(mid)
        return names

    async def _openai_chat(
        self, client: httpx.AsyncClient, provider_id: str, model: str,
        messages: List[Dict], temperature: float, max_tokens: int, timeout: int
    ) -> Optional[Dict[str, Any]]:
        """Chat via OpenAI-compatible /v1/chat/completions endpoint."""
        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }

        # OpenAI-compatible uses /chat/completions (base_url already has /v1)
        resp = await client.post(
            "/chat/completions",
            json=payload,
            timeout=httpx.Timeout(max(timeout * 3, 30), connect=5.0),
        )
        resp.raise_for_status()
        data = resp.json()
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")

        if content:
            return {
                "response": content,
                "source": "openai_compatible",
                "provider_id": provider_id,
                "error": None,
            }
        return None

    # ── Streaming Chat ──

    async def chat_stream(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        provider_id: Optional[str] = None,
        system: Optional[str] = None,
        temperature: float = 0.7,
    ) -> AsyncGenerator[str, None]:
        """Stream chat response token by token from the active provider."""
        await self.initialize()

        pid = provider_id or self._active_chat_provider
        requested_model = model
        if not requested_model and pid == self._active_chat_provider:
            requested_model = self._active_chat_model
        model_name = self._resolve_model_for_provider(pid, requested_model, role="chat") if pid else ""

        if not pid:
            result = self._rule_based_response(messages)
            yield result["response"]
            return

        provider = self._providers.get(pid)
        if not provider:
            yield "[Error: No provider configured]"
            return
        if not model_name:
            yield "[Error: No chat model configured]"
            return

        provider_type = provider.get("type", ProviderType.OPENAI_COMPATIBLE.value)
        timeout = provider.get("timeout", 10)
        client = self._get_http_client(pid)

        chat_messages = list(messages)
        if system and (not chat_messages or chat_messages[0].get("role") != "system"):
            chat_messages = [{"role": "system", "content": system}] + chat_messages

        try:
            if provider_type == ProviderType.OLLAMA.value:
                payload = {
                    "model": model_name,
                    "messages": chat_messages,
                    "stream": True,
                    "options": {"temperature": temperature},
                }
                async with client.stream(
                    "POST", "/api/chat",
                    json=payload,
                    timeout=httpx.Timeout(max(timeout * 3, 60), connect=5.0),
                ) as resp:
                    async for line in resp.aiter_lines():
                        if line.strip():
                            try:
                                chunk = json.loads(line)
                                content = chunk.get("message", {}).get("content", "")
                                if content:
                                    yield content
                                if chunk.get("done", False):
                                    break
                            except json.JSONDecodeError:
                                continue
            else:
                payload = {
                    "model": model_name,
                    "messages": chat_messages,
                    "temperature": temperature,
                    "stream": True,
                }
                async with client.stream(
                    "POST", "/chat/completions",
                    json=payload,
                    timeout=httpx.Timeout(max(timeout * 3, 60), connect=5.0),
                ) as resp:
                    async for line in resp.aiter_lines():
                        if line.startswith("data: "):
                            data_str = line[6:]
                            if data_str.strip() == "[DONE]":
                                break
                            try:
                                chunk = json.loads(data_str)
                                delta = chunk.get("choices", [{}])[0].get("delta", {})
                                content = delta.get("content", "")
                                if content:
                                    yield content
                            except json.JSONDecodeError:
                                continue

        except Exception as e:
            logger.error(f"Stream chat error: {e}")
            yield f"[Error: {e}]"

    # ── Vision / Image Analysis ──

    async def analyze_images(
        self,
        images_b64: List[str],
        prompt: str,
        model: Optional[str] = None,
        provider_id: Optional[str] = None,
    ) -> str:
        """Analyze images using a vision-capable model."""
        await self.initialize()

        pid = provider_id or self._active_vision_provider
        requested_model = model
        if not requested_model and pid == self._active_vision_provider:
            requested_model = self._active_vision_model
        model_name = self._resolve_model_for_provider(pid, requested_model, role="vision") if pid else ""

        if not pid:
            return "[Error: No vision provider configured]"

        provider = self._providers.get(pid)
        if not provider:
            return "[Error: Vision provider not found]"
        if not model_name:
            return "[Error: No vision model configured]"

        provider_type = provider.get("type", ProviderType.OPENAI_COMPATIBLE.value)
        timeout = provider.get("timeout", 10)
        client = self._get_http_client(pid)

        try:
            if provider_type == ProviderType.OLLAMA.value:
                # Ollama /api/generate with images
                payload = {
                    "model": model_name,
                    "prompt": prompt,
                    "images": images_b64,
                    "stream": False,
                }
                resp = await client.post(
                    "/api/generate",
                    json=payload,
                    timeout=httpx.Timeout(max(timeout * 3, 60), connect=5.0),
                )
                resp.raise_for_status()
                data = resp.json()
                return data.get("response", "")
            else:
                # OpenAI Vision API format
                content = [{"type": "text", "text": prompt}]
                for img in images_b64:
                    content.append({
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{img}"},
                    })
                messages = [{"role": "user", "content": content}]
                payload = {
                    "model": model_name,
                    "messages": messages,
                    "max_tokens": 2048,
                }
                # OpenAI Vision API uses /chat/completions (base_url already has /v1)
                resp = await client.post(
                    "/chat/completions",
                    json=payload,
                    timeout=httpx.Timeout(max(timeout * 3, 60), connect=5.0),
                )
                resp.raise_for_status()
                data = resp.json()
                return data.get("choices", [{}])[0].get("message", {}).get("content", "")

        except Exception as e:
            logger.error(f"Vision analysis error: {e}")
            return ""

    # ── Active Model Management ──

    def set_active_chat(self, provider_id: str, model: str):
        """Set the active chat provider and model.

        Validates that `model` is a non-empty string. Empty values used to
        silently clear the active model, causing every subsequent chat to
        fall through to `_resolve_model_for_provider` which picked the first
        cached entry (often a stale `gemma3:4b` that the user had uninstalled).
        """
        if not isinstance(model, str) or not model.strip():
            logger.warning(
                f"set_active_chat: refusing empty/invalid model name (provider={provider_id})"
            )
            return
        model = model.strip()
        self._active_chat_provider = provider_id
        self._active_chat_model = model
        # Also update the provider's stored chat_model
        if provider_id in self._providers:
            self._providers[provider_id]["chat_model"] = model
        self._save_config()

    def set_active_vision(self, provider_id: str, model: str):
        """Set the active vision provider and model."""
        self._active_vision_provider = provider_id
        self._active_vision_model = model
        if provider_id in self._providers:
            self._providers[provider_id]["vision_model"] = model
        self._save_config()

    def get_active_chat(self) -> Dict[str, Optional[str]]:
        """Get active chat provider_id and model."""
        return {
            "provider_id": self._active_chat_provider,
            "model": self._active_chat_model,
        }

    def get_active_vision(self) -> Dict[str, Optional[str]]:
        """Get active vision provider_id and model."""
        return {
            "provider_id": self._active_vision_provider,
            "model": self._active_vision_model,
        }

    # ── Model Management (Ollama-specific) ──

    async def pull_model(self, provider_id: str, model_name: str) -> AsyncGenerator[Dict, None]:
        """Pull/download a model from an Ollama provider."""
        if provider_id not in self._providers:
            yield {"error": f"Provider '{provider_id}' not found"}
            return

        provider = self._providers[provider_id]
        if provider.get("type") != ProviderType.OLLAMA.value:
            yield {"error": "Model pulling is only supported for Ollama providers"}
            return

        client = self._get_http_client(provider_id)
        timeout = provider.get("timeout", 10)

        try:
            async with client.stream(
                "POST", "/api/pull",
                json={"name": model_name, "stream": True},
                timeout=httpx.Timeout(max(timeout * 10, 300), connect=5.0),
            ) as resp:
                async for line in resp.aiter_lines():
                    if line.strip():
                        try:
                            chunk = json.loads(line)
                            yield chunk
                        except json.JSONDecodeError:
                            continue

            # Invalidate cache after pull
            self._model_cache.pop(provider_id, None)
            self._cache_timestamps.pop(provider_id, None)

        except Exception as e:
            logger.error(f"Pull model error: {e}")
            yield {"error": str(e)}

    async def delete_model(self, provider_id: str, model_name: str) -> bool:
        """Delete a model from an Ollama provider."""
        if provider_id not in self._providers:
            return False

        provider = self._providers[provider_id]
        if provider.get("type") != ProviderType.OLLAMA.value:
            return False

        client = self._get_http_client(provider_id)
        timeout = provider.get("timeout", 10)

        try:
            resp = await client.delete(
                "/api/delete",
                json={"name": model_name},
                timeout=httpx.Timeout(timeout, connect=5.0),
            )
            if resp.status_code == 200:
                self._model_cache.pop(provider_id, None)
                self._cache_timestamps.pop(provider_id, None)
                return True
            return False
        except Exception as e:
            logger.error(f"Delete model error: {e}")
            return False

    # ── Rule-Based Fallback ──

    # Fallback responses surfaced when no LLM provider is connected.
    # Keep endpoints current with the v2 pipeline (analyze → cut → visuals → premiere).
    _FALLBACK_PATTERNS = [
        (r"\b(hello|hi|hey|greetings|salam|assalam)\b",
         "Hello! I'm EditFlow AI. No LLM provider is connected, so I can only "
         "answer with canned responses right now. Configure a provider in "
         "Settings to unlock full AI replies."),
        (r"\b(help|what can you do|commands)\b",
         "EditFlow AI — core endpoints:\n"
         "- POST /api/pipeline/analyze     – transcribe a folder of videos\n"
         "- POST /api/pipeline/cut         – match a script and build a clean cut\n"
         "- POST /api/pipeline/cut/execute – render the cut with FFmpeg\n"
         "- POST /api/pipeline/visuals     – place visuals from a mapping doc\n"
         "- POST /api/premiere/edl/from-cuts – push cuts to Premiere via EDL\n"
         "- GET  /api/providers            – manage LLM providers\n"
         "Configure a provider for natural-language replies."),
        (r"\b(analy[sz]e|transcribe|transcription|scan)\b",
         "To analyze a folder of videos, POST /api/pipeline/analyze with "
         "{ folder_path, language }. Whisper runs locally — no LLM required."),
        (r"\b(cut|script|clean|edit)\b",
         "Provide an English script and POST /api/pipeline/cut. The cutter "
         "matches each line to the best Urdu take and produces a cutting plan."),
        (r"\b(visual|image|overlay|broll|b-?roll)\b",
         "POST /api/pipeline/visuals with a mapping document (docx/txt) and "
         "a visual_folder path. Each entry binds a script line to a visual file."),
        (r"\b(premiere|timeline|sequence|edl)\b",
         "Use the CEP panel's Sync / Scan buttons, or POST /api/premiere/edl/"
         "from-cuts to push the latest cutting result to Premiere's timeline."),
        (r"\b(provider|ollama|openai|model)\b",
         "Manage providers under /api/providers. Use /api/models/list to "
         "see configured chat/vision models across all providers."),
        (r"\b(status|health|system)\b",
         "System status: no LLM connected. Check /api/status for full health. "
         "Whisper and FFmpeg are local — they work without a provider."),
        (r"\b(thank|thanks)\b",
         "You're welcome — let me know what to cut next."),
    ]

    def _rule_based_response(self, messages: List[Dict[str, str]]) -> Dict[str, Any]:
        """Simple rule-based response when no LLM provider is available."""

        user_message = ""
        for msg in reversed(messages):
            if msg.get("role") == "user":
                user_message = msg.get("content", "")
                break

        msg_lower = user_message.lower()
        for pattern, response in self._FALLBACK_PATTERNS:
            if re.search(pattern, msg_lower):
                return {
                    "response": response,
                    "source": "rule_based",
                    "provider_id": None,
                    "error": None,
                }

        return {
            "response": (
                "I'm currently in offline mode (no LLM connected). "
                "For full AI capabilities, please configure an LLM provider in Settings. "
                "Type 'help' for available commands."
            ),
            "source": "rule_based",
            "provider_id": None,
            "error": None,
        }

    # ── Utility ──

    async def get_all_models_flat(self) -> List[Dict]:
        """Get a flat list of all models from all providers with provider info.

        This is what the model selector in the UI uses.
        """
        await self.initialize()

        all_models = []
        for pid, p in self._providers.items():
            if not p.get("enabled", True):
                continue

            # Try cached models first
            cached = self._model_cache.get(pid, [])
            if not cached:
                # Try provider's stored model list
                for model_name in p.get("models", []):
                    cached.append({"id": model_name, "name": model_name})

            for m in cached:
                entry = dict(m)
                entry["provider_id"] = pid
                entry["provider_name"] = p.get("name", pid)
                entry["provider_type"] = p.get("type", "unknown")
                entry["is_active_chat"] = (
                    pid == self._active_chat_provider and
                    m.get("id") == self._active_chat_model
                )
                entry["is_active_vision"] = (
                    pid == self._active_vision_provider and
                    m.get("id") == self._active_vision_model
                )
                all_models.append(entry)

        return all_models

    async def test_provider(self, provider_id: str, prompt: str = "Hello, respond with 'EditFlow AI is working!'") -> Dict[str, Any]:
        """Test a provider by sending a simple chat prompt."""
        await self.initialize()

        if provider_id not in self._providers:
            return {"success": False, "error": "Provider not found"}

        provider = self._providers[provider_id]
        model = self._resolve_model_for_provider(provider_id, provider.get("chat_model", ""), role="chat")

        # If no chat_model set, try to discover and use the first available
        if not model:
            models = await self.discover_models(provider_id, force=True)
            if models:
                model = models[0].get("id", "")

        if not model:
            return {"success": False, "error": "No model available for testing"}

        try:
            result = await self.chat(
                messages=[{"role": "user", "content": prompt}],
                model=model,
                provider_id=provider_id,
                temperature=0.3,
                max_tokens=100,
            )
            return {
                "success": bool(result.get("response")),
                "response": result.get("response", ""),
                "source": result.get("source", ""),
                "provider_id": provider_id,
                "model": model,
                "error": result.get("error"),
            }
        except Exception as e:
            return {"success": False, "error": str(e)}


# Global service instance
provider_service = ProviderService()
