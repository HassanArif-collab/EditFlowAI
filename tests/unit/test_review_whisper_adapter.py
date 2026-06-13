"""Tests for the Whisper → Review-editor adapter.

WHY: the panel's engine toggle (Whisper local / Scribe cloud) only works if both
engines land the SAME Segment/Word shape in the editor. Scribe has
build_segments_and_words(); this pins the Whisper equivalent so a local
transcribe drops words into the word editor exactly like Scribe does — ids
sequential, times rounded, words bound to their parent segment. If the shapes
drift, the editor (and every downstream cut) silently breaks for one engine.
"""
from __future__ import annotations

from backend.models.schemas import TranscriptResult, TranscriptSegment, TranscriptWord
from backend.services.review_service import (
    Segment,
    Word,
    build_segments_and_words_from_whisper,
)


def _result() -> TranscriptResult:
    return TranscriptResult(
        source_file="clip.mov",
        segments=[
            TranscriptSegment(
                start=0.5, end=2.0, text=" Hello world. ",
                words=[
                    TranscriptWord(word=" Hello", start=0.5004, end=1.2),
                    TranscriptWord(word="world.", start=1.2, end=2.0),
                ],
            ),
            TranscriptSegment(
                start=2.5, end=3.1, text="Again",
                words=[TranscriptWord(word="Again", start=2.5, end=3.1)],
            ),
        ],
    )


def test_whisper_adapter_matches_editor_shape():
    segments, words = build_segments_and_words_from_whisper(_result())

    # Segments: sequential ids, trimmed text, tight_* defaults equal raw times.
    assert [s.id for s in segments] == [0, 1]
    assert isinstance(segments[0], Segment)
    assert segments[0].text == "Hello world."
    assert (segments[0].start, segments[0].end) == (0.5, 2.0)
    assert (segments[0].tight_in, segments[0].tight_out) == (0.5, 2.0)

    # Words: globally sequential ids, rounded times, bound to parent segment.
    assert [w.id for w in words] == [0, 1, 2]
    assert isinstance(words[0], Word)
    assert [w.text for w in words] == ["Hello", "world.", "Again"]
    assert words[0].start == 0.5  # 0.5004 rounded to 3 dp
    assert [w.segment_id for w in words] == [0, 0, 1]
    assert all(w.keep for w in words)


def test_whisper_adapter_interpolates_when_word_timestamps_missing():
    result = TranscriptResult(
        source_file="clip.mov",
        segments=[TranscriptSegment(start=0.0, end=2.0, text="one two", words=[])],
    )
    segments, words = build_segments_and_words_from_whisper(result)
    # Falls back to the same interpolation the paste path uses: words exist,
    # lie inside the segment span, and stay contiguous for the karaoke highlight.
    assert [w.text for w in words] == ["one", "two"]
    assert words[0].start == segments[0].start
    assert words[-1].end == segments[0].end
    assert words[0].end == words[1].start
