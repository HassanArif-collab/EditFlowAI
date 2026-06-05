"""Tests for the deterministic keep/cut classifier.

WHY: this is the safety net that lets a weak local model be useful. It must cut
the junk the user explicitly hated (retakes, 'haan ji' filler, non-speech, tiny
stutters) using only LANGUAGE-AGNOSTIC signals, and it must NOT attempt
cross-lingual script matching (Urdu video vs English script) — doing so would
wrongly delete every good line. Each test encodes one of those guarantees.
"""
from __future__ import annotations

from backend.services.review_service import Segment, classify


def _seg(i, text, start=0.0, end=2.0):
    return Segment(id=i, start=start, end=end, text=text, tight_in=start, tight_out=end)


def test_bracketed_nonspeech_is_cut():
    segs = [_seg(0, "[بچے کی آواز]")]
    classify(segs)
    assert segs[0].decision == "cut" and segs[0].reason == "non_speech"


def test_whole_segment_filler_is_cut_english_and_urdu():
    segs = [_seg(0, "umm"), _seg(1, "ہاں جی"), _seg(2, "a real spoken line here")]
    classify(segs)
    assert segs[0].decision == "cut" and segs[0].reason == "filler"
    assert segs[1].decision == "cut" and segs[1].reason == "filler"
    assert segs[2].decision == "keep"


def test_word_containing_filler_token_is_not_cut():
    # 'ji' is filler only as the WHOLE segment; a real line containing it survives.
    segs = [_seg(0, "ji haan main aa raha hoon abhi")]
    classify(segs)
    # This exact text isn't a bare filler token → must be kept.
    assert segs[0].decision == "keep"


def test_too_short_stutter_is_cut():
    segs = [_seg(0, "کچھ", start=0.0, end=0.3)]  # 0.3s < 0.4s threshold
    classify(segs)
    assert segs[0].decision == "cut" and segs[0].reason == "too_short"


def test_retake_cluster_keeps_last_cuts_earlier():
    line = "میں نے چودہ ہزار کروڑ لگائے ایک ٹیک سٹارٹ اپ میں"
    segs = [
        _seg(0, line, 0, 4),               # take 1
        _seg(1, line, 10, 14),             # take 2 (retake of take 1)
        _seg(2, "بالکل الگ جملہ یہاں پر", 20, 23),  # unrelated, kept
    ]
    classify(segs)
    assert segs[0].decision == "cut" and segs[0].reason == "retake_of:#1"
    assert segs[1].decision == "keep"            # LAST clean take kept
    assert segs[2].decision == "keep"
    assert segs[0].group_id == segs[1].group_id != -1


def test_cross_lingual_script_is_not_auto_cut():
    # Urdu transcript + English script → deterministic script-match is skipped,
    # so a clean Urdu line must remain KEEP (not 'not_in_script').
    segs = [_seg(0, "میں نے ایک ٹیک سٹارٹ اپ میں سرمایہ لگایا")]
    classify(segs, script="I invested in a tech startup. Now I am a billionaire.")
    assert segs[0].decision == "keep"


def test_same_language_script_match_keeps_and_flags_off_script():
    script = "I invested fourteen crore in a tech startup. It blew up."
    segs = [
        _seg(0, "I invested fourteen crore in a tech startup"),  # in script → keep
        _seg(1, "what should I have for lunch today"),           # off script → cut
    ]
    classify(segs, script=script)
    assert segs[0].decision == "keep" and segs[0].script_line
    assert segs[1].decision == "cut" and segs[1].reason == "not_in_script"
