"""Caption overlay encoder — raw RGBA frames from the panel → ProRes 4444.

The panel renders every caption frame with the same code as its live
preview (WYSIWYG) and streams them here; this module only encodes. Frames
arrive at the sequence's EXACT rate (e.g. 30000/1001), so the overlay lines
up frame-for-frame with the timeline — no 30 fps conform, no stutter.

Only the band of rows captions can touch is sent (the rest of the frame is
transparent); ffmpeg pads it back to full size. Identical consecutive
frames (holds) are sent as a "repeat" op instead of pixels.

Wire format of a frames batch: a sequence of records
    0x01 + width*band_h*4 bytes (RGBA, straight alpha)   — a new frame
    0x02 + uint32 LE count                               — repeat last frame
"""
from __future__ import annotations

import logging
import queue
import struct
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

OP_FRAME = 1
OP_REPEAT = 2
MAX_JOBS = 4
STALE_SECONDS = 15 * 60


@dataclass
class EncodeJob:
    id: str
    path: Path
    width: int
    height: int
    band_y: int
    band_h: int
    fps_num: int
    fps_den: int
    proc: subprocess.Popen
    frames: int = 0
    started: float = field(default_factory=time.time)
    touched: float = field(default_factory=time.time)
    last: bytes | None = None
    stderr_tail: bytearray = field(default_factory=bytearray)
    lock: threading.Lock = field(default_factory=threading.Lock)
    # Batches are parsed on arrival and written to ffmpeg by a writer thread,
    # so the panel renders the next batch while ffmpeg encodes this one. A
    # small bounded queue keeps memory flat and slows the panel if ffmpeg lags.
    q: queue.Queue = field(default_factory=lambda: queue.Queue(maxsize=3))
    writer: threading.Thread | None = None
    error: str | None = None

    @property
    def frame_bytes(self) -> int:
        return self.width * self.band_h * 4


_jobs: dict[str, EncodeJob] = {}
_jobs_lock = threading.Lock()


CODECS = ("prores", "animation")


def build_command(ffmpeg: str, width: int, height: int, band_y: int, band_h: int,
                  fps_num: int, fps_den: int, out_path: Path, codec: str = "prores") -> list[str]:
    """ffmpeg argv: raw RGBA band on stdin → padded full-frame overlay.

    prores    — ProRes 4444 + alpha, BT.709 tagged (default: smallest files,
                imports everywhere).
    animation — QuickTime Animation, every frame a keyframe (Premiere only
                decodes Animation without delta frames); ~3x faster to
                render, lossless, larger files.
    """
    head = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{width}x{band_h}",
        "-framerate", f"{fps_num}/{fps_den}", "-i", "pipe:0",
    ]
    pad = f"pad={width}:{height}:0:{band_y}:color=black@0"
    if codec == "animation":
        return head + ["-vf", pad + ",format=argb", "-c:v", "qtrle", "-g", "1", str(out_path)]
    return head + [
        "-vf", pad + ",scale=out_color_matrix=bt709:out_range=tv,format=yuva444p10le",
        "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
        "-alpha_bits", "16", "-vendor", "apl0",
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
        str(out_path),
    ]


def _drain(job: EncodeJob) -> None:
    for chunk in iter(lambda: job.proc.stderr.read(4096), b""):
        job.stderr_tail.extend(chunk)
        del job.stderr_tail[:-8192]


def _reap_stale() -> None:
    now = time.time()
    with _jobs_lock:
        stale = [j for j in _jobs.values() if now - j.touched > STALE_SECONDS]
    for j in stale:
        cancel(j.id)


