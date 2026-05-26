"""
EditFlow AI - Script Matcher

For each script beat, pick the best take AND name the exact word indices
for the in/out points. Uses embedding-based top-K recall followed by
LLM re-ranking with thinking mode.

Enhanced (v2) with:
  - [[beat]] bracket syntax for explicit beat boundaries
  - beat_kind heuristic (intro / body / outro / transition)
  - top-5 alternates from embedding recall
  - confidence level from llm_score
  - decisions audit trail
  - token cost estimation
  - persistent disk cache for LLM responses
  - model_revision in cache key

MVP Task M5.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from ..models.schemas import TranscriptWord
from .embedding_service import embedding_service
from .take_segmenter import Take

logger = logging.getLogger(__name__)

# ── Beat parsing ──

_BEAT_SPLIT = re.compile(
    # Split a script into beats on ANY of:
    #   1. End of sentence followed by an English capital letter — original
    #      English-only rule.  "Hello. World." → ["Hello.", "World."].
    #   2. Urdu / Arabic / Hindi end-of-sentence followed by whitespace —
    #      "۔" (U+06D4 Arabic Full Stop) or "।" (U+0964 Devanagari Danda),
    #      common in pasted non-English scripts.
    #   3. ANY newline (one or more) — script writers commonly put one line
    #      per beat without blank-line separators.  Was \n{2,} which required
    #      a BLANK line between beats; that excluded the natural one-line-per-
    #      beat format Urdu / Hindi scripts use and lumped every line into
    #      a single beat.  THAT bug surfaced as "1 cut from a 17-line script".
    r"(?<=[.!?])\s+(?=[A-Z])|(?<=[۔।])\s+|\n+",
    re.MULTILINE,
)
_BRACKET_BEAT = re.compile(r"\[\[(.+?)\]\]", re.DOTALL)


def parse_beats(script: str) -> list[str]:
    """Split a script into beats.

    Supports [[beat]] bracket syntax: if the script contains [[...]] markers,
    each [[text]] becomes its own beat and the remaining text is split by the
    existing regex.  Empty lines between beats are preserved as metadata
    (scene breaks) but don't create beats.

    Without brackets, falls back to the original logic: sentences separated by
    punctuation + space + capital, OR blank line.  Trailing whitespace
    stripped.  Empty beats dropped.
    """
    text = script.strip()
    if not text:
        return []

    # ── Check for [[beat]] bracket syntax ──
    bracket_matches = list(_BRACKET_BEAT.finditer(text))
    if bracket_matches:
        beats: list[str] = []

        # Extract the text between bracketed beats and split it normally
        prev_end = 0
        for m in bracket_matches:
            # Text between previous bracket and this one
            between = text[prev_end:m.start()]
            # Split the interstitial text with the normal regex
            if between.strip():
                interstitial = _BEAT_SPLIT.split(between.strip())
                beats.extend(b.strip() for b in interstitial if b.strip() and len(b.strip()) > 2)

            # The bracketed beat itself
            beat_text = m.group(1).strip()
            if beat_text and len(beat_text) > 2:
                beats.append(beat_text)

            prev_end = m.end()

        # Trailing text after last bracket
        trailing = text[prev_end:]
        if trailing.strip():
            trailing_beats = _BEAT_SPLIT.split(trailing.strip())
            beats.extend(b.strip() for b in trailing_beats if b.strip() and len(b.strip()) > 2)

        return beats

    # ── Original logic (no brackets) ──
    raw = _BEAT_SPLIT.split(text)
    return [b.strip() for b in raw if b.strip() and len(b.strip()) > 2]


# ── Match result ──


def _confidence_from_score(llm_score: float) -> str:
    """Map llm_score to a confidence label."""
    if llm_score >= 0.7:
        return "high"
    if llm_score >= 0.5:
        return "medium"
    return "low"


def _beat_kind_heuristic(beat_index: int, beat_text: str, total_beats: int) -> str:
    """Simple heuristic for beat kind.

    - First beat → "intro"
    - Last beat → "outro"  (only if >1 beat)
    - Short beats (<5 words) → "transition"
    - Everything else → "body"
    """
    word_count = len(beat_text.split())
    if total_beats > 1 and beat_index == 0:
        return "intro"
    if total_beats > 1 and beat_index == total_beats - 1:
        return "outro"
    if word_count < 5:
        return "transition"
    return "body"


@dataclass
class MatchedBeat:
    beat_index: int
    beat_text: str
    take: Optional[Take] = None          # None if unmatched
    word_start_index: int = 0            # 0-based, within take's words
    word_start_text: str = ""
    word_end_index: int = 0
    word_end_text: str = ""
    llm_score: float = 0.0               # 0-1
    rationale: str = ""
    raw_llm_response: str = ""           # for debugging / cache key
    unmatched_reason: Optional[str] = None  # e.g. "no_recall", "llm_failed"
    # ── New fields (v2) ──
    beat_kind: str = "body"              # "intro", "body", "outro", "transition"
    confidence: str = "low"              # "high" (>=0.7), "medium" (0.5-0.7), "low" (<0.5)
    alternates: list[dict] = field(default_factory=list)
    # Each alternate: {"take_id": str, "embed_score": float, "rerank_score": float, "rationale": str}
    decisions: list[str] = field(default_factory=list)
    # Audit trail: e.g. "embed_recall_k=10", "selected_candidate=B", "score=0.91"


# ── Token cost estimation ──


def estimate_token_cost(script: str, take_count: int) -> dict:
    """Estimate token cost for matching a script against takes.

    Per the plan: ~700 tokens per beat (max 20 candidates × ~30 tokens each + beat).
    """
    beats = parse_beats(script)
    # Per the plan: ~700 tokens per beat (max 20 candidates × ~30 tokens each + beat)
    tokens_per_beat = min(700, 200 + take_count * 30)
    total_tokens = len(beats) * tokens_per_beat
    return {
        "beats": len(beats),
        "take_count": take_count,
        "estimated_tokens": total_tokens,
        "estimated_cost_cents": total_tokens * 0.00003,  # GPT-4o rate
    }


# ── LLM prompt templates ──

_SYSTEM_PROMPT = """\
You are an expert video editor selecting takes for a final cut.

