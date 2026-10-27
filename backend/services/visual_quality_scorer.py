"""
EditFlow AI - Visual Quality Scorer & Golden Section Extractor
Analyzes raw video frames for Laplacian edge sharpness, exposure balance,
and camera stability to automatically isolate the sharpest, most stable 3-5 second
window (the 'Golden Section') of raw footage, rejecting blurry, shaky, or uninformative segments.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple
import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)


@dataclass
class FrameQuality:
    timestamp: float
    sharpness: float
    is_blurry: bool
    exposure_score: float
    composite_score: float


@dataclass
class GoldenSectionResult:
    recommended_in: float
    recommended_out: float
    duration: float
    average_quality: float
    max_sharpness: float
    is_usable: bool
    frame_scores: List[FrameQuality]


class VisualQualityScorer:
    """
    Evaluates raw footage quality using image processing heuristics:
    - 2D Laplacian variance for edge sharpness / focus detection.
    - Luminance histogram distribution for exposure check (rejects pitch-black and blown-out).
    - Rolling window optimizer to discover the highest-quality continuous segment.
    """

    BLUR_THRESHOLD: float = 160.0       # Sharpness below this is considered out-of-focus or motion-blurred
    CRISP_THRESHOLD: float = 500.0      # Sharpness above this is considered high-definition crisp
    MIN_LUMINANCE: float = 25.0         # Underexposed / dark frame threshold
    MAX_LUMINANCE: float = 235.0        # Overexposed / blown-out frame threshold

    @classmethod
    def score_frame(cls, img: Image.Image, timestamp: float = 0.0) -> FrameQuality:
        """
        Evaluate a single PIL Image for sharpness and exposure quality.
        """
        try:
            gray = img.convert("L")
            arr = np.array(gray, dtype=np.float32)

            if arr.shape[0] < 5 or arr.shape[1] < 5:
                return FrameQuality(timestamp, 0.0, True, 0.0, 0.0)

            # 2D Laplacian operator via discrete convolution slicing
            lap = (
                arr[:-2, 1:-1]
                + arr[2:, 1:-1]
                + arr[1:-1, :-2]
                + arr[1:-1, 2:]
                - 4.0 * arr[1:-1, 1:-1]
            )
            sharpness = float(np.var(lap))

            # Exposure check
            mean_lum = float(np.mean(arr))
            exposure_score = 1.0

            if mean_lum < cls.MIN_LUMINANCE:
                # Underexposed penalty
                exposure_score = max(0.1, mean_lum / cls.MIN_LUMINANCE)
            elif mean_lum > cls.MAX_LUMINANCE:
                # Overexposed penalty
                exposure_score = max(0.1, (255.0 - mean_lum) / (255.0 - cls.MAX_LUMINANCE))

            is_blurry = sharpness < cls.BLUR_THRESHOLD
            composite = sharpness * exposure_score

            return FrameQuality(
                timestamp=round(timestamp, 3),
                sharpness=round(sharpness, 2),
                is_blurry=is_blurry,
                exposure_score=round(exposure_score, 3),
                composite_score=round(composite, 2),
            )
        except Exception as e:
            logger.warning(f"[visual_quality_scorer] Error scoring frame: {e}")
            return FrameQuality(timestamp, 0.0, True, 0.0, 0.0)

    @classmethod
    def find_golden_section(
        cls,
        frame_qualities: List[FrameQuality],
        total_duration: float,
        target_duration: float = 4.0,
        min_duration: float = 2.5,
        max_duration: float = 5.0,
    ) -> GoldenSectionResult:
        """
        Find the continuous time window of target_duration that maximizes overall quality.
        Automatically avoids shaky camera starts (first 1.5s) and camera ends if duration allows.
        """
        if not frame_qualities:
            # Fallback if no frames were scored
            start = 1.5 if total_duration > 6.0 else 0.0
            end = min(start + target_duration, total_duration)
            return GoldenSectionResult(
                recommended_in=round(start, 2),
                recommended_out=round(end, 2),
                duration=round(end - start, 2),
                average_quality=50.0,
                max_sharpness=50.0,
                is_usable=True,
                frame_scores=[],
            )

        # Desired window length
        window_sec = min(target_duration, total_duration)
        if window_sec < min_duration:
            window_sec = min(total_duration, min_duration)

        # If clip is very short, use the whole thing (trimming 0.2s edges if possible)
        if total_duration <= min_duration + 0.5:
            avg_q = float(np.mean([f.composite_score for f in frame_qualities]))
            max_s = float(np.max([f.sharpness for f in frame_qualities]))
            return GoldenSectionResult(
                recommended_in=0.0,
                recommended_out=round(total_duration, 2),
                duration=round(total_duration, 2),
                average_quality=round(avg_q, 2),
                max_sharpness=round(max_s, 2),
                is_usable=avg_q > 50.0,
                frame_scores=frame_qualities,
            )

        # Sliding window evaluation
        # Prefer windows starting after 1.0s (to skip camera settle shake)
        # and ending before (total_duration - 0.8s) (to skip camera cutoff shake)
        safe_start_min = 1.0 if total_duration > (window_sec + 2.0) else 0.0
        safe_start_max = max(0.0, total_duration - window_sec - 0.5)

        best_score = -1.0
        best_in = safe_start_min
        best_out = safe_start_min + window_sec

        # Candidate start times sampled across the timestamps
        candidate_starts = [f.timestamp for f in frame_qualities if safe_start_min <= f.timestamp <= safe_start_max]
        if not candidate_starts:
            candidate_starts = [safe_start_min]

        for cand_start in candidate_starts:
            cand_end = min(cand_start + window_sec, total_duration)
            # Find frames that fall within [cand_start, cand_end]
            in_window = [f for f in frame_qualities if cand_start <= f.timestamp <= cand_end]
            if not in_window:
                continue

            # Compute score: average composite, penalizing windows with blurry frames
            scores = [f.composite_score for f in in_window]
            blurry_ratio = sum(1 for f in in_window if f.is_blurry) / len(in_window)
            window_score = float(np.mean(scores)) * (1.0 - 0.6 * blurry_ratio)

            if window_score > best_score:
                best_score = window_score
                best_in = cand_start
                best_out = cand_end

        # Calculate summary statistics
        in_best_window = [f for f in frame_qualities if best_in <= f.timestamp <= best_out]
        avg_quality = float(np.mean([f.composite_score for f in in_best_window])) if in_best_window else 0.0
        max_sharpness = float(np.max([f.sharpness for f in in_best_window])) if in_best_window else 0.0

        return GoldenSectionResult(
            recommended_in=round(best_in, 2),
            recommended_out=round(best_out, 2),
            duration=round(best_out - best_in, 2),
            average_quality=round(avg_quality, 2),
            max_sharpness=round(max_sharpness, 2),
            is_usable=avg_quality >= cls.BLUR_THRESHOLD * 0.5,
            frame_scores=frame_qualities,
        )


# Global singleton
visual_quality_scorer = VisualQualityScorer()
