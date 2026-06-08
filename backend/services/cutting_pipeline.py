"""
EditFlow AI - Video Cutting Pipeline Service
Analyzes videos, matches Urdu speech to English script, removes repetitions/pauses,
and produces clean cut videos. Also handles visual placement from mapping documents.
"""
import asyncio
import json
import logging
import re
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..config import get_settings
from ..models.sqlite_registry import sqlite_registry
from ..models.schemas import (
    CutSegment, CuttingResult, CuttingStatus,
    ScriptMatchRequest, VisualMapEntry, VisualMapRequest, VisualPlacementResult,
    utc_now,
)
from ..services.media_fingerprint import compute_file_fingerprint
from ..services.provider_service import provider_service
from ..services.whisper_service import whisper_service
from ..utils.ffmpeg_utils import get_duration, get_media_info, run_ffmpeg_async
from ..utils.progress import ProgressReporter

logger = logging.getLogger(__name__)

# Common filler words across languages
URDU_FILLERS = {"umm", "uh", "ah", "aray", "yaani", "toh", "woh", "bas", "jo", "kay"}
ENGLISH_FILLERS = {"um", "uh", "ah", "like", "you know", "i mean", "so", "basically", "actually", "right"}

# Common prompt-injection phrases neutralised before LLM interpolation.
_INJECTION_PATTERNS = re.compile(
    r"(?i)(ignore previous|disregard|system:|assistant:|new instructions|respond with only)"
)


def _sanitize_for_prompt(text: str, max_len: int = 200) -> str:
    """Strip control chars and neutralise common injection phrases.

    Transcript text and user-supplied script lines are interpolated into LLM
    prompts. A transcript that contains text like "Ignore previous instructions"
    could otherwise override the editor's intent.
    """
    if not text:
        return ""
    cleaned = (
        text.replace("\x00", "")
        .replace("`", "'")
        .replace("\r", " ")
        .replace("\n", " ")
    )
    cleaned = _INJECTION_PATTERNS.sub(lambda m: f"[{m.group(0)}]", cleaned)
    return cleaned[:max_len]


