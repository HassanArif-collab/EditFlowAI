"""Tests for the Scribe response parser + cost estimate.

WHY: Scribe gives the exact per-word times the word editor relies on. The parser
must keep real words, drop 'spacing', flag 'audio_event' as non-speech, assign
each word to the right segment, and never crash on a slightly-off field. The live
API is validated with a real key; this pins the mapping against the documented
shape so a schema drift is caught here, not in production.
"""
from __future__ import annotations

from backend.services.scribe_service import (
    build_segments_and_words,
    estimate_cost,
    parse_scribe_words,
    words_to_segments,
)

_RESP = {
    "language_code": "urd",
    "text": "میں ہوں جاوید۔ ہاں",
    "words": [
        {"text": "میں", "start": 0.0, "end": 0.3, "type": "word"},
        {"text": " ", "start": 0.3, "end": 0.3, "type": "spacing"},
        {"text": "ہوں", "start": 0.3, "end": 0.6, "type": "word"},
        {"text": "جاوید۔", "start": 0.6, "end": 1.0, "type": "word"},
        {"text": "laughter", "start": 1.5, "end": 1.8, "type": "audio_event"},
        {"text": "ہاں", "start": 2.5, "end": 2.8, "type": "word"},
    ],
}


def test_parse_scribe_words_keeps_words_drops_spacing_flags_events():
    words = parse_scribe_words(_RESP)
    assert [w["text"] for w in words] == ["میں", "ہوں", "جاوید۔", "[laughter]", "ہاں"]
    assert all("start" in w and "end" in w for w in words)
    # audio_event got bracketed so the editor cuts it as non-speech.
    assert words[3]["type"] == "audio_event" and words[3]["text"].startswith("[")


def test_words_to_segments_splits_on_endpunct_and_pause():
    words = parse_scribe_words(_RESP)
    segs = words_to_segments(words)
    # "…جاوید۔" ends a sentence; then a >0.6s pause isolates [laughter] and ہاں.
    assert [s["text"] for s in segs] == ["میں ہوں جاوید۔", "[laughter]", "ہاں"]


def test_build_segments_and_words_uses_exact_times_and_assigns_segments():
    segments, words = build_segments_and_words(_RESP)
    assert len(segments) == 3
    assert len(words) == 5
    assert words[0].start == 0.0 and words[0].end == 0.3   # exact, not interpolated
    assert words[0].segment_id == segments[0].id
    assert words[4].segment_id == segments[2].id           # ہاں → last segment


def test_parse_tolerates_missing_words():
    assert parse_scribe_words({}) == []
    assert parse_scribe_words({"words": "nope"}) == []


def test_estimate_cost():
    e = estimate_cost(3600)
    assert e["minutes"] == 60.0
    assert e["usd"] == 0.22
