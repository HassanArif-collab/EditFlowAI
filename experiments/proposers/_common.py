"""Shared helpers for cut proposers (the LLM refine stage)."""
from __future__ import annotations

from backend.services.review_service import build_gemma_prompt, parse_gemma_decisions
from backend.routes.review import _suggest_max_tokens
from backend.services.provider_service import provider_service


async def llm_refine(segments, script, max_tokens=None):
    """The standard LLM refine: it may only flip KEEP→cut (never resurrect a cut),
    exactly like /api/review/suggest. Mutates `segments` in place."""
    mt = max_tokens or _suggest_max_tokens(len(segments))
    prompt = build_gemma_prompt(segments, script)
    raw = await provider_service.chat(
        messages=[{"role": "user", "content": prompt}], temperature=0.0, max_tokens=mt,
    )
    text = (raw or {}).get("response") or ""
    decisions = parse_gemma_decisions(text, {s.id for s in segments})
    for s in segments:
        if s.decision == "keep" and s.id in decisions:
            keep, reason = decisions[s.id]
            if not keep:
                s.decision, s.reason = "cut", reason or "llm_off_script"
    return segments
