"""
EditFlow AI - Configuration
Central settings for the simplified video editing pipeline.
"""
import os
import logging
import shutil
from pathlib import Path
from typing import Optional
from pydantic_settings import BaseSettings

logger = logging.getLogger(__name__)

# ── HuggingFace cache redirect (Option B) ───────────────────────────
# C: drive runs out of space when downloading Whisper models (medium ~1.5 GB,
# large-v3 ~3 GB). Project lives on G: with plenty of room. Redirect the HF
# cache into the project's data/ dir so model downloads land on the same drive
# as the rest of the project's working data.
#
# CRITICAL: this MUST happen BEFORE any huggingface_hub / transformers import
# anywhere else in the codebase, otherwise those libraries will already have
# computed their cache paths. config.py is the first module backend/main.py
# imports, so setting it here is safe.
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_HF_CACHE = _PROJECT_ROOT / "data" / "hf-cache"
_HF_CACHE = Path(os.environ.get("HF_HUB_CACHE") or str(_DEFAULT_HF_CACHE)).expanduser()
try:
    _HF_CACHE.mkdir(parents=True, exist_ok=True)
    os.environ["HF_HUB_CACHE"] = str(_HF_CACHE)
    # HF_HOME affects both transformers AND huggingface_hub. Setting both means
    # any downstream library lands on the same drive.
    os.environ.setdefault("HF_HOME", str(_HF_CACHE.parent))
except OSError as e:
    logger.warning(f"Could not create HF cache dir {_HF_CACHE}: {e}")


def _resolve_ffmpeg_path(bare_name: str) -> str:
    """Find ffmpeg/ffprobe by checking PATH then common Windows install dirs.

    Returns the configured value unchanged if a real path is found at the
    expected locations. Returns an absolute path if a bundled copy is found
    under data/tools/. Falls back to the bare name if nothing matches —
    the user will then get a clearer error from the transcription pipeline.
    """
    # 1) PATH lookup — works if the user has ffmpeg installed globally.
    on_path = shutil.which(bare_name)
    if on_path:
        return on_path

    # 2) Bundled binary inside the project (data/tools/ffmpeg-*/bin/).
    bundled_glob = list((_PROJECT_ROOT / "data" / "tools").glob(f"ffmpeg-*/bin/{bare_name}.exe"))
    if bundled_glob:
        return str(bundled_glob[0])
    bundled_glob = list((_PROJECT_ROOT / "data" / "tools").glob(f"ffmpeg-*/bin/{bare_name}"))
    if bundled_glob:
        return str(bundled_glob[0])

    # 3) Common Windows install locations (winget, chocolatey, manual).
    candidates = [
        Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/WinGet/Packages",
        Path("C:/ffmpeg/bin"),
        Path("C:/Program Files/ffmpeg/bin"),
        Path("C:/ProgramData/chocolatey/bin"),
    ]
    for base in candidates:
        if not base.exists():
            continue
        # Direct hit (C:/ffmpeg/bin/ffmpeg.exe)
        direct = base / f"{bare_name}.exe"
        if direct.is_file():
            return str(direct)
        # WinGet packages nest one level — search shallow tree
        for match in base.glob(f"**/{bare_name}.exe"):
            return str(match)

    # 4) No luck — return the bare name. Transcription will fail with a clearer
    # error than "WinError 2" once we surface it in the route.
    return bare_name


