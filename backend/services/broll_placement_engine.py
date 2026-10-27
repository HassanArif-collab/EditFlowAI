"""
EditFlow AI - B-Roll Placement Engine (High-Density Editorial & Concept-Aware Pacing)
Intelligently matches and places visual B-roll onto timeline Track V2 based on:
1. Editorial Pacing Presets (Dynamic/Viral, Editorial/Balanced, Story/Face-Focused).
2. Human-Centric Rhythm:
   - Speaker Face Anchor (establishing connection on Track V1).
   - Rapid, diverse micro-visual cutaway sequence on Track V2 (1.0s - 2.4s each).
   - Emotional Punchline Face Return on calls-to-action and climaxes.
3. Concept-Aware Multi-Clip Pool Utilization:
   - Recognizes spoken concepts (parking damage, car overflow, 77-car plan, campus/school, winter weather).
   - Utilizes ALL distinct raw clips available for that concept across the video rather than repeating the same one.
4. Strict Global Zero-Repetition:
   - Maximizes utilization of all 73+ raw footage clips in the project library.
5. Shot Cluster & Camera Variety Rotation:
   - Alternates wide, ground, vehicle, drone, and detail angles.
"""
from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from ..config import get_settings
from .script_assembly_service import AssembledCut, BrollPlacement
from .visual_library_service import VisualItem, visual_library_service

logger = logging.getLogger(__name__)

STOPWORDS = {
    "the", "a", "an", "is", "are", "was", "were", "and", "or", "to", "of", "in", "for",
    "on", "at", "by", "with", "from", "about", "into", "through", "during", "before",
    "after", "above", "below", "we", "our", "you", "your", "they", "their", "it", "its",
    "this", "that", "these", "those", "can", "will", "would", "should", "have", "has",
    "had", "cut", "clip", "video", "final", "raw", "data", "shot", "camera"
}

PACING_PRESETS: Dict[str, Dict[str, Any]] = {
    "dynamic": {
        "name": "Dynamic / Viral (Fast)",
        "min_visual_dur": 1.0,
        "max_visual_dur": 1.8,
        "target_visual_dur": 1.35,
        "face_anchor_dur": 0.8,
        "face_return_dur": 0.8,
        "min_cut_for_broll": 2.2,
        "max_visuals_per_cut": 5,
    },
    "editorial": {  # Default
        "name": "Editorial / Balanced (Default)",
        "min_visual_dur": 1.4,
        "max_visual_dur": 2.4,
        "target_visual_dur": 1.8,
        "face_anchor_dur": 1.0,
        "face_return_dur": 1.0,
        "min_cut_for_broll": 2.6,
        "max_visuals_per_cut": 4,
    },
    "talking_head": {
        "name": "Story / Face Focused",
        "min_visual_dur": 2.2,
        "max_visual_dur": 3.6,
        "target_visual_dur": 2.8,
        "face_anchor_dur": 1.4,
        "face_return_dur": 1.4,
        "min_cut_for_broll": 3.8,
        "max_visuals_per_cut": 2,
    },
}

TALKING_HEAD_STEMS: Set[str] = {
    "c1307 07", "c1308 08", "c1310 10", "c1311 11", "c1312 12", "c1313 13",
    "c1314 14", "c1316 16", "c1318 18", "c1319 19", "c1321 21", "c1325 25", "c1326 26",
    "video a1", "video b2", "video c3", "whatsapp video 2026-10-20 at 12.32.12 am",
    "video of problems in rahima", "video of problems in rahima.mp4"
}

