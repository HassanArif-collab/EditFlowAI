"""
EditFlow AI - FFmpeg Utilities
Wrappers around ffmpeg/ffprobe for video analysis and frame extraction.
"""
import asyncio
import base64
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from ..config import get_settings


# ── Async wrappers ──

async def run_ffmpeg_async(
    cmd: List[str],
    timeout: int = 600,
) -> subprocess.CompletedProcess:
    """Run an FFmpeg/FFprobe command off the event loop.

    Use this from any async handler that invokes ffmpeg/ffprobe — blocking
    subprocess.run() inside an `async def` freezes the entire uvicorn worker.
    """
    return await asyncio.to_thread(
        subprocess.run,
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


# ── Probing ──

def probe_video(video_path: str | Path) -> Dict:
    """Get comprehensive video information using ffprobe. Sync, has a timeout."""
    ffprobe = get_settings().FFPROBE_PATH
    cmd = [
        ffprobe, "-v", "quiet", "-print_format", "json",
        "-show_format", "-show_streams", str(video_path),
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            return {"error": (result.stderr or "ffprobe failed").strip()[:200]}
        return json.loads(result.stdout) if result.stdout else {}
    except (subprocess.TimeoutExpired, json.JSONDecodeError, OSError) as e:
        return {"error": str(e)}


def get_duration(video_path: str | Path) -> float:
    """Get video duration in seconds. Returns 0.0 on any failure."""
    ffprobe = get_settings().FFPROBE_PATH
    cmd = [
        ffprobe, "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(video_path),
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30, check=True)
        return float(out.stdout.strip())
    except (subprocess.SubprocessError, ValueError, OSError):
        return 0.0


def get_resolution(video_path: str | Path) -> Tuple[int, int]:
    """Get video resolution (width, height)."""
    probe = probe_video(video_path)
    for stream in probe.get("streams", []):
        if stream.get("codec_type") == "video":
            return int(stream.get("width", 0)), int(stream.get("height", 0))
    return 0, 0


def get_fps(video_path: str | Path) -> float:
    """Get video frame rate."""
    probe = probe_video(video_path)
    for stream in probe.get("streams", []):
        if stream.get("codec_type") == "video":
            r_frame_rate = stream.get("r_frame_rate", "0/1")
            try:
                num, den = r_frame_rate.split("/")
                return float(num) / float(den) if float(den) > 0 else 0.0
            except (ValueError, ZeroDivisionError):
                return 0.0
    return 0.0


def has_audio(video_path: str | Path) -> bool:
    """Check if video file has audio stream."""
    probe = probe_video(video_path)
    for stream in probe.get("streams", []):
        if stream.get("codec_type") == "audio":
            return True
    return False


def extract_frames(
    video_path: str | Path,
    duration: float,
    output_dir: Optional[str | Path] = None,
    num_frames: int = 4,
    resolution: str = "480x270",
    quality: int = 5,
) -> List[str]:
    """Extract frames from video and return base64 encoded images.

    Args:
        video_path: Path to video file
        duration: Video duration in seconds
        output_dir: Directory for temporary frames (auto-created if None)
        num_frames: Max number of frames to extract
        resolution: Frame resolution (width x height)
        quality: JPEG quality (1-31, lower is better)

    Returns:
        List of base64 encoded JPEG frame strings
    """
    ffmpeg = get_settings().FFMPEG_PATH
    video_path = Path(video_path)
    frames = []

    num_frames = min(num_frames, max(1, int(duration // 5)))
    if num_frames < 1:
        num_frames = 1

    interval = duration / (num_frames + 1)

    with tempfile.TemporaryDirectory() as tmpdir:
        for i in range(num_frames):
            timestamp = interval * (i + 1)
            frame_path = Path(tmpdir) / f"frame_{i}.jpg"
            cmd = [
                ffmpeg, "-y", "-ss", str(timestamp), "-i", str(video_path),
                "-vframes", "1", "-q:v", str(quality),
                "-s", resolution, str(frame_path),
            ]
            try:
                subprocess.run(
                    cmd, stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL, check=True, timeout=30,
                )
                if frame_path.exists():
                    with open(frame_path, "rb") as f:
                        b64 = base64.b64encode(f.read()).decode("utf-8")
                        frames.append(b64)
            except Exception:
                continue

    return frames


def extract_audio(
    video_path: str | Path,
    output_path: str | Path,
    sample_rate: int = 16000,
) -> Path:
    """Extract audio from video as WAV for Whisper.

    Args:
        video_path: Source video path
        output_path: Output WAV path
        sample_rate: Audio sample rate (16000 for Whisper)

    Returns:
        Path to the extracted audio file
    """
    ffmpeg = get_settings().FFMPEG_PATH
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    cmd = [
        ffmpeg, "-y", "-v", "quiet", "-i", str(video_path),
        "-vn", "-acodec", "pcm_s16le", "-ar", str(sample_rate),
        "-ac", "1", str(output_path),
    ]
    subprocess.run(cmd, check=True, timeout=300)
    return output_path


def get_media_info(video_path: str | Path) -> Dict:
    """Get comprehensive media info as a structured dict."""
    path = Path(video_path)
    if not path.exists():
        return {"error": f"File not found: {video_path}"}

    duration = get_duration(path)
    width, height = get_resolution(path)
    fps = get_fps(path)
    audio = has_audio(path)

    probe = probe_video(path)
    codec = ""
    for stream in probe.get("streams", []):
        if stream.get("codec_type") == "video":
            codec = stream.get("codec_name", "")
            break

    try:
        file_size = path.stat().st_size
    except OSError:
        file_size = 0

    return {
        "path": str(path),
        "filename": path.name,
        "duration": duration,
        "width": width,
        "height": height,
        "fps": fps,
        "codec": codec,
        "has_audio": audio,
        "file_size": file_size,
    }


def scan_directory(
    directory: str | Path,
    extensions: Optional[List[str]] = None,
) -> List[Path]:
    """Recursively scan directory for video files.

    On case-sensitive filesystems we also probe upper-case extensions;
    on case-insensitive ones (Windows, default macOS) one pass is enough.

    Args:
        directory: Root directory to scan
        extensions: Video file extensions to include

    Returns:
        Sorted list of unique video file paths
    """
    if extensions is None:
        extensions = [".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm", ".mpg", ".mpeg"]

    directory = Path(directory)
    if not directory.exists():
        return []

    case_sensitive = sys.platform not in ("win32", "darwin")
    seen: set = set()
    unique: List[Path] = []
    for ext in extensions:
        patterns = [f"*{ext}"]
        if case_sensitive and ext != ext.upper():
            patterns.append(f"*{ext.upper()}")
        for pat in patterns:
            for f in directory.rglob(pat):
                if f not in seen:
                    seen.add(f)
                    unique.append(f)

    return sorted(unique, key=lambda p: p.name)
