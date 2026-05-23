"""
EditFlow AI - Content-Addressed Audio Preparation

Stage 2 of the take-based editing pipeline.  Given a source media file
(video or audio), this service:

1. Computes a content-addressed fingerprint (content_hash).
2. Checks the audio cache — if a 16 kHz mono WAV already exists for this
   (content_hash, range_in, range_out) combination, returns it immediately.
3. If not cached, extracts audio via ffmpeg to 16 kHz mono PCM WAV.
   - If a range (source_in, source_out) is specified, extracts just that
     range with 1.0 s padding on each side (so word boundaries near the
     edges aren't cut off).
   - Ranges are rounded to the nearest 100 ms per the plan.
4. Computes the *audio* fingerprint of the extracted WAV (PCM-level hash).
5. Stores the prepared audio in the cache directory keyed by
   ``{content_hash}_{in:.3f}_{out:.3f}.wav``.
6. Returns a ``PreparedAudio`` result with all metadata.

Every downstream operation (Whisper transcription, VAD, segmenter) reads
from the prepared audio cache, never from the original file.  This ensures:

- **Transcribe-once-per-source-file**: the (content_hash, range) is the
  cache key.  If the same file is referenced from two different clips or
  folders, transcription only runs once.
- **Reproducibility**: the same source content always produces the same
  prepared WAV, regardless of where the file lives on disk.
- **Invalidation**: if the source file changes, its content_hash changes,
  and the cache misses — forcing a fresh extraction + transcription.
"""
from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any, Dict, Optional

from ..config import Settings, get_settings
from ..models.schemas import PreparedAudio
from ..services.media_fingerprint import (
    compute_audio_fingerprint,
    compute_file_fingerprint,
)
from ..utils.ffmpeg_utils import extract_audio

logger = logging.getLogger(__name__)


