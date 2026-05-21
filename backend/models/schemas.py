"""
EditFlow AI - Simplified Schemas
Core data models for the video cutting pipeline, AI chat, and provider management.
"""
from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


# ── Enums ──

class MessageRole(str, Enum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"


class ProviderType(str, Enum):
    OLLAMA = "ollama"
    OPENAI_COMPATIBLE = "openai_compatible"
    CUSTOM = "custom"


class ProviderStatus(str, Enum):
    UNKNOWN = "unknown"
    UNCONFIGURED = "unconfigured"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    ERROR = "error"


class CuttingStatus(str, Enum):
    PENDING = "pending"
    ANALYZING = "analyzing"
    MATCHING = "matching"
    CUTTING = "cutting"
    COMPLETED = "completed"
    FAILED = "failed"


# ── Chat Models ──

class ChatMessage(BaseModel):
    role: MessageRole = MessageRole.USER
    content: str


class ChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None
    context: Optional[Dict[str, Any]] = None


class ChatResponse(BaseModel):
    message: ChatMessage
    intent: str = "chat"
    parameters: Dict[str, Any] = Field(default_factory=dict)
    session_id: str = ""


# ── Media / Transcription Models ──

class TranscriptWord(BaseModel):
    word: str
    start: float
    end: float
    probability: float = 0.0


class TranscriptSegment(BaseModel):
    start: float
    end: float
    text: str
    words: List[TranscriptWord] = Field(default_factory=list)


class TranscriptResult(BaseModel):
    source_file: str
    language: str = ""
    duration: float = 0.0
    segments: List[TranscriptSegment] = Field(default_factory=list)
    full_text: str = ""


# ── Provider Models ──

class ProviderConfig(BaseModel):
    id: Optional[str] = None
    name: str = "Custom Provider"
    type: ProviderType = ProviderType.OPENAI_COMPATIBLE
    base_url: str = ""
    api_key: str = ""
    timeout: int = 10
    enabled: bool = True
    chat_model: str = ""
    vision_model: str = ""


class ProviderInfo(BaseModel):
    id: str
    name: str = ""
    type: str = "openai_compatible"
    base_url: str = ""
    api_key_set: bool = False
    timeout: int = 10
    enabled: bool = True
    is_default: bool = False
    status: str = "unknown"
    last_checked: Optional[str] = None
    error: Optional[str] = None
    models: List[Any] = Field(default_factory=list)
    chat_model: str = ""
    vision_model: str = ""
    is_active_chat: bool = False
    is_active_vision: bool = False


class ModelInfo(BaseModel):
    id: str = ""
    name: str = ""
    provider_id: str = ""
    provider_name: str = ""
    provider_type: str = ""
    size: str = ""
    is_vision: bool = False
    is_local: bool = False
    is_active_chat: bool = False


class ProviderTestResult(BaseModel):
    success: bool = False
    response: str = ""
    source: str = ""
    provider_id: str = ""
    model: str = ""
    error: Optional[str] = None


class SetActiveModelRequest(BaseModel):
    provider_id: str
    model: str
    role: str = "chat"  # "chat" or "vision"


# ── Video Analysis Pipeline Models ──

class VideoAnalysisRequest(BaseModel):
    """Request to analyze a folder of videos."""
    folder_path: str
    language: Optional[str] = None  # e.g. "ur" for Urdu
    recursive: bool = True


class ScriptMatchRequest(BaseModel):
    """Request to match a script against analyzed videos and produce a clean cut."""
    script_content: str
    script_language: str = "en"  # Script language (English by default)
    video_language: str = "ur"   # Video language (Urdu by default)
    cleanup_style: str = "natural_clean"  # natural_clean, aggressive, minimal
    source_folders: List[str] = Field(default_factory=list)  # If empty, use all analyzed videos


class VisualMapEntry(BaseModel):
    """A single mapping entry: which script line gets which visual."""
    line_number: int  # 1-based line number in the script
    line_text: str = ""  # The script line text for reference
    visual_file: str = ""  # Filename or path of the visual
    placement_note: str = ""  # e.g. "overlay", "cutaway", "full_frame"


class VisualMapRequest(BaseModel):
    """Request to place visuals based on a mapping document."""
    script_id: str = ""
    video_output_path: str = ""  # Path to the cut video
    visual_folder: str = ""  # Folder containing visual assets
    entries: List[VisualMapEntry] = Field(default_factory=list)
    document_content: str = ""  # Raw docx/txt content (alternative to structured entries)


class CutSegment(BaseModel):
    """A single segment in the final cut."""
    source_file: str
    start: float
    end: float
    text: str = ""
    script_line: str = ""  # Matched script line (English)
    confidence: float = 0.0


class CuttingResult(BaseModel):
    """Result of the script-based auto-cutting pipeline."""
    status: CuttingStatus = CuttingStatus.PENDING
    total_segments: int = 0
    matched_segments: int = 0
    unmatched_lines: List[str] = Field(default_factory=list)
    cuts: List[CutSegment] = Field(default_factory=list)
    output_path: str = ""
    duration_before: float = 0.0
    duration_after: float = 0.0
    message: str = ""


class VisualPlacementResult(BaseModel):
    """Result of visual placement on a cut video."""
    success: bool = False
    output_path: str = ""
    visuals_placed: int = 0
    visuals_missing: List[str] = Field(default_factory=list)
    message: str = ""


# ── Asset Models ──

class AssetResponse(BaseModel):
    id: str
    path: str
    name: str
    asset_type: str
    duration: float = 0.0
    has_transcript: bool = False
    language: str = ""
    status: str = "registered"


# ── API Response ──

class APIResponse(BaseModel):
    success: bool = True
    message: str = ""
    data: Dict[str, Any] = Field(default_factory=dict)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