class Settings(BaseSettings):
    """Application settings with environment variable support."""

    # ── Server ──
    HOST: str = "127.0.0.1"
    PORT: int = 8765
    # Hot-reload is opt-in. Set EDITFLOW_DEBUG=true in your local env to enable.
    DEBUG: bool = False

    # ── Default LLM ──
    # IMPORTANT: this default is used ONLY when no provider_config.json exists
    # yet (i.e., first-run). After that the persisted active_chat_model wins.
    # Use a model that's likely to actually be installed (nemotron-3-nano:4b
    # is a small free local Ollama model). Avoid gemma3:4b which has caused
    # repeated 404 spam in production logs because users didn't have it pulled.
    DEFAULT_CHAT_MODEL: str = "nemotron-3-nano:4b"
    DEFAULT_VISION_MODEL: str = "nemotron-3-nano:4b"

    # ── Whisper ──
    # Default: medium — best speed/quality balance on CPU for multilingual.
    # The actual active model is overridable at runtime via the panel UI
    # (POST /api/whisper/set-model) and persists in data/whisper_config.json.
    WHISPER_MODEL: str = "medium"
    WHISPER_DEVICE: str = "cpu"
    WHISPER_COMPUTE_TYPE: str = "int8"
    WHISPER_LOCAL_DIR: Optional[str] = None

    # ── HuggingFace cache ──
    # Exposed for diagnostics + UI. The env var was already set at module top.
    HF_CACHE_DIR: Path = _HF_CACHE

    # ── Paths ──
    DATA_DIR: Path = _PROJECT_ROOT / "data"
    MEDIA_CACHE_DIR: Path = _PROJECT_ROOT / "data" / "media_cache"
    OUTPUT_DIR: Path = _PROJECT_ROOT / "data" / "output"
    DB_PATH: Path = _PROJECT_ROOT / "data" / "editflow_v2.sqlite3"

    # ── FFmpeg ──
    # Resolved at startup by _resolve_ffmpeg_path(). If neither PATH nor a
    # bundled binary nor common install dirs have ffmpeg, the bare name is
    # kept and the transcription pipeline will surface a clear error.
    FFMPEG_PATH: str = "ffmpeg"
    FFPROBE_PATH: str = "ffprobe"

    # ── WebSocket ──
    WS_HEARTBEAT_INTERVAL: int = 30

    # ── Cutting Pipeline ──
    DEFAULT_SILENCE_THRESHOLD_DB: float = -35.0
    DEFAULT_MIN_SILENCE_DURATION: float = 0.8
    DEFAULT_FILLER_WORDS: str = "um,uh,ah,like,you know,I mean,so,basically,actually"

    # ── Transcript Sidecar ──
    # Write a human-readable {video}.transcript.json next to each source video
    # after transcription. Default ON; user can disable via env if their footage
    # lives on a read-only mount.
    WRITE_TRANSCRIPT_SIDECAR: bool = True

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
        s = Settings()
        # Auto-resolve ffmpeg paths after env-var processing so users with
        # ffmpeg installed via winget/chocolatey don't have to set PATH.
        resolved_ffmpeg = _resolve_ffmpeg_path(s.FFMPEG_PATH)
        resolved_ffprobe = _resolve_ffmpeg_path(s.FFPROBE_PATH)
        if resolved_ffmpeg != s.FFMPEG_PATH:
            logger.info(f"Resolved ffmpeg: {s.FFMPEG_PATH} -> {resolved_ffmpeg}")
            s.FFMPEG_PATH = resolved_ffmpeg
        if resolved_ffprobe != s.FFPROBE_PATH:
            logger.info(f"Resolved ffprobe: {s.FFPROBE_PATH} -> {resolved_ffprobe}")
            s.FFPROBE_PATH = resolved_ffprobe
        if resolved_ffmpeg == "ffmpeg" and not shutil.which("ffmpeg"):
            logger.warning(
                "ffmpeg not found on PATH or in common install dirs. "
                "Audio extraction will fail. Install via 'winget install Gyan.FFmpeg' "
                "or place ffmpeg.exe under data/tools/ffmpeg-VERSION/bin/."
            )
        _settings_instance = s
    return _settings_instance


def init_dirs():
    """Ensure data directories exist."""
    s = get_settings()
    for d in [s.DATA_DIR, s.MEDIA_CACHE_DIR, s.OUTPUT_DIR, s.DB_PATH.parent, s.HF_CACHE_DIR]:
        d.mkdir(parents=True, exist_ok=True)
    logger.info(f"HF cache dir: {s.HF_CACHE_DIR}")
    logger.info(f"FFmpeg: {s.FFMPEG_PATH}")
