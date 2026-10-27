import numpy as np
import pytest
from PIL import Image, ImageDraw

from backend.services.visual_quality_scorer import (
    FrameQuality,
    VisualQualityScorer,
    visual_quality_scorer,
)


def _create_sharp_image(w=200, h=200):
    """Creates an image with high-contrast sharp edges."""
    img = Image.new("RGB", (w, h), color=(240, 240, 240))
    draw = ImageDraw.Draw(img)
    for i in range(10, w, 20):
        draw.line([(i, 0), (i, h)], fill=(10, 10, 10), width=3)
        draw.line([(0, i), (w, i)], fill=(20, 20, 20), width=3)
    return img


def _create_blurry_image(w=200, h=200):
    """Creates a flat/blurry low-contrast image."""
    arr = np.full((h, w, 3), 128, dtype=np.uint8)
    return Image.fromarray(arr)


def _create_dark_image(w=200, h=200):
    """Creates an underexposed near-black image."""
    arr = np.full((h, w, 3), 10, dtype=np.uint8)
    return Image.fromarray(arr)


class TestVisualQualityScorer:
    def test_sharp_vs_blurry_scoring(self):
        sharp = _create_sharp_image()
        blurry = _create_blurry_image()

        q_sharp = VisualQualityScorer.score_frame(sharp, timestamp=1.0)
        q_blurry = VisualQualityScorer.score_frame(blurry, timestamp=2.0)

        assert q_sharp.sharpness > q_blurry.sharpness
        assert not q_sharp.is_blurry
        assert q_blurry.is_blurry
        assert q_sharp.composite_score > q_blurry.composite_score

    def test_exposure_penalty(self):
        dark = _create_dark_image()
        q_dark = VisualQualityScorer.score_frame(dark, timestamp=0.5)

        assert q_dark.exposure_score < 0.5
        assert q_dark.composite_score < 10.0

    def test_find_golden_section_skips_shaky_edges(self):
        # Create simulated timeline: 0.0-1.5s is blurry/shaky, 1.5-6.0s is crisp, 6.0-8.0s is blurry
        frames = [
            FrameQuality(timestamp=0.0, sharpness=50.0, is_blurry=True, exposure_score=1.0, composite_score=50.0),
            FrameQuality(timestamp=0.5, sharpness=80.0, is_blurry=True, exposure_score=1.0, composite_score=80.0),
            FrameQuality(timestamp=1.0, sharpness=90.0, is_blurry=True, exposure_score=1.0, composite_score=90.0),
            FrameQuality(timestamp=2.0, sharpness=800.0, is_blurry=False, exposure_score=1.0, composite_score=800.0),
            FrameQuality(timestamp=3.0, sharpness=950.0, is_blurry=False, exposure_score=1.0, composite_score=950.0),
            FrameQuality(timestamp=4.0, sharpness=900.0, is_blurry=False, exposure_score=1.0, composite_score=900.0),
            FrameQuality(timestamp=5.0, sharpness=850.0, is_blurry=False, exposure_score=1.0, composite_score=850.0),
            FrameQuality(timestamp=6.0, sharpness=70.0, is_blurry=True, exposure_score=0.3, composite_score=21.0),
            FrameQuality(timestamp=7.0, sharpness=30.0, is_blurry=True, exposure_score=0.2, composite_score=6.0),
        ]

        result = VisualQualityScorer.find_golden_section(
            frames, total_duration=8.0, target_duration=3.5, min_duration=2.5, max_duration=5.0
        )

        assert result.recommended_in >= 1.5
        assert result.recommended_out <= 6.0
        assert result.average_quality > 600.0
        assert result.is_usable is True

    def test_fallback_on_empty_frames(self):
        res = VisualQualityScorer.find_golden_section([], total_duration=10.0, target_duration=4.0)
        assert res.recommended_in == 1.5
        assert res.recommended_out == 5.5
        assert res.duration == 4.0
