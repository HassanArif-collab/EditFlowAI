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


def _find_balanced_objects(text: str):
    """Yield (start, end_exclusive) indices for every top-level balanced
    {...} object in *text*.

    Tracks string state so braces inside JSON strings (e.g. ``"foo {bar}"``)
    don't confuse the counter.  We use this instead of a regex because
    JSON objects nest arbitrarily and a regex of the form ``\\{[^{}]*\\}``
    can't see past a nested object — meaning ``{"meta":{"x":1},"cuts":[]}``
    would fail.  (We hit exactly that on a Claude paste in testing.)
    """
    i = 0
    while i < len(text):
        if text[i] != "{":
            i += 1
            continue
        # Found a candidate object start — scan forward for the matching brace
        depth = 0
        in_string = False
        escape = False
        j = i
        while j < len(text):
            ch = text[j]
            if in_string:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == '"':
                    in_string = False
            else:
                if ch == '"':
                    in_string = True
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        yield (i, j + 1)
                        i = j + 1
                        break
            j += 1
        else:
            # Ran off the end without closing — this candidate is junk.
            i += 1


def _extract_json(raw: str) -> dict:
    """Pull a JSON object from arbitrary text.

    Accepts either pure JSON or a fenced/embedded block.  Raises
    ExternalPlanError on failure.

    Strategy (in order):
      1. Try direct json.loads.
      2. Find ```json``` fences and parse what's inside.
      3. Find every balanced {...} block and pick the first one that has a
         ``cuts`` array (in case the user pasted multiple objects, or there
         are JSON-looking decoys like config snippets).
    """
    raw = raw.strip()
    if not raw:
        raise ExternalPlanError("Pasted plan is empty.")

    # 1. Direct parse
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    # 2. Try EACH fenced ``` block (some models emit multiple blocks)
    for m in re.finditer(r"```(?:json)?\s*(.*?)```", raw, re.DOTALL):
        body = m.group(1).strip()
        try:
            parsed = json.loads(body)
            if isinstance(parsed, dict) and "cuts" in parsed:
                return parsed
        except json.JSONDecodeError:
            continue

    # 3. Walk every balanced {...} object in the raw text
    last_parse_error: Optional[str] = None
    for start, end in _find_balanced_objects(raw):
        candidate = raw[start:end]
        if '"cuts"' not in candidate:
            # Cheap pre-filter: skip objects that obviously aren't our plan
            continue
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError as exc:
            last_parse_error = str(exc)
            continue
        if isinstance(parsed, dict) and "cuts" in parsed:
            return parsed

    if last_parse_error:
        raise ExternalPlanError(
            f"Found a JSON-looking block but couldn't parse it: {last_parse_error}"
        )
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
    matches = [p for p in transcripts_ready.keys() if Path(p).name.lower() == req_name]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        # Two clips with the same basename in different folders — we can't
        # safely pick.  Force the user to use the full path.
        raise ExternalPlanError(
            f"source_file '{requested}' is ambiguous; multiple transcribed "
            f"clips have that filename: {matches}.  Use the full path."
        )

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


# ── Cut-plan prompt for the Gemini-transcription workflow ────────
#
# build_paste_prompt (above) bundles OUR cached Whisper word-level transcript.
# This builder is for the other flow: the user transcribed each clip in a
# frontier model (e.g. Gemini) and will paste THAT transcript in themselves,
# so we embed no transcript — only the script and the valid source filenames.
#
# The one rule that matters: cut on SEGMENT-level timestamps, never per-word.
# Gemini's word-level start/end values collapse to identical numbers inside
# long segments (we've seen dozens of words all sharing one start==end), so
# word boundaries are unreliable; segment start_seconds/end_seconds stay
# accurate.  If the model cuts on word times the result is mis-placed cuts.

