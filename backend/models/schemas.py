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
    no_speech_prob: float = 0.0
    compression_ratio: float = 1.0
    avg_logprob: float = 0.0


class TranscriptResult(BaseModel):
    source_file: str
    language: str = ""
    duration: float = 0.0
    segments: List[TranscriptSegment] = Field(default_factory=list)
    full_text: str = ""
    # Phase B: content-addressed fields
    content_hash: str = ""
    range_in: float = 0.0
    range_out: float = 0.0
    audio_offset: float = 0.0
    engine: str = "faster_whisper"  # "whisperx" | "stable_ts" | "faster_whisper"
    model: str = ""
    model_revision: str = ""
    warnings: List[str] = Field(default_factory=list)


class VADSegment(BaseModel):
    """A single VAD (Voice Activity Detection) segment."""
    start: float
    end: float
    is_speech: bool = True
    confidence: float = 1.0


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


# ── Active Sequence Phrase Cuts ──

class SequenceAudioClip(BaseModel):
    """A single audio clip from the active Premiere sequence sent by the CEP panel."""
    sequence_name: str = ""
    track_index: int = 0
    clip_index: int = 0
    clip_name: str = ""
    media_path: str = ""
    timeline_start: float = 0.0
    timeline_end: float = 0.0
    source_in: float = 0.0
    source_out: float = 0.0
    speed: float = 1.0


class SequenceAnalyzeRequest(BaseModel):
    """Trigger Whisper transcription of every audio clip in the active sequence."""
    sequence_id: str = ""
    sequence_name: str = ""
    language: Optional[str] = None
    audio_clips: List[SequenceAudioClip] = Field(default_factory=list)
    client_id: Optional[str] = None  # For WebSocket progress reporting


class SequenceAnalyzeResponse(BaseModel):
    success: bool = False
    sequence_id: str = ""
    sequence_name: str = ""
    transcript_id: str = ""
    clips_analyzed: int = 0
    words_indexed: int = 0
    skipped_clips: List[str] = Field(default_factory=list)
    message: str = ""


class SequencePhraseRequest(BaseModel):
    """Search a phrase in an already-analyzed sequence."""
    sequence_id: str = ""
    sequence_name: str = ""
    phrase: str
    padding_before: float = 0.05
    padding_after: float = 0.08
    min_confidence: float = 0.0


class SequencePhraseRange(BaseModel):
    """One detected occurrence of the search phrase on the timeline."""
    start: float
    end: float
    text: str = ""
    words: List[str] = Field(default_factory=list)
    track_index: int = 0
    clip_index: int = 0
    clip_name: str = ""
    media_path: str = ""


class SequencePhraseResponse(BaseModel):
    success: bool = False
    phrase: str = ""
    ranges: List[SequencePhraseRange] = Field(default_factory=list)
    message: str = ""


# ── Phase B: Content-Addressed Audio Prepare ──

class PreparedAudio(BaseModel):
    """Result of content-addressed audio preparation (Stage 2).

    Contains both the file-level fingerprint (SHA-256 of the source file
    bytes) and the audio-level fingerprint (SHA-256 of the decoded PCM
    data), along with the path to the cached 16 kHz mono WAV.
    """
    source_file: str
    file_fingerprint: str = ""
    audio_fingerprint: str = ""
    prepared_wav_path: str = ""
    duration: float = 0.0
    sample_rate: int = 16000
    channels: int = 1
    from_cache: bool = False


class FingerprintResult(BaseModel):
    """Fingerprint computation result for a media file."""
    path: str
    file_fingerprint: str = ""
    audio_fingerprint: str = ""
    file_size: int = 0
    duration: float = 0.0


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
    fingerprint: str = ""


# ── API Response ──

class APIResponse(BaseModel):
    success: bool = True
    message: str = ""
    data: Dict[str, Any] = Field(default_factory=dict)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
