"""Unit tests for the pure helpers in sequence_phrase_service.

These tests exercise the math + matching logic in isolation — no Whisper,
no SQLite, no FastAPI. Run via:

    python -m unittest tests.test_sequence_phrase_service -v
"""
import unittest

from backend.services.sequence_phrase_service import (
    find_phrase_ranges,
    map_word_to_timeline,
    normalize_phrase_words,
)


def _word(
    normalized: str,
    timeline_start: float,
    timeline_end: float,
    *,
    track_index: int = 0,
    clip_index: int = 0,
    clip_name: str = "voice.mp3",
    media_path: str = "voice.mp3",
    raw: str | None = None,
):
    return {
        "normalized_word": normalized,
        "word": raw if raw is not None else normalized,
        "timeline_start": timeline_start,
        "timeline_end": timeline_end,
        "track_index": track_index,
        "clip_index": clip_index,
        "clip_name": clip_name,
        "media_path": media_path,
    }


class NormalizationTests(unittest.TestCase):
    def test_strips_punctuation_and_lowercases(self):
        self.assertEqual(
            normalize_phrase_words("Jamia, Masjid!"),
            ["jamia", "masjid"],
        )

    def test_empty_input_returns_empty(self):
        self.assertEqual(normalize_phrase_words(""), [])
        self.assertEqual(normalize_phrase_words(None), [])  # type: ignore[arg-type]


class TimelineMappingTests(unittest.TestCase):
    def test_normal_speed(self):
        clip = {"timeline_start": 10.0, "source_in": 30.0, "speed": 1.0}
        self.assertEqual(map_word_to_timeline(clip, 32.25, 32.75), (12.25, 12.75))

    def test_double_speed_halves_duration(self):
        clip = {"timeline_start": 0.0, "source_in": 0.0, "speed": 2.0}
        # 2s of source plays in 1s of timeline at 2x speed
        self.assertEqual(map_word_to_timeline(clip, 2.0, 4.0), (1.0, 2.0))

    def test_zero_speed_defaults_to_one(self):
        clip = {"timeline_start": 5.0, "source_in": 0.0, "speed": 0}
        self.assertEqual(map_word_to_timeline(clip, 1.0, 2.0), (6.0, 7.0))


class PhraseMatchingTests(unittest.TestCase):
    def test_finds_all_occurrences_in_single_clip(self):
        words = [
            _word("welcome", 0.0, 0.4),
            _word("jamia",   1.0, 1.3),
            _word("masjid",  1.31, 1.7),
            _word("jamia",   3.0, 3.4),
            _word("masjid",  3.41, 3.9),
        ]
        ranges = find_phrase_ranges(words, "jamia masjid",
                                    padding_before=0.05, padding_after=0.08)
        self.assertEqual(len(ranges), 2)
        self.assertAlmostEqual(ranges[0]["start"], 0.95)
        self.assertAlmostEqual(ranges[0]["end"], 1.78)
        self.assertAlmostEqual(ranges[1]["start"], 2.95)
        self.assertAlmostEqual(ranges[1]["end"], 3.98)

    def test_does_not_bridge_across_clips(self):
        # Same phrase but split across two clips on different tracks must NOT match.
        # Otherwise a parallel-track ambient mic could falsely complete a phrase
        # started on the main track.
        words = [
            _word("jamia",  1.0, 1.3, track_index=0, clip_index=0, clip_name="main"),
            _word("masjid", 1.31, 1.7, track_index=1, clip_index=0, clip_name="ambient"),
        ]
        ranges = find_phrase_ranges(words, "jamia masjid")
        self.assertEqual(ranges, [],
                         "phrase must not bridge two different clips/tracks")

    def test_handles_multi_clip_same_phrase(self):
        # Two clips on the same track, each containing the phrase exactly once.
        words = [
            _word("jamia",  1.0, 1.3, clip_index=0),
            _word("masjid", 1.31, 1.7, clip_index=0),
            _word("jamia",  5.0, 5.3, clip_index=1),
            _word("masjid", 5.31, 5.7, clip_index=1),
        ]
        ranges = find_phrase_ranges(words, "jamia masjid")
        self.assertEqual(len(ranges), 2)
        self.assertEqual(ranges[0]["clip_index"], 0)
        self.assertEqual(ranges[1]["clip_index"], 1)

    def test_empty_phrase_returns_empty(self):
        words = [_word("jamia", 1.0, 1.3)]
        self.assertEqual(find_phrase_ranges(words, ""), [])
        self.assertEqual(find_phrase_ranges(words, "  "), [])

    def test_padding_clamps_to_zero(self):
        # A word at t=0.01 with padding_before=0.5 must not produce a negative start.
        words = [
            _word("hello", 0.01, 0.3),
            _word("world", 0.31, 0.6),
        ]
        ranges = find_phrase_ranges(words, "hello world",
                                    padding_before=0.5, padding_after=0.0)
        self.assertEqual(len(ranges), 1)
        self.assertEqual(ranges[0]["start"], 0.0)


if __name__ == "__main__":
    unittest.main()
