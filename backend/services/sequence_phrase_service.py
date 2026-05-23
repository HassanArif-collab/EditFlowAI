"""
EditFlow AI - Sequence Phrase Service
Active-sequence transcription + phrase matching for spoken-phrase removal.

Diagnosis of the original problem:
The /api/pipeline/cut endpoint reads `speech_candidates`, which only get
created when the user runs folder analysis on raw recordings. The active
sequence in Premiere is unrelated to those candidates, so cut-by-phrase
calls returned `Matched 0/0`. This service plugs that gap: take the active
sequence's audio clips, transcribe each *unique* source file once, map
every word back to its position on the sequence timeline, and search
for phrases in timeline order.
"""
from __future__ import annotations

import asyncio
import logging
import re
import uuid
from collections import defaultdict
from typing import Any, Dict, Iterable, List, Optional, Tuple

from fastapi import HTTPException

from ..models.schemas import (
    SequenceAnalyzeRequest,
    SequenceAnalyzeResponse,
    SequencePhraseRange,
    SequencePhraseResponse,
    utc_now,
)
from ..models.sqlite_registry import sqlite_registry
from ..services.whisper_service import whisper_service
from ..utils.path_safety import DEFAULT_MEDIA_EXTS, safe_file_path
from ..utils.progress import ProgressReporter

logger = logging.getLogger(__name__)


_WORD_RE = re.compile(r"[\w']+", re.UNICODE)


# ── Pure helpers (also exposed for unit tests) ──

def normalize_phrase_words(text: str) -> List[str]:
    """Tokenise text into lowercase word tokens, dropping punctuation."""
    return [m.group(0).lower() for m in _WORD_RE.finditer(text or "")]


def map_word_to_timeline(
    clip: Dict[str, Any],
    source_start: float,
    source_end: float,
) -> Tuple[float, float]:
    """Translate a word's *source* time range to *timeline* time for a given clip.

    timeline_t = clip.timeline_start + (source_t - clip.source_in) / speed
    """
    speed = float(clip.get("speed") or 1.0)
    if speed == 0:
        speed = 1.0
    base = float(clip.get("timeline_start", 0))
    src_in = float(clip.get("source_in", 0))
    timeline_start = base + (source_start - src_in) / speed
    timeline_end = base + (source_end - src_in) / speed
    return round(timeline_start, 3), round(timeline_end, 3)