You will be given ONE script beat and several candidate takes the speaker \
recorded. Each take is a continuous spoken phrase. For each take you receive:
- the source file and which take it was in source-file order (e.g. "take 3 of 5")
- the duration
- a tab-separated word list with timing and Whisper's confidence score

Your job:
1. Choose the take that BEST expresses the script beat's meaning. Tolerate \
paraphrase — match by intent, not by exact wording.
2. Inside that take, name the word index range you would cut. SKIP any \
restart, hesitation, throat clearing, or trailing-off. Pick the cleanest \
continuous span that expresses the beat.
3. Speakers usually warm up across takes. Among takes that express the \
meaning equally well, prefer the LATER take in source-file order.
4. If NO take expresses the beat well (all are off-topic or unintelligible), \
return chosen=null.
{USER_HINT_BLOCK}

Use the thinking block to reason through your choice. Then return JSON.

Return JSON exactly in this schema:
{{
  "thinking": "your reasoning here",
  "chosen": "A" | "B" | "C" | ... | null,
  "word_start_index": <integer, 0-based within the chosen take's word list>,
  "word_start_text": "<the actual text of the word at word_start_index>",
  "word_end_index": <integer, 0-based, inclusive>,
  "word_end_text": "<the actual text of the word at word_end_index>",
  "score": <number 0-1: how well the chosen take expresses the beat>,
  "rationale": "one short sentence",
  "skipped_at_head": <integer: words skipped before word_start_index>,
  "skipped_at_tail": <integer: words skipped after word_end_index>
}}\
"""


def _build_user_message(
    beat_text: str,
    candidates: list[tuple[str, Take, list[TranscriptWord]]],
    language_hint: Optional[str],
) -> str:
    """Build the user message for the LLM with candidate takes in tab format."""
    lang_str = language_hint if language_hint else "auto-detect"

    lines = [
        f'SCRIPT BEAT:\n"{beat_text}"\n',
        f"LANGUAGE: {lang_str}\n",
        "CANDIDATE TAKES:\n",
    ]

    labels = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    for i, (label, take, words) in enumerate(candidates):
        tag = labels[i % len(labels)]
        # Count total takes from same source file
        lines.append(
            f"[{tag}] from {take.source_file} — "
            f"take {take.take_index + 1} — {take.duration:.1f} s"
        )
        lines.append("idx\tword\tstart\tend\tprob")
        for wi, w in enumerate(words):
            lines.append(f"{wi}\t{w.word}\t{w.start:.2f}\t{w.end:.2f}\t{w.probability:.2f}")
        lines.append("")

    return "\n".join(lines)


def _parse_response(raw: str) -> dict:
    """Parse the LLM response, stripping ```json fences if present."""
    text = raw.strip()
    # Strip code fences
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*\n?", "", text)
        text = re.sub(r"\n?```\s*$", "", text)
    try:
        return json.loads(text.strip())
    except json.JSONDecodeError as e:
        raise ValueError(f"Failed to parse LLM response as JSON: {e}") from e


