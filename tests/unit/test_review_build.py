"""Tests for turning kept segments into a buildable plan.

WHY: Build is where the review's decisions become a real Premiere cut. It must
(1) emit only KEPT segments, (2) cut on the TIGHTENED boundaries (no dead air),
(3) honour the panel's explicit ordered selection, and (4) feed cleanly into the
existing, already-tested external-plan ingest (frame-snap + duration bounds) so
the apply path is reused, not reinvented.
"""
from __future__ import annotations

import json

from backend.services.external_plan import build_plan_from_pasted_json
from backend.services.review_service import Segment, classify, kept_cuts


def _seg(i, text, tin, tout, decision="keep", script_line=""):
    s = Segment(id=i, start=tin, end=tout, text=text, tight_in=tin, tight_out=tout)
    s.decision = decision
    s.script_line = script_line
    return s


def test_kept_cuts_uses_tight_bounds_and_skips_cut_segments():
    segs = [
        _seg(0, "keep me", 1.0, 3.0, decision="keep"),
        _seg(1, "drop me", 4.0, 5.0, decision="cut"),
        _seg(2, "keep me too", 6.0, 9.0, decision="keep"),
    ]
    cuts = kept_cuts(segs, "IMG_1694.MOV")
    assert len(cuts) == 2
    assert cuts[0]["source_in"] == 1.0 and cuts[0]["source_out"] == 3.0
    assert all(c["source_file"] == "IMG_1694.MOV" for c in cuts)


def test_kept_cuts_explicit_order_wins():
    segs = [
        _seg(0, "first", 1.0, 2.0),
        _seg(1, "second", 3.0, 4.0),
    ]
    cuts = kept_cuts(segs, "C.MOV", kept_ids=[1, 0])
    assert [c["beat_text"] for c in cuts] == ["second", "first"]


def test_kept_cuts_prefers_script_line_for_beat_text():
    segs = [_seg(0, "raw urdu text", 1.0, 2.0, script_line="I invested 14 crore")]
    cuts = kept_cuts(segs, "C.MOV")
    assert cuts[0]["beat_text"] == "I invested 14 crore"


def test_build_pipeline_end_to_end():
    """kept_cuts → external-plan ingest produces a real, frame-snapped Plan."""
    abs_path = "G:/footage/IMG_1694.MOV"
    segs = [
        _seg(0, "line one", 20.49, 29.78),
        _seg(1, "filler", 30.0, 30.2, decision="cut"),
        _seg(2, "line two", 173.2, 179.4),
    ]
    cuts = kept_cuts(segs, "IMG_1694.MOV")
    raw = json.dumps({"version": 1, "cuts": cuts}, ensure_ascii=False)

    plan = build_plan_from_pasted_json(
        raw,
        bin_reference="@review",
        script="",
        transcripts_ready={abs_path: "ready"},  # basename resolves to abs path
        user_hint="review_editor",
    )
    assert len(plan.cuts) == 2  # only the two kept lines
    # source_file resolved to the absolute path; bounds frame-snapped to 30 fps.
    assert plan.cuts[0].take_source_file == abs_path
    for c in plan.cuts:
        assert c.source_out > c.source_in
        assert 0.3 <= c.duration <= 60.0


def test_classify_then_kept_cuts_roundtrip():
    """A realistic pass: junk gets cut, survivors become the cut list."""
    segs = [
        Segment(0, 0.0, 2.0, "ہاں جی", 0.0, 2.0),                 # filler → cut
        Segment(1, 3.0, 7.0, "میں نے کام شروع کیا", 3.2, 6.8),     # keep
        Segment(2, 8.0, 8.2, "[گلا صاف]", 8.0, 8.2),              # non-speech → cut
    ]
    classify(segs)
    cuts = kept_cuts(segs, "C.MOV")
    assert len(cuts) == 1
    assert cuts[0]["source_in"] == 3.2 and cuts[0]["source_out"] == 6.8
