"""A8 — coverage-preserving (safe) LLM refine.

The +LLM measurement showed the LLM drops whole beats (loses content). A8 lets the
LLM tighten, but VETOES any cut of a segment that is unique content — a cut is
applied only when the segment is a fragment (`--`/short/bracketed) OR has a
semantically-similar still-kept neighbour (i.e. genuinely redundant). Runs A1's
embedding+token dedup first. Principled (don't drop unique content) — NOT tied to
the eval's beat definitions, so no Goodharting.
"""
from __future__ import annotations

from backend.services.review_service import (
    build_gemma_prompt, parse_gemma_decisions, _tokens, _strip_brackets, _is_bracketed_nonspeech,
)
from backend.routes.review import _suggest_max_tokens
from backend.services.provider_service import provider_service
from backend.services.embedding_service import embedding_service
from .a1_embed import a1_embed, _cos


def _fragmentish(text: str) -> bool:
    t = (text or "").strip()
    return "--" in t or _is_bracketed_nonspeech(t) or len(_tokens(_strip_brackets(t))) <= 2


async def _safe_refine(segments, script, cos_safe: float = 0.5):
    kept = [s for s in segments if s.decision == "keep"]
    if not kept:
        return segments
    embs = embedding_service.embed([s.text for s in kept])
    prompt = build_gemma_prompt(kept, script)
    raw = await provider_service.chat(
        messages=[{"role": "user", "content": prompt}], temperature=0.0,
        max_tokens=_suggest_max_tokens(len(kept)),
    )
    text = (raw or {}).get("response") or ""
    decisions = parse_gemma_decisions(text, {s.id for s in kept})
    for i, s in enumerate(kept):
        if s.id not in decisions or decisions[s.id][0]:
            continue  # LLM kept it
        reason = decisions[s.id][1]
        if _fragmentish(s.text):
            s.decision, s.reason = "cut", reason or "llm_fragment"
        else:
            redundant = any(
                j != i and kept[j].decision == "keep" and _cos(embs[i], embs[j]) >= cos_safe
                for j in range(len(kept))
            )
            if redundant:
                s.decision, s.reason = "cut", reason or "llm_redundant"
            # else VETO — unique content; keep it so we never drop a beat
    return segments


def a8_safe(segments, script, use_llm=False):
    a1_embed(segments, script, use_llm=False)   # embedding+token dedup first
    if use_llm:
        return _safe_refine(segments, script)
    return None
