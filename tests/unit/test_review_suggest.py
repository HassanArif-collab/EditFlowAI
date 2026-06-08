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


def test_containment_groups_rephrased_retake_and_keeps_clean_take():
    # WHY: the user's real footage repeats a line three ways with different lead-ins;
    # the whole-string char ratio misses it, so the same sentence survived twice.
    # Token containment must group them, and keep-last-CLEAN must keep the clean
    # earlier take over a later one that opens with a false start ('--').
    clean = "تو اب ہم اپنی income کو دس گنا کر دیتے ہیں"
    messy_later = "income کو-- اب ہم ہزار کروڑ کی income کو دس گنا کر دیتے ہیں"
    segs = [_seg(0, clean, 0, 4), _seg(1, messy_later, 8, 12)]
    classify(segs)
    assert segs[0].group_id == segs[1].group_id != -1   # grouped despite char-ratio miss
    assert segs[0].decision == "keep"                   # clean take kept
    assert segs[1].decision == "cut"                    # later false-start take cut


def test_lone_short_word_is_cut_as_fragment():
    # WHY: Scribe splits trailing words ('مجھے۔', 'گے۔') into their own cue; a lone
    # short word is a split-off grammatical tail, not a real line — it must be cut.
    segs = [
        _seg(0, "یعنی اپنی total income پہ میں دو فیصد ٹیکس دوں گا", 0, 3),
        _seg(1, "مجھے", 3, 4),
    ]
    classify(segs)
    assert segs[0].decision == "keep"
    assert segs[1].decision == "cut" and segs[1].reason == "fragment"


def test_real_short_distinct_line_is_not_cut_as_fragment():
    # WHY: the fragment rule must not eat genuinely short, distinct lines. A short
    # line that is NOT a subset of a neighbour and not a lone tiny word survives.
    segs = [
        _seg(0, "میں نے بہت محنت کی اس کام کے لیے", 0, 3),
        _seg(1, "دو فیصد loan", 3, 5),     # 3 tokens, not a subset of neighbour
    ]
    classify(segs)
    assert segs[1].decision == "keep"


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