def _validate_indices(
    parsed: dict,
    candidate_take: Take,
    words: list[TranscriptWord],
) -> tuple[int, int, str | None]:
    """Validate word indices from the LLM response.

    Returns (validated_start, validated_end, error_or_None).

    On mismatch between word_start_text and words[word_start_index].word,
    search ±3 indices for the quoted text. If found, snap. If not found,
    return the LLM's index unchanged but emit a warning.
    """
    start_idx = parsed.get("word_start_index", 0)
    end_idx = parsed.get("word_end_index", 0)
    start_text = parsed.get("word_start_text", "")
    end_text = parsed.get("word_end_text", "")

    error: str | None = None

    # Snap start index if text doesn't match
    if start_idx < len(words) and start_text:
        if words[start_idx].word.lower() != start_text.lower():
            snapped = _find_word_in_range(words, start_text, start_idx, window=3)
            if snapped is not None:
                start_idx = snapped
            # else: keep LLM index, but note as warning

    # Snap end index if text doesn't match
    if end_idx < len(words) and end_text:
        if words[end_idx].word.lower() != end_text.lower():
            snapped = _find_word_in_range(words, end_text, end_idx, window=3)
            if snapped is not None:
                end_idx = snapped

    # Check reversed range
    if end_idx < start_idx:
        start_idx, end_idx = end_idx, start_idx
        error = "swapped_indices"

    # Check duration bounds
    if start_idx < len(words) and end_idx < len(words):
        dur = words[end_idx].end - words[start_idx].start
        if dur < 1.0:
            error = "too_short"
        elif dur > 60.0:
            error = "too_long"

    # Clamp to word list bounds
    start_idx = max(0, min(start_idx, len(words) - 1))
    end_idx = max(0, min(end_idx, len(words) - 1))

    return start_idx, end_idx, error


def _find_word_in_range(
    words: list[TranscriptWord],
    target_text: str,
    center: int,
    window: int = 3,
) -> Optional[int]:
    """Search ±window indices from center for a word matching target_text."""
    target_lower = target_text.lower()
    for offset in range(-window, window + 1):
        idx = center + offset
        if 0 <= idx < len(words):
            if words[idx].word.lower() == target_lower:
                return idx
    return None


# ── Persistent LLM response cache ──

_llm_cache: dict[str, dict] = {}
_cache_dir: Optional[Path] = None


def _get_cache_dir() -> Path:
    """Return the cache directory for LLM responses, creating it if needed."""
    global _cache_dir
    if _cache_dir is not None:
        return _cache_dir
    # Use the project data directory
    _cache_dir = Path(__file__).parent.parent.parent / "data" / "llm_cache"
    _cache_dir.mkdir(parents=True, exist_ok=True)
    return _cache_dir


def _load_cache_from_disk() -> None:
    """Load all cached LLM responses from disk into memory."""
    global _llm_cache
    cache_dir = _get_cache_dir()
    if not cache_dir.exists():
        return
    count = 0
    for path in cache_dir.glob("*.json"):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            # The cache key is the filename stem
            cache_key = path.stem
            _llm_cache[cache_key] = data
            count += 1
        except Exception as e:
            logger.warning(f"Failed to load cache file {path}: {e}")
    if count:
        logger.info(f"Loaded {count} LLM cache entries from disk")


def _save_cache_to_disk(cache_key: str, data: dict) -> None:
    """Persist a single cache entry to disk."""
    try:
        cache_dir = _get_cache_dir()
        cache_path = cache_dir / f"{cache_key}.json"
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logger.warning(f"Failed to save cache entry {cache_key}: {e}")


# Load disk cache on module import
try:
    _load_cache_from_disk()
except Exception:
    pass  # Non-fatal — in-memory cache will still work


def _cache_key(prompt: str, model: str, model_revision: str = "") -> str:
    """Generate a deterministic cache key for the LLM response.

    Includes model revision so a model update invalidates stale cache.
    """
    raw = f"{prompt}:{model}:{model_revision}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


