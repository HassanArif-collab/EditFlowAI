"""
EditFlow AI - B-Roll Catalog Service
Manages visual B-roll cataloging using AI vision analysis.
"""
import asyncio
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from ..config import Settings
from ..models.schemas import CatalogEntry, CatalogResult
from ..models.database import db
from ..services.ollama_service import ollama_service
from ..utils.ffmpeg_utils import (
    extract_frames, get_duration, get_media_info, scan_directory,
)
from ..utils.progress import ProgressReporter

logger = logging.getLogger(__name__)

# Vision analysis prompt
VISION_PROMPT = """You are a professional video archivist. These images are sequential frames from a single video clip. Provide:
1. A single, concise sentence describing the visual contents of this video. Focus only on what is visually shown.
2. 3-5 relevant keywords/tags separated by commas.
3. A category (e.g., Construction, Interview, Architecture, Nature, People, Drone, Event, Stock, Animation, UI).

Format your response exactly like this:
DESCRIPTION: <your description>
KEYWORDS: <keyword1>, <keyword2>, <keyword3>
CATEGORY: <category>"""


class CatalogService:
    """Service for building and managing B-roll catalogs."""

    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or Settings()
        self.catalog_dir = self.settings.CATALOG_DIR
        self.catalog_dir.mkdir(parents=True, exist_ok=True)

    async def build_catalog(
        self,
        directories: List[str],
        catalog_name: str = "default",
        model: Optional[str] = None,
        force_reanalyze: bool = False,
        progress: Optional[ProgressReporter] = None,
    ) -> CatalogResult:
        """Build a B-roll catalog by analyzing videos with AI vision.

        Args:
            directories: List of directories containing B-roll footage
            catalog_name: Name for the catalog
            model: Vision model to use for analysis
            force_reanalyze: Whether to re-analyze already processed files
            progress: Progress reporter

        Returns:
            CatalogResult with all catalog entries
        """
        if progress:
            await progress.start("Scanning directories for video files...")

        # Collect all video files
        all_videos = []
        for d in directories:
            all_videos.extend(scan_directory(d))

        if progress:
            await progress.update(0.05, f"Found {len(all_videos)} video files")

        # Load existing catalog
        existing = db.load(f"catalog_{catalog_name}") or []
        processed_paths = {entry.get("path") for entry in existing}

        # Filter to unprocessed files
        to_process = []
        for v in all_videos:
            if force_reanalyze or str(v) not in processed_paths:
                to_process.append(v)

        if progress:
            await progress.update(0.1, f"Processing {len(to_process)} new videos ({len(existing)} already cataloged)")

        # Process each video
        new_entries = []
        for i, video_path in enumerate(to_process):
            if progress:
                pct = 0.1 + 0.85 * (i / max(len(to_process), 1))
                await progress.update(pct, f"Analyzing {video_path.name}...")

            try:
                entry = await self._analyze_video(video_path, model)
                if entry:
                    new_entries.append(entry.dict())
                    # Save incrementally
                    existing.append(entry.dict())
                    db.save(f"catalog_{catalog_name}", existing)
            except Exception as e:
                logger.error(f"Failed to analyze {video_path}: {e}")
                # Fallback: add with filename-based description
                entry = CatalogEntry(
                    filename=video_path.name,
                    path=str(video_path),
                    duration=get_duration(video_path),
                    visual_description=f"Visual footage: {video_path.stem.replace('_', ' ').replace('-', ' ')}",
                    keywords=self._keywords_from_filename(video_path.name),
                    categories=["Uncategorized"],
                    analyzed_at=datetime.utcnow(),
                )
                new_entries.append(entry.dict())
                existing.append(entry.dict())
                db.save(f"catalog_{catalog_name}", existing)

        if progress:
            await progress.complete(f"Catalog complete: {len(new_entries)} new entries, {len(existing)} total")

        return CatalogResult(
            entries=[CatalogEntry(**e) for e in existing],
            total_count=len(existing),
            last_updated=datetime.utcnow(),
        )

    async def _analyze_video(
        self,
        video_path: Path,
        model: Optional[str] = None,
    ) -> Optional[CatalogEntry]:
        """Analyze a single video with AI vision."""
        duration = get_duration(video_path)
        if duration <= 0:
            return None

        # Extract frames
        frames = extract_frames(video_path, duration)
        if not frames:
            # Fallback to filename-based description
            return CatalogEntry(
                filename=video_path.name,
                path=str(video_path),
                duration=duration,
                visual_description=f"Visual footage: {video_path.stem.replace('_', ' ').replace('-', ' ')}",
                keywords=self._keywords_from_filename(video_path.name),
                categories=["Uncategorized"],
                analyzed_at=datetime.utcnow(),
            )

        # Analyze with vision model
        description = ""
        keywords = []
        categories = []

        try:
            response = await ollama_service.analyze_images(
                images_b64=frames,
                prompt=VISION_PROMPT,
                model=model or ollama_service.get_active_vision_model(),
            )

            # Parse structured response
            description, keywords, categories = self._parse_vision_response(response, video_path.name)

        except Exception as e:
            logger.warning(f"Vision analysis failed for {video_path.name}: {e}")
            description = f"Visual footage: {video_path.stem.replace('_', ' ').replace('-', ' ')}"
            keywords = self._keywords_from_filename(video_path.name)
            categories = ["Uncategorized"]

        # Get additional media info
        media_info = get_media_info(video_path)

        return CatalogEntry(
            filename=video_path.name,
            path=str(video_path),
            duration=duration,
            width=media_info.get("width", 0),
            height=media_info.get("height", 0),
            visual_description=description,
            keywords=keywords,
            categories=categories,
            analyzed_at=datetime.utcnow(),
            analysis_model=model or ollama_service.get_active_vision_model(),
        )

    def _parse_vision_response(self, response: str, filename: str) -> tuple:
        """Parse structured vision response into description, keywords, categories."""
        description = ""
        keywords = []
        categories = []

        for line in response.split("\n"):
            line = line.strip()
            if line.upper().startswith("DESCRIPTION:"):
                description = line.split(":", 1)[1].strip()
            elif line.upper().startswith("KEYWORDS:"):
                kw_str = line.split(":", 1)[1].strip()
                keywords = [k.strip() for k in kw_str.split(",") if k.strip()]
            elif line.upper().startswith("CATEGORY:"):
                cat_str = line.split(":", 1)[1].strip()
                categories = [c.strip() for c in cat_str.split(",") if c.strip()]

        # Fallbacks
        if not description:
            # Use the full response as description if structured parse failed
            description = response.strip() if response.strip() else f"Visual footage: {Path(filename).stem.replace('_', ' ')}"
        if not keywords:
            keywords = self._keywords_from_filename(filename)
        if not categories:
            categories = ["Uncategorized"]

        return description, keywords, categories

    def _keywords_from_filename(self, filename: str) -> List[str]:
        """Extract keywords from filename as fallback."""
        stem = Path(filename).stem
        # Split on common separators
        parts = stem.replace("_", " ").replace("-", " ").split()
        # Filter out common non-keywords
        skip = {"the", "a", "an", "of", "in", "on", "at", "for", "to", "and", "mp4", "mov"}
        return [p.lower() for p in parts if p.lower() not in skip and len(p) > 2][:5]

    async def search_catalog(
        self,
        query: str,
        catalog_name: str = "default",
        max_results: int = 20,
    ) -> List[CatalogEntry]:
        """Search catalog entries by keywords/description.

        Args:
            query: Search query
            catalog_name: Catalog to search
            max_results: Maximum number of results

        Returns:
            List of matching CatalogEntry objects
        """
        catalog_data = db.load(f"catalog_{catalog_name}") or []
        entries = [CatalogEntry(**e) for e in catalog_data]

        query_lower = query.lower()
        query_words = set(query_lower.split())

        scored = []
        for entry in entries:
            score = 0
            # Check description
            if query_lower in entry.visual_description.lower():
                score += 10
            # Check keywords
            for kw in entry.keywords:
                if query_lower in kw.lower():
                    score += 5
                for qw in query_words:
                    if qw in kw.lower():
                        score += 2
            # Check categories
            for cat in entry.categories:
                if query_lower in cat.lower():
                    score += 3
            # Check filename
            if query_lower in entry.filename.lower():
                score += 2

            if score > 0:
                scored.append((score, entry))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [entry for _, entry in scored[:max_results]]

    async def get_catalog(self, catalog_name: str = "default") -> CatalogResult:
        """Get full catalog."""
        catalog_data = db.load(f"catalog_{catalog_name}") or []
        entries = [CatalogEntry(**e) for e in catalog_data]
        return CatalogResult(
            entries=entries,
            total_count=len(entries),
            last_updated=datetime.utcnow() if entries else None,
        )


# Global service instance
catalog_service = CatalogService()
