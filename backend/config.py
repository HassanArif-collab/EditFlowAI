"""
EditFlow AI - Configuration
Central settings for the entire system.
"""
import os
from pathlib import Path
from typing import Optional
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings with environment variable support."""

    # ── Server ──
    HOST: str = "127.0.0.1"
    PORT: int = 8765
    DEBUG: bool = True

    # ── Ollama ──
    OLLAMA_BASE_URL: str = "http://localhost:11434"
    OLLAMA_API_KEY: Optional[str] = None
    OLLAMA_CLOUD_URL: str = "https://api.ohmyllama.com/v1"
    DEFAULT_CHAT_MODEL: str = "gemma3:4b"
    DEFAULT_VISION_MODEL: str = "gemma3:4b"
    OLLAMA_TIMEOUT: int = 300  # seconds

    # ── Whisper ──
    WHISPER_MODEL: str = "large-v3-turbo"
    WHISPER_DEVICE: str = "cpu"
    WHISPER_COMPUTE_TYPE: str = "int8"
    WHISPER_LOCAL_DIR: Optional[str] = None  # Path to local model weights

    # ── Paths ──
    DATA_DIR: Path = Path(__file__).parent.parent / "data"
    CATALOG_DIR: Path = Path(__file__).parent.parent / "data" / "catalogs"
    TEMPLATE_DIR: Path = Path(__file__).parent.parent / "data" / "templates"
    MEDIA_CACHE_DIR: Path = Path(__file__).parent.parent / "data" / "media_cache"
    EDL_DIR: Path = Path(__file__).parent.parent / "data" / "edl"
    DB_PATH: Path = Path(__file__).parent.parent / "data" / "editflow_v2.sqlite3"

    # ── FFmpeg ──
    FFMPEG_PATH: str = "ffmpeg"
    FFPROBE_PATH: str = "ffprobe"

    # ── Premiere Pro ──
    PREMIERE_HOST: str = "localhost"
    PREMIERE_CSXS_PORT: int = 8088

    # ── WebSocket ──
    WS_HEARTBEAT_INTERVAL: int = 30  # seconds

    # ── Templates ──
    DEFAULT_TEMPLATE: str = "jamia_masjid"

    # ── Feature Gates ──
    # Phase 1 keeps the panel in reference-check mode: scan bins, resolve references,
    # and show exact media before any edit planning/execution is allowed.
    ENABLE_PHASE1_REFERENCE_ONLY: bool = True
    ENABLE_V2_BIN_WORKFLOW: bool = True
    ENABLE_V2_EDIT_PLANNING: bool = False
    ENABLE_LEGACY_PREMIERE_COMMANDS: bool = False
    ENABLE_OLD_IMPORT_FILES: bool = False
    ENABLE_OLD_GENERATE_SCRIPT: bool = False
    ENABLE_GENERATED_JSX: bool = False

    model_config = {
        "env_prefix": "EDITFLOW_",
        "env_file": ".env",
        "case_sensitive": True,
        "extra": "ignore",
    }


_settings_instance: Settings | None = None

def get_settings() -> Settings:
    """Get cached settings singleton."""
    global _settings_instance
    if _settings_instance is None:
        _settings_instance = Settings()
    return _settings_instance


def feature_flags(settings: Settings | None = None) -> dict:
    s = settings or get_settings()
    return {
        "phase1_reference_only": s.ENABLE_PHASE1_REFERENCE_ONLY,
        "enable_v2_bin_workflow": s.ENABLE_V2_BIN_WORKFLOW,
        "enable_v2_edit_planning": s.ENABLE_V2_EDIT_PLANNING,
        "enable_legacy_premiere_commands": s.ENABLE_LEGACY_PREMIERE_COMMANDS,
        "enable_old_import_files": s.ENABLE_OLD_IMPORT_FILES,
        "enable_old_generate_script": s.ENABLE_OLD_GENERATE_SCRIPT,
        "enable_generated_jsx": s.ENABLE_GENERATED_JSX,
    }


# Ensure data directories exist
def init_dirs():
    s = get_settings()
    for d in [
        s.DATA_DIR,
        s.CATALOG_DIR,
        s.TEMPLATE_DIR,
        s.MEDIA_CACHE_DIR,
        s.EDL_DIR,
        s.DB_PATH.parent,
    ]:
        d.mkdir(parents=True, exist_ok=True)
