"""Tests for the Gemini transcript normalizer.

Pins the field mapping so that changes to Gemini's JSON schema don't silently
break the pipeline's ability to consume its transcripts.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.services.gemini_transcript import (
    gemini_words_to_transcript_words,
    gemini_to_transcript_result,
    load_gemini_json,
)
from backend.models.schemas import TranscriptWord, TranscriptSegment, TranscriptResult


# ── Helpers ────────────────────────────────────────────────────

_A_GEMINI_WORD = {"word": "تو", "start_seconds": 0.0, "end_seconds": 0.4, "confidence": 0.99}


def _make_gemini_json(n_words: int = 3) -> dict:
    return {
        "full_text": "تو اب کیا",
        "language": "ur",
        "segments": [
            {
                "start_seconds": 0.0,
                "end_seconds": 1.2,
                "text": "تو اب کیا",
                "words": [
                    {"word": f"w{i}", "start_seconds": float(i * 0.4), "end_seconds": float(i * 0.4 + 0.4), "confidence": 0.95 + i * 0.01}
                    for i in range(n_words)
                ],
            }
        ],
    }


# ── load_gemini_json ──────────────────────────────────────────


def test_load_gemini_json(tmp_path: Path):
    data = _make_gemini_json(2)
    fp = tmp_path / "test.json"
    fp.write_text(json.dumps(data), encoding="utf-8")
    loaded = load_gemini_json(str(fp))
    assert loaded["language"] == "ur"
    assert len(loaded["segments"]) == 1


# ── gemini_words_to_transcript_words ──────────────────────────


class TestGeminiWordsToTranscriptWords:
    def test_basic_mapping(self):
        result = gemini_words_to_transcript_words([_A_GEMINI_WORD])
        assert len(result) == 1
        tw = result[0]
        assert isinstance(tw, TranscriptWord)
        assert tw.word == "تو"
        assert tw.start == 0.0
        assert tw.end == 0.4
        assert tw.probability == 0.99

    def test_empty_list(self):
        assert gemini_words_to_transcript_words([]) == []

    def test_missing_confidence_defaults_to_1(self):
        gw = {"word": "x", "start_seconds": 1.0, "end_seconds": 2.0}
        tw = gemini_words_to_transcript_words([gw])[0]
        assert tw.probability == 1.0

    def test_none_confidence_defaults_to_1(self):
        gw = {"word": "x", "start_seconds": 1.0, "end_seconds": 2.0, "confidence": None}
        tw = gemini_words_to_transcript_words([gw])[0]
        assert tw.probability == 1.0

    def test_missing_word_defaults_to_empty(self):
        gw = {"start_seconds": 0.0, "end_seconds": 0.5, "confidence": 0.9}
        tw = gemini_words_to_transcript_words([gw])[0]
        assert tw.word == ""

    def test_output_works_with_getattr(self):
        """build_paste_prompt uses getattr(w, 'start', ...) — must work on result."""
        tw = gemini_words_to_transcript_words([_A_GEMINI_WORD])[0]
        assert getattr(tw, "start", None) == 0.0
        assert getattr(tw, "end", None) == 0.4
        assert getattr(tw, "word", None) == "تو"

    def test_rounds_to_3_decimal_places(self):
        gw = {"word": "x", "start_seconds": 0.123456, "end_seconds": 0.987654, "confidence": 0.9999}
        tw = gemini_words_to_transcript_words([gw])[0]
        assert tw.start == 0.123
        assert tw.end == 0.988
        assert tw.probability == 1.0  # rounded


# ── gemini_to_transcript_result ───────────────────────────────


class TestGeminiToTranscriptResult:
    def test_happy_path(self):
        data = _make_gemini_json(3)
        tr = gemini_to_transcript_result(data, source_path="/clips/a.mov", language="ur")
        assert isinstance(tr, TranscriptResult)
        assert tr.source_file == "/clips/a.mov"
        assert tr.language == "ur"
        assert tr.engine == "gemini_2.5_pro"
        assert tr.model == "gemini-2.5-pro"
        assert len(tr.segments) == 1
        assert len(tr.segments[0].words) == 3
        assert tr.duration == pytest.approx(1.2)

    def test_language_falls_back_to_gemini_data(self):
        data = _make_gemini_json(2)
        data["language"] = "ur"
        tr = gemini_to_transcript_result(data, source_path="/clips/a.mov")
        assert tr.language == "ur"

    def test_empty_segments(self):
        data = {"segments": []}
        tr = gemini_to_transcript_result(data, source_path="/clips/a.mov")
        assert tr.segments == []
        assert tr.duration == 0.0
        assert tr.full_text == ""

    def test_engine_and_model_are_stamped(self):
        data = _make_gemini_json(1)
        tr = gemini_to_transcript_result(data, source_path="/clips/a.mov")
        assert tr.engine == "gemini_2.5_pro"
        assert tr.model == "gemini-2.5-pro"
