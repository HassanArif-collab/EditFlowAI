"""Tests for cues[] → SRT export.

WHY: the SRT file is both a user deliverable and the caption-track engine's
input to Premiere. A malformed timestamp (dot instead of comma, missing
zero-pad) makes PPro silently misplace or reject cues — pin the exact format.
"""
from __future__ import annotations

from backend.services.subtitles.srt_export import cues_to_srt


def test_srt_format_exact():
    cues = [
        {"index": 0, "start": 0.0, "end": 2.5, "text": "Hello world"},
        {"index": 1, "start": 61.25, "end": 3661.04, "text": "Two\nlines"},
    ]
    srt = cues_to_srt(cues)
    assert srt == (
        "1\n00:00:00,000 --> 00:00:02,500\nHello world\n\n"
        "2\n00:01:01,250 --> 01:01:01,040\nTwo\nlines\n\n"
    )


def test_srt_empty_and_blank_cues_skipped():
    assert cues_to_srt([]) == ""
    srt = cues_to_srt([{"index": 0, "start": 0, "end": 1, "text": "  "},
                       {"index": 1, "start": 1, "end": 2, "text": "ok"}])
    assert srt.startswith("1\n00:00:01,000")  # blank cue dropped, renumbered
