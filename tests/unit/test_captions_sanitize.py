"""Tests for word-timestamp sanitation.

WHY: engines emit garbage times (overlaps, zeros, WhisperX 0-defaults)
and the caption track shows them verbatim. Sanitation is the only guard
before import — these pin overlap clamping, interpolation, and the
minimum-duration floor.
"""
from __future__ import annotations

import pytest

from backend.services.subtitles.word_sanitizer import MIN_DUR, sanitize_words


def test_overlap_clamped_to_next_start():
    words = [{"text": "a", "start": 0.0, "end": 0.9},
             {"text": "b", "start": 0.5, "end": 0.8}]
    out = sanitize_words(words)
    assert out[0]["end"] <= out[1]["start"] + 1e-9
    assert out[0]["end"] - out[0]["start"] >= MIN_DUR


def test_zero_duration_gets_floor():
    out = sanitize_words([{"text": "a", "start": 1.0, "end": 1.0}])
    assert out[0]["end"] - out[0]["start"] == pytest.approx(MIN_DUR)
    # start never moves — only end shifts
    assert out[0]["start"] == 1.0


def test_whisperx_zero_defaults_interpolated():
    # WHY: WhisperX stamps unalignable tokens 0/0; leaving them breaks
    # monotonicity and Premiere stacks the cues.
    words = [{"text": "hello", "start": 0.0, "end": 0.4},
             {"text": "123", "start": 0, "end": 0},
             {"text": "world", "start": 0.8, "end": 1.2}]
    out = sanitize_words(words)
    assert out[1]["start"] >= out[0]["end"] - 1e-9
    assert out[1]["end"] <= out[2]["start"] + 1e-9
    assert out[1]["end"] > out[1]["start"]


def test_idempotent():
    words = [{"text": "a", "start": 0.0, "end": 0.9},
             {"text": "b", "start": 0, "end": 0},
             {"text": "c", "start": 0.5, "end": 0.5}]
    once = sanitize_words(words)
    assert sanitize_words(once) == once
