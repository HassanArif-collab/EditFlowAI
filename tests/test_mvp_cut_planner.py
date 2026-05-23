"""MVP Task M7: cut_planner tests"""
import unittest
from backend.models.schemas import TranscriptWord
from backend.services.script_matcher import MatchedBeat
from backend.services.take_segmenter import Take
from backend.services.match_validator import ValidatedMatch
from backend.services.cut_planner import build_plan

def _make_test_data():
    take = Take(
        take_index=0, source_file="test.mp4",
        source_start=0.0, source_end=5.0, duration=5.0,
        text="Hello and welcome back", word_offset=0, word_count=4,
    )
    words = [
        TranscriptWord(word="Hello", start=0.0, end=0.5, probability=0.95),
        TranscriptWord(word="and", start=0.5, end=0.7, probability=0.92),
        TranscriptWord(word="welcome", start=0.7, end=1.1, probability=0.93),
        TranscriptWord(word="back", start=1.1, end=1.4, probability=0.91),
    ]
    return take, words

class TestCutPlanner(unittest.TestCase):
    def test_single_cut_plan(self):
        take, words = _make_test_data()
        mb = MatchedBeat(
            beat_index=0, beat_text="Hello back",
            take=take, word_start_index=0, word_end_index=3,
        )
        vm = ValidatedMatch(matched=mb)
        plan = build_plan(
            bin_reference="@bin:Test",
            script="Hello back",
            user_hint=None,
            matcher_model="test-model",
            validated_matches=[vm],
            word_lookup={"test.mp4": words},
        )
        self.assertEqual(len(plan.cuts), 1)
        self.assertAlmostEqual(plan.cuts[0].source_in, 0.0, places=1)
        # build_plan applies VAD-snap + frame-snap (24 fps), so source_out
        # shifts from 1.4 to 34/24 ≈ 1.4167
        self.assertAlmostEqual(plan.cuts[0].source_out, 1.4, places=0)
        self.assertEqual(plan.summary["matched"], 1)
        self.assertEqual(plan.summary["unmatched"], 0)

    def test_unmatched_creates_gap(self):
        take, words = _make_test_data()
        mb_matched = MatchedBeat(
            beat_index=0, beat_text="Hello back",
            take=take, word_start_index=0, word_end_index=3,
        )
        mb_unmatched = MatchedBeat(
            beat_index=1, beat_text="Missing content",
            unmatched_reason="no_recall",
        )
        vm1 = ValidatedMatch(matched=mb_matched)
        vm2 = ValidatedMatch(matched=mb_unmatched)
        plan = build_plan(
            bin_reference="@bin:Test",
            script="Hello back\n\nMissing content",
            user_hint=None,
            matcher_model="test-model",
            validated_matches=[vm1, vm2],
            word_lookup={"test.mp4": words},
        )
        self.assertEqual(len(plan.cuts), 1)
        self.assertEqual(len(plan.gaps), 1)
        self.assertEqual(plan.summary["unmatched"], 1)

if __name__ == "__main__":
    unittest.main()
