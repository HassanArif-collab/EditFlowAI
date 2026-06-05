"""Normalize Gemini 2.5 Pro transcripts for the EditFlow pipeline.

Gemini outputs word timestamps like ``{"start_seconds": 0.0, "end_seconds": 0.4,
"word": "تو", "confidence": 0.99}`` but the pipeline expects Whisper's
``TranscriptWord(start=…, end=…, word=…, probability=…)``.

This module converts Gemini's format into the pipeline's format so Gemini
transcripts can feed into the paste-prompt builder (``build_paste_prompt``)
and the rest of the pipeline.

Schema mapping
--------------
+------------------+---------------------------+----------------------------+
| Gemini field     | Pipeline field            | Notes                      |
+------------------+---------------------------+----------------------------+
| start_seconds    | start                     | numeric seconds            |
| end_seconds      | end                       | numeric seconds            |
| word             | word                      | unchanged                  |
| confidence       | probability               | renamed, same value        |
| segment.text     | segment.text              | unchanged                  |
| segment.start_seconds | segment.start        |                            |
| segment.end_seconds   | segment.end          |                            |
+------------------+---------------------------+----------------------------+
"""
from __future__ import annotations

import json
from pathlib import Path

from ..models.schemas import TranscriptResult, TranscriptSegment, TranscriptWord


def load_gemini_json(path: str | Path) -> dict:
    """Read a Gemini-format JSON transcript file and return the raw dict."""
    raw = Path(path).read_text(encoding="utf-8")
    return json.loads(raw)


def gemini_words_to_transcript_words(gemini_words: list[dict]) -> list[TranscriptWord]:
    """Map Gemini word dicts to pipeline ``TranscriptWord`` objects.

    ``build_paste_prompt`` accesses ``.start``, ``.end``, ``.word`` via
    ``getattr``, so we must return objects with real attributes — plain
    dicts won't work.

    Example::

        [{"word":"تو", "start_seconds":0.0, "end_seconds":0.4, "confidence":0.99}]
        →
        [TranscriptWord(word="تو", start=0.0, end=0.4, probability=0.99)]
    """
    return [
        TranscriptWord(
            word=gw.get("word", ""),
            start=round(float(gw.get("start_seconds", 0.0) or 0.0), 3),
            end=round(float(gw.get("end_seconds", 0.0) or 0.0), 3),
            probability=round(float(gw.get("confidence", 1.0) or 1.0), 3),
        )
        for gw in gemini_words
    ]


def gemini_to_transcript_result(
    gemini_data: dict,
    source_path: str,
    *,
    language: str = "",
) -> TranscriptResult:
    """Convert a full Gemini JSON transcript dict to a pipeline ``TranscriptResult``.

    All word fields are mapped, and the result can be cached or passed
    directly to ``build_paste_prompt``.
    """
    segments: list[TranscriptSegment] = []
    all_words: list[TranscriptWord] = []

    for seg in gemini_data.get("segments", []):
        words: list[TranscriptWord] = []
        for gw in seg.get("words", []):
            tw = TranscriptWord(
                word=gw.get("word", ""),
                start=round(float(gw.get("start_seconds", 0.0) or 0.0), 3),
                end=round(float(gw.get("end_seconds", 0.0) or 0.0), 3),
                probability=round(float(gw.get("confidence", 1.0) or 1.0), 3),
            )
            words.append(tw)
            all_words.append(tw)

        segments.append(TranscriptSegment(
            start=round(float(seg.get("start_seconds", 0.0) or 0.0), 3),
            end=round(float(seg.get("end_seconds", 0.0) or 0.0), 3),
            text=seg.get("text", "").strip(),
            words=words,
        ))

    full_text = "\n".join(s.text for s in segments)

    return TranscriptResult(
        source_file=source_path,
        language=language or gemini_data.get("language", ""),
        duration=segments[-1].end if segments else 0.0,
        segments=segments,
        full_text=full_text,
        engine="gemini_2.5_pro",
        model="gemini-2.5-pro",
    )


def build_prompt_from_gemini(
    gemini_path: str | Path,
    *,
    script: str = "",
    clip_path: str = "",
) -> str:
    """Build a paste-prompt string directly from a Gemini JSON file.

    This is a convenience wrapper: reads the Gemini JSON, normalizes words,
    and calls the same prompt builder that the pipeline uses — no need to
    run the server or inject into the Whisper cache.

    Args:
        gemini_path: Path to the Gemini JSON transcript file.
        script: The user's script text (one line per beat).
        clip_path: Full path for the clip (used for source_file resolution).
            Defaults to the gemini JSON path with .mov extension.

    Returns:
        The formatted prompt string, ready to paste into a frontier model.
    """
    from .external_plan import build_paste_prompt

    data = load_gemini_json(gemini_path)
    path = clip_path or str(Path(gemini_path).with_suffix(".mov"))
    all_words = gemini_words_to_transcript_words(
        w for seg in data.get("segments", []) for w in seg.get("words", [])
    )

    return build_paste_prompt(
        script=script,
        transcripts_ready={path: "cached"},
        word_lookup={path: all_words},
    )


# ── CLI entry point ──────────────────────────────────────────────

def _parse_args() -> dict:
    import argparse
    p = argparse.ArgumentParser(
        description="Normalize a Gemini transcript for the EditFlow pipeline."
    )
    p.add_argument("gemini_json", help="Path to the Gemini JSON transcript file")
    p.add_argument("--script", "-s", default="", help="Script text for the prompt")
    p.add_argument("--clip-path", default="", help="Full source clip path")
    p.add_argument("--output", "-o", default="", help="Output path for the prompt file")
    return vars(p.parse_args())


def main():
    args = _parse_args()
    prompt = build_prompt_from_gemini(
        args["gemini_json"],
        script=args["script"],
        clip_path=args["clip_path"],
    )
    out_path = args["output"] or (Path(args["gemini_json"]).parent / "editflow_llm_prompt.txt")
    Path(out_path).write_text(prompt, encoding="utf-8")
    print(f"Prompt written to {out_path} ({len(prompt)} chars)")


if __name__ == "__main__":
    main()
