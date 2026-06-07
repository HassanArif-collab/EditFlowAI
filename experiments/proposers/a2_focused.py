"""A2 — focused LLM refine. Deterministic classify, then the LLM sees ONLY the
kept segments (~18) instead of all 66. Smaller, cleaner input → less run-to-run
variance and faster. A1A2 also runs the embedding dedup first (A1 ∘ A2)."""
from __future__ import annotations

from backend.services.review_service import classify
from .a1_embed import a1_embed
from ._common import llm_refine_kept_only


def a2_focused(segments, script, use_llm=False):
    classify(segments, script)
    if use_llm:
        return llm_refine_kept_only(segments, script)
    return None


def a1a2(segments, script, use_llm=False):
    # embedding+token dedup (A1) produces the kept set; focused LLM (A2) refines it.
    a1_embed(segments, script, use_llm=False)
    if use_llm:
        return llm_refine_kept_only(segments, script)
    return None
