"""Word-timestamp sanitizer: every rule exists because a caption glitch
was visible — overlaps flash two words, zero durations skip the animation,
missing times (WhisperX 0-defaults) teleport words to t=0."""
import pytest

from backend.services.subtitles.word_sanitizer import MIN_DUR, sanitize_words


def w(word, start, end):
    return {"word": word, "start": start, "end": end}


def test_empty_list_ok():
    assert sanitize_words([]) == []


def test_overlap_clamped_to_next_start():
    out = sanitize_words([w("a", 0.0, 0.9), w("b", 0.5, 1.0)])
    assert out[0]["end"] == 0.5
    assert out[1]["start"] == 0.5


def test_zero_duration_gets_min_dur_shifting_end_not_start():
    out = sanitize_words([w("a", 1.0, 1.0), w("b", 2.0, 2.5)])
    assert out[0]["start"] == 1.0
    assert out[0]["end"] == pytest.approx(1.0 + MIN_DUR)


def test_negative_duration_fixed():
    out = sanitize_words([w("a", 1.0, 0.8), w("b", 2.0, 2.5)])
    assert out[0]["start"] == 1.0
    assert out[0]["end"] == pytest.approx(1.0 + MIN_DUR)


def test_missing_between_good_neighbors_interpolated():
    # "42" is unalignable → WhisperX defaults it to 0/0. It must land
    # between its neighbors, proportional to text length.
    out = sanitize_words([w("count", 1.0, 2.0), w("42", 0, 0), w("now", 3.0, 3.5)])
    assert 2.0 <= out[1]["start"] < out[1]["end"] <= 3.0


def test_none_timestamps_interpolated():
    out = sanitize_words([w("a", 1.0, 2.0), {"word": "b"}, w("c", 3.0, 3.5)])
    assert 2.0 <= out[1]["start"] < out[1]["end"] <= 3.0


def test_leading_missing_snaps_before_first_good_start():
    out = sanitize_words([{"word": "uh"}, w("hello", 5.0, 5.5)])
    assert out[0]["end"] == pytest.approx(5.0)
    assert out[0]["start"] == pytest.approx(5.0 - MIN_DUR)


def test_first_word_at_zero_is_not_treated_as_missing():
    out = sanitize_words([w("hi", 0.0, 0.4), w("there", 0.5, 0.9)])
    assert out[0]["start"] == 0.0
    assert out[0]["end"] == 0.4


def test_starts_non_decreasing():
    out = sanitize_words([w("a", 2.0, 2.5), w("b", 1.0, 3.0), w("c", 2.8, 3.2)])
    starts = [x["start"] for x in out]
    assert starts == sorted(starts)


def test_idempotent():
    messy = [w("a", 0.0, 0.9), w("b", 0.5, 0.5), w("42", 0, 0), w("c", 3.0, 3.5)]
    once = sanitize_words(messy)
    twice = sanitize_words(once)
    assert once == twice


def test_extra_keys_preserved_and_input_not_mutated():
    src = [{"word": "a", "start": 0.0, "end": 0.9, "confidence": 0.7},
           {"word": "b", "start": 0.5, "end": 1.0, "confidence": 0.9}]
    out = sanitize_words(src)
    assert out[0]["confidence"] == 0.7
    assert src[0]["end"] == 0.9  # input untouched