def start(ffmpeg: str, out_path: Path, width: int, height: int, band_y: int, band_h: int,
          fps_num: int, fps_den: int, codec: str = "prores") -> EncodeJob:
    if not (16 <= width <= 8192 and 16 <= height <= 8192):
        raise ValueError(f"bad frame size {width}x{height}")
    if not (0 <= band_y and 2 <= band_h and band_y + band_h <= height):
        raise ValueError(f"bad caption band y={band_y} h={band_h} for height {height}")
    if not (fps_num > 0 and fps_den > 0 and 1 <= fps_num / fps_den <= 240):
        raise ValueError(f"bad frame rate {fps_num}/{fps_den}")
    if codec not in CODECS:
        raise ValueError(f"unknown codec {codec!r}")
    _reap_stale()
    with _jobs_lock:
        if len(_jobs) >= MAX_JOBS:
            raise RuntimeError("Too many caption renders running — cancel one first.")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = build_command(ffmpeg, width, height, band_y, band_h, fps_num, fps_den, out_path, codec)
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE, bufsize=0)
    job = EncodeJob(id=uuid.uuid4().hex[:12], path=out_path, width=width, height=height,
                    band_y=band_y, band_h=band_h, fps_num=fps_num, fps_den=fps_den, proc=proc)
    threading.Thread(target=_drain, args=(job,), daemon=True).start()
    with _jobs_lock:
        _jobs[job.id] = job
    logger.info("caption encode %s: %dx%d band %d+%d @ %d/%d → %s", job.id, width, height,
                band_y, band_h, fps_num, fps_den, out_path.name)
    return job


def get(job_id: str) -> EncodeJob:
    with _jobs_lock:
        job = _jobs.get(job_id)
    if job is None:
        raise KeyError(job_id)
    return job


def _error(job: EncodeJob) -> str:
    return bytes(job.stderr_tail).decode("utf-8", errors="replace").strip()[-600:] or "ffmpeg exited"


def _write_loop(job: EncodeJob) -> None:
    """Writer thread: drain parsed batches into ffmpeg's stdin, in order."""
    while True:
        batch = job.q.get()
        if batch is None:
            return
        if job.error:
            continue                       # keep draining so feed() never blocks forever
        try:
            for frame, count in batch:
                for _ in range(count):
                    job.proc.stdin.write(frame)
        except (BrokenPipeError, OSError, ValueError):
            job.error = f"encoder stopped: {_error(job)}"


def feed(job: EncodeJob, payload: bytes) -> int:
    """Parse one batch of records and queue it for ffmpeg. Returns the total
    frames accepted so far. Raises on a malformed batch or a dead encoder."""
    fb = job.frame_bytes
    view = memoryview(payload)
    batch: list[tuple[bytes, int]] = []
    i, n = 0, 0
    with job.lock:
        job.touched = time.time()
        if job.error or job.proc.poll() is not None:
            raise RuntimeError(job.error or f"encoder stopped: {_error(job)}")
        last = job.last
        while i < len(view):
            op = view[i]
            i += 1
            if op == OP_FRAME:
                if i + fb > len(view):
                    raise ValueError("truncated frame in batch")
                last = bytes(view[i:i + fb])
                batch.append((last, 1))
                n += 1
                i += fb
            elif op == OP_REPEAT:
                if i + 4 > len(view):
                    raise ValueError("truncated repeat in batch")
                (count,) = struct.unpack_from("<I", view, i)
                i += 4
                if last is None:
                    last = bytes(fb)           # fully transparent
                batch.append((last, count))
                n += count
            else:
                raise ValueError(f"unknown record type {op}")
        job.last = last
        job.frames += n
        if job.writer is None:
            job.writer = threading.Thread(target=_write_loop, args=(job,), daemon=True)
            job.writer.start()
        job.q.put(batch)                       # in order; blocks while 3 batches are pending
    return job.frames


def finish(job: EncodeJob, timeout: float = 600) -> dict:
    if job.writer is not None:
        job.q.put(None)
        job.writer.join(timeout)
    with job.lock:
        try:
            job.proc.stdin.close()
        except OSError:
            pass
        code = job.proc.wait(timeout=timeout)
    with _jobs_lock:
        _jobs.pop(job.id, None)
    if job.error or code != 0 or not job.path.exists():
        raise RuntimeError(job.error or f"encode failed: {_error(job)}")
    return {"path": str(job.path), "frames": job.frames,
            "seconds": round(job.frames * job.fps_den / job.fps_num, 3),
            "bytes": job.path.stat().st_size, "elapsed": round(time.time() - job.started, 2)}


def cancel(job_id: str) -> bool:
    with _jobs_lock:
        job = _jobs.pop(job_id, None)
    if job is None:
        return False
    job.error = job.error or "cancelled"
    try:
        job.proc.kill()
        job.proc.wait(timeout=10)
    except Exception:  # noqa: BLE001
        pass
    if job.writer is not None:
        try:
            job.q.put_nowait(None)             # wake the writer so it exits
        except queue.Full:
            pass
    try:
        job.path.unlink(missing_ok=True)
    except OSError:
        pass
    return True
