"""Rebuild a Premiere sequence's speech track for transcription.

The panel sends the audio clips on the sequence's unmuted tracks (media
path, source in/out, timeline start/end). Each clip's audio is cut from
its source with ffmpeg and dropped at its TIMELINE position in one 16 kHz
mono buffer, so the transcript's word times are sequence times — captions
line up with the edit as cut, with no re-timing step.

Non-overlapping clips (the usual single dialogue track) are copied straight
into place; where clips overlap (several unmuted tracks) the samples are
mixed. Mute a music track in Premiere to keep it out of the transcript.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import subprocess
import wave
from pathlib import Path

logger = logging.getLogger(__name__)

RATE = 16000


def clean_clips(clips: list[dict]) -> tuple[list[dict], list[dict]]:
    """Validate clip dicts → (usable, skipped[{path, reason}])."""
    ok, skipped = [], []
    for c in clips or []:
        path = str(c.get("path") or "")
        try:
            start, end = float(c.get("start", 0)), float(c.get("end", 0))
            src_in = float(c.get("in", 0))
            src_out = float(c.get("out", src_in + (end - start)))
            vol = float(c.get("volume", 1.0))
        except (TypeError, ValueError):
            skipped.append({"path": path, "reason": "bad times"})
            continue
        if not path or not Path(path).is_file():
            skipped.append({"path": path, "reason": "media offline"})
            continue
        if end - start < 0.02 or src_out <= src_in:
            skipped.append({"path": path, "reason": "empty or reversed clip"})
            continue
        if vol <= 0.005:
            skipped.append({"path": path, "reason": "muted in sequence"})
            continue
        ok.append({"path": path, "start": max(0.0, start), "end": end, "in": max(0.0, src_in),
                   "out": src_out, "speed": (src_out - src_in) / (end - start), "volume": vol})
    ok.sort(key=lambda c: c["start"])
    return ok, skipped


def fingerprint(clips: list[dict], extra: str = "") -> str:
    """Stable key for the transcript cache: same edit + same media → same key."""
    items = []
    for c in clips:
        try:
            st = os.stat(c["path"])
            stamp = f"{st.st_size}:{int(st.st_mtime)}"
        except OSError:
            stamp = "?"
        items.append([c["path"], stamp, round(c["start"], 3), round(c["end"], 3),
                      round(c["in"], 3), round(c.get("out", 0), 3),
                      round(float(c.get("volume", 1.0)), 3)])
    return hashlib.sha256((json.dumps(items) + "|" + extra).encode("utf-8")).hexdigest()[:16]


def _atempo(speed: float) -> str:
    # atempo accepts 0.5–2.0 per stage on older ffmpeg: chain stages.
    stages, s = [], speed
    while s > 2.0:
        stages.append("atempo=2.0"); s /= 2.0
    while s < 0.5:
        stages.append("atempo=0.5"); s /= 0.5
    stages.append(f"atempo={s:.6f}")
    return ",".join(stages)


def extract_command(ffmpeg: str, clip: dict) -> list[str]:
    cmd = [ffmpeg, "-v", "error", "-nostdin", "-ss", f"{clip['in']:.3f}",
           "-accurate_seek", "-i", clip["path"],
           "-t", f"{clip['out'] - clip['in']:.3f}", "-vn"]
    filters = []
    if abs(clip.get("speed", 1.0) - 1.0) > 0.01:
        filters.append(_atempo(clip["speed"]))
    vol = float(clip.get("volume", 1.0))
    if abs(vol - 1.0) > 0.01:
        filters.append(f"volume={vol:.4f}")
    if filters:
        cmd += ["-af", ",".join(filters)]
    return cmd + ["-ac", "1", "-ar", str(RATE), "-f", "s16le", "-"]


def mix_sequence_audio(ffmpeg: str, clips: list[dict], out_wav: Path, duration: float | None = None) -> dict:
    """Write the mixed 16 kHz mono WAV. Returns {duration, clips, overlaps}."""
    if not clips:
        raise ValueError("No usable audio clips on unmuted tracks.")
    from ...utils.error_helpers import check_and_prune_disk_space, clean_system_error
    check_and_prune_disk_space(out_wav.parent, min_mb=50, auto_prune=True, prune_pattern="*.wav", keep_count=10)

    total = max(duration or 0.0, max(c["end"] for c in clips))
    buf = bytearray(int(total * RATE + RATE) * 2)
    written: list[tuple[int, int]] = []        # sample ranges already filled
    overlaps = 0
    for c in clips:
        proc = subprocess.run(extract_command(ffmpeg, c), capture_output=True, timeout=600)
        if proc.returncode != 0:
            logger.warning("sequence audio: skipped %s: %s", c["path"],
                           proc.stderr.decode("utf-8", errors="replace")[-300:])
            continue
        pcm = proc.stdout
        a = int(round(c["start"] * RATE))
        n = min(len(pcm) // 2, int(round((c["end"] - c["start"]) * RATE)), len(buf) // 2 - a)
        if n <= 0:
            continue
        b = a + n
        if any(x < b and a < y for x, y in written):
            overlaps += 1
            _mix_into(buf, a, pcm[: n * 2])
        else:
            buf[a * 2: b * 2] = pcm[: n * 2]
        written.append((a, b))

    if written:
        _normalize_pcm(buf)
    else:
        logger.warning("sequence audio: no audio could be extracted from clips, writing silence")

    out_wav.parent.mkdir(parents=True, exist_ok=True)
    tmp_wav = out_wav.with_suffix(".tmp.wav")
    try:
        with wave.open(str(tmp_wav), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes(bytes(buf))
        os.replace(tmp_wav, out_wav)
    except Exception as exc:
        if tmp_wav.exists():
            try:
                tmp_wav.unlink(missing_ok=True)
            except OSError:
                pass
        raise RuntimeError(clean_system_error(exc, target_path=out_wav)) from exc

    return {"duration": round(total, 3), "clips": len(clips), "overlaps": overlaps}


def _normalize_pcm(buf: bytearray) -> None:
    """Soft-limit int16 PCM buffer only if overlapping tracks exceed digital ceiling (clipping protection)."""
    try:
        import numpy as np
        samples = np.frombuffer(buf, dtype="<i2")
        peak = int(np.max(np.abs(samples)))
        if peak > 32000:
            scale = 31500.0 / peak
            limited = np.clip(samples.astype(np.float32) * scale, -32768, 32767).astype("<i2")
            buf[:] = limited.tobytes()
    except Exception:
        pass


def _mix_into(buf: bytearray, start: int, pcm: bytes) -> None:
    """buf[start:] += pcm (int16, saturating)."""
    try:
        import numpy as np
        dst = np.frombuffer(buf, dtype="<i2", count=len(pcm) // 2, offset=start * 2)
        mixed = np.clip(dst.astype(np.int32) + np.frombuffer(pcm, dtype="<i2"), -32768, 32767)
        buf[start * 2: start * 2 + len(pcm)] = mixed.astype("<i2").tobytes()
    except ImportError:          # numpy ships with faster-whisper; this is a safety net
        buf[start * 2: start * 2 + len(pcm)] = pcm
