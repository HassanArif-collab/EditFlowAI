"""External-LLM paste workflow.

Builds a Plan from a JSON blob the user pasted back from a frontier model
(Claude, ChatGPT, Gemini, etc.).  This bypasses the local matcher + LLM
re-rank entirely: the frontier model has the script and full word-level
transcript, picks `source_in`/`source_out` in seconds, and we just turn
that into a Plan that the existing apply pipeline can execute.

Why this exists
---------------
The local 4B-class LLM can't reliably:
  - cluster Urdu/Hindi retakes
  - pick the right word boundaries within a take
  - distinguish a script line from neighbouring content
Frontier models can.  Letting the user do that work in their browser is
~zero engineering and removes every guess from the pipeline.

Design constraints
------------------
- Schema is intentionally tiny: ``source_file``, ``source_in``, ``source_out``,
  ``beat_text``.  Anything else is optional.
- The service NEVER edits the legacy auto-matcher path.  It only writes a
  fresh Plan and stores it under ``data/plans/``.
- We frame-align in/out to 30 fps (iPhone source default) the same way the
  auto-matcher does, so timeline placement is consistent.
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .cut_planner import Cut, Plan
from .plan_store import plan_store

logger = logging.getLogger(__name__)

# Frame alignment for iPhone 30 fps source — matches cut_planner default.
_SOURCE_FPS = 30.0
_FRAME_QUANTUM_S = 1.0 / _SOURCE_FPS


class ExternalPlanError(ValueError):
    """Raised when a pasted plan can't be turned into a real Plan."""


# ── JSON extraction ────────────────────────────────────────────

# Frontier models often wrap JSON in ```json``` fences or surrounding prose.
# This regex pulls out the first balanced {...} that contains "cuts".
_JSON_BLOCK_RE = re.compile(
    r"\{[^{}]*\"cuts\"\s*:\s*\[.*?\]\s*[^{}]*\}",
    re.DOTALL,
)


def _extract_json(raw: str) -> dict:
    """Pull a JSON object from arbitrary text.

    Accepts either pure JSON or a fenced/embedded block.  Raises
    ExternalPlanError on failure.
    """
    raw = raw.strip()
    if not raw:
        raise ExternalPlanError("Pasted plan is empty.")

    # Try direct parse first
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    # Strip common ``` fences
    fenced = re.search(r"```(?:json)?\s*(.*?)```", raw, re.DOTALL)
    if fenced:
        body = fenced.group(1).strip()
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            pass

    # Last resort: find the first balanced object with "cuts" key
    match = _JSON_BLOCK_RE.search(raw)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError as exc:
            raise ExternalPlanError(
                f"Found a JSON-looking block but couldn't parse it: {exc}"
            ) from exc

    raise ExternalPlanError(
        "Couldn't find a JSON object in the pasted text. "
        "Make sure it contains a 'cuts' array."
    )


# ── Source-file resolution ─────────────────────────────────────

def _resolve_source_file(
    requested: str,
    transcripts_ready: dict,
) -> str:
    """Map a bare filename or path to the absolute path of a known clip.

    The frontier LLM only sees filenames like ``IMG_1694.MOV`` — we need to
    find the absolute path in this session's transcribed clips.  Match by
    exact path first, then by basename, case-insensitively.
    """
    if not requested:
        raise ExternalPlanError("Cut missing 'source_file'.")

    if requested in transcripts_ready:
        return requested

    req_name = Path(requested).name.lower()
    for clip_path in transcripts_ready.keys():
        if Path(clip_path).name.lower() == req_name:
            return clip_path

    available = sorted({Path(p).name for p in transcripts_ready.keys()})
    raise ExternalPlanError(
        f"source_file '{requested}' isn't a transcribed clip in this session. "
        f"Available: {', '.join(available) or '(none)'}"
    )


# ── Frame snapping ─────────────────────────────────────────────