CONCEPT_TAXONOMY: Dict[str, Dict[str, Any]] = {
    "ibadah_masjid_prayer": {
        "keywords": {
            "ibadah", "masjid", "prayer", "mosque", "worship", "worshippers", "musallis",
            "congregation", "prayers", "jum'ah", "jumuah", "friday", "allah", "sacred",
            "dua", "khutbah", "seeking", "sujood", "entering", "door", "sanctuary", "muslims",
            "worshipper", "musalli", "halal", "house of allah"
        },
        "preferred_categories": {"pure_broll", "still_graphic"},
    },
    "quran_madrasah_students": {
        "keywords": {
            "quran", "koran", "madrasa", "madrasah", "students", "children", "kids",
            "learn", "learning", "recite", "reciting", "recitation", "hifz", "halaqah",
            "teacher", "classes", "education", "books", "class", "youth", "studying"
        },
        "preferred_categories": {"pure_broll"},
    },
    "winter_elderly_dropoff": {
        "keywords": {
            "winter", "snow", "snowfall", "elder", "elders", "cold", "cane", "freeze",
            "freezing", "drop", "dropping", "drop-off", "slush", "shivering", "outside",
            "hardship", "cannot come inside", "turned away", "hits", "ice", "slippery"
        },
        "preferred_categories": {"pure_broll", "still_graphic"},
    },
    "parking_problem": {
        "keywords": {
            "parking", "lot", "ground", "broken", "damaged", "asphalt", "pothole",
            "potholes", "mud", "gravel", "condition", "situation", "destroy", "bad",
            "deteriorated", "unpaved", "ruts"
        },
        "preferred_categories": {"pure_broll", "still_graphic"},
    },
    "cars_overflow": {
        "keywords": {
            "cars", "car", "vehicles", "traffic", "grass", "driveway", "overflow",
            "accommodate", "parked", "park", "outside", "blocked", "line", "capacity", "15", "20"
        },
        "preferred_categories": {"pure_broll"},
    },
    "plan_77_spots": {
        "keywords": {
            "77", "plan", "extend", "blueprint", "expand", "spots", "layout", "solution",
            "future", "establish", "built", "diagram", "essential", "infrastructure",
            "sanctuary", "paved", "foundation", "sadaqah", "jariyah", "institution"
        },
        "preferred_categories": {"pure_broll", "still_graphic"},
    },
    "academy_campus": {
        "keywords": {
            "academy", "school", "campus", "hallway", "entrance", "walkway", "building",
            "institution", "office", "wudu", "purification"
        },
        "preferred_categories": {"pure_broll"},
    },
    "community_jumah": {
        "keywords": {
            "community", "gathering", "crowd", "people", "event", "fellowship", "unity"
        },
        "preferred_categories": {"pure_broll"},
    },
}

PUNCHLINE_KEYWORDS = {
    "donate", "donation", "help us", "support", "as soon as possible", "asap",
    "300,000", "$300k", "urgent", "urgently", "reach out", "winter hits",
    "cannot come inside", "contribute", "sadaqah", "jariya", "safe place",
    "safe environment", "essential infrastructure", "future"
}


