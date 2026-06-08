"""
EditFlow AI - Cut Planner

Turns validated matches into a final cut plan with timeline positions
and audio fade defaults.

MVP Task M7.  Phase 2: M11 (VAD-snap), M12 (frame snapping).
Phase 2+: engine-dependent snap, 23.976 fps, alternates, beat-repetition
guard, level warnings, enhanced EDL ops.
"""
from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from ..models.schemas import TranscriptWord
from .match_validator import ValidatedMatch
from .take_segmenter import Take

# ── Phase 2 constants ───────────────────────────────────────────────
_SILENCE_GAP_THRESHOLD_S = 0.3      # gap ≥ this between words = silence region
_FALLBACK_FADE_MS = 25              # longer fade when no silence to snap to

# Engine-dependent VAD snap windows (seconds)
_VAD_SNAP_WINDOWS: dict[str, float] = {
    "whisperx": 0.2,
    "stable_ts": 0.35,
    "faster_whisper": 0.5,
}

# Framerate quantum table (seconds per frame)
_FPS_QUANTA: dict[float, float] = {
    24.0:   1.0 / 24.0,            # 0.04167 s
    25.0:   0.04,                  # 0.04 s
    29.97:  1001.0 / 30000.0,      # ≈ 0.03337 s
    23.976: 1001.0 / 24000.0,      # ≈ 0.04171 s
}

logger = logging.getLogger(__name__)


@dataclass
class Cut:
    beat_index: int
    beat_text: str
    take_source_file: str
    source_in: float           # seconds — words[word_start_index].start
    source_out: float          # seconds — words[word_end_index].end
    duration: float            # source_out - source_in
    timeline_position: float   # seconds — cumulative sum of previous cut durations
    audio_fade_in_ms: int = 15
    audio_fade_out_ms: int = 15
    rationale: str = ""
    warnings: list[str] = field(default_factory=list)
    fell_back_to_word_boundary: bool = False  # True when VAD snap didn't find silence
    take_id: str = ""                      # unique ID of the chosen take
    confidence: float = 0.0                # match confidence 0-1
    alternates: list[str] = field(default_factory=list)  # top-3 alternate take IDs


@dataclass
class Plan:
    plan_id: str               # uuid4 prefix
    created_at: str            # ISO timestamp
    bin_reference: str
    script: str
    user_hint: Optional[str]
    matcher_model: str
    cuts: list[Cut]
    gaps: list[dict]           # [{"after_beat": int, "reason": "unmatched", "beat_text": "..."}]
    summary: dict              # {"total_duration": s, "beats": n, "matched": n, "unmatched": n}
    level_warnings: list[dict] = field(default_factory=list)  # cross-take LUFS warnings

    def model_dump_json(self, indent: int = 2) -> str:
        """Serialize plan to JSON string."""
        import json
        from dataclasses import asdict
        return json.dumps(asdict(self), indent=indent, ensure_ascii=False, default=str)


# ── Normalization helper for beat-repetition guard ──────────────────

_PUNCT_RE = re.compile(r"[^\w\s]")


def _normalize_word(word: str) -> str:
    """Lowercase and strip punctuation for comparison."""
    return _PUNCT_RE.sub("", word).lower()


# ── Beat-repetition guard ──────────────────────────────────────────

_BEAT_REP_OVERLAP_MIN = 1     # minimum overlapping words to trigger warning
_BEAT_REP_GAP_MS = 500        # maximum gap in ms between adjacent cuts


def _check_beat_repetition(cuts: list[Cut]) -> None:
    """Compare adjacent cuts for word-level repetition.

    For each adjacent pair (cut N, cut N+1), compare the last 3 normalized
    words of cut N with the first 3 normalized words of cut N+1.  If the
    overlap is ≥ 1 word and the gap between cuts ≤ 500 ms, add a
    ``"beat_repetition_with_next"`` warning to cut N.
    """
    for i in range(len(cuts) - 1):
        cur = cuts[i]
        nxt = cuts[i + 1]

        # Compute gap between cuts on the timeline
        gap_ms = (nxt.timeline_position - (cur.timeline_position + cur.duration)) * 1000.0
        if gap_ms > _BEAT_REP_GAP_MS:
            continue

        # Extract and normalize words from beat text
        cur_words = [_normalize_word(w) for w in cur.beat_text.split()]
        nxt_words = [_normalize_word(w) for w in nxt.beat_text.split()]

        # Last 3 of current, first 3 of next
        cur_tail = [w for w in cur_words[-3:] if w]
        nxt_head = [w for w in nxt_words[:3] if w]

        if not cur_tail or not nxt_head:
            continue

        overlap = len(set(cur_tail) & set(nxt_head))
        if overlap >= _BEAT_REP_OVERLAP_MIN:
            cur.warnings.append("beat_repetition_with_next")
            logger.debug(
                "Beat-repetition guard: cut %d ↔ %d, overlap=%d words, gap=%.1f ms",
                cur.beat_index,
                nxt.beat_index,
                overlap,
                gap_ms,
            )