def _snap_to_frame(seconds: float) -> float:
    """Round to the nearest 30 fps frame boundary."""
    return round(seconds / _FRAME_QUANTUM_S) * _FRAME_QUANTUM_S


# ── Main entry point ───────────────────────────────────────────

def build_plan_from_pasted_json(
    raw_text: str,
    *,
    bin_reference: str,
    script: str,
    transcripts_ready: dict,
    user_hint: Optional[str] = None,
) -> Plan:
    """Parse the pasted JSON and build a Plan ready for apply_plan.

    Validation:
      - At least 1 cut
      - source_in < source_out, both >= 0
      - source_file resolvable in transcripts_ready
      - Duration in [0.3, 60.0] seconds
    Cuts that fail individual validation are skipped and recorded in gaps.
    Frame-aligned to 30 fps.  Sorted by their position in the array
    (the frontier model decides timeline order; we don't re-sort).
    """
    data = _extract_json(raw_text)

    if not isinstance(data, dict):
        raise ExternalPlanError("Top-level JSON must be an object.")

    raw_cuts = data.get("cuts")
    if not isinstance(raw_cuts, list) or not raw_cuts:
        raise ExternalPlanError("JSON must contain a non-empty 'cuts' array.")

    cuts: list[Cut] = []
    gaps: list[dict] = []
    timeline_cursor = 0.0
    last_matched_beat = -1

    for idx, raw in enumerate(raw_cuts):
        if not isinstance(raw, dict):
            gaps.append({
                "after_beat": last_matched_beat,
                "reason": "not_an_object",
                "beat_text": str(raw)[:80],
            })
            continue

        beat_text = str(raw.get("beat_text", "")).strip()
        source_file_raw = str(raw.get("source_file", "")).strip()

        # Resolve source file
        try:
            source_file = _resolve_source_file(source_file_raw, transcripts_ready)
        except ExternalPlanError as exc:
            gaps.append({
                "after_beat": last_matched_beat,
                "reason": f"unresolved_source: {exc}",
                "beat_text": beat_text or f"(cut #{idx})",
            })
            continue

        # Parse in/out
        try:
            source_in = float(raw.get("source_in"))
            source_out = float(raw.get("source_out"))
        except (TypeError, ValueError):
            gaps.append({
                "after_beat": last_matched_beat,
                "reason": "invalid_timestamps",
                "beat_text": beat_text or f"(cut #{idx})",
            })
            continue

        if source_in < 0 or source_out <= source_in:
            gaps.append({
                "after_beat": last_matched_beat,
                "reason": f"bad_range: in={source_in:.2f} out={source_out:.2f}",
                "beat_text": beat_text or f"(cut #{idx})",
            })
            continue

        # Frame-align
        snapped_in = _snap_to_frame(source_in)
        snapped_out = _snap_to_frame(source_out)
        if snapped_out <= snapped_in:
            # Pathological tiny cut after snap — keep at least 1 frame
            snapped_out = snapped_in + _FRAME_QUANTUM_S

        duration = snapped_out - snapped_in
        if duration < 0.3:
            gaps.append({
                "after_beat": last_matched_beat,
                "reason": f"too_short: {duration:.2f}s",
                "beat_text": beat_text or f"(cut #{idx})",
            })
            continue
        if duration > 60.0:
            gaps.append({
                "after_beat": last_matched_beat,
                "reason": f"too_long: {duration:.2f}s",
                "beat_text": beat_text or f"(cut #{idx})",
            })
            continue

        rationale = str(raw.get("rationale", "")).strip() or "external_llm_paste"
        confidence_raw = raw.get("confidence")
        try:
            confidence = float(confidence_raw) if confidence_raw is not None else 1.0
        except (TypeError, ValueError):
            confidence = 1.0

        cut = Cut(
            beat_index=idx,
            beat_text=beat_text or f"(cut #{idx})",
            take_source_file=source_file,
            source_in=round(snapped_in, 3),
            source_out=round(snapped_out, 3),
            duration=round(duration, 3),
            timeline_position=round(timeline_cursor, 3),
            audio_fade_in_ms=15,
            audio_fade_out_ms=15,
            rationale=rationale[:300],
            warnings=[],
            fell_back_to_word_boundary=False,
            take_id=f"{source_file}::external_{idx}",
            confidence=max(0.0, min(1.0, confidence)),
        )
        cuts.append(cut)
        timeline_cursor += duration
        last_matched_beat = idx

    if not cuts:
        raise ExternalPlanError(
            "Every cut in the pasted plan failed validation. "
            f"Gaps: {[g['reason'] for g in gaps]}"
        )

    plan = Plan(
        plan_id=uuid.uuid4().hex[:12],
        created_at=datetime.now(timezone.utc).isoformat(),
        bin_reference=bin_reference,
        script=script,
        user_hint=user_hint,
        matcher_model="external_llm_paste",
        cuts=cuts,
        gaps=gaps,
        summary={
            "total_duration": round(timeline_cursor, 2),
            "beats": len(raw_cuts),
            "matched": len(cuts),
            "unmatched": len(gaps),
            "low_confidence": 0,
            "estimated_apply_time_s": round(0.1 * len(cuts), 2),
        },
        level_warnings=[],
    )

    plan_store.save(plan)
    logger.info(
        "External plan ingested: %s (%d cuts, %d gaps)",
        plan.plan_id,
        len(cuts),
        len(gaps),
    )
    return plan