class BrollPlacementEngine:
    """
    Intelligent multi-visual placement engine for Track V2 B-roll overlays.
    """

    @classmethod
    def place_broll_for_plan(
        cls,
        cuts: List[AssembledCut],
        aspect_ratio: str = "9:16",
        pacing_style: str = "editorial",
        max_density: float = 0.85,
        allow_ai_generated: bool = False,
    ) -> List[BrollPlacement]:
        """
        Generate high-density, concept-aware B-roll placements on Track V2 across assembled cuts.
        """
        placements: List[BrollPlacement] = []
        if not cuts:
            return placements

        # Resolve pacing preset
        pacing_key = pacing_style.lower() if pacing_style else "editorial"
        config = PACING_PRESETS.get(pacing_key, PACING_PRESETS["editorial"])

        # Retrieve available visual library items
        raw_candidates = visual_library_service.query_items(limit=300)
        if not raw_candidates:
            return placements

        # Filter to visual assets only (pure B-roll, demonstration, stills)
        # STRICT RULE: Talking heads / interview dialogue clips are NEVER eligible as B-roll overlays!
        eligible_items = [
            it for it in raw_candidates
            if it.get("category") in ("pure_broll", "demonstration_broll", "still_graphic")
            and it.get("stem", "").lower() not in TALKING_HEAD_STEMS
            and "video of problems" not in it.get("filename", "").lower()
            and it.get("category") != "talking_head"
            and not it.get("banned")
            and not (it.get("ai_generated") and not allow_ai_generated)
        ]
        if not eligible_items:
            eligible_items = [
                it for it in raw_candidates
                if it.get("stem", "").lower() not in TALKING_HEAD_STEMS
                and "video of problems" not in it.get("filename", "").lower()
                and it.get("category") != "talking_head"
            ]

        # Global sequence-wide state to guarantee zero repetition and variety
        used_stems_global: Set[str] = set()
        last_cluster: Optional[str] = None
        recent_used_stems: Set[str] = cls._load_recent_usage()
        total_cuts = len(cuts)

        for cut_idx, cut in enumerate(cuts):
            is_last_cut = (cut_idx == total_cuts - 1)
            # Reset cut B-roll tracking
            cut.has_broll_overlay = False
            cut.broll_name = None
            cut.broll_placements = []

            # 1. Subdivide cut into rhythmic micro-visual slots
            slots = cls._slice_cut_into_visual_slots(cut, is_last_cut, config)
            if not slots:
                continue

            cut_placed_names = []

            for slot in slots:
                # 2. Extract spoken text for this micro-slot
                clause_text = cls._get_clause_text_for_slot(cut, slot)
                cue_text = cut.marker_comment or ""
                concept = cls._detect_concept(clause_text, cue_text)

                # Tokenize clause
                search_text = f"{clause_text} {cue_text}".lower()
                tokens = [
                    w for w in re.findall(r"\b[a-zA-Z0-9_-]{3,}\b", search_text)
                    if w not in STOPWORDS
                ]

                # 3. Score all candidates with concept awareness & strict anti-repeat
                scored = []
                for it in eligible_items:
                    score = cls._score_candidate(
                        it, tokens, cue_text, clause_text, concept, aspect_ratio,
                        used_stems_global, last_cluster, recent_used_stems
                    )
                    if score > 0.0:
                        scored.append((score, it))

                # Fallback: if pool exhausted, allow unused items from wider library
                if not scored:
                    for it in eligible_items:
                        if it["stem"] not in used_stems_global:
                            fb_score = cls._score_candidate(
                                it, tokens, cue_text, clause_text, concept, aspect_ratio,
                                used_stems_global, last_cluster, recent_used_stems
                            )
                            scored.append((100.0 + fb_score, it))

                # If still nothing (whole library used!), pick highest quality clip
                if not scored:
                    scored = [(it.get("quality_score", 0), it) for it in eligible_items]

                scored.sort(key=lambda x: x[0], reverse=True)
                best_score, best_item = scored[0]

                # Mark stem as used globally to prevent any repetition!
                used_stems_global.add(best_item["stem"])
                last_cluster = cls._get_item_cluster(best_item)

                # 4. Extract Golden Section slice
                item_dur = float(best_item.get("duration", 5.0))
                is_still = best_item.get("file_type") == "image" or best_item.get("category") == "still_graphic"
                rec_in = float(best_item.get("recommended_in", 0.0))
                rec_out = float(best_item.get("recommended_out", min(rec_in + 4.0, item_dur)))
                slot_dur = slot["duration"]

                source_in = rec_in
                source_out = min(item_dur, rec_in + slot_dur) if not is_still else 5.0
                actual_dur = round(source_out - source_in, 2) if not is_still else slot_dur

                broll = BrollPlacement(
                    source_file=best_item["path"],
                    name=best_item["filename"],
                    track=1,  # Track V2
                    cut_index=cut.cut_index,
                    timeline_start=slot["timeline_start"],
                    timeline_end=slot["timeline_end"],
                    duration=actual_dur,
                    source_in=round(source_in, 2),
                    source_out=round(source_out, 2),
                    cluster=concept or best_item.get("category", "broll"),
                    visual_cue=clause_text[:40] or cue_text[:40],
                    is_still=is_still,
                    item_id=str(best_item.get("id") or ""),
                )
                placements.append(broll)
                cut.broll_placements.append(broll.to_dict())
                cut_placed_names.append(best_item["filename"])

            if cut.broll_placements:
                cut.has_broll_overlay = True
                cut.broll_name = " -> ".join(cut_placed_names[:2])
                if len(cut_placed_names) > 2:
                    cut.broll_name += f" (+{len(cut_placed_names)-2})"

        return placements

    @classmethod
    def place_broll_for_timeline_segments(
        cls,
        segments: List[Dict[str, Any]],
        aspect_ratio: str = "9:16",
        pacing_style: str = "editorial",
        target_track: int = 1,
    ) -> Tuple[List[BrollPlacement], List[AssembledCut]]:
        """
        Takes transcribed timeline segments (from an active Premiere Pro sequence)
        and computes rhythm-matched, concept-aware micro-visual placements for target_track (e.g. V2).
        Returns tuple of (placements, cuts_with_placements).
        """
        cuts: List[AssembledCut] = []
        for idx, seg in enumerate(segments):
            c_start = float(seg.get("start", 0.0))
            c_end = float(seg.get("end", c_start + 1.0))
            dur = max(0.1, c_end - c_start)
            text = seg.get("text", "")
            cue = seg.get("cue", "") or seg.get("visual_cue", "")
            speaker = seg.get("speaker", "Speaker")

            cut = AssembledCut(
                cut_index=idx + 1,
                beat_index=idx + 1,
                speaker=speaker,
                source_file=seg.get("source_file", ""),
                source_stem=seg.get("source_stem", ""),
                source_in=float(seg.get("in", 0.0)),
                source_out=float(seg.get("out", dur)),
                duration=round(dur, 2),
                timeline_start=round(c_start, 2),
                timeline_end=round(c_end, 2),
                quote=text,
                caption_text=text,
                marker_comment=cue,
            )
            cuts.append(cut)

        placements = cls.place_broll_for_plan(
            cuts=cuts,
            aspect_ratio=aspect_ratio,
            pacing_style=pacing_style,
        )

        if target_track != 1:
            for p in placements:
                p.track = target_track

        return placements, cuts

    @classmethod
    def _slice_cut_into_visual_slots(
        cls,
        cut: AssembledCut,
        is_last_cut: bool,
        config: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        """
        Subdivide a dialogue cut's duration into rhythmic micro-visual slots
        interleaved with speaker face anchor and face return windows.
        """
        cut_dur = cut.duration
        if cut_dur < config["min_cut_for_broll"]:
            return []

        # 1. Face Anchor at start of cut (establishes speaker on camera)
        anchor_dur = min(config["face_anchor_dur"], cut_dur * 0.3)

        # 2. Check if this cut has an emotional punchline / call-to-action
        quote_lower = (cut.quote or cut.caption_text or "").lower()
        has_punchline = is_last_cut or any(pk in quote_lower for pk in PUNCHLINE_KEYWORDS)
        return_dur = config["face_return_dur"] if has_punchline else 0.4
        return_dur = min(return_dur, cut_dur * 0.3)

        avail_window = round(cut_dur - anchor_dur - return_dur, 2)
        if avail_window < config["min_visual_dur"]:
            return []

        # 3. Determine number of micro-visual slots
        target_dur = config["target_visual_dur"]
        num_slots = max(1, round(avail_window / target_dur))
        num_slots = min(num_slots, config["max_visuals_per_cut"])

        slot_dur = round(avail_window / num_slots, 2)
        if slot_dur < config["min_visual_dur"] and num_slots > 1:
            num_slots -= 1
            slot_dur = round(avail_window / num_slots, 2)

        # 4. Generate timestamped slots relative to timeline
        slots = []
        curr_offset = anchor_dur
        for slot_idx in range(num_slots):
            actual_dur = slot_dur if slot_idx < num_slots - 1 else round(avail_window - (slot_dur * (num_slots - 1)), 2)
            tl_start = round(cut.timeline_start + curr_offset, 2)
            tl_end = round(tl_start + actual_dur, 2)

            slots.append({
                "slot_index": slot_idx,
                "timeline_start": tl_start,
                "timeline_end": tl_end,
                "duration": actual_dur,
                "cut_relative_start": curr_offset,
                "cut_relative_end": round(curr_offset + actual_dur, 2),
            })
            curr_offset += actual_dur

        return slots

    @classmethod
    def _get_clause_text_for_slot(cls, cut: AssembledCut, slot: Dict[str, Any]) -> str:
        """
        Extract the specific words spoken during this micro-visual slot.
        Uses transcript file if available, falling back to proportional quote slicing.
        """
        # Try transcript first
        tr_path = cut.transcript_file
        if tr_path and os.path.exists(tr_path):
            try:
                with open(tr_path, "r", encoding="utf-8", errors="ignore") as f:
                    data = json.load(f)
                segs = data.get("segments", [])
                slot_src_start = cut.source_in + slot["cut_relative_start"]
                slot_src_end = cut.source_in + slot["cut_relative_end"]

                matched_texts = []
                for s in segs:
                    s_st = float(s.get("start", 0))
                    s_en = float(s.get("end", 0))
                    if s_en >= slot_src_start and s_st <= slot_src_end:
                        matched_texts.append(s.get("text", "").strip())
                if matched_texts:
                    return " ".join(matched_texts)
            except Exception:
                pass

        # Fallback: slice quote text by sentences/clauses
        raw_quote = cut.quote or cut.caption_text or ""
        phrases = [p.strip() for p in re.split(r"[,;—–\.\n]+", raw_quote) if p.strip()]
        if not phrases:
            return raw_quote

        slot_idx = slot["slot_index"]
        if slot_idx < len(phrases):
            return phrases[slot_idx]
        return phrases[-1]

    @classmethod
    def _detect_concept(cls, text: str, cue_text: str = "") -> str:
        """Detect the semantic concept from speech and visual cues."""
        combined = f"{text} {cue_text}".lower()
        tokens = set(re.findall(r"\b[a-zA-Z0-9_-]+\b", combined))

        best_concept = "general"
        best_score = 0
        for c_name, c_data in CONCEPT_TAXONOMY.items():
            overlap = len(tokens.intersection(c_data["keywords"]))
            if overlap > best_score:
                best_score = overlap
                best_concept = c_name
        return best_concept

    @classmethod
    def _score_candidate(
        cls,
        item: Dict[str, Any],
        tokens: List[str],
        cue_text: str,
        clause_text: str,
        concept: str,
        target_aspect_ratio: str,
        used_stems_global: Set[str],
        last_cluster: Optional[str],
        recent_used_stems: Optional[Set[str]] = None,
    ) -> float:
        """Score a candidate clip with concept alignment, anti-repeat, and variety checks."""
        stem = item.get("stem", "")
        # Strict anti-repeat check: never reuse a stem in the same timeline!
        if stem in used_stems_global:
            return -100.0

        category = item.get("category", "")
        file_type = item.get("file_type", "")
        is_still = file_type == "image" or category == "still_graphic"

        score = 0.0

        # 1. Category baseline
        if category == "pure_broll":
            score += 4.0
        elif category == "demonstration_broll":
            score += 3.5
        elif is_still:
            score += 1.0
        elif category == "talking_head":
            score -= 3.0

        # 2. Concept match boost & semantic suppression
        tags = set([t.lower() for t in item.get("tags", [])])
        item_concepts = set(item.get("concepts") or [])
        item_setting = (item.get("setting") or "").lower()
        item_desc = (item.get("description") or "").lower()
        item_text = f"{stem} {item.get('filename', '')} {item_desc} {' '.join(tags)}".lower()

        if concept != "general":
            concept_kw = CONCEPT_TAXONOMY[concept]["keywords"]
            overlap = len(tags.intersection(concept_kw))
            if overlap > 0:
                score += 3.5
            if any(kw in item_text for kw in concept_kw):
                score += 2.0

            # Verified concept metadata match
            if concept in item_concepts:
                score += 5.0

            # Parking problem family semantic routing & strict suppression
            if concept in ("parking_problem", "cars_overflow", "winter_elderly_dropoff"):
                if item_concepts.intersection({"parking_problem", "cars_overflow"}):
                    score += 3.5
                # Negative penalty: NEVER place indoor rooms, office signs, kitchens, storage, or soccer on parking lines
                if item_setting in ("classroom", "kitchen", "storage", "sign", "office", "hallway", "lawn"):
                    score -= 20.0
                if "academy_campus" in item_concepts and not item_concepts.intersection({"parking_problem", "cars_overflow", "plan_77_spots"}):
                    score -= 20.0
                if any(bad_tag in tags for bad_tag in ("sign", "office", "classroom", "kitchen", "stove", "microwave", "soccer", "storage", "calligraphy")):
                    score -= 20.0

            # Ibadah & Quran madrasah semantic routing
            elif concept in ("ibadah_masjid_prayer", "quran_madrasah_students"):
                if item_concepts.intersection({"ibadah_masjid_prayer", "quran_madrasah_students"}):
                    score += 4.0

        # 3. Token overlap with clause speech
        for tok in tokens:
            if tok in tags:
                score += 2.5
            elif tok in item_text:
                score += 1.2

        # 4. Architectural Still Graphic Promotion (only if blueprint / 77 spots / plan mentioned)
        clause_clean = f"{clause_text} {cue_text}".lower()
        if is_still:
            if any(w in clause_clean for w in ["77", "blueprint", "plan", "layout", "architectural", "area built", "area broken"]):
                score += 5.0
            else:
                score -= 2.0  # Real video footage takes precedence over stills

        # 5. Aspect ratio alignment
        if item.get("aspect_ratio") == target_aspect_ratio:
            score += 1.5

        # 6. Visual quality bonus (normalized)
        raw_q = float(item.get("quality_score", 100.0))
        effective_q = min(raw_q, 550.0) if is_still else raw_q
        score += min(2.5, effective_q / 350.0)

        # 7. Shot cluster rotation penalty (forces angle & camera diversity)
        cluster = cls._get_item_cluster(item)
        if last_cluster and cluster == last_cluster:
            score -= 2.5

        # 8. Cross-sequence diversity penalty (encourages rotation across reels)
        if recent_used_stems and stem.lower() in recent_used_stems:
            score -= 1.8

        return score

    @classmethod
    def _get_history_file(cls) -> Path:
        data_dir = get_settings().DATA_DIR
        return data_dir / "visual_library" / "usage_history.json"

    @classmethod
    def _load_recent_usage(cls, max_reels: int = 2) -> Set[str]:
        hist_file = cls._get_history_file()
        if not hist_file.exists():
            return set()
        try:
            data = json.loads(hist_file.read_text(encoding="utf-8"))
            reels = data.get("recent_reels", [])
            recent = set()
            for r in reels[-max_reels:]:
                recent.update(s.lower() for s in r.get("stems", []))
            return recent
        except Exception:
            return set()

    @classmethod
    def _record_usage(cls, sequence_name: str, stems: List[str]):
        if not stems:
            return
        hist_file = cls._get_history_file()
        try:
            hist_file.parent.mkdir(parents=True, exist_ok=True)
            data = {}
            if hist_file.exists():
                data = json.loads(hist_file.read_text(encoding="utf-8"))
            reels = data.setdefault("recent_reels", [])
            reels.append({
                "sequence_name": sequence_name,
                "stems": list(set(stems))
            })
            if len(reels) > 20:
                reels = reels[-20:]
                data["recent_reels"] = reels
            hist_file.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except Exception:
            pass

    @classmethod
    def _get_item_cluster(cls, item: Dict[str, Any]) -> str:
        """Classify item into a visual camera cluster to prevent consecutive identical angles."""
        if item.get("file_type") == "image" or item.get("category") == "still_graphic":
            return "graphic"
        stem = item.get("stem", "").upper()
        m = re.search(r"C(\d{2})", stem)
        if m:
            return f"cam_{m.group(1)}"
        return "video_general"


# Global singleton
broll_placement_engine = BrollPlacementEngine()
