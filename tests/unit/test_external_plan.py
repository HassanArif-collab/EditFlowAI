"""Tests for the external-LLM paste workflow.

These pin the behaviour the user relies on:
  - fenced/embedded JSON survives extraction
  - bare filenames resolve to absolute paths in the session
  - invalid cuts go to gaps; one bad cut doesn't poison the rest
  - frame snap rounds to the 30 fps grid
  - duration bounds reject pathological cuts (negative, zero, > 60s)
"""
from __future__ import annotations

import pytest

from backend.services.external_plan import (
    ExternalPlanError,
    _extract_json,
    _resolve_source_file,
    _snap_to_frame,
    build_cutplan_prompt,
    build_plan_from_pasted_json,
    build_transcription_prompt,
)


# ── _extract_json ───────────────────────────────────────────────

def test_extract_json_plain():
    raw = '{"cuts": [{"x": 1}]}'
    assert _extract_json(raw) == {"cuts": [{"x": 1}]}


def test_extract_json_fenced():
    raw = "Here you go:\n```json\n{\"cuts\": [{\"x\": 1}]}\n```\nLet me know!"
    out = _extract_json(raw)
    assert out["cuts"][0]["x"] == 1


def test_extract_json_unfenced_with_prose():
    raw = 'Sure, here it is:\n{"version": 1, "cuts": [{"x": 2}]}\nThat\'s all.'
    out = _extract_json(raw)
    assert out["cuts"][0]["x"] == 2


def test_extract_json_empty_raises():
    with pytest.raises(ExternalPlanError):
        _extract_json("")


def test_extract_json_no_object_raises():
    with pytest.raises(ExternalPlanError):
        _extract_json("just plain prose with no json")


def test_extract_json_with_nested_object_before_cuts():
    """Regression: the old regex-based extractor choked on objects that had
    a nested object (e.g. ``meta``) BEFORE the ``cuts`` key.  Frontier
    models routinely emit JSON with a sibling metadata object, and we must
    not lose those."""
    raw = (
        'Here you go: {"meta":{"author":"claude","model":"opus"},'
        '"cuts":[{"source_file":"a.mov","source_in":0,"source_out":5}]}'
    )
    out = _extract_json(raw)
    assert "cuts" in out
    assert out["meta"]["author"] == "claude"


def test_extract_json_with_braces_inside_strings():
    """Regression: balanced-brace scan must not be confused by braces that
    appear inside JSON string values (e.g. an LLM quoting code)."""
    raw = '{"cuts":[{"beat_text":"function f() { return 1; }","source_file":"a.mov","source_in":0,"source_out":2}]}'
    out = _extract_json(raw)
    assert out["cuts"][0]["beat_text"].startswith("function")


def test_extract_json_picks_object_with_cuts_when_multiple():
    """If the user pastes a config object AND the cut plan, pick the right one."""
    raw = (
        '{"some_other":{"x":1}}\n'
        'and then:\n'
        '{"cuts":[{"source_file":"a.mov","source_in":1,"source_out":3}]}'
    )
    out = _extract_json(raw)
    assert "cuts" in out


def test_resolve_basename_collision_raises():
    """Two clips with the same filename in different folders must fail
    loudly rather than silently picking one."""
    ready = {
        "/A/IMG_1694.MOV": {},
        "/B/IMG_1694.MOV": {},
    }
    with pytest.raises(ExternalPlanError) as exc:
        _resolve_source_file("IMG_1694.MOV", ready)
    assert "ambiguous" in str(exc.value).lower()


# ── _resolve_source_file ───────────────────────────────────────

def test_resolve_exact_match():
    ready = {"/abs/path/IMG_1694.MOV": {}}
    assert _resolve_source_file("/abs/path/IMG_1694.MOV", ready) == "/abs/path/IMG_1694.MOV"


def test_resolve_bare_filename():
    ready = {"/abs/path/IMG_1694.MOV": {}}
    assert _resolve_source_file("IMG_1694.MOV", ready) == "/abs/path/IMG_1694.MOV"


