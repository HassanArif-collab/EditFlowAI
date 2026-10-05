"""Tests for SRT export.

WHY: Premiere's SRT importer is strict — wrong millisecond separators or
unpadded timestamps silently misplace cues on the caption track. These
pin the exact bytes.
"""
from __future__ import annotations

from backend.services.subtitles.srt_export import cues_to_srt


def test_exact_numbering_and_timestamps():
    cues = [
        {"start": 0.0, "end": 2.5, "text": "ہاں جی"},
        {"start": 3.0, "end": 7.25, "text": "line one\nline two"},
    ]
    assert cues_to_srt(cues) == (
        "1\n00:00:00,000 --> 00:00:02,500\nہاں جی\n\n"
        "2\n00:00:03,000 --> 00:00:07,250\nline one\nline two\n\n"
    )


def test_empty_cues_skipped_and_renumbered():
    cues = [
        {"start": 0.0, "end": 1.0, "text": "  "},
        {"start": 1.0, "end": 2.0, "text": "hi"},
    ]
    out = cues_to_srt(cues)
    assert out.startswith("1\n00:00:01,000 --> 00:00:02,000\nhi")
    assert cues_to_srt([]) == ""
