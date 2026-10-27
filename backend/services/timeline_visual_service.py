"""
EditFlow AI - Timeline Visual Overlay Service
Transcribes the active Premiere Pro sequence, aligns speech with a script (or autonomous NLP concepts),
and computes rhythm-matched micro-visual B-roll placements on Track V2 (or specified target track).
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from ..config import get_settings
from .broll_placement_engine import BrollPlacementEngine, PACING_PRESETS
from .script_assembly_service import AssembledCut, BrollPlacement, ScriptAssemblyService
from .subtitles.animated_overlay import _ffmpeg_path
from .subtitles.sequence_audio import clean_clips, fingerprint as clips_fp, mix_sequence_audio
from .whisper_service import whisper_service

logger = logging.getLogger(__name__)


class TimelineVisualService:
    """
    Orchestrates end-to-end active timeline transcription and B-roll placement.
    """

    def __init__(self):
        self.script_assembly = ScriptAssemblyService()

    async def transcribe_active_sequence(
        self,
        clips: List[Dict[str, Any]],
        sequence_duration: float,
        language: str = "auto",
        force: bool = False,
    ) -> List[Dict[str, Any]]:
        """
        Mixes down unmuted sequence audio and transcribes with Whisper.
        Returns sequence-time segments with start, end, text, and words.
        """
        cleaned, skipped = clean_clips(clips)
        if not cleaned:
            raise ValueError("No valid unmuted audio clips found in the active sequence.")

        active_model = whisper_service.get_active_model_name()
        lang_key = (language or "auto").strip().lower()
        fp_suffix = f"{active_model}|{lang_key}|timeline_visuals"
        fp = clips_fp(cleaned, fp_suffix)

        mixdowns_dir = get_settings().DATA_DIR / "media_cache" / "mixdowns"
        mixdowns_dir.mkdir(parents=True, exist_ok=True)
        wav_path = mixdowns_dir / f"seq-visuals-{fp}.wav"

        if not wav_path.exists() or force:
            logger.info(f"[timeline_visuals] Mixing {len(cleaned)} clips to {wav_path}")
            await asyncio.to_thread(
                mix_sequence_audio,
                _ffmpeg_path(),
                cleaned,
                wav_path,
                sequence_duration,
            )

        logger.info(f"[timeline_visuals] Transcribing sequence audio with Whisper ({language})...")
        lang_arg = None if language == "auto" else language
        transcription = await whisper_service.transcribe_fingerprinted(
            source_path=str(wav_path),
            file_fingerprint=fp,
            language=lang_arg,
            word_timestamps=True,
            force=force,
        )

        segments = []
        raw_segs = transcription.segments if hasattr(transcription, "segments") else (transcription.get("segments", []) if isinstance(transcription, dict) else [])
        for s in raw_segs:
            txt = (s.text if hasattr(s, "text") else s.get("text", "")).strip()
            if not txt:
                continue
            seg_start = round(float(s.start if hasattr(s, "start") else s.get("start", 0.0)), 2)
            seg_end = round(float(s.end if hasattr(s, "end") else s.get("end", seg_start + 1.0)), 2)
            raw_words = s.words if hasattr(s, "words") else s.get("words", [])
            words_list = []
            for w in raw_words:
                if hasattr(w, "__dict__"):
                    words_list.append({
                        "word": getattr(w, "word", ""),
                        "start": getattr(w, "start", 0.0),
                        "end": getattr(w, "end", 0.0),
                        "score": getattr(w, "score", 1.0)
                    })
                elif isinstance(w, dict):
                    words_list.append(w)

            segments.append({
                "start": seg_start,
                "end": seg_end,
                "duration": round(seg_end - seg_start, 2),
                "text": txt,
                "words": words_list,
                "speaker": "Speaker",
                "cue": "",
            })

        logger.info(f"[timeline_visuals] Produced {len(segments)} transcribed sequence segments.")
        return segments

    def align_segments_with_script(
        self,
        segments: List[Dict[str, Any]],
        script_path: Optional[str] = None,
        script_content: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        Aligns transcribed sequence segments against script narrative beats and visual cues.
        If no script is provided, preserves segments with autonomous concept cues.
        """
        text = script_content
        if not text and script_path and os.path.exists(script_path):
            try:
                with open(script_path, "r", encoding="utf-8", errors="ignore") as f:
                    text = f.read()
            except Exception as e:
                logger.warning(f"[timeline_visuals] Failed to read script {script_path}: {e}")

        if not text:
            # Autonomous mode: no script text provided
            return segments

        parsed_beats = self.script_assembly.parse_markdown_script(text)
        if not parsed_beats:
            return segments

        logger.info(f"[timeline_visuals] Aligning {len(segments)} segments with {len(parsed_beats)} script beats...")

        # Match each segment to the best script beat based on token overlap
        for seg in segments:
            seg_tokens = set(re.findall(r"\b[a-zA-Z0-9_-]{3,}\b", seg["text"].lower()))
            best_beat = None
            best_overlap = 0

            for beat in parsed_beats:
                beat_text = f"{beat.quote} {beat.caption} {beat.visual_cue} {beat.title}".lower()
                beat_tokens = set(re.findall(r"\b[a-zA-Z0-9_-]{3,}\b", beat_text))
                overlap = len(seg_tokens.intersection(beat_tokens))
                if overlap > best_overlap:
                    best_overlap = overlap
                    best_beat = beat

            if best_beat:
                seg["speaker"] = best_beat.speaker or seg["speaker"]
                seg["cue"] = best_beat.visual_cue or best_beat.caption or seg["cue"]
                seg["beat_title"] = best_beat.title

        return segments

    async def compile_timeline_visual_plan(
        self,
        clips: List[Dict[str, Any]],
        sequence_duration: float,
        sequence_name: str = "Active Sequence",
        script_path: Optional[str] = None,
        script_content: Optional[str] = None,
        aspect_ratio: str = "9:16",
        pacing_style: str = "editorial",
        target_track: int = 1,
        language: str = "auto",
        force: bool = False,
    ) -> Dict[str, Any]:
        """
        Full compilation:
        1. Transcribes sequence audio.
        2. Aligns segments with script / concepts.
        3. Generates micro-visual B-roll placements with pacing & Golden Section trimming.
        4. Generates single-undo EDL operations for Premiere Pro.
        """
        # 1. Transcribe
        segments = await self.transcribe_active_sequence(
            clips=clips,
            sequence_duration=sequence_duration,
            language=language,
            force=force,
        )

        # 2. Align with script
        aligned_segments = self.align_segments_with_script(
            segments=segments,
            script_path=script_path,
            script_content=script_content,
        )

        # 3. Compute B-roll placements on target track (e.g. V2)
        placements, cuts = BrollPlacementEngine.place_broll_for_timeline_segments(
            segments=aligned_segments,
            aspect_ratio=aspect_ratio,
            pacing_style=pacing_style,
            target_track=target_track,
        )

        # 4. Generate EDL operations
        edl_ops = self.generate_timeline_edl_ops(
            placements=placements,
            target_track=target_track,
            sequence_name=sequence_name,
        )

        unique_files = list(set(p.source_file for p in placements))

        return {
            "success": True,
            "sequence_name": sequence_name,
            "duration": sequence_duration,
            "aspect_ratio": aspect_ratio,
            "pacing_style": pacing_style,
            "target_track": target_track,
            "target_track_name": f"V{target_track + 1}",
            "transcription_segments": aligned_segments,
            "broll_placements": [p.to_dict() for p in placements],
            "cuts": [c.to_dict() for c in cuts],
            "edl_ops": edl_ops,
            "summary": {
                "total_segments": len(aligned_segments),
                "total_visuals": len(placements),
                "unique_visual_files": len(unique_files),
                "pacing": pacing_style,
                "target_track_name": f"V{target_track + 1}",
                "duration": sequence_duration,
            },
        }

    def generate_timeline_edl_ops(
        self,
        placements: List[BrollPlacement],
        target_track: int = 1,
        sequence_name: str = "Active Sequence",
    ) -> List[Dict[str, Any]]:
        """
        Generates single-undo EDL operations to place B-roll clips directly on the active sequence.
        """
        ops: List[Dict[str, Any]] = []

        ops.append({
            "action": "beginUndoGroup",
            "name": f"EditFlow: Place Visuals on V{target_track + 1}",
        })
        ops.append({"action": "ensure_bin", "bin_name": "_EditFlow Raw"})

        # Import all unique visual media files
        unique_files = set(p.source_file for p in placements if p.source_file)
        for f in unique_files:
            ops.append({
                "action": "import_file",
                "mediaPath": f,
                "bin_name": "_EditFlow Raw",
            })

        # Add visual overlay clips onto target track (auto-routes B-roll sound to clean empty audio track)
        for p in placements:
            if not p.source_file:
                continue
            ops.append({
                "action": "add",
                "mediaPath": p.source_file,
                "startTime": p.timeline_start,
                "inPoint": p.source_in,
                "outPoint": p.source_out,
                "video_track_index": target_track,
                "audio_track_index": "auto",  # Routes to clean empty audio track (A3..A8); dialogue on A1/A2 is 100% protected
                "auto_detect_track": target_track == -1,
            })

        ops.append({"action": "endUndoGroup"})
        return ops


timeline_visual_service = TimelineVisualService()
