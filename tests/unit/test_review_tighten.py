"""Tests for review 'tighten to speech' math.

WHY: the user's #1 complaint was seconds of silence and 'looking around' between
lines. tighten() must move a boundary that sits inside a pause onto the actual
speech edge — and must NEVER invert a segment or reach across a pause into a
neighbouring take. This is the pure math behind 'very tight' cuts, tested without
ffmpeg so the rule is locked regardless of the detector.
"""
from __future__ import annotations

from backend.services.review_service import Segment, tighten


def _seg(start, end):
    return Segment(id=0, start=start, end=end, text="x", tight_in=start, tight_out=end)


def test_in_snaps_to_speech_onset_out_trims_trailing_silence():
    seg = _seg(1.0, 5.0)
    # start 1.0 sits in pause 0.5–1.5 → onset 1.5; end 5.0 in pause 4.5–5.5 → offset 4.5
    tighten([seg], [(0.5, 1.5), (4.5, 5.5)], pad=0.0)
    assert seg.tight_in == 1.5
    assert seg.tight_out == 4.5


def test_boundaries_already_on_speech_are_unchanged():
    seg = _seg(2.0, 4.0)
    tighten([seg], [(0.5, 1.5), (4.5, 5.5)], pad=0.0)
    assert seg.tight_in == 2.0
    assert seg.tight_out == 4.0


def test_pad_widens_outward_without_clipping():
    seg = _seg(1.0, 5.0)
    tighten([seg], [(0.5, 1.5), (4.5, 5.5)], pad=0.1)
    # onset 1.5 - pad, offset 4.5 + pad
    assert round(seg.tight_in, 3) == 1.4
    assert round(seg.tight_out, 3) == 4.6


def test_all_silence_segment_falls_back_to_raw():
    seg = _seg(1.0, 5.0)
    # one big pause swallows the whole segment → would invert → keep raw bounds
    tighten([seg], [(0.5, 5.5)], pad=0.0)
    assert seg.tight_in == 1.0
    assert seg.tight_out == 5.0


def test_in_never_goes_negative():
    seg = _seg(0.0, 2.0)
    tighten([seg], [], pad=0.5)
    assert seg.tight_in >= 0.0
