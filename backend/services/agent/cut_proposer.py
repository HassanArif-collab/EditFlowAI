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
    from ...services.whisper_service import whisper_service, filter_junk_segments
    from ...services.take_segmenter import segment_into_takes
    from ...services.cut_planner import build_plan, Plan
    from ...services.plan_store import plan_store
    from ...services.provider_service import provider_service
    from ...models.schemas import TranscriptWord
    from ...services.match_validator import ValidatedMatch
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
            result, _junk = filter_junk_segments(result)
            transcripts[p] = result
        except Exception as e:
            logger.warning(f"Failed to get transcript for {p}: {e}")

    if not transcripts:
        raise ValueError("No transcripts available. Transcribe the clips first.")

    # 2. Segment into takes
    all_takes = []
    for path, tr in transcripts.items():
        try:
            takes = segment_into_takes(path, tr)
            all_takes.extend(takes)
        except Exception as e:
            logger.warning(f"Failed to segment takes for {path}: {e}")

    if not all_takes:
        raise ValueError("No takes could be extracted from the transcripts.")

    # 3. Build takes description for the LLM
    takes_desc = []
    for i, take in enumerate(all_takes):
        takes_desc.append({
            "take_index": i,
            "source_file": Path(take.source_file).name,
            "duration": round(take.duration, 1),
            "text_preview": take.text[:200] if take.text else "(no text)",
        })

    # 4. Ask the LLM to pick takes
    prompt_text = _build_selection_prompt(takes_desc, instruction, hint)
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

    # 5. Convert to ValidatedMatch objects
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
            confidence=0.7,
            rationale=sel.get("rationale", "LLM-selected take"),
        )
        vm = ValidatedMatch(matched=mb)
        validated.append(vm)

    # 6. Build word lookup
    word_lookup: Dict[str, List[TranscriptWord]] = {}
    for path, tr in transcripts.items():
        flat_words = []
        for seg in tr.segments:
            flat_words.extend(seg.words)
        word_lookup[path] = flat_words

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
    instruction: str,
    hint: Optional[str],
) -> str:
    """Build the LLM prompt for take selection."""
    takes_json = json.dumps(takes_desc[:50], indent=2)  # cap at 50 takes
    hint_section = f"\nAdditional hint: {hint}" if hint else ""

    return f"""You are an expert video editor. Below is a list of takes from video clips.

User's instruction: {instruction}{hint_section}

Select takes that form the best sequence. Skip false starts, hesitations, mumbled words, and repeated content. Prefer later takes when content is equivalent (they're usually more polished).

Takes:
{takes_json}

Return a JSON object with this exact format:
{{
  "selections": [
    {{"take_index": 0, "beat_text": "short description of this beat", "rationale": "why this take"}},
    {{"take_index": 2, "beat_text": "next beat description", "rationale": "why this take"}}
  ]
}}

Rules:
- Order selections by how they should appear in the final cut
- Each beat_text should be 5-15 words describing what's said
- Skip takes that are just false starts or dead air
- Aim for a coherent, flowing sequence
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