# ── Cross-take level warnings (placeholder) ────────────────────────

def check_level_warnings(plan: Plan, takes_qualities: dict) -> list[dict]:
    """Check adjacent cuts for LUFS level differences.

    Args:
        plan: The assembled Plan with cuts.
        takes_qualities: Dict mapping source_file → quality metadata,
            e.g. ``{"file.mp4": {"lufs": -14.2, ...}}``.

    Returns:
        A list of level warning dicts, each with:
        - ``between_beats``: [beat_index_N, beat_index_N+1]
        - ``lufs_diff_db``: absolute LUFS difference
        - ``remediation``: suggested fix
    """
    warnings: list[dict] = []
    if not takes_qualities:
        return warnings

    for i in range(len(plan.cuts) - 1):
        cur = plan.cuts[i]
        nxt = plan.cuts[i + 1]

        cur_lufs = takes_qualities.get(cur.take_source_file, {}).get("lufs")
        nxt_lufs = takes_qualities.get(nxt.take_source_file, {}).get("lufs")

        if cur_lufs is None or nxt_lufs is None:
            continue

        diff_db = abs(cur_lufs - nxt_lufs)
        if diff_db > 3.0:
            warnings.append({
                "between_beats": [cur.beat_index, nxt.beat_index],
                "lufs_diff_db": round(diff_db, 1),
                "remediation": "consider normalize",
            })
            logger.debug(
                "Level warning: beats %d ↔ %d, LUFS diff=%.1f dB",
                cur.beat_index,
                nxt.beat_index,
                diff_db,
            )

    return warnings


# ── Main plan builder ──────────────────────────────────────────────

