"""
EditFlow AI - Visual Library Service
Manages multi-folder raw data ingestion, persistent indexing, video quality scoring,
thumbnail caching, embedded visual extraction, and fast semantic querying.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import shutil
import tempfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple
from PIL import Image

from ..config import get_settings
from ..utils.ffmpeg_utils import extract_frames, get_duration, get_media_info, has_audio
from ..utils.subprocess_utils import run_silent
from .embedded_visual_detector import EmbeddedVisual, embedded_visual_detector
from .visual_quality_scorer import FrameQuality, VisualQualityScorer, visual_quality_scorer

logger = logging.getLogger(__name__)

VIDEO_EXTS: Set[str] = {
    ".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm",
    ".3gp", ".wmv", ".flv", ".ts", ".mts", ".m2ts"
}
IMAGE_EXTS: Set[str] = {
    ".png", ".jpg", ".jpeg", ".webp", ".tiff", ".bmp", ".gif"
}
TRANSCRIPT_EXTS: Set[str] = {".json", ".srt", ".txt", ".vtt"}


@dataclass
class VisualItem:
    id: str                             # Unique hash id
    path: str                           # Absolute path on disk
    filename: str                       # Base filename
    stem: str                           # Clean stem without extension
    folder_path: str                    # Parent folder path
    file_type: str                      # 'video' or 'image'
    category: str                       # 'pure_broll', 'demonstration_broll', 'talking_head', 'still_graphic'
    duration: float                     # Seconds
    resolution: Optional[str] = None    # "1080x1920", "1920x1080", etc.
    aspect_ratio: str = "16:9"          # "9:16", "16:9", "1:1", "4:5"
    fps: float = 30.0
    has_audio: bool = False
    quality_score: float = 100.0        # Composite sharpness & exposure score
    recommended_in: float = 0.0         # Best in point (seconds)
    recommended_out: float = 4.0        # Best out point (seconds)
    recommended_duration: float = 4.0   # Out - In
    thumbnail_path: Optional[str] = None
    tags: List[str] = field(default_factory=list)
    embedded_visuals: List[Dict[str, Any]] = field(default_factory=list)
    speaker: Optional[str] = None
    mtime: float = 0.0
    size_bytes: int = 0
    # Verified / vision-model metadata (see Visual_Library/ground_truth.json + shot_log.jsonl)
    description: Optional[str] = None
    setting: Optional[str] = None
    concepts: List[str] = field(default_factory=list)
    verified: bool = False
    ai_generated: bool = False
    banned: bool = False

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        return d


@dataclass
class LibraryFolder:
    path: str
    name: str
    brand: str = ""
    total_assets: int = 0
    broll_count: int = 0
    talking_head_count: int = 0
    transcribed_count: int = 0
    last_indexed: Optional[str] = None
    is_active: bool = True

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class VisualLibraryService:
    """
    Central manager for the user's Visual Library across raw data folders.
    """

    def __init__(self, base_dir: Optional[Path] = None):
        self.base_dir = base_dir or Path("data/visual_library")
        self.thumbs_dir = self.base_dir / "thumbs"
        self.config_file = self.base_dir / "folders_config.json"
        self.index_file = self.base_dir / "library_index.json"

        self._folders: Dict[str, LibraryFolder] = {}
        self._items: Dict[str, VisualItem] = {}
        self._initialized: bool = False

    def _ensure_dirs(self):
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.thumbs_dir.mkdir(parents=True, exist_ok=True)

    def initialize(self):
        if self._initialized:
            return
        self._ensure_dirs()
        self._load_config()
        self._load_index()
        self._initialized = True

    @staticmethod
    def infer_brand_from_path(path_str: str) -> str:
        if not path_str:
            return ""
        norm = os.path.normpath(path_str)
        parts = norm.split(os.sep)
        for i, part in enumerate(parts):
            if part.upper() == "MARKETING" and i + 1 < len(parts):
                return parts[i + 1]
        return ""

    def _load_config(self):
        if self.config_file.exists():
            try:
                data = json.loads(self.config_file.read_text(encoding="utf-8"))
                folders = {}
                for f in data.get("folders", []):
                    brand = f.get("brand") or self.infer_brand_from_path(f.get("path", ""))
                    lf = LibraryFolder(
                        path=f.get("path", ""),
                        name=f.get("name", ""),
                        brand=brand,
                        total_assets=f.get("total_assets", 0),
                        broll_count=f.get("broll_count", 0),
                        talking_head_count=f.get("talking_head_count", 0),
                        transcribed_count=f.get("transcribed_count", 0),
                        last_indexed=f.get("last_indexed"),
                        is_active=f.get("is_active", True),
                    )
                    folders[lf.path] = lf
                self._folders = folders
            except Exception as e:
                logger.warning(f"[visual_library] Failed to load folders_config.json: {e}")
                self._folders = {}

    def _save_config(self):
        self._ensure_dirs()
        data = {"folders": [f.to_dict() for f in self._folders.values()]}
        self.config_file.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def _load_index(self):
        if self.index_file.exists():
            try:
                data = json.loads(self.index_file.read_text(encoding="utf-8"))
                self._items = {
                    item["id"]: VisualItem(**item) for item in data.get("items", [])
                }
            except Exception as e:
                logger.warning(f"[visual_library] Failed to load library_index.json: {e}")
                self._items = {}

    def _save_index(self):
        self._ensure_dirs()
        data = {
            "version": 1,
            "total_items": len(self._items),
            "items": [item.to_dict() for item in self._items.values()],
        }
        self.index_file.write_text(json.dumps(data, indent=2), encoding="utf-8")

    # ── Folder Management ────────────────────────────────────────────────────────

    def list_folders(self, brand: Optional[str] = None) -> List[Dict[str, Any]]:
        self.initialize()
        self._load_config()
        folders = list(self._folders.values())
        if brand and brand.lower() not in ("all", "", "null", "undefined"):
            folders = [f for f in folders if f.brand.lower() == brand.lower()]
        return [f.to_dict() for f in folders]

    def list_brands(self) -> List[str]:
        self.initialize()
        self._load_config()
        brands = set()
        for f in self._folders.values():
            if f.brand:
                brands.add(f.brand)
        # Scan D:\MARKETING
        marketing_dir = r"D:\MARKETING"
        if os.path.isdir(marketing_dir):
            try:
                for entry in os.scandir(marketing_dir):
                    if entry.is_dir() and not entry.name.startswith(".") and entry.name.lower() not in ("data", "other", "delivered"):
                        brands.add(entry.name)
            except Exception as e:
                logger.warning(f"[visual_library] Error discovering brands: {e}")
        return sorted(list(brands))

    def add_folder(self, folder_path: str, brand: Optional[str] = None, auto_analyze: bool = True) -> Dict[str, Any]:
        """Add a raw data folder to the visual library and optionally analyze it."""
        self.initialize()
        folder_path = folder_path.strip().strip('"').strip("'")
        norm_path = os.path.normpath(os.path.abspath(folder_path))
        if not os.path.isdir(norm_path):
            return {"success": False, "error": f"Directory does not exist: {norm_path}"}

        folder_name = os.path.basename(norm_path) or norm_path
        detected_brand = brand or self.infer_brand_from_path(norm_path)
        folder = LibraryFolder(
            path=norm_path,
            name=folder_name,
            brand=detected_brand,
            is_active=True
        )
        self._folders[norm_path] = folder
        self._save_config()

        res = {"success": True, "folder": folder.to_dict()}
        if auto_analyze:
            stats = self.analyze_folder(norm_path)
            res["analysis"] = stats

        return res

    def remove_folder(self, folder_path: str) -> Dict[str, Any]:
        """Remove a raw data folder from the visual library (without deleting files on disk)."""
        self.initialize()
        norm_path = os.path.normpath(os.path.abspath(folder_path))
        if norm_path in self._folders:
            del self._folders[norm_path]
            self._save_config()

            # Remove indexed items belonging to this folder
            to_del = [item_id for item_id, item in self._items.items() if item.folder_path == norm_path or item.path.startswith(norm_path)]
            for item_id in to_del:
                del self._items[item_id]
            self._save_index()
            return {"success": True, "removed_items": len(to_del)}

        return {"success": False, "error": f"Folder not found in library: {norm_path}"}

    # ── Analysis & Indexing Pipeline ─────────────────────────────────────────────

    def analyze_all(self, force: bool = False) -> Dict[str, Any]:
        """Analyze all active raw data folders."""
        self.initialize()
        total_indexed = 0
        total_broll = 0
        folder_stats = []

        for folder_path, folder in list(self._folders.items()):
            if folder.is_active:
                stats = self.analyze_folder(folder_path, force=force)
                total_indexed += stats.get("indexed_count", 0)
                total_broll += stats.get("broll_count", 0)
                folder_stats.append(stats)

        return {
            "success": True,
            "total_folders": len(folder_stats),
            "total_indexed": total_indexed,
            "total_broll": total_broll,
            "folders": folder_stats,
        }

    def analyze_folder(self, folder_path: str, force: bool = False) -> Dict[str, Any]:
        """
        Deep-scan a single raw data folder:
        - Probes metadata, aspect ratio, audio.
        - Computes Laplacian sharpness & exposure across frames.
        - Identifies Golden Section (recommended in/out points).
        - Detects embedded visual demonstration cues in transcripts.
        - Generates and caches thumbnail.
        """
        self.initialize()
        norm_path = os.path.normpath(os.path.abspath(folder_path))
        if not os.path.isdir(norm_path):
            return {"success": False, "error": f"Directory not found: {norm_path}"}

        folder_name = os.path.basename(norm_path) or norm_path
        indexed_count = 0
        broll_count = 0
        talking_head_count = 0
        transcribed_count = 0

        # Scan all video and image files in folder
        for root, dirs, files in os.walk(norm_path):
            transcripts_by_stem: Dict[str, str] = {}
            for f in files:
                ext = os.path.splitext(f)[1].lower()
                if ext in TRANSCRIPT_EXTS:
                    stem = os.path.splitext(f)[0].lower()
                    transcripts_by_stem[stem] = os.path.join(root, f)

            for f in files:
                ext = os.path.splitext(f)[1].lower()
                if ext not in VIDEO_EXTS and ext not in IMAGE_EXTS:
                    continue

                full_path = os.path.join(root, f)
                file_stem = os.path.splitext(f)[0].lower()
                if file_stem in transcripts_by_stem:
                    transcribed_count += 1

                try:
                    stat = os.stat(full_path)
                    item_id = hashlib.md5(full_path.lower().encode("utf-8")).hexdigest()

                    # Check incremental cache
                    existing = self._items.get(item_id)
                    if existing and not force and existing.mtime == stat.st_mtime and existing.size_bytes == stat.st_size:
                        indexed_count += 1
                        if existing.category in ("pure_broll", "demonstration_broll", "still_graphic"):
                            broll_count += 1
                        elif existing.category == "talking_head":
                            talking_head_count += 1
                        continue

                    # Analyze the media file
                    item = self._analyze_file(full_path, stat, transcripts_by_stem)
                    if item:
                        self._items[item.id] = item
                        indexed_count += 1
                        if item.category in ("pure_broll", "demonstration_broll", "still_graphic"):
                            broll_count += 1
                        elif item.category == "talking_head":
                            talking_head_count += 1

                except Exception as e:
                    logger.warning(f"[visual_library] Error analyzing file {full_path}: {e}")

        # Update folder metadata
        from datetime import datetime, timezone
        now_iso = datetime.now(timezone.utc).isoformat()
        if norm_path in self._folders:
            self._folders[norm_path].total_assets = indexed_count
            self._folders[norm_path].broll_count = broll_count
            self._folders[norm_path].talking_head_count = talking_head_count
            self._folders[norm_path].transcribed_count = transcribed_count
            self._folders[norm_path].last_indexed = now_iso
            self._save_config()

        self._save_index()

        return {
            "success": True,
            "folder": norm_path,
            "indexed_count": indexed_count,
            "broll_count": broll_count,
        }

    def _analyze_file(
        self,
        full_path: str,
        stat: os.stat_result,
        transcripts_by_stem: Dict[str, str],
    ) -> Optional[VisualItem]:
        """Analyze an individual video or image file."""
        fname = os.path.basename(full_path)
        stem, ext = os.path.splitext(fname)
        ext = ext.lower()
        item_id = hashlib.md5(full_path.lower().encode("utf-8")).hexdigest()
        is_video = ext in VIDEO_EXTS
        file_type = "video" if is_video else "image"

        # 1. Technical metadata
        duration = 0.0
        width = 1920
        height = 1080
        fps = 30.0
        has_aud = False

        if is_video:
            try:
                info = get_media_info(full_path)
                duration = float(info.get("duration") or 0.0)
                fps = float(info.get("fps") or 30.0)
                has_aud = bool(info.get("has_audio"))
                width = int(info.get("width") or 1920)
                height = int(info.get("height") or 1080)
            except Exception:
                duration = 5.0
        else:
            # Image file
            try:
                with Image.open(full_path) as im:
                    width, height = im.size
                duration = 5.0
            except Exception:
                pass

        # Calculate aspect ratio
        if height > 0:
            ratio = width / height
            if ratio < 0.7:
                aspect_ratio = "9:16"
            elif ratio > 1.4:
                aspect_ratio = "16:9"
            elif 0.95 <= ratio <= 1.05:
                aspect_ratio = "1:1"
            elif 0.75 <= ratio <= 0.85:
                aspect_ratio = "4:5"
            else:
                aspect_ratio = f"{round(ratio, 2)}:1"
        else:
            aspect_ratio = "16:9"

        # 2. Thumbnail & Quality Scoring
        thumb_filename = f"{item_id}.jpg"
        thumb_path = self.thumbs_dir / thumb_filename
        quality_score = 100.0
        recommended_in = 0.0
        recommended_out = min(4.0, duration if duration > 0 else 4.0)

        if is_video and duration > 0:
            frame_qualities: List[FrameQuality] = []
            extracted_frames = []

            # Extract 3-4 representative frames for quality analysis & thumbnail
            try:
                ffmpeg_bin = get_settings().FFMPEG_PATH
                num_samples = 3 if duration <= 8.0 else 4
                sample_interval = duration / (num_samples + 1)

                with tempfile.TemporaryDirectory() as tmpdir:
                    for i in range(num_samples):
                        ts = sample_interval * (i + 1)
                        fpath = Path(tmpdir) / f"frame_{i}.jpg"
                        cmd = [
                            ffmpeg_bin, "-y", "-ss", str(round(ts, 2)), "-i", full_path,
                            "-vframes", "1", "-s", "480x270", "-q:v", "5", str(fpath)
                        ]
                        run_silent(cmd, timeout=8)
                        if fpath.exists():
                            with Image.open(fpath) as frame_im:
                                q = VisualQualityScorer.score_frame(frame_im, timestamp=ts)
                                frame_qualities.append(q)
                                extracted_frames.append((q.composite_score, fpath))

                    # Find golden section
                    golden = VisualQualityScorer.find_golden_section(
                        frame_qualities, total_duration=duration, target_duration=4.0
                    )
                    recommended_in = golden.recommended_in
                    recommended_out = golden.recommended_out
                    quality_score = golden.average_quality

                    # Save best frame as primary thumbnail
                    if extracted_frames:
                        extracted_frames.sort(key=lambda x: x[0], reverse=True)
                        best_frame_path = extracted_frames[0][1]
                        shutil.copyfile(str(best_frame_path), str(thumb_path))

            except Exception as e:
                logger.warning(f"[visual_library] Error extracting frames for {full_path}: {e}")

        elif not is_video:
            # Generate thumbnail for image
            try:
                with Image.open(full_path) as im:
                    im.thumbnail((640, 360))
                    im.convert("RGB").save(str(thumb_path), "JPEG", quality=85)
                    q = VisualQualityScorer.score_frame(im)
                    quality_score = q.composite_score
            except Exception:
                pass

        # 3. Embedded Visual Detection & Transcript Linking
        embedded_visuals: List[Dict[str, Any]] = []
        transcript_text = ""
        matching_transcript_path = transcripts_by_stem.get(stem.lower())
        if matching_transcript_path and os.path.exists(matching_transcript_path):
            try:
                cues = self._parse_transcript_cues(matching_transcript_path)
                if cues:
                    transcript_text = " ".join([c.get("text", "") for c in cues])
                    evs = EmbeddedVisualDetector.extract_visual_segments(
                        cues, source_file=full_path, clip_stem=stem
                    )
                    embedded_visuals = [ev.to_dict() for ev in evs]
            except Exception as e:
                logger.warning(f"[visual_library] Error parsing transcript {matching_transcript_path}: {e}")

        # 4. Semantic Categorization & Tagging
        path_lower = full_path.lower()
        has_broll_keyword = any(k in path_lower for k in ("visual", "b-roll", "broll", "drone", "exterior", "cutaway", "stills", "whatsapp", "raw", "lot", "parking", "scene", "overlay", "footage", "shot", "clip", "cinematic"))
        has_interview_keyword = any(k in path_lower for k in ("interview", "talking", "speaker", "speech", "podcast", "qa", "q&a"))
        has_dialogue = bool(transcript_text.strip())

        if not is_video:
            category = "still_graphic"
        elif embedded_visuals:
            category = "demonstration_broll"
        elif has_broll_keyword or not has_aud or not has_dialogue:
            category = "pure_broll"
        elif has_interview_keyword:
            category = "talking_head"
        else:
            category = "pure_broll" if duration < 45.0 else "talking_head"

        # Extract semantic tags from path, stem, and transcript
        tags = self._extract_tags(full_path, stem, transcript_text, category)

        rel_thumb = f"api/visual-library/thumb/{item_id}" if thumb_path.exists() else None

        return VisualItem(
            id=item_id,
            path=full_path,
            filename=fname,
            stem=stem,
            folder_path=os.path.dirname(full_path),
            file_type=file_type,
            category=category,
            duration=round(duration, 2),
            resolution=f"{width}x{height}",
            aspect_ratio=aspect_ratio,
            fps=round(fps, 2),
            has_audio=has_aud,
            quality_score=round(quality_score, 1),
            recommended_in=round(recommended_in, 2),
            recommended_out=round(recommended_out, 2),
            recommended_duration=round(recommended_out - recommended_in, 2),
            thumbnail_path=rel_thumb,
            tags=tags,
            embedded_visuals=embedded_visuals,
            mtime=stat.st_mtime,
            size_bytes=stat.st_size,
        )

    def _extract_tags(self, full_path: str, stem: str, transcript_text: str, category: str) -> List[str]:
        """Extract searchable keywords and semantic tags."""
        tags = set()
        if category in ("pure_broll", "demonstration_broll"):
            tags.add("broll")
        if category == "demonstration_broll":
            tags.add("demonstration")
        if category == "still_graphic":
            tags.add("graphic")
            tags.add("still")

        # Clean words from filename and folder
        clean_text = re.sub(r"[^\w\s]", " ", f"{stem} {os.path.dirname(full_path)} {transcript_text[:200]}")
        stopwords = {"video", "final", "file", "cut", "clip", "raw", "data", "marketing", "mp4", "mov", "the", "and"}
        for word in re.findall(r"\b[a-zA-Z]{3,}\b", clean_text.lower()):
            if word not in stopwords and not word.isdigit():
                tags.add(word)

        return sorted(list(tags))[:15]

    def _parse_transcript_cues(self, path: str) -> List[Dict[str, Any]]:
        """Parse cues from SRT, VTT, or transcript JSON."""
        cues = []
        ext = os.path.splitext(path)[1].lower()
        try:
            if ext == ".json":
                data = json.loads(Path(path).read_text(encoding="utf-8"))
                # Handle Whisper JSON format: {"segments": [{"start": 0.0, "end": 4.5, "text": "..."}]}
                if "segments" in data:
                    for seg in data["segments"]:
                        cues.append({
                            "start": float(seg.get("start", 0.0)),
                            "end": float(seg.get("end", 0.0)),
                            "text": seg.get("text", "").strip(),
                        })
            elif ext in (".srt", ".vtt"):
                content = Path(path).read_text(encoding="utf-8", errors="ignore")
                blocks = re.split(r"\n\s*\n", content.strip())
                for b in blocks:
                    lines = b.strip().splitlines()
                    for line in lines:
                        time_match = re.search(r"(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})", line)
                        if time_match:
                            start_s = self._time_to_seconds(time_match.group(1))
                            end_s = self._time_to_seconds(time_match.group(2))
                            text_lines = [l for l in lines if "-->" not in l and not l.strip().isdigit()]
                            text = " ".join(text_lines).strip()
                            if text:
                                cues.append({"start": start_s, "end": end_s, "text": text})
                            break
        except Exception:
            pass
        return cues

    def _time_to_seconds(self, t_str: str) -> float:
        parts = t_str.replace(",", ".").split(":")
        if len(parts) == 3:
            return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
        elif len(parts) == 2:
            return float(parts[0]) * 60 + float(parts[1])
        return 0.0

    # ── Query & Search ───────────────────────────────────────────────────────────

    def query_items(
        self,
        query: str = "",
        category: str = "all",
        folder: str = "",
        aspect_ratio: str = "",
        min_quality: float = 0.0,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        """Filter and search items in the visual library."""
        self.initialize()
        results: List[VisualItem] = []
        tokens = [t.lower() for t in re.findall(r"\b[a-zA-Z0-9_-]+\b", query) if len(t) > 1]

        for item in self._items.values():
            # Category filter
            if category != "all" and item.category != category:
                continue

            # Folder filter
            if folder and item.folder_path != folder and not item.path.startswith(folder):
                continue

            # Aspect ratio filter
            if aspect_ratio and item.aspect_ratio != aspect_ratio:
                continue

            # Quality threshold
            if min_quality > 0.0 and item.quality_score < min_quality:
                continue

            # Text query match
            if tokens:
                search_corpus = f"{item.filename.lower()} {item.stem.lower()} {' '.join(item.tags)}".lower()
                matches = sum(1 for tok in tokens if tok in search_corpus)
                if matches == 0:
                    continue

            results.append(item)

        # Sort: prefer higher quality score and pure/demonstration broll
        def sort_key(it: VisualItem):
            cat_priority = 3 if it.category == "demonstration_broll" else (2 if it.category == "pure_broll" else 1)
            return (cat_priority, it.quality_score)

        results.sort(key=sort_key, reverse=True)
        return [r.to_dict() for r in results[:limit]]


    async def transcribe_and_index_folder(
        self,
        folder_path: str,
        force: bool = False,
        on_progress: Optional[Any] = None,
    ) -> Dict[str, Any]:
        """
        Transcribe any untranscribed media in the folder and re-index.
        """
        self.initialize()
        norm_path = os.path.normpath(os.path.abspath(folder_path))
        if not os.path.isdir(norm_path):
            return {"success": False, "error": f"Directory not found: {norm_path}"}

        from .whisper_service import whisper_service

        video_files = []
        for root, _, files in os.walk(norm_path):
            for f in files:
                ext = os.path.splitext(f)[1].lower()
                if ext in VIDEO_EXTS:
                    video_files.append(Path(root) / f)

        total_files = len(video_files)
        transcribed_count = 0

        for i, vf in enumerate(video_files):
            sidecar = vf.with_name(vf.stem + ".transcript.json")
            if not sidecar.exists() or force:
                if on_progress:
                    await on_progress({
                        "file": vf.name,
                        "processed": i + 1,
                        "total": total_files,
                        "percent": int(((i + 1) / max(total_files, 1)) * 100),
                        "message": f"Transcribing {vf.name} ({i + 1}/{total_files})..."
                    })
                try:
                    await whisper_service.transcribe(str(vf))
                    transcribed_count += 1
                except Exception as e:
                    logger.error(f"[visual_library] Error transcribing {vf}: {e}")

        stats = self.analyze_folder(norm_path, force=True)
        stats["transcribed_new"] = transcribed_count
        stats["total_videos"] = total_files
        return stats

    def get_thumbnail_file(self, item_id: str) -> Optional[Path]:
        """Return the path to the cached thumbnail file on disk."""
        self.initialize()
        p = self.thumbs_dir / f"{item_id}.jpg"
        return p if p.exists() else None


# Global singleton
visual_library_service = VisualLibraryService()
