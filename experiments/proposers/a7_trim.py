"""A7 — deterministic false-start / redundant-messy-line trim on top of baseline.

Rationale: the baseline keeps some lines that contain a '--' self-interrupt or
lead with a [non-speech] aside. Those are fine to keep IF they're the only take
of their content, but usually a CLEAN take of the same content is also kept (the
messy one is then a redundant repeat). This pass cuts a messy kept line only when
a cleaner kept line already covers its words — so we never drop a unique beat.
"""
from __future__ import annotations

from backend.services.review_service import (
    classify, _tokens, _token_containment, _strip_brackets,
)
from ._common import llm_refine


def _is_messy(text: str) -> bool:
    t = (text or "")
    if "--" in t:
        return True
    # leads with a bracket cue and the spoken remainder is short
    stripped = _strip_brackets(t).strip()
    return t.lstrip().startswith(("[", "(", "{")) and len(_tokens(stripped)) <= 6


def a7_trim(segments, script, use_llm=False):
    classify(segments, script)
    kept = [s for s in segments if s.decision == "keep"]
    # "clean" = kept, no '--', not bracket-led
    clean = [s for s in kept if not _is_messy(s.text)]
    for s in kept:
        if not _is_messy(s.text):
            continue
        st = _tokens(_strip_brackets(s.text))
        if not st:
            s.decision, s.reason = "cut", "redundant_false_start"
            continue
        for t in clean:
            if t is s:
                continue
            if _token_containment(st, _tokens(t.text)) >= 0.55:
                s.decision, s.reason = "cut", "redundant_false_start"
                break
    if use_llm:
        return llm_refine(segments, script)
    return None
