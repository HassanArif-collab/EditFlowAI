"""Tests for caption cue grouping.

WHY: cues are what Premiere imports — a bad split (orphaned word, cue
longer than its audio, sentences torn mid-thought) shows on screen with
no further chance to fix it. These pin the split rules that matter.
"""
from __future__ import annotations

import pytest

from backend.services.subtitles.cue_builder import (
    CueOpts,
    build_cues,
    remap_kept_words_to_output,
)


def _w(text, start, end, **kw):
    return {"text": text, "start": start, "end": end, **kw}


def test_gap_forces_split():
    # WHY: a real pause between words must end the on-screen caption —
    # otherwise text lingers over unrelated footage.
    words = [_w("hello", 0.0, 0.4), _w("world", 2.5, 2.9)]
    cues = build_cues(words, CueOpts(max_gap=0.8))
    assert len(cues) == 2
    assert cues[0]["text"] == "hello"


def test_max_words_caps_cue():
    words = [_w(f"w{i}", i * 0.3, i * 0.3 + 0.2) for i in range(10)]
    cues = build_cues(words, CueOpts(max_words_per_cue=4))
    assert len(cues) == 3
    assert all(len(c["words"]) <= 4 for c in cues)


def test_sentence_end_splits_including_urdu():
    # WHY: Urdu/Arabic punctuation must behave like Latin — half our
    # footage is Urdu and torn sentences read as mistakes.
    words = [_w("کیا", 0.0, 0.3), _w("حال", 0.3, 0.6), _w("ہے؟", 0.6, 0.9),
             _w("ٹھیک", 1.0, 1.3)]
    cues = build_cues(words, CueOpts())
    assert len(cues) == 2
    assert cues[0]["text"].endswith("ہے؟")


def test_word_mode_one_cue_per_word():
    words = [_w("a", 0.0, 0.2), _w("b", 0.2, 0.4)]
    cues = build_cues(words, CueOpts(word_mode="word"))
    assert len(cues) == 2
    assert [c["text"] for c in cues] == ["a", "b"]


def test_empty_and_blank_words_ignored():
    assert build_cues([], CueOpts()) == []
    cues = build_cues([_w("  ", 0.0, 0.2), _w("hi", 0.3, 0.5)], CueOpts())
    assert len(cues) == 1 and cues[0]["text"] == "hi"


def test_bad_opt_raises_type_error():
    with pytest.raises(TypeError):
        CueOpts(**{"no_such_opt": 1})


def test_remap_slides_second_run_left():
    # WHY: after the Review editor cuts a span, kept words must slide left
    # by exactly the removed length — wrong remap = captions drift.
    words = [_w("keep", 0.0, 0.5), _w("cut", 0.5, 1.5, keep=False),
             _w("next", 2.0, 2.5)]
    out = remap_kept_words_to_output(words, max_gap=0.35)
    assert [w["text"] for w in out] == ["keep", "next"]
    assert out[0]["start"] == 0.0
    # "next" ran 2.0→2.5 in source; the output keeps only kept spans, so it
    # lands right after "keep" (0.0→0.5).
    assert out[1]["start"] == pytest.approx(0.5)
    assert out[1]["end"] == pytest.approx(1.0)
