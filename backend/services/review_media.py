"""EditFlow AI — Review media helpers (proxy generation + silence detection).

WHY THIS EXISTS
---------------
The Review editor plays clips inside the panel with a plain HTML5 ``<video>``.
Two problems make raw source files unreliable there:

  1. **Codec** — iPhone footage is frequently HEVC (H.265), which Chromium/CEF
     cannot decode, and ``.mov`` containers play inconsistently. So we always
     hand the player a clean **H.264 / AAC ``.mp4``** proxy. When the source is
     already H.264 we *remux* (copy the video bitstream — near-instant); only
     HEVC/ProRes/oversized sources are fully transcoded.
  2. **Seeking** — ``+faststart`` moves the moov atom to the front so the panel
     can seek instantly to any segment.

Proxies are cached by content fingerprint, so a clip is only ever prepared once.

This module also produces the **silence map** (ffmpeg ``silencedetect``) that
:func:`review_service.tighten` uses to snap cuts hard onto speech — the fix for
the "gaps / looking around" the user complained about.

All ffmpeg calls reuse the project's resolved binary
(:data:`config.Settings.FFMPEG_PATH`, which already finds the bundled
``data/tools/ffmpeg-*/bin/ffmpeg.exe``) and run off the event loop via
:func:`utils.ffmpeg_utils.run_ffmpeg_async`.
"""
from __future__ import annotations

import array
import asyncio
import json
import logging
import re
import subprocess
from pathlib import Path
from typing import Optional

from ..config import get_settings
from ..utils.ffmpeg_utils import get_media_info, run_ffmpeg_async
from .media_fingerprint import fingerprint_short

logger = logging.getLogger(__name__)

# Same detector values already validated on this footage (see data/proof).
_SILENCE_NOISE_DB = "-33dB"
_SILENCE_MIN_DUR = "0.35"

# Heights at/under this play & seek fine as copied H.264 — above it we scale down.
_MAX_COPY_HEIGHT = 1080
# Proxy target height when transcoding. 480p is plenty for a review preview
# (the user is reading text + judging delivery, not grading colour) and keeps
# the first-load transcode of HEVC/4K sources fast.
_PROXY_HEIGHT = 480
# x264 preset for the transcode path — 'ultrafast' minimises first-load wait;
# the preview only needs to play & seek, not compress well.
_PROXY_PRESET = "ultrafast"


def _proxy_dir() -> Path:
    d = get_settings().DATA_DIR / "review" / "proxies"
    d.mkdir(parents=True, exist_ok=True)
    return d


def proxy_path_for(src_path: str | Path) -> Path:
    """Deterministic cache path for a source clip's playable proxy."""
    return _proxy_dir() / f"{fingerprint_short(src_path, 16)}.mp4"


async def ensure_playable_proxy(
    src_path: str | Path,
    reporter=None,
) -> dict:
    """Ensure a browser-playable H.264/AAC mp4 proxy exists; return its metadata.

    Returns ``{proxy_path, src_codec, height, duration, transcoded, cached}``.

    - Cached hit → returns immediately (no ffmpeg).
    - H.264 source ≤1080p → fast remux (``-c:v copy -c:a aac``).
    - Anything else (HEVC, ProRes, >1080p, missing/odd codec) → transcode to
      H.264 720p.

    ``reporter`` is an optional :class:`utils.progress.ProgressReporter` for WS
    progress (coarse start/complete — a remux is instant; a transcode shows a
    spinner). Raises :class:`FileNotFoundError` if the source is missing and
    ``RuntimeError`` with the ffmpeg stderr tail on encode failure.
    """
    src = Path(src_path)
    if not src.exists():
        raise FileNotFoundError(f"Source clip not found: {src}")

    proxy = proxy_path_for(src)
    info = get_media_info(src)
    src_codec = str(info.get("codec") or "").lower()
    height = int(info.get("height") or 0)
    duration = float(info.get("duration") or 0.0)

    if proxy.exists() and proxy.stat().st_size > 0:
        return {
            "proxy_path": str(proxy), "src_codec": src_codec, "height": height,
            "duration": duration, "transcoded": False, "cached": True,
        }

    ffmpeg = get_settings().FFMPEG_PATH
    can_copy = src_codec == "h264" and 0 < height <= _MAX_COPY_HEIGHT

    if reporter:
        await reporter.start(
            "Preparing video…" if can_copy else "Converting video for preview…"
        )

    tmp = proxy.with_suffix(".tmp.mp4")
    if can_copy:
        cmd = [
            ffmpeg, "-y", "-v", "error", "-i", str(src),
            "-map", "0:v:0", "-map", "0:a:0?",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
            "-movflags", "+faststart", str(tmp),
        ]
    else:
        cmd = [
            ffmpeg, "-y", "-v", "error", "-i", str(src),
            "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", f"scale=-2:{_PROXY_HEIGHT}",
            "-c:v", "libx264", "-preset", _PROXY_PRESET, "-crf", "26", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "160k",
            "-movflags", "+faststart", str(tmp),
        ]

    proc = await run_ffmpeg_async(cmd, timeout=1800)
    if proc.returncode != 0 or not tmp.exists():
        # If a copy-remux failed (e.g. odd H.264 profile), fall back to a full
        # transcode before giving up — robustness over speed.
        stderr_tail = (proc.stderr or "")[-500:]
        if can_copy:
            logger.warning("review proxy remux failed, transcoding instead: %s", stderr_tail)
            cmd = [
                ffmpeg, "-y", "-v", "error", "-i", str(src),
                "-map", "0:v:0", "-map", "0:a:0?",
                "-vf", f"scale=-2:{_PROXY_HEIGHT}",
                "-c:v", "libx264", "-preset", _PROXY_PRESET, "-crf", "26", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "160k",
                "-movflags", "+faststart", str(tmp),
            ]
            proc = await run_ffmpeg_async(cmd, timeout=1800)
        if proc.returncode != 0 or not tmp.exists():
            if reporter:
                await reporter.fail("Couldn't prepare the video preview.")
            raise RuntimeError(f"ffmpeg proxy build failed: {(proc.stderr or '')[-500:]}")
        can_copy = False

    tmp.replace(proxy)
    if reporter:
        await reporter.complete("Preview ready.")
    return {
        "proxy_path": str(proxy), "src_codec": src_codec, "height": height,
        "duration": duration, "transcoded": not can_copy, "cached": False,
    }