# ── Main matching function ──


async def match_script_to_takes(
    script: str,
    takes: list[Take],
    *,
    word_lookup: dict[str, list[TranscriptWord]],
    language_hint: Optional[str] = None,
    user_hint: Optional[str] = None,
    matcher_model: Optional[str] = None,
    recall_k: int = 10,
    embed_threshold: float = 0.3,
) -> list[MatchedBeat]:
    """Match every script beat to a take with word-level in/out indices.

    ``word_lookup[source_file]`` is the flat list of TranscriptWord (already
    junk-filtered) for that source file — used to look up word.text when
    sending to the LLM and to verify quoted texts when the matcher returns.
    """
    from ..services.provider_service import provider_service

    beats = parse_beats(script)
    total_beats = len(beats)

    if not beats or not takes:
        return [
            MatchedBeat(
                beat_index=i,
                beat_text=b,
                beat_kind=_beat_kind_heuristic(i, b, total_beats),
                unmatched_reason="no_takes" if not takes else "empty_script",
                decisions=["no_takes" if not takes else "empty_script"],
            )
            for i, b in enumerate(beats)
        ]

    # Resolve model name and revision
    model_name = matcher_model
    if not model_name:
        model_name = provider_service._active_chat_model or ""
    model_revision = ""
    # Try to get model revision from provider_service if available
    try:
        if hasattr(provider_service, "_active_chat_provider") and provider_service._active_chat_provider:
            pid = provider_service._active_chat_provider
            provider = provider_service._providers.get(pid, {})
            # Some providers store model details with revision info
            model_revision = provider.get("model_revision", "")
            # Try to find revision in cached model list
            if not model_revision:
                cached_models = provider_service._model_cache.get(pid, [])
                for m in cached_models:
                    if m.get("id") == model_name or m.get("name") == model_name:
                        model_revision = m.get("revision", m.get("modified_at", ""))
                        break
    except Exception:
        pass  # Non-fatal — revision is best-effort for cache invalidation

    # Pre-compute take embeddings
    take_texts = [t.text for t in takes]
    try:
        import asyncio
        take_embeddings = await asyncio.to_thread(embedding_service.embed, take_texts)
    except Exception as e:
        logger.warning(f"Embedding failed, falling back to all-candidates: {e}")
        take_embeddings = None

    results: list[MatchedBeat] = []

    for beat_idx, beat_text in enumerate(beats):
        decisions: list[str] = []
        beat_kind = _beat_kind_heuristic(beat_idx, beat_text, total_beats)
        alternates: list[dict] = []

        # ── Step 1: Embedding recall ──
        candidates: list[tuple[str, Take, list[TranscriptWord]]] = []
        # We also keep the full top_hits for building alternates
        top_hits_full: list[tuple[int, float]] = []

        if take_embeddings is not None:
            try:
                import asyncio
                beat_emb = await asyncio.to_thread(embedding_service.embed, [beat_text])
                top_hits = embedding_service.top_k(beat_emb[0], take_embeddings, k=recall_k)
                top_hits_full = list(top_hits)

                decisions.append(f"embed_recall_k={recall_k}")
                decisions.append(f"embed_hits={len(top_hits)}")

                # Filter by embed_threshold
                for take_idx, score in top_hits:
                    if score >= embed_threshold:
                        take = takes[take_idx]
                        words = word_lookup.get(take.source_file, [])
                        # Extract just this take's words
                        take_words = words[take.word_offset:take.word_offset + take.word_count]
                        label = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[len(candidates) % 26]
                        candidates.append((label, take, take_words))

                decisions.append(f"candidates_after_threshold={len(candidates)}")
                decisions.append(f"embed_threshold={embed_threshold}")

                # ── Build top-5 alternates from embedding scores ──
                # Take the top 5 from embedding recall (regardless of threshold),
                # so the user can see what was close even if below threshold.
                for rank, (take_idx, embed_score) in enumerate(top_hits_full[:5]):
                    take = takes[take_idx]
                    alternates.append({
                        "take_id": take.take_id,
                        "embed_score": round(embed_score, 4),
                        "rerank_score": 0.0,  # Will be updated for the chosen one
                        "rationale": "",
                    })

            except Exception as e:
                logger.warning(f"Embedding recall failed for beat {beat_idx}: {e}")
                decisions.append(f"embed_recall_error={e}")

        # If no candidates from embeddings, try all takes
        if not candidates:
            # If we have embeddings but all were below threshold, mark as unmatched
            if take_embeddings is not None:
                decisions.append("no_recall")
                results.append(MatchedBeat(
                    beat_index=beat_idx,
                    beat_text=beat_text,
                    beat_kind=beat_kind,
                    unmatched_reason="no_recall",
                    decisions=decisions,
                    alternates=alternates,
                ))
                continue

            # No embeddings at all — use all takes as candidates (limited to recall_k)
            labels = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
            for i, take in enumerate(takes[:recall_k]):
                words = word_lookup.get(take.source_file, [])
                take_words = words[take.word_offset:take.word_offset + take.word_count]
                candidates.append((labels[i % 26], take, take_words))
                # Also add to alternates
                alternates.append({
                    "take_id": take.take_id,
                    "embed_score": 0.0,
                    "rerank_score": 0.0,
                    "rationale": "fallback_no_embeddings",
                })
            decisions.append(f"fallback_all_takes={len(candidates)}")

        if not candidates:
            decisions.append("no_candidates")
            results.append(MatchedBeat(
                beat_index=beat_idx,
                beat_text=beat_text,
                beat_kind=beat_kind,
                unmatched_reason="no_candidates",
                decisions=decisions,
                alternates=alternates,
            ))
            continue

        # ── Step 2: LLM re-rank ──
        # Build the user hint block
        hint_block = ""
        if user_hint:
            hint_block = f"\n5. Additional user hint: {user_hint}"

        system_prompt = _SYSTEM_PROMPT.replace("{USER_HINT_BLOCK}", hint_block)
        user_message = _build_user_message(beat_text, candidates, language_hint)

        # Check cache (with model_revision in key)
        ckey = _cache_key(system_prompt + user_message, model_name, model_revision)
        if ckey in _llm_cache:
            parsed = _llm_cache[ckey]
            decisions.append("cache_hit")
        else:
            try:
                messages = [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_message},
                ]
                resp = await provider_service.chat(
                    messages=messages,
                    model=model_name,
                    temperature=0.0,
                    max_tokens=2048,
                )
                raw_content = resp.get("response", "")
                if not raw_content:
                    decisions.append("llm_empty")
                    results.append(MatchedBeat(
                        beat_index=beat_idx,
                        beat_text=beat_text,
                        beat_kind=beat_kind,
                        unmatched_reason="llm_empty",
                        decisions=decisions,
                        alternates=alternates,
                    ))
                    continue

                parsed = _parse_response(raw_content)
                _llm_cache[ckey] = parsed
                # Persist to disk
                _save_cache_to_disk(ckey, parsed)
                decisions.append("llm_called")
            except Exception as e:
                logger.warning(f"LLM call failed for beat {beat_idx}: {e}")
                decisions.append(f"llm_failed={e}")
                results.append(MatchedBeat(
                    beat_index=beat_idx,
                    beat_text=beat_text,
                    beat_kind=beat_kind,
                    unmatched_reason="llm_failed",
                    decisions=decisions,
                    alternates=alternates,
                ))
                continue

        # ── Step 3: Process LLM response ──
        chosen_label = parsed.get("chosen")
        if chosen_label is None:
            # ── FALLBACK: deterministic token-overlap match ────────────────
            # The local LLM (small Ollama model) routinely returns "no match"
            # for Urdu/Hindi candidates that ARE perfect matches.  When the
            # user's script line is a verbatim quote from the transcript,
            # token overlap will catch it even when the LLM is too timid.
            #
            # Algorithm: tokenize beat + each candidate take, drop punctuation,
            # compute Jaccard overlap (intersection / union of word sets).
            # If any candidate has overlap >= 0.55, accept it.  Pick the
            # highest-scoring one.
            def _toks(s: str) -> set[str]:
                # Strip common Urdu/Hindi punctuation + ASCII punctuation
                tbl = str.maketrans({c: " " for c in ",.!?:;\"'()[]{}،۔।"})
                return {w for w in s.translate(tbl).split() if w}

            beat_toks = _toks(beat_text)
            best_overlap = 0.0
            best_take_idx = -1  # index into the FULL `takes` list

            # Search the ENTIRE takes list, not just the embedding-filtered
            # candidates.  The multilingual MiniLM embedding scores Urdu
            # takes below the 0.3 recall threshold even when they're a
            # verbatim match, so the correct take never makes it into the
            # LLM-candidate list.  The fallback's whole purpose is to catch
            # what embeddings missed — limiting it to the candidate list
            # was self-defeating.
            if beat_toks:
                for t_idx, t in enumerate(takes):
                    t_words = word_lookup.get(t.source_file, [])
                    t_words_slice = t_words[t.word_offset:t.word_offset + t.word_count]
                    cand_text = (
                        " ".join(w.word for w in t_words_slice)
                        if t_words_slice
                        else t.text
                    )
                    cand_toks = _toks(cand_text)
                    if not cand_toks:
                        continue
                    inter = beat_toks & cand_toks
                    union = beat_toks | cand_toks
                    jacc = len(inter) / len(union) if union else 0.0
                    coverage = len(inter) / len(beat_toks)
                    # Equal-weighted: a high-coverage match (most of the
                    # script line's words appear in the take) is as good as
                    # a high-Jaccard match.  Previously coverage was * 0.9
                    # which dropped legit verbatim matches below the bar.
                    score = max(jacc, coverage)
                    if score > best_overlap:
                        best_overlap = score
                        best_take_idx = t_idx

            # Threshold 0.50 because some script lines span take boundaries
            # (the take-segmenter may split a sentence on a long pause).
            # At 50% word coverage we're already confident this is the right
            # span — the matcher's word-level boundary search downstream
            # will tighten the in/out points within the chosen take.
            if best_take_idx >= 0 and best_overlap >= 0.50:
                # Inject the winning take into the candidate list so the
                # downstream code (which addresses candidates[chosen_idx])
                # finds it.  Use the next available letter label.
                fb_take = takes[best_take_idx]
                fb_words = word_lookup.get(fb_take.source_file, [])
                fb_words = fb_words[fb_take.word_offset:fb_take.word_offset + fb_take.word_count]
                fb_label_idx = len(candidates) % 26
                fb_label = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[fb_label_idx]
                candidates.append((fb_label, fb_take, fb_words))
                chosen_label = fb_label
                decisions.append(
                    f"llm_null_but_overlap_fallback={best_overlap:.2f} "
                    f"(searched all {len(takes)} takes, not just candidates)"
                )
                # Fix A (overlap-fallback-4): compute TIGHT word boundaries
                # within the chosen take instead of grabbing the whole take.
                # Previous behaviour set first_words/last_words from the take
                # edges; the validator then couldn't match the (absent) word
                # text and fell back to _fallback_range(take_words) which IS
                # the whole take.  That's why beat 10 in plan 719f6e64a9d6
                # became 13.3 seconds.
                #
                # Strategy: find the first and last word in fb_words whose
                # normalized token appears in beat_toks, then pad outward by
                # one word on each side (so the cut starts/ends naturally).
                fb_punct_tbl = str.maketrans({c: " " for c in ",.!?:;\"'()[]{}،۔।"})
                def _norm_word(w: str) -> str:
                    return w.translate(fb_punct_tbl).strip().lower()

                fb_first_idx = 0
                fb_last_idx = max(0, len(fb_words) - 1)
                if fb_words and beat_toks:
                    hits = [
                        i for i, w in enumerate(fb_words)
                        if _norm_word(w.word) in beat_toks
                    ]
                    if hits:
                        fb_first_idx = max(0, hits[0] - 1)
                        fb_last_idx = min(len(fb_words) - 1, hits[-1] + 1)

                fb_first = fb_words[fb_first_idx].word if fb_words else ""
                fb_last = fb_words[fb_last_idx].word if fb_words else ""
                parsed = {
                    "chosen": chosen_label,
                    "word_start_index": fb_first_idx,
                    "word_start_text": fb_first,
                    "word_end_index": fb_last_idx,
                    "word_end_text": fb_last,
                    # Legacy keys kept for any older consumer:
                    "first_words": fb_first,
                    "last_words": fb_last,
                    "score": round(best_overlap, 2),
                    "rationale": "token_overlap_fallback",
                }
                logger.info(
                    f"script_matcher beat {beat_idx}: LLM said null, recovered "
                    f"with token-overlap {best_overlap:.2f} → take "
                    f"{getattr(fb_take, 'take_id', '?')[:8]} "
                    f"({fb_take.source_start:.1f}s-{fb_take.source_end:.1f}s)"
                )
            else:
                decisions.append(
                    f"llm_null_choice (overlap_max={best_overlap:.2f}, no fallback)"
                )
                results.append(MatchedBeat(
                    beat_index=beat_idx,
                    beat_text=beat_text,
                    beat_kind=beat_kind,
                    unmatched_reason="llm_null_choice",
                    raw_llm_response=json.dumps(parsed),
                    decisions=decisions,
                    alternates=alternates,
                ))
                continue

        # Find the chosen candidate
        chosen_idx = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".index(chosen_label.upper()) if len(chosen_label) == 1 else -1
        if chosen_idx < 0 or chosen_idx >= len(candidates):
            decisions.append(f"llm_invalid_choice={chosen_label}")
            results.append(MatchedBeat(
                beat_index=beat_idx,
                beat_text=beat_text,
                beat_kind=beat_kind,
                unmatched_reason="llm_invalid_choice",
                raw_llm_response=json.dumps(parsed),
                decisions=decisions,
                alternates=alternates,
            ))
            continue

        _, take, take_words = candidates[chosen_idx]
        llm_score = parsed.get("score", 0.0)
        rationale = parsed.get("rationale", "")

        decisions.append(f"selected_candidate={chosen_label}")
        decisions.append(f"score={llm_score:.2f}")

        # Validate indices
        start_idx, end_idx, val_error = _validate_indices(parsed, take, take_words)
        if val_error:
            decisions.append(f"validation_warning={val_error}")
        else:
            # Fix C (overlap-fallback-4): pad narrow cuts outward to nearest
            # sentence boundary or natural pause.  The local LLM frequently
            # returns a word range that's tighter than the actual spoken
            # phrase ("انکم کو دس گنا" instead of "تو اب کیا کرتے ہیں کہ اب
            # ہم اپنی انکم کو دس گنا کر دیتے ہیں") which produces 1-2 second
            # cuts that start mid-sentence in the timeline.
            #
            # Bounded expansion: extend backwards while the previous word's
            # gap to current start is < 0.4s AND we've added < 0.5s of audio.
            # Same forward.  This prevents grabbing the whole take but does
            # round out cut starts/ends to natural breath points.
            try:
                _PAD_MAX_GAP_S = 0.4
                _PAD_MAX_ADD_S = 0.5
                orig_start = start_idx
                orig_end = end_idx
                # Extend backwards
                added = 0.0
                while start_idx > 0:
                    prev = take_words[start_idx - 1]
                    cur = take_words[start_idx]
                    gap = max(0.0, cur.start - prev.end)
                    if gap > _PAD_MAX_GAP_S:
                        break
                    extra = (cur.start - prev.start)
                    if added + extra > _PAD_MAX_ADD_S:
                        break
                    added += extra
                    start_idx -= 1
                # Extend forwards
                added = 0.0
                while end_idx < len(take_words) - 1:
                    cur = take_words[end_idx]
                    nxt = take_words[end_idx + 1]
                    gap = max(0.0, nxt.start - cur.end)
                    if gap > _PAD_MAX_GAP_S:
                        break
                    extra = (nxt.end - cur.end)
                    if added + extra > _PAD_MAX_ADD_S:
                        break
                    added += extra
                    end_idx += 1
                if start_idx != orig_start or end_idx != orig_end:
                    decisions.append(
                        f"padded_indices=({orig_start}->{start_idx},{orig_end}->{end_idx})"
                    )
            except Exception as _pad_exc:  # noqa: BLE001
                # Never let padding regress correctness — log + skip.
                logger.debug("Padding skipped for beat %d: %s", beat_idx, _pad_exc)
            decisions.append("validated_indices=True")

        # ── Update alternates: mark the chosen one with rerank_score ──
        for alt in alternates:
            if alt["take_id"] == take.take_id:
                alt["rerank_score"] = round(llm_score, 4)
                alt["rationale"] = rationale
                break

        # Compute confidence from llm_score
        confidence = _confidence_from_score(llm_score)
        decisions.append(f"confidence={confidence}")

        results.append(MatchedBeat(
            beat_index=beat_idx,
            beat_text=beat_text,
            take=take,
            word_start_index=start_idx,
            word_start_text=parsed.get("word_start_text", ""),
            word_end_index=end_idx,
            word_end_text=parsed.get("word_end_text", ""),
            llm_score=llm_score,
            rationale=rationale,
            raw_llm_response=json.dumps(parsed),
            beat_kind=beat_kind,
            confidence=confidence,
            alternates=alternates,
            decisions=decisions,
        ))

    return results
