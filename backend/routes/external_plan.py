"""HTTP routes for the external-LLM paste workflow.

Two endpoints, both stateless so they're callable from either the LLM agent
or the orchestrator state machine:

  POST /external-plan/build-prompt
      Resolve bin_references → cached transcripts → write a clipboard-
      friendly prompt file next to the first clip.  Returns the path.

  POST /external-plan/ingest
      Parse pasted JSON, resolve bin_references → clip paths, build a Plan,
      save it.  Returns the plan_id (frontend then calls /plan/{id}/apply).
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services.bin_resolver import AmbiguousReferenceError, resolve as resolve_bins
from ..services.external_plan import (
    ExternalPlanError,
    build_cutplan_prompt,
    build_paste_prompt,
    build_plan_from_pasted_json,
    build_transcription_prompt,
)
from ..services.whisper_service import whisper_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/external-plan", tags=["external-plan"])


# ── Helpers ────────────────────────────────────────────────────


def _get_project_scan() -> Any:
    """Lazy import of premiere route's project context.

    Mirrors backend/routes/edit.py — the project scan lives on the premiere
    route's module state.  We import lazily to avoid circular imports.
    """
    from . import premiere
    return getattr(premiere, "_project_context", None) or {}


async def _resolve_bins_to_words(
    bin_references: list[str],
) -> tuple[dict, dict, list[str]]:
    """Resolve bin references → (transcripts_ready, word_lookup, missing_names).

    transcripts_ready maps absolute clip_path → "cached".
    word_lookup maps absolute clip_path → list[TranscriptWord].
    missing_names lists clip basenames whose transcripts couldn't be loaded.
    """
    if not bin_references:
        raise HTTPException(status_code=400, detail="bin_references is required")

    project_scan = _get_project_scan()
    try:
        clips = resolve_bins(bin_references, project_scan)
    except AmbiguousReferenceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not clips:
        raise HTTPException(
            status_code=400,
            detail="No audio clips found in the referenced bins. Scan the project first.",
        )

    transcripts_ready: dict = {}
    word_lookup: dict = {}
    missing: list[str] = []

    for clip in clips:
        try:
            tr = await whisper_service.transcribe_fingerprinted(
                clip.path,
                language=None,
                force=False,  # cache-only behaviour in practice
            )
            words = []
            for seg in getattr(tr, "segments", []) or []:
                for w in getattr(seg, "words", []) or []:
                    words.append(w)
            if words:
                transcripts_ready[clip.path] = "cached"
                word_lookup[clip.path] = words
            else:
                missing.append(Path(clip.path).name)
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "external_plan: no cached transcript for %s: %s", clip.path, e
            )
            missing.append(Path(clip.path).name)

    if not word_lookup:
        raise HTTPException(
            status_code=400,
            detail=(
                "None of the bin's clips have a cached transcript. "
                "Transcribe them first, then retry. "
                f"Missing: {', '.join(missing)}"
            ),
        )

    return transcripts_ready, word_lookup, missing


async def _resolve_bins_to_paths(bin_references: list[str]) -> dict:
    """Resolve bin references → ``{clip_path: "ready"}`` WITHOUT loading transcripts.

    /ingest only needs clip *paths* to map a pasted cut's ``source_file`` (a bare
    filename) to an absolute path — it does NOT need the transcript text.  This
    matters for the Gemini-transcription workflow: those clips were transcribed
    in the browser and have no cached Whisper transcript on disk, so requiring
    one (as ``_resolve_bins_to_words`` does) would wrongly reject a valid paste.
    """
    if not bin_references:
        raise HTTPException(status_code=400, detail="bin_references is required")

    project_scan = _get_project_scan()
    try:
        clips = resolve_bins(bin_references, project_scan)
    except AmbiguousReferenceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not clips:
        raise HTTPException(
            status_code=400,
            detail="No audio clips found in the referenced bins. Scan the project first.",
        )

    return {clip.path: "ready" for clip in clips}


# ── /build-prompt ──────────────────────────────────────────────


class BuildPromptRequest(BaseModel):
    bin_references: list[str]
    script: Optional[str] = ""


@router.post("/build-prompt")
async def build_prompt(req: BuildPromptRequest):
    """Build the LLM-paste prompt and write it to disk next to the first clip.

    Returns ``{prompt_path, prompt_chars, clips_included, clips_missing}``.
    """
    transcripts_ready, word_lookup, missing = await _resolve_bins_to_words(
        req.bin_references
    )

    prompt = build_paste_prompt(
        script=(req.script or "").strip(),
        transcripts_ready=transcripts_ready,
        word_lookup=word_lookup,
    )

    # Write next to first clip so the user can find it in their project folder.
    first_clip = next(iter(word_lookup.keys()))
    prompt_path = Path(first_clip).parent / "editflow_llm_prompt.txt"
    try:
        prompt_path.write_text(prompt, encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Couldn't write prompt file: %s", exc)
        raise HTTPException(
            status_code=500,
            detail=f"Built prompt ({len(prompt)} chars) but couldn't write to disk: {exc}",
        ) from exc

    logger.info(
        "external_plan: wrote prompt to %s (%d chars, %d clips)",
        prompt_path, len(prompt), len(word_lookup),
    )
    return {
        "prompt_path": str(prompt_path),
        "prompt_chars": len(prompt),
        "prompt": prompt,
        "clips_included": list(word_lookup.keys()),
        "clips_missing": missing,
    }


# ── /ingest ────────────────────────────────────────────────────


class IngestRequest(BaseModel):
    pasted_text: str
    # Either bin_references (orchestrator path) OR transcripts_ready (agent path)
    bin_references: Optional[list[str]] = None
    transcripts_ready: Optional[dict] = None
    bin_reference: Optional[str] = "@external"
    script: Optional[str] = ""
    user_hint: Optional[str] = None


@router.post("/ingest")
async def ingest(req: IngestRequest):
    """Build a Plan from pasted JSON. Returns ``{plan_id, summary, gaps}``.

    Accepts either:
      - ``bin_references=[...]``  (orchestrator path — we resolve to clip paths)
      - ``transcripts_ready={...}``  (agent path — already resolved)
    """
    if req.transcripts_ready:
        transcripts_ready = req.transcripts_ready
    elif req.bin_references:
        # Path-only resolution: ingest just needs clip paths to resolve each
        # cut's source_file.  It must NOT require a cached Whisper transcript,
        # or the Gemini-transcription flow (no Whisper cache) gets blocked.
        transcripts_ready = await _resolve_bins_to_paths(req.bin_references)
    else:
        raise HTTPException(
            status_code=400,
            detail="Either transcripts_ready or bin_references is required.",
        )

    bin_ref = req.bin_reference or (
        req.bin_references[0] if req.bin_references else "@external"
    )

    try:
        plan = build_plan_from_pasted_json(
            req.pasted_text,
            bin_reference=bin_ref,
            script=(req.script or "").strip(),
            transcripts_ready=transcripts_ready,
            user_hint=req.user_hint,
        )
    except ExternalPlanError as exc:
        logger.warning("External plan ingest failed: %s", exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {
        "plan_id": plan.plan_id,
        "summary": plan.summary,
        "gaps": plan.gaps,
        "cuts_count": len(plan.cuts),
    }


# ── /cutplan-prompt ────────────────────────────────────────────


class CutplanPromptRequest(BaseModel):
    bin_references: list[str]
    script: Optional[str] = ""


@router.post("/cutplan-prompt")
async def cutplan_prompt(req: CutplanPromptRequest):
    """Build the cut-planning prompt for the Gemini-transcription workflow.

    Unlike /build-prompt, this does NOT require cached transcripts — the user
    pastes the (Gemini) transcript into the model themselves.  We only need the
    clip filenames (so the model's ``source_file`` resolves) and the script.

    Returns ``{prompt, prompt_chars, prompt_path, source_files}``.
    """
    paths = await _resolve_bins_to_paths(req.bin_references)
    source_files = sorted({Path(p).name for p in paths})

    prompt = build_cutplan_prompt(
        script=(req.script or "").strip(),
        source_files=source_files,
    )

    # Best-effort: also drop the prompt next to the first clip for convenience.
    # The textarea in the panel is the primary delivery, so a write failure is
    # non-fatal here (unlike /build-prompt, whose file is its main output).
    first_clip = next(iter(paths.keys()))
    saved_path: Optional[str] = None
    try:
        p = Path(first_clip).parent / "editflow_cutplan_prompt.txt"
        p.write_text(prompt, encoding="utf-8")
        saved_path = str(p)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Couldn't write cutplan prompt file: %s", exc)

    logger.info(
        "external_plan: built cutplan prompt (%d chars, %d source files)",
        len(prompt), len(source_files),
    )
    return {
        "prompt": prompt,
        "prompt_chars": len(prompt),
        "prompt_path": saved_path,
        "source_files": source_files,
    }


# ── /transcription-prompt ──────────────────────────────────────


@router.get("/transcription-prompt")
async def transcription_prompt():
    """Return the step-1 Gemini transcription prompt (static, no project state).

    The user pastes this into Gemini with the video attached; Gemini's JSON
    output is then fed into the /cutplan-prompt (step 2).  Returns the same
    ``{prompt, prompt_chars}`` shape the panel's prompt-box renders.
    """
    prompt = build_transcription_prompt()
    return {"prompt": prompt, "prompt_chars": len(prompt)}
