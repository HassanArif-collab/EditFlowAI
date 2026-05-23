"""Build the interview_short.wav fixture using Microsoft Edge TTS.

Edge-tts is free, deterministic per voice + text, no API key, no auth.
Requires `pip install edge-tts`.

Why edge-tts: out-of-the-box high quality, much closer to real-voice acoustics
than espeak/festival/pyttsx3. Whisper transcribes it cleanly. Voice is fixed so
the same script produces byte-identical (or near-identical) audio across machines.

Output: tests/fixtures/short/interview_short.wav

The audio is structured to match `tests/fixtures/short/spec.md` and
`tests/fixtures/short/canonical.json`. Three takes separated by silence gaps:

    0.0–2.0    silence  (room tone)
    2.0–9.0    take 1   ("Hello and welcome back ... uh ... really cool.")
    9.0–11.0   silence  (1.5 s + a bit of room tone)
    11.0–18.0  take 2   ("Today I want to talk ... uh ... fascinating.")
    18.0–20.0  silence
    20.0–31.5  take 3   ("Welcome back to the channel ... really enjoy.")
    31.5–33.0  silence  (tail)

If timings drift from the canonical spec by more than ~0.5 s due to TTS rate
variance, edit the SCRIPTS list below to be slightly shorter/longer until the
real audio matches.

Usage:
    python tests/fixtures/build/build_short_tts.py
"""
from __future__ import annotations

import argparse
import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
OUTPUT_WAV = REPO_ROOT / "tests" / "fixtures" / "short" / "interview_short.wav"

# Voice choice: en-US-AriaNeural is a clear female voice, well-known to whisperX
# transcribers, robust across Whisper model sizes.
VOICE = "en-US-AriaNeural"
RATE = "+0%"  # default rate
PITCH = "+0Hz"

# Each tuple = (text, target_duration_seconds_approx, post_silence_seconds)
# Insert "<silence-Xs/>" SSML-style tokens by adding `_pause` markers.
# edge-tts does not support raw SSML breaks reliably across all voices, so we
# generate each take separately and stitch with ffmpeg silence.
TAKES = [
    {
        "text": "Hello and welcome back to my channel. Today I want to, uh, talk about something really cool.",
        "lead_silence": 2.0,
        "trail_silence": 2.0,  # before the next take
    },
    {
        "text": "Today I want to talk about something interesting, uh, something that I think you'll find fascinating.",
        "lead_silence": 0.0,
        "trail_silence": 2.0,
    },
    {
        "text": "Welcome back to the channel. Today I want to discuss a fascinating topic that I think you'll really enjoy.",
        "lead_silence": 0.0,
        "trail_silence": 1.5,
    },
]


def _have_edge_tts() -> bool:
    try:
        import edge_tts  # noqa: F401
        return True
    except ImportError:
        return False


def _ffmpeg() -> str:
    """Locate ffmpeg. PATH first, then EDITFLOW_FFMPEG_PATH, then common locations."""
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


async def _synth_one(text: str, out_path: Path) -> None:
    import edge_tts
    communicate = edge_tts.Communicate(text=text, voice=VOICE, rate=RATE, pitch=PITCH)
    await communicate.save(str(out_path))


def _to_pcm_16k_mono(src: Path, dst: Path) -> None:
    """edge-tts gives us mp3. Convert to mono 16 kHz PCM WAV."""
    cmd = [
        _ffmpeg(), "-y", "-v", "error",
        "-i", str(src),
        "-ac", "1", "-ar", "16000",
        "-acodec", "pcm_s16le",
        str(dst),
    ]
    subprocess.run(cmd, check=True)


def _silence_wav(seconds: float, dst: Path) -> None:
    cmd = [
        _ffmpeg(), "-y", "-v", "error",
        "-f", "lavfi",
        "-i", f"anullsrc=channel_layout=mono:sample_rate=16000",
        "-t", f"{seconds:.3f}",
        "-acodec", "pcm_s16le",
        str(dst),
    ]
    subprocess.run(cmd, check=True)


def _concat(parts: list[Path], dst: Path) -> None:
    """Use ffmpeg concat demuxer — bit-perfect, no re-encode."""
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


def _measure_duration(path: Path) -> float:
    """Get duration from a PCM WAV via Python's stdlib (no ffprobe needed)."""
    with wave.open(str(path), "rb") as w:
        frames = w.getnframes()
        rate = w.getframerate()
        return frames / float(rate) if rate else 0.0


async def _build_async() -> None:
    OUTPUT_WAV.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="editflow_fixture_") as tmpdir:
        tmp = Path(tmpdir)
        parts: list[Path] = []

        for i, take in enumerate(TAKES):
            # Lead silence (only the very first take's lead silence is the
            # 2-second room-tone leader).
            if take["lead_silence"] > 0:
                sil = tmp / f"sil_lead_{i}.wav"
                _silence_wav(take["lead_silence"], sil)
                parts.append(sil)

            mp3 = tmp / f"take_{i}.mp3"
            wav = tmp / f"take_{i}.wav"
            print(f"  synth take {i}: {take['text'][:60]}...")
            await _synth_one(take["text"], mp3)
            _to_pcm_16k_mono(mp3, wav)
            dur = _measure_duration(wav)
            print(f"    -> {dur:.2f}s of speech")
            parts.append(wav)

            if take["trail_silence"] > 0:
                sil = tmp / f"sil_trail_{i}.wav"
                _silence_wav(take["trail_silence"], sil)
                parts.append(sil)

        print(f"  concatenating {len(parts)} parts -> {OUTPUT_WAV}")
        _concat(parts, OUTPUT_WAV)
        total = _measure_duration(OUTPUT_WAV)
        print(f"  done. final duration: {total:.2f}s (canonical expects 33.00s ± 1.5s)")
        if abs(total - 33.0) > 1.5:
            print(
                f"  WARNING: duration drift > 1.5s. Edit TAKES rates or silence "
                f"durations in this script and re-run, or update canonical.json "
                f"to match the new timings.",
                file=sys.stderr,
            )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--allow-overwrite",
        action="store_true",
        help="Overwrite existing interview_short.wav without prompting.",
    )
    args = parser.parse_args()

    if OUTPUT_WAV.exists() and not args.allow_overwrite:
        reply = input(f"{OUTPUT_WAV} exists. Overwrite? [y/N] ")
        if reply.strip().lower() != "y":
            print("aborted")
            return 1

    if not _have_edge_tts():
        print("edge-tts not installed. Run: pip install edge-tts", file=sys.stderr)
        print("Or use build_short_silence.py for the structural-only fixture.", file=sys.stderr)
        return 2

    asyncio.run(_build_async())
    return 0


if __name__ == "__main__":
    sys.exit(main())
