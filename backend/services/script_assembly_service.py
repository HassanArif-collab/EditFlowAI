"""
EditFlow AI - Script Assembly & Franken-Bite Compiler Service
Parses structured Markdown scripts (Scripts 01-46 from AI Workflow or freeform ads),
resolves real camera media via MediaResolver, performs sub-phrase word trimming
around ellipsis (...) skips, and compiles multi-track Premiere Pro assembly plans
with checkerboarded J-cuts, 108% scale punch-ins, and V2 B-roll cover.
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from .media_resolver import MediaItem, media_resolver

logger = logging.getLogger(__name__)


def parse_timecode_to_seconds(tc_str: str) -> float:
    """
    Parse a timecode string to float seconds.
    Supports formats:
      - "02:44" (MM:SS) -> 164.0
      - "01:12:30" (HH:MM:SS) -> 4350.0
      - "00:00:05:15" (HH:MM:SS:FF at 30fps) -> 5.5
      - "15s" or "15" -> 15.0
    """
    if not tc_str:
        return 0.0
    s = tc_str.strip().lower()
    # Strip trailing units e.g. "15s"
    s = re.sub(r"[s\s]+$", "", s)

    parts = s.split(":")
    try:
        if len(parts) == 1:
            return float(parts[0])
        elif len(parts) == 2:
            return float(parts[0]) * 60.0 + float(parts[1])
        elif len(parts) == 3:
            return float(parts[0]) * 3600.0 + float(parts[1]) * 60.0 + float(parts[2])
        elif len(parts) == 4:
            # HH:MM:SS:FF (assume 30fps)
            return float(parts[0]) * 3600.0 + float(parts[1]) * 60.0 + float(parts[2]) + float(parts[3]) / 30.0
    except ValueError:
        pass
    return 0.0


@dataclass
class ParsedBeat:
    """A single beat / scene parsed from a script."""
    index: int
    title: str = ""
    speaker: str = ""
    clip_stem: str = ""
    source_in: float = 0.0
    source_out: float = 0.0
    timeline_in: float = 0.0
    timeline_out: float = 0.0
    target_slot_duration: float = 0.0
    quote: str = ""
    caption: str = ""
    visual_cue: str = ""
    on_screen_cta: str = ""
    handoff_note: str = ""
    combine_mode: str = "MONTAGE"  # 'SEAMLESS' or 'MONTAGE'

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class MicroCutSlice:
    """A sub-phrase slice within a single take, trimmed around ellipses."""
    sub_index: int
    sub_text: str
    source_in: float
    source_out: float
    duration: float


@dataclass
class AssembledCut:
    """A concrete clip operation placed on the Premiere Pro timeline."""
    cut_index: int
    beat_index: int
    speaker: str
    source_file: str                # Real verified path on D:\
    source_stem: str
    source_in: float                # Seconds
    source_out: float               # Seconds
    duration: float                 # source_out - source_in
    timeline_start: float           # Placement time on sequence
    timeline_end: float
    video_track: int = 0            # 0 = V1 (0-based in ExtendScript)
    audio_track: int = 0            # 0 = A1, 1 = A2 (for checkerboarded J-cuts)
    audio_lead_frames: int = 0      # e.g. 4 for 4-frame J-cut lead
    audio_lead_sec: float = 0.0
    same_clip_splice: bool = False  # True if directly joined with prior take of same speaker
    scale_punch_in: float = 1.0     # 1.08 (108%) if same-clip splice to prevent jump cut
    quote: str = ""                 # Spoken script dialogue
    caption_text: str = ""
    speaker_badge: str = ""
    marker_name: str = ""
    marker_comment: str = ""
    enhanced_audio_file: Optional[str] = None
    transcript_file: Optional[str] = None
    has_broll_overlay: bool = False
    broll_name: Optional[str] = None
    broll_placements: List[Dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class BrollPlacement:
    """A B-roll cover clip placed on Track V2."""
    source_file: str
    name: str
    track: int = 1                  # 1 = V2 (0-based in ExtendScript)
    cut_index: Optional[int] = None
    timeline_start: float = 0.0
    timeline_end: float = 0.0
    source_in: float = 0.0
    source_out: float = 0.0
    duration: float = 0.0
    cluster: str = "general"
    visual_cue: str = ""
    is_still: bool = False
    item_id: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class AssembledScriptPlan:
    """Complete assembled multi-track rough cut plan ready for Premiere Pro."""
    script_id: str
    title: str
    target_duration: float
    aspect_ratio: str = "9:16"
    fps: float = 30.0
    width: int = 1080
    height: int = 1920
    combine_mode: str = "MONTAGE"
    cuts: List[AssembledCut] = field(default_factory=list)
    broll_clips: List[BrollPlacement] = field(default_factory=list)
    markers: List[Dict[str, Any]] = field(default_factory=list)
    captions: List[Dict[str, Any]] = field(default_factory=list)
    summary: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "script_id": self.script_id,
            "title": self.title,
            "target_duration": self.target_duration,
            "aspect_ratio": self.aspect_ratio,
            "fps": self.fps,
            "width": self.width,
            "height": self.height,
            "combine_mode": self.combine_mode,
            "cuts": [c.to_dict() for c in self.cuts],
            "broll_clips": [b.to_dict() for b in self.broll_clips],
            "markers": self.markers,
            "captions": self.captions,
            "summary": self.summary,
        }


class FrankenBiteTrimmer:
    """
    Sub-phrase word slicer.
    Extracts precision sub-clauses when a quote has ellipses (...) or when an 11s clip
    must be compressed into an 8s slot.
    """

    def __init__(self):
        self._cache: Dict[str, Any] = {}

    def trim_frankenbite(
        self,
        quote: str,
        gross_in: float,
        gross_out: float,
        transcript_path: Optional[str] = None,
        target_slot_sec: Optional[float] = None,
    ) -> List[MicroCutSlice]:
        """
        Split a quote with ellipses (...) into micro-cut time slices.
        Uses word-level or segment-level transcript timestamps if available,
        falling back to proportional sub-phrase interpolation.
        """
        gross_dur = gross_out - gross_in
        if gross_dur <= 0:
            gross_dur = target_slot_sec or 3.0
            gross_out = gross_in + gross_dur

        # 1. Clean and split quote on ellipsis / dash boundaries
        # e.g. "Caissons in the ground… earth retention up… first concrete poured."
        raw_phrases = re.split(r"[…]+|\.{3,}|--+|—+", quote)
        sub_phrases = [p.strip() for p in raw_phrases if p.strip() and len(p.strip()) > 2]

        if not sub_phrases:
            return [MicroCutSlice(0, quote.strip(), gross_in, gross_out, gross_dur)]

        # If only 1 phrase and no ellipses, return single cut
        if len(sub_phrases) == 1 and "…" not in quote and "..." not in quote:
            dur = min(gross_dur, target_slot_sec or gross_dur)
            return [MicroCutSlice(0, sub_phrases[0], gross_in, gross_in + dur, dur)]

        # If the gross duration already fits comfortably within the target slot,
        # it is a single curated continuous take (ellipses in the quote are merely descriptive).
        if gross_dur <= (target_slot_sec or 8.0) + 1.5:
            dur = min(gross_dur, target_slot_sec or gross_dur)
            return [MicroCutSlice(0, quote.strip(), gross_in, gross_in + dur, dur)]

        # 2. Try transcript-based word matching if transcript file is provided
        slices: List[MicroCutSlice] = []
        if transcript_path and os.path.exists(transcript_path):
            slices = self._align_with_transcript(sub_phrases, gross_in, gross_out, transcript_path)

        # 3. Fallback: proportional allocation within the gross window
        if not slices:
            slices = self._proportional_slices(sub_phrases, gross_in, gross_out, target_slot_sec)

        # 4. Strict Deduplication & Overlap Merge
        # A video edit must NEVER play the exact same video and audio clip back-to-back.
        # If segments overlap or repeat identical source timecodes, merge them into one continuous take.
        clean_slices: List[MicroCutSlice] = []
        for s in slices:
            if not clean_slices:
                clean_slices.append(s)
                continue
            prev = clean_slices[-1]
            if s.source_in < prev.source_out - 0.05:
                # Merge overlapping or duplicate slices into a single continuous take
                merged_in = min(prev.source_in, s.source_in)
                merged_out = max(prev.source_out, s.source_out)
                clean_slices[-1] = MicroCutSlice(
                    prev.slice_index,
                    prev.sub_text + " " + s.sub_text,
                    merged_in,
                    merged_out,
                    merged_out - merged_in,
                )
            else:
                clean_slices.append(s)

        return clean_slices

    def _align_with_transcript(
        self,
        sub_phrases: List[str],
        gross_in: float,
        gross_out: float,
        transcript_path: str,
    ) -> List[MicroCutSlice]:
        """Attempt word-level or segment-level alignment against a transcript JSON or SRT."""
        slices: List[MicroCutSlice] = []
        try:
            if transcript_path.endswith(".json"):
                with open(transcript_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                segments = data.get("segments", [])
                slices = self._match_segments(sub_phrases, gross_in, gross_out, segments)
            elif transcript_path.endswith(".srt"):
                # Parse basic SRT segments
                segments = self._parse_srt(transcript_path)
                slices = self._match_segments(sub_phrases, gross_in, gross_out, segments)
        except Exception as e:
            logger.debug(f"[frankenbite] Transcript alignment error: {e}")

        return slices

    def _match_segments(
        self,
        sub_phrases: List[str],
        gross_in: float,
        gross_out: float,
        segments: List[Dict[str, Any]],
    ) -> List[MicroCutSlice]:
        """Match sub-phrases across transcript segments in the gross window chronologically."""
        slices: List[MicroCutSlice] = []
        # Filter segments overlapping gross window
        active_segs = [s for s in segments if s.get("end", 0) >= gross_in - 2.0 and s.get("start", 0) <= gross_out + 2.0]
        if not active_segs:
            return []

        curr_time = gross_in
        last_matched_idx = -1

        for idx, phrase in enumerate(sub_phrases):
            norm_phrase = re.sub(r"[^\w\s]", "", phrase.lower()).strip()
            phrase_words = set(norm_phrase.split())
            if not phrase_words:
                continue

            best_seg = None
            best_seg_idx = -1
            best_overlap = 0

            # Search chronologically starting from the last matched segment index
            start_search_idx = max(0, last_matched_idx)
            for s_idx in range(start_search_idx, len(active_segs)):
                seg = active_segs[s_idx]
                seg_text = re.sub(r"[^\w\s]", "", seg.get("text", "").lower())
                seg_words = set(seg_text.split())
                overlap = len(phrase_words.intersection(seg_words))
                if overlap > best_overlap:
                    best_overlap = overlap
                    best_seg = seg
                    best_seg_idx = s_idx

            if best_seg and best_overlap >= 1:
                # If this phrase matched the same segment as the previous phrase,
                # do not emit a duplicate slice! Append phrase text to previous slice.
                if best_seg_idx == last_matched_idx and slices:
                    slices[-1].sub_text += " " + phrase
                    continue

                last_matched_idx = best_seg_idx
                seg_start = max(gross_in, float(best_seg.get("start", curr_time)))
                seg_end = min(gross_out, float(best_seg.get("end", seg_start + 2.5)))
                dur = seg_end - seg_start

                # If word tokens exist inside segment, refine further
                words = best_seg.get("words", [])
                if words:
                    w_start, w_end = self._refine_words(phrase_words, words)
                    if w_start is not None and w_end is not None:
                        seg_start = max(gross_in, w_start - 0.06)  # 60ms breath pad
                        seg_end = min(gross_out, w_end + 0.08)
                        dur = seg_end - seg_start

                slices.append(MicroCutSlice(idx, phrase, seg_start, seg_end, dur))
                curr_time = seg_end
            else:
                # Proportional fallback for this phrase
                dur = max(1.5, (gross_out - gross_in) / len(sub_phrases))
                slices.append(MicroCutSlice(idx, phrase, curr_time, min(gross_out, curr_time + dur), dur))
                curr_time += dur

        return slices

    def _refine_words(self, target_words: Set[str], words: List[Dict[str, Any]]) -> Tuple[Optional[float], Optional[float]]:
        """Refine start/end bounds from word-level objects."""
        matched_starts = []
        matched_ends = []
        for w in words:
            clean_w = re.sub(r"[^\w]", "", str(w.get("word", "")).lower())
            if clean_w in target_words:
                matched_starts.append(float(w.get("start", 0)))
                matched_ends.append(float(w.get("end", 0)))
        if matched_starts and matched_ends:
            return min(matched_starts), max(matched_ends)
        return None, None

    def _proportional_slices(
        self,
        sub_phrases: List[str],
        gross_in: float,
        gross_out: float,
        target_slot_sec: Optional[float],
    ) -> List[MicroCutSlice]:
        """Proportionally slice sub-phrases across the available duration."""
        slices: List[MicroCutSlice] = []
        n = len(sub_phrases)
        total_chars = sum(max(1, len(p)) for p in sub_phrases)

        # Target available duration
        available_dur = target_slot_sec if target_slot_sec and target_slot_sec < (gross_out - gross_in) else (gross_out - gross_in)
        curr_in = gross_in

        for idx, phrase in enumerate(sub_phrases):
            weight = max(1, len(phrase)) / total_chars
            phrase_dur = round(available_dur * weight, 2)
            phrase_dur = max(1.2, phrase_dur)  # Keep speech intelligible (minimum 1.2s per sub-phrase)
            sub_out = min(gross_out, curr_in + phrase_dur)
            slices.append(MicroCutSlice(idx, phrase, curr_in, sub_out, sub_out - curr_in))
            # Leave tiny 0.1s gap in source sampling if within gross window
            curr_in = min(gross_out, sub_out + 0.1)

        return slices

    def _parse_srt(self, srt_path: str) -> List[Dict[str, Any]]:
        """Quick SRT parser to extract segment text and timestamps."""
        segments: List[Dict[str, Any]] = []
        with open(srt_path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()

        blocks = re.split(r"\n\s*\n", content.strip())
        for block in blocks:
            lines = [l.strip() for l in block.splitlines() if l.strip()]
            if len(lines) >= 3:
                time_line = lines[1]
                text_line = " ".join(lines[2:])
                time_match = re.search(r"(\d+:\d+:\d+[,\.]\d+)\s*-->\s*(\d+:\d+:\d+[,\.]\d+)", time_line)
                if time_match:
                    t_in = self._srt_time_to_sec(time_match.group(1))
                    t_out = self._srt_time_to_sec(time_match.group(2))
                    segments.append({"start": t_in, "end": t_out, "text": text_line})
        return segments

    def _srt_time_to_sec(self, srt_tc: str) -> float:
        """Convert '00:01:23,456' to float seconds."""
        cleaned = srt_tc.replace(",", ".").strip()
        parts = cleaned.split(":")
        if len(parts) == 3:
            return float(parts[0]) * 3600.0 + float(parts[1]) * 60.0 + float(parts[2])
        return 0.0


class ScriptAssemblyService:
    """
    Parses Markdown scripts (CUT LIST tables & narrative beats) and generates
    concrete multi-track Premiere Pro assembly plans.
    """

    def __init__(self):
        self.frankenbite = FrankenBiteTrimmer()

    def parse_markdown_script(self, script_text: str) -> List[ParsedBeat]:
        """
        Parse a Markdown script into structured ParsedBeat objects.
        Supports:
          1. CUT LIST markdown tables (Scripts 01-46 in AI Workflow)
          2. Narrative CHAIN / SCENE blocks (e.g. 0:00–0:07 | CHAIN 1)
          3. Ultra-short ad scripts (e.g. [0:00 - 0:05] HOOK)
        """
        if not script_text or not script_text.strip():
            return []

        beats: List[ParsedBeat] = []

        # Strategy 1: Check for CUT LIST Markdown table
        table_beats = self._parse_cut_list_table(script_text)
        if table_beats:
            return table_beats

        # Strategy 2: Check for Narrative CHAIN / TIME blocks
        chain_beats = self._parse_chain_blocks(script_text)
        if chain_beats:
            return chain_beats

        # Strategy 3: Check for Ad scene blocks [0:00 - 0:05]
        ad_beats = self._parse_ad_blocks(script_text)
        if ad_beats:
            return ad_beats

        # Strategy 4: Fallback sentence / paragraph parser
        return self._parse_freeform_beats(script_text)

    def _parse_cut_list_table(self, text: str) -> List[ParsedBeat]:
        """Extract beats from a markdown table e.g. | # | Person | Source file | Cut IN -> OUT | ..."""
        lines = text.splitlines()
        in_table = False
        headers: List[str] = []
        beats: List[ParsedBeat] = []

        for line in lines:
            l = line.strip()
            if not l.startswith("|"):
                if in_table:
                    # End of table
                    break
                continue

            parts = [p.strip() for p in l.split("|")[1:-1]]
            if not parts:
                continue

            if any(h in parts[0].lower() for h in ["#", "cut", "index"]):
                headers = [h.lower() for h in parts]
                in_table = True
                continue

            if in_table and any(p.startswith("---") for p in parts):
                continue

            if in_table and len(parts) >= 4:
                # Map headers to indices
                col_map = {name: i for i, name in enumerate(headers)}

                idx_val = len(beats) + 1
                person_val = self._get_col(parts, col_map, ["person", "speaker", "cast"], default="Speaker")
                src_val = self._get_col(parts, col_map, ["source", "source file", "file"], default="")
                cut_val = self._get_col(parts, col_map, ["cut in", "cut in -> out", "cut", "in -> out"], default="")
                timeline_val = self._get_col(parts, col_map, ["timeline", "slot"], default="")
                yields_val = self._get_col(parts, col_map, ["yields", "duration"], default="")
                handoff_val = self._get_col(parts, col_map, ["handoff", "use as", "notes"], default="")

                # Parse timecodes
                src_in, src_out = self._extract_in_out(cut_val)
                tl_in, tl_out = self._extract_in_out(timeline_val)

                # Extract stem from source file (e.g. `Raw_Transcriptions\C5032.MP4` -> C5032)
                stem_match = re.search(r"(?i)\b(C\d{4}|DJI_\d{4}|[\w\s-]+?)\b", src_val)
                clip_stem = media_resolver.normalize_stem(src_val) if src_val else ""

                # 1. Check table columns for explicit dialogue quote in quotation marks (e.g. "every dollar...")
                quote = ""
                quote_match = re.search(r'["“](.+?)["”]', cut_val)
                if quote_match and len(quote_match.group(1).strip()) > 3:
                    quote = quote_match.group(1).strip()

                if not quote:
                    for col_val in parts:
                        col_q = re.search(r'["“](.+?)["”]', col_val)
                        if col_q and len(col_q.group(1).strip()) > 4:
                            q_candidate = col_q.group(1).strip()
                            if len(q_candidate.split()) >= 3:
                                quote = q_candidate
                                break

                # 2. If quote not in table, scan markdown body for Audio — [Speaker] (ClipStem...): > "..."
                if not quote and clip_stem:
                    mins = int(src_in) // 60
                    secs = int(src_in) % 60
                    tc_str = f"{mins:02d}:{secs:02d}"
                    body_m = None
                    if len(clip_stem) >= 3:
                        body_m = re.search(rf'(?i)Audio[^\n]*?\b{re.escape(clip_stem)}\b[^\n]*?{tc_str}[^\n]*?\n(?:\s*>\s*)?["“](.+?)["”]', text)
                        if not body_m:
                            body_m = re.search(rf'(?i)\b{re.escape(clip_stem)}\b[^\n]*?{tc_str}[^\n]*?\n(?:\s*>\s*)?["“](.+?)["”]', text)
                        if not body_m:
                            body_m = re.search(rf'(?i)Audio[^\n]*?\b{re.escape(clip_stem)}\b[^\n]*?\n(?:\s*>\s*)?["“](.+?)["”]', text)
                    if not body_m:
                        # Match by speaker and timecode
                        sp_clean = re.sub(r"[^\w\s]", "", person_val).strip().split()
                        sp_first = sp_clean[0] if sp_clean else ""
                        if sp_first:
                            body_m = re.search(rf'(?i)Audio[^\n]*?{sp_first}[^\n]*?{tc_str}[^\n]*?\n(?:\s*>\s*)?["“](.+?)["”]', text)

                    if body_m:
                        raw_q = body_m.group(1).strip()
                        phrases = [p.strip(" —\t\r\n") for p in re.split(r"—+|--+", raw_q) if len(p.strip()) > 3]
                        if len(phrases) > 1 and "b" in str(parts[0]).lower():
                            body_quote = phrases[1]
                        elif len(phrases) > 1 and "a" in str(parts[0]).lower():
                            body_quote = phrases[0]
                        else:
                            body_quote = raw_q
                        if body_quote:
                            quote = body_quote

                target_dur = (tl_out - tl_in) if tl_out > tl_in else parse_timecode_to_seconds(yields_val)

                beats.append(ParsedBeat(
                    index=idx_val,
                    title=f"Cut {idx_val} - {person_val}",
                    speaker=person_val,
                    clip_stem=clip_stem,
                    source_in=src_in,
                    source_out=src_out,
                    timeline_in=tl_in,
                    timeline_out=tl_out,
                    target_slot_duration=target_dur or (src_out - src_in),
                    quote=quote,
                    handoff_note=handoff_val,
                    combine_mode="MONTAGE" if "montage" in handoff_val.lower() else "SEAMLESS",
                ))

        return beats

    def _get_col(self, parts: List[str], col_map: Dict[str, int], candidates: List[str], default: str = "") -> str:
        """Find column value by checking candidate header names."""
        for c in candidates:
            for header, idx in col_map.items():
                if c in header and idx < len(parts):
                    return parts[idx]
        # Positional fallbacks
        return default

    def _extract_in_out(self, text: str) -> Tuple[float, float]:
        """Extract '00:40 -> 00:51' or '00:40–00:51' or '00:40 - 00:51' or '00:17.05 → 00:25.05'."""
        if not text:
            return 0.0, 0.0
        # Match two timecodes separated by arrow, dash, or hyphen (supporting decimals like .05)
        m = re.search(r"(\d+(?::\d+)+(?:\.\d+)?)\s*(?:->|→|–|-|to)\s*(\d+(?::\d+)+(?:\.\d+)?)", text)
        if m:
            t_in = parse_timecode_to_seconds(m.group(1))
            t_out = parse_timecode_to_seconds(m.group(2))
            return t_in, t_out
        # Single timecode
        single = re.search(r"(\d+(?::\d+)+(?:\.\d+)?)", text)
        if single:
            return parse_timecode_to_seconds(single.group(1)), 0.0
        return 0.0, 0.0

    def _parse_chain_blocks(self, text: str) -> List[ParsedBeat]:
        """Extract beats from blocks like **0:00–0:07 | CHAIN 1 — THE CHANCE** or #### 0:00.00–0:06.42 | ACT 1."""
        beats: List[ParsedBeat] = []
        # Match time range headers: (optional ** or ####) 0:00–0:07 | ...
        blocks = re.split(r"(?m)^(?:[#\s*]*?)(\d+:\d+(?:\.\d+)?\s*[–-]\s*\d+:\d+(?:\.\d+)?)\s*\|\s*(.+?)(?:\*\*)?$", text)
        if len(blocks) < 3:
            # Fallback inline regex
            blocks = re.split(r"(?:\*\*|#{1,6}\s*)?(\d+:\d+(?:\.\d+)?\s*[–-]\s*\d+:\d+(?:\.\d+)?)\s*\|\s*(.+?)(?:\*\*)?\n", text)
            if len(blocks) < 3:
                return []

        # blocks: [preamble, timecode, title, content, timecode, title, content, ...]
        i = 1
        beat_idx = 1
        while i < len(blocks) - 1:
            tc_str = blocks[i].strip()
            title_str = blocks[i + 1].strip()
            content = blocks[i + 2].strip() if (i + 2) < len(blocks) else ""

            tl_in, tl_out = self._extract_in_out(tc_str)

            # Extract speaker, quote, and source from content
            # e.g. - **Audio — Nisar starts (C5024 02:44–02:48):** "This is the best..."
            # or - **Audio — Youth Speaker (`WhatsApp Video...`):** \n > "Right now..."
            speaker = ""
            clip_stem = ""
            src_in = 0.0
            src_out = 0.0
            quote = ""
            caption = ""
            visual_cue = ""

            # Check audio line
            audio_m = re.search(r"(?is)\*\*Audio\s*(?:[—–-]\s*([^\(:]+?))?\s*(?:\(([^\)]+?)\))?\s*:\*\*\s*(?:>\s*)?[\"“](.+?)[\"”]", content)
            if audio_m:
                speaker = audio_m.group(1).strip() if audio_m.group(1) else ""
                spec = audio_m.group(2).strip() if audio_m.group(2) else ""
                quote = audio_m.group(3).strip()

                stem_m = re.search(r"(?i)\b(C\d{4}|DJI_\d{4})\b", spec)
                if stem_m:
                    clip_stem = stem_m.group(1).upper()
                if spec:
                    src_in, src_out = self._extract_in_out(spec)

            # Check caption line
            cap_m = re.search(r"(?i)\*\*Caption:\*\*\s*[`*]*(.+?)[`*]*$", content, re.MULTILINE)
            if cap_m:
                caption = cap_m.group(1).strip()

            # Check visual cue
            vis_m = re.search(r"(?i)\*\*Visual:\*\*\s*(.+?)$", content, re.MULTILINE)
            if vis_m:
                visual_cue = vis_m.group(1).strip()

            beats.append(ParsedBeat(
                index=beat_idx,
                title=title_str,
                speaker=speaker,
                clip_stem=clip_stem,
                source_in=src_in,
                source_out=src_out,
                timeline_in=tl_in,
                timeline_out=tl_out,
                target_slot_duration=tl_out - tl_in,
                quote=quote,
                caption=caption,
                visual_cue=visual_cue,
            ))

            beat_idx += 1
            i += 3

        return beats

    def _parse_ad_blocks(self, text: str) -> List[ParsedBeat]:
        """Extract beats from blocks like ### **[0:00 - 0:05] HOOK**."""
        beats: List[ParsedBeat] = []
        blocks = re.split(r"###\s*(?:\*\*)?\[(\d+:\d+\s*[–-]\s*\d+:\d+)\]\s*(.+?)(?:\*\*)?\n", text)
        if len(blocks) < 3:
            return []

        i = 1
        beat_idx = 1
        while i < len(blocks) - 1:
            tc_str = blocks[i].strip()
            title_str = blocks[i + 1].strip()
            content = blocks[i + 2].strip() if (i + 2) < len(blocks) else ""

            tl_in, tl_out = self._extract_in_out(tc_str)

            vis_m = re.search(r"(?i)\*\*VISUAL:\*\*\s*(.+?)$", content, re.MULTILINE)
            visual_cue = vis_m.group(1).strip() if vis_m else ""

            vo_m = re.search(r"(?i)\*\*VOICEOVER:\*\*\s*\n?>?\s*[\"“]?(.+?)[\"”]?$", content, re.MULTILINE)
            quote = vo_m.group(1).strip() if vo_m else ""

            cap_m = re.search(r"(?i)\*\*TEXT:\*\*\s*(.+?)$", content, re.MULTILINE)
            caption = cap_m.group(1).strip() if cap_m else ""

            beats.append(ParsedBeat(
                index=beat_idx,
                title=title_str,
                timeline_in=tl_in,
                timeline_out=tl_out,
                target_slot_duration=tl_out - tl_in,
                quote=quote,
                caption=caption,
                visual_cue=visual_cue,
            ))

            beat_idx += 1
            i += 3

        return beats

    def _parse_freeform_beats(self, text: str) -> List[ParsedBeat]:
        """Fallback: split into sentences / paragraphs for unstructured text."""
        lines = [l.strip() for l in text.splitlines() if l.strip() and not l.startswith("#")]
        beats: List[ParsedBeat] = []
        curr_time = 0.0
        for idx, line in enumerate(lines, 1):
            dur = max(2.5, len(line.split()) * 0.35)
            beats.append(ParsedBeat(
                index=idx,
                title=f"Beat {idx}",
                timeline_in=curr_time,
                timeline_out=curr_time + dur,
                target_slot_duration=dur,
                quote=line,
                caption=line[:40],
            ))
            curr_time += dur
        return beats

    def compile_script_to_plan(
        self,
        script_input: str,
        script_id: str = "Script",
        title: str = "Rough Cut",
        aspect_ratio: str = "9:16",
        fps: float = 30.0,
        auto_broll: bool = True,
        pacing_style: str = "editorial",
    ) -> AssembledScriptPlan:
        """
        Compile a script into a concrete multi-track assembly plan.
        Resolves media paths on disk, trims Franken-bite sub-phrases, schedules
        checkerboarded J-cuts, and matches B-roll overlays.
        """
        # If script_input is a path on disk, read it
        if os.path.exists(script_input):
            p = Path(script_input)
            script_id = p.stem
            title = p.name
            with open(script_input, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
        else:
            content = script_input

        # Parse beats
        beats = self.parse_markdown_script(content)
        if not beats:
            raise ValueError("No valid beats could be parsed from the provided script.")

        # Determine overall title and duration
        target_dur = beats[-1].timeline_out if beats[-1].timeline_out > 0 else sum(b.target_slot_duration for b in beats)

        width, height = (1080, 1920) if aspect_ratio == "9:16" else (1920, 1080)
        plan = AssembledScriptPlan(
            script_id=script_id,
            title=title,
            target_duration=round(target_dur, 2),
            aspect_ratio=aspect_ratio,
            fps=fps,
            width=width,
            height=height,
        )

        curr_timeline_sec = 0.0
        last_speaker = ""
        last_clip_stem = ""
        active_video_track = 0  # Alternates 0 (V1) and 1 (V2) for J-cuts
        active_audio_track = 0  # Alternates 0 (A1) and 1 (A2) for J-cuts

        for beat in beats:
            # Step 1: Resolve speaker and clip stem
            resolved_media = None
            if beat.clip_stem:
                resolved_media = media_resolver.resolve_media(beat.clip_stem)

            # If no clip stem directly on beat, search speaker
            speaker_name = beat.speaker
            if not resolved_media and speaker_name:
                sp_info = media_resolver.get_speaker(speaker_name)
                if sp_info and sp_info.clip_stems:
                    resolved_media = media_resolver.resolve_media(sp_info.clip_stems[0])

            # Fallback: if no media resolved yet, search quote text across transcript index
            if not resolved_media and beat.quote:
                resolved_media = self._find_media_by_quote(beat.quote)

            # If still nothing, fallback to first available video in resolver
            if not resolved_media:
                all_videos = [m for m in media_resolver._media_by_path.values() if m.file_type == "video"]
                if all_videos:
                    resolved_media = all_videos[0]

            source_path = resolved_media.path if resolved_media else ""
            source_stem = resolved_media.stem if resolved_media else beat.clip_stem

            # Step 2: Resolve companion audio and transcript
            pair = media_resolver.resolve_audio_pair(source_stem) if source_stem else None
            transcript_path = pair.transcript_item.path if (pair and pair.transcript_item) else None
            enhanced_audio_path = pair.enhanced_audio_item.path if (pair and pair.enhanced_audio_item) else None

            # Step 3: Speech boundary snapping & Franken-bite micro-slicing
            gross_in = beat.source_in
            gross_out = beat.source_out if beat.source_out > beat.source_in else gross_in + beat.target_slot_duration

            # Intelligently snap to complete spoken sentences if transcript exists
            if transcript_path and os.path.exists(transcript_path):
                gross_in, gross_out = self._snap_to_complete_sentences(gross_in, gross_out, beat.quote, transcript_path, clip_stem=source_stem)

            target_slot = beat.target_slot_duration or (gross_out - gross_in)

            # If not explicitly marked as frankenbite and gross duration is reasonably compact,
            # keep as a single curated continuous cut to preserve complete, natural speech sentences.
            is_explicit_frankenbite = "frankenbite" in beat.handoff_note.lower()
            if not is_explicit_frankenbite:
                slices = [MicroCutSlice(0, beat.quote.strip(), gross_in, gross_out, gross_out - gross_in)]
            else:
                slices = self.frankenbite.trim_frankenbite(
                    quote=beat.quote,
                    gross_in=gross_in,
                    gross_out=gross_out,
                    transcript_path=transcript_path,
                    target_slot_sec=target_slot,
                )

            # Step 4: Emit AssembledCut items
            # Only apply J-cut if explicitly requested in script handoff note (e.g. "j-cut out: ...")
            # Default behavior: clean straight cuts joined on ONE track (V1 / A1), no overlapping voices
            has_j_cut = "j-cut" in beat.handoff_note.lower()
            audio_lead_frames = 15 if has_j_cut else 0
            audio_lead_sec = round(audio_lead_frames / fps, 4)

            # Only alternate tracks if J-cut is explicitly requested
            if has_j_cut:
                active_video_track = 1 if active_video_track == 0 else 0
                active_audio_track = 1 if active_audio_track == 0 else 0
            else:
                active_video_track = 0
                active_audio_track = 0

            for sub_idx, sl in enumerate(slices):
                if sl.duration < 0.3 or sl.source_out <= sl.source_in:
                    continue
                cut_idx = len(plan.cuts) + 1
                is_same_clip = bool(source_stem and source_stem == last_clip_stem and sub_idx > 0)

                cut_start = curr_timeline_sec
                cut_end = cut_start + sl.duration

                punch_in = 1.08 if is_same_clip else 1.0

                cut_quote = sl.sub_text or beat.quote
                if not cut_quote and transcript_path:
                    cut_quote = self._extract_transcript_words(transcript_path, sl.source_in, sl.source_out)

                assembled_cut = AssembledCut(
                    cut_index=cut_idx,
                    beat_index=beat.index,
                    speaker=speaker_name or (pair.speaker if pair else "Speaker"),
                    source_file=source_path,
                    source_stem=source_stem,
                    source_in=round(sl.source_in, 3),
                    source_out=round(sl.source_out, 3),
                    duration=round(sl.duration, 3),
                    timeline_start=round(cut_start, 3),
                    timeline_end=round(cut_end, 3),
                    video_track=active_video_track,  # V1 by default (joined on single track)
                    audio_track=active_audio_track,  # A1 by default (joined on single track)
                    audio_lead_frames=audio_lead_frames if sub_idx == 0 else 0,
                    audio_lead_sec=audio_lead_sec if sub_idx == 0 else 0.0,
                    same_clip_splice=is_same_clip,
                    scale_punch_in=punch_in,
                    quote=cut_quote,
                    caption_text=beat.caption or cut_quote,
                    speaker_badge=speaker_name,
                    marker_name=f"[{speaker_name or 'Cut'}] {beat.title}",
                    marker_comment=cut_quote,
                    enhanced_audio_file=enhanced_audio_path,
                    transcript_file=transcript_path,
                )

                plan.cuts.append(assembled_cut)

                # Caption entry for Captions Studio matching each cut
                plan.captions.append({
                    "start": round(cut_start, 3),
                    "end": round(cut_end, 3),
                    "text": beat.caption or cut_quote,
                    "speaker": speaker_name,
                })

                curr_timeline_sec = cut_end
                last_clip_stem = source_stem

            # Beat marker
            plan.markers.append({
                "time": round(beat.timeline_in or (curr_timeline_sec - target_slot), 3),
                "name": f"[{speaker_name}] {beat.title}",
                "comment": beat.caption or beat.quote[:50],
                "color_index": 4,  # Cyan
            })

        # Step 5: Intelligent B-Roll Placement via Visual Library
        if auto_broll and plan.cuts:
            try:
                from .broll_placement_engine import broll_placement_engine
                from .visual_library_service import visual_library_service

                vl_items = visual_library_service.query_items(limit=1)
                if vl_items:
                    brolls = broll_placement_engine.place_broll_for_plan(
                        plan.cuts, aspect_ratio=aspect_ratio, pacing_style=pacing_style
                    )
                    if brolls:
                        plan.broll_clips = brolls
            except Exception as e:
                logger.warning(f"[script_assembly] Visual Library broll placement fallback: {e}")

            last_speaker = speaker_name

        plan.summary = {
            "total_cuts": len(plan.cuts),
            "broll_count": len(plan.broll_clips),
            "pacing_style": pacing_style,
            "speakers": list({c.speaker for c in plan.cuts if c.speaker}),
            "total_duration": round(curr_timeline_sec, 2),
            "j_cuts_count": sum(1 for c in plan.cuts if c.audio_lead_frames > 0),
            "punch_in_count": sum(1 for c in plan.cuts if c.scale_punch_in > 1.0),
        }

        return plan

    def _find_media_by_quote(self, quote: str) -> Optional[MediaItem]:
        """Search across all indexed transcripts to find which video uttered this quote."""
        if not quote:
            return None
        norm_q = re.sub(r"[^\w\s]", "", quote.lower()).strip()
        tokens = set(norm_q.split())
        if len(tokens) < 3:
            return None

        # Check media resolver transcript items
        for path_key, item in media_resolver._media_by_path.items():
            if item.file_type == "transcript" and item.path.endswith(".json"):
                try:
                    with open(item.path, "r", encoding="utf-8", errors="ignore") as f:
                        text = f.read().lower()
                    if norm_q[:30] in text or len(tokens.intersection(set(text.split()))) >= len(tokens) * 0.7:
                        # Found matching transcript stem; return its video pair
                        video_match = media_resolver.resolve_media(item.stem, prefer_video=True)
                        if video_match:
                            return video_match
                except Exception:
                    pass
        return None

    def _extract_transcript_words(self, transcript_path: str, start: float, end: float) -> str:
        """Extract spoken words from transcript segments overlapping [start, end]."""
        if not transcript_path or not os.path.exists(transcript_path):
            return ""
        try:
            with open(transcript_path, "r", encoding="utf-8", errors="ignore") as f:
                data = json.load(f)
            texts = []
            for s in data.get("segments", []):
                s_st = float(s.get("start", 0))
                s_en = float(s.get("end", 0))
                if s_en >= start - 0.5 and s_st <= end + 0.5:
                    texts.append(s.get("text", "").strip())
            return " ".join(texts).strip()
        except Exception:
            return ""

    def _snap_to_complete_sentences(
        self,
        gross_in: float,
        gross_out: float,
        quote: str,
        transcript_path: str,
        clip_stem: str = "",
    ) -> Tuple[float, float]:
        """
        Intelligently snap gross_in and gross_out to natural speech boundaries in transcript.
        Dynamically aligns start and end timestamps to word/sentence boundaries.
        Prevents clips from cutting off mid-sentence, mid-word, or mid-thought.
        """
        try:
            if not transcript_path or not os.path.exists(transcript_path):
                return gross_in, gross_out
            if not transcript_path.endswith(".json"):
                return gross_in, gross_out

            with open(transcript_path, "r", encoding="utf-8", errors="ignore") as f:
                data = json.load(f)
            segments = data.get("segments", [])
            if not segments:
                return gross_in, gross_out

            clean_in = gross_in
            clean_out = gross_out

            # 1. Collect all words from segments overlapping the gross window
            window_words = []
            for seg in segments:
                s_start = float(seg.get("start", 0))
                s_end = float(seg.get("end", 0))
                if s_end >= gross_in - 3.0 and s_start <= gross_out + 3.0:
                    words = seg.get("words", [])
                    if words:
                        for w in words:
                            w_st = float(w.get("start", 0))
                            w_en = float(w.get("end", 0))
                            w_txt = str(w.get("word", "")).strip()
                            if w_st >= gross_in - 2.5 and w_en <= gross_out + 2.5:
                                window_words.append({"word": w_txt, "start": w_st, "end": w_en})

            # 2. Dynamic Start Snapping
            if window_words:
                start_candidates = [w for w in window_words if abs(w["start"] - gross_in) <= 2.0]
                if start_candidates:
                    best_w_in = min(start_candidates, key=lambda w: abs(w["start"] - gross_in))
                    clean_in = max(0.0, round(best_w_in["start"] - 0.06, 2))
                else:
                    clean_in = max(0.0, round(window_words[0]["start"] - 0.06, 2))
            else:
                in_candidates = [
                    s for s in segments
                    if abs(float(s.get("start", 0)) - gross_in) <= 2.5
                    or (float(s.get("start", 0)) <= gross_in and float(s.get("end", 0)) > gross_in)
                ]
                if in_candidates:
                    best_in = min(in_candidates, key=lambda s: abs(float(s.get("start", 0)) - gross_in))
                    clean_in = round(float(best_in.get("start", gross_in)), 2)

            # 3. Dynamic End Snapping (Sentence boundary / punctuation / pause)
            if window_words:
                end_candidates = [w for w in window_words if w["end"] > clean_in + 0.8 and abs(w["end"] - gross_out) <= 2.5]
                if end_candidates:
                    punctuated = [w for w in end_candidates if any(w["word"].endswith(p) for p in [".", "!", "?", ",", "—", "…"])]
                    if punctuated:
                        best_w_out = min(punctuated, key=lambda w: abs(w["end"] - gross_out))
                    else:
                        best_w_out = min(end_candidates, key=lambda w: abs(w["end"] - gross_out))
                    clean_out = round(best_w_out["end"] + 0.08, 2)
            else:
                inside_segs = [s for s in segments if float(s.get("start", 0)) <= gross_out <= float(s.get("end", 0))]
                if inside_segs:
                    clean_out = round(float(inside_segs[0].get("end", gross_out)), 2)
                else:
                    out_candidates = [s for s in segments if abs(float(s.get("end", 0)) - gross_out) <= 2.5]
                    if out_candidates:
                        best_out = min(out_candidates, key=lambda s: abs(float(s.get("end", 0)) - gross_out))
                        clean_out = round(float(best_out.get("end", gross_out)), 2)

            if clean_out <= clean_in + 0.5:
                clean_out = clean_in + max(1.5, (gross_out - gross_in))

            return clean_in, clean_out
        except Exception as e:
            logger.debug(f"[script_assembly] Dynamic sentence snapping fallback: {e}")
            return gross_in, gross_out

    def plan_to_edl_ops(self, plan: AssembledScriptPlan, target_seq_name: Optional[str] = None) -> List[Dict[str, Any]]:
        """
        Convert an AssembledScriptPlan into ExtendScript operations for processEDL.
        Features:
          - Pre-trimmed FIX-A projectItem.setInPoint/setOutPoint
          - Checkerboarded V1/A1 and V1/A2 audio placement for 4-frame J-cuts
          - Track V2 B-roll cover placement
          - Beat chapter markers
          - Single-undo group in Premiere Pro
        """
        seq_name = target_seq_name or f"Rough Cut - {plan.title}"
        ops: List[Dict[str, Any]] = []

        ops.append({"action": "beginUndoGroup", "name": f"EditFlow: {seq_name}"})
        ops.append({"action": "ensure_bin", "bin_name": "_EditFlow Raw"})

        # Collect unique media files to import
        all_source_files = sorted({c.source_file for c in plan.cuts if c.source_file} | {b.source_file for b in plan.broll_clips if b.source_file})
        for fpath in all_source_files:
            ops.append({
                "action": "import_file",
                "mediaPath": fpath,
                "bin_name": "_EditFlow Raw",
            })

        # Create output sequence
        base_clip = plan.cuts[0].source_file if plan.cuts else None
        ops.append({"action": "ensure_bin", "bin_name": "EditFlow Rough Cuts"})
        ops.append({
            "action": "create_sequence",
            "name": seq_name,
            "preset_from_clip_path": base_clip,
            "width": plan.width,
            "height": plan.height,
            "fps": plan.fps,
        })

        # Add cuts (Track V1, alternating A1/A2)
        for cut in plan.cuts:
            if not cut.source_file:
                continue

            # Frame-aligned placement
            ops.append({
                "action": "add",
                "mediaPath": cut.source_file,
                "startTime": cut.timeline_start,
                "inPoint": cut.source_in,
                "outPoint": cut.source_out,
                "video_track_index": cut.video_track,
                "audio_track_index": cut.audio_track,
                "audio_lead_frames": cut.audio_lead_frames,
                "scale_punch_in": cut.scale_punch_in,
                "single_channel_dialogue": True,
            })

            # Add marker for the cut
            ops.append({
                "action": "add_marker",
                "time": cut.timeline_start,
                "name": cut.marker_name,
                "comments": cut.marker_comment,
                "color_index": 4,  # Cyan
            })

        # Add B-roll overlays (Track V2)
        for broll in plan.broll_clips:
            if not broll.source_file:
                continue
            ops.append({
                "action": "add",
                "mediaPath": broll.source_file,
                "startTime": broll.timeline_start,
                "inPoint": broll.source_in,
                "outPoint": broll.source_out,
                "video_track_index": broll.track,  # 1 = V2
                "audio_track_index": -1,           # No audio for B-roll overlay
            })

        ops.append({"action": "endUndoGroup"})

        return ops


# Global singleton instance
script_assembly_service = ScriptAssemblyService()