def build_plan(
    *,
    bin_reference: str,
    script: str,
    user_hint: Optional[str],
    matcher_model: str,
    validated_matches: list[ValidatedMatch],
    word_lookup: dict[str, list[TranscriptWord]],
    engine: str = "faster_whisper",
    takes_qualities: dict | None = None,
) -> Plan:
    """Convert validated matches into a Plan.

    For each matched beat:
      - source_in = words[take.word_offset + word_start_index].start
      - source_out = words[take.word_offset + word_end_index].end
      - timeline_position = sum of previous cuts' durations
      - audio_fade_in_ms = 15, audio_fade_out_ms = 15

    For each unmatched beat, append to gaps with after_beat = the index
    of the last successfully matched beat (or -1 if none yet).
    """
    cuts: list[Cut] = []
    gaps: list[dict] = []
    timeline_cursor = 0.0
    last_matched_beat_index = -1

    for vm in validated_matches:
        mb = vm.matched

        if mb.take is None:
            # Unmatched beat
            gaps.append({
                "after_beat": last_matched_beat_index,
                "reason": mb.unmatched_reason or "unmatched",
                "beat_text": mb.beat_text,
            })
            continue

        # Look up the words for this take's source file
        all_words = word_lookup.get(mb.take.source_file, [])
        if not all_words:
            logger.warning(f"No words found for {mb.take.source_file}, skipping beat {mb.beat_index}")
            gaps.append({
                "after_beat": last_matched_beat_index,
                "reason": "no_words",
                "beat_text": mb.beat_text,
            })
            continue

        # Map take-local indices to global word list
        global_start = mb.take.word_offset + mb.word_start_index
        global_end = mb.take.word_offset + mb.word_end_index

        # Bounds check
        global_start = max(0, min(global_start, len(all_words) - 1))
        global_end = max(0, min(global_end, len(all_words) - 1))

        source_in = all_words[global_start].start
        source_out = all_words[global_end].end
        duration = source_out - source_in

        # Generate take_id and extract alternate take IDs
        take_id = f"{mb.take.source_file}::take_{mb.take.take_index}"

        cut = Cut(
            beat_index=mb.beat_index,
            beat_text=mb.beat_text,
            take_source_file=mb.take.source_file,
            source_in=round(source_in, 3),
            source_out=round(source_out, 3),
            duration=round(duration, 3),
            timeline_position=round(timeline_cursor, 3),
            audio_fade_in_ms=15,
            audio_fade_out_ms=15,
            rationale=mb.rationale,
            warnings=list(vm.warnings),  # copy so we can append later
            take_id=take_id,
            confidence=mb.llm_score,
        )
        cuts.append(cut)
        timeline_cursor += duration
        last_matched_beat_index = mb.beat_index

    # ── Phase 2 post-processing ────────────────────────────────────────
    plan = Plan(
        plan_id=uuid.uuid4().hex[:12],
        created_at=datetime.now(timezone.utc).isoformat(),
        bin_reference=bin_reference,
        script=script,
        user_hint=user_hint,
        matcher_model=matcher_model,
        cuts=cuts,
        gaps=gaps,
        summary={},  # filled after snapping
        level_warnings=[],  # filled after level check
    )

    # M11 — VAD-snap cut boundaries to silence midpoints (engine-dependent)
    vad_snap_cut_boundaries(plan, word_lookup, engine=engine)

    # M12 — Snap to frame boundaries
    snap_to_frame_boundaries(plan, fps=24.0)

    # Fix B (overlap-fallback-4): when two consecutive cuts come from the
    # same take and their source ranges overlap, the same audio plays twice
    # in the timeline.  Plan 719f6e64a9d6 had beat 10 (281.75-295.04) and
    # beat 11 (290.5-294.29) — beat 11 lay entirely inside beat 10.
    #
    # Resolution: clip the later cut's source_in up to the earlier cut's
    # source_out.  If that leaves the later cut shorter than 1 second, drop
    # it entirely and record it as a gap.
    _MIN_DURATION_S = 1.0
    _OVERLAP_EPS_S = 1.0 / 30.0  # one 30 fps frame of breathing room
    deduped: list[Cut] = []
    overlap_gaps: list[dict] = []
    for cut in plan.cuts:
        if deduped:
            prev = deduped[-1]
            if (
                prev.take_source_file == cut.take_source_file
                and prev.take_id == cut.take_id
                and cut.source_in < prev.source_out
            ):
                new_in = prev.source_out + _OVERLAP_EPS_S
                if cut.source_out - new_in >= _MIN_DURATION_S:
                    logger.info(
                        "Fix B: clipped overlapping cut at beat %d: "
                        "source_in %.3f -> %.3f (prev cut ended %.3f)",
                        cut.beat_index, cut.source_in, new_in, prev.source_out,
                    )
                    cut.source_in = round(new_in, 3)
                    cut.duration = round(cut.source_out - cut.source_in, 3)
                    cut.warnings = list(cut.warnings) + ["overlap_clipped"]
                else:
                    logger.info(
                        "Fix B: dropped overlapping cut at beat %d "
                        "(would be %.2fs after clip)",
                        cut.beat_index, cut.source_out - new_in,
                    )
                    overlap_gaps.append({
                        "after_beat": prev.beat_index,
                        "reason": "overlap_with_prev",
                        "beat_text": cut.beat_text,
                    })
                    continue
        deduped.append(cut)
    plan.cuts = deduped
    plan.gaps.extend(overlap_gaps)

    # Recompute durations & summary after snapping
    for cut in plan.cuts:
        cut.duration = round(cut.source_out - cut.source_in, 3)
    total_duration = sum(c.duration for c in plan.cuts)
    timeline_cursor = 0.0
    for cut in plan.cuts:
        cut.timeline_position = round(timeline_cursor, 3)
        timeline_cursor += cut.duration

    # Beat-repetition guard
    _check_beat_repetition(plan.cuts)

    # Cross-take level warnings
    if takes_qualities:
        plan.level_warnings = check_level_warnings(plan, takes_qualities)

    total_beats = len(validated_matches)
    matched = len(plan.cuts)
    unmatched = total_beats - matched
    low_confidence = sum(1 for c in plan.cuts if c.confidence < 0.5)
    plan.summary = {
        "total_duration": round(total_duration, 2),
        "beats": total_beats,
        "matched": matched,
        "unmatched": unmatched,
        "low_confidence": low_confidence,
        "estimated_apply_time_s": round(len(plan.cuts) * 0.1, 1),
    }

    return plan


# ── Phase 2: M11 — VAD-snap cut boundaries ────────────────────────────


def _find_silence_midpoints(words: list[TranscriptWord]) -> list[float]:
    """Return the midpoints of all silence regions (gaps ≥ threshold) in *words*."""
    midpoints: list[float] = []
    for i in range(len(words) - 1):
        gap = words[i + 1].start - words[i].end
        if gap >= _SILENCE_GAP_THRESHOLD_S:
            midpoints.append(words[i].end + gap / 2.0)
    return midpoints


