"""A1 — semantic dedup via multilingual sentence embeddings, on top of baseline.

The token-containment clustering misses rephrased retakes that share meaning but
few exact words (the 0.55-0.60 near-dups: the growth line, the pool/amenities
lines). This adds a second dedup pass over the KEPT segments using cosine
similarity of `paraphrase-multilingual-MiniLM-L12-v2` embeddings (multilingual →
works on Urdu). Within a semantic group, keep the last clean take, cut the rest.
"""
from __future__ import annotations

import math

from backend.services.review_service import classify, _is_clean_take, _tokens, _token_containment
from backend.services.embedding_service import embedding_service
from ._common import llm_refine


def _cos(a, b) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


def a1_embed(segments, script, use_llm=False, cos_thresh: float = 0.5, tok_thresh: float = 0.45):
    """COMBINED signal: a pair is the same take only if BOTH embedding cosine AND
    token containment are moderate. High cosine alone conflates related-but-distinct
    beats (they share vocabulary); the token gate blocks that."""
    classify(segments, script)
    kept = [s for s in segments if s.decision == "keep"]
    if len(kept) >= 2:
        embs = embedding_service.embed([s.text for s in kept])
        toks = [_tokens(s.text) for s in kept]
        n = len(kept)
        parent = list(range(n))

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for i in range(n):
            for j in range(i + 1, n):
                if _cos(embs[i], embs[j]) >= cos_thresh and _token_containment(toks[i], toks[j]) >= tok_thresh:
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
            win = clean[-1] if clean else g[-1]  # kept is time-ordered → last clean take
            for i in g:
                if i != win:
                    kept[i].decision, kept[i].reason = "cut", "semantic_dup"
    if use_llm:
        return llm_refine(segments, script)
    return None
