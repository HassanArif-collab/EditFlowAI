"""cues[] → SRT text (pure, no I/O).

Exact format matters: comma milliseconds and zero-padded HH:MM:SS, or Premiere
silently misplaces/rejects cues on import.
"""
from __future__ import annotations


def _ts(seconds: float) -> str:
    ms = round(max(0.0, seconds) * 1000)
    h, rem = divmod(ms, 3600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def cues_to_srt(cues: list[dict]) -> str:
    out: list[str] = []
    n = 0
    for c in cues:
        text = (c.get("text") or "").strip()
        if not text:
            continue
        n += 1
        out.append(f"{n}\n{_ts(c['start'])} --> {_ts(c['end'])}\n{text}\n\n")
    return "".join(out)
