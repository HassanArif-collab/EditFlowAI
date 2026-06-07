"""Structured trace of the suggest pipeline, for the panel's debug drawer.

Pure data + pure functions — no I/O, no provider calls. A ``ReviewTrace`` is only
built when debug is on, so the normal suggest path pays nothing. Each stage is a
plain JSON-serialisable dict; the exact shapes are the contract the frontend
drawer renders (see docs/superpowers/plans/2026-06-07-suggest-trace-debug-drawer.md).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Optional

_JUNK_REASONS = {"filler", "non_speech", "too_short", "empty"}


@dataclass
class ReviewTrace:
    """Accumulates the per-stage decision records for one Suggest run."""

    stages: list[dict] = field(default_factory=list)

    def add(self, entry: dict) -> None:
        self.stages.append(entry)

    def to_dict(self) -> dict:
        return {"stages": self.stages}


def stage_of_reason(decision: str, reason: str) -> str:
    """Map a segment's final (decision, reason) to the stage that decided it."""
    if decision == "keep":
        return "kept"
    r = reason or ""
    if r in _JUNK_REASONS:
        return "junk"
    if r.startswith("retake_of:"):
        return "cluster"
    if r == "not_in_script":
        return "script"
    if r == "llm_off_script":
        return "llm"
    if r == "manual":
        return "manual"
    return r or "cut"


def junk_stage(segments: Iterable[Any]) -> dict:
    """Segments cut by the language-agnostic junk rules (steps 1-3 of classify)."""
    segs = list(segments)
    cut = [
        {"id": s.id, "text": s.text, "reason": s.reason}
        for s in segs
        if s.decision == "cut"
    ]
    return {
        "stage": "junk",
        "cut": cut,
        "kept_after_junk": sum(1 for s in segs if s.decision == "keep"),
    }


def cluster_stage(pairs: list[dict], segments: Iterable[Any]) -> dict:
    """Retake groups (from group_id) + the notable similarity pairs recorded
    during clustering. ``pairs`` is filled by ``_cluster_retakes``."""
    groups: dict[int, list[Any]] = {}
    for s in segments:
        if s.group_id is not None and s.group_id >= 0:
            groups.setdefault(s.group_id, []).append(s)
    clusters = []
    for gid in sorted(groups):
        members = groups[gid]
        winner = next((m.id for m in members if m.decision == "keep"), members[-1].id)
        clusters.append({
            "group_id": gid,
            "winner_id": winner,
            "members": [
                {"id": m.id, "text": m.text, "decision": m.decision} for m in members
            ],
        })
    return {"stage": "cluster", "pairs": pairs, "clusters": clusters}


def script_stage(enabled: bool, same_language: Optional[bool], matches: list[dict]) -> dict:
    """Per-segment script-match scores (only meaningful when same_language)."""
    return {
        "stage": "script",
        "enabled": enabled,
        "same_language": same_language,
        "matches": matches,
    }


def llm_stage(
    prompt: str,
    raw: str,
    max_tokens: int,
    parsed_count: int,
    segment_count: int,
    flips: list[dict],
    error: Optional[str] = None,
) -> dict:
    """The model-refine stage: prompt, raw reply, what it flipped, and a
    truncation heuristic (a complete decisions reply ends with a closing brace/
    bracket; an empty parse over a long reply is also suspect)."""
    raw = raw or ""
    stripped = raw.rstrip()
    looks_closed = stripped.endswith("}") or stripped.endswith("]")
    truncated = bool(raw) and (not looks_closed or (parsed_count == 0 and len(raw) > 200))
    return {
        "stage": "llm",
        "used": bool(raw) and error is None,
        "prompt": prompt,
        "raw_response": raw,
        "response_chars": len(raw),
        "max_tokens": max_tokens,
        "parsed_count": parsed_count,
        "segment_count": segment_count,
        "truncated": truncated,
        "flips": flips,
        "error": error,
    }


def final_stage(segments: Iterable[Any]) -> dict:
    """Per-segment final decision tagged with the stage that produced it."""
    return {
        "stage": "final",
        "segments": [
            {
                "id": s.id,
                "text": s.text,
                "decision": s.decision,
                "reason": s.reason,
                "group_id": s.group_id,
                "decided_by": stage_of_reason(s.decision, s.reason),
            }
            for s in segments
        ],
    }