class AudioPrepareService:
    """Content-addressed audio preparation: extract, cache, fingerprint."""

    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()

    # Padding around extracted range (seconds).  Per the plan, we add
    # 1.0 s on each side so word boundaries near the edges aren't cut off.
    _RANGE_PADDING_S = 1.0

    def prepare(
        self,
        source_path: str | Path,
        source_in: float | None = None,
        source_out: float | None = None,
        audio_stream_index: int = 0,
    ) -> PreparedAudio:
        """Prepare audio from a source file with content-addressed caching.

        If a prepared WAV already exists for this source file's fingerprint
        and range, return it without re-extracting.  This is the core of the
        transcribe-once-per-source-file guarantee.

        Per the plan (Stage 2):
        - If source_in/source_out are specified, extract *just* that range
          with 1.0 s padding on each side.
        - Ranges are rounded to the nearest 100 ms.
        - The cache key is (content_hash, range_in, range_out).
        - The filename is ``{content_hash}_{in:.3f}_{out:.3f}.wav``.

        Args:
            source_path: Path to the source media file (video or audio).
            source_in: Start of the needed range in seconds (None = 0).
            source_out: End of the needed range in seconds (None = whole file).
            audio_stream_index: Which audio stream to extract (default 0).

        Returns:
            PreparedAudio with fingerprint, cache path, and metadata.

        Raises:
            FileNotFoundError: If source_path does not exist.
            RuntimeError: If audio extraction fails.
        """
        source = Path(source_path).resolve()
        if not source.exists():
            raise FileNotFoundError(f"Source file not found: {source}")

        # ── Step 1: Compute the file-level content hash ──
        file_fp = compute_file_fingerprint(source)
        logger.info(f"Content hash for {source.name}: {file_fp[:16]}...")

        # ── Step 1b: Determine the range (rounded to 100ms) ──
        # Per the plan: "in_rounded_to_100ms, out_rounded_to_100ms"
        range_in = round((source_in or 0.0) * 10) / 10  # nearest 100ms
        range_out = round((source_out or 0.0) * 10) / 10 if source_out is not None else 0.0

        # ── Step 2: Check the audio cache ──
        cache_dir = Path(self.settings.MEDIA_CACHE_DIR) / "audio"
        cache_dir.mkdir(parents=True, exist_ok=True)

        # The prepared WAV is keyed by (content_hash, range_in, range_out).
        # When no range is specified, both are 0 → simple whole-file cache.
        cache_key = f"{file_fp}_{range_in:.3f}_{range_out:.3f}"
        cached_wav = cache_dir / f"{cache_key}.wav"
        if cached_wav.exists():
            # Mtime check: if source file is newer than cached WAV, regenerate
            try:
                source_mtime = source.stat().st_mtime
                cache_mtime = cached_wav.stat().st_mtime
                if source_mtime > cache_mtime:
                    logger.info(f"Source newer than cache for {source.name}, regenerating")
                    cached_wav.unlink(missing_ok=True)
                else:
                    # Cache is valid
                    audio_fp = compute_audio_fingerprint(cached_wav)
                    duration = self._wav_duration(cached_wav)
                    logger.info(
                        f"Audio cache hit for {source.name} "
                        f"(fp={file_fp[:16]}..., in={range_in:.3f}, out={range_out:.3f}), "
                        f"duration={duration:.2f}s"
                    )
                    return PreparedAudio(
                        source_file=str(source),
                        file_fingerprint=file_fp,
                        audio_fingerprint=audio_fp,
                        prepared_wav_path=str(cached_wav),
                        duration=duration,
                        sample_rate=16000,
                        channels=1,
                        from_cache=True,
                    )
            except OSError:
                # If we can't check mtimes, fall through to cache hit below
                audio_fp = compute_audio_fingerprint(cached_wav)
                duration = self._wav_duration(cached_wav)
                logger.info(
                    f"Audio cache hit for {source.name} "
                    f"(fp={file_fp[:16]}..., in={range_in:.3f}, out={range_out:.3f}), "
                    f"duration={duration:.2f}s"
                )
                return PreparedAudio(
                    source_file=str(source),
                    file_fingerprint=file_fp,
                    audio_fingerprint=audio_fp,
                    prepared_wav_path=str(cached_wav),
                    duration=duration,
                    sample_rate=16000,
                    channels=1,
                    from_cache=True,
                )

        # ── Step 3: Extract audio via ffmpeg ──
        # If a range is specified, add 1.0s padding and use -ss/-t for seeking.
        # If no range, extract the whole file (backward-compatible).
        tmp_wav = cache_dir / f"{cache_key}.tmp.wav"
        try:
            if source_in is not None or source_out is not None:
                self._extract_range(
                    source, tmp_wav,
                    source_in=source_in or 0.0,
                    source_out=source_out,
                    audio_stream_index=audio_stream_index,
                )
            else:
                extract_audio(source, tmp_wav, sample_rate=16000)
        except Exception as e:
            # Clean up partial file
            if tmp_wav.exists():
                tmp_wav.unlink(missing_ok=True)
            raise RuntimeError(
                f"Audio extraction failed for {source}: {e}"
            ) from e

        # ── Step 4: Compute audio-level fingerprint ──
        audio_fp = compute_audio_fingerprint(tmp_wav)
        duration = self._wav_duration(tmp_wav)

        # ── Step 5: Atomically move to final cache location ──
        try:
            shutil.move(str(tmp_wav), str(cached_wav))
        except OSError:
            # Another process may have written it; that's fine.
            if tmp_wav.exists():
                tmp_wav.unlink(missing_ok=True)

        logger.info(
            f"Audio prepared for {source.name}: "
            f"file_fp={file_fp[:16]}..., audio_fp={audio_fp[:16]}..., "
            f"duration={duration:.2f}s, cached at {cached_wav.name}"
        )

        return PreparedAudio(
            source_file=str(source),
            file_fingerprint=file_fp,
            audio_fingerprint=audio_fp,
            prepared_wav_path=str(cached_wav),
            duration=duration,
            sample_rate=16000,
            channels=1,
            from_cache=False,
        )

    def _extract_range(
        self,
        source: Path,
        output: Path,
        source_in: float,
        source_out: float | None,
        audio_stream_index: int = 0,
    ) -> None:
        """Extract a range of audio with 1.0s padding.

        Uses ffmpeg ``-ss`` and ``-t`` with padding applied before the
        start and after the end.  The padding ensures word boundaries
        near the edges of the requested range aren't cut off.

        Per the plan: ``ffmpeg -ss in -t (out-in) -map 0:a:{audio_stream_index}
        -ac 1 -ar 16000 -vn -y``.
        """
        import subprocess

        pad = self._RANGE_PADDING_S
        seek = max(0.0, source_in - pad)
        if source_out is not None:
            end = source_out + pad
            duration = end - seek
        else:
            duration = None  # extract to end

        cmd = [
            self.settings.FFMPEG_PATH, "-y",
            "-ss", f"{seek:.3f}",
        ]
        if duration is not None:
            cmd.extend(["-t", f"{duration:.3f}"])

        cmd.extend([
            "-i", str(source),
            "-map", f"0:a:{audio_stream_index}",
            "-ac", "1",
            "-ar", "16000",
            "-vn",
            str(output),
        ])

        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=120,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"ffmpeg range extraction failed (rc={result.returncode}): "
                f"{result.stderr[:500]}"
            )

    def get_cached(self, file_fingerprint: str, range_in: float = 0.0, range_out: float = 0.0) -> Optional[PreparedAudio]:
        """Look up a previously prepared audio file by file fingerprint + range.

        Returns None if no cached WAV exists for this fingerprint and range.
        """
        cache_dir = Path(self.settings.MEDIA_CACHE_DIR) / "audio"
        # New cache key format includes range
        cache_key = f"{file_fingerprint}_{range_in:.3f}_{range_out:.3f}"
        cached_wav = cache_dir / f"{cache_key}.wav"
        if not cached_wav.exists():
            # Fall back to old format (no range suffix) for backward compat
            cached_wav = cache_dir / f"{file_fingerprint}.wav"
            if not cached_wav.exists():
                return None

        audio_fp = compute_audio_fingerprint(cached_wav)
        duration = self._wav_duration(cached_wav)

        return PreparedAudio(
            source_file="",  # Original source path unknown in cache-only lookup
            file_fingerprint=file_fingerprint,
            audio_fingerprint=audio_fp,
            prepared_wav_path=str(cached_wav),
            duration=duration,
            sample_rate=16000,
            channels=1,
            from_cache=True,
        )

    def invalidate(self, file_fingerprint: str, range_in: float = 0.0, range_out: float = 0.0) -> bool:
        """Remove a cached prepared audio file.

        Returns True if the file was removed, False if it wasn't in cache.
        Removes both new-format and old-format cache files for the fingerprint.
        """
        cache_dir = Path(self.settings.MEDIA_CACHE_DIR) / "audio"
        removed = False

        # New format: {fp}_{in:.3f}_{out:.3f}.wav
        cache_key = f"{file_fingerprint}_{range_in:.3f}_{range_out:.3f}"
        new_wav = cache_dir / f"{cache_key}.wav"
        if new_wav.exists():
            new_wav.unlink()
            removed = True

        # Old format: {fp}.wav (backward compat)
        old_wav = cache_dir / f"{file_fingerprint}.wav"
        if old_wav.exists():
            old_wav.unlink()
            removed = True

        # Also remove any range-based cache files for this fingerprint
        for wav_file in cache_dir.glob(f"{file_fingerprint}_*.wav"):
            wav_file.unlink()
            removed = True

        if removed:
            logger.info(f"Invalidated audio cache for fp={file_fingerprint[:16]}...")
        return removed

    @staticmethod
    def _wav_duration(path: Path) -> float:
        """Compute duration of a WAV file from its header.

        Uses pure Python — no ffprobe dependency.  Falls back to 0.0 if
        the header can't be parsed.
        """
        import struct

        try:
            with open(path, "rb") as f:
                header = f.read(44)
                if len(header) < 44:
                    return 0.0
                # RIFF header: bytes 16-20 = audio format, 20-22 = channels,
                # 22-24 = sample rate, 24-28 = byte rate, 28-30 = block align,
                # 30-32 = bits per sample.
                # For data chunk starting at byte 36: bytes 40-44 = data size.
                # But we should find the 'data' chunk properly.
                f.seek(0)
                # Skip RIFF header (12 bytes)
                f.read(12)
                data_size = None
                sample_rate = 16000
                channels = 1
                bits_per_sample = 16
                while True:
                    chunk_header = f.read(8)
                    if len(chunk_header) < 8:
                        break
                    chunk_id = chunk_header[:4]
                    chunk_size = struct.unpack("<I", chunk_header[4:8])[0]

                    if chunk_id == b"fmt ":
                        fmt_data = f.read(chunk_size)
                        if len(fmt_data) >= 16:
                            channels = struct.unpack("<H", fmt_data[2:4])[0]
                            sample_rate = struct.unpack("<I", fmt_data[4:8])[0]
                            bits_per_sample = struct.unpack("<H", fmt_data[14:16])[0]
                    elif chunk_id == b"data":
                        data_size = chunk_size
                        break
                    else:
                        f.seek(chunk_size, 1)
                        if chunk_size % 2:
                            f.seek(1, 1)

                if data_size is not None and sample_rate > 0 and channels > 0:
                    bytes_per_sample = bits_per_sample // 8
                    if bytes_per_sample == 0:
                        bytes_per_sample = 2  # assume 16-bit
                    num_samples = data_size // (bytes_per_sample * channels)
                    return num_samples / sample_rate
            return 0.0
        except Exception:
            return 0.0


# Global service instance
audio_prepare_service = AudioPrepareService()