def test_resolve_case_insensitive():
    ready = {"/abs/path/IMG_1694.MOV": {}}
    assert _resolve_source_file("img_1694.mov", ready) == "/abs/path/IMG_1694.MOV"


def test_resolve_unknown_raises():
    ready = {"/abs/IMG_1694.MOV": {}}
    with pytest.raises(ExternalPlanError) as exc:
        _resolve_source_file("OTHER.MOV", ready)
    # Error message lists what's available so the user can correct it
    assert "IMG_1694.MOV" in str(exc.value)


# ── _snap_to_frame ────────────────────────────────────────────

def test_frame_snap_30fps():
    # 30 fps quantum = 1/30 s
    q = 1.0 / 30.0
    # 0.05s -> nearest frame is 0.0667 (2 frames) or 0.0333 (1 frame)
    snapped = _snap_to_frame(0.05)
    # Should be within half a frame of input
    assert abs(snapped - 0.05) <= q / 2 + 1e-9
    # And land exactly on a frame boundary
    assert abs(round(snapped / q) * q - snapped) < 1e-9


# ── build_plan_from_pasted_json ───────────────────────────────

def _ready_with(*paths):
    return {p: {} for p in paths}


def test_build_plan_happy_path():
    raw = """```json
    {"cuts": [
      {"beat_text": "line A", "source_file": "IMG_1694.MOV", "source_in": 10.0, "source_out": 14.5},
      {"beat_text": "line B", "source_file": "IMG_1694.MOV", "source_in": 20.0, "source_out": 23.2}
    ]}
    ```"""
    plan = build_plan_from_pasted_json(
        raw,
        bin_reference="@bin:Test",
        script="line A\nline B",
        transcripts_ready=_ready_with("/abs/IMG_1694.MOV"),
    )
    assert len(plan.cuts) == 2
    assert plan.cuts[0].take_source_file == "/abs/IMG_1694.MOV"
    assert plan.cuts[0].duration > 0
    assert plan.cuts[1].timeline_position > 0  # cumulative


def test_build_plan_bad_cut_goes_to_gaps_not_fatal():
    raw = """{"cuts": [
      {"beat_text": "good", "source_file": "IMG_1694.MOV", "source_in": 10.0, "source_out": 14.5},
      {"beat_text": "bad", "source_file": "MISSING.MOV", "source_in": 0, "source_out": 1.0}
    ]}"""
    plan = build_plan_from_pasted_json(
        raw,
        bin_reference="@bin:Test",
        script="good\nbad",
        transcripts_ready=_ready_with("/abs/IMG_1694.MOV"),
    )
    assert len(plan.cuts) == 1
    assert len(plan.gaps) == 1
    assert "MISSING.MOV" in plan.gaps[0]["reason"] or "unresolved_source" in plan.gaps[0]["reason"]


def test_build_plan_rejects_inverted_range():
    raw = '{"cuts":[{"beat_text":"x","source_file":"a.mov","source_in":10,"source_out":5}]}'
    with pytest.raises(ExternalPlanError):
        build_plan_from_pasted_json(
            raw, bin_reference="@b", script="", transcripts_ready=_ready_with("/abs/a.mov"),
        )


def test_build_plan_rejects_too_long():
    raw = '{"cuts":[{"beat_text":"x","source_file":"a.mov","source_in":0,"source_out":120}]}'
    with pytest.raises(ExternalPlanError):
        build_plan_from_pasted_json(
            raw, bin_reference="@b", script="", transcripts_ready=_ready_with("/abs/a.mov"),
        )


def test_build_plan_rejects_too_short():
    raw = '{"cuts":[{"beat_text":"x","source_file":"a.mov","source_in":0,"source_out":0.1}]}'
    with pytest.raises(ExternalPlanError):
        build_plan_from_pasted_json(
            raw, bin_reference="@b", script="", transcripts_ready=_ready_with("/abs/a.mov"),
        )


