"""Tests for Whisper model install detection.

WHY: the panel's Transcribe flow keys off this boolean — a false negative
pops a "download a model" demand for a model that is already on disk
(seen live: active_model stored as full repo id
"Systran/faster-whisper-large-v3" never matched the short catalog names).
"""
from __future__ import annotations

from backend.routes.whisper_admin import _normalize_model_id, is_model_installed


def test_normalize_strips_org_and_prefix():
    assert _normalize_model_id("Systran/faster-whisper-large-v3") == "large-v3"
    assert _normalize_model_id("large-v3") == "large-v3"
    assert _normalize_model_id("mobiuslabsgmbh/faster-whisper-large-v3-turbo") == "large-v3-turbo"


def test_installed_model_detected_by_full_id_and_short_name(monkeypatch):
    # Hermetic: stub the disk check, pin the catalog matching. The live
    # failure was _normalize-free comparison, not disk state.
    import backend.routes.whisper_admin as wa
    seen = []
    monkeypatch.setattr(wa, "_is_model_installed", lambda n, f: seen.append(n) or True)
    assert is_model_installed("Systran/faster-whisper-large-v3") is True
    assert is_model_installed("large-v3") is True
    assert seen == ["large-v3", "large-v3"]


def test_unknown_model_is_not_installed():
    assert is_model_installed("does-not-exist") is False
