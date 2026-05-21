"""
EditFlow AI - Configuration
Central settings for the simplified video editing pipeline.
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
    # Hot-reload is opt-in. Set EDITFLOW_DEBUG=true in your local env to enable.
    DEBUG: bool = False

    # ── Default LLM ──
    DEFAULT_CHAT_MODEL: str = "gemma3:4b"
    DEFAULT_VISION_MODEL: str = "gemma3:4b"

    # ── Whisper ──
    WHISPER_MODEL: str = "large-v3-turbo"
    WHISPER_DEVICE: str = "cpu"
    WHISPER_COMPUTE_TYPE: str = "int8"
    WHISPER_LOCAL_DIR: Optional[str] = None

    # ── Paths ──
    DATA_DIR: Path = Path(__file__).parent.parent / "data"
    MEDIA_CACHE_DIR: Path = Path(__file__).parent.parent / "data" / "media_cache"
    OUTPUT_DIR: Path = Path(__file__).parent.parent / "data" / "output"
    DB_PATH: Path = Path(__file__).parent.parent / "data" / "editflow_v2.sqlite3"

    # ── FFmpeg ──
    FFMPEG_PATH: str = "ffmpeg"
    FFPROBE_PATH: str = "ffprobe"

    # ── WebSocket ──
    WS_HEARTBEAT_INTERVAL: int = 30

    # ── Cutting Pipeline ──
    DEFAULT_SILENCE_THRESHOLD_DB: float = -35.0
    DEFAULT_MIN_SILENCE_DURATION: float = 0.8
    DEFAULT_FILLER_WORDS: str = "um,uh,ah,like,you know,I mean,so,basically,actually"

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


def init_dirs():
    """Ensure data directories exist."""
    s = get_settings()
    for d in [s.DATA_DIR, s.MEDIA_CACHE_DIR, s.OUTPUT_DIR, s.DB_PATH.parent]:
        d.mkdir(parents=True, exist_ok=True)
