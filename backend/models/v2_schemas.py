"""
EditFlow AI v2 schemas.
Focused on talking-head analysis, script matching, visual maps, and job-ledger execution.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class AssetRegisterRequest(BaseModel):
    path: str
    source_type: str = "local_file"
    asset_type: Optional[str] = None
    name: Optional[str] = None
    tags: List[str] = Field(default_factory=list)
    metadata: Dict[str, Any] = Field(default_factory=dict)


class AssetResponse(BaseModel):
    id: str
    path: str
    name: str
    asset_type: str
    source_type: str
    duration: float = 0.0
    width: int = 0
    height: int = 0
    fps: float = 0.0
    has_audio: bool = False
    file_size: int = 0
    fingerprint: str = ""
    status: str = "registered"
    tags: List[str] = Field(default_factory=list)
    metadata: Dict[str, Any] = Field(default_factory=dict)
    created_at: str = ""
    updated_at: str = ""


class FolderScanRequest(BaseModel):
    path: str
    recursive: bool = True
    extensions: Optional[List[str]] = None
    source_type: str = "local_folder"
    tags: List[str] = Field(default_factory=list)


class ReferenceRootRequest(BaseModel):
    alias: str
    path: str
    description: str = ""
    metadata: Dict[str, Any] = Field(default_factory=dict)


class ReferenceResolveRequest(BaseModel):
    text: str
    kind: Optional[str] = None
    root_alias: Optional[str] = None
    folder_name: Optional[str] = None
    register_assets: bool = True
    recursive: bool = False


class TranscriptSegmentV2(BaseModel):
    id: str
    asset_id: str
    start: float
    end: float
    text: str
    words: List[Dict[str, Any]] = Field(default_factory=list)


class SpeechCandidate(BaseModel):
    id: str
    asset_id: str
    start: float
    end: float
    transcript_excerpt: str
    cleaned_excerpt: str
    reason: str
    warnings: List[str] = Field(default_factory=list)
    scores: Dict[str, float] = Field(default_factory=dict)
    metadata: Dict[str, Any] = Field(default_factory=dict)


class AssetAnalyzeRequest(BaseModel):
    language: Optional[str] = None
    force: bool = False
    transcribe: bool = True
    detect_silence: bool = True
    create_candidates: bool = True


class ScriptIngestRequest(BaseModel):
    title: str = "Untitled Script"
    content: str
    source_type: str = "pasted"
    metadata: Dict[str, Any] = Field(default_factory=dict)


class ScriptDocument(BaseModel):
    id: str
    title: str
    content: str
    source_type: str
    metadata: Dict[str, Any] = Field(default_factory=dict)
    created_at: str = ""


class ScriptLine(BaseModel):
    id: str
    script_id: str
    line_index: int
    text: str
    meaning_summary: str = ""
    priority: str = "normal"
    desired_duration: Optional[float] = None
    visual_requirement: str = ""


class VisualMapIngestRequest(BaseModel):
    title: str = "Untitled Visual Map"
    content: str
    source_type: str = "pasted"
    metadata: Dict[str, Any] = Field(default_factory=dict)


class VisualMap(BaseModel):
    id: str
    title: str
    content: str
    source_type: str
    metadata: Dict[str, Any] = Field(default_factory=dict)
    created_at: str = ""


class VisualMapEntry(BaseModel):
    id: str
    visual_map_id: str
    row_index: int
    script_line_or_keyword: str
    visual_folder: str
    visual_type: str = ""
    placement_note: str = ""
    priority: str = "normal"
    matched_asset_ids: List[str] = Field(default_factory=list)


class EditPlanCreateRequest(BaseModel):
    operation: str = "build_script_guided_talking_head_sequence"
    sources: List[str] = Field(default_factory=list)
    script_id: Optional[str] = None
    visual_map_id: Optional[str] = None
    target: str = "@new_sequence"
    cleanup_style: str = "natural_clean"
    matching: str = "best_meaning_match"
    visual_density: str = "script_guided_balanced"
    constraints: Dict[str, Any] = Field(default_factory=dict)
    dry_run: bool = True


class EditPlan(BaseModel):
    id: str
    operation: str
    sources: List[str]
    script_id: Optional[str] = None
    visual_map_id: Optional[str] = None
    target: str
    cleanup_style: str
    matching: str
    visual_density: str
    constraints: Dict[str, Any] = Field(default_factory=dict)
    status: str = "planned"
    created_at: str = ""


class DryRunResult(BaseModel):
    success: bool = True
    plan_id: str
    would_change: int = 0
    estimated_duration: float = 0.0
    timeline_items: List[Dict[str, Any]] = Field(default_factory=list)
    script_coverage: List[Dict[str, Any]] = Field(default_factory=list)
    visual_placements: List[Dict[str, Any]] = Field(default_factory=list)
    missing_lines: List[Dict[str, Any]] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)


class JobResponse(BaseModel):
    id: str
    job_type: str
    status: str
    target_id: Optional[str] = None
    progress: float = 0.0
    message: str = ""
    result: Dict[str, Any] = Field(default_factory=dict)
    error: str = ""
    created_at: str = ""
    updated_at: str = ""


def utc_now() -> str:
    return datetime.utcnow().isoformat()
