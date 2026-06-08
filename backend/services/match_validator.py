"""
EditFlow AI - Match Validator

Sanity-checks script matcher output and either fixes it or falls back.
Applies safety checks to validate word indices and cut durations.

MVP Task M6.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional

from ..models.schemas import TranscriptWord
from .script_matcher import MatchedBeat

logger = logging.getLogger(__name__)


@dataclass
class ValidatedMatch:
    matched: MatchedBeat
    warnings: list[str] = field(default_factory=list)
    fell_back: bool = False


def validate_and_fix(
    matched: MatchedBeat,
    take_words: list[TranscriptWord],
) -> ValidatedMatch:
    """Apply the safety checks. Returns a fixed-or-fell-back ValidatedMatch.

    Checks (in order):
      1. word_start_text matches take_words[word_start_index].word (case-insensitive).
         If mismatch -> search ±3 indices for the quoted text. Snap if found.
         If still not found -> fell_back=True, set indices to [0, len-1] minus
         leading/trailing words with prob<0.5.

      2. word_end > word_start. If not -> swap.

      3. Cut duration = words[end].end - words[start].start in [1.0s, 60.0s].
         If outside -> if too short, extend to nearest word boundary that
         gives >=1s; if too long, trim to 60s.

      4. No silence > 1.5s INSIDE the named range. If found -> split warning
         (the LLM probably included a hesitation). Keep the range but add
         a 'long_silence_inside_cut' warning.
    """
    warnings: list[str] = []
    fell_back = False

    if matched.take is None or not take_words:
        # Unmatched beat — nothing to validate
        return ValidatedMatch(matched=matched, warnings=warnings, fell_back=False)

    start_idx = matched.word_start_index
    end_idx = matched.word_end_index

    # ── Check 1: Word text matches ──
    start_text = matched.word_start_text.lower() if matched.word_start_text else ""
    end_text = matched.word_end_text.lower() if matched.word_end_text else ""

    start_ok = False
    end_ok = False

    if 0 <= start_idx < len(take_words):
        start_ok = take_words[start_idx].word.lower() == start_text
    if 0 <= end_idx < len(take_words):
        end_ok = take_words[end_idx].word.lower() == end_text

    # Try to snap start
    if not start_ok and start_text:
        snapped = _find_word_near(take_words, start_text, start_idx, window=3)
        if snapped is not None:
            start_idx = snapped
            warnings.append(f"Snapped start index to {snapped} (text match)")
        else:
            warnings.append(f"Could not find word '{matched.word_start_text}' near index {start_idx}")

    # Try to snap end
    if not end_ok and end_text:
        snapped = _find_word_near(take_words, end_text, end_idx, window=3)
        if snapped is not None:
            end_idx = snapped
            warnings.append(f"Snapped end index to {snapped} (text match)")

    # Full fallback if both indices are unreliable
    if not start_ok and not end_ok and not warnings:
        # Neither text matched and no snapping worked — use full range
        # minus low-probability edges
        start_idx, end_idx = _fallback_range(take_words)
        fell_back = True
        warnings.append("Fell back to full take range (text mismatch)")

    # ── Check 2: Swapped indices ──
    if end_idx < start_idx:
        start_idx, end_idx = end_idx, start_idx
        warnings.append("Swapped start/end indices")

    # ── Check 3: Duration bounds ──
    start_idx = max(0, min(start_idx, len(take_words) - 1))
    end_idx = max(0, min(end_idx, len(take_words) - 1))

    if start_idx < len(take_words) and end_idx < len(take_words):
        duration = take_words[end_idx].end - take_words[start_idx].start

        if duration < 1.0:
            # Try to extend to get at least 1 second
            new_end = end_idx
            while new_end < len(take_words) - 1:
                new_end += 1
                if take_words[new_end].end - take_words[start_idx].start >= 1.0:
                    end_idx = new_end
                    warnings.append(f"Extended end index to {end_idx} for minimum 1s duration")
                    break
            else:
                warnings.append("Could not extend cut to 1s minimum — take too short")

        elif duration > 60.0:
            # Trim from the end
            new_end = end_idx
            while new_end > start_idx:
                new_end -= 1
                if take_words[new_end].end - take_words[start_idx].start <= 60.0:
                    end_idx = new_end
                    warnings.append(f"Trimmed end index to {end_idx} for 60s maximum")
                    break

    # ── Check 4: Long silence inside cut ──
    for i in range(start_idx, end_idx):
        gap = take_words[i + 1].start - take_words[i].end
        if gap > 1.5:
            warnings.append(
                f"Long silence ({gap:.1f}s) between words {i} and {i + 1} inside cut"
            )
            break  # Only warn once

    # Apply fixes to the MatchedBeat
    fixed = MatchedBeat(
        beat_index=matched.beat_index,
        beat_text=matched.beat_text,
        take=matched.take,
        word_start_index=start_idx,
        word_start_text=take_words[start_idx].word if start_idx < len(take_words) else "",
        word_end_index=end_idx,
        word_end_text=take_words[end_idx].word if end_idx < len(take_words) else "",
        llm_score=matched.llm_score,
        rationale=matched.rationale,
        raw_llm_response=matched.raw_llm_response,
        unmatched_reason=matched.unmatched_reason,
    )

    return ValidatedMatch(matched=fixed, warnings=warnings, fell_back=fell_back)


def _find_word_near(
    words: list[TranscriptWord],
    target: str,
    center: int,
    window: int = 3,
) -> Optional[int]:
    """Search ±window from center for a word matching target (case-insensitive)."""
    target_lower = target.lower()
    for offset in range(-window, window + 1):
        idx = center + offset
        if 0 <= idx < len(words):
            if words[idx].word.lower() == target_lower:
                return idx
    return None


def _fallback_range(words: list[TranscriptWord]) -> tuple[int, int]:
    """Compute a safe fallback range: [0, len-1] minus low-prob edges."""
    start = 0
    end = len(words) - 1

    # Skip leading words with prob < 0.5
    while start < end and words[start].probability < 0.5:
        start += 1

    # Skip trailing words with prob < 0.5
    while end > start and words[end].probability < 0.5:
        end -= 1

    return start, end
