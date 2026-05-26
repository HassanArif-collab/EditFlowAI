"""Regression tests for script_matcher.parse_beats — Urdu / Hindi scripts.

Bug history: the _BEAT_SPLIT regex only split on
  (?<=[.!?])\\s+(?=[A-Z]) | \\n{2,}
which means a script with one beat per single-newline-separated line and
no English capital letters (e.g., Urdu) collapsed into ONE giant beat.
That surfaced as the "1 cut from a 17-line script" symptom in the
script-matcher flow. Fix splits on any newline + Urdu/Hindi sentence
punctuation, in addition to the original English rule.
"""
from backend.services.script_matcher import parse_beats


URDU_17_LINE_SCRIPT = """تو اب کیا کرتے ہیں کہ اب ہم اپنی انکم کو دس گنا کر دیتے ہیں
تو میرا نام ہے جاوید میں نے چودہ کروڑ انویسٹ کی ایک ٹیک سٹارٹ اپ میں
اور جو چلا اور اسے بیشنے کے بعد مجھے ملے چودہ ہزار کروڑ
اور اب میری نیٹ انکم ہے دس ہزار کروڑ
اب ان دس ہزار کروڑ میں میں وہی سیم ٹرک کھیلوں گا
لون لینے والی تاکہ کم سے کم ٹیکس دینا پڑے مجھے
یعنی اپنی ٹوٹل انکم پر میں 2% ٹیکس لوں گا جو کہ بنے گا 200 کروڑ روپے
اور میرے دس ہزار کروڑ دس پرسنٹ کی گروتھ سے بڑھتے جا رہے ہیں
چلیے اب میرا گھر دیکھتے ہیں
میں ایف سکس اسلام آباد میں رہتا ہوں
میرا بنگلہ چار کنال کے رقبے پر پھیلا ہوا ہے
اس کے اندر چھے بیڈروم ہیں ٹوٹلی بائیس کمرے ہیں
اور اس کی ٹوٹل کیمت ٹھائی سو کروڑ روپے ہے
اس میں ایک بڑا سارا پول ہے ایک پرائیویٹ کارڈن ہے
ایک بیسمنٹ انٹرٹینمنٹ کمپلیکس ہے
یہ میرے سات گھروں میں سے ایک ہے
میرے پاس ایک دبائی کے اندر ہے ایک مرینہ کے اندر ہے"""


def test_urdu_single_newline_split_into_17_beats():
    """The pre-fix regex returned 1 beat for this exact input — the bug."""
    beats = parse_beats(URDU_17_LINE_SCRIPT)
    assert len(beats) == 17, (
        f"Expected 17 beats from 17-line Urdu script, got {len(beats)}. "
        "If 1, the _BEAT_SPLIT regex regressed to English-only splitting."
    )
    # Each beat should be non-empty and contain Urdu characters.
    for i, b in enumerate(beats):
        assert b.strip(), f"Beat {i} is empty"
        # Urdu/Arabic chars live in U+0600..U+06FF
        has_urdu = any(0x0600 <= ord(c) <= 0x06FF for c in b)
        assert has_urdu, f"Beat {i} has no Urdu characters: {b!r}"


def test_english_capitals_still_split():
    """The original English rule must keep working."""
    script = "Hello there. World is round. Goodbye."
    beats = parse_beats(script)
    assert len(beats) == 3


def test_blank_line_separator_still_works():
    """Scripts using a blank line between beats keep working."""
    script = "first beat\n\nsecond beat\n\nthird beat"
    beats = parse_beats(script)
    assert len(beats) == 3


def test_single_newline_now_splits():
    """Scripts using ONE newline between beats (common Urdu/Hindi format)
    now split correctly — used to be lumped into one beat."""
    script = "first beat\nsecond beat\nthird beat"
    beats = parse_beats(script)
    assert len(beats) == 3


def test_hindi_danda_splits():
    """Hindi scripts using the danda (।) end-of-sentence mark split."""
    script = "मेरा नाम जावेद है। मैंने एक स्टार्टअप में निवेश किया।"
    beats = parse_beats(script)
    assert len(beats) == 2


def test_urdu_full_stop_splits():
    """Urdu scripts using the Arabic full stop (۔) end-of-sentence mark split."""
    script = "میرا نام جاوید ہے۔ میں نے ایک سٹارٹ اپ میں سرمایہ کاری کی۔"
    beats = parse_beats(script)
    assert len(beats) == 2


def test_empty_script_returns_empty_list():
    assert parse_beats("") == []
    assert parse_beats("\n\n\n") == []


def test_very_short_lines_dropped():
    """Beats shorter than 3 chars are dropped (existing behavior)."""
    script = "a\nb\nfirst real beat\nc\nsecond real beat"
    beats = parse_beats(script)
    # 'a', 'b', 'c' are all <= 2 chars and should be filtered
    assert all(len(b) > 2 for b in beats)
    assert len(beats) == 2
