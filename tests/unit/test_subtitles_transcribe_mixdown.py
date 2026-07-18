"""Unit tests for the /api/subtitles/transcribe-mixdown endpoint (DRAFT).

This is a DRAFT test file. The parent agent should:
  1. Apply the endpoint code to backend/routes/subtitles.py
  2. Apply the is_model_installed helper to backend/routes/whisper_admin.py
  3. Move this file into the repo's test directory (e.g. backend/tests/)
  4. Run:  pytest draft_test_transcribe_mixdown.py -v

The file is self-contained: it adds the repo root to sys.path and injects
the is_model_installed helper into whisper_admin at import time as a safety
net (no-op once EDIT 1 lands). Tests never load real Whisper — every
whisper_service method is mocked via unittest.mock.patch.
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

# ── Locate the repo ────────────────────────────────────────────────────
# This draft file lives in /home/z/my-project/scripts/. The EditFlowAI
# repo is one directory up + research/editflowai/. Resolve robustly so
# the file still works after the parent agent moves it into the repo.
_REPO_ROOT = Path(__file__).resolve().parent
while _REPO_ROOT.name and not (_REPO_ROOT / "backend" / "routes").is_dir():
    if _REPO_ROOT.parent == _REPO_ROOT:
        break
    _REPO_ROOT = _REPO_ROOT.parent
# Fallback to the known absolute path if the walk didn't find it.
if not (_REPO_ROOT / "backend" / "routes").is_dir():
    _REPO_ROOT = Path("/home/z/my-project/research/editflowai")
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

# ── Safety-net: ensure whisper_admin.is_model_installed exists ─────────
# If the parent agent hasn't applied EDIT 1 yet, inject the helper so the
# `from .whisper_admin import is_model_installed` line in subtitles.py
# doesn't ImportError. Once EDIT 1 lands, this block is a no-op.
import backend.routes.whisper_admin as _wa  # noqa: E402

if not hasattr(_wa, "is_model_installed"):
    def _is_model_installed_public(model_name: str) -> bool:
        for m in _wa._MODEL_CATALOG:
            if m["name"] == model_name:
                return _wa._is_model_installed(m["name"], m["hf_repo_fragments"])
        return False
    _wa.is_model_installed = _is_model_installed_public

# ── Now we can import the router ───────────────────────────────────────
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.models.schemas import (  # noqa: E402
    TranscriptResult,
    TranscriptSegment,
    TranscriptWord,
)
from backend.routes import subtitles as _subtitles  # noqa: E402

# ── Test app: just the subtitles router under /api ────────────────────
# We don't import backend.main to avoid pulling in every router / DB /
# provider init. The endpoint under test only depends on the subtitles
# router + the lazy imports it does at call time.
app = FastAPI()
app.include_router(_subtitles.router, prefix="/api")
client = TestClient(app)


def _fake_transcript_result(words: list[tuple[str, float, float, float]]) -> TranscriptResult:
    """Build a TranscriptResult with one segment containing the given words.

    Each tuple is (word, start, end, probability). The endpoint flattens
    segment.words into the response, so one segment is enough.
    """
    seg_words = [
        TranscriptWord(word=w, start=s, end=e, probability=p)
        for (w, s, e, p) in words
    ]
    seg = TranscriptSegment(
        start=words[0][1] if words else 0.0,
        end=words[-1][2] if words else 0.0,
        text=" ".join(w[0] for w in words),
        words=seg_words,
    )
    return TranscriptResult(
        source_file="/tmp/fake.wav",
        language="en",
        duration=words[-1][2] if words else 0.0,
        segments=[seg],
        full_text=" ".join(w[0] for w in words),
        content_hash="fakehash",
        engine="faster_whisper",
        model="small",
    )


# ── Tests ──────────────────────────────────────────────────────────────


def test_transcribe_mixdown_409_when_no_model_installed():
    """If is_model_installed() returns False, the endpoint must 409 with
    the {error: "no_model", ...} body the frontend uses to pop the
    Whisper download UI — NOT 500, NOT 422."""
    with patch.object(_subtitles, "is_model_installed", return_value=False), \
         patch.object(_subtitles.whisper_service, "get_active_model_name", return_value="small"):
        resp = client.post(
            "/api/subtitles/transcribe-mixdown",
            files={"file": ("mix.wav", b"fake-audio-bytes", "audio/wav")},
            data={
                "client_id": "test-client",
                "sequence_name": "Main Seq",
                "in_seconds": "0.0",
                "out_seconds": "10.0",
            },
        )
    assert resp.status_code == 409, resp.text
    body = resp.json()
    # FastAPI stores HTTPException.detail under "detail" in the JSON body.
    detail = body.get("detail", body)
    assert detail["error"] == "no_model"
    assert detail["download_hint"] == "open_settings_whisper"
    assert detail["available"] == []


def test_transcribe_mixdown_200_returns_word_list():
    """Happy path: model installed, transcribe_fingerprinted returns a
    fake TranscriptResult. Response must contain the word list, the
    range-based fingerprint, duration, model, engine — exactly the
    shape the Native Animated Captions panel parses."""
    fake = _fake_transcript_result([
        ("hello", 0.0, 0.5, 0.95),
        ("world", 0.5, 1.0, 0.93),
    ])
    with patch.object(_subtitles, "is_model_installed", return_value=True), \
         patch.object(_subtitles.whisper_service, "get_active_model_name", return_value="small"), \
         patch.object(
             _subtitles.whisper_service,
             "transcribe_fingerprinted",
             new=AsyncMock(return_value=fake),
         ):
        resp = client.post(
            "/api/subtitles/transcribe-mixdown",
            files={"file": ("mix.wav", b"fake-audio-bytes", "audio/wav")},
            data={
                "client_id": "test-client",
                "sequence_name": "Main Seq",
                "in_seconds": "0.0",
                "out_seconds": "1.0",
            },
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    # Word list: fields word/start/end/confidence (NOT probability).
    assert len(body["words"]) == 2
    w0 = body["words"][0]
    assert set(w0.keys()) == {"word", "start", "end", "confidence"}
    assert w0["word"] == "hello"
    assert w0["start"] == 0.0
    assert w0["end"] == 0.5
    assert w0["confidence"] == 0.95

    # Top-level fields. Fingerprint is the range-based sha256[:16], not
    # the file content hash — verifies the hash uses sequence_name +
    # in/out + active_model + language + engine + vocab (NOT file bytes).
    import hashlib
    expected_fp = hashlib.sha256(
        "Main Seq|0.0|1.0|small|auto|auto|".encode("utf-8")
    ).hexdigest()[:16]
    assert body["fingerprint"] == expected_fp
    assert body["duration"] == 1.0
    assert body["model"] == "small"
    assert body["engine"] == "faster_whisper"


def test_transcribe_mixdown_passes_vocab_through_and_keys_cache_on_it():
    """The custom-vocabulary box only works if the route hands vocab to
    the whisper service (initial_prompt/hotwords) — and different vocab
    must produce a different fingerprint or stale cached transcripts
    would shadow the new spelling."""
    fake = _fake_transcript_result([("Alhamdulillah", 0.0, 0.8, 0.9)])
    mock_tf = AsyncMock(return_value=fake)
    with patch.object(_subtitles, "is_model_installed", return_value=True), \
         patch.object(_subtitles.whisper_service, "get_active_model_name", return_value="small"), \
         patch.object(_subtitles.whisper_service, "transcribe_fingerprinted", new=mock_tf):
        resp = client.post(
            "/api/subtitles/transcribe-mixdown",
            files={"file": ("mix.wav", b"fake-audio-bytes", "audio/wav")},
            data={
                "sequence_name": "Main Seq",
                "in_seconds": "0.0",
                "out_seconds": "1.0",
                "engine": "whisper",   # forces the plain-whisper path
                "vocab": "Alhamdulillah, EditFlow",
            },
        )
    assert resp.status_code == 200, resp.text
    assert mock_tf.await_args.kwargs["vocab"] == "Alhamdulillah, EditFlow"

    import hashlib
    expected_fp = hashlib.sha256(
        "Main Seq|0.0|1.0|small|auto|whisper|Alhamdulillah, EditFlow".encode("utf-8")
    ).hexdigest()[:16]
    assert resp.json()["fingerprint"] == expected_fp


def test_transcribe_mixdown_sanitizes_word_overlaps():
    """Engines emit overlapping word times; the route must clamp them
    (word-by-word caption animation turns every overlap into a visible
    double-flash). Proves sanitize_words is actually wired in."""
    fake = _fake_transcript_result([
        ("first", 0.0, 0.9, 0.9),    # overlaps into the next word
        ("second", 0.5, 1.0, 0.9),
    ])
    with patch.object(_subtitles, "is_model_installed", return_value=True), \
         patch.object(_subtitles.whisper_service, "get_active_model_name", return_value="small"), \
         patch.object(_subtitles.whisper_service, "transcribe_fingerprinted",
                      new=AsyncMock(return_value=fake)):
        resp = client.post(
            "/api/subtitles/transcribe-mixdown",
            files={"file": ("mix.wav", b"fake-audio-bytes", "audio/wav")},
            data={"sequence_name": "S", "in_seconds": "0", "out_seconds": "1",
                  "engine": "whisper"},
        )
    assert resp.status_code == 200, resp.text
    words = resp.json()["words"]
    assert words[0]["end"] == 0.5      # clamped to next start
    assert words[1]["start"] == 0.5


def test_transcribe_mixdown_500_when_transcribe_raises():
    """If transcribe_fingerprinted raises, the endpoint must catch it,
    log via logger.exception, and return 500 with str(exc) as detail —
    NOT propagate the raw exception to the ASGI error handler."""
    with patch.object(_subtitles, "is_model_installed", return_value=True), \
         patch.object(_subtitles.whisper_service, "get_active_model_name", return_value="small"), \
         patch.object(
             _subtitles.whisper_service,
             "transcribe_fingerprinted",
             new=AsyncMock(side_effect=RuntimeError("whisper blew up")),
         ):
        resp = client.post(
            "/api/subtitles/transcribe-mixdown",
            files={"file": ("mix.wav", b"fake-audio-bytes", "audio/wav")},
            data={
                "client_id": "test-client",
                "sequence_name": "Main Seq",
                "in_seconds": "0.0",
                "out_seconds": "1.0",
            },
        )
    assert resp.status_code == 500, resp.text
    body = resp.json()
    detail = body.get("detail", body)
    assert "whisper blew up" in str(detail)


def test_transcribe_mixdown_500_when_upload_save_fails():
    """Error-handling path #2: if the WAV save itself fails (e.g. disk
    full / permission denied), the endpoint must still return a clean
    500 rather than a stack trace. We force this by patching
    Path.write_bytes to raise."""
    with patch.object(_subtitles, "is_model_installed", return_value=True), \
         patch.object(_subtitles.whisper_service, "get_active_model_name", return_value="small"), \
         patch.object(
             Path,
             "write_bytes",
             side_effect=OSError("disk full"),
         ):
        resp = client.post(
            "/api/subtitles/transcribe-mixdown",
            files={"file": ("mix.wav", b"fake-audio-bytes", "audio/wav")},
            data={
                "client_id": "test-client",
                "sequence_name": "Main Seq",
                "in_seconds": "0.0",
                "out_seconds": "1.0",
            },
        )
    assert resp.status_code == 500, resp.text
    body = resp.json()
    detail = body.get("detail", body)
    assert "disk full" in str(detail)


if __name__ == "__main__":
    # Manual run: `python draft_test_transcribe_mixdown.py`
    # Lets the parent agent sanity-check without installing pytest.
    test_transcribe_mixdown_409_when_no_model_installed()
    print("OK: 409 when no model installed")
    test_transcribe_mixdown_200_returns_word_list()
    print("OK: 200 with word list")
    test_transcribe_mixdown_500_when_transcribe_raises()
    print("OK: 500 when transcribe raises")
    test_transcribe_mixdown_500_when_upload_save_fails()
    print("OK: 500 when upload save fails")
    print("\nAll tests passed.")
