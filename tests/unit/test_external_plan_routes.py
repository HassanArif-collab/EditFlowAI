"""End-to-end tests for the external-plan HTTP routes (Gemini paste workflow).

These drive the *actual* FastAPI route handlers — not the service in isolation —
to prove the integration that kept breaking before:

  - /cutplan-prompt resolves bins → source filenames and builds a paste prompt
    WITHOUT requiring any cached Whisper transcript.
  - /ingest with ``bin_references`` resolves each cut's ``source_file`` to an
    absolute clip path by basename, again WITHOUT a Whisper cache (the whole
    point of the Gemini flow: those clips were transcribed in the browser).
  - A persisted plan lands on disk with the cut pointing at the resolved path.
  - One bad cut goes to gaps; an empty/unscanned bin fails loudly (HTTP 400).

The clip's ``mediaPath`` deliberately points at a file that does NOT exist on
disk — resolution must work from the scan alone, never by touching the file.
"""
from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

from backend.routes import premiere
from backend.routes.external_plan import (
    CutplanPromptRequest,
    IngestRequest,
    cutplan_prompt,
    ingest,
)
from backend.services.plan_store import plan_store

# A fake absolute path whose file does NOT exist — proves we never read it.
_FAKE_CLIP = "/fake/session/raw/IMG_1694.MOV"


def _fake_scan(*items: dict) -> dict:
    """Build a minimal projectScanner-shaped dict with one 'Test' bin."""
    return {
        "bins": [{"name": "Test", "path": "Test", "itemCount": len(items), "depth": 0}],
        "items": list(items),
    }


def _clip_item(media_path: str = _FAKE_CLIP, name: str = "IMG_1694.MOV") -> dict:
    return {
        "name": name,
        "binPath": "Test",
        "mediaPath": media_path,
        "hasAudio": True,
        "duration": 323.5,
    }


@pytest.fixture
def one_clip_project(monkeypatch):
    """Point the premiere route's project context at a one-clip scan."""
    monkeypatch.setattr(
        premiere, "_project_context", _fake_scan(_clip_item()), raising=False
    )
    return _FAKE_CLIP


@pytest.fixture
def empty_project(monkeypatch):
    monkeypatch.setattr(
        premiere, "_project_context", {"bins": [], "items": []}, raising=False
    )


def _run(coro):
    return asyncio.run(coro)


# ── /cutplan-prompt ────────────────────────────────────────────

def test_cutplan_prompt_endpoint_no_whisper(one_clip_project):
    """Builds a prompt from bins alone — no cached transcript anywhere."""
    out = _run(
        cutplan_prompt(
            CutplanPromptRequest(bin_references=["@bin:Test"], script="line A\nline B")
        )
    )
    assert out["source_files"] == ["IMG_1694.MOV"]
    assert "IMG_1694.MOV" in out["prompt"]
    assert "PASTE THE TRANSCRIPT JSON" in out["prompt"].upper()
    assert out["prompt_chars"] == len(out["prompt"])


def test_cutplan_prompt_empty_bin_raises_400(empty_project):
    with pytest.raises(HTTPException) as exc:
        _run(cutplan_prompt(CutplanPromptRequest(bin_references=["@bin:Test"], script="")))
    assert exc.value.status_code == 400


# ── /ingest (the Gemini path: bin_references, NO Whisper cache) ──

def test_ingest_resolves_basename_without_whisper(one_clip_project):
    """The crux: a pasted cut naming the clip by *basename* resolves to its
    absolute path purely from the scan, and the plan persists to disk."""
    pasted = (
        '{"cuts":[{"beat_text":"line A","source_file":"IMG_1694.MOV",'
        '"source_in":10.0,"source_out":14.5}]}'
    )
    out = _run(
        ingest(
            IngestRequest(
                pasted_text=pasted,
                bin_references=["@bin:Test"],
                script="line A",
            )
        )
    )
    assert out["cuts_count"] == 1
    assert out["gaps"] == []
    plan_id = out["plan_id"]

    try:
        saved = plan_store.load(plan_id)
        cut = saved["cuts"][0]
        # Resolved from bare "IMG_1694.MOV" → the scan's absolute mediaPath.
        assert cut["take_source_file"] == _FAKE_CLIP
        assert cut["duration"] > 0
    finally:
        plan_store.delete(plan_id)


def test_ingest_bad_cut_goes_to_gaps(one_clip_project):
    """One unresolved source_file must not poison the whole paste."""
    pasted = (
        '{"cuts":['
        '{"beat_text":"good","source_file":"IMG_1694.MOV","source_in":10.0,"source_out":14.5},'
        '{"beat_text":"bad","source_file":"MISSING.MOV","source_in":0,"source_out":1.0}'
        ']}'
    )
    out = _run(
        ingest(
            IngestRequest(
                pasted_text=pasted, bin_references=["@bin:Test"], script="good\nbad"
            )
        )
    )
    try:
        assert out["cuts_count"] == 1
        assert len(out["gaps"]) == 1
        assert "MISSING.MOV" in out["gaps"][0]["reason"]
    finally:
        plan_store.delete(out["plan_id"])


def test_ingest_empty_bin_raises_400(empty_project):
    pasted = '{"cuts":[{"source_file":"x.mov","source_in":0,"source_out":2}]}'
    with pytest.raises(HTTPException) as exc:
        _run(ingest(IngestRequest(pasted_text=pasted, bin_references=["@bin:Test"])))
    assert exc.value.status_code == 400


def test_ingest_requires_bin_or_transcripts(monkeypatch):
    """Neither bin_references nor transcripts_ready → 400, not a 500 crash."""
    pasted = '{"cuts":[{"source_file":"x.mov","source_in":0,"source_out":2}]}'
    with pytest.raises(HTTPException) as exc:
        _run(ingest(IngestRequest(pasted_text=pasted)))
    assert exc.value.status_code == 400


def test_ingest_with_transcripts_ready_bypasses_bins(monkeypatch):
    """The agent path: caller already resolved paths, no bin scan needed."""
    monkeypatch.setattr(premiere, "_project_context", {}, raising=False)
    pasted = (
        '{"cuts":[{"beat_text":"a","source_file":"IMG_1694.MOV",'
        '"source_in":2.0,"source_out":5.0}]}'
    )
    out = _run(
        ingest(
            IngestRequest(
                pasted_text=pasted,
                transcripts_ready={_FAKE_CLIP: "ready"},
                script="a",
            )
        )
    )
    try:
        assert out["cuts_count"] == 1
        saved = plan_store.load(out["plan_id"])
        assert saved["cuts"][0]["take_source_file"] == _FAKE_CLIP
    finally:
        plan_store.delete(out["plan_id"])
