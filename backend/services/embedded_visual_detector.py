"""
EditFlow AI - Embedded Visual Detector
Scans video transcripts and spoken dialogue for deictic pointing phrases
(e.g., 'look at this', 'as you can see', 'see right here', 'this is where').
Pinpoints on-camera demonstration moments within talking-head clips and extracts
them as first-class visual B-roll candidate segments.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


@dataclass
class EmbeddedVisual:
    source_file: str
    clip_stem: str
    cue_phrase: str
    demonstration_target: str
    start_time: float
    end_time: float
    duration: float
    tags: List[str] = field(default_factory=list)
    speaker: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "source_file": self.source_file,
            "clip_stem": self.clip_stem,
            "cue_phrase": self.cue_phrase,
            "demonstration_target": self.demonstration_target,
            "start_time": round(self.start_time, 2),
            "end_time": round(self.end_time, 2),
            "duration": round(self.duration, 2),
            "tags": self.tags,
            "speaker": self.speaker,
            "category": "demonstration_broll",
        }


# Common deictic pointing patterns where on-camera speaker indicates a physical visual
DEICTIC_PATTERNS: List[Tuple[str, str]] = [
    (r"\b(look at this\s+([a-zA-Z0-9_\s]{2,30}))\b", "look at this"),
    (r"\b(look right here\s+([a-zA-Z0-9_\s]{0,30}))\b", "look right here"),
    (r"\b(look at that\s+([a-zA-Z0-9_\s]{2,30}))\b", "look at that"),
    (r"\b(as you can see\s+([a-zA-Z0-9_\s]{2,35}))\b", "as you can see"),
    (r"\b(see right here\s+([a-zA-Z0-9_\s]{0,30}))\b", "see right here"),
    (r"\b(this is where\s+([a-zA-Z0-9_\s]{2,35}))\b", "this is where"),
    (r"\b(look at how\s+([a-zA-Z0-9_\s]{2,35}))\b", "look at how"),
    (r"\b(showing you\s+([a-zA-Z0-9_\s]{2,35}))\b", "showing you"),
    (r"\b(right over here\s+([a-zA-Z0-9_\s]{0,30}))\b", "right over here"),
]

STOP_WORDS = {"the", "a", "an", "is", "are", "was", "were", "it", "our", "my", "we", "and", "or", "to", "of", "in"}


class EmbeddedVisualDetector:
    """
    Detects moments in talking videos where the speaker visually demonstrates
    or points to something on camera.
    """

    @classmethod
    def extract_visual_segments(
        cls,
        transcript_cues: List[Dict[str, Any]],
        source_file: str = "",
        clip_stem: str = "",
        speaker: Optional[str] = None,
        default_duration: float = 4.0,
    ) -> List[EmbeddedVisual]:
        """
        Scan a list of transcript cues ({'start': float, 'end': float, 'text': str})
        for embedded visual demonstration moments.
        """
        results: List[EmbeddedVisual] = []
        if not transcript_cues:
            return results

        for cue in transcript_cues:
            text = cue.get("text", "")
            start = float(cue.get("start", 0.0))
            end = float(cue.get("end", start + default_duration))
            cue_dur = max(0.5, end - start)

            text_lower = text.lower()

            for pattern, cue_name in DEICTIC_PATTERNS:
                match = re.search(pattern, text_lower, re.IGNORECASE)
                if match:
                    full_match = match.group(1).strip()
                    target_phrase = match.group(2).strip() if len(match.groups()) >= 2 else ""

                    # Clean target phrase (e.g. "look at this parking lot" -> "parking lot")
                    cleaned_target = re.sub(r"^[,\.\s]+|[,\.\s]+$", "", target_phrase)
                    cleaned_target = re.split(r"[,;\.\?!]", cleaned_target)[0].strip()

                    # Extract tags
                    tags = ["demonstration", "pointed_visual"]
                    for token in re.findall(r"\b[a-zA-Z]{3,}\b", cleaned_target):
                        if token.lower() not in STOP_WORDS:
                            tags.append(token.lower())

                    # Calculate visual segment window (at least 3.0s, up to 5.0s)
                    seg_start = max(0.0, start)
                    seg_end = max(seg_start + 3.0, min(seg_start + max(default_duration, cue_dur), end + 2.0))

                    results.append(
                        EmbeddedVisual(
                            source_file=source_file,
                            clip_stem=clip_stem,
                            cue_phrase=full_match,
                            demonstration_target=cleaned_target or cue_name,
                            start_time=round(seg_start, 2),
                            end_time=round(seg_end, 2),
                            duration=round(seg_end - seg_start, 2),
                            tags=list(dict.fromkeys(tags)),
                            speaker=speaker,
                        )
                    )
                    break  # Avoid double-matching the same cue

        return results


# Global singleton
embedded_visual_detector = EmbeddedVisualDetector()
