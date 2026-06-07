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


from backend.services.review_service import _cluster_retakes  # noqa: E402


def test_cluster_records_grouped_pair():
    line = "میں نے چودہ ہزار کروڑ لگائے ایک ٹیک سٹارٹ اپ میں"
    segs = [_seg(0, line), _seg(1, line), _seg(2, "بالکل الگ جملہ یہاں")]
    pairs: list[dict] = []
    _cluster_retakes(segs, 0.72, pairs)
    hit = [p for p in pairs if p["clustered"]]
    assert any(p["a_id"] == 0 and p["b_id"] == 1 for p in hit)
    assert hit[0]["score"] is not None and hit[0]["skipped"] is None


def test_cluster_records_length_guard_skip_for_contained_fragment():
    full = "تو اب ہم اپنی income کو دس گنا کر دیتے ہیں"
    segs = [_seg(0, full), _seg(1, "income")]   # fragment fully inside the full line
    pairs: list[dict] = []
    _cluster_retakes(segs, 0.72, pairs)
    skipped = [p for p in pairs if p["skipped"] == "length_guard"]
    assert any({p["a_id"], p["b_id"]} == {0, 1} for p in skipped)


def test_cluster_pairs_default_off_is_backward_compatible():
    segs = [_seg(0, "hello world this is a line"), _seg(1, "hello world this is a line")]
    # Called the old way (no pairs arg) — must still cluster, must not raise.
    clusters = _cluster_retakes(segs, 0.72)
    assert any(len(c) == 2 for c in clusters)


from backend.services.review_service import classify  # noqa: E402


def test_classify_with_trace_emits_all_stages_and_keeps_behaviour():
    line = "میں نے چودہ ہزار کروڑ لگائے ایک ٹیک سٹارٹ اپ میں"
    segs = [_seg(0, line), _seg(1, line), _seg(2, "umm")]
    t = ReviewTrace()
    classify(segs, "", trace=t)
    names = [s["stage"] for s in t.to_dict()["stages"]]
    assert names == ["junk", "cluster", "script"]
    # behaviour identical to the no-trace path: filler cut, first retake cut, last kept
    assert segs[2].decision == "cut" and segs[2].reason == "filler"
    assert segs[0].decision == "cut" and segs[1].decision == "keep"
    cluster = next(s for s in t.to_dict()["stages"] if s["stage"] == "cluster")
    assert cluster["clusters"] and cluster["clusters"][0]["winner_id"] == 1


def test_classify_without_trace_unchanged():
    line = "میں نے چودہ ہزار کروڑ لگائے ایک ٹیک سٹارٹ اپ میں"
    segs = [_seg(0, line), _seg(1, line)]
    classify(segs, "")           # no trace kwarg — old call site
    assert segs[0].decision == "cut" and segs[1].decision == "keep"


import asyncio  # noqa: E402

from backend.routes.review import SuggestReq, _reviews, suggest  # noqa: E402


def test_suggest_route_returns_trace_when_debug(tmp_path, monkeypatch):
    # Avoid touching the real DATA_DIR on snapshot write.
    import backend.config as cfg
    monkeypatch.setattr(cfg.get_settings(), "DATA_DIR", tmp_path, raising=False)

    line = "میں نے چودہ ہزار کروڑ لگائے ایک ٹیک سٹارٹ اپ میں"
    _reviews["trace-test"] = {
        "segments": [
            Segment(id=0, start=0, end=4, text=line, tight_in=0, tight_out=4),
            Segment(id=1, start=10, end=14, text=line, tight_in=10, tight_out=14),
            Segment(id=2, start=20, end=20.2, text="umm", tight_in=20, tight_out=20.2),
        ],
        "words": [],
        "script": "",
        "source_name": "X.MOV",
    }
    try:
        resp = asyncio.run(suggest(SuggestReq(review_id="trace-test", use_llm=False, debug=True)))
    finally:
        _reviews.pop("trace-test", None)

    assert resp["trace"] is not None
    names = [s["stage"] for s in resp["trace"]["stages"]]
    assert names == ["junk", "cluster", "script", "final"]   # no llm stage when use_llm=False
    final = resp["trace"]["stages"][-1]
    by = {s["id"]: s["decided_by"] for s in final["segments"]}
    assert by[2] == "junk" and by[1] == "kept" and by[0] == "cluster"


def test_suggest_route_no_trace_when_debug_off():
    _reviews["trace-test2"] = {
        "segments": [Segment(id=0, start=0, end=2, text="a normal spoken line", tight_in=0, tight_out=2)],
        "words": [], "script": "", "source_name": "X.MOV",
    }
    try:
        resp = asyncio.run(suggest(SuggestReq(review_id="trace-test2", use_llm=False)))
    finally:
        _reviews.pop("trace-test2", None)
    assert resp["trace"] is None
