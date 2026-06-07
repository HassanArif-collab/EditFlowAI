"""Baseline proposer = the current shipped pipeline (v2-simple-start HEAD):
deterministic classify (token-containment clustering + keep-last-clean + fragment
rule + non-speech guard) then the optional LLM refine."""
from __future__ import annotations

from backend.services.review_service import classify
from ._common import llm_refine


def baseline(segments, script, use_llm=False):
    classify(segments, script)
    if use_llm:
        return llm_refine(segments, script)   # coroutine — eval awaits it
    return None
