"""Shared helpers for cut proposers (the LLM refine stage)."""
from __future__ import annotations

from backend.services.review_service import build_gemma_prompt, parse_gemma_decisions
from backend.routes.review import _suggest_max_tokens
from backend.services.provider_service import provider_service


async def _refine(segments, prompt_segments, script):
    """Send `prompt_segments` to the model; apply only KEEP→cut flips to whichever
    of `segments` the model named. Mutates `segments` in place."""
    mt = _suggest_max_tokens(len(prompt_segments))
    prompt = build_gemma_prompt(prompt_segments, script)
    raw = await provider_service.chat(
        messages=[{"role": "user", "content": prompt}], temperature=0.0, max_tokens=mt,
    )
    text = (raw or {}).get("response") or ""
    decisions = parse_gemma_decisions(text, {s.id for s in prompt_segments})
    for s in segments:
        if s.decision == "keep" and s.id in decisions and not decisions[s.id][0]:
            s.decision, s.reason = "cut", decisions[s.id][1] or "llm_off_script"
    return segments


async def llm_refine(segments, script, max_tokens=None):
    """Standard refine — the model sees ALL segments (exactly like /api/review/suggest)."""
    return await _refine(segments, segments, script)


async def llm_refine_kept_only(segments, script):
    """Focused refine — the model sees ONLY the still-kept segments. Smaller, less
    noisy input (the deterministic pass already removed the obvious junk), so the
    run-to-run variance should drop."""
    return await _refine(segments, [s for s in segments if s.decision == "keep"], script)
