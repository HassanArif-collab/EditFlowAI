"""Tests for the suggest-pipeline trace (debug drawer data).

WHY: the trace is the instrument that lets us SEE which stage cut/kept each
segment instead of guessing from the final cut list. These tests pin the exact
JSON shape the frontend drawer depends on, and the truncation/provenance
heuristics that surface the real bugs (un-grouped retakes, fragment skips, a
truncated LLM reply).
"""
from __future__ import annotations

from backend.services.review_service import Segment
from backend.services.review_trace import (
    ReviewTrace,
    final_stage,
    junk_stage,
    llm_stage,
    stage_of_reason,
)


def _seg(i, text, decision="keep", reason="", group_id=-1):
    s = Segment(id=i, start=0.0, end=2.0, text=text, tight_in=0.0, tight_out=2.0)
    s.decision, s.reason, s.group_id = decision, reason, group_id
    return s


def test_accumulator_collects_stages_in_order():
    t = ReviewTrace()
    t.add({"stage": "junk", "cut": []})
    t.add({"stage": "final", "segments": []})
    assert [s["stage"] for s in t.to_dict()["stages"]] == ["junk", "final"]


def test_stage_of_reason_maps_every_decision_kind():
    assert stage_of_reason("keep", "") == "kept"
    assert stage_of_reason("cut", "filler") == "junk"
    assert stage_of_reason("cut", "too_short") == "junk"
    assert stage_of_reason("cut", "retake_of:#5") == "cluster"
    assert stage_of_reason("cut", "not_in_script") == "script"
    assert stage_of_reason("cut", "llm_off_script") == "llm"
    assert stage_of_reason("cut", "manual") == "manual"


def test_junk_stage_lists_only_cut_segments_with_reasons():
    segs = [_seg(0, "umm", "cut", "filler"), _seg(1, "a real line", "keep")]
    st = junk_stage(segs)
    assert st["stage"] == "junk"
    assert st["cut"] == [{"id": 0, "text": "umm", "reason": "filler"}]
    assert st["kept_after_junk"] == 1


def test_final_stage_tags_each_segment_with_deciding_stage():
    segs = [_seg(0, "x", "cut", "retake_of:#1", group_id=0), _seg(1, "x", "keep")]
    st = final_stage(segs)
    by = {s["id"]: s["decided_by"] for s in st["segments"]}
    assert by == {0: "cluster", 1: "kept"}


def test_llm_stage_flags_truncation_when_json_unclosed():
    st = llm_stage(
        prompt="P", raw='{"decisions": [{"id": 1, "keep": false',  # cut off
        max_tokens=1500, parsed_count=0, segment_count=80, flips=[], error=None,
    )
    assert st["truncated"] is True
    assert st["parsed_count"] == 0 and st["segment_count"] == 80


def test_llm_stage_not_truncated_when_json_closed():
    st = llm_stage(
        prompt="P", raw='{"decisions": [{"id": 1, "keep": false}]}',
        max_tokens=1500, parsed_count=1, segment_count=3,
        flips=[{"id": 1, "reason": "llm_off_script"}], error=None,
    )
    assert st["truncated"] is False
    assert st["used"] is True and st["flips"][0]["id"] == 1
