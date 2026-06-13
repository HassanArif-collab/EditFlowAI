"""Tests for the subtitle cue builder (words[] → cues[]).

WHY: every subtitle engine (caption track, built-in keyframes, MOGRT) consumes
the cues this module emits. If grouping breaks a cap, captions overflow the
frame; if the final-cut remap drifts, captions desync from the edited timeline.
These pin the grouping rules and the kept-words→output-time remap from the plan
(docs/plans/subtitles-animated-captions-plan.md §3, §5).
"""
from __future__ import annotations

from backend.services.subtitles.cue_builder import (
    CueOpts,
    build_cues,
    remap_kept_words_to_output,
)


def _w(text: str, start: float, end: float, keep: bool = True) -> dict:
    return {"text": text, "start": start, "end": end, "keep": keep}


def _sentence(words: list[str], t0: float = 0.0, dur: float = 0.4) -> list[dict]:
    """Contiguous words, dur seconds each, starting at t0."""
    out = []
    for i, txt in enumerate(words):
        s = t0 + i * dur
        out.append(_w(txt, s, s + dur))
    return out


# ── build_cues: grouping rules ─────────────────────────────────────

def test_empty_input_yields_no_cues():
    assert build_cues([], CueOpts()) == []


def test_cue_spans_words_and_carries_word_timing():
    words = _sentence(["Hello", "world"])
    cues = build_cues(words, CueOpts())
    assert len(cues) == 1
    c = cues[0]
    assert c["index"] == 0
    assert c["text"] == "Hello world"
    assert (c["start"], c["end"]) == (0.0, 0.8)
    # per-word timing survives for karaoke / word-by-word placement
    assert [w["text"] for w in c["words"]] == ["Hello", "world"]
    assert c["words"][0]["start"] == 0.0 and c["words"][1]["end"] == 0.8


def test_max_words_per_cue_splits():
    words = _sentence([f"w{i}" for i in range(10)])
    cues = build_cues(words, CueOpts(max_words_per_cue=4))
    assert [len(c["words"]) for c in cues] == [4, 4, 2]
    # no overlap, no gap at the split boundary
    assert cues[0]["end"] == cues[1]["start"]


def test_gap_splits_cue():
    words = _sentence(["before"]) + [_w("after", 5.0, 5.4)]
    cues = build_cues(words, CueOpts(max_gap=0.8))
    assert len(cues) == 2
    assert cues[0]["text"] == "before" and cues[1]["text"] == "after"


def test_sentence_end_splits_cue():
    words = [_w("Done.", 0.0, 0.4), _w("Next", 0.4, 0.8)]
    cues = build_cues(words, CueOpts(split_on_sentence_end=True))
    assert [c["text"] for c in cues] == ["Done.", "Next"]
    # Urdu full stop too (the panel's primary language)
    words_ur = [_w("ہاں۔", 0.0, 0.4), _w("جی", 0.4, 0.8)]
    assert len(build_cues(words_ur, CueOpts(split_on_sentence_end=True))) == 2


def test_max_duration_splits_cue():
    words = _sentence([f"w{i}" for i in range(8)], dur=1.0)  # 8s of words
    cues = build_cues(words, CueOpts(max_cue_duration=3.0, max_words_per_cue=99))
    assert all(c["end"] - c["start"] <= 3.0 for c in cues)


def test_line_wrap_respects_char_caps():
    words = _sentence(["supercalifragilistic", "expialidocious", "again"])
    cues = build_cues(words, CueOpts(max_chars_per_line=22, max_lines=2,
                                     max_words_per_cue=99))
    for c in cues:
        for line in c["text"].split("\n"):
            assert len(line) <= 22


def test_word_mode_emits_one_cue_per_word():
    words = _sentence(["one", "two", "three"])
    cues = build_cues(words, CueOpts(word_mode="word"))
    assert [c["text"] for c in cues] == ["one", "two", "three"]
    assert cues[1]["start"] == words[1]["start"]
    assert cues[1]["end"] == words[1]["end"]


# ── remap_kept_words_to_output: final-cut time remap ───────────────

def test_remap_shifts_kept_words_to_output_time():
    # source: [0.0–0.8 kept] [0.8–1.6 CUT] [1.6–2.4 kept]
    words = (_sentence(["a", "b"], t0=0.0)
             + [_w("x", 0.8, 1.2, keep=False), _w("y", 1.2, 1.6, keep=False)]
             + _sentence(["c", "d"], t0=1.6))
    out = remap_kept_words_to_output(words)
    assert [w["text"] for w in out] == ["a", "b", "c", "d"]
    # first kept run unchanged; second run slides left by the cut 0.8s
    assert (out[0]["start"], out[1]["end"]) == (0.0, 0.8)
    assert (out[2]["start"], out[3]["end"]) == (0.8, 1.6)


def test_remap_with_leading_cut_starts_at_zero():
    words = [_w("x", 0.0, 1.0, keep=False)] + _sentence(["a", "b"], t0=1.0)
    out = remap_kept_words_to_output(words)
    assert out[0]["start"] == 0.0
    assert out[-1]["end"] == 0.8


def test_remap_keeps_intra_run_word_spacing():
    # a 0.2s pause INSIDE one kept span must survive the remap
    words = [_w("a", 1.0, 1.4), _w("b", 1.6, 2.0)]
    out = remap_kept_words_to_output(words)
    assert out[0]["start"] == 0.0
    assert abs(out[1]["start"] - out[0]["end"] - 0.2) < 1e-6
