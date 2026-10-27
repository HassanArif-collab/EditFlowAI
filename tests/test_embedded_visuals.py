import pytest
from backend.services.embedded_visual_detector import (
    EmbeddedVisualDetector,
    embedded_visual_detector,
)


class TestEmbeddedVisualDetector:
    def test_detect_look_at_this(self):
        cues = [
            {"start": 0.0, "end": 4.5, "text": "currently the situation of our parking lot is actually very bad."},
            {"start": 4.5, "end": 9.2, "text": "look at this parking lot, see the mud and water standing right here."},
            {"start": 9.2, "end": 14.0, "text": "we need to raise funds to pave this ground."},
        ]

        visuals = EmbeddedVisualDetector.extract_visual_segments(
            cues, source_file="D:/videos/Video_B2.mp4", clip_stem="Video_B2", speaker="Muhammad Hafiz Abdullah"
        )

        assert len(visuals) == 1
        v = visuals[0]
        assert "look at this" in v.cue_phrase
        assert v.start_time == 4.5
        assert v.duration >= 3.0
        assert "parking" in v.tags or "mud" in v.tags or "demonstration" in v.tags
        assert v.speaker == "Muhammad Hafiz Abdullah"

    def test_detect_as_you_can_see(self):
        cues = [
            {"start": 12.0, "end": 16.5, "text": "as you can see the cracked asphalt is breaking apart under the cars."},
        ]

        visuals = EmbeddedVisualDetector.extract_visual_segments(
            cues, source_file="D:/videos/C1307.mp4", clip_stem="C1307"
        )

        assert len(visuals) == 1
        v = visuals[0]
        assert "as you can see" in v.cue_phrase
        assert "cracked" in v.tags or "asphalt" in v.tags
        assert v.start_time == 12.0

    def test_empty_or_non_deictic_cues(self):
        cues = [
            {"start": 0.0, "end": 5.0, "text": "thank you for joining us today for this update."},
        ]
        visuals = EmbeddedVisualDetector.extract_visual_segments(cues)
        assert len(visuals) == 0
