"""Tests for the word-level model (approximate times + word→cut merging).

WHY: the word editor lets the user keep PART of a sentence. These pin (1) that a
segment is split into proportionally-timed words and (2) that kept words merge
into the minimal set of contiguous cuts — dropping cut words and dead air — which
is exactly what makes the partial-sentence edit land correctly on the timeline.
"""
from __future__ import annotations

from backend.services.review_service import (
    Segment,
    Word,
    words_from_segments,
    words_to_cuts,
)


def _seg(i, text, start, end):
    return Segment(id=i, start=start, end=end, text=text, tight_in=start, tight_out=end)


def test_words_from_segments_splits_and_times():
    # "a bb ccc" = 1+2+3 = 6 chars over [0,6]s → boundaries at 1,3,6s.
    segs = [_seg(0, "a bb ccc", 0.0, 6.0)]
    words = words_from_segments(segs)
    assert [w.text for w in words] == ["a", "bb", "ccc"]
    assert [w.id for w in words] == [0, 1, 2]
    assert all(w.segment_id == 0 for w in words)
    assert words[0].start == 0.0
    assert abs(words[0].end - 1.0) < 0.01
    assert abs(words[1].end - 3.0) < 0.01
    assert abs(words[2].end - 6.0) < 0.01


def test_words_ids_are_global_across_segments():
    segs = [_seg(0, "one two", 0.0, 2.0), _seg(1, "three four", 3.0, 5.0)]
    words = words_from_segments(segs)
    assert [w.id for w in words] == [0, 1, 2, 3]
    assert words[2].segment_id == 1


def test_words_to_cuts_merges_contiguous_and_splits_on_gap():
    # words 0-2 contiguous (one cut); word 3 after a big gap (second cut).
    words = [
        Word(0, "keep", 1.0, 1.5, 0),
        Word(1, "this", 1.5, 2.0, 0),
        Word(2, "part", 2.0, 2.6, 0),
        Word(3, "later", 9.0, 9.6, 0),  # >0.35s gap → new cut
    ]
    by_id = {w.id: w for w in words}
    cuts = words_to_cuts(by_id, [0, 1, 2, 3], "C.MOV")
    assert len(cuts) == 2
    assert cuts[0]["source_in"] == 1.0 and cuts[0]["source_out"] == 2.6
    assert cuts[0]["beat_text"] == "keep this part"
    assert cuts[1]["source_in"] == 9.0 and cuts[1]["source_out"] == 9.6


def test_words_to_cuts_drops_unkept_words_in_middle():
    # Keeping 0,1 then 3 (skipping 2) → the dropped word 2 splits the span.
    words = [
        Word(0, "alpha", 1.0, 1.4, 0),
        Word(1, "beta", 1.4, 1.8, 0),
        Word(2, "JUNK", 1.8, 2.2, 0),
        Word(3, "gamma", 2.2, 2.6, 0),
    ]
    by_id = {w.id: w for w in words}
    cuts = words_to_cuts(by_id, [0, 1, 3], "C.MOV")  # word 2 omitted
    # 1.8 (end of beta) → 2.2 (start of gamma) gap is 0.4 > 0.35 → split.
    assert len(cuts) == 2
    assert cuts[0]["source_out"] == 1.8
    assert cuts[1]["source_in"] == 2.2
