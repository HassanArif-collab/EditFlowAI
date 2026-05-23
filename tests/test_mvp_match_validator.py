"""MVP Task M6: match_validator tests"""
import unittest
from backend.models.schemas import TranscriptWord
from backend.services.script_matcher import MatchedBeat
from backend.services.take_segmenter import Take
from backend.services.match_validator import validate_and_fix

def _make_words():
    return [
        TranscriptWord(word="Hello", start=0.0, end=0.5, probability=0.95),
        TranscriptWord(word="and", start=0.5, end=0.7, probability=0.92),
        TranscriptWord(word="welcome", start=0.7, end=1.1, probability=0.93),
        TranscriptWord(word="back", start=1.1, end=1.4, probability=0.91),
        TranscriptWord(word="to", start=1.4, end=1.55, probability=0.94),
        TranscriptWord(word="my", start=1.55, end=1.75, probability=0.90),
        TranscriptWord(word="channel", start=1.75, end=2.3, probability=0.93),
    ]

def _make_take():
    return Take(
        take_index=0,
        source_file="test.mp4",
        source_start=0.0,
        source_end=2.3,
        duration=2.3,
        text="Hello and welcome back to my channel",
        word_offset=0,
        word_count=7,
    )

class TestMatchValidator(unittest.TestCase):
    def test_valid_indices_pass(self):
        mb = MatchedBeat(beat_index=0, beat_text="test", take=_make_take(),
                         word_start_index=0, word_start_text="Hello",
                         word_end_index=6, word_end_text="channel")
        vm = validate_and_fix(mb, _make_words())
        self.assertFalse(vm.fell_back)
        self.assertEqual(vm.matched.word_start_index, 0)
        self.assertEqual(vm.matched.word_end_index, 6)

    def test_snaps_off_by_one_start(self):
        mb = MatchedBeat(beat_index=0, beat_text="test", take=_make_take(),
                         word_start_index=2, word_start_text="welcome",  # wrong index
                         word_end_index=6, word_end_text="channel")
        # "welcome" is actually at index 2, so this should be fine
        vm = validate_and_fix(mb, _make_words())
        self.assertFalse(vm.fell_back)

    def test_swapped_indices(self):
        mb = MatchedBeat(beat_index=0, beat_text="test", take=_make_take(),
                         word_start_index=5, word_start_text="my",
                         word_end_index=0, word_end_text="Hello")
        vm = validate_and_fix(mb, _make_words())
        self.assertTrue(any("swap" in w.lower() for w in vm.warnings))

    def test_too_short_duration(self):
        mb = MatchedBeat(beat_index=0, beat_text="test", take=_make_take(),
                         word_start_index=0, word_start_text="Hello",
                         word_end_index=0, word_end_text="Hello")
        vm = validate_and_fix(mb, _make_words())
        self.assertTrue(len(vm.warnings) > 0)

    def test_unmatched_beat_passes_through(self):
        mb = MatchedBeat(beat_index=0, beat_text="test", unmatched_reason="no_recall")
        vm = validate_and_fix(mb, [])
        self.assertFalse(vm.fell_back)
        self.assertIsNone(vm.matched.take)

    def test_empty_words_no_crash(self):
        mb = MatchedBeat(beat_index=0, beat_text="test", take=_make_take(),
                         word_start_index=0, word_end_index=0)
        vm = validate_and_fix(mb, [])
        self.assertIsNotNone(vm)

if __name__ == "__main__":
    unittest.main()