# ── Prompt builder for the user to paste into the frontier model ──

_PROMPT_HEADER = """You are helping me cut a Premiere Pro timeline.

Below is my script (in the original language) and the full Whisper transcript
of each source clip with word-level timestamps.  Multiple takes of the same
line are mixed throughout the transcript — your job is to pick which span of
the transcript corresponds to each script line, preferring the cleanest
delivery (no fillers, no false starts, complete sentences).

Output STRICT JSON in this exact schema and nothing else:

```json
{
  "version": 1,
  "cuts": [
    {
      "beat_text": "<the script line, copied verbatim>",
      "source_file": "<filename only, e.g. IMG_1694.MOV>",
      "source_in":  <number, seconds, matches word.start>,
      "source_out": <number, seconds, matches word.end>,
      "rationale": "<short reason, optional>"
    }
  ]
}
```

Rules:
- One cut per script line, in script order.  Skip a line by omitting it.
- source_in/source_out are SECONDS from the start of the source clip,
  taken from the word-level timestamps below — don't invent times.
- Pick the LAST clean take when a line was re-recorded.
- Include leading/trailing words for natural sentence boundaries.
- Output only the JSON.  No prose, no markdown around it.
"""


def build_paste_prompt(
    *,
    script: str,
    transcripts_ready: dict,
    word_lookup: dict,
) -> str:
    """Bundle the script + transcripts into a single prompt string.

    Args:
        script: the user's full script (one line per beat).
        transcripts_ready: session dict, ``{clip_path: TranscriptionResult-like}``.
        word_lookup: ``{clip_path: list[TranscriptWord]}``, the word-level
            timestamps we have on disk.
    """
    parts: list[str] = [_PROMPT_HEADER, ""]
    parts.append("=== SCRIPT ===")
    parts.append(script.strip())
    parts.append("")

    for clip_path, words in word_lookup.items():
        name = Path(clip_path).name
        parts.append(f"=== TRANSCRIPT: {name} ===")
        # Emit one line per word: "  12.345  18.420  word"
        for w in words:
            try:
                start = float(getattr(w, "start", 0.0) or 0.0)
                end = float(getattr(w, "end", 0.0) or 0.0)
                text = getattr(w, "word", "") or ""
            except Exception:  # noqa: BLE001
                continue
            parts.append(f"  {start:7.3f}  {end:7.3f}  {text}")
        parts.append("")

    return "\n".join(parts)