_CUTPLAN_HEADER = """You are helping me cut a Premiere Pro timeline from a transcript.

Below this prompt I will paste the transcript of one or more source clips as
JSON.  Each clip's transcript has a `segments` array; each segment has
`start_seconds`, `end_seconds`, and `text` (and a `words` array you must
IGNORE — see the rule below).  Multiple takes of the same line are mixed
throughout — your job is to pick which segment span corresponds to each script
line, preferring the cleanest delivery (no fillers, no false starts, complete
sentences), and the LAST clean take when a line was re-recorded.

Output STRICT JSON in this exact schema and nothing else:

```json
{
  "version": 1,
  "cuts": [
    {
      "beat_text": "<the script line, copied verbatim>",
      "source_file": "<one of the exact filenames listed under SOURCE FILES>",
      "source_in":  <number, seconds = a segment's start_seconds>,
      "source_out": <number, seconds = a segment's end_seconds>,
      "rationale": "<short reason, optional>"
    }
  ]
}
```

Rules:
- CRITICAL: source_in / source_out MUST come from SEGMENT-level start_seconds /
  end_seconds.  Do NOT use the per-word timestamps — they are unreliable and
  collapse to identical values inside long segments.  When a line spans several
  segments, use the first segment's start_seconds and the last segment's
  end_seconds.
- source_file MUST be copied verbatim from the SOURCE FILES list below.  If I
  pasted more than one clip, each transcript is preceded by a line
  `### FILE: <filename>` — use that filename for cuts taken from it.  If only
  one file is listed, use it for every cut.
- One cut per script line, in script order.  Skip a line by omitting it.
- Output only the JSON.  No prose, no markdown around it.
"""

_CUTPLAN_NO_SCRIPT_NOTE = (
    "(No script provided.  Instead, pick the cleanest, most complete takes in "
    "the transcript and output them in the order they should appear on the "
    "timeline — one cut per kept segment span.)"
)


def build_cutplan_prompt(
    *,
    script: str,
    source_files: list[str],
) -> str:
    """Build the prompt the user pastes into the cut-planning model.

    The Gemini-workflow counterpart to build_paste_prompt: embeds the script
    and the valid source filenames but NOT any transcript (the user pastes the
    transcript directly after this prompt).
    """
    parts: list[str] = [_CUTPLAN_HEADER, ""]

    parts.append("=== SOURCE FILES (use these exact names for source_file) ===")
    for name in source_files:
        parts.append(f"  {name}")
    parts.append("")

    parts.append("=== SCRIPT ===")
    script = (script or "").strip()
    parts.append(script if script else _CUTPLAN_NO_SCRIPT_NOTE)
    parts.append("")

    parts.append("=== PASTE THE TRANSCRIPT JSON BELOW THIS LINE ===")
    parts.append("")

    return "\n".join(parts)


# ── Step 1 of the Gemini workflow: the transcription prompt ──────
#
# This is what the user pastes into Gemini WITH the video attached.  Its output
# JSON is exactly what build_cutplan_prompt (step 2) expects to consume:
# a ``segments`` array of {start_seconds, end_seconds, text}.  We deliberately
# ask for SEGMENT-level times only and NO per-word array — Gemini's per-word
# timestamps collapse to identical values inside long segments, so leaving them
# out removes the one unreliable thing from the pipeline.

_TRANSCRIPTION_HEADER = """You are transcribing a video for a Premiere Pro edit.
I have attached/uploaded the video — transcribe its spoken audio.

Output STRICT JSON in EXACTLY this schema and nothing else:

```json
{
  "segments": [
    { "start_seconds": <number>, "end_seconds": <number>, "text": "<verbatim words>" }
  ]
}
```

Rules:
- Transcribe VERBATIM in the original spoken language (e.g. Urdu / Hindi in its
  native script).  Do NOT translate and do NOT summarise.
- One segment per sentence or natural pause — aim for 2-12 seconds per segment.
  Keep a complete thought together; start a new segment at a clear pause.
- start_seconds / end_seconds are the segment's start and end time in SECONDS
  from the very start of the video (e.g. 12.480).  Be as accurate as you can.
- Include EVERY spoken segment in order, INCLUDING false starts and repeated
  takes of the same line — do NOT skip or merge repeats.  The next step picks
  the best take, so it needs to see all of them.
- Do NOT output a per-word breakdown.  Segment-level times only.
- Output only the JSON object.  No prose, no markdown fences around it.
"""


def build_transcription_prompt() -> str:
    """Return the step-1 prompt the user pastes into Gemini with the video.

    Static by design: it instructs the model to emit the ``segments`` schema
    that build_cutplan_prompt consumes, independent of any project state.
    """
    return _TRANSCRIPTION_HEADER
