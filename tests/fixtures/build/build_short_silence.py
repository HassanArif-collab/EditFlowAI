"""Structural-only fallback for interview_short.wav.

When TTS isn't available (offline machine, no edge-tts install, sandboxed CI),
this script generates a WAV with the **same timing structure** as the canonical
fixture but replaces speech with short sine-wave bursts of low amplitude.

Whisper will produce empty (or garbage) transcripts from this file — that's
expected. The point is to exercise:

  * stage 2 (audio preparation, ffmpeg cache)
  * silero-vad detection of speech vs silence boundaries
  * stage 4 take segmentation purely from VAD output
  * stage 6 cut-boundary math

without depending on a real Whisper model loading and a real network for TTS.

Run instead of `build_short_tts.py` when:
  * Running in CI without network
  * Sanity-checking the pipeline math after a refactor
  * Smoke-testing on a new machine before installing edge-tts

Usage:
    python tests/fixtures/build/build_short_silence.py
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
OUTPUT_WAV = REPO_ROOT / "tests" / "fixtures" / "short" / "interview_short_structural.wav"

# (start_seconds, end_seconds, kind) — matches canonical.json vad_segments
SEGMENTS = [
    ( 0.0,  2.0, "silence"),
    ( 2.0,  9.0, "tone_a"),    # take 1 placeholder (440 Hz)
    ( 9.0, 11.0, "silence"),
    (11.0, 18.0, "tone_b"),    # take 2 placeholder (494 Hz)
    (18.0, 20.0, "silence"),
    (20.0, 31.5, "tone_c"),    # take 3 placeholder (523 Hz)
    (31.5, 33.0, "silence"),
]

TONE_FREQ = {"tone_a": 440, "tone_b": 494, "tone_c": 523}
TONE_AMP = 0.05  # low so it's not deafening — silero-vad uses pattern, not energy alone


def _ffmpeg() -> str:
    """Locate ffmpeg. PATH first, then EDITFLOW_FFMPEG_PATH, then common locations."""
    import os
    found = shutil.which("ffmpeg")
    if found:
        return found
    env_override = os.environ.get("EDITFLOW_FFMPEG_PATH")
    if env_override and Path(env_override).is_file():
        return env_override
    for candidate in (r"C:\tmp\ffmpeg.exe", r"C:\ffmpeg\bin\ffmpeg.exe"):
        if Path(candidate).is_file():
            return candidate
    raise RuntimeError(
        "ffmpeg not found. Install ffmpeg, set EDITFLOW_FFMPEG_PATH, "
        "or drop ffmpeg.exe at C:\\tmp\\ffmpeg.exe."
    )


def _segment_to_file(start: float, end: float, kind: str, dst: Path) -> None:
    dur = end - start
    if kind == "silence":
        src = "anullsrc=channel_layout=mono:sample_rate=16000"
    else:
        freq = TONE_FREQ[kind]
        # Sine with low volume; for VAD-only structural testing this counts
        # as "audio present" but Whisper won't transcribe anything meaningful.
        src = f"sine=frequency={freq}:sample_rate=16000:duration={dur:.3f}"
    cmd = [
        _ffmpeg(), "-y", "-v", "error",
        "-f", "lavfi", "-i", src,
        "-t", f"{dur:.3f}",
        "-ac", "1", "-ar", "16000",
        "-filter:a", f"volume={TONE_AMP if kind != 'silence' else 1.0}",
        "-acodec", "pcm_s16le",
        str(dst),
    ]
    subprocess.run(cmd, check=True)


def _concat(parts: list[Path], dst: Path) -> None:
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as fh:
        for p in parts:
            esc = str(p).replace("'", "'\\''")
            fh.write(f"file '{esc}'\n")
        list_path = Path(fh.name)
    try:
        cmd = [
            _ffmpeg(), "-y", "-v", "error",
            "-f", "concat", "-safe", "0",
            "-i", str(list_path),
            "-c", "copy",
            str(dst),
        ]
        subprocess.run(cmd, check=True)
    finally:
        list_path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-overwrite", action="store_true")
    args = parser.parse_args()

    if OUTPUT_WAV.exists() and not args.allow_overwrite:
        reply = input(f"{OUTPUT_WAV} exists. Overwrite? [y/N] ")
        if reply.strip().lower() != "y":
            print("aborted")
            return 1

    OUTPUT_WAV.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="editflow_struct_") as tmpdir:
        tmp = Path(tmpdir)
        parts: list[Path] = []
        for i, (start, end, kind) in enumerate(SEGMENTS):
            p = tmp / f"seg_{i:02d}_{kind}.wav"
            _segment_to_file(start, end, kind, p)
            parts.append(p)
        _concat(parts, OUTPUT_WAV)

    print(f"wrote {OUTPUT_WAV}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
