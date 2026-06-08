"""
EditFlow AI - Bin Resolver

Parses @bin:... / @clip:... / @/Full/Bin/Path references against the latest
project scan and returns a list of source files. Pure function — no DB, no
HTTP, no LLM.

MVP Task M1.  Updated for v2 Stage 1 fields.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import List, Optional

from .media_fingerprint import compute_content_hash

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------

class AmbiguousReferenceError(ValueError):
    """Raised when @bin:X or @clip:X matches more than one item."""

    def __init__(self, reference: str, candidates: list[str]):
        self.reference = reference
        self.candidates = candidates
        super().__init__(
            f"{reference} matched {len(candidates)} items: " + ", ".join(candidates[:5])
        )


class NestedSequenceError(ValueError):
    """Raised when a nested sequence clip is referenced.

    Nested sequences cannot be resolved to a single media file and are
    refused by the bin resolver with a RED-level warning.
    """

    def __init__(self, clip_name: str, bin_path: str):
        self.clip_name = clip_name
        self.bin_path = bin_path
        super().__init__(
            f"Clip '{clip_name}' in bin '{bin_path}' is a nested sequence — "
            "nested sequences cannot be resolved to a single media file."
        )


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ResolvedClip:
    path: str           # absolute on-disk path
    name: str           # display name (filename or clip name from PPro)
    bin_path: str       # e.g. "Interviews/Day 1"
    duration: float     # seconds; 0.0 if unknown
    has_audio: bool

    # --- Stage 1 additions ---
    content_hash: str = ""              # SHA-256 of first_16MB + size + duration
    project_item_node_id: str = ""      # for later "import to project" guarantees
    audio_stream_index: int = 0         # which audio stream
    audio_channel_layout: str = "mono"  # mono / stereo / 5.1
    clip_kind: str = "basic"            # basic | subclip | multicam | nested | proxy_only | offline
    warnings: list[str] = field(default_factory=list)  # per-clip warnings


# ---------------------------------------------------------------------------
# Warning severity helpers
# ---------------------------------------------------------------------------

def _warn_yellow(msg: str) -> str:
    """Return a YELLOW-level warning string."""
    return f"[YELLOW] {msg}"


def _warn_red(msg: str) -> str:
    """Return a RED-level warning string."""
    return f"[RED] {msg}"


# ---------------------------------------------------------------------------
# Clip-type helpers
# ---------------------------------------------------------------------------

def _determine_clip_kind(it: dict) -> tuple[str, list[str]]:
    """Determine clip_kind and any associated warnings from scan item data.

    Returns (clip_kind, warnings_list).
    """
    warnings: list[str] = []
    clip_type = it.get("clipType", "")
    media_path = it.get("mediaPath", "")
    has_audio = it.get("hasAudio", False)

    # If the scan data provides clipType, honour it
    if clip_type:
        kind = clip_type.lower()
    elif not has_audio and media_path:
        # Has a media path but no audio → offline / missing media
        kind = "offline"
    else:
        kind = "basic"

    # Add severity-appropriate warnings for special clip kinds
    if kind == "multicam":
        warnings.append(_warn_yellow(
            "Multicam clip — audio stream selection may differ from source angle"
        ))
    elif kind == "nested":
        warnings.append(_warn_red(
            "Nested sequence clip — cannot resolve to a single media file"
        ))
    elif kind == "proxy_only":
        warnings.append(_warn_yellow(
            "Proxy-only clip — original media may be offline"
        ))
    elif kind == "offline":
        warnings.append(_warn_yellow(
            "Clip is offline — media file may be missing or unlinked"
        ))

    return kind, warnings


def _determine_audio_channel_layout(it: dict) -> str:
    """Infer audio channel layout from scan data.

    Falls back to 'mono' if no information is available.
    """
    # Check for explicit channel layout field
    layout = it.get("audioChannelLayout", "")
    if layout:
        return layout

    # Infer from channel count if available
    channels = it.get("audioChannels", 0)
    if channels >= 6:
        return "5.1"
    elif channels >= 2:
        return "stereo"

    return "mono"


def _compute_clip_hash(media_path: str, duration: float) -> str:
    """Try to compute content hash; return empty string on failure.

    The bin resolver is nominally a pure function, but content hashing
    requires reading the file from disk.  We tolerate failures (missing
    files, permission errors) and fall back gracefully — de-duplication
    will also check by path as a safety net.
    """
    try:
        return compute_content_hash(media_path, duration=duration)
    except (FileNotFoundError, OSError) as exc:
        logger.debug("Could not compute content hash for %s: %s", media_path, exc)
        return ""


# ---------------------------------------------------------------------------
# Main resolve function
# ---------------------------------------------------------------------------

def resolve(
    references: list[str],
    project_scan: dict,
) -> list[ResolvedClip]:
    """Walk the project scan and resolve every reference to a list of clips.

    Reference grammar:
        @bin:<path>         -> direct children of that bin (NOT recursive)
        @bin:<path>/**      -> recursive descent through nested bins
        @clip:<name>        -> unambiguous clip match by exact name
        @/Full/Bin/Path     -> absolute bin path (shorthand)
        @<x>                -> tries bin first, then clip; ambiguous -> raise

    ``project_scan`` is the parsed JSON from ``projectScanner.scanAll()`` —
    contains ``bins: [{name, path, itemCount, depth}]`` and
    ``items: [{name, binPath, mediaPath, hasAudio, duration, ...}]``.

    Returns a de-duplicated list of ResolvedClip, in the order references
    were given.  Items without ``mediaPath`` are dropped.  Nested sequence
    clips raise NestedSequenceError.

    Raises:
        AmbiguousReferenceError: if any reference matches more than one
            bin/clip at the wrong level.
        NestedSequenceError: if a nested sequence clip is referenced.
    """
    bins = project_scan.get("bins", [])
    items = project_scan.get("items", [])

    # Build a lookup of bin path -> bin dict for quick matching
    bins_by_name: dict[str, list[dict]] = {}
    for b in bins:
        name = b.get("name", "")
        if name:
            bins_by_name.setdefault(name, []).append(b)

    # Build a lookup of clip name -> list of item dicts
    items_by_name: dict[str, list[dict]] = {}
    for it in items:
        name = it.get("name", "")
        if name:
            items_by_name.setdefault(name, []).append(it)

    # De-duplicate by content_hash (primary) with path as fallback
    seen_hashes: set[str] = set()
    seen_paths: set[str] = set()      # safety-net fallback when hash is empty
    result: list[ResolvedClip] = []

    for ref in references:
        ref = ref.strip()
        if not ref.startswith("@"):
            continue

        # Strip the leading @
        body = ref[1:]

        # Split on ':' once — lhs is type qualifier, rhs is the path/name
        if ":" in body:
            kind, value = body.split(":", 1)
        else:
            kind = None
            value = body

        # @/Full/Bin/Path — absolute bin path shorthand
        if kind is None and value.startswith("/"):
            kind = "bin"
            # value already contains the absolute path (e.g. "/Full/Bin/Path")

        recursive = False
        if value.endswith("/**"):
            recursive = True
            value = value[:-3]

        if kind == "bin":
            clips = _resolve_bin(value, bins_by_name, items, recursive)
        elif kind == "clip":
            clips = _resolve_clip(value, items_by_name)
        else:
            # @x → try bin first, then clip; ambiguous → raise
            bin_clips = _resolve_bin(value, bins_by_name, items, recursive)
            clip_clips = _resolve_clip(value, items_by_name)
            if bin_clips and clip_clips:
                # Both matched — ambiguous
                raise AmbiguousReferenceError(
                    ref,
                    [f"bin:{value}", f"clip:{value}"],
                )
            clips = bin_clips or clip_clips

        # De-duplicate by content_hash (primary), then by path (fallback)
        for clip in clips:
            # Check for nested sequences — raise immediately
            if clip.clip_kind == "nested":
                raise NestedSequenceError(clip.name, clip.bin_path)

            if clip.content_hash:
                if clip.content_hash in seen_hashes:
                    continue
                seen_hashes.add(clip.content_hash)
            else:
                # No content hash available — fall back to path dedup
                if clip.path in seen_paths:
                    continue
            # Always track path as a secondary dedup key
            seen_paths.add(clip.path)
            result.append(clip)

    return result


# ---------------------------------------------------------------------------
# Internal resolvers
# ---------------------------------------------------------------------------

def _build_resolved_clip(it: dict) -> ResolvedClip:
    """Build a ResolvedClip from a project scan item, populating all
    Stage 1 fields.
    """
    media_path = it.get("mediaPath", "")
    duration = it.get("duration", 0.0)

    # Determine clip kind and warnings
    clip_kind, warnings = _determine_clip_kind(it)

    # Compute content hash (best-effort)
    content_hash = _compute_clip_hash(media_path, duration) if media_path else ""

    # Audio stream selection
    audio_stream_index = it.get("audioStreamIndex", 0)

    # Audio channel layout
    audio_channel_layout = _determine_audio_channel_layout(it)

    # Project item node ID for later "import to project" guarantees
    project_item_node_id = it.get("nodeId", it.get("projectItemNodeId", ""))

    return ResolvedClip(
        path=media_path,
        name=it.get("name", ""),
        bin_path=it.get("binPath", ""),
        duration=duration,
        has_audio=_item_has_usable_audio(it),
        content_hash=content_hash,
        project_item_node_id=project_item_node_id,
        audio_stream_index=audio_stream_index,
        audio_channel_layout=audio_channel_layout,
        clip_kind=clip_kind,
        warnings=warnings,
    )


def _item_has_usable_audio(it: dict) -> bool:
    """Return whether a scanned Premiere item is worth trying as audio media.

    Some Premiere DOM versions do not expose ProjectItem.hasAudio(), so the
    CEP scan may omit hasAudio entirely. In that case, infer from media path.
    """
    explicit = it.get("hasAudio", it.get("has_audio"))
    if explicit is not None:
        return bool(explicit)

    media_path = (it.get("mediaPath") or it.get("media_path") or "").lower()
    return media_path.endswith((
        ".mov", ".mp4", ".m4v", ".avi", ".mxf", ".mts", ".m2ts",
        ".mpg", ".mpeg", ".webm", ".wav", ".mp3", ".aac", ".m4a",
        ".aif", ".aiff",
    ))


def _resolve_bin(
    bin_ref: str,
    bins_by_name: dict[str, list[dict]],
    items: list[dict],
    recursive: bool,
) -> list[ResolvedClip]:
    """Resolve a bin reference to a list of ResolvedClip.

    Direct children only (unless recursive=True).
    Supports both short names and absolute paths (e.g. @/Full/Bin/Path).

    Raises AmbiguousReferenceError if the bin name matches multiple bins.
    """
    matching_bins: list[dict] = []

    # Determine if bin_ref is an absolute path (starts with "/") or a name
    is_abs_path = bin_ref.startswith("/")

    for bin_name, bin_list in bins_by_name.items():
        for b in bin_list:
            bpath = b.get("path", "")
            bname = b.get("name", "")

            if is_abs_path:
                # Absolute path: only match on full path
                if bpath == bin_ref:
                    matching_bins.append(b)
            else:
                # Relative / name: match by full path first, then by name
                if bpath == bin_ref:
                    matching_bins.append(b)
                elif bname == bin_ref and b not in matching_bins:
                    matching_bins.append(b)

    if not matching_bins:
        return []

    if len(matching_bins) > 1:
        # Check if they're actually the same path (just different depth)
        paths = set(b.get("path", "") for b in matching_bins)
        if len(paths) > 1:
            raise AmbiguousReferenceError(
                f"@bin:{bin_ref}",
                sorted(paths),
            )

    # Collect items from matching bin(s)
    clips: list[ResolvedClip] = []
    for b in matching_bins:
        bin_path = b.get("path", "")
        for it in items:
            item_bin_path = it.get("binPath", "")
            media_path = it.get("mediaPath", "")

            # Skip items without mediaPath or without audio
            # Plan: "still image / graphic / title: silently dropped (has_audio == False)"
            has_audio = _item_has_usable_audio(it)
            if not media_path or not has_audio:
                continue

            if recursive:
                # Include items in this bin or any nested bin
                if item_bin_path == bin_path or item_bin_path.startswith(bin_path + "/"):
                    clips.append(_build_resolved_clip(it))
            else:
                # Direct children only
                if item_bin_path == bin_path:
                    clips.append(_build_resolved_clip(it))

    # Sort by name within this bin reference
    clips.sort(key=lambda c: c.name)
    return clips


def _resolve_clip(
    clip_name: str,
    items_by_name: dict[str, list[dict]],
) -> list[ResolvedClip]:
    """Resolve a clip reference by exact name match.

    Raises AmbiguousReferenceError if the name matches clips in
    different bins (same-named clip in different bins).
    """
    matching = items_by_name.get(clip_name, [])
    if not matching:
        return []

    # Check for ambiguity: same-named clip in different bins
    if len(matching) > 1:
        bin_paths = sorted(set(it.get("binPath", "") for it in matching))
        if len(bin_paths) > 1:
            raise AmbiguousReferenceError(
                f"@clip:{clip_name}",
                bin_paths,
            )

    clips: list[ResolvedClip] = []
    for it in matching:
        media_path = it.get("mediaPath", "")
        if not media_path or not _item_has_usable_audio(it):
            continue
        clips.append(_build_resolved_clip(it))

    return clips
