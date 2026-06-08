"""A5-CLEAN — script coverage (LLM match) + dedup + false-start removal.

Pipeline:
  1. LLM matches every script line to its take(s)  → full script coverage.
  2. embedding+token dedup over the kept set        → one take per line (kills the
     house/tax/growth/pool repeats the LLM left in).
  3. drop kept lines that are false starts ('--') / bracket-led when a clean
     sibling already covers them.
Silences are removed at RENDER time by trimming each take to its word boundaries.
"""
from __future__ import annotations

import math

from backend.services.review_service import (
    _tokens, _token_containment, _is_clean_take, _strip_brackets,
)
from backend.services.embedding_service import embedding_service
from .a5_llm_script import _run as _llm_match


def _cos(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)); nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


def _dedup(segments):
    kept = [s for s in segments if s.decision == "keep"]
    if len(kept) < 2:
        return
    embs = embedding_service.embed([s.text for s in kept])
    toks = [_tokens(s.text) for s in kept]
    n = len(kept); parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x

    for i in range(n):
        for j in range(i + 1, n):
            if _cos(embs[i], embs[j]) >= 0.5 and _token_containment(toks[i], toks[j]) >= 0.45:
                ri, rj = find(i), find(j)
                if ri != rj:
                    parent[max(ri, rj)] = min(ri, rj)
    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    for g in groups.values():
        if len(g) < 2:
            continue
        clean = [i for i in g if _is_clean_take(kept[i].text)]
        win = clean[-1] if clean else g[-1]
        for i in g:
            if i != win:
                kept[i].decision, kept[i].reason = "cut", "dup"


def _messy(text: str) -> bool:
    t = (text or "").strip()
    return "--" in t or t.startswith(("[", "-", "("))


def _trim_false_starts(segments):
    kept = [s for s in segments if s.decision == "keep"]
    clean = [s for s in kept if not _messy(s.text)]
    for s in kept:
        if not _messy(s.text):
            continue
        st = _tokens(_strip_brackets(s.text))
        if not st:
            s.decision, s.reason = "cut", "fragment"; continue
        for t in clean:
            if t is not s and _token_containment(st, _tokens(t.text)) >= 0.5:
                s.decision, s.reason = "cut", "redundant_false_start"; break


async def _run(segments, script):
    await _llm_match(segments, script)   # 1. script coverage
    _dedup(segments)                     # 2. one take per line
    _trim_false_starts(segments)         # 3. drop false starts


def a5_clean(segments, script, use_llm=True):
    return _run(segments, script)
