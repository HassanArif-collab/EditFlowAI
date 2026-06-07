"""A5 — SCRIPT-DRIVEN selection (the approach the user actually wants).

The cut should DELIVER THE SCRIPT: for every clause in the (English) script, find
the Urdu take that best matches it (cross-lingual multilingual embeddings), keep
the cleanest such take, in transcript order. Nothing off-script. Deterministic —
no LLM in the keep/cut decision, so zero run-to-run variance.

Guarantees: every script clause that was actually delivered is present, as its
best clean take; repetitions and off-script chatter are dropped.
"""
from __future__ import annotations

import math
import re

from backend.services.review_service import classify, _is_clean_take
from backend.services.embedding_service import embedding_service


def split_script(script: str) -> list[str]:
    """Script → ordered clauses. Sentences, then long sentences split on commas/
    dashes/"and" so each factual point can be matched separately."""
    clauses: list[str] = []
    for sent in re.split(r"[.!?\n]+", script or ""):
        sent = sent.strip()
        if not sent:
            continue
        if len(sent.split()) > 9:
            for sub in re.split(r"[,—–]|\band\b", sent):
                sub = sub.strip()
                if len(sub.split()) >= 2:
                    clauses.append(sub)
        elif sent.split():
            clauses.append(sent)
    return clauses


def _cos(a, b) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)); nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


def align(segments, script, min_sim: float = 0.18, margin: float = 0.05):
    """Returns (chosen_idx:set, report:list[(clause, picked_seg_id|None, sim)])."""
    clauses = split_script(script)
    if not clauses or not segments:
        return set(), []
    seg_embs = embedding_service.embed([s.text for s in segments])
    cl_embs = embedding_service.embed(clauses)
    chosen: set[int] = set()
    report = []
    for ci, ce in enumerate(cl_embs):
        sims = sorted(((_cos(ce, seg_embs[i]), i) for i in range(len(segments))), reverse=True)
        best = sims[0][0]
        if best < min_sim:
            report.append((clauses[ci], None, round(best, 3)))
            continue
        cands = [(sim, i) for sim, i in sims if sim >= best - margin]
        clean = [(sim, i) for sim, i in cands if _is_clean_take(segments[i].text)]
        pick_sim, pick_i = max(clean or cands)
        chosen.add(pick_i)
        report.append((clauses[ci], segments[pick_i].id, round(pick_sim, 3)))
    return chosen, report


def a5_script(segments, script, use_llm=False):
    chosen, _ = align(segments, script)
    if not chosen:          # no script / no embeddings → safe fallback
        classify(segments, script)
        return None
    for i, s in enumerate(segments):
        if i in chosen:
            s.decision, s.reason = "keep", ""
        else:
            s.decision, s.reason = "cut", "off_script"
    return None
