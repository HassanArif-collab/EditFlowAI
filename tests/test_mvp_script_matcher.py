"""MVP Task M5: script_matcher tests (beat parsing + mocked matcher)"""
import unittest
from backend.services.script_matcher import parse_beats

class TestBeatParsing(unittest.TestCase):
    def test_splits_on_sentence_terminators(self):
        beats = parse_beats("Hello there. How are you? I am fine!")
        self.assertEqual(beats, ["Hello there.", "How are you?", "I am fine!"])

    def test_splits_on_blank_lines(self):
        beats = parse_beats("First beat\n\nSecond beat with no period")
        self.assertEqual(beats, ["First beat", "Second beat with no period"])

    def test_drops_short_beats(self):
        beats = parse_beats("Hi. Ok. This is a real beat sentence.")
        # "Hi" and "Ok" are <3 chars, should be dropped
        self.assertTrue(all(len(b) > 2 for b in beats))

    def test_empty_script(self):
        beats = parse_beats("")
        self.assertEqual(beats, [])

if __name__ == "__main__":
    unittest.main()
