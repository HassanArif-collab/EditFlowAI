"""
EditFlow AI - Content-Addressed Media Fingerprinting

Computes deterministic fingerprints for media files so that:
1. The same file never gets re-transcribed (transcribe-once-per-source-file).
2. Identical files in different folders are recognised as duplicates.
3. A file whose content has changed gets a new fingerprint, invalidating caches.

The fingerprint is a SHA-256 hex digest of the file's byte content.
For audio files we also compute a "waveform fingerprint" — the SHA-256 of
the raw PCM data after decoding to 16 kHz mono — so that files with
different containers but identical audio content share the same audio
fingerprint.

Phase B deliverable: every media file that enters the pipeline gets
fingerprinted before any expensive work (audio extraction, transcription)
is done.  All downstream caches (audio WAV cache, transcript cache) are
keyed by fingerprint, not by file path.
"""
from __future__ import annotations

import hashlib
import logging
import struct
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Buffer size for streaming hash computation — 1 MiB.
_BUF_SIZE = 1 << 20


def compute_file_fingerprint(path: str | Path) -> str:
    """Compute a SHA-256 fingerprint of a file's byte content.

    This is a *file-level* fingerprint: two files with identical byte content
    (even if they live at different paths) produce the same fingerprint.
    Two files with different byte content produce different fingerprints
    (barring a SHA-256 collision, which is computationally infeasible).

    Args:
        path: Path to the file.

    Returns:
        64-character lowercase hex string (SHA-256 digest).

    Raises:
        FileNotFoundError: If the file does not exist.
        OSError: If the file cannot be read.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Cannot fingerprint non-existent file: {path}")

    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(_BUF_SIZE)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def compute_audio_fingerprint(path: str | Path) -> str:
    """Compute a SHA-256 fingerprint of the audio content in a file.

    For WAV files this reads the raw PCM samples directly, skipping the
    44-byte RIFF header.  For non-WAV files this falls back to the file
    fingerprint (byte-level SHA-256), since decoding arbitrary containers
    would require ffmpeg.

    The audio fingerprint is independent of the container format — a .wav
    and a .flac containing the same PCM data at the same sample rate will
    have different *file* fingerprints but could theoretically have the
    same *audio* fingerprint once decoded.  In practice we only read PCM
    from WAV here; other formats use the file fingerprint as a proxy.

    Args:
        path: Path to the audio file.

    Returns:
        64-character lowercase hex string.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Cannot fingerprint non-existent file: {path}")

    suffix = path.suffix.lower()

    if suffix == ".wav":
        return _wav_pcm_fingerprint(path)
    # For non-WAV audio/video files, the file fingerprint is the best we
    # can do without running ffmpeg.  The audio-prepare step (which does
    # run ffmpeg) will compute a proper audio fingerprint after extraction.
    return compute_file_fingerprint(path)


def _wav_pcm_fingerprint(path: Path) -> str:
    """SHA-256 of the PCM sample data in a standard 44-byte-header WAV.

    Most WAV files produced by ffmpeg's ``pcm_s16le`` codec use a standard
    44-byte RIFF header.  We skip those 44 bytes and hash the rest (the
    raw PCM data).  If the header is non-standard (e.g. extra chunks),
    we fall back to hashing the entire file.
    """
    h = hashlib.sha256()
    with open(path, "rb") as f:
        # Read and validate the RIFF header
        header = f.read(44)
        if len(header) < 44:
            # Tiny file — hash everything
            h.update(header)
            return h.hexdigest()

        # Check for RIFF....WAVE marker
        is_standard_wav = (
            header[:4] == b"RIFF"
            and header[8:12] == b"WAVE"
            and header[12:16] == b"fmt "
        )

        if is_standard_wav:
            # Find the 'data' sub-chunk by walking the RIFF chunk structure.
            # Standard layout: RIFF(12) + fmt(24) + data(header 8) = 44
            # But some WAVs have extra chunks (LIST, INFO, etc.).
            f.seek(12)  # Skip RIFF header (12 bytes)
            data_start = None
            while True:
                chunk_header = f.read(8)
                if len(chunk_header) < 8:
                    break
                chunk_id = chunk_header[:4]
                chunk_size = struct.unpack("<I", chunk_header[4:8])[0]
                if chunk_id == b"data":
                    data_start = f.tell()
                    break
                # Skip this chunk's data
                f.seek(chunk_size, 1)
                # WAV chunks are padded to even size
                if chunk_size % 2:
                    f.seek(1, 1)

            if data_start is not None:
                f.seek(data_start)
                while True:
                    chunk = f.read(_BUF_SIZE)
                    if not chunk:
                        break
                    h.update(chunk)
                return h.hexdigest()

        # Non-standard header — hash entire file
        f.seek(0)
        while True:
            chunk = f.read(_BUF_SIZE)
            if not chunk:
                break
            h.update(chunk)
        return h.hexdigest()


def fingerprint_short(path: str | Path, length: int = 16) -> str:
    """Return the first *length* hex characters of the file fingerprint.

    Useful for cache keys and display where full 64-char hashes are unwieldy.
    Collision probability for 16 chars (64 bits) is negligible for typical
    media libraries (< 1 billion files).
    """
    return compute_file_fingerprint(path)[:length]


def audio_fingerprint_short(path: str | Path, length: int = 16) -> str:
    """Return the first *length* hex characters of the audio fingerprint."""
    return compute_audio_fingerprint(path)[:length]
