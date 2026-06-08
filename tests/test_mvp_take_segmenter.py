"""MVP Task M3: take_segmenter tests"""
import unittest
from backend.models.schemas import TranscriptResult, TranscriptSegment, TranscriptWord
from backend.services.take_segmenter import segment_into_takes

def _make_transcript_from_canonical():
    """Build a TranscriptResult matching the Phase A fixture canonical.json."""
    words_t0 = [
        TranscriptWord(word="Hello", start=2.10, end=2.55, probability=1.0),
        TranscriptWord(word="and", start=2.55, end=2.75, probability=1.0),
        TranscriptWord(word="welcome", start=2.75, end=3.20, probability=1.0),
        TranscriptWord(word="back", start=3.20, end=3.50, probability=1.0),
        TranscriptWord(word="to", start=3.50, end=3.65, probability=1.0),
        TranscriptWord(word="my", start=3.65, end=3.85, probability=1.0),
        TranscriptWord(word="channel", start=3.85, end=4.45, probability=1.0),
        TranscriptWord(word="Today", start=4.80, end=5.20, probability=1.0),
        TranscriptWord(word="I", start=5.20, end=5.30, probability=1.0),
        TranscriptWord(word="want", start=5.30, end=5.55, probability=1.0),
        TranscriptWord(word="to", start=5.55, end=5.70, probability=1.0),
        TranscriptWord(word="uh", start=5.85, end=6.20, probability=1.0),
        TranscriptWord(word="talk", start=6.35, end=6.70, probability=1.0),
        TranscriptWord(word="about", start=6.70, end=7.05, probability=1.0),
        TranscriptWord(word="something", start=7.05, end=7.55, probability=1.0),
        TranscriptWord(word="really", start=7.55, end=7.95, probability=1.0),
        TranscriptWord(word="cool", start=7.95, end=8.55, probability=1.0),
    ]
    words_t1 = [
        TranscriptWord(word="Today", start=11.10, end=11.45, probability=1.0),
        TranscriptWord(word="I", start=11.45, end=11.55, probability=1.0),
        TranscriptWord(word="want", start=11.55, end=11.80, probability=1.0),
        TranscriptWord(word="to", start=11.80, end=11.95, probability=1.0),
        TranscriptWord(word="talk", start=11.95, end=12.25, probability=1.0),
        TranscriptWord(word="about", start=12.25, end=12.60, probability=1.0),
        TranscriptWord(word="something", start=12.60, end=13.10, probability=1.0),
        TranscriptWord(word="interesting", start=13.10, end=13.90, probability=1.0),
        TranscriptWord(word="uh", start=14.10, end=14.45, probability=1.0),
        TranscriptWord(word="something", start=14.60, end=15.05, probability=1.0),
        TranscriptWord(word="that", start=15.05, end=15.25, probability=1.0),
        TranscriptWord(word="I", start=15.25, end=15.35, probability=1.0),
        TranscriptWord(word="think", start=15.35, end=15.65, probability=1.0),
        TranscriptWord(word="you'll", start=15.65, end=15.90, probability=1.0),
        TranscriptWord(word="find", start=15.90, end=16.20, probability=1.0),
        TranscriptWord(word="fascinating", start=16.20, end=17.40, probability=1.0),
    ]
    words_t2 = [
        TranscriptWord(word="Welcome", start=20.10, end=20.55, probability=1.0),
        TranscriptWord(word="back", start=20.55, end=20.85, probability=1.0),
        TranscriptWord(word="to", start=20.85, end=21.00, probability=1.0),
        TranscriptWord(word="the", start=21.00, end=21.15, probability=1.0),
        TranscriptWord(word="channel", start=21.15, end=21.75, probability=1.0),
        TranscriptWord(word="Today", start=22.20, end=22.60, probability=1.0),
        TranscriptWord(word="I", start=22.60, end=22.70, probability=1.0),
        TranscriptWord(word="want", start=22.70, end=22.95, probability=1.0),
        TranscriptWord(word="to", start=22.95, end=23.10, probability=1.0),
        TranscriptWord(word="discuss", start=23.10, end=23.65, probability=1.0),
        TranscriptWord(word="a", start=23.65, end=23.75, probability=1.0),
        TranscriptWord(word="fascinating", start=23.75, end=24.65, probability=1.0),
        TranscriptWord(word="topic", start=24.65, end=25.10, probability=1.0),
        TranscriptWord(word="that", start=25.40, end=25.65, probability=1.0),
        TranscriptWord(word="I", start=25.65, end=25.75, probability=1.0),
        TranscriptWord(word="think", start=25.75, end=26.05, probability=1.0),
        TranscriptWord(word="you'll", start=26.05, end=26.35, probability=1.0),
        TranscriptWord(word="really", start=26.35, end=26.80, probability=1.0),
        TranscriptWord(word="enjoy", start=26.80, end=31.10, probability=1.0),
    ]

    return TranscriptResult(
        source_file="fixture://short.wav",
        language="en",
        duration=33.0,
        segments=[
            TranscriptSegment(start=2.0, end=9.0, text=" ".join(w.word for w in words_t0), words=words_t0),
            TranscriptSegment(start=11.0, end=18.0, text=" ".join(w.word for w in words_t1), words=words_t1),
            TranscriptSegment(start=20.0, end=31.5, text=" ".join(w.word for w in words_t2), words=words_t2),
        ],
    )

class TestTakeSegmenter(unittest.TestCase):
    def test_three_takes_from_canonical(self):
        transcript = _make_transcript_from_canonical()
        takes = segment_into_takes("fixture://short.wav", transcript)
        self.assertEqual(len(takes), 3)
        self.assertAlmostEqual(takes[0].source_start, 2.10, places=2)
        self.assertAlmostEqual(takes[0].source_end, 8.55, places=1)
        self.assertAlmostEqual(takes[1].source_start, 11.10, places=2)
        self.assertAlmostEqual(takes[1].source_end, 17.40, places=1)
        self.assertAlmostEqual(takes[2].source_start, 20.10, places=2)
        self.assertAlmostEqual(takes[2].source_end, 31.10, places=1)

    def test_no_takes_for_empty_transcript(self):
        takes = segment_into_takes("x", TranscriptResult(source_file="x"))
        self.assertEqual(takes, [])

if __name__ == "__main__":
    unittest.main()
