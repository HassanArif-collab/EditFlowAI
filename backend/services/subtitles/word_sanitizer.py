"""Word-timestamp sanitation for caption pipelines.

Transcription engines emit occasional garbage word times: overlaps,
zero/negative durations, and missing timestamps (WhisperX defaults
unalignable tokens — numbers, foreign words — to 0). Word-by-word caption
animation amplifies every one of these into a visible glitch, so every
word list leaving the backend passes through ``sanitize_words``.
"""
from __future__ import annotations

MIN_DUR = 0.02


def _num(v) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _text_of(w: dict) -> str:
    return str(w.get("word") or w.get("text") or "")


def sanitize_words(words: list[dict]) -> list[dict]:
    """Return a copy of ``words`` with monotonic, non-overlapping, minimum-
    duration timestamps. Missing/zero timestamps are interpolated between
    the nearest good neighbors proportionally to text length. Idempotent.

    Rules:
    - a word is "missing" when start/end are absent or None, or both are
      <= 0 while an earlier word already ended later (WhisperX 0-defaults)
    - leading missing words are snapped to just before the first good start
    - starts are non-decreasing; a word's end never crosses the next start
      (except the pathological case where that would leave < MIN_DUR)
    - zero/negative durations become MIN_DUR by shifting end, never start
    """
    if not words:
        return []

    out = [dict(w) for w in words]
    n = len(out)

    # ── Pass A: find missing words and interpolate them ──
    starts = [_num(w.get("start")) for w in out]
    ends = [_num(w.get("end")) for w in out]

    max_seen_end = 0.0
    missing = [False] * n
    for i in range(n):
        s, e = starts[i], ends[i]
        if s is None or e is None:
            missing[i] = True
        elif s <= 0 and e <= 0 and max_seen_end > 0:
            missing[i] = True
        else:
            max_seen_end = max(max_seen_end, e)

    i = 0
    while i < n:
        if not missing[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and missing[j + 1]:
            j += 1
        run = list(range(i, j + 1))
        left_end = ends[i - 1] if i > 0 else None      # anchor before run
        right_start = starts[j + 1] if j + 1 < n else None  # anchor after run

        if left_end is not None and right_start is not None and right_start > left_end:
            # Distribute the gap proportionally to text length.
            weights = [len(_text_of(out[k])) + 1 for k in run]
            total = float(sum(weights)) or 1.0
            span = right_start - left_end
            t = left_end
            for k, wt in zip(run, weights):
                dur = span * (wt / total)
                starts[k], ends[k] = t, t + dur
                t += dur
        elif right_start is not None:
            # Leading run: snap to just before the first good start.
            t = right_start
            for k in reversed(run):
                starts[k] = max(0.0, t - MIN_DUR)
                ends[k] = t
                t = starts[k]
        else:
            # Trailing run (or no anchors at all): sequential after left.
            t = left_end if left_end is not None else 0.0
            for k in run:
                starts[k], ends[k] = t, t + MIN_DUR
                t += MIN_DUR
        i = j + 1

    # ── Pass B: non-decreasing starts ──
    for k in range(1, n):
        if starts[k] < starts[k - 1]:
            starts[k] = starts[k - 1]

    # ── Pass C: overlap clamp + minimum duration (end moves, start never) ──
    for k in range(n):
        if ends[k] < starts[k] + MIN_DUR:
            ends[k] = starts[k] + MIN_DUR
        if k + 1 < n:
            nxt = starts[k + 1]
            # Clamp into the next word's start unless that would leave the
            # word shorter than MIN_DUR (then a tiny overlap is the lesser
            # evil — starts are never shifted).
            if nxt > starts[k]:
                ends[k] = min(ends[k], max(nxt, starts[k] + MIN_DUR))

    for k in range(n):
        out[k]["start"] = round(starts[k], 3)
        out[k]["end"] = round(ends[k], 3)
    return out