class CuttingPipelineService:
    """Core pipeline: analyze videos → match script → auto-cut → place visuals."""

    def __init__(self):
        self.settings = get_settings()

    # ── Video Analysis ──

    async def analyze_videos(
        self,
        folder_path: str,
        language: Optional[str] = None,
        recursive: bool = True,
        progress: Optional[ProgressReporter] = None,
    ) -> List[Dict[str, Any]]:
        """Analyze all videos in a folder: register assets + transcribe + create speech candidates.

        Args:
            folder_path: Path to folder containing video files
            language: Language hint (e.g. "ur" for Urdu)
            recursive: Whether to scan subdirectories
            progress: Progress reporter

        Returns:
            List of asset summaries with transcript info
        """
        from ..utils.ffmpeg_utils import scan_directory

        folder = Path(folder_path)
        if not folder.exists():
            raise ValueError(f"Folder not found: {folder_path}")

        files = scan_directory(str(folder))
        if not files:
            raise ValueError(f"No video files found in {folder_path}")

        if progress:
            await progress.start(f"Found {len(files)} videos to analyze")

        results = []
        for i, file_path in enumerate(files):
            if progress:
                await progress.step(i + 1, len(files), f"Analyzing {file_path.name}...")

            try:
                asset = await self._analyze_single_video(str(file_path), language)
                results.append(asset)
            except Exception as e:
                logger.error(f"Failed to analyze {file_path}: {e}")
                results.append({
                    "path": str(file_path),
                    "name": file_path.name,
                    "status": "error",
                    "error": str(e),
                })

        if progress:
            await progress.complete(f"Analyzed {len(results)} videos")

        return results

    async def _analyze_single_video(
        self, video_path: str, language: Optional[str] = None
    ) -> Dict[str, Any]:
        """Analyze a single video: register + transcribe + speech candidates.

        Phase B enhancement: computes and stores the file fingerprint, and
        uses transcribe_fingerprinted() for transcribe-once-per-source-file.
        """
        path = Path(video_path)
        asset_id = str(uuid.uuid4())[:12]

        # Compute file fingerprint (Phase B: content-addressed dedup)
        file_fingerprint = ""
        try:
            file_fingerprint = await asyncio.to_thread(compute_file_fingerprint, path)
        except Exception as e:
            logger.warning(f"Fingerprint computation failed for {path}: {e}")

        # Check if we already have this file by fingerprint
        if file_fingerprint:
            existing = sqlite_registry.find_asset_by_fingerprint(file_fingerprint)
            if existing:
                logger.info(
                    f"Asset already registered with fp={file_fingerprint[:16]}... "
                    f"(existing id={existing['id']}). Reusing transcript."
                )
                # Return the existing asset's summary
                transcript = sqlite_registry.fetch_one(
                    "SELECT language FROM transcripts WHERE asset_id = ?",
                    (existing["id"],),
                )
                return {
                    "id": existing["id"],
                    "path": str(path),
                    "name": path.name,
                    "duration": existing.get("duration", 0),
                    "language": transcript.get("language", "") if transcript else "",
                    "has_transcript": True,
                    "status": "analyzed",
                    "fingerprint": file_fingerprint,
                    "from_cache": True,
                }

        # Get media info (ffprobe blocks, run off the event loop)
        media_info = await asyncio.to_thread(get_media_info, video_path)

        # Register asset in SQLite (now with fingerprint)
        now = utc_now()
        sqlite_registry.execute(
            """INSERT OR REPLACE INTO assets
            (id, path, name, asset_type, source_type, duration, width, height, fps, has_audio,
             file_size, fingerprint, audio_fingerprint, status, language, tags, metadata, created_at, updated_at)
            VALUES (?, ?, ?, 'video', 'local_file', ?, ?, ?, ?, ?, ?, ?, '', 'analyzed', ?, '[]', '{}', ?, ?)""",
            (asset_id, str(path), path.name,
             media_info.get("duration", 0), media_info.get("width", 0),
             media_info.get("height", 0), media_info.get("fps", 0),
             1 if media_info.get("has_audio") else 0,
             media_info.get("file_size", 0),
             file_fingerprint,
             language or "", now, now),
        )

        # Transcribe (Phase B: transcribe-once-per-source-file)
        transcript_result = await whisper_service.transcribe_fingerprinted(
            source_path=video_path,
            file_fingerprint=file_fingerprint or None,
            language=language,
        )

        # Save transcript
        transcript_id = str(uuid.uuid4())[:12]
        sqlite_registry.execute(
            """INSERT OR REPLACE INTO transcripts
            (id, asset_id, language, duration, full_text, metadata, created_at)
            VALUES (?, ?, ?, ?, ?, '{}', ?)""",
            (transcript_id, asset_id, transcript_result.language,
             transcript_result.duration, transcript_result.full_text, now),
        )

        # Save segments and create speech candidates
        for seg in transcript_result.segments:
            seg_id = str(uuid.uuid4())[:12]
            sqlite_registry.execute(
                """INSERT OR REPLACE INTO transcript_segments
                (id, transcript_id, asset_id, start, end, text, words)
                VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (seg_id, transcript_id, asset_id, seg.start, seg.end, seg.text,
                 sqlite_registry.dumps([w.model_dump() for w in seg.words])),
            )

            # Create speech candidate (detect fillers, pauses, repetitions)
            await self._create_speech_candidate(asset_id, seg)

        # Index for search
        sqlite_registry.upsert_fts(
            "asset", asset_id, path.name, transcript_result.full_text, ""
        )

        return {
            "id": asset_id,
            "path": str(path),
            "name": path.name,
            "duration": media_info.get("duration", 0),
            "language": transcript_result.language,
            "has_transcript": True,
            "status": "analyzed",
            "fingerprint": file_fingerprint,
        }

    async def _create_speech_candidate(self, asset_id: str, segment) -> None:
        """Create a speech candidate from a transcript segment, detecting fillers/pauses/repetitions."""
        text = segment.text.strip().lower()
        words = [w.word.strip().lower() for w in segment.words] if segment.words else []

        # Detect filler words
        detected_fillers = []
        for w in words:
            if w in URDU_FILLERS or w in ENGLISH_FILLERS:
                detected_fillers.append(w)

        # Detect pauses (gap between words > 1 second)
        has_long_pause = False
        if segment.words and len(segment.words) > 1:
            for i in range(1, len(segment.words)):
                gap = segment.words[i].start - segment.words[i - 1].end
                if gap > 1.0:
                    has_long_pause = True
                    break

        # Detect repetitions
        has_repetition = False
        if len(words) >= 2:
            for i in range(1, len(words)):
                if words[i] == words[i - 1] and len(words[i]) > 2:
                    has_repetition = True
                    break

        # Delivery quality score (higher = better take)
        filler_penalty = len(detected_fillers) * 0.15
        pause_penalty = 0.3 if has_long_pause else 0
        rep_penalty = 0.25 if has_repetition else 0
        delivery_score = max(0.0, 1.0 - filler_penalty - pause_penalty - rep_penalty)

        # Cleaned excerpt (remove fillers)
        cleaned_words = [w for w in words if w not in URDU_FILLERS and w not in ENGLISH_FILLERS]
        cleaned_excerpt = " ".join(cleaned_words)

        reasons = []
        if detected_fillers:
            reasons.append(f"Fillers: {', '.join(detected_fillers)}")
        if has_long_pause:
            reasons.append("Long pause detected")
        if has_repetition:
            reasons.append("Word repetition detected")

        candidate_id = str(uuid.uuid4())[:12]
        now = utc_now()
        sqlite_registry.execute(
            """INSERT OR REPLACE INTO speech_candidates
            (id, asset_id, start, end, transcript_excerpt, cleaned_excerpt, reason,
             filler_words, has_pause, has_repetition, delivery_score, warnings, scores, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '{}', '{}')""",
            (candidate_id, asset_id, segment.start, segment.end,
             segment.text.strip(), cleaned_excerpt,
             "; ".join(reasons) if reasons else "Clean take",
             sqlite_registry.dumps(detected_fillers),
             1 if has_long_pause else 0,
             1 if has_repetition else 0,
             round(delivery_score, 2)),
        )

    # ── Script-Based Auto-Cutting ──

    async def match_and_cut(
        self,
        request: ScriptMatchRequest,
        progress: Optional[ProgressReporter] = None,
    ) -> CuttingResult:
        """Match an English script against Urdu video transcripts and produce clean cuts.

        This is the core feature: given Urdu videos and an English script, find the best
        take for each script line, remove repetitions/pauses/fillers, and produce a clean cut.

        Args:
            request: Script match request with script content and language settings
            progress: Progress reporter

        Returns:
            CuttingResult with matched segments and cut instructions
        """
        if progress:
            await progress.start("Loading analyzed videos...")

        # Get all speech candidates
        candidates = sqlite_registry.fetch_all(
            "SELECT sc.*, a.path as asset_path, a.name as asset_name FROM speech_candidates sc "
            "JOIN assets a ON sc.asset_id = a.id ORDER BY sc.delivery_score DESC"
        )

        if not candidates:
            return CuttingResult(
                status=CuttingStatus.FAILED,
                message="No analyzed videos found. Run video analysis first.",
            )

        if progress:
            await progress.update(0.1, "Parsing script into lines...")

        # Parse script into lines
        script_lines = self._parse_script(request.script_content)
        if not script_lines:
            return CuttingResult(
                status=CuttingStatus.FAILED,
                message="No script lines found. Please provide a valid script.",
            )

        if progress:
            await progress.update(0.2, f"Matching {len(script_lines)} script lines to {len(candidates)} speech segments...")

        # Use LLM to match script lines to speech candidates (cross-lingual matching)
        matches = await self._match_script_to_candidates(
            script_lines, candidates, request, progress
        )

        if progress:
            await progress.update(0.8, "Building clean cut plan...")

        # Build cut segments from matches
        cuts = []
        unmatched = []
        for i, line in enumerate(script_lines):
            match = matches.get(i)
            if match:
                cuts.append(CutSegment(
                    source_file=match["asset_path"],
                    start=match["start"],
                    end=match["end"],
                    text=match["transcript_excerpt"],
                    script_line=line,
                    confidence=match.get("match_confidence", 0.0),
                ))
            else:
                unmatched.append(line)

        # Cuts are intentionally kept in script-line order — the script
        # IS the narrative order, so do not sort by source_file/time here.

        # Calculate durations
        total_before = sum(c.end - c.start for c in cuts)
        # Estimate cleaned duration (remove pauses/fillers)
        total_after = total_before * 0.85  # Rough estimate

        result = CuttingResult(
            status=CuttingStatus.COMPLETED,
            total_segments=len(candidates),
            matched_segments=len(cuts),
            unmatched_lines=unmatched,
            cuts=cuts,
            duration_before=round(total_before, 2),
            duration_after=round(total_after, 2),
            message=f"Matched {len(cuts)}/{len(script_lines)} script lines. {len(unmatched)} lines unmatched.",
        )

        # Save result to DB
        result_id = str(uuid.uuid4())[:12]
        now = utc_now()
        sqlite_registry.execute(
            """INSERT OR REPLACE INTO cutting_results
            (id, script_id, status, total_segments, matched_segments, unmatched_lines,
             cuts, output_path, duration_before, duration_after, message, metadata, created_at, updated_at)
            VALUES (?, '', ?, ?, ?, ?, ?, '', ?, ?, ?, '{}', ?, ?)""",
            (result_id, result.status.value, result.total_segments, result.matched_segments,
             sqlite_registry.dumps(result.unmatched_lines),
             sqlite_registry.dumps([c.model_dump() for c in result.cuts]),
             result.duration_before, result.duration_after, result.message, now, now),
        )

        if progress:
            await progress.complete(result.message)

        return result

    def _parse_script(self, content: str) -> List[str]:
        """Parse script content into meaningful lines."""
        lines = []
        for line in content.split("\n"):
            stripped = line.strip()
            # Skip empty lines, stage directions (in brackets/parentheses), and very short lines
            if not stripped:
                continue
            if stripped.startswith("[") and stripped.endswith("]"):
                continue
            if stripped.startswith("(") and stripped.endswith(")"):
                continue
            if len(stripped) < 3:
                continue
            lines.append(stripped)
        return lines

    async def _match_script_to_candidates(
        self,
        script_lines: List[str],
        candidates: List[Dict],
        request: ScriptMatchRequest,
        progress: Optional[ProgressReporter] = None,
    ) -> Dict[int, Dict]:
        """Use LLM to match English script lines to Urdu speech candidates.

        This performs cross-lingual semantic matching: the LLM understands both
        the English script meaning and the Urdu transcript content, finding the
        best corresponding takes for each script line.
        """
        matches = {}

        # Build candidate summaries for LLM context (sanitised — see _sanitize_for_prompt)
        candidate_summaries = []
        for i, c in enumerate(candidates[:200]):  # Limit to prevent token overflow
            candidate_summaries.append(
                f"  [{i}] File: {_sanitize_for_prompt(c.get('asset_name', 'unknown'), 80)} | "
                f"Time: {c.get('start', 0):.1f}-{c.get('end', 0):.1f}s | "
                f"Score: {c.get('delivery_score', 0):.2f} | "
                f"Text: {_sanitize_for_prompt(c.get('transcript_excerpt', ''), 100)} | "
                f"Reason: {_sanitize_for_prompt(c.get('reason', ''), 80)}"
            )

        # Process in batches of script lines to avoid token limits
        batch_size = 10
        for batch_start in range(0, len(script_lines), batch_size):
            batch_end = min(batch_start + batch_size, len(script_lines))
            batch_lines = script_lines[batch_start:batch_end]

            if progress:
                pct = 0.2 + 0.6 * (batch_start / len(script_lines))
                await progress.update(pct, f"Matching script lines {batch_start+1}-{batch_end}...")

            # Build the matching prompt
            prompt = self._build_matching_prompt(
                batch_lines, batch_start, candidate_summaries, request
            )

            try:
                result = await provider_service.chat(
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0.2,
                    max_tokens=4096,
                )
                response_text = result.get("response", "")

                # Parse LLM response
                batch_matches = self._parse_matching_response(response_text, candidates)
                for line_offset, match_data in batch_matches.items():
                    global_line = batch_start + line_offset
                    matches[global_line] = match_data

            except Exception as e:
                logger.error(f"LLM matching failed for batch starting at {batch_start}: {e}")
                # Fall back to simple keyword matching
                for i, line in enumerate(batch_lines):
                    global_idx = batch_start + i
                    best = self._simple_keyword_match(line, candidates)
                    if best:
                        matches[global_idx] = best

        return matches

    def _build_matching_prompt(
        self,
        batch_lines: List[str],
        batch_start: int,
        candidate_summaries: List[str],
        request: ScriptMatchRequest,
    ) -> str:
        """Build the cross-lingual matching prompt for the LLM."""
        lines_text = "\n".join(
            f"  Line {batch_start + i + 1}: {_sanitize_for_prompt(line, 300)}"
            for i, line in enumerate(batch_lines)
        )
        candidates_text = "\n".join(candidate_summaries)

        return f"""You are an expert video editor who understands both English and Urdu.
Your task is to match English script lines to Urdu speech segments from video recordings.

The videos contain Urdu speech. The script is in English. You need to find which Urdu speech 
segment best corresponds to each English script line based on semantic meaning.

SCRIPT LINES (English):
{lines_text}

AVAILABLE SPEECH SEGMENTS (Urdu transcribed):
{candidates_text}

MATCHING RULES:
1. Match each script line to the BEST speech segment that conveys the same meaning.
2. Prefer segments with higher delivery_score (better quality takes).
3. Avoid segments with fillers, pauses, or repetitions when better alternatives exist.
4. A speech segment can match multiple script lines if the speaker repeated themselves.
5. If no segment matches a line, leave it unmatched.

Respond with ONLY a JSON object in this format:
{{
  "matches": {{
    "1": {{"candidate_index": 5, "confidence": 0.9, "reason": "Semantic match"}},
    "2": {{"candidate_index": 12, "confidence": 0.8, "reason": "Close meaning match"}},
    "3": null
  }}
}}

The keys are line numbers (1-based within this batch). null means no match found.
Respond with valid JSON only, no other text."""

    def _parse_matching_response(
        self, response: str, candidates: List[Dict]
    ) -> Dict[int, Dict]:
        """Parse the LLM matching response into match data."""
        try:
            # Extract JSON from response
            text = response.strip()
            if text.startswith("```"):
                text = "\n".join(line for line in text.split("\n") if not line.strip().startswith("```"))

            match = re.search(r"\{[\s\S]*\}", text)
            if match:
                data = json.loads(match.group())
            else:
                data = json.loads(text)

            matches = {}
            for line_key, match_data in data.get("matches", {}).items():
                if match_data is None:
                    continue
                line_idx = int(line_key) - 1  # Convert to 0-based
                cand_idx = match_data.get("candidate_index", -1)
                if 0 <= cand_idx < len(candidates):
                    candidate = candidates[cand_idx]
                    matches[line_idx] = {
                        **candidate,
                        "match_confidence": match_data.get("confidence", 0.5),
                        "match_reason": match_data.get("reason", ""),
                    }
            return matches

        except (json.JSONDecodeError, ValueError) as e:
            logger.error(f"Failed to parse matching response: {e}")
            return {}

    def _simple_keyword_match(
        self, script_line: str, candidates: List[Dict]
    ) -> Optional[Dict]:
        """Simple fallback: match by keyword overlap when LLM is unavailable."""
        script_words = set(script_line.lower().split())
        best_score = 0
        best_candidate = None

        for c in candidates:
            excerpt_words = set(c.get("cleaned_excerpt", "").lower().split())
            # Check for overlapping meaningful words (>3 chars)
            meaningful_script = {w for w in script_words if len(w) > 3}
            meaningful_excerpt = {w for w in excerpt_words if len(w) > 3}
            overlap = len(meaningful_script & meaningful_excerpt)
            if overlap > best_score:
                best_score = overlap
                best_candidate = {
                    **c,
                    "match_confidence": min(0.5, overlap * 0.1),
                    "match_reason": f"Keyword overlap: {overlap} words",
                }

        return best_candidate if best_score > 0 else None

    # ── FFmpeg Cut Execution ──

    async def execute_cut(
        self,
        cuts: List[CutSegment],
        output_path: str,
        progress: Optional[ProgressReporter] = None,
    ) -> str:
        """Execute the cut plan using FFmpeg to produce the final clean video.

        Args:
            cuts: List of cut segments to concatenate
            output_path: Path for the output video file
            progress: Progress reporter

        Returns:
            Path to the output video
        """
        if not cuts:
            raise ValueError("No cut segments to process")

        if progress:
            await progress.start("Preparing cut segments...")

        # Create a concat file for FFmpeg
        temp_dir = Path(self.settings.MEDIA_CACHE_DIR) / f"cut_{uuid.uuid4().hex[:8]}"
        temp_dir.mkdir(parents=True, exist_ok=True)

        try:
            # Extract each segment as a separate file
            segment_files = []
            for i, cut in enumerate(cuts):
                if progress:
                    await progress.step(i + 1, len(cuts), f"Extracting segment {i+1}/{len(cuts)}...")

                seg_path = temp_dir / f"seg_{i:04d}.mp4"
                duration = cut.end - cut.start

                cmd = [
                    self.settings.FFMPEG_PATH, "-y",
                    "-i", cut.source_file,
                    "-ss", str(cut.start),
                    "-t", str(duration),
                    "-c:v", "libx264", "-preset", "fast",
                    "-c:a", "aac", "-b:a", "128k",
                    "-avoid_negative_ts", "make_zero",
                    str(seg_path),
                ]

                try:
                    proc = await run_ffmpeg_async(cmd, timeout=300)
                except subprocess.TimeoutExpired:
                    logger.warning(f"FFmpeg segment extraction timed out for cut {i}")
                    continue
                if proc.returncode != 0:
                    logger.warning(f"FFmpeg segment extraction failed: {(proc.stderr or '')[:200]}")
                    continue
                segment_files.append(str(seg_path))

            if not segment_files:
                raise RuntimeError("Failed to extract any segments")

            # Create concat list file
            concat_file = temp_dir / "concat.txt"
            with open(concat_file, "w", encoding="utf-8") as f:
                for seg_path in segment_files:
                    # Escape single quotes for ffmpeg concat demuxer
                    safe = seg_path.replace("'", "'\\''")
                    f.write(f"file '{safe}'\n")

            # Concatenate all segments
            if progress:
                await progress.update(0.9, "Concatenating segments...")

            output = Path(output_path)
            output.parent.mkdir(parents=True, exist_ok=True)

            cmd = [
                self.settings.FFMPEG_PATH, "-y",
                "-f", "concat", "-safe", "0",
                "-i", str(concat_file),
                "-c:v", "libx264", "-preset", "medium",
                "-c:a", "aac", "-b:a", "128k",
                str(output),
            ]

            proc = await run_ffmpeg_async(cmd, timeout=600)
            if proc.returncode != 0:
                raise RuntimeError(f"FFmpeg concatenation failed: {(proc.stderr or '')[:500]}")

            if progress:
                await progress.complete(f"Clean cut video saved to {output_path}")

            return str(output)

        finally:
            # Clean up temp files
            try:
                shutil.rmtree(temp_dir, ignore_errors=True)
            except Exception:
                pass

    # ── Visual Placement ──

    async def place_visuals(
        self,
        request: VisualMapRequest,
        progress: Optional[ProgressReporter] = None,
    ) -> VisualPlacementResult:
        """Place visuals on a cut video based on a mapping document.

        Takes a mapping (from docx/txt) that specifies which script line should
        have which visual, along with a folder of visual assets, and produces
        a final video with visuals placed at the correct positions.

        Args:
            request: Visual map request with entries and visual folder
            progress: Progress reporter

        Returns:
            VisualPlacementResult with placement details
        """
        if progress:
            await progress.start("Processing visual map...")

        # If document_content is provided instead of structured entries, parse it
        entries = request.entries
        if not entries and request.document_content:
            entries = self._parse_visual_document(request.document_content)
            if not entries:
                return VisualPlacementResult(
                    success=False,
                    message="Could not parse any visual mappings from the document.",
                )

        if not entries:
            return VisualPlacementResult(
                success=False,
                message="No visual map entries provided.",
            )

        # Resolve visual files from the folder
        visual_folder = Path(request.visual_folder)
        if not visual_folder.exists():
            return VisualPlacementResult(
                success=False,
                message=f"Visual folder not found: {request.visual_folder}",
            )

        # Map visual filenames to full paths
        visual_files = {}
        for ext in ["*.png", "*.jpg", "*.jpeg", "*.bmp", "*.webp", "*.mp4", "*.mov"]:
            for f in visual_folder.glob(ext):
                visual_files[f.name.lower()] = str(f)
                visual_files[f.stem.lower()] = str(f)  # Also index by stem (without extension)

        if progress:
            await progress.update(0.2, f"Found {len(visual_files)} visual files. Processing {len(entries)} placements...")

        # Get the cutting result to find timestamps for each script line
        video_path = request.video_output_path
        if not video_path or not Path(video_path).exists():
            return VisualPlacementResult(
                success=False,
                message="Cut video not found. Run the cutting pipeline first.",
            )

        # Get transcript segments with timestamps from the cut video
        # We need to find which timestamps correspond to which script lines
        # Load the cutting result to get the mapping
        cutting_results = sqlite_registry.fetch_all(
            "SELECT * FROM cutting_results ORDER BY created_at DESC LIMIT 1"
        )
        if not cutting_results:
            return VisualPlacementResult(
                success=False,
                message="No cutting result found. Run the cutting pipeline first.",
            )

        cuts_data = sqlite_registry.loads(cutting_results[0].get("cuts", "[]"), [])
        if not cuts_data:
            return VisualPlacementResult(
                success=False,
                message="No cut segments found in the latest cutting result.",
            )

        # Build line-to-timestamp mapping
        line_timestamps = {}
        current_time = 0.0
        for cut_data in cuts_data:
            duration = cut_data.get("end", 0) - cut_data.get("start", 0)
            script_line = cut_data.get("script_line", "")
            if script_line:
                line_timestamps[script_line.strip()] = {
                    "start": current_time,
                    "end": current_time + duration,
                }
            current_time += duration

        # Place each visual at the right timestamp
        placed = 0
        missing = []
        overlay_inputs = []

        for entry in entries:
            # Find the visual file
            visual_path = self._resolve_visual_file(entry.visual_file, visual_files)
            if not visual_path:
                missing.append(entry.visual_file)
                continue

            # Find the timestamp for this script line
            timestamp = self._find_timestamp_for_line(entry, line_timestamps)
            if not timestamp:
                missing.append(f"Line {entry.line_number}: {entry.line_text[:50]}")
                continue

            overlay_inputs.append({
                "visual_path": visual_path,
                "start": timestamp["start"],
                "end": timestamp["end"],
                "placement": entry.placement_note or "overlay",
                "line_number": entry.line_number,
            })
            placed += 1

        if not overlay_inputs:
            return VisualPlacementResult(
                success=False,
                visuals_placed=0,
                visuals_missing=missing,
                message="No visuals could be placed. Check visual filenames and script line mappings.",
            )

        # Execute visual placement using FFmpeg
        if progress:
            await progress.update(0.6, f"Applying {placed} visual overlays...")

        try:
            output_path = str(Path(video_path).with_stem(
                Path(video_path).stem + "_with_visuals"
            ))
            result_path = await self._apply_visual_overlays(
                video_path, overlay_inputs, output_path, progress
            )

            if progress:
                await progress.complete(f"Visual placement complete: {placed} visuals placed")

            return VisualPlacementResult(
                success=True,
                output_path=result_path,
                visuals_placed=placed,
                visuals_missing=missing,
                message=f"Successfully placed {placed} visuals. {len(missing)} could not be placed.",
            )

        except Exception as e:
            logger.error(f"Visual overlay failed: {e}")
            return VisualPlacementResult(
                success=False,
                visuals_placed=0,
                visuals_missing=missing,
                message=f"Visual overlay failed: {e}",
            )

    def _parse_visual_document(self, content: str) -> List[VisualMapEntry]:
        """Parse a visual mapping document (from docx/txt) into structured entries.

        Expected format per line:
        Line <number>: <visual_filename> [placement_note]
        OR
        <line_number>|<visual_filename>|<placement_note>
        OR free-form with "line X" and filename references
        """
        entries = []
        lines = content.strip().split("\n")

        for line in lines:
            line = line.strip()
            if not line or line.startswith("#"):
                continue

            # Try pipe-delimited format: 1|image.png|overlay
            pipe_match = re.match(r"^(\d+)\s*\|\s*(.+?)\s*(?:\|\s*(.+))?$", line)
            if pipe_match:
                entries.append(VisualMapEntry(
                    line_number=int(pipe_match.group(1)),
                    visual_file=pipe_match.group(2).strip(),
                    placement_note=pipe_match.group(3).strip() if pipe_match.group(3) else "overlay",
                ))
                continue

            # Try "Line X: filename" format
            line_match = re.match(r"^Line\s+(\d+)\s*[:\-]\s*(.+?)(?:\s*\((.+?)\))?$", line, re.IGNORECASE)
            if line_match:
                entries.append(VisualMapEntry(
                    line_number=int(line_match.group(1)),
                    visual_file=line_match.group(2).strip(),
                    placement_note=line_match.group(3).strip() if line_match.group(3) else "overlay",
                ))
                continue

            # Try "X - filename (placement)" format
            dash_match = re.match(r"^(\d+)\s*[\.\-]\s*(.+?)(?:\s*\((.+?)\))?$", line)
            if dash_match:
                entries.append(VisualMapEntry(
                    line_number=int(dash_match.group(1)),
                    visual_file=dash_match.group(2).strip(),
                    placement_note=dash_match.group(3).strip() if dash_match.group(3) else "overlay",
                ))
                continue

        return entries

    def _resolve_visual_file(self, filename: str, visual_files: Dict[str, str]) -> Optional[str]:
        """Resolve a visual filename to its full path."""
        # Try exact match
        lower = filename.lower().strip()
        if lower in visual_files:
            return visual_files[lower]

        # Try with common extensions
        for ext in [".png", ".jpg", ".jpeg", ".mp4", ".mov"]:
            key = lower + ext
            if key in visual_files:
                return visual_files[key]

        # Try stem match (filename without extension)
        stem = Path(lower).stem
        if stem in visual_files:
            return visual_files[stem]

        # Try partial match
        for key, path in visual_files.items():
            if lower in key or key in lower:
                return path

        return None

    def _find_timestamp_for_line(
        self, entry: VisualMapEntry, line_timestamps: Dict[str, Dict]
    ) -> Optional[Dict]:
        """Find the timestamp range for a given script line in the cut video."""
        # Try exact match
        if entry.line_text and entry.line_text.strip() in line_timestamps:
            return line_timestamps[entry.line_text.strip()]

        # Try partial match
        for line_text, timestamp in line_timestamps.items():
            if entry.line_text and (
                entry.line_text.strip().lower() in line_text.lower()
                or line_text.lower() in entry.line_text.strip().lower()
            ):
                return timestamp

        # If line_number is provided, try to find by index
        if entry.line_number > 0:
            keys = list(line_timestamps.keys())
            idx = entry.line_number - 1
            if 0 <= idx < len(keys):
                return line_timestamps[keys[idx]]

        return None

    async def _apply_visual_overlays(
        self,
        video_path: str,
        overlays: List[Dict],
        output_path: str,
        progress: Optional[ProgressReporter] = None,
    ) -> str:
        """Apply visual overlays to a video using FFmpeg via sequential passes.

        For image overlays: displays the image over the video during the time range.
        For video overlays: cuts away to the overlay video for the time range.
        """
        # Probe duration once off the event loop; it only changes after a successful pass.
        current_duration = await asyncio.to_thread(get_duration, video_path)
        if current_duration <= 0:
            raise ValueError("Cannot determine video duration")

        current_video = video_path
        temp_dir = Path(self.settings.MEDIA_CACHE_DIR) / f"visuals_{uuid.uuid4().hex[:8]}"
        temp_dir.mkdir(parents=True, exist_ok=True)

        try:
            for i, overlay in enumerate(overlays):
                if progress:
                    await progress.update(
                        0.6 + 0.3 * (i / max(len(overlays), 1)),
                        f"Applying visual {i+1}/{len(overlays)}...",
                    )

                visual_path = overlay["visual_path"]
                start = float(overlay.get("start", 0) or 0)
                end = min(float(overlay.get("end", 0) or 0), current_duration)
                duration = end - start

                if duration <= 0:
                    continue

                is_video_file = Path(visual_path).suffix.lower() in [".mp4", ".mov", ".mkv", ".avi", ".webm"]
                temp_output = temp_dir / f"step_{i:04d}.mp4"

                if is_video_file:
                    # Cutaway: before visual → visual → after visual
                    cmd = [
                        self.settings.FFMPEG_PATH, "-y",
                        "-i", current_video,
                        "-i", visual_path,
                        "-filter_complex",
                        (
                            f"[0:v]split=3[before][mid][after];"
                            f"[before]trim=end={start},setpts=PTS-STARTPTS[v1];"
                            f"[1:v]trim=0:{duration},scale=main_w:main_h,setpts=PTS-STARTPTS[v2];"
                            f"[after]trim=start={end},setpts=PTS-STARTPTS[v3];"
                            f"[v1][v2][v3]concat=n=3:v=1:a=0[outv]"
                        ),
                        "-map", "[outv]", "-map", "0:a?",
                        "-c:v", "libx264", "-preset", "fast",
                        "-c:a", "aac", "-b:a", "128k",
                        str(temp_output),
                    ]
                else:
                    # Image overlay: show image on top of video during the time range
                    cmd = [
                        self.settings.FFMPEG_PATH, "-y",
                        "-i", current_video,
                        "-i", visual_path,
                        "-filter_complex",
                        (
                            f"[1:v]scale=main_w:main_h[img];"
                            f"[0:v][img]overlay=enable='between(t,{start},{end})':format=auto[outv]"
                        ),
                        "-map", "[outv]", "-map", "0:a?",
                        "-c:v", "libx264", "-preset", "fast",
                        "-c:a", "aac", "-b:a", "128k",
                        str(temp_output),
                    ]

                try:
                    proc = await run_ffmpeg_async(cmd, timeout=600)
                except subprocess.TimeoutExpired:
                    logger.warning(f"Visual overlay step {i} timed out")
                    continue

                if proc.returncode == 0 and temp_output.exists():
                    current_video = str(temp_output)
                    # Duration may have changed after a cutaway pass; refresh once.
                    if is_video_file:
                        current_duration = await asyncio.to_thread(get_duration, current_video)
                else:
                    logger.warning(f"Visual overlay step {i} failed: {(proc.stderr or '')[:200]}")

            # Final copy to output path
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(current_video, output_path)

            return output_path

        finally:
            try:
                shutil.rmtree(temp_dir, ignore_errors=True)
            except Exception:
                pass


# Global service instance
cutting_pipeline = CuttingPipelineService()