_SIL_START = re.compile(r"silence_start:\s*([-\d.]+)")
_SIL_END = re.compile(r"silence_end:\s*([-\d.]+)")


async def silence_regions(src_path: str | Path) -> list[tuple[float, float]]:
    """Return sorted (start, end) silence spans via ffmpeg ``silencedetect``.

    Runs on the original source (audio decoding works regardless of the video
    codec). Returns an empty list if ffmpeg fails — tightening then simply
    no-ops, leaving raw transcript boundaries (safe degradation).
    """
    src = Path(src_path)
    if not src.exists():
        raise FileNotFoundError(f"Source clip not found: {src}")

    ffmpeg = get_settings().FFMPEG_PATH
    # -vn: silence detection only needs the AUDIO. Without it, ffmpeg also decodes
    # the (HEVC) video stream — pointless work that made this take ~2 min on the
    # test clip. Audio-only decode is near-instant.
    cmd = [
        ffmpeg, "-hide_banner", "-vn", "-i", str(src),
        "-af", f"silencedetect=noise={_SILENCE_NOISE_DB}:d={_SILENCE_MIN_DUR}",
        "-f", "null", "-",
    ]
    proc = await run_ffmpeg_async(cmd, timeout=600)
    stderr = proc.stderr or ""
    regions: list[tuple[float, float]] = []
    cur: Optional[float] = None
    for line in stderr.splitlines():
        ms = _SIL_START.search(line)
        if ms:
            cur = float(ms.group(1))
            continue
        me = _SIL_END.search(line)
        if me and cur is not None:
            regions.append((cur, float(me.group(1))))
            cur = None
    regions.sort()
    logger.info("review.silence_regions: %d span(s) in %s", len(regions), src.name)
    return regions


def _peaks_path(src_path: str | Path) -> Path:
    d = get_settings().DATA_DIR / "review" / "peaks"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{fingerprint_short(src_path, 16)}.json"


async def waveform_peaks(src_path: str | Path, buckets: int = 1600) -> list[float]:
    """Return ``buckets`` normalized amplitude peaks (0..1) for the waveform strip.

    Decodes audio only (8 kHz mono s16le) and reduces it to one peak per bucket.
    Cached by content fingerprint. Returns ``[]`` on failure (the UI then just
    omits the waveform). Audio-only (`-vn`) so HEVC video is never decoded.
    """
    src = Path(src_path)
    if not src.exists():
        raise FileNotFoundError(f"Source clip not found: {src}")

    cache = _peaks_path(src)
    if cache.exists() and cache.stat().st_size > 0:
        try:
            return json.loads(cache.read_text(encoding="utf-8")).get("peaks", [])
        except Exception:  # noqa: BLE001
            pass

    ffmpeg = get_settings().FFMPEG_PATH
    cmd = [ffmpeg, "-v", "error", "-vn", "-i", str(src),
           "-ac", "1", "-ar", "8000", "-f", "s16le", "-"]
    proc = await asyncio.to_thread(subprocess.run, cmd, capture_output=True)
    raw = proc.stdout or b""
    if not raw:
        return []
    samples = array.array("h")
    samples.frombytes(raw[: len(raw) - (len(raw) % 2)])
    n = len(samples)
    if n == 0:
        return []

    per = max(1, n // buckets)
    peaks: list[int] = []
    for i in range(0, n, per):
        hi = 0
        for x in samples[i:i + per]:
            ax = x if x >= 0 else -x
            if ax > hi:
                hi = ax
        peaks.append(hi)
    top = max(peaks) or 1
    norm = [round(p / top, 3) for p in peaks]

    try:
        cache.write_text(json.dumps({"peaks": norm}), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        logger.debug("review.waveform_peaks: cache write failed: %s", exc)
    return norm
