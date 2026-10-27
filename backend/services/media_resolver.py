"""
EditFlow AI - Global Media & Speaker Resolver Service
Indexes media assets across project directories (e.g. Jamia Masjid Chicago),
resolves opaque stems (C5032, C6019), handles legacy drive letter remaps (F: -> D:),
parses Person_Crossreference.md for speaker attribution, and matches B-roll cues
using fuzzy folder/file keyword clustering.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

# Video, audio, transcript, and image extensions
VIDEO_EXTS: Set[str] = {".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm"}
AUDIO_EXTS: Set[str] = {".mp3", ".wav", ".aac", ".m4a", ".flac", ".ogg"}
TRANSCRIPT_EXTS: Set[str] = {".json", ".srt", ".txt", ".vtt"}
IMAGE_EXTS: Set[str] = {".png", ".jpg", ".jpeg", ".webp", ".psd", ".tiff", ".bmp"}

# Known B-roll semantic clusters and synonym patterns (handles typos like 'cassans' and 'demoltioed')
BROLL_CLUSTERS: Dict[str, List[str]] = {
    "caissons": [
        "caisson", "caissons", "cassan", "cassans", "phase 2", "phase2", "drilling",
        "deep", "pile", "piling", "steel pile", "74 caissons"
    ],
    "demolition": [
        "demolition", "demolish", "demoltioed", "demolished", "phase 1", "phase1",
        "breaking ground", "rubble", "excavator demolishing"
    ],
    "earth_retention": [
        "earth retention", "retention system", "elevator grade beam", "grade beam",
        "shoring", "pit wall", "rebar", "excavation", "pit"
    ],
    "concrete_trucks": [
        "concrete", "truck", "trucks", "concrete pouring", "pour", "pouring", "mixer",
        "real truck", "ai trucks", "cement", "708 trucks", "1000 trucks", "slab"
    ],
    "drone_aerial": [
        "dji_", "drone", "aerial", "overhead", "flyover", "high angle"
    ],
    "renders_3d": [
        "render", "3d", "3d mosque", "renderings", "architectural", "blueprint",
        "future", "completed", "drawing", "model"
    ],
    "old_mosque_history": [
        "old mosque", "old masjid", "history", "nostalgia", "broken", "20 years",
        "30 years", "legacy", "original"
    ],
    "community_crowd": [
        "crowd", "people", "community", "event", "conference", "prayer", "jummah",
        "attendees", "brothers", "youth"
    ]
}


@dataclass
class MediaItem:
    """Represents an indexed media file on disk."""
    stem: str                       # Normalized filename stem, e.g. "C5032", "DJI_0003"
    name: str                       # Full filename e.g. "C5032.MP4"
    path: str                       # Absolute file path
    file_type: str                  # 'video', 'audio', 'transcript', 'image'
    ext: str                        # File extension with dot e.g. ".mp4"
    subfolder: str = ""             # Relative folder path from indexed root
    speaker: Optional[str] = None   # Attributed speaker name if known
    is_enhanced: bool = False       # True for Adobe Podcast / enhanced audio
    category: str = "general"       # 'talking_head', 'broll', 'render', 'audio', 'transcript'
    file_size: int = 0
    duration: float = 0.0           # Seconds if known or probed
    tags: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class SpeakerInfo:
    """Speaker profile parsed from Person_Crossreference.md."""
    id: int
    name: str                       # e.g. "Anees Ul Rehman"
    title: str                      # e.g. "Community Leader / Project Committee"
    aliases: List[str] = field(default_factory=list)       # ["Anees Bhai", "Anisur Rehman"]
    clip_stems: List[str] = field(default_factory=list)    # ["C6045", "C4182", "C5015", "C5018"]
    themes: str = ""                # e.g. "Demolition phase complete; building fortress..."
    disambiguation_notes: str = ""
    single_voice_rule: bool = False # True for Abdullah (max 1 appearance per script)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ResolvedAudioPair:
    """Co-located video and audio sources for a given clip stem."""
    stem: str
    video_item: Optional[MediaItem] = None
    audio_item: Optional[MediaItem] = None
    enhanced_audio_item: Optional[MediaItem] = None
    transcript_item: Optional[MediaItem] = None
    speaker: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "stem": self.stem,
            "video_item": self.video_item.to_dict() if self.video_item else None,
            "audio_item": self.audio_item.to_dict() if self.audio_item else None,
            "enhanced_audio_item": self.enhanced_audio_item.to_dict() if self.enhanced_audio_item else None,
            "transcript_item": self.transcript_item.to_dict() if self.transcript_item else None,
            "speaker": self.speaker,
        }


class MediaResolverService:
    """
    Core service that indexes, maps, and resolves media files across local project folders.
    Maintains stem-based lookups, cross-era speaker rosters, and fuzzy B-roll clustering.
    """

    def __init__(self, root_dir: Optional[str] = None):
        self.root_dir: Optional[str] = root_dir
        self._media_by_stem: Dict[str, List[MediaItem]] = {}
        self._media_by_clean_stem: Dict[str, List[MediaItem]] = {}
        self._media_by_camera_code: Dict[str, List[MediaItem]] = {}
        self._media_by_path: Dict[str, MediaItem] = {}
        self._speakers: Dict[str, SpeakerInfo] = {}          # Keyed by canonical lower name
        self._speaker_by_clip: Dict[str, SpeakerInfo] = {}   # Keyed by clip stem lower
        self._broll_items: List[MediaItem] = []
        self._indexed: bool = False
        self._cache_dir: Path = Path("data/cache")

    @staticmethod
    def clean_alphanumeric(text: str) -> str:
        """Remove all non-alphanumeric chars and return uppercase string for resilient matching."""
        if not text:
            return ""
        return re.sub(r"[^a-zA-Z0-9]", "", text).upper()

    @property
    def is_indexed(self) -> bool:
        return self._indexed

    def normalize_stem(self, text: str) -> str:
        """Extract a clean, case-insensitive media stem from a name, path, or reference."""
        if not text:
            return ""
        # Strip trailing extension if present
        p = Path(text)
        name = p.stem if p.suffix else p.name
        # Remove typical enhancements/suffixes for stem matching (space, dash, underscore)
        s = re.sub(r"(?i)[-_\s]+(enhanced|v\d+|clean|audio|video|raw).*$", "", name)
        s = re.sub(r"[^\w\s-]", "", s).strip()
        return s.upper()

    def remap_legacy_path(self, raw_path: str) -> str:
        """
        Remap obsolete drive letters (e.g. F:\\ -> D:\\) or clean slashes.
        Also handles forward/backward slash normalization.
        """
        if not raw_path:
            return ""
        p = raw_path.strip().replace("/", "\\")
        # Remap legacy F:\MARKETING to current drive if D:\ exists
        if p.lower().startswith("f:\\marketing\\") and os.path.exists("D:\\MARKETING"):
            p = "D:\\MARKETING\\" + p[13:]
        elif p.lower().startswith("f:\\marketing\\"):
            p = "D:\\MARKETING\\" + p[13:]
        return p

    def index_directory(
        self,
        root_dir: Optional[str] = None,
        force: bool = False,
        scan_subdirs: bool = True,
    ) -> Dict[str, Any]:
        """
        Recursively index all media files and cross-references in the root directory.
        Subsequent calls return the cached state unless force=True.
        """
        if root_dir:
            p = Path(root_dir).resolve()
            # If pointing to an automation or scripts subfolder, walk up to the project root
            # (e.g. D:\MARKETING\Rahima Aziz Foundation) so all footage, B-roll, and transcripts are indexed.
            curr = p
            skip_names = {
                "ai automation", "ai workflow", "scripts", "script gen", "scripts_15_30_45",
                "mix", "mixed with old data", "interviews_talking_heads", "project"
            }
            while curr.name.lower() in skip_names and curr.parent != curr:
                curr = curr.parent
            self.root_dir = str(curr)
        elif not self.root_dir:
            self._cache_dir.mkdir(parents=True, exist_ok=True)
            last_file = self._cache_dir / "last_project.txt"
            if last_file.exists():
                try:
                    last_val = last_file.read_text(encoding="utf-8").strip()
                    if os.path.exists(last_val):
                        self.root_dir = last_val
                except Exception:
                    pass
            if not self.root_dir:
                raf_path = "D:\\MARKETING\\Rahima Aziz Foundation"
                self.root_dir = raf_path if os.path.exists(raf_path) else os.getcwd()

        target_dir = Path(self.root_dir)
        if not target_dir.exists():
            logger.warning(f"[media_resolver] Target directory not found: {self.root_dir}")
            return {
                "success": False,
                "error": f"Directory not found: {self.root_dir}",
                "indexed_files": 0,
            }

        # Remember active project directory
        try:
            self._cache_dir.mkdir(parents=True, exist_ok=True)
            (self._cache_dir / "last_project.txt").write_text(str(target_dir), encoding="utf-8")
        except Exception:
            pass

        # Project-specific disk cache file
        cache_key = hashlib.md5(str(target_dir).lower().encode()).hexdigest()[:12]
        cache_file = self._cache_dir / f"media_index_{cache_key}.json"
        if not force and cache_file.exists():
            try:
                with open(cache_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if data.get("root_dir") == str(target_dir):
                    self._load_from_cache(data)
                    self._indexed = True
                    logger.info(f"[media_resolver] Loaded {len(self._media_by_path)} items from cache for {target_dir}")
                    return self.get_stats()
            except Exception as e:
                logger.warning(f"[media_resolver] Cache load failed ({e}), re-indexing disk")

        # Perform fresh disk crawl
        self._media_by_stem.clear()
        self._media_by_clean_stem.clear()
        self._media_by_camera_code.clear()
        self._media_by_path.clear()
        self._broll_items.clear()
        self._speakers.clear()
        self._speaker_by_clip.clear()

        # Step 1: Discover and parse Person_Crossreference.md
        self._find_and_parse_person_crossreference(target_dir)

        # Step 2: Index all media files
        count = 0
        broll_count = 0
        try:
            for root, dirs, files in os.walk(str(target_dir)):
                rel_dir = os.path.relpath(root, str(target_dir))
                rel_lower = rel_dir.lower()

                for fname in files:
                    ext = os.path.splitext(fname)[1].lower()
                    if ext not in VIDEO_EXTS and ext not in AUDIO_EXTS and ext not in TRANSCRIPT_EXTS and ext not in IMAGE_EXTS:
                        continue

                    full_path = os.path.join(root, fname)
                    stem = Path(fname).stem
                    norm_stem = self.normalize_stem(fname)

                    file_type = "unknown"
                    if ext in VIDEO_EXTS:
                        file_type = "video"
                    elif ext in AUDIO_EXTS:
                        file_type = "audio"
                    elif ext in TRANSCRIPT_EXTS:
                        file_type = "transcript"
                    elif ext in IMAGE_EXTS:
                        file_type = "image"

                    is_enhanced = bool(re.search(r"(?i)[-_]enhanced", fname))
                    category = self._classify_category(fname, rel_lower, file_type)

                    # Lookup speaker from cross-reference or directory name
                    speaker = self._detect_speaker(fname, rel_lower, norm_stem)

                    # Extract tags from path and name
                    tags = self._extract_tags(fname, rel_lower)

                    try:
                        file_size = os.path.getsize(full_path)
                    except OSError:
                        file_size = 0

                    item = MediaItem(
                        stem=norm_stem,
                        name=fname,
                        path=full_path,
                        file_type=file_type,
                        ext=ext,
                        subfolder=rel_dir if rel_dir != "." else "",
                        speaker=speaker,
                        is_enhanced=is_enhanced,
                        category=category,
                        file_size=file_size,
                        tags=tags,
                    )

                    self._media_by_path[full_path.lower()] = item
                    self._media_by_stem.setdefault(norm_stem, []).append(item)
                    clean_k = self.clean_alphanumeric(norm_stem)
                    if clean_k:
                        self._media_by_clean_stem.setdefault(clean_k, []).append(item)
                    cam_match = re.match(r"(?i)^([A-Z]\d{4})\b", norm_stem)
                    if cam_match:
                        self._media_by_camera_code.setdefault(cam_match.group(1).upper(), []).append(item)

                    if category in ("broll", "render") or (file_type == "video" and "visuals" in rel_lower):
                        self._broll_items.append(item)
                        broll_count += 1

                    count += 1

            self._indexed = True
            logger.info(f"[media_resolver] Indexed {count} media files ({broll_count} B-roll) across {self.root_dir}")

            # Save cache to disk
            self._save_to_cache(cache_file, target_dir)

            return self.get_stats()

        except Exception as e:
            logger.error(f"[media_resolver] Failed indexing directory: {e}", exc_info=True)
            return {"success": False, "error": str(e), "indexed_files": count}

    def _classify_category(self, fname: str, rel_path_lower: str, file_type: str) -> str:
        """Classify a file into talking_head, broll, render, audio, or transcript."""
        if file_type == "transcript":
            return "transcript"
        if file_type == "audio":
            return "audio"
        if "render" in fname.lower() or "render" in rel_path_lower or "3d" in fname.lower():
            return "render"
        if "visual" in rel_path_lower or "b-roll" in rel_path_lower or "broll" in rel_path_lower:
            return "broll"
        if any(b in rel_path_lower for b in ["concrete", "truck", "caisson", "cassan", "earth retention", "demolition", "demoltioed"]):
            # If it's an interview / talking head folder inside those, respect talking head
            if "interview" in rel_path_lower or "talking" in rel_path_lower:
                return "talking_head"
            return "broll"
        if re.search(r"^C\d{4}", fname, re.IGNORECASE):
            # Camera files can be talking head or B-roll; check speaker cross-reference
            stem_norm = self.normalize_stem(fname)
            if stem_norm.lower() in self._speaker_by_clip:
                return "talking_head"
            return "broll"
        if "interview" in rel_path_lower or "talking" in rel_path_lower or "voice" in rel_path_lower:
            return "talking_head"
        return "general"

    def _extract_tags(self, fname: str, rel_path_lower: str) -> List[str]:
        """Extract semantic topic tags from path and filename using cluster vocabulary."""
        text = f"{rel_path_lower} {fname.lower()}"
        matched_tags: List[str] = []
        for cluster_name, synonyms in BROLL_CLUSTERS.items():
            for syn in synonyms:
                if syn in text:
                    matched_tags.append(cluster_name)
                    break
        return matched_tags

    def _find_and_parse_person_crossreference(self, root_dir: Path) -> None:
        """Find Person_Crossreference.md anywhere in the project tree and parse it."""
        candidates = list(root_dir.rglob("*Person_Crossreference*.md"))
        if not candidates and root_dir.parent.exists():
            candidates = list(root_dir.parent.rglob("*Person_Crossreference*.md"))

        if not candidates:
            logger.info("[media_resolver] No Person_Crossreference.md found; using folder heuristics")
            return

        ref_file = candidates[0]
        try:
            with open(ref_file, "r", encoding="utf-8") as f:
                content = f.read()
            self._parse_person_crossreference_markdown(content)
            logger.info(f"[media_resolver] Successfully parsed {len(self._speakers)} speakers from {ref_file.name}")
        except Exception as e:
            logger.warning(f"[media_resolver] Failed to parse Person_Crossreference.md: {e}")

    def _parse_person_crossreference_markdown(self, markdown_text: str) -> None:
        """Parse the Markdown table in Person_Crossreference.md into structured SpeakerInfo objects.
        Supports both numbered tables (# | Speaker Name | ...) and entity tables (Person | Files | ...).
        """
        lines = markdown_text.splitlines()
        in_table = False
        col_id: Optional[int] = None
        col_name: Optional[int] = None
        col_title: Optional[int] = None
        col_footage: Optional[int] = None
        col_themes: Optional[int] = None
        auto_id = 1

        for line in lines:
            line_str = line.strip()
            if not line_str.startswith("|"):
                if in_table and line_str and not line_str.startswith("|"):
                    in_table = False
                continue

            parts = [p.strip() for p in line_str.split("|")]
            lower_parts = [p.lower() for p in parts]

            # Detect table header row
            if any(k in p for p in lower_parts for k in ("person", "speaker", "name")) and any(k in p for p in lower_parts for k in ("file", "footage", "clip")):
                in_table = True
                col_id, col_name, col_title, col_footage, col_themes = None, None, None, None, None
                for idx, p in enumerate(lower_parts):
                    if p in ("#", "id", "no", "no."):
                        col_id = idx
                    elif any(k in p for k in ("person", "speaker", "name")) and col_name is None:
                        col_name = idx
                    elif any(k in p for k in ("title", "role", "designation")):
                        col_title = idx
                    elif any(k in p for k in ("file", "footage", "clip")):
                        col_footage = idx
                    elif any(k in p for k in ("theme", "topic", "evidence")):
                        col_themes = idx
                continue

            if in_table and line_str.startswith("|---"):
                continue

            if in_table and col_name is not None and col_footage is not None:
                max_col = max(col_name, col_footage)
                if len(parts) > max_col:
                    raw_name = parts[col_name]
                    raw_footage = parts[col_footage]
                    raw_title = parts[col_title] if col_title is not None and len(parts) > col_title else ""
                    raw_themes = parts[col_themes] if col_themes is not None and len(parts) > col_themes else ""

                    if not raw_name or "---" in raw_name or raw_name.lower().strip() in ("person", "speaker", "speaker name", "name", "#", "id"):
                        continue

                    # Determine speaker ID
                    sp_id = auto_id
                    auto_id += 1
                    if col_id is not None and len(parts) > col_id and parts[col_id].isdigit():
                        sp_id = int(parts[col_id])

                    # Clean name & extract title if formatted like "**Name** — Title / Role"
                    clean_name = raw_name
                    for sep in ("—", "--", " - "):
                        if sep in clean_name:
                            spl = clean_name.split(sep, 1)
                            clean_name = spl[0]
                            if not raw_title:
                                raw_title = spl[1].strip()
                            break

                    clean_name = re.sub(r"[*_]", "", clean_name).strip()
                    aliases: List[str] = []
                    alias_match = re.search(r"\((.+?)\)", clean_name)
                    if alias_match:
                        aliases.append(alias_match.group(1).strip())
                        clean_name = re.sub(r"\(.+?\)", "", clean_name).strip()

                    if not clean_name:
                        continue

                    # Extract all clip stems: C\d{4}, DJI_\d{4}, Video\s+[A-Za-z0-9]+, etc.
                    stems: Set[str] = set()
                    for m in re.findall(r"(?i)\b(C\d{4}(?:[_\s]\d{2})?|DJI_\d{4})\b", raw_footage):
                        m_clean = m.strip().upper()
                        stems.add(m_clean)
                        stems.add(m_clean.replace(" ", "_"))
                        stems.add(m_clean.replace("_", " "))
                        base_c = re.match(r"(?i)^C\d{4}", m_clean)
                        if base_c:
                            stems.add(base_c.group(0).upper())

                    for m in re.findall(r"(?i)\b(Video[_\s][A-Za-z0-9]+)\b", raw_footage):
                        v_clean = m.strip()
                        stems.add(v_clean)
                        stems.add(v_clean.replace(" ", "_"))
                        stems.add(v_clean.replace("_", " "))

                    # Check single voice rule (e.g. Abdullah)
                    is_abdullah = "abdullah" in clean_name.lower()

                    sp_info = SpeakerInfo(
                        id=sp_id,
                        name=clean_name,
                        title=raw_title,
                        aliases=aliases,
                        clip_stems=sorted(stems),
                        themes=raw_themes,
                        single_voice_rule=is_abdullah,
                    )

                    key = clean_name.lower()
                    self._speakers[key] = sp_info
                    for alias in aliases:
                        self._speakers[alias.lower()] = sp_info

                    for st in stems:
                        self._speaker_by_clip[st.lower()] = sp_info

            elif in_table and line_str and not line_str.startswith("|"):
                # End of table
                in_table = False

    def _detect_speaker(self, fname: str, rel_path_lower: str, norm_stem: str) -> Optional[str]:
        """Detect speaker from cross-reference mappings or directory names."""
        # 1. Exact clip stem lookup from cross-reference
        if norm_stem.lower() in self._speaker_by_clip:
            return self._speaker_by_clip[norm_stem.lower()].name

        # 2. Direct name match in filename or path
        combined = f"{rel_path_lower} {fname.lower()}"
        for sp_key, sp in self._speakers.items():
            if sp_key in combined:
                return sp.name

        # 3. Common path heuristics (e.g. "Voice/1 Abdullah" -> "Abdullah")
        speaker_match = re.search(r"(?:voice|finals|interviews)[\\/](\d+\s+)?([a-z\s]+?)(?:[\\/]|$)", rel_path_lower)
        if speaker_match:
            candidate = speaker_match.group(2).strip()
            # Verify candidate matches a known speaker or looks like a valid name
            for sp_key, sp in self._speakers.items():
                if candidate in sp_key or sp_key in candidate:
                    return sp.name
            if len(candidate) > 2 and candidate not in ("mix", "mixed", "mix with old", "other"):
                return candidate.title()

        return None

    def _ensure_indexed(self) -> None:
        if not self._indexed:
            self.index_directory()

    def _get_source_file_from_transcript(self, transcript_path: str) -> Optional[MediaItem]:
        """Extract and resolve the source video referenced inside a Whisper transcript JSON."""
        try:
            with open(transcript_path, "r", encoding="utf-8", errors="ignore") as f:
                data = json.load(f)
            src = data.get("source_file")
            if src:
                remapped = self.remap_legacy_path(src)
                if os.path.exists(remapped):
                    ext = Path(remapped).suffix.lower()
                    return MediaItem(
                        stem=self.normalize_stem(remapped),
                        name=Path(remapped).name,
                        path=remapped,
                        file_type="video" if ext in VIDEO_EXTS else "general",
                        ext=ext,
                    )
        except Exception:
            pass
        return None

    def resolve_media(self, query: str, prefer_video: bool = True) -> Optional[MediaItem]:
        r"""
        Resolve an arbitrary query (path, filename, stem, or reference) to a valid on-disk MediaItem.
        Handles:
        - Legacy drive letters (F:\ -> D:\)
        - Virtual paths e.g. "Raw_Transcriptions\C5032.MP4" -> real C5032.MP4
        - Bare stems e.g. "C5032", "C6019"
        - Filenames e.g. "01 Abdullah.mp3"
        """
        if not query or not query.strip():
            return None

        self._ensure_indexed()
        clean_query = self.remap_legacy_path(query.strip())

        # 1. Direct path lookup
        exact_path = clean_query.lower()
        if exact_path in self._media_by_path:
            item = self._media_by_path[exact_path]
            if prefer_video and item.file_type != "video":
                if item.file_type == "transcript" and item.path.endswith(".json"):
                    src_v = self._get_source_file_from_transcript(item.path)
                    if src_v:
                        return src_v
            else:
                return item

        # 2. Real on-disk file check
        if os.path.isabs(clean_query) and os.path.exists(clean_query):
            norm_stem = self.normalize_stem(clean_query)
            ext = Path(clean_query).suffix.lower()
            if prefer_video and ext in TRANSCRIPT_EXTS and ext == ".json":
                src_v = self._get_source_file_from_transcript(clean_query)
                if src_v:
                    return src_v
            return MediaItem(
                stem=norm_stem,
                name=Path(clean_query).name,
                path=clean_query,
                file_type="video" if ext in VIDEO_EXTS else ("audio" if ext in AUDIO_EXTS else "general"),
                ext=ext,
            )

        # 3. Stem lookup (e.g. "C5032", "C6019", "Raw_Transcriptions\C5032.MP4")
        stem = self.normalize_stem(clean_query)
        candidates = self._media_by_stem.get(stem, [])
        if candidates:
            if prefer_video:
                # Pick video first
                for c in candidates:
                    if c.file_type == "video":
                        return c
                # If no video in candidates, check if any transcript has a source_file video
                for c in candidates:
                    if c.file_type == "transcript" and c.path.endswith(".json"):
                        src_v = self._get_source_file_from_transcript(c.path)
                        if src_v:
                            return src_v
            else:
                # Else pick first audio/video
                for c in candidates:
                    if c.file_type in ("video", "audio"):
                        return c
                return candidates[0]

        # 4. Alphanumeric clean key lookup (e.g. "C1321_21" matches "C1321 21.mp4")
        clean_k = self.clean_alphanumeric(clean_query)
        if clean_k and clean_k in self._media_by_clean_stem:
            candidates = self._media_by_clean_stem[clean_k]
            if prefer_video:
                for c in candidates:
                    if c.file_type == "video":
                        return c
                for c in candidates:
                    if c.file_type == "transcript" and c.path.endswith(".json"):
                        src_v = self._get_source_file_from_transcript(c.path)
                        if src_v:
                            return src_v
            for c in candidates:
                if c.file_type in ("video", "audio"):
                    return c
            return candidates[0]

        # 5. Camera code prefix lookup (e.g. "C1321" or "C1321_21" -> camera code "C1321")
        cam_code_match = re.match(r"(?i)^([A-Z]\d{4})\b", stem)
        if cam_code_match:
            cam_code = cam_code_match.group(1).upper()
            if cam_code in self._media_by_camera_code:
                cam_candidates = self._media_by_camera_code[cam_code]
                if prefer_video:
                    for c in cam_candidates:
                        if c.file_type == "video":
                            return c
                for c in cam_candidates:
                    if c.file_type in ("video", "audio"):
                        return c
                return cam_candidates[0]

        # 6. Filename exact match
        fname = Path(clean_query).name.lower()
        for path_key, item in self._media_by_path.items():
            if item.name.lower() == fname:
                if prefer_video and item.file_type != "video":
                    if item.file_type == "transcript" and item.path.endswith(".json"):
                        src_v = self._get_source_file_from_transcript(item.path)
                        if src_v:
                            return src_v
                    continue
                return item

        # 7. Fuzzy stem containment (strictly for stems with length >= 4 and not pure digits)
        if len(stem) >= 4 and not stem.isdigit():
            for st, items in self._media_by_stem.items():
                if len(st) >= 4 and not st.isdigit() and (stem in st or st in stem):
                    for item in items:
                        if prefer_video and item.file_type == "video":
                            return item
                    if not prefer_video:
                        return items[0]

        # 6. Speaker + Number pattern search (e.g. "Abdullah - 4" -> "Finals\Abdullah\4.mp4")
        sp_num_match = re.search(r"(?i)\b([a-zA-Z]+)\b[^\d]*(\d+)", clean_query) or re.search(r"(?i)(\d+)[^\w]*\b([a-zA-Z]+)\b", clean_query)
        if sp_num_match:
            g1, g2 = sp_num_match.group(1).lower(), sp_num_match.group(2).lower()
            sp_word = g1 if not g1.isdigit() else g2
            num_str = g2 if not g1.isdigit() else g1
            for path_key, item in self._media_by_path.items():
                if prefer_video and item.file_type != "video":
                    continue
                p_lower = item.path.lower()
                name_lower = item.name.lower()
                if sp_word in p_lower and (name_lower.startswith(f"{num_str}.") or f" {num_str} " in name_lower or f"- {num_str}" in name_lower or name_lower == f"{num_str}.mp4"):
                    return item

        return None

    def resolve_audio_pair(self, stem_or_path: str) -> ResolvedAudioPair:
        """
        Resolve all companion files for a given clip stem:
        - The source camera video (Track V1)
        - The raw audio track
        - The enhanced audio track (e.g. *-enhanced-v2.mp3 for Track A1)
        - The word transcript (.json or .srt)
        """
        self._ensure_indexed()
        stem = self.normalize_stem(stem_or_path)
        pair = ResolvedAudioPair(stem=stem)

        candidates = list(self._media_by_stem.get(stem, []))
        clean_key = self.clean_alphanumeric(stem)
        if clean_key:
            for extra in self._media_by_clean_stem.get(clean_key, []):
                if extra not in candidates:
                    candidates.append(extra)

        cam_match = re.match(r"(?i)^([A-Z]\d{4})\b", stem)
        if cam_match:
            cam_code = cam_match.group(1).upper()
            if cam_code in self._media_by_camera_code:
                for extra in self._media_by_camera_code[cam_code]:
                    if extra not in candidates:
                        candidates.append(extra)

        for c in candidates:
            if c.file_type == "video" and not pair.video_item:
                pair.video_item = c
            elif c.file_type == "audio":
                if c.is_enhanced and not pair.enhanced_audio_item:
                    pair.enhanced_audio_item = c
                elif not pair.audio_item:
                    pair.audio_item = c
            elif c.file_type == "transcript":
                if not pair.transcript_item:
                    pair.transcript_item = c
                elif pair.transcript_item.ext != ".json" and c.ext == ".json":
                    pair.transcript_item = c

        # Speaker detection
        if stem.lower() in self._speaker_by_clip:
            pair.speaker = self._speaker_by_clip[stem.lower()].name
        elif pair.video_item and pair.video_item.speaker:
            pair.speaker = pair.video_item.speaker

        # Fallback: search for speaker enhanced audio in Voice subfolder
        if not pair.enhanced_audio_item and pair.speaker:
            sp_lower = pair.speaker.lower()
            for path_key, item in self._media_by_path.items():
                if item.file_type == "audio" and item.is_enhanced:
                    if sp_lower in path_key or stem.lower() in path_key:
                        pair.enhanced_audio_item = item
                        break

        return pair

    def find_broll(self, visual_cue: str, limit: int = 5) -> List[Dict[str, Any]]:
        """
        Search indexed B-roll and stills using fuzzy keywords from a script visual cue.
        Returns candidate clips with relevance score, duration, and recommended in/out points.
        """
        self._ensure_indexed()
        if not visual_cue or not self._broll_items:
            return []

        cue_clean = re.sub(r"[^\w\s]", " ", visual_cue.lower())
        cue_tokens = set(cue_clean.split())

        scored_results: List[Tuple[float, MediaItem, str]] = []

        for item in self._broll_items:
            score = 0.0
            matched_cluster = "general"
            item_text = f"{item.name.lower()} {item.subfolder.lower()} {' '.join(item.tags)}"

            # Direct token overlap
            for token in cue_tokens:
                if len(token) < 3:
                    continue
                if token in item_text:
                    score += 2.0

            # Synonym cluster matching
            for cluster_name, synonyms in BROLL_CLUSTERS.items():
                cluster_matches_cue = any(syn in cue_clean for syn in synonyms)
                if cluster_matches_cue:
                    cluster_matches_item = any(syn in item_text for syn in synonyms)
                    if cluster_matches_item:
                        score += 5.0
                        matched_cluster = cluster_name

            # Prefer real videos over stills if not specified
            if item.file_type == "video":
                score += 0.5

            if score > 0:
                scored_results.append((score, item, matched_cluster))

        # Sort by highest score descending
        scored_results.sort(key=lambda x: x[0], reverse=True)

        results: List[Dict[str, Any]] = []
        for score, item, cluster in scored_results[:limit]:
            # Recommend stable center window for B-roll (avoid shaky start)
            rec_in = 2.0 if item.file_type == "video" else 0.0
            rec_out = rec_in + 4.0 if item.file_type == "video" else 4.0

            results.append({
                "stem": item.stem,
                "name": item.name,
                "path": item.path,
                "file_type": item.file_type,
                "subfolder": item.subfolder,
                "cluster": cluster,
                "score": round(score, 2),
                "recommended_in": rec_in,
                "recommended_out": rec_out,
                "is_still": item.file_type == "image",
            })

        return results

    def get_speaker(self, query: str) -> Optional[SpeakerInfo]:
        """Look up speaker info by name, alias, or clip stem."""
        if not self._indexed and not self._speakers:
            self._ensure_indexed()
        q = query.strip().lower()
        if q in self._speakers:
            return self._speakers[q]
        if q in self._speaker_by_clip:
            return self._speaker_by_clip[q]
        # Partial match
        for k, sp in self._speakers.items():
            if q in k or k in q:
                return sp
        return None

    def get_all_speakers(self) -> List[Dict[str, Any]]:
        """Return the roster of verified speakers."""
        self._ensure_indexed()
        seen = set()
        out = []
        for sp in self._speakers.values():
            if sp.id not in seen:
                seen.add(sp.id)
                out.append(sp.to_dict())
        out.sort(key=lambda s: s["id"])
        return out

    def get_speaker_clips(self, speaker_name: str) -> List[Dict[str, Any]]:
        """Return all indexed clips belonging to a specific speaker."""
        self._ensure_indexed()
        sp = self.get_speaker(speaker_name)
        if not sp:
            return []
        clips: List[Dict[str, Any]] = []
        target_name = sp.name.lower()
        for item in self._media_by_path.values():
            if item.speaker and item.speaker.lower() == target_name:
                clips.append(item.to_dict())
        return clips

    def get_stats(self) -> Dict[str, Any]:
        """Summary statistics of indexed assets."""
        videos = sum(1 for m in self._media_by_path.values() if m.file_type == "video")
        audios = sum(1 for m in self._media_by_path.values() if m.file_type == "audio")
        transcripts = sum(1 for m in self._media_by_path.values() if m.file_type == "transcript")
        images = sum(1 for m in self._media_by_path.values() if m.file_type == "image")

        return {
            "success": True,
            "root_dir": self.root_dir,
            "total_items": len(self._media_by_path),
            "unique_stems": len(self._media_by_stem),
            "videos": videos,
            "audios": audios,
            "transcripts": transcripts,
            "images": images,
            "broll_items": len(self._broll_items),
            "verified_speakers": len({s.id for s in self._speakers.values()}),
        }

    def _save_to_cache(self, cache_file: Path, target_dir: Path) -> None:
        """Serialize media resolver index to JSON cache file."""
        try:
            payload = {
                "root_dir": str(target_dir),
                "items": [item.to_dict() for item in self._media_by_path.values()],
                "speakers": [sp.to_dict() for sp in {s.id: s for s in self._speakers.values()}.values()],
            }
            with open(cache_file, "w", encoding="utf-8") as f:
                json.dump(payload, f, indent=2)
            logger.info(f"[media_resolver] Saved cache to {cache_file}")
        except Exception as e:
            logger.warning(f"[media_resolver] Failed to write cache: {e}")

    def _load_from_cache(self, data: Dict[str, Any]) -> None:
        """Restore media resolver index from cached dictionary."""
        self._media_by_path.clear()
        self._media_by_stem.clear()
        self._media_by_clean_stem.clear()
        self._media_by_camera_code.clear()
        self._broll_items.clear()
        self._speakers.clear()
        self._speaker_by_clip.clear()

        # Restore speakers
        for sp_data in data.get("speakers", []):
            sp = SpeakerInfo(**sp_data)
            self._speakers[sp.name.lower()] = sp
            for alias in sp.aliases:
                self._speakers[alias.lower()] = sp
            for st in sp.clip_stems:
                self._speaker_by_clip[st.lower()] = sp

        # Restore items
        for item_data in data.get("items", []):
            item = MediaItem(**item_data)
            self._media_by_path[item.path.lower()] = item
            self._media_by_stem.setdefault(item.stem, []).append(item)
            clean_k = self.clean_alphanumeric(item.stem)
            if clean_k:
                self._media_by_clean_stem.setdefault(clean_k, []).append(item)
            cam_match = re.match(r"(?i)^([A-Z]\d{4})\b", item.stem)
            if cam_match:
                self._media_by_camera_code.setdefault(cam_match.group(1).upper(), []).append(item)
            if item.category in ("broll", "render"):
                self._broll_items.append(item)


# Global singleton instance
media_resolver = MediaResolverService()
