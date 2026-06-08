"""Tests for review transcript parsing.

WHY: the Review editor's whole premise is that the pasted transcript is shown
verbatim and its times are trusted to cut. If parsing drops a cue, mangles RTL
Urdu, or mis-reads a timestamp, every downstream cut is wrong. These pin the
real-world quirks of an ElevenLabs Scribe SRT (Urdu, multi-line, comma/dot ms,
optional index lines) and the JSON fallbacks.
"""
from __future__ import annotations

import json

import pytest

from backend.services.review_service import ReviewError, parse_srt, parse_transcript


def test_srt_basic_times_and_ids():
    srt = (
        "1\n00:00:00,000 --> 00:00:02,500\nہاں جی\n\n"
        "2\n00:00:03,000 --> 00:00:07,250\nمیں نے چودہ ہزار کروڑ لگائے\nایک ٹیک سٹارٹ اپ میں\n"
    )
    segs = parse_srt(srt)
    assert [s.id for s in segs] == [0, 1]
    assert (segs[0].start, segs[0].end) == (0.0, 2.5)
    assert (segs[1].start, segs[1].end) == (3.0, 7.25)
    # tight defaults equal raw until tighten() runs
    assert segs[0].tight_in == 0.0 and segs[0].tight_out == 2.5


def test_srt_preserves_urdu_and_joins_multiline():
    srt = "1\n00:00:03,000 --> 00:00:07,250\nمیں نے چودہ ہزار کروڑ لگائے\nایک ٹیک سٹارٹ اپ میں\n"
    segs = parse_srt(srt)
    # Multi-line cue text is joined with a single space; Urdu kept verbatim.
    assert segs[0].text == "میں نے چودہ ہزار کروڑ لگائے ایک ٹیک سٹارٹ اپ میں"


def test_srt_accepts_dot_ms_and_missing_index():
    # No numeric index lines; '.' millisecond separator.
    srt = "00:00:01.000 --> 00:00:02.000\nhello\n\n00:00:02.000 --> 00:00:03.250\nworld"
    segs = parse_srt(srt)
    assert [s.text for s in segs] == ["hello", "world"]
    assert segs[1].end == 3.25


def test_srt_sorts_by_start_time():
    srt = (
        "1\n00:00:05,000 --> 00:00:06,000\nsecond\n\n"
        "2\n00:00:01,000 --> 00:00:02,000\nfirst\n"
    )
    segs = parse_srt(srt)
    assert [s.text for s in segs] == ["first", "second"]
    assert [s.id for s in segs] == [0, 1]  # ids assigned AFTER sort


def test_srt_zero_duration_cue_is_kept_positive():
    srt = "1\n00:00:04,000 --> 00:00:04,000\noops\n"
    segs = parse_srt(srt)
    assert segs[0].end > segs[0].start  # guarded to a tiny positive span


def test_srt_no_cues_raises():
    with pytest.raises(ReviewError):
        parse_srt("this is not an srt at all")


def test_parse_transcript_autodetects_srt():
    srt = "1\n00:00:00,000 --> 00:00:01,000\nhi\n"
    segs = parse_transcript(srt, fmt="auto")
    assert segs[0].text == "hi"


def test_parse_transcript_gemini_json_segments():
    data = {"segments": [
        {"start_seconds": 1.0, "end_seconds": 2.0, "text": "a"},
        {"start_seconds": 2.0, "end_seconds": 3.0, "text": "b"},
    ]}
    segs = parse_transcript(json.dumps(data))
    assert [s.text for s in segs] == ["a", "b"]
    assert segs[0].start == 1.0


def test_parse_transcript_generic_segments_and_array():
    segs = parse_transcript('[{"start":1,"end":2,"text":"x"}]')
    assert segs[0].text == "x" and segs[0].end == 2.0


def test_parse_transcript_words_split_on_gap():
    data = {"words": [
        {"start": 0.0, "end": 0.4, "word": "alpha"},
        {"start": 0.5, "end": 0.9, "word": "beta"},
        {"start": 3.0, "end": 3.4, "word": "gamma"},  # >0.6s gap → new segment
    ]}
    segs = parse_transcript(json.dumps(data))
    assert [s.text for s in segs] == ["alpha beta", "gamma"]


def test_parse_transcript_empty_raises():
    with pytest.raises(ReviewError):
        parse_transcript("   ")
