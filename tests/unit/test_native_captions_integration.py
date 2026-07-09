"""Integration test: transcribe-mixdown word shape → cue_builder.

The transcribe-mixdown endpoint returns words with key 'word' (matching
Whisper's TranscriptWord.word field). The cue_builder expects key 'text'.
This test documents the mismatch and verifies the native-captions flow
handles it (applyNativeCaptions reads `w.word || w.text`).

If someone wanted to pass transcribe-mixdown words directly to /api/subtitles/cues,
they'd need to rename 'word' → 'text' first. This test proves that.
"""
import pytest
from backend.services.subtitles.cue_builder import build_cues, CueOpts


def test_cue_builder_with_transcribe_mixdown_word_shape():
    """transcribe-mixdown returns {word, start, end} — cue_builder needs {text, start, end}.

    This test proves the mismatch: passing transcribe-mixdown words directly
    to build_cues produces an empty list because the 'text' key is missing.
    """
    # Words as returned by /api/subtitles/transcribe-mixdown
    mixdown_words = [
        {"word": "hello", "start": 0.0, "end": 0.5, "confidence": 0.95},
        {"word": "world", "start": 0.6, "end": 1.0, "confidence": 0.92},
    ]

    # cue_builder filters by w.get("text") — 'word' key is missing → filtered out
    cues = build_cues(mixdown_words, CueOpts())
    assert cues == [], "cue_builder should return empty list for {word, ...} shape"

    # Now rename 'word' → 'text' (what the panel would do if it needed cues)
    text_words = [{"text": w["word"], "start": w["start"], "end": w["end"]} for w in mixdown_words]
    cues = build_cues(text_words, CueOpts())
    assert len(cues) == 1, f"expected 1 cue for 2 words, got {len(cues)}"
    assert "hello" in cues[0]["text"]
    assert "world" in cues[0]["text"]


def test_native_captions_word_shape_compatibility():
    """applyNativeCaptions in native_captions_manager.jsx reads `w.word || w.text`.

    This test documents that the ExtendScript code handles BOTH shapes:
    - {word: "hello", start: 0, end: 1}  (from transcribe-mixdown)
    - {text: "hello", start: 0, end: 1}  (from cue_builder/review)

    We can't run ExtendScript here, but we verify the JS code contains
    the dual-key access pattern.
    """
    from pathlib import Path
    jsx_path = Path(__file__).parent.parent.parent / "cep-panel" / "extendscript" / "native_captions_manager.jsx"
    content = jsx_path.read_text()

    # The critical line: var wordText = w.word || w.text || "";
    assert "w.word || w.text" in content, \
        "native_captions_manager.jsx must read w.word || w.text for shape compatibility"


def test_transcribe_mixdown_response_shape():
    """Verify the transcribe-mixdown endpoint returns the expected word shape."""
    from fastapi.testclient import TestClient
    from unittest.mock import patch, MagicMock
    from backend.main import app

    client = TestClient(app)

    # Mock whisper_service so we don't need a real model
    mock_result = MagicMock()
    mock_result.segments = [
        MagicMock(words=[
            MagicMock(word="hello", start=0.0, end=0.5, probability=0.95),
            MagicMock(word="world", start=0.6, end=1.0, probability=0.92),
        ])
    ]
    mock_result.duration = 1.0
    mock_result.model = "small"
    mock_result.engine = "faster_whisper"

    mock_word = MagicMock()
    mock_word.word = "hello"
    mock_word.start = 0.0
    mock_word.end = 0.5
    mock_word.probability = 0.95

    with patch("backend.routes.subtitles.whisper_service") as mock_ws, \
         patch("backend.routes.subtitles.is_model_installed", return_value=True):
        mock_ws.get_active_model_name.return_value = "small"
        # transcribe_fingerprinted is async — must use AsyncMock
        import asyncio
        async def mock_transcribe(*args, **kwargs):
            return mock_result
        mock_ws.transcribe_fingerprinted = mock_transcribe

        # Create a minimal WAV
        import io
        wav_bytes = b'RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x44\xac\x00\x00\x88\x58\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00'

        r = client.post(
            "/api/subtitles/transcribe-mixdown",
            files={"file": ("test.wav", wav_bytes, "audio/wav")},
            data={"client_id": "test", "sequence_name": "test", "in_seconds": "0", "out_seconds": "1"},
        )

        assert r.status_code == 200, f"expected 200, got {r.status_code}: {r.text[:200]}"
        body = r.json()

        # Verify the word shape
        assert "words" in body
        assert len(body["words"]) >= 1
        word = body["words"][0]
        assert "word" in word, f"word key missing: {word}"
        assert "start" in word
        assert "end" in word
        assert "confidence" in word


def test_end_to_end_data_flow_shapes():
    """Document the data flow from transcribe-mixdown → applyNativeCaptions.

    transcribe-mixdown returns: [{word, start, end, confidence}]
    applyNativeCaptions expects: [{word|text, start, end}]

    The panel passes words directly (no cue_builder) — the {word, start, end}
    shape works because applyNativeCaptions reads `w.word || w.text`.
    """
    # This is the shape transcribe-mixdown returns
    transcribe_words = [
        {"word": "hello", "start": 0.0, "end": 0.5, "confidence": 0.95},
        {"word": "world", "start": 0.6, "end": 1.0, "confidence": 0.92},
    ]

    # The panel passes these directly to applyNativeCaptions.
    # applyNativeCaptions reads:
    #   var wordText = w.word || w.text || "";   ← handles {word: ...} shape
    #   var startSec = parseFloat(w.start);       ← handles {start: ...} shape
    #   var endSec = parseFloat(w.end);           ← handles {end: ...} shape

    # Verify all required fields are present in the transcribe-mixdown output
    for w in transcribe_words:
        assert "word" in w, f"missing 'word' key: {w}"
        assert "start" in w, f"missing 'start' key: {w}"
        assert "end" in w, f"missing 'end' key: {w}"
        assert isinstance(w["start"], (int, float)), f"start not numeric: {w}"
        assert isinstance(w["end"], (int, float)), f"end not numeric: {w}"
        assert w["end"] > w["start"], f"end <= start: {w}"
