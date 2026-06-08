"""Unit tests for bare-filename clip_path recovery in propose_cuts and
match_script_to_transcripts tools.

These tests verify the WIRING — that bare filenames resolve to real paths
via session.context["selected_clips"], and that empty clip_paths falls back
to session.context["transcripts_ready"] — not the cut math itself.
Mirrors the transcribe_clips fix in commit 177dd6e.

See also: plan in PR glm/editing, commit 177dd6e for the original pattern.
"""
import pytest
from unittest.mock import AsyncMock
from pathlib import Path

from backend.services.agent.session import get_or_create
from backend.services.agent import tools


# Use a real file that exists on this machine so Path.is_file() passes
# in the _recover_clip_path helper and the resolution filters.
_REAL_FILE = str(Path(__file__).resolve())  # this test file itself


@pytest.mark.asyncio
async def test_propose_cuts_recovers_bare_filename(monkeypatch):
    """Regression for: LLM passes ['test_path_recovery.py'], tool must resolve
    via session.context['selected_clips']. Mirrors the transcribe_clips fix
    in commit 177dd6e. Without recovery, cut_proposer crashes with
    'ValueError: No transcripts available' — the bare filename never reaches
    a real file and propose_cuts gets an empty transcripts dict."""
    session = get_or_create("test-propose-recover")

    # Simulate what resolve_clips_in_bin would have put in session context
    session.context["selected_clips"] = [
        {"path": _REAL_FILE, "name": "test_path_recovery.py"}
    ]
    session.context["transcripts_ready"] = {
        _REAL_FILE: "fingerprint-abc"
    }

    # Capture what propose_cuts actually receives
    captured = {}

    async def fake_propose(clip_paths, **_kw):
        captured["clip_paths"] = clip_paths
        # Return a minimal plan-like object that propose_cuts_from_transcripts_tool expects
        class FakeCut:
            beat_text = "test beat"
            take_source_file = _REAL_FILE
            source_in = 0.0
            source_out = 1.0
            duration = 1.0

        class FakePlan:
            plan_id = "test-plan-id"
            cuts = [FakeCut()]
            summary = {"total_duration": 1.0, "unmatched": 0}

        return FakePlan()

    monkeypatch.setattr(
        "backend.services.agent.cut_proposer.propose_cuts", fake_propose
    )

    result = await tools.propose_cuts_from_transcripts_tool(
        args={"clip_paths": ["test_path_recovery.py"]},
        ws_emit=AsyncMock(),
        session=session,
    )

    assert result["success"] is True
    # The bare filename should have been resolved to the real path
    assert len(captured["clip_paths"]) > 0
    assert captured["clip_paths"][0] == _REAL_FILE


@pytest.mark.asyncio
async def test_propose_cuts_no_clip_paths_uses_all_transcripts(monkeypatch):
    """When clip_paths is missing/empty, the tool should fall back to all keys
    in session.context['transcripts_ready']. This lets the user say 'cut the
    video' after a successful transcribe without re-transcribing."""
    session = get_or_create("test-propose-fallback")

    session.context["selected_clips"] = [
        {"path": _REAL_FILE, "name": "test_path_recovery.py"}
    ]
    session.context["transcripts_ready"] = {
        _REAL_FILE: "fingerprint-xyz"
    }

    captured = {}

    async def fake_propose(clip_paths, **_kw):
        captured["clip_paths"] = clip_paths

        class FakeCut:
            beat_text = "test beat"
            take_source_file = _REAL_FILE
            source_in = 0.0
            source_out = 1.0
            duration = 1.0

        class FakePlan:
            plan_id = "test-plan-fallback"
            cuts = [FakeCut()]
            summary = {"total_duration": 1.0, "unmatched": 0}

        return FakePlan()

    monkeypatch.setattr(
        "backend.services.agent.cut_proposer.propose_cuts", fake_propose
    )

    # Call with empty clip_paths
    result = await tools.propose_cuts_from_transcripts_tool(
        args={"clip_paths": []},
        ws_emit=AsyncMock(),
        session=session,
    )

    assert result["success"] is True
    # Should have fallen back to transcripts_ready keys
    assert len(captured["clip_paths"]) > 0
    assert captured["clip_paths"][0] == _REAL_FILE

    # Also test with clip_paths missing entirely
    captured.clear()
    result2 = await tools.propose_cuts_from_transcripts_tool(
        args={},
        ws_emit=AsyncMock(),
        session=session,
    )

    assert result2["success"] is True
    assert len(captured["clip_paths"]) > 0


@pytest.mark.asyncio
async def test_match_script_recovers_bare_filename(monkeypatch):
    """Same recovery shape for match_script_to_transcripts — the LLM will
    eventually emit bare names here too (defensive fix, user hasn't tripped
    it yet but the defect class is identical)."""
    session = get_or_create("test-match-recover")

    session.context["selected_clips"] = [
        {"path": _REAL_FILE, "name": "test_path_recovery.py"}
    ]
    session.context["transcripts_ready"] = {
        _REAL_FILE: "fingerprint-def"
    }

    captured = {}

    async def fake_run_analyze(req):
        captured["bin_references"] = req.bin_references
        return {
            "plan_id": "test-match-plan",
            "summary": {"total_duration": 60, "beats": 1, "unmatched": 0},
            "warnings": [],
        }

    # We need to mock the import that happens inside match_script_to_transcripts_tool
    # The function does: from ...routes.edit import run_analyze, AnalyzeRequest
    import backend.routes.edit as edit_mod
    monkeypatch.setattr(edit_mod, "run_analyze", fake_run_analyze)

    result = await tools.match_script_to_transcripts_tool(
        args={
            "bin_references": ["test_path_recovery.py"],
            "script": "This is a test script content for matching.",
        },
        ws_emit=AsyncMock(),
        session=session,
    )

    assert result["success"] is True
    # The bare filename should have been resolved to the real path
    assert len(captured["bin_references"]) > 0
    assert captured["bin_references"][0] == _REAL_FILE