def _snap_point(point: float, silence_midpoints: list[float], window: float) -> float | None:
    """Find the closest silence midpoint within ±window of *point*.

    Returns the midpoint if one is close enough, else ``None``.
    """
    best: float | None = None
    best_dist = window + 1.0
    for mid in silence_midpoints:
        dist = abs(mid - point)
        if dist <= window and dist < best_dist:
            best = mid
            best_dist = dist
    return best


def vad_snap_cut_boundaries(
    plan: Plan,
    word_lookup: dict[str, list[TranscriptWord]],
    engine: str = "faster_whisper",
) -> None:
    """Snap each cut's source_in / source_out to a silence midpoint if one
    exists within the engine-dependent VAD snap window.  If no silence region
    is found near a boundary, keep the word boundary and increase the fade to
    25 ms to mask the click.  Also sets ``fell_back_to_word_boundary = True``
    on the cut when a snap was not possible.

    Mutates *plan* in place.
    """
    snap_window = _VAD_SNAP_WINDOWS.get(engine, 0.5)

    # Pre-compute silence midpoints per source file (avoids re-scanning per cut)
    silence_cache: dict[str, list[float]] = {}

    for cut in plan.cuts:
        src = cut.take_source_file
        if src not in silence_cache:
            words = word_lookup.get(src, [])
            silence_cache[src] = _find_silence_midpoints(words) if words else []

        midpoints = silence_cache[src]

        # --- source_in ---
        snapped_in = _snap_point(cut.source_in, midpoints, snap_window)
        if snapped_in is not None:
            cut.source_in = round(snapped_in, 3)
        else:
            # No silence nearby — keep word boundary but use longer fade
            cut.audio_fade_in_ms = _FALLBACK_FADE_MS
            cut.fell_back_to_word_boundary = True

        # --- source_out ---
        snapped_out = _snap_point(cut.source_out, midpoints, snap_window)
        if snapped_out is not None:
            cut.source_out = round(snapped_out, 3)
        else:
            cut.audio_fade_out_ms = _FALLBACK_FADE_MS
            cut.fell_back_to_word_boundary = True

        logger.debug(
            "VAD-snap cut %d  in_snapped=%s  out_snapped=%s  fade_in=%d  fade_out=%d  engine=%s  window=%.2f",
            cut.beat_index,
            snapped_in is not None,
            snapped_out is not None,
            cut.audio_fade_in_ms,
            cut.audio_fade_out_ms,
            engine,
            snap_window,
        )


# ── Phase 2: M12 — Frame-accuracy snapping ────────────────────────────


def _round_to_frame(t: float, quantum: float) -> float:
    """Round a time value *t* to the nearest frame boundary given *quantum*
    (seconds per frame)."""
    if quantum <= 0:
        return t
    return round(round(t / quantum) * quantum, 6)


def snap_to_frame_boundaries(plan: Plan, fps: float = 24.0) -> None:
    """Round each cut's source_in, source_out, and timeline_position to the
    nearest frame boundary for the given *fps*.

    Supported framerates: 23.976, 24, 25, 29.97.  Unrecognised values fall
    back to 24 fps.  Mutates *plan* in place.
    """
    quantum = _FPS_QUANTA.get(fps, _FPS_QUANTA[24.0])

    for cut in plan.cuts:
        cut.source_in = _round_to_frame(cut.source_in, quantum)
        cut.source_out = _round_to_frame(cut.source_out, quantum)
        cut.timeline_position = _round_to_frame(cut.timeline_position, quantum)

    logger.debug("Frame-snapped plan to %.3f fps (quantum=%.6f s)", fps, quantum)


# ── EDL operation generation ──────────────────────────────────────────


def _confidence_marker_color(confidence: float) -> int:
    """Return a Premiere marker color index based on confidence.

    - green (8)  for confidence >= 0.7
    - yellow (7) for confidence >= 0.5
    - red (4)    for confidence < 0.5
    """
    if confidence >= 0.7:
        return 8  # green
    elif confidence >= 0.5:
        return 7  # yellow
    else:
        return 4  # red