def test_build_plan_frame_aligned():
    # source_in=10.05 should snap to nearest 30fps frame
    raw = '{"cuts":[{"beat_text":"x","source_file":"a.mov","source_in":10.05,"source_out":14.3}]}'
    plan = build_plan_from_pasted_json(
        raw, bin_reference="@b", script="", transcripts_ready=_ready_with("/abs/a.mov"),
    )
    q = 1.0 / 30.0
    cut = plan.cuts[0]
    # Both endpoints sit on frame boundaries.  Stored at ms precision so the
    # tolerance is half a millisecond — that's the most rounding can hide.
    # (The plan rounds source_in/source_out to 3 decimals before storage.)
    assert abs(round(cut.source_in / q) * q - cut.source_in) < 5e-4
    assert abs(round(cut.source_out / q) * q - cut.source_out) < 5e-4
    # Sanity: the input 10.05 should not be unchanged — it should move to a frame
    assert cut.source_in != 10.05


# ── build_cutplan_prompt (Gemini-transcription workflow) ───────

def test_cutplan_prompt_forbids_word_timestamps():
    """The whole reason this prompt exists: Gemini's per-word timestamps
    collapse to identical values inside long segments, so cuts MUST be taken
    from segment-level start_seconds/end_seconds.  If this instruction ever
    disappears, the model will cut on word times and place cuts wrongly."""
    prompt = build_cutplan_prompt(script="line A", source_files=["IMG_1694.MOV"])
    low = prompt.lower()
    # Must steer to segment-level times and explicitly warn off per-word times.
    assert "start_seconds" in prompt and "end_seconds" in prompt
    assert "per-word" in low
    assert "ignore" in low  # the words[] array must be ignored


def test_cutplan_prompt_lists_exact_source_files():
    """source_file must be copied verbatim, so the valid filenames have to be
    in the prompt or the model will guess names that won't resolve."""
    prompt = build_cutplan_prompt(
        script="x", source_files=["IMG_1694.MOV", "IMG_1702.MOV"]
    )
    assert "IMG_1694.MOV" in prompt
    assert "IMG_1702.MOV" in prompt


def test_cutplan_prompt_embeds_script_but_not_transcript():
    """We embed the script and leave a placeholder for the user's pasted
    transcript — the backend never sees the Gemini transcript."""
    prompt = build_cutplan_prompt(
        script="my unique script line", source_files=["a.mov"]
    )
    assert "my unique script line" in prompt
    assert "PASTE THE TRANSCRIPT" in prompt.upper()


def test_cutplan_prompt_handles_no_script():
    """No script → fall back to 'pick the cleanest takes' framing rather than
    emitting an empty SCRIPT section that confuses the model."""
    prompt = build_cutplan_prompt(script="", source_files=["a.mov"])
    assert "no script" in prompt.lower()


def test_cutplan_prompt_emits_target_schema():
    """The output schema must match what build_plan_from_pasted_json ingests:
    cuts[] with source_file/source_in/source_out."""
    prompt = build_cutplan_prompt(script="x", source_files=["a.mov"])
    for key in ('"cuts"', "source_file", "source_in", "source_out"):
        assert key in prompt


# ── build_transcription_prompt (Gemini workflow, step 1) ───────

def test_transcription_prompt_emits_segment_schema():
    """Step 1's output must be exactly what build_cutplan_prompt (step 2)
    consumes: a segments[] array of start_seconds/end_seconds/text.  If these
    two prompts drift apart, the Gemini pipeline silently breaks at the seam."""
    prompt = build_transcription_prompt()
    for key in ('"segments"', "start_seconds", "end_seconds", '"text"'):
        assert key in prompt


def test_transcription_prompt_forbids_per_word_and_translation():
    """The two non-negotiables: segment-level times only (no per-word array,
    which collapses in Gemini), and verbatim/no-translate (the source is
    Urdu/Hindi and the cut text must match the spoken words)."""
    low = build_transcription_prompt().lower()
    assert "per-word" in low   # explicitly told NOT to emit a per-word breakdown
    assert "verbatim" in low
    assert "translate" in low  # "do NOT translate"
