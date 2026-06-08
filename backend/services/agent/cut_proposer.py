"""
EditFlow Agent — Cut Proposer (transcript-only editing).

Builds an edit plan from transcripts WITHOUT a written script.
The LLM selects the best takes from the segmented transcripts.

This is the **only** new business logic in the agent rewrite.
It reuses existing infrastructure: take_segmenter, cut_planner,
plan_store, provider_service.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


# ── Retake detection helpers ──────────────────────────────────────────────


def _cosine_sim(a: List[float], b: List[float]) -> float:
    """Cosine similarity between two embedding vectors.  Returns 0 on empty input."""
    if not a or not b or len(a) != len(b):
        return 0.0
    import math
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


def _compute_retake_pairs(takes: List[Any], threshold: float = 0.60) -> List[Dict]:
    """Find pairs of takes whose embeddings are similar enough to be retakes.

    Returns a list of {"take_a": i, "take_b": j, "similarity": float} dicts
    with i < j.  Takes without an embedding are silently skipped.

    Threshold 0.60 (down from earlier 0.80) — verbal retakes of the same
    sentence with slightly different surface words land at 0.60-0.78 cosine.
    Empirically observed on Urdu rephrasings; 0.80 missed nearly all retakes.
    """
    pairs: List[Dict] = []
    n = len(takes)
    for i in range(n):
        ei = getattr(takes[i], "embedding", None) or []
        if not ei:
            continue
        for j in range(i + 1, n):
            ej = getattr(takes[j], "embedding", None) or []
            if not ej:
                continue
            sim = _cosine_sim(ei, ej)
            if sim >= threshold:
                pairs.append({
                    "take_a": i,
                    "take_b": j,
                    "similarity": round(sim, 3),
                })
    return pairs


def _cluster_retakes(pairs: List[Dict], num_takes: int) -> List[List[int]]:
    """Group retake pairs into transitive clusters.

    If pair (A,B) and pair (B,C) both exist, return a single cluster {A,B,C}
    so the LLM sees one decision per cluster ("pick one of these N retakes")
    rather than independent pairs.

    Returns a list of clusters, each cluster a sorted list of take indices
    with >= 2 members.  Takes not in any pair don't appear.
    """
    parent = list(range(num_takes))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x: int, y: int) -> None:
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[rx] = ry

    for p in pairs:
        union(int(p["take_a"]), int(p["take_b"]))

    buckets: Dict[int, List[int]] = {}
    seen = set()
    for p in pairs:
        for idx in (int(p["take_a"]), int(p["take_b"])):
            if idx in seen:
                continue
            seen.add(idx)
            root = find(idx)
            buckets.setdefault(root, []).append(idx)

    return [sorted(b) for b in buckets.values() if len(b) >= 2]


# Junk-take filter thresholds (drop before LLM sees them)
_MIN_TAKE_SEC = 3.0      # drop sub-3-second takes (usually trail-offs)
_MIN_TAKE_WORDS = 8      # drop takes with fewer than 8 spoken words
_MAX_FILLER_RATIO = 0.45  # drop takes that are mostly filler words

# Post-LLM dedup threshold — pairwise compare FINAL selections and drop
# duplicates that scored too low to cluster but are still effectively retakes.
_POSTHOC_DEDUP_THRESHOLD = 0.55

# Trailing-filler words that signal an "and that's it" closer the user
# usually doesn't want in the cut.  Compared against the last 1-3 words
# of the final selected take.
_TRAILING_FILLERS = frozenset({
    # English / common
    "okay", "ok", "yeah", "yep", "right", "alright", "so", "anyway",
    # Urdu / Hindi
    "haan", "haan ji", "ji", "bas", "theek", "theek hai",
    "हाँ", "हाँ जी", "जी", "बस", "ठीक", "ठीक है",
    "ہاں", "ہاں جی", "جی", "بس", "ٹھیک", "ٹھیک ہے",
})


def _enforce_cluster_constraint(
    selected: List[Dict],
    retake_clusters: List[List[int]],
    takes: List[Any],
) -> List[Dict]:
    """For each retake cluster, keep at most ONE of the LLM's selections.

    The small local LLM often ignores the 'pick exactly one per cluster' rule
    in the prompt.  This enforces it deterministically: if the LLM picked
    multiple takes from the same cluster, keep the one with the highest
    quality_score; if tied, the LATEST take_index (speakers improve on retry).

    Preserves the LLM's chosen order otherwise.
    """
    if not selected or not retake_clusters:
        return selected

    # Build a take_index → cluster_id map (None if not in any cluster)
    take_to_cluster: Dict[int, int] = {}
    for cluster_id, cluster in enumerate(retake_clusters):
        for idx in cluster:
            take_to_cluster[idx] = cluster_id

    # Pick the best take per cluster among LLM's selections
    cluster_winners: Dict[int, Dict] = {}  # cluster_id → selection dict
    standalone: List[Dict] = []  # selections not in any cluster
    for sel in selected:
        idx = int(sel.get("take_index", -1))
        cid = take_to_cluster.get(idx)
        if cid is None:
            standalone.append(sel)
            continue
        incumbent = cluster_winners.get(cid)
        if incumbent is None:
            cluster_winners[cid] = sel
            continue
        # Tie-break: higher quality_score wins; if equal, higher take_index
        cur_q = float((takes[idx].quality or {}).get("score", 0.0))
        inc_idx = int(incumbent["take_index"])
        inc_q = float((takes[inc_idx].quality or {}).get("score", 0.0))
        if cur_q > inc_q + 0.001 or (abs(cur_q - inc_q) <= 0.001 and idx > inc_idx):
            cluster_winners[cid] = sel

    # Reassemble in the LLM's original order; drop later duplicates from the same cluster
    seen_clusters: set = set()
    kept: List[Dict] = []
    for sel in selected:
        idx = int(sel.get("take_index", -1))
        cid = take_to_cluster.get(idx)
        if cid is None:
            kept.append(sel)
            continue
        if cid in seen_clusters:
            continue  # already kept a winner for this cluster
        seen_clusters.add(cid)
        kept.append(cluster_winners[cid])
    return kept


def _dedup_by_similarity(
    selected: List[Dict],
    takes: List[Any],
    threshold: float = _POSTHOC_DEDUP_THRESHOLD,
) -> List[Dict]:
    """Catch retakes that didn't cluster.

    Pairwise compares all final selections.  If any two have cosine
    similarity >= threshold (and weren't already in the same cluster),
    drop the one with lower quality_score.
    """
    if len(selected) < 2:
        return selected
    keep_mask = [True] * len(selected)
    for i in range(len(selected)):
        if not keep_mask[i]:
            continue
        ti = int(selected[i].get("take_index", -1))
        ei = getattr(takes[ti], "embedding", None) or []
        if not ei:
            continue
        for j in range(i + 1, len(selected)):
            if not keep_mask[j]:
                continue
            tj = int(selected[j].get("take_index", -1))
            ej = getattr(takes[tj], "embedding", None) or []
            if not ej:
                continue
            if _cosine_sim(ei, ej) >= threshold:
                # Drop the lower-quality one (ties → later take_index wins)
                qi = float((takes[ti].quality or {}).get("score", 0.0))
                qj = float((takes[tj].quality or {}).get("score", 0.0))
                if qj > qi + 0.001 or (abs(qi - qj) <= 0.001 and tj > ti):
                    keep_mask[i] = False
                    break  # i is dropped; move to next i
                else:
                    keep_mask[j] = False
    return [s for s, k in zip(selected, keep_mask) if k]


def _drop_trailing_filler(
    selected: List[Dict],
    takes: List[Any],
) -> List[Dict]:
    """If the LAST selected take is short and ends with an affirmation
    filler ("haan ji", "bas", "ok", etc.), drop it.

    Speakers often trail off into 'okay yeah that's all' which makes the
    final cut feel abrupt or low-effort.
    """
    if not selected:
        return selected
    last = selected[-1]
    idx = int(last.get("take_index", -1))
    if idx < 0 or idx >= len(takes):
        return selected
    take = takes[idx]
    duration = float(take.duration or 0.0)
    text = (take.text or "").strip().lower()
    if duration > 5.0:
        return selected
    # Check if the last 1-3 tokens are all filler
    tokens = text.split()[-3:]
    if not tokens:
        return selected
    # Drop if ALL trailing tokens are filler, OR text is JUST 2 words of filler
    if all(t in _TRAILING_FILLERS for t in tokens):
        return selected[:-1]
    if len(tokens) <= 2 and any(t in _TRAILING_FILLERS for t in tokens):
        return selected[:-1]
    return selected


async def propose_cuts(
    clip_paths: List[str],
    instruction: str,
    hint: Optional[str] = None,
) -> Any:
    """Build an edit plan from transcripts without a script.

    1. Pull transcripts (cache-hit expected)
    2. Segment into takes
    3. Ask the LLM to select the best takes
    4. Convert LLM output to ValidatedMatch objects
    5. Build plan via cut_planner
    6. Save to plan_store
    """
    from ...services.whisper_service import whisper_service
    from ...services.take_segmenter import segment_into_takes
    from ...services.cut_planner import build_plan, Plan
    from ...services.plan_store import plan_store
    from ...services.provider_service import provider_service
    from ...models.schemas import TranscriptWord
    from ...services.match_validator import ValidatedMatch, validate_and_fix
    from ..script_matcher import MatchedBeat

    # 1. Pull transcripts (cache-hit)
    transcripts: Dict[str, Any] = {}
    for p in clip_paths:
        try:
            result = await whisper_service.transcribe_fingerprinted(
                source_path=p,
                language=None,
                force=False,
            )
            # NOTE: we intentionally skip filter_junk_segments here.
            # That filter's avg_logprob_min=-1.0 threshold is calibrated
            # for English; for Urdu, Hindi, Arabic etc. the model produces
            # avg_logprob in -1.5..-0.5 even for correct transcriptions,
            # so the filter drops the majority of valid segments and leaves
            # only a few seconds of material.  The LLM take-selection step
            # below already skips false starts and mumbled content, and
            # validate_and_fix catches bad word indices — so the junk filter
            # is redundant in this path and actively harmful for non-English.
            transcripts[p] = result
            logger.info(
                f"propose_cuts: transcript for {Path(p).name}: "
                f"{len(result.segments)} segments, "
                f"{sum(len(s.words) for s in result.segments)} words, "
                f"language={result.language}"
            )
        except Exception as e:
            logger.warning(f"Failed to get transcript for {p}: {e}")

    if not transcripts:
        raise ValueError("No transcripts available. Transcribe the clips first.")

    # 2. Segment into takes
    all_takes = []
    for path, tr in transcripts.items():
        try:
            takes = segment_into_takes(path, tr, language=tr.language or "en")
            all_takes.extend(takes)
        except Exception as e:
            logger.warning(f"Failed to segment takes for {path}: {e}")

    if not all_takes:
        raise ValueError("No takes could be extracted from the transcripts.")

    logger.info(f"propose_cuts: {len(all_takes)} takes extracted from {len(transcripts)} clip(s)")

    # 3. Build takes description for the LLM — pre-filter junk takes so the
    # model isn't tempted to pick obvious fragments / trail-offs / fillers.
    takes_desc = []
    dropped: List[tuple] = []
    for i, take in enumerate(all_takes):
        q = take.quality or {}
        duration = float(take.duration or 0.0)
        word_count = int(take.word_count or 0)
        filler_ratio = float(q.get("filler_ratio", 0.0))

        if duration < _MIN_TAKE_SEC:
            dropped.append((i, f"too short ({duration:.1f}s)"))
            continue
        if word_count < _MIN_TAKE_WORDS:
            dropped.append((i, f"too few words ({word_count})"))
            continue
        if filler_ratio > _MAX_FILLER_RATIO:
            dropped.append((i, f"filler-heavy ({filler_ratio:.0%})"))
            continue

        full_text = (take.clean_text or take.text or "").strip()
        if len(full_text) > 1500:
            full_text = full_text[:1500] + "... [truncated]"
        takes_desc.append({
            "take_index": i,
            "source_file": Path(take.source_file).name,
            "source_start_sec": round(take.source_start, 1),
            "duration_sec": round(take.duration, 1),
            "text": full_text or "(no text)",
            "false_starts": q.get("false_starts", 0),
            "filler_ratio": round(filler_ratio, 2),
            "wpm": round(q.get("wpm", 0.0), 1),
            "quality_score": round(q.get("score", 0.0), 2),
        })

    if dropped:
        logger.info(
            f"propose_cuts: dropped {len(dropped)} junk take(s): "
            + "; ".join(f"#{i}={reason}" for i, reason in dropped[:10])
            + (f"; +{len(dropped) - 10} more" if len(dropped) > 10 else "")
        )

    # Compute retake similarity pairs across ALL takes (including dropped ones,
    # so a junk-filtered take can still cluster with a substantive retake of it).
    # Threshold 0.55 catches verbal rephrasings with different word orderings.
    similarity_pairs = _compute_retake_pairs(all_takes, threshold=0.55)
    retake_clusters = _cluster_retakes(similarity_pairs, len(all_takes))
    logger.info(
        f"propose_cuts: {len(similarity_pairs)} retake pair(s), "
        f"{len(retake_clusters)} cluster(s) of size >= 2 "
        f"across {len(all_takes)} takes (threshold 0.55)"
    )

    # 4. Ask the LLM to pick takes
    prompt_text = _build_selection_prompt(takes_desc, retake_clusters, instruction, hint)
    raw = await provider_service.chat(
        messages=[{"role": "user", "content": prompt_text}],
        temperature=0.0,
        max_tokens=1024,
    )

    raw_response = raw.get("response") or ""
    selected_takes = _parse_llm_selection(raw_response, len(all_takes))

    if not selected_takes:
        # Fallback: use all takes in order (basic sequential cut)
        logger.warning("LLM selection parsing failed, using all takes as fallback")
        selected_takes = [
            {"take_index": i, "beat_text": all_takes[i].text[:80] if all_takes[i].text else f"Take {i}"}
            for i in range(min(len(all_takes), 20))
        ]

    # ── Deterministic post-processing ─────────────────────────────────────
    # The small local Ollama LLM often ignores the "pick exactly ONE per
    # cluster" rule in the prompt.  Enforce it here in Python so retakes
    # cannot make it into the final cut regardless of LLM compliance.
    _pre_count = len(selected_takes)
    selected_takes = _enforce_cluster_constraint(
        selected_takes, retake_clusters, all_takes
    )
    selected_takes = _dedup_by_similarity(selected_takes, all_takes)
    selected_takes = _drop_trailing_filler(selected_takes, all_takes)
    if len(selected_takes) != _pre_count:
        logger.info(
            f"propose_cuts: post-LLM dedup reduced {_pre_count} → "
            f"{len(selected_takes)} selections "
            f"(cluster-enforce + similarity-dedup + trailing-filler)"
        )

    # 5. Build word lookup (needed before validation)
    word_lookup: Dict[str, List[TranscriptWord]] = {}
    for path, tr in transcripts.items():
        flat_words = []
        for seg in tr.segments:
            flat_words.extend(seg.words)
        word_lookup[path] = flat_words

    # 6. Convert to ValidatedMatch objects
    validated = []
    for beat_idx, sel in enumerate(selected_takes):
        take_idx = sel.get("take_index", beat_idx)
        if take_idx < 0 or take_idx >= len(all_takes):
            continue
        take = all_takes[take_idx]
        beat_text = sel.get("beat_text", take.text[:80] if take.text else f"Beat {beat_idx}")

        mb = MatchedBeat(
            beat_index=beat_idx,
            beat_text=beat_text,
            take=take,
            word_start_index=0,
            word_end_index=max(0, take.word_count - 1),
            word_start_text=take.text.split()[0] if take.text and take.text.split() else "",
            word_end_text=take.text.split()[-1] if take.text and take.text.split() else "",
            llm_score=0.7,
            confidence="high",
            rationale=sel.get("rationale", "LLM-selected take"),
        )
        # Validate + fix word indices (mirrors the edit.py pipeline)
        take_words = word_lookup.get(take.source_file, [])
        take_words_slice = take_words[take.word_offset:take.word_offset + take.word_count]
        vm = validate_and_fix(mb, take_words_slice)
        validated.append(vm)

    # 7. Determine engine
    engine = "faster_whisper"
    for _path, tr in transcripts.items():
        if getattr(tr, "engine", None):
            engine = tr.engine
            break

    # 8. Resolve matcher model
    try:
        matcher_model = provider_service._active_chat_model or "agent-propose"
    except Exception:
        matcher_model = "agent-propose"

    # 9. Build plan
    plan = build_plan(
        bin_reference="(transcript-only)",
        script=f"(generated from transcripts: {instruction})",
        user_hint=hint,
        matcher_model=matcher_model,
        validated_matches=validated,
        word_lookup=word_lookup,
        engine=engine,
        takes_qualities=None,
    )

    # 10. Save plan
    plan_store.save(plan)
    logger.info(f"Cut proposer: plan {plan.plan_id} saved with {len(plan.cuts)} cuts")

    return plan


def _build_selection_prompt(
    takes_desc: List[Dict],
    retake_clusters: List[List[int]],
    instruction: str,
    hint: Optional[str],
) -> str:
    """Build the LLM prompt for take selection.

    Passes full take text, per-take quality metrics, and a list of retake
    CLUSTERS (transitively merged similarity pairs).  Instructs the model to
    pick exactly ONE take per cluster and to prefer substance over short
    transitional phrases.
    """
    takes_json = json.dumps(takes_desc[:50], indent=2)
    clusters_json = json.dumps(retake_clusters[:30], indent=2)
    hint_section = f"\nAdditional hint: {hint}" if hint else ""

    return f"""You are an expert video editor selecting takes for the final cut.

User's instruction: {instruction}{hint_section}

You receive a list of TAKES (segments of spoken content) and a list of
RETAKE_CLUSTERS (groups of takes that say roughly the same thing).

Each take has:
  - text             : full transcribed words spoken
  - source_start_sec : when it starts within its source clip
  - duration_sec     : how long the take is
  - false_starts     : count of detected false starts (lower is better)
  - filler_ratio     : 0-1 fraction of fillers (lower is better)
  - wpm              : delivery pace
  - quality_score    : 0-1 overall (higher is better)

HARD RULES — follow strictly:

1. RETAKE CLUSTERS.  For EVERY cluster in retake_clusters, pick EXACTLY ONE
   take from that cluster — never two, never three.  Prefer the take with
   the HIGHEST take_index in the cluster (speakers usually improve on retry).
   If quality_score differs by more than 0.2 within a cluster, override and
   pick the higher quality_score.

2. SUBSTANCE OVER TRANSITIONS.  Prefer takes that express a FULL THOUGHT
   over short transitional phrases.  A 12-second take with a complete
   argument is almost always better than a 3-second take that just says
   "and then" or "so now".  Lean toward duration_sec >= 5.

3. SKIP FRAGMENTS.  Drop takes that read like trail-offs, false starts,
   or partial sentences cut off mid-thought.  Skip pure fillers / dead air.

4. CHRONOLOGICAL ORDER.  Output selections in ascending source_start_sec
   so the final cut plays as natural narrative flow.

5. DON'T PAD.  If only 3 takes are substantive, return 3, not 7.
   Padding with weak takes is the #1 reason cuts feel random.

TAKES:
{takes_json}

RETAKE_CLUSTERS (pick exactly ONE take from each cluster):
{clusters_json}

Return JSON in EXACTLY this format and nothing else:
{{
  "selections": [
    {{"take_index": <int>, "beat_text": "5-15 word English description", "rationale": "<one sentence>"}},
    ...
  ]
}}
"""


def _parse_llm_selection(raw_text: str, max_take_index: int) -> List[Dict]:
    """Parse the LLM's take selection response."""
    try:
        # Try to extract JSON
        import re
        json_match = re.search(r'\{[\s\S]*\}', raw_text)
        if not json_match:
            return []

        obj = json.loads(json_match.group())
        selections = obj.get("selections") or obj.get("takes") or []

        # Validate take indices
        valid = []
        for sel in selections:
            idx = sel.get("take_index", -1)
            if 0 <= idx < max_take_index:
                valid.append(sel)

        return valid
    except (json.JSONDecodeError, ValueError, TypeError) as e:
        logger.warning(f"Failed to parse LLM selection: {e}")
        return []
