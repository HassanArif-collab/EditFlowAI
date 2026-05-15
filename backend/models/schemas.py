"""
EditFlow AI - Data Schemas
Pydantic models for all API requests, responses, and internal data structures.
"""
from __future__ import annotations
import uuid
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


# ═══════════════════════════════════════════
# Enums
# ═══════════════════════════════════════════

class MessageRole(str, Enum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"

class IntentType(str, Enum):
    ANALYZE = "analyze"               # Analyze media/sequence
    TRANSCRIBE = "transcribe"         # Transcribe audio/video
    CATALOG = "catalog"               # Build/update B-roll catalog
    GENERATE = "generate"             # Generate edit script
    REFINE = "refine"                 # Refine existing script
    EXECUTE = "execute"               # Execute script to timeline
    QUERY = "query"                   # Query sequence state
    UNDO = "undo"                     # Undo last action
    CONFIGURE = "configure"           # Change settings/model
    HELP = "help"                     # Ask for help
    CHITCHAT = "chitchat"            # General conversation
    UNKNOWN = "unknown"              # Could not classify

class ClipType(str, Enum):
    A_ROLL = "a_roll"
    B_ROLL = "b_roll"
    A_AUDIO = "a_audio"
    TITLE = "title"
    TRANSITION = "transition"

class ScriptStatus(str, Enum):
    DRAFT = "draft"
    PREVIEWED = "previewed"
    APPROVED = "approved"
    EXECUTING = "executing"
    COMPLETED = "completed"
    FAILED = "failed"

class ExecutionStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    ROLLED_BACK = "rolled_back"



# ═══════════════════════════════════════════
# Intent Classification
# ═══════════════════════════════════════════

class IntentResult(BaseModel):
    intent: IntentType
    confidence: float = 0.0
    entities: Dict[str, Any] = Field(default_factory=dict)
    raw_response: str = ""


# ═══════════════════════════════════════════
# Media & Transcription
# ═══════════════════════════════════════════

class MediaInfo(BaseModel):
    path: str
    filename: str
    duration: float = 0.0
    width: int = 0
    height: int = 0
    fps: float = 0.0
    codec: str = ""
    has_audio: bool = False
    file_size: int = 0

class TranscriptWord(BaseModel):
    word: str
    start: float
    end: float
    probability: float = 1.0

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


# ═══════════════════════════════════════════
# B-Roll Catalog
# ═══════════════════════════════════════════

class CatalogEntry(BaseModel):
    filename: str
    path: str
    duration: float = 0.0
    width: int = 0
    height: int = 0
    visual_description: str = ""
    keywords: List[str] = Field(default_factory=list)
    categories: List[str] = Field(default_factory=list)
    thumbnail_path: Optional[str] = None
    analyzed_at: Optional[datetime] = None
    analysis_model: Optional[str] = None

class CatalogResult(BaseModel):
    entries: List[CatalogEntry] = Field(default_factory=list)
    total_count: int = 0
    last_updated: Optional[datetime] = None


# ═══════════════════════════════════════════
# Edit Script
# ═══════════════════════════════════════════

class EditClip(BaseModel):
    """A single clip in an edit script."""
    id: str = Field(default_factory=lambda: str(uuid.uuid4())[:8])
    clip_type: ClipType = ClipType.B_ROLL
    source_file: str = ""
    source_path: str = ""
    in_point: float = 0.0      # seconds into source
    out_point: float = 0.0     # seconds into source
    start_time: float = 0.0    # position on timeline
    duration: float = 0.0      # out_point - in_point
    track: int = 0             # track index
    scale: float = 100.0       # scale percentage
    speed: float = 1.0         # playback speed
    effects: List[Dict[str, Any]] = Field(default_factory=list)
    notes: str = ""

class ScriptSection(BaseModel):
    """A section/act of an edit script."""
    name: str = ""
    description: str = ""
    clips: List[EditClip] = Field(default_factory=list)
    start_time: float = 0.0
    end_time: float = 0.0

class ScriptPreview(BaseModel):
    """Preview of a generated edit script for user review."""
    id: str = Field(default_factory=lambda: str(uuid.uuid4())[:8])
    title: str = ""
    template: str = ""
    sections: List[ScriptSection] = Field(default_factory=list)
    all_clips: List[EditClip] = Field(default_factory=list)
    total_duration: float = 0.0
    status: ScriptStatus = ScriptStatus.DRAFT
    created_at: datetime = Field(default_factory=datetime.utcnow)
    version: int = 1
    notes: str = ""


# ═══════════════════════════════════════════
# Chat Messages & Actions
# ═══════════════════════════════════════════

class PremiereAction(BaseModel):
    """Action to be executed by the client on Premiere Pro."""
    type: str  # "premiere_command", "generate_script", "execute_script"
    command: Optional[str] = None  # ExtendScript command name
    parameters: dict = Field(default_factory=dict)

class ChatMessage(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    role: MessageRole
    content: str
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    metadata: Dict[str, Any] = Field(default_factory=dict)

class ChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None
    context: Optional[Dict[str, Any]] = None

class ChatResponse(BaseModel):
    """Updated chat response with structured actions."""
    message: ChatMessage
    intent: str = "chat"
    actions: List[PremiereAction] = Field(default_factory=list)
    parameters: dict = Field(default_factory=dict)
    script_preview: Optional[ScriptPreview] = None
    session_id: Optional[str] = None


# ═══════════════════════════════════════════
# EDL (Edit Decision List) - For ExtendScript
# ═══════════════════════════════════════════

class EDLClip(BaseModel):
    """Clip instruction for ExtendScript to execute."""
    id: str
    action: str = "add"        # add, remove, move, modify
    clip_type: ClipType
    source_path: str
    in_point: float
    out_point: float
    start_time: float
    track_index: int
    scale: float = 100.0
    speed: float = 1.0
    effects: List[Dict[str, Any]] = Field(default_factory=list)

class EDLInstruction(BaseModel):
    """Complete EDL instruction set for ExtendScript."""
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    script_id: str = ""
    clips: List[EDLClip] = Field(default_factory=list)
    undo_group: str = "EditFlow AI"
    created_at: datetime = Field(default_factory=datetime.utcnow)


# ═══════════════════════════════════════════
# Sequence State
# ═══════════════════════════════════════════

class SequenceClip(BaseModel):
    """Represents a clip currently on the Premiere timeline."""
    name: str = ""
    path: str = ""
    track_index: int = 0
    track_type: str = "video"   # video, audio
    in_point: float = 0.0
    out_point: float = 0.0
    start_time: float = 0.0
    end_time: float = 0.0
    duration: float = 0.0
    scale: float = 100.0
    speed: float = 1.0

class SequenceState(BaseModel):
    """Current state of the active Premiere sequence."""
    name: str = ""
    width: int = 1080
    height: int = 1920
    fps: float = 60.0
    duration: float = 0.0
    video_tracks: int = 0
    audio_tracks: int = 0
    clips: List[SequenceClip] = Field(default_factory=list)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


# ═══════════════════════════════════════════
# Model Management
# ═══════════════════════════════════════════

class OllamaModel(BaseModel):
    name: str
    size: str = ""
    modified_at: str = ""
    is_local: bool = True
    is_vision: bool = False
    is_downloaded: bool = False
    status: str = ""  # downloading, ready, error

class ModelListResponse(BaseModel):
    local_models: List[OllamaModel] = Field(default_factory=list)
    cloud_models: List[OllamaModel] = Field(default_factory=list)
    active_chat_model: str = ""
    active_vision_model: str = ""


# ═══════════════════════════════════════════
# Multi-Provider Management
# ═══════════════════════════════════════════

class ProviderType(str, Enum):
    OLLAMA = "ollama"
    OPENAI_COMPATIBLE = "openai_compatible"
    CUSTOM = "custom"

class ProviderStatus(str, Enum):
    UNKNOWN = "unknown"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    ERROR = "error"
    UNCONFIGURED = "unconfigured"

class ProviderConfig(BaseModel):
    """Configuration for an LLM provider."""
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
    """Full provider info including status."""
    id: str
    name: str
    type: str
    base_url: str
    api_key_set: bool = False  # Don't expose the actual key
    timeout: int = 10
    enabled: bool = True
    is_default: bool = False
    status: str = ProviderStatus.UNKNOWN.value
    last_checked: Optional[str] = None
    error: Optional[str] = None
    models: List[str] = Field(default_factory=list)
    chat_model: str = ""
    vision_model: str = ""
    is_active_chat: bool = False
    is_active_vision: bool = False

class ModelInfo(BaseModel):
    """A single model from any provider."""
    id: str
    name: str
    provider_id: str
    provider_name: str
    provider_type: str
    size: str = ""
    is_vision: bool = False
    is_local: bool = False
    is_active_chat: bool = False
    is_active_vision: bool = False

class ProviderTestResult(BaseModel):
    """Result of testing a provider connection."""
    success: bool
    response: str = ""
    source: str = ""
    provider_id: str = ""
    model: str = ""
    error: Optional[str] = None

class SetActiveModelRequest(BaseModel):
    """Request to set the active chat or vision model."""
    provider_id: str
    model: str
    role: str = "chat"  # "chat" or "vision"


# ═══════════════════════════════════════════
# Progress & WebSocket
# ═══════════════════════════════════════════

class ProgressEvent(BaseModel):
    """Real-time progress update sent via WebSocket."""
    task_id: str
    task_type: str     # transcribe, catalog, generate, execute
    status: str        # started, progress, completed, failed
    progress: float = 0.0  # 0.0 to 1.0
    message: str = ""
    data: Optional[Dict[str, Any]] = None

class WSMessage(BaseModel):
    """Generic WebSocket message."""
    type: str
    payload: Dict[str, Any] = Field(default_factory=dict)


# ═══════════════════════════════════════════
# Error Handling
# ═══════════════════════════════════════════

class ErrorReport(BaseModel):
    """Error report sent to user when something fails."""
    task: str
    error: str
    fallback_tried: List[str] = Field(default_factory=list)
    suggestion: str = ""
    can_undo: bool = False
    can_retry: bool = True

class APIResponse(BaseModel):
    """Standard API response wrapper."""
    success: bool = True
    message: str = ""
    data: Optional[Any] = None
    error: Optional[str] = None