def _group_words_by_clip(words: Iterable[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    """Group words by (track_index, clip_index) and order each group by timeline.

    Words from different audio tracks/clips must not cross a phrase boundary —
    otherwise a two-word phrase could accidentally match "jamia(track 0)" +
    "masjid(track 1)" across overlapping audio.
    """
    groups: Dict[Tuple[int, int], List[Dict[str, Any]]] = defaultdict(list)
    for w in words:
        key = (int(w.get("track_index", 0)), int(w.get("clip_index", 0)))
        groups[key].append(w)
    for group in groups.values():
        group.sort(key=lambda w: float(w.get("timeline_start", 0)))
    return list(groups.values())


def find_phrase_ranges(
    words: List[Dict[str, Any]],
    phrase: str,
    padding_before: float = 0.05,
    padding_after: float = 0.08,
) -> List[Dict[str, Any]]:
    """Find every contiguous occurrence of ``phrase`` inside ``words``.

    Sliding window operates *within each clip group* so the phrase boundary
    can never bridge two unrelated clips/tracks.
    """
    phrase_words = normalize_phrase_words(phrase)
    if not phrase_words:
        return []

    ranges: List[Dict[str, Any]] = []
    width = len(phrase_words)

    for group in _group_words_by_clip(words):
        if len(group) < width:
            continue
        for i in range(0, len(group) - width + 1):
            window = group[i:i + width]
            if [w.get("normalized_word", "") for w in window] != phrase_words:
                continue
            first, last = window[0], window[-1]
            start = max(0.0, round(float(first["timeline_start"]) - padding_before, 3))
            end = round(float(last["timeline_end"]) + padding_after, 3)
            ranges.append({
                "start": start,
                "end": end,
                "text": " ".join(w.get("word", "") for w in window),
                "words": [w.get("word", "") for w in window],
                "track_index": int(first.get("track_index", 0)),
                "clip_index": int(first.get("clip_index", 0)),
                "clip_name": first.get("clip_name", ""),
                "media_path": first.get("media_path", ""),
            })

    # Return in timeline order so the preview/markers look natural.
    ranges.sort(key=lambda r: (r["start"], r["track_index"], r["clip_index"]))
    return ranges


# ── Service ──

class SequencePhraseService:
    """Transcribe the active sequence's audio clips and search phrases in it."""

    async def analyze_sequence(
        self,
        request: SequenceAnalyzeRequest,
        progress: Optional[ProgressReporter] = None,
    ) -> SequenceAnalyzeResponse:
        """Transcribe each unique source audio file once, then map words to
        every clip on the sequence that references that source file."""
        clips = [c.model_dump() for c in request.audio_clips if (c.media_path or "").strip()]
        if not clips:
            return SequenceAnalyzeResponse(
                success=False,
                sequence_id=request.sequence_id,
                sequence_name=request.sequence_name,
                message="No audio clips with media paths were provided.",
            )

        # ── Path validation (don't trust CEP-supplied paths) ──
        validated: List[Dict[str, Any]] = []
        skipped: List[str] = []
        unique_paths: Dict[str, str] = {}  # raw path -> validated absolute path
        for clip in clips:
            raw = clip.get("media_path", "")
            if raw in unique_paths:
                clip["media_path"] = unique_paths[raw]
                validated.append(clip)
                continue
            try:
                resolved = safe_file_path(raw, label="media_path", allow_extensions=DEFAULT_MEDIA_EXTS)
            except HTTPException as e:
                skipped.append(f"{raw}: {e.detail}")
                continue
            unique_paths[raw] = str(resolved)
            clip["media_path"] = str(resolved)
            validated.append(clip)

        if not validated:
            return SequenceAnalyzeResponse(
                success=False,
                sequence_id=request.sequence_id,
                sequence_name=request.sequence_name,
                skipped_clips=skipped,
                message="No clips passed path validation. Check media paths exist on this machine.",
            )

        # ── Persist parent transcript row ──
        transcript_id = str(uuid.uuid4())[:12]
        now = utc_now()
        sqlite_registry.execute(
            """INSERT INTO sequence_transcripts
            (id, sequence_id, sequence_name, language, clips_analyzed, words_indexed, metadata, created_at)
            VALUES (?, ?, ?, ?, 0, 0, '{}', ?)""",
            (transcript_id, request.sequence_id, request.sequence_name,
             request.language or "", now),
        )

        if progress:
            await progress.start(f"Transcribing {len(unique_paths)} unique source file(s)...")

        # ── Transcribe each unique file once ──
        # Maps validated absolute path -> list of word dicts {word, normalized_word, start, end, probability}
        transcripts: Dict[str, List[Dict[str, Any]]] = {}
        idx = 0
        for raw_path, resolved in unique_paths.items():
            idx += 1
            if progress:
                await progress.update(
                    0.1 + 0.7 * ((idx - 1) / max(len(unique_paths), 1)),
                    f"Transcribing {idx}/{len(unique_paths)}: {resolved}",
                )
            try:
                result = await whisper_service.transcribe(
                    video_path=resolved,
                    language=request.language,
                    word_timestamps=True,
                )
            except Exception as e:
                logger.exception(f"Whisper failed for {resolved}: {e}")
                skipped.append(f"{resolved}: transcription failed ({e})")
                transcripts[resolved] = []
                continue

            file_words: List[Dict[str, Any]] = []
            for segment in result.segments:
                for word in (segment.words or []):
                    normalized = normalize_phrase_words(word.word)
                    if not normalized:
                        continue
                    file_words.append({
                        "word": (word.word or "").strip(),
                        "normalized_word": normalized[0],
                        "start": float(word.start),
                        "end": float(word.end),
                        "probability": float(word.probability or 0),
                    })
            transcripts[resolved] = file_words

        # ── Map source words → timeline ranges for every clip ──
        if progress:
            await progress.update(0.85, "Mapping words to timeline positions...")

        words_indexed = 0
        for clip in validated:
            resolved_path = clip["media_path"]
            file_words = transcripts.get(resolved_path, [])
            src_in = float(clip.get("source_in", 0) or 0)
            src_out = float(clip.get("source_out", 10 ** 9) or 10 ** 9)
            # source_out=0 means "no limit" in Premiere clip data; treat <=0 as no cap.
            if src_out <= 0:
                src_out = 10 ** 9

            for word in file_words:
                ws, we = word["start"], word["end"]
                # Word must be entirely within the clip's used source range
                if ws < src_in or we > src_out:
                    continue
                tl_start, tl_end = map_word_to_timeline(clip, ws, we)
                sqlite_registry.execute(
                    """INSERT INTO sequence_words
                    (id, sequence_transcript_id, sequence_id, sequence_name, track_index, clip_index,
                     clip_name, media_path, source_start, source_end, timeline_start, timeline_end,
                     word, normalized_word, probability)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        str(uuid.uuid4())[:12], transcript_id,
                        request.sequence_id, request.sequence_name,
                        int(clip.get("track_index", 0)), int(clip.get("clip_index", 0)),
                        clip.get("clip_name", ""), resolved_path,
                        ws, we, tl_start, tl_end,
                        word["word"], word["normalized_word"], word["probability"],
                    ),
                )
                words_indexed += 1

        clips_analyzed = len(validated)
        sqlite_registry.execute(
            "UPDATE sequence_transcripts SET clips_analyzed = ?, words_indexed = ? WHERE id = ?",
            (clips_analyzed, words_indexed, transcript_id),
        )

        if progress:
            await progress.complete(
                f"Indexed {words_indexed} words across {clips_analyzed} clip(s)"
            )

        return SequenceAnalyzeResponse(
            success=True,
            sequence_id=request.sequence_id,
            sequence_name=request.sequence_name,
            transcript_id=transcript_id,
            clips_analyzed=clips_analyzed,
            words_indexed=words_indexed,
            skipped_clips=skipped,
            message=(
                f"Analyzed {clips_analyzed} sequence audio clips and indexed {words_indexed} words. "
                + (f"{len(skipped)} clip(s) skipped." if skipped else "")
            ).strip(),
        )

    def find_phrase(
        self,
        sequence_id: str,
        sequence_name: str,
        phrase: str,
        padding_before: float = 0.05,
        padding_after: float = 0.08,
    ) -> SequencePhraseResponse:
        """Look up phrase occurrences in the most recent transcript of this sequence."""
        # Match either sequence_id or sequence_name — both are user-facing identifiers
        # that may not always be present (a brand-new sequence has no id).
        rows = sqlite_registry.fetch_all(
            """SELECT * FROM sequence_words
            WHERE (sequence_id = ? OR sequence_name = ?)
            ORDER BY track_index ASC, clip_index ASC, timeline_start ASC""",
            (sequence_id, sequence_name),
        )
        ranges = find_phrase_ranges(rows, phrase, padding_before, padding_after)
        return SequencePhraseResponse(
            success=True,
            phrase=phrase,
            ranges=[SequencePhraseRange(**r) for r in ranges],
            message=(
                f"Found {len(ranges)} occurrence(s) of '{phrase}'."
                if ranges
                else f"No occurrences of '{phrase}' found. "
                "Did you run 'Analyze Sequence Audio' first?"
            ),
        )


sequence_phrase_service = SequencePhraseService()
