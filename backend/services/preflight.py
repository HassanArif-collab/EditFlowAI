"""
EditFlow AI - Preflight Service
Runs environment and dependency checks before the user kicks off a pipeline run.
Follows the "fail loudly" principle — every check produces a clear status.
"""
from __future__ import annotations

import asyncio
import json
import logging
import shutil
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ..config import Settings, get_settings

logger = logging.getLogger(__name__)


# ── Data Models ──


@dataclass
class PreflightCheck:
    """Single preflight check result."""
    name: str
    status: str  # "green" | "yellow" | "red"
    message: str
    remediation: str = ""


@dataclass
class PreflightResult:
    """Aggregate preflight result."""
    ready: bool = False
    checks: list[PreflightCheck] = field(default_factory=list)
    checked_at: str = ""

    def __post_init__(self) -> None:
        self.ready = all(c.status != "red" for c in self.checks)
        if not self.checked_at:
            self.checked_at = datetime.now(timezone.utc).isoformat()


# ── Preflight Service ──


class PreflightService:
    """Runs all preflight checks and returns an aggregate result.

    Each check is a separate async method so they can be run concurrently
    and individually mocked in tests.
    """

    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()

    async def run_checks(self) -> PreflightResult:
        """Run all preflight checks and return the aggregate result."""
        checks = await asyncio.gather(
            self.check_ffmpeg_available(),
            self.check_ffprobe_available(),
            self.check_whisper_engine(),
            self.check_whisper_model(),
            self.check_chat_provider(),
            self.check_embedding_model(),
            self.check_disk_space(),
            self.check_python_version(),
            self.check_premiere_project(),
        )
        check_list = list(checks)
        ready = all(c.status != "red" for c in check_list)
        checked_at = datetime.now(timezone.utc).isoformat()
        return PreflightResult(
            ready=ready,
            checks=check_list,
            checked_at=checked_at,
        )

    # ── Individual Checks ──

    async def check_ffmpeg_available(self) -> PreflightCheck:
        """Check that ffmpeg resolves on PATH and responds to -version in <2s."""
        ffmpeg_path = self.settings.FFMPEG_PATH
        return await self._check_binary(
            name="ffmpeg_available",
            binary=ffmpeg_path,
            red_remedation="Install ffmpeg and ensure it is on PATH, or set EDITFLOW_FFMPEG_PATH.",
            yellow_if_missing=False,
        )

    async def check_ffprobe_available(self) -> PreflightCheck:
        """Check that ffprobe resolves on PATH and responds to -version in <2s.

        Yellow if missing — some features degrade but the pipeline can use
        Python's wave module as a fallback.
        """
        ffprobe_path = self.settings.FFPROBE_PATH
        return await self._check_binary(
            name="ffprobe_available",
            binary=ffprobe_path,
            red_remedation="Install ffmpeg (includes ffprobe) or set EDITFLOW_FFPROBE_PATH.",
            yellow_if_missing=True,
        )

    async def _check_binary(
        self,
        name: str,
        binary: str,
        red_remedation: str,
        yellow_if_missing: bool,
    ) -> PreflightCheck:
        """Generic binary availability check with 2s timeout."""
        resolved = shutil.which(binary)
        if resolved is None:
            status = "yellow" if yellow_if_missing else "red"
            msg = f"{binary} not found on PATH"
            return PreflightCheck(
                name=name,
                status=status,
                message=msg,
                remediation=red_remedation,
            )

        try:
            proc = await asyncio.create_subprocess_exec(
                resolved, "-version",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                await asyncio.wait_for(proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                return PreflightCheck(
                    name=name,
                    status="red",
                    message=f"{resolved} -version timed out (>2s)",
                    remediation=red_remedation,
                )

            if proc.returncode == 0:
                return PreflightCheck(
                    name=name,
                    status="green",
                    message=f"{resolved} available",
                    remediation="",
                )
            else:
                status = "yellow" if yellow_if_missing else "red"
                return PreflightCheck(
                    name=name,
                    status=status,
                    message=f"{resolved} -version exited with code {proc.returncode}",
                    remediation=red_remedation,
                )
        except OSError as exc:
            status = "yellow" if yellow_if_missing else "red"
            return PreflightCheck(
                name=name,
                status=status,
                message=f"Failed to execute {resolved}: {exc}",
                remediation=red_remedation,
            )

    async def check_whisper_engine(self) -> PreflightCheck:
        """Check which transcription engines are importable.

        Priority: whisperx (green) > stable-ts (yellow) > faster-whisper (yellow).
        Red if none are available.
        """
        # Try whisperx first
        try:
            import whisperx  # noqa: F401
            logger.info("Preflight: whisperx is available (selected)")
            return PreflightCheck(
                name="whisper_engine",
                status="green",
                message="whisperx is available",
                remediation="",
            )
        except ImportError:
            pass

        # Try stable-ts
        try:
            import stable_ts  # noqa: F401
            logger.info("Preflight: stable-ts is available (fallback from whisperx)")
            return PreflightCheck(
                name="whisper_engine",
                status="yellow",
                message="stable-ts available (fallback — whisperx not found)",
                remediation="Install whisperx for best results: pip install whisperx",
            )
        except ImportError:
            pass

        # Try faster-whisper
        try:
            import faster_whisper  # noqa: F401
            logger.info("Preflight: faster-whisper is available (fallback from whisperx/stable-ts)")
            return PreflightCheck(
                name="whisper_engine",
                status="yellow",
                message="faster-whisper available (fallback — whisperx/stable-ts not found)",
                remediation="Install whisperx for best results: pip install whisperx",
            )
        except ImportError:
            pass

        logger.error("Preflight: no transcription engine available")
        return PreflightCheck(
            name="whisper_engine",
            status="red",
            message="No transcription engine found (whisperx, stable-ts, or faster-whisper)",
            remediation="Install at least one: pip install faster-whisper",
        )

    async def check_whisper_model(self) -> PreflightCheck:
        """Check if the configured Whisper model is cached or downloadable.

        For faster-whisper models, check if the model directory exists locally.
        Green if cached, yellow if needs download, red if can't determine.
        """
        model_name = self.settings.WHISPER_MODEL
        local_dir = self.settings.WHISPER_LOCAL_DIR

        # If a local directory is configured, check if it exists
        if local_dir:
            local_path = Path(local_dir)
            if local_path.exists() and any(local_path.iterdir()):
                return PreflightCheck(
                    name="whisper_model",
                    status="green",
                    message=f"Whisper model found at {local_dir}",
                    remediation="",
                )
            else:
                return PreflightCheck(
                    name="whisper_model",
                    status="red",
                    message=f"Configured WHISPER_LOCAL_DIR does not exist or is empty: {local_dir}",
                    remediation=f"Download the model to {local_dir} or remove EDITFLOW_WHISPER_LOCAL_DIR to use auto-download.",
                )

        # Check for faster-whisper cache directory
        try:
            # faster-whisper caches models in ~/.cache/huggingface/hub/
            hf_cache = Path.home() / ".cache" / "huggingface" / "hub"
            if hf_cache.exists():
                # Look for a model directory matching the model name
                model_slug = f"models--Systran--faster-whisper-{model_name}"
                model_cache_dir = hf_cache / model_slug
                if model_cache_dir.exists():
                    return PreflightCheck(
                        name="whisper_model",
                        status="green",
                        message=f"Whisper model '{model_name}' cached in HuggingFace hub",
                        remediation="",
                    )
        except Exception as exc:
            logger.debug(f"Preflight: error checking HuggingFace cache: {exc}")

        # Can't confirm cache — assume needs download (yellow, not red, since
        # faster-whisper can download on first use)
        return PreflightCheck(
            name="whisper_model",
            status="yellow",
            message=f"Whisper model '{model_name}' not found in cache — will download on first use",
            remediation=f"Ensure internet access for first run, or pre-download the model.",
        )

    async def check_chat_provider(self) -> PreflightCheck:
        """Check if an active chat provider is configured and healthy.

        Green if connected, yellow if provider exists but not connected,
        red if no provider configured.
        """
        try:
            from .provider_service import provider_service

            # Ensure provider_service is initialized
            await provider_service.initialize()

            active = provider_service.get_active_chat()
            if not active or not active.get("provider_id"):
                return PreflightCheck(
                    name="chat_provider",
                    status="red",
                    message="No active chat provider configured",
                    remediation="Configure a provider via the Providers panel (e.g. Ollama at localhost:11434).",
                )

            provider_id = active["provider_id"]

            # Check health
            health = await provider_service.health_check(provider_id)
            provider_health = health.get(provider_id, {})

            if provider_health.get("connected"):
                return PreflightCheck(
                    name="chat_provider",
                    status="green",
                    message=f"Chat provider '{provider_id}' connected",
                    remediation="",
                )
            else:
                error = provider_health.get("error", "unknown")
                return PreflightCheck(
                    name="chat_provider",
                    status="yellow",
                    message=f"Chat provider '{provider_id}' not connected: {error}",
                    remediation="Check that the provider service is running and accessible.",
                )

        except Exception as exc:
            logger.warning(f"Preflight: chat provider check failed: {exc}")
            return PreflightCheck(
                name="chat_provider",
                status="red",
                message=f"Chat provider check failed: {exc}",
                remediation="Ensure the provider service is properly configured.",
            )

    async def check_embedding_model(self) -> PreflightCheck:
        """Check if sentence-transformers is importable.

        Embeddings are needed for Phase D, not yet. Yellow if unavailable.
        """
        try:
            import sentence_transformers  # noqa: F401
            return PreflightCheck(
                name="embedding_model",
                status="green",
                message="sentence-transformers is available",
                remediation="",
            )
        except ImportError:
            return PreflightCheck(
                name="embedding_model",
                status="yellow",
                message="sentence-transformers not installed (needed for Phase D embeddings)",
                remediation="pip install sentence-transformers",
            )

    async def check_disk_space(self) -> PreflightCheck:
        """Check free disk space in MEDIA_CACHE_DIR.

        Green if >= 5GB, yellow if 1-5GB, red if < 1GB.
        """
        cache_dir = Path(self.settings.MEDIA_CACHE_DIR)

        # Ensure directory exists for the check
        try:
            cache_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            return PreflightCheck(
                name="disk_space",
                status="red",
                message=f"Cannot create MEDIA_CACHE_DIR: {exc}",
                remediation=f"Ensure write access to {cache_dir}",
            )

        try:
            free_bytes = self._get_free_space(cache_dir)
            free_gb = free_bytes / (1024 ** 3)

            if free_gb >= 5.0:
                return PreflightCheck(
                    name="disk_space",
                    status="green",
                    message=f"{free_gb:.1f} GB free in {cache_dir}",
                    remediation="",
                )
            elif free_gb >= 1.0:
                return PreflightCheck(
                    name="disk_space",
                    status="yellow",
                    message=f"Only {free_gb:.1f} GB free in {cache_dir} (recommended: >= 5 GB)",
                    remediation="Free up disk space or set EDITFLOW_MEDIA_CACHE_DIR to a larger volume.",
                )
            else:
                return PreflightCheck(
                    name="disk_space",
                    status="red",
                    message=f"Only {free_gb:.1f} GB free in {cache_dir} — insufficient for pipeline",
                    remediation="Free up disk space. At least 5 GB is recommended.",
                )
        except Exception as exc:
            return PreflightCheck(
                name="disk_space",
                status="red",
                message=f"Cannot check disk space: {exc}",
                remediation=f"Ensure {cache_dir} is accessible.",
            )

    @staticmethod
    def _get_free_space(path: Path) -> int:
        """Get free disk space in bytes for the given path. Cross-platform."""
        try:
            # Python 3.11+: Path.stat().st_dev gives the device, but
            # shutil.disk_usage is the reliable cross-platform way.
            usage = shutil.disk_usage(str(path))
            return usage.free
        except OSError:
            # Fallback for unusual filesystems
            raise

    async def check_premiere_project(self) -> PreflightCheck:
        """Check if a Premiere project is open (via capability probe data).

        Yellow if no capability probe data exists (panel may not be running).
        Red if probe says no project open.
        """
        try:
            from ..models.sqlite_registry import sqlite_registry
            caps = sqlite_registry.find_latest_capabilities()
            if not caps:
                return PreflightCheck(
                    name="premiere_project",
                    status="yellow",
                    message="No Premiere capability probe received — panel may not be running",
                    remediation="Open the EditFlow panel in Premiere Pro.",
                )
            caps_data = json.loads(caps.get("capabilities_json", "{}"))
            if caps_data.get("project_has_path") and caps_data.get("active_sequence"):
                return PreflightCheck(
                    name="premiere_project",
                    status="green",
                    message="Premiere project is open with active sequence",
                    remediation="",
                )
            elif caps_data.get("project_has_path"):
                return PreflightCheck(
                    name="premiere_project",
                    status="yellow",
                    message="Premiere project open but no active sequence",
                    remediation="Open or create a sequence in Premiere.",
                )
            else:
                return PreflightCheck(
                    name="premiere_project",
                    status="red",
                    message="No Premiere project open",
                    remediation="Open a Premiere project before generating a plan.",
                )
        except Exception as exc:
            return PreflightCheck(
                name="premiere_project",
                status="yellow",
                message=f"Cannot check Premiere status: {exc}",
                remediation="Ensure the CEP panel is running.",
            )

    async def check_python_version(self) -> PreflightCheck:
        """Check that Python version is >= 3.10."""
        version = sys.version_info
        version_str = f"{version.major}.{version.minor}.{version.micro}"

        if version >= (3, 10):
            return PreflightCheck(
                name="python_version",
                status="green",
                message=f"Python {version_str}",
                remediation="",
            )
        else:
            return PreflightCheck(
                name="python_version",
                status="red",
                message=f"Python {version_str} — requires >= 3.10",
                remediation="Upgrade Python to 3.10 or later.",
            )


# ── Global Instance ──

preflight_service = PreflightService()