def plan_to_edl_ops(plan: Plan, target_seq_name: str) -> list[dict]:
    """Convert a Plan to ExtendScript operations for processEDL.

    Returns a list of operation dicts that the CEP panel dispatches
    via ``evalExtendScript('processEDL', ...)``.

    Features:
      - ``beginUndoGroup`` / ``endUndoGroup`` wrapping all operations
      - ``_EditFlow Imports`` bin for source file imports
      - Per-cut markers with beat text, confidence, and color coding
      - A2 reserved audio track
    """
    ops: list[dict] = []

    # Begin undo group for single-undo in Premiere
    ops.append({"action": "beginUndoGroup", "name": f"EditFlow: {target_seq_name}"})

    # Create imports bin
    ops.append({"action": "ensure_bin", "bin_name": "_EditFlow Imports"})

    # Import all unique source files into the imports bin
    source_files = sorted({c.take_source_file for c in plan.cuts})
    for src in source_files:
        ops.append({
            "action": "import_file",
            "mediaPath": src,
            "bin_name": "_EditFlow Imports",
        })

    # Create output bin and sequence
    ops.append({"action": "ensure_bin", "bin_name": "EditFlow Output"})
    ops.append({
        "action": "create_sequence",
        "name": target_seq_name,
        "preset_from_clip_path": plan.cuts[0].take_source_file if plan.cuts else None,
    })

    # Add cuts — one op per cut using insertClip's 4-arg form
    # which places both video and audio simultaneously.
    #
    # Frame-align inPoint/outPoint to a 1/30-sec grid before emitting the op.
    # PPro snaps video to frame boundaries but audio to sample boundaries;
    # at non-frame-aligned source times this surfaces as the red sync-offset
    # badge between V and A tracks.  30fps is the iPhone default (the user's
    # IMG_*.MOV is iPhone footage) and the most common modern source rate.
    # Values aligned to 1/30 still land on valid frames at 60fps.
    _SOURCE_FPS = 30.0

    def _frame_align(seconds: float) -> float:
        return round(float(seconds) * _SOURCE_FPS) / _SOURCE_FPS

    for cut in plan.cuts:
        src_in_aligned = _frame_align(cut.source_in)
        src_out_aligned = _frame_align(cut.source_out)
        # Also frame-align the TIMELINE start position.  Was previously left
        # unaligned, which is what kept the red A/V sync badge alive even
        # after we aligned source in/out: V snapped to a frame on placement
        # but A snapped to a sample, so V and A drifted by one frame.
        start_aligned = _frame_align(cut.timeline_position)
        # Duration must also be a multiple of 1/fps to keep end-of-clip in sync.
        # We derive it from aligned in/out so it's always frame-quantised.
        duration_aligned = src_out_aligned - src_in_aligned
        ops.append({
            "action": "add",
            "mediaPath": cut.take_source_file,
            "video_track_index": 0,   # V1
            "audio_track_index": 0,   # A1
            "startTime": start_aligned,
            "inPoint": src_in_aligned,
            "outPoint": src_out_aligned,
            "endTime": start_aligned + duration_aligned,
            "audio_fade_in_ms": cut.audio_fade_in_ms,
            "audio_fade_out_ms": cut.audio_fade_out_ms,
        })

        # Per-cut marker with beat text, confidence, and color coding
        marker_color = _confidence_marker_color(cut.confidence)
        ops.append({
            "action": "add_marker",
            "time": cut.timeline_position,
            "name": f"Beat {cut.beat_index}: {cut.beat_text[:60]}",
            "color": marker_color,
            "comments": f"confidence={cut.confidence:.2f} take={cut.take_id}",
        })

    # Add red markers for unmatched beats
    for gap in plan.gaps:
        # Position the marker at the end of the last cut before this gap
        gap_time = 0.0
        after = gap.get("after_beat", -1)
        if after >= 0:
            for c in plan.cuts:
                if c.beat_index == after:
                    gap_time = c.timeline_position + c.duration
                    break

        ops.append({
            "action": "add_marker",
            "time": gap_time,
            "name": f"EditFlow UNMATCHED: {gap.get('beat_text', '')[:50]}",
            "color": 4,  # red
        })

    # Add level warning markers if present
    for lw in plan.level_warnings:
        beats = lw.get("between_beats", [])
        if len(beats) >= 2:
            # Place marker at the second beat's timeline position
            for c in plan.cuts:
                if c.beat_index == beats[1]:
                    ops.append({
                        "action": "add_marker",
                        "time": c.timeline_position,
                        "name": f"LEVEL WARNING: {lw.get('lufs_diff_db', 0):.1f}dB diff",
                        "color": 7,  # yellow
                        "comments": lw.get("remediation", ""),
                    })
                    break

    # End undo group
    ops.append({"action": "endUndoGroup"})

    return ops
