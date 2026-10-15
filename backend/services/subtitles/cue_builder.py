"""Caption cue builder — words[] → cues[] (pure, no I/O).

The one interchange every caption consumer takes (native caption track,
per-cue graphics, SRT export). Times are seconds; for the post-cut path
run :func:`remap_kept_words_to_output` first so captions don't drift after
the Review editor removes spans.
"""
from __future__ import annotations

from dataclasses import dataclass

# Sentence-final punctuation that ends a cue (Latin + Urdu/Arabic).
_SENTENCE_END = (".", "?", "!", "…", "۔", "؟")


@dataclass
class CueOpts:
    max_words_per_cue: int = 7
    max_chars_per_line: int = 42
    max_lines: int = 2
    max_cue_duration: float = 6.0   # seconds
    max_gap: float = 0.8            # silence between words that forces a split
    split_on_sentence_end: bool = True
    word_mode: str = "line"         # "line" (cues) | "word" (one cue per word)


def _wrap(texts: list[str], max_chars: int) -> list[str]:
    """Greedy line wrap; a single over-long word keeps its own line."""
    lines: list[str] = []
    cur = ""
    for t in texts:
        if not cur:
            cur = t
        elif len(cur) + 1 + len(t) <= max_chars:
            cur += " " + t
        else:
            lines.append(cur)
            cur = t
    if cur:
        lines.append(cur)
    return lines


def _cue(index: int, words: list[dict], opts: CueOpts) -> dict:
    return {
        "index": index,
        "start": words[0]["start"],
        "end": words[-1]["end"],
        "text": "\n".join(_wrap([w["text"] for w in words], opts.max_chars_per_line)),
        # pill survives grouping (AE parity): the Content tab toggles it per
        # word, the overlay merges adjacent pill words into one background.
        "words": [{"text": w["text"], "start": w["start"], "end": w["end"],
                   "pill": bool(w.get("pill", False))}
                  for w in words],
    }


def build_cues(words: list[dict], opts: CueOpts) -> list[dict]:
    """Group words into caption cues. Pure + deterministic.

    A new cue starts when any cap would be exceeded by the next word
    (word count, wrapped line count, cue duration, inter-word gap) or after
    sentence-final punctuation.
    """
    normalized = []
    for w in words or []:
        txt = (w.get("text") or w.get("word") or "").strip()
        if txt:
            w_copy = dict(w)
            w_copy["text"] = txt
            normalized.append(w_copy)
    words = normalized
    if not words:
        return []

    if opts.word_mode == "word":
        return [_cue(i, [w], opts) for i, w in enumerate(words)]

    cues: list[dict] = []
    cur: list[dict] = []

    def flush() -> None:
        if cur:
            cues.append(_cue(len(cues), list(cur), opts))
            cur.clear()

    for w in words:
        if cur:
            gap = w["start"] - cur[-1]["end"]
            too_many = len(cur) + 1 > opts.max_words_per_cue
            too_long = w["end"] - cur[0]["start"] > opts.max_cue_duration
            too_wide = len(_wrap([x["text"] for x in cur] + [w["text"]],
                                 opts.max_chars_per_line)) > opts.max_lines
            if too_many or too_long or too_wide or gap > opts.max_gap:
                flush()
        cur.append(w)
        if opts.split_on_sentence_end and w["text"].rstrip().endswith(_SENTENCE_END):
            flush()
    flush()
    return cues


def remap_kept_words_to_output(words: list[dict], max_gap: float = 0.35) -> list[dict]:
    """Map kept words from SOURCE time to OUTPUT-sequence time after the cut.

    The built sequence concatenates the kept spans, so each kept run slides
    left by the total removed before it. Spans follow
    ``review_service.words_to_cuts`` exactly: a kept word joins the current
    span only if it IMMEDIATELY follows the previous kept word (nothing cut
    in between) and the pause is within ``max_gap``. Merging across a cut
    word by time alone (the old rule) left every later caption late by the
    removed filler's length, accumulating through the video.
    """
    out: list[dict] = []
    cursor = 0.0          # output time where the current run begins
    run_start: float | None = None
    prev_end = 0.0
    prev_idx = -2
    for idx, w in enumerate(words):
        if not w.get("keep", True):
            continue
        if run_start is None:
            run_start = w["start"]
        elif idx != prev_idx + 1 or w["start"] - prev_end > max_gap:
            cursor += prev_end - run_start
            run_start = w["start"]
        out.append({**w,
                    "start": round(cursor + (w["start"] - run_start), 3),
                    "end": round(cursor + (w["end"] - run_start), 3)})
        prev_end = w["end"]
        prev_idx = idx
    return out
