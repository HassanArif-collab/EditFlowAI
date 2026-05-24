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


def _compute_retake_pairs(takes: List[Any], threshold: float = 0.80) -> List[Dict]:
    """Find pairs of takes whose embeddings are similar enough to be retakes.

    Returns a list of {"take_a": i, "take_b": j, "similarity": float} dicts
    with i < j.  Takes without an embedding are silently skipped.
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

    # 3. Build takes description for the LLM
    takes_desc = []
    for i, take in enumerate(all_takes):
        q = take.quality or {}
        # Prefer clean_text (fillers + false starts stripped) if available, but
        # cap to keep the prompt manageable for small local LLMs.
        full_text = (take.clean_text or take.text or "").strip()
        if len(full_text) > 1500:
            full_text = full_text[:1500] + "... [truncated]"
        takes_desc.append({
            "take_index": i,
            "source_file": Path(take.source_file).name,
            "source_start_sec": round(take.source_start, 1),
            "duration_sec": round(take.duration, 1),
            "text": full_text or "(no text)",
            # Quality signals from take_segmenter — empty dict if unavailable
            "false_starts": q.get("false_starts", 0),
            "filler_ratio": round(q.get("filler_ratio", 0.0), 2),
            "wpm": round(q.get("wpm", 0.0), 1),
            "quality_score": round(q.get("score", 0.0), 2),
        })

    # Compute cosine similarity between all take pairs using the eager embeddings
    # that take_segmenter already produced. Pairs with similarity >= 0.80 are
    # almost certainly retakes of the same content.
    similarity_pairs = _compute_retake_pairs(all_takes, threshold=0.80)
    logger.info(
        f"propose_cuts: {len(similarity_pairs)} retake pair(s) detected "
        f"(similarity >= 0.80) across {len(all_takes)} takes"
    )

    # 4. Ask the LLM to pick takes
    prompt_text = _build_selection_prompt(takes_desc, similarity_pairs, instruction, hint)
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
    similarity_pairs: List[Dict],
    instruction: str,
    hint: Optional[str],
) -> str:
    """Build the LLM prompt for take selection.

    Now passes full take text, per-take quality metrics, and a list of
    likely retake pairs (computed from embedding similarity).  The prompt
    instructs the model to prefer later/cleaner takes when a retake is
    detected, and to skip filler-heavy / false-start takes outright.
    """
    takes_json = json.dumps(takes_desc[:50], indent=2)  # cap at 50 takes
    sim_json = json.dumps(similarity_pairs[:80], indent=2)  # cap noise
    hint_section = f"\nAdditional hint: {hint}" if hint else ""

    return f"""You are an expert video editor.  Below is a list of takes from one or more video clips, with their full transcribed text and quality metrics.

User's instruction: {instruction}{hint_section}

For each take you see:
- text          : the full transcribed words spoken in that take
- source_start_sec : when this take starts within its source clip (seconds)
- duration_sec  : how long the take is
- false_starts  : count of detected false starts (lower is better)
- filler_ratio  : 0.0-1.0 fraction of filler words (lower is better)
- wpm           : words per minute of delivery (higher is usually more polished)
- quality_score : 0.0-1.0 overall quality (higher is better)

SOME TAKES ARE RETAKES OF THE SAME CONTENT.  The similarity_pairs list at the bottom shows pairs of takes whose embeddings are >= 0.80 cosine similar — those are almost certainly two attempts at the same line.

RULES — apply in order:
1. RETAKES: For each pair in similarity_pairs, NEVER include both takes.  Prefer the one with HIGHER take_index (speakers usually improve on retry).  If quality_score differs by more than 0.2, override and pick the higher quality_score.
2. QUALITY: Among non-retake takes covering distinct topics, prefer takes with low false_starts, low filler_ratio, and higher quality_score.
3. SKIP: Drop any take that is purely a false start ("matlab... nahin... aisa..."), dead air, or fillers only.
4. ORDER: Output selections in chronological order of source_start_sec, so the final cut plays as natural narrative.
5. LENGTH: Don't pad — if only 3 takes are good, return 3, not 7.

Takes:
{takes_json}

Similarity pairs (likely retakes, >= 0.80 cosine):
{sim_json}

Return a JSON object with this exact format:
{{
  "selections": [
    {{"take_index": 0, "beat_text": "short English description of this beat", "rationale": "why this take"}},
    {{"take_index": 3, "beat_text": "...", "rationale": "..."}}
  ]
}}

Each beat_text: 5-15 words, in English even if the source is non-English.
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
