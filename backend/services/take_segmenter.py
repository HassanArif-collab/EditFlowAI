"""
take_segmenter — Split a Whisper word stream into "takes" by silence gaps,
with filler detection, quality scoring, clean_text generation, false-start
detection, and eager embedding computation.

Enhanced from MVP Task M3 (pure silence math) to include:
  - Filler word detection (en/ur lexicons, duration + silence heuristics)
  - clean_text generation (fillers and false starts removed)
  - Quality scoring (weighted combination of filler ratio, pause ratio,
    false-start ratio, WPM, log-prob, and SNR)
  - False-start detection (cross-take Levenshtein matching)
  - Eager 384-dim embedding computation (best-effort)
  - long_pauses, wpm, logprob_mean metrics
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from typing import List, Optional

from ..models.schemas import TranscriptResult, TranscriptWord

logger = logging.getLogger(__name__)


# ── Filler-word lexicons ──────────────────────────────────────────────────

FILLER_WORDS: dict[str, list[str]] = {
    "en": [
        "uh", "um", "ah", "er", "like", "you know", "so", "actually",
        "basically", "literally", "right", "okay", "well",
    ],
    "ur": [
        "umm", "ahh", "toh", "woh", "matlab", "dekho", "haan",
    ],
}

# Duration range (seconds) considered filler-typical for all supported languages
_FILLER_DURATION_MIN = 0.200   # 200 ms
_FILLER_DURATION_MAX = 0.600   # 600 ms

# Silence threshold around a filler (seconds)
_FILLER_SILENCE_MIN = 0.150    # 150 ms

# Silence threshold for "long pause" within a take
_LONG_PAUSE_THRESHOLD = 1.5    # 1.5 s

# Sentence terminators (used for false-start detection)
_SENTENCE_TERMINATORS = frozenset({".", "!", "?", "…"})


# ── Take dataclass ───────────────────────────────────────────────────────

@dataclass
class Take:
    """A single take extracted from a source file's transcript.

    Attributes:
        take_index:   0-based index within this source file.
        source_file:  Absolute path of the source media file.
        source_start: Seconds — first word's start time.
        source_end:   Seconds — last word's end time.
        duration:     source_end - source_start in seconds.
        text:         Space-joined word texts.
        word_offset:  Index in the source file's flat word list where this
                      take's words begin.
        word_count:   Number of words in this take.
        content_hash: SHA-256 content hash of the source file.
        take_id:      Unique identifier (uuid4 prefix).
        clean_text:   Text with fillers and false starts removed.
        word_ids:     Word IDs for DB lookup.
        quality:      Quality scoring dict.
        embedding:    384-dim embedding vector (empty if unavailable).
    """

    take_index: int
    source_file: str
    source_start: float
    source_end: float
    duration: float
    text: str
    word_offset: int
    word_count: int
    # ── New fields ──
    content_hash: str = ""
    take_id: str = ""
    clean_text: str = ""
    word_ids: list[str] = field(default_factory=list)
    quality: dict = field(default_factory=dict)
    embedding: list[float] = field(default_factory=list)


# ── Helper: flatten words ────────────────────────────────────────────────

def _flatten_words(transcript: TranscriptResult) -> List[TranscriptWord]:
    """Flatten transcript.segments[].words into a single ordered list."""
    words: List[TranscriptWord] = []
    for segment in transcript.segments:
        words.extend(segment.words)
    return words


# ── Filler detection ─────────────────────────────────────────────────────

def _is_filler_word(
    word_text: str,
    word_duration: float,
    prev_gap: Optional[float],
    next_gap: Optional[float],
    language: str,
) -> bool:
    """Determine whether a single word is a filler.

    All three criteria must be met:
      a) Word matches a filler from the language lexicon (case-insensitive).
      b) Word duration is in the filler-typical range (200–600 ms).
      c) Word is preceded or followed by >= 150 ms silence.
    """
    lexicon = FILLER_WORDS.get(language, FILLER_WORDS.get("en", []))
    word_lower = word_text.strip().lower()

    # Criterion (a): lexical match
    matched_lexically = any(
        word_lower == filler or word_lower == filler.lower()
        for filler in lexicon
    )
    if not matched_lexically:
        return False

    # Criterion (b): duration in filler-typical range
    if not (_FILLER_DURATION_MIN <= word_duration <= _FILLER_DURATION_MAX):
        return False

    # Criterion (c): preceding or following silence >= 150 ms
    # Small epsilon (1 ms) to guard against floating-point imprecision
    _eps = 0.001
    has_silence = (
        (prev_gap is not None and prev_gap >= _FILLER_SILENCE_MIN - _eps)
        or (next_gap is not None and next_gap >= _FILLER_SILENCE_MIN - _eps)
    )
    return has_silence


def _detect_fillers(
    words: List[TranscriptWord],
    language: str,
) -> list[bool]:
    """Return a parallel list of booleans — True where the word is a filler."""
    n = len(words)
    is_filler = [False] * n

    for i, w in enumerate(words):
        duration = w.end - w.start

        # Gap before this word
        if i > 0:
            prev_gap = w.start - words[i - 1].end
        else:
            prev_gap = None

        # Gap after this word
        if i < n - 1:
            next_gap = words[i + 1].start - w.end
        else:
            next_gap = None

        if _is_filler_word(w.word, duration, prev_gap, next_gap, language):
            is_filler[i] = True

    return is_filler


# ── Long-pause detection ────────────────────────────────────────────────

def _count_long_pauses(words: List[TranscriptWord]) -> int:
    """Count gaps > 1.5 s between consecutive words within the list."""
    count = 0
    for i in range(1, len(words)):
        gap = words[i].start - words[i - 1].end
        if gap > _LONG_PAUSE_THRESHOLD:
            count += 1
    return count


# ── WPM calculation ──────────────────────────────────────────────────────

def _calc_wpm(word_count: int, duration_s: float) -> float:
    """Words per minute. Returns 0.0 if duration is zero."""
    if duration_s <= 0:
        return 0.0
    return (word_count / duration_s) * 60.0


# ── Log-prob mean ────────────────────────────────────────────────────────

def _calc_logprob_mean(words: List[TranscriptWord]) -> float:
    """Average of word probabilities in the take. Returns 0.0 if empty."""
    if not words:
        return 0.0
    return sum(w.probability for w in words) / len(words)


# ── Levenshtein distance ─────────────────────────────────────────────────

def _levenshtein(a: str, b: str) -> int:
    """Compute Levenshtein distance between two strings (pure Python)."""
    if len(a) < len(b):
        a, b = b, a
    if not b:
        return len(a)

    prev_row = list(range(len(b) + 1))
    for i, ca in enumerate(a):
        curr_row = [i + 1]
        for j, cb in enumerate(b):
            cost = 0 if ca == cb else 1
            curr_row.append(min(
                curr_row[j] + 1,        # insert
                prev_row[j + 1] + 1,    # delete
                prev_row[j] + cost,     # substitute
            ))
        prev_row = curr_row
    return prev_row[-1]


def _normalize_word(text: str) -> str:
    """Lowercase, strip punctuation for comparison."""
    return text.strip().lower().strip(".,;:!?\"'()[]{}")


# ── False-start detection ────────────────────────────────────────────────

def _detect_false_starts(
    takes_words: list[List[TranscriptWord]],
) -> list[int]:
    """Count false starts per take.

    A false start is detected when:
      - A take ends mid-phrase (last word followed by >=1.0s silence and
        the last word does not end with a sentence terminator), AND
      - The next take's first >=3 words approximately match this take's
        last >=3 words (Levenshtein distance <= 1 on normalized form).

    Returns a list of false_start counts (0 or 1) per take.
    """
    n = len(takes_words)
    false_starts = [0] * n

    for i in range(n - 1):
        curr_words = takes_words[i]
        next_words = takes_words[i + 1]

        if len(curr_words) < 3 or len(next_words) < 3:
            continue

        # Check if the current take ends mid-phrase:
        # last word must NOT end with a sentence terminator
        last_word_text = curr_words[-1].word.strip()
        ends_with_terminator = last_word_text[-1] in _SENTENCE_TERMINATORS if last_word_text else False

        if ends_with_terminator:
            continue

        # Gap after last word of current take to first word of next take
        gap_after = next_words[0].start - curr_words[-1].end
        if gap_after < 1.0:
            continue

        # Compare last 3 words of current take with first 3 words of next take
        curr_tail = [_normalize_word(w.word) for w in curr_words[-3:]]
        next_head = [_normalize_word(w.word) for w in next_words[:3]]

        # Join for Levenshtein comparison
        curr_str = " ".join(curr_tail)
        next_str = " ".join(next_head)

        if not curr_str or not next_str:
            continue

        dist = _levenshtein(curr_str, next_str)
        if dist <= 1:
            false_starts[i] += 1

    return false_starts


# ── Clean-text generation ────────────────────────────────────────────────

def _generate_clean_text(
    words: List[TranscriptWord],
    is_filler: list[bool],
    is_false_start_take: bool,
) -> str:
    """Generate clean text by removing filler words and false-start phrases.

    - Removes words marked as fillers.
    - If this take is a false start, removes the last 3 words (the repeated
      phrase that was restarted).
    - Strips leading/trailing whitespace.
    """
    # Determine which word indices to skip
    skip_indices: set[int] = set()

    # Skip fillers
    for idx, flag in enumerate(is_filler):
        if flag:
            skip_indices.add(idx)

    # Skip false-start tail (last 3 words of the repeated phrase)
    if is_false_start_take and len(words) >= 3:
        for idx in range(len(words) - 3, len(words)):
            skip_indices.add(idx)

    clean_words = [words[i].word for i in range(len(words)) if i not in skip_indices]
    return " ".join(clean_words).strip()


# ── Quality scoring ──────────────────────────────────────────────────────

# Default quality-score weights
_W_FILLER = 0.30
_W_PAUSE = 0.20
_W_REPEAT = 0.20
_W_SPEECH = 0.10
_W_LOGPROB = 0.10
_W_SNR = 0.10

# Ideal values for normalization
_IDEAL_WPM = 150.0
_IDEAL_LOGPROB = -0.1
_IDEAL_SNR_DB = 20.0


def _clamp01(v: float) -> float:
    """Clamp a value to [0, 1]."""
    return max(0.0, min(1.0, v))


def _normalize_inverse(count: int, reference_count: int) -> float:
    """Normalize a count to [0,1] where 0 is best (high count).
    Returns 1 - (count / reference_count) clamped to [0,1].
    Uses max(reference_count, 1) to avoid division by zero.
    """
    return _clamp01(1.0 - count / max(reference_count, 1))


def _normalize_around(value: float, ideal: float, tolerance: float = 1.0) -> float:
    """Normalize a value around an ideal: 1.0 when value==ideal, decaying
    towards 0 as it diverges.  Uses a Gaussian-like falloff.
    """
    if tolerance <= 0:
        return 1.0 if value == ideal else 0.0
    diff = abs(value - ideal) / tolerance
    return _clamp01(1.0 - diff)


def _compute_quality(
    filler_count: int,
    long_pauses: int,
    false_starts: int,
    wpm: float,
    logprob_mean: float,
    word_count: int,
    filler_words: list[str],
) -> dict:
    """Compute quality scoring dict using the plan's weighted formula.

    overall = w_filler * (1 - normalize(filler_count))
            + w_pause  * (1 - normalize(long_pauses))
            + w_repeat * (1 - normalize(false_starts))
            + w_speech * normalize(wpm, ideal=150)
            + w_logprob * normalize(logprob_mean, ideal=-0.1)
            + w_snr     * normalize(snr_db, ideal=20)
    """
    # Normalization: use word_count as reference so ratios are meaningful
    filler_ratio = _normalize_inverse(filler_count, max(word_count, 1))
    pause_ratio = _normalize_inverse(long_pauses, max(word_count, 1))
    repeat_ratio = _normalize_inverse(false_starts, max(word_count, 1))
    speech_score = _normalize_around(wpm, _IDEAL_WPM, tolerance=75.0)
    logprob_score = _normalize_around(logprob_mean, _IDEAL_LOGPROB, tolerance=0.5)

    # SNR is estimated from logprob as a proxy (actual SNR requires audio analysis)
    # Higher logprob -> better SNR proxy. Map logprob to approximate SNR.
    # This is a heuristic: logprob ~ -0.1 corresponds to clean audio (~20 dB SNR)
    snr_db_estimate = 20.0 + (logprob_mean - _IDEAL_LOGPROB) * 40.0
    snr_score = _normalize_around(snr_db_estimate, _IDEAL_SNR_DB, tolerance=10.0)

    overall = (
        _W_FILLER * filler_ratio
        + _W_PAUSE * pause_ratio
        + _W_REPEAT * repeat_ratio
        + _W_SPEECH * speech_score
        + _W_LOGPROB * logprob_score
        + _W_SNR * snr_score
    )

    return {
        "filler_count": filler_count,
        "filler_words": filler_words,
        "false_starts": false_starts,
        "long_pauses": long_pauses,
        "wpm": round(wpm, 1),
        "logprob_mean": round(logprob_mean, 4),
        "overall_score": round(_clamp01(overall), 4),
    }


# ── Eager embedding ──────────────────────────────────────────────────────

def _compute_embeddings(takes: list[Take]) -> None:
    """Best-effort embedding computation for all takes.

    Modifies takes in-place, setting the embedding field.
    If the embedding service fails, the embedding stays empty.
    """
    if not takes:
        return

    texts_to_embed: list[str] = []
    # Use clean_text if available, else text
    for take in takes:
        text = take.clean_text or take.text
        if text.strip():
            texts_to_embed.append(text)
        else:
            texts_to_embed.append("")  # placeholder to keep indices aligned

    # Skip if no non-empty texts
    if not any(t.strip() for t in texts_to_embed):
        return

    try:
        from .embedding_service import embedding_service
        embeddings = embedding_service.embed(texts_to_embed)
        for i, take in enumerate(takes):
            if i < len(embeddings) and texts_to_embed[i].strip():
                take.embedding = embeddings[i]
    except Exception as exc:
        logger.warning("Eager embedding computation failed (non-fatal): %s", exc)


# ── Word ID generation ───────────────────────────────────────────────────

def _generate_word_ids(content_hash: str, word_offset: int, word_count: int) -> list[str]:
    """Generate word IDs for DB lookup.

    Format: "{content_hash}:{global_index}" or "nohash:{global_index}"
    if content_hash is empty.
    """
    prefix = content_hash if content_hash else "nohash"
    return [f"{prefix}:{word_offset + i}" for i in range(word_count)]


# ── Main segmentation function ───────────────────────────────────────────

def segment_into_takes(
    source_file: str,
    transcript: TranscriptResult,
    *,
    silence_threshold_s: float = 0.7,
    language: str = "en",
    content_hash: str = "",
) -> list[Take]:
    """Group words from a Whisper transcript into takes by silence-gap,
    with filler detection, quality scoring, clean_text, and eager embeddings.

    Take boundary: if word[n+1].start - word[n].end >= silence_threshold_s,
    take ends at word[n] and a new take starts at word[n+1].

    Enhancements over pure silence math:
      - Filler words detected and excluded from clean_text.
      - Quality score computed per take.
      - False-start detection across consecutive takes.
      - Eager 384-dim embeddings computed (best-effort).
      - long_pauses, wpm, logprob_mean metrics included.

    Backward-compatible: calling with just (source_file, transcript)
    still works — new parameters default to sensible values.

    Args:
        source_file:          Absolute path of the source media file.
        transcript:           Whisper transcript result containing segments
                              with word-level timestamps.
        silence_threshold_s:  Minimum silence gap (seconds) between consecutive
                              words to trigger a take boundary. Defaults to 0.7s.
        language:             Language code for filler lexicon ("en", "ur").
                              Defaults to "en".
        content_hash:         SHA-256 content hash of the source file.
                              Defaults to "".

    Returns:
        A list of Take objects, ordered by appearance in the source file.
        Chunks with fewer than 3 words are excluded.
    """
    all_words = _flatten_words(transcript)

    if not all_words:
        return []

    # ── Build chunks by walking pairwise and splitting on silence gaps ──
    chunks: List[List[TranscriptWord]] = []
    current_chunk: List[TranscriptWord] = [all_words[0]]

    for i in range(1, len(all_words)):
        prev = all_words[i - 1]
        curr = all_words[i]
        gap = curr.start - prev.end

        if gap >= silence_threshold_s:
            chunks.append(current_chunk)
            current_chunk = [curr]
        else:
            current_chunk.append(curr)

    # Append the last chunk
    if current_chunk:
        chunks.append(current_chunk)

    # ── Filter chunks: skip tiny chunks (< 3 words) ──
    # We keep track of which chunks are valid and their word offsets
    valid_chunks: list[tuple[List[TranscriptWord], int]] = []  # (chunk, word_offset)
    word_cursor = 0

    for chunk in chunks:
        word_count = len(chunk)
        if word_count < 3:
            word_cursor += word_count
            continue
        valid_chunks.append((chunk, word_cursor))
        word_cursor += word_count

    # ── False-start detection (requires cross-take visibility) ──
    chunk_word_lists = [vc[0] for vc in valid_chunks]
    false_starts_per_take = _detect_false_starts(chunk_word_lists)

    # ── Build Take objects with all enrichments ──
    takes: list[Take] = []

    for take_index, (chunk, word_offset) in enumerate(valid_chunks):
        word_count = len(chunk)
        source_start = chunk[0].start
        source_end = chunk[-1].end
        duration = source_end - source_start
        text = " ".join(w.word for w in chunk)

        # Filler detection for this chunk
        is_filler = _detect_fillers(chunk, language)
        filler_count = sum(is_filler)
        filler_words_list = [chunk[i].word for i in range(len(chunk)) if is_filler[i]]

        # Long pauses
        long_pauses = _count_long_pauses(chunk)

        # WPM
        wpm = _calc_wpm(word_count, duration)

        # Log-prob mean
        logprob_mean = _calc_logprob_mean(chunk)

        # False starts for this take
        false_starts = false_starts_per_take[take_index]

        # Quality scoring
        quality = _compute_quality(
            filler_count=filler_count,
            long_pauses=long_pauses,
            false_starts=false_starts,
            wpm=wpm,
            logprob_mean=logprob_mean,
            word_count=word_count,
            filler_words=filler_words_list,
        )

        # Clean text
        clean_text = _generate_clean_text(
            chunk, is_filler, is_false_start_take=false_starts > 0
        )

        # Word IDs
        word_ids = _generate_word_ids(content_hash, word_offset, word_count)

        # Take ID (uuid4 prefix, first 8 chars)
        take_id = uuid.uuid4().hex[:8]

        takes.append(
            Take(
                take_index=take_index,
                source_file=source_file,
                source_start=source_start,
                source_end=source_end,
                duration=duration,
                text=text,
                word_offset=word_offset,
                word_count=word_count,
                content_hash=content_hash,
                take_id=take_id,
                clean_text=clean_text,
                word_ids=word_ids,
                quality=quality,
                embedding=[],  # filled by _compute_embeddings below
            )
        )

    # ── Eager embedding computation (best-effort) ──
    _compute_embeddings(takes)

    return takes
