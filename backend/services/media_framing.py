"""Source-aware Premiere Motion transforms shared by script and overlay plans."""
from functools import lru_cache
import math
from pathlib import Path
from typing import Any, Dict, Optional

from ..utils.ffmpeg_utils import probe_video


@lru_cache(maxsize=512)
def _source_geometry(path: str, mtime: int, size: int) -> Dict[str, Any]:
    probe = probe_video(path)
    stream = next((s for s in probe.get("streams", []) if s.get("codec_type") == "video"), {})
    ratio = str(stream.get("sample_aspect_ratio", "1:1")).replace("/", ":").split(":")
    try:
        sar = float(ratio[0]) / float(ratio[1])
    except (ValueError, IndexError, ZeroDivisionError):
        sar = 1.0
    rotation = float(stream.get("tags", {}).get("rotate", 0) or 0)
    for side in stream.get("side_data_list", []):
        if "rotation" in side:
            rotation = float(side["rotation"])
    return {"width": int(stream.get("width", 0)), "height": int(stream.get("height", 0)),
            "pixel_aspect_ratio": sar if sar > 0 else 1.0, "rotation": rotation,
            "duration": float(probe.get("format", {}).get("duration") or stream.get("duration") or 0),
            "has_alpha": str(stream.get("pix_fmt", "")).startswith(("yuva", "gbrap", "rgba", "bgra", "argb", "abgr", "ya"))}


def source_facts(path: str) -> Dict[str, Any]:
    stat = Path(path).stat()
    return _source_geometry(str(Path(path).resolve()), stat.st_mtime_ns, stat.st_size)


def bound_visual(placement, fps: float = 30) -> None:
    """Keep a selected cutaway within the real file, even with an older index."""
    if not Path(placement.source_file).is_file():
        return
    stat = Path(placement.source_file).stat()
    placement.source_revision = f"{stat.st_size}:{stat.st_mtime_ns}"
    if placement.is_still:
        return
    duration = source_facts(placement.source_file).get("duration", 0)
    if duration > 0:
        available_frames = math.floor((duration - placement.source_in) * fps + 1e-6)
        frames = min(round(placement.duration * fps), available_frames)
        if frames <= 0:
            placement.duration = 0
        else:
            placement.duration = frames / fps
        placement.source_out = placement.source_in + placement.duration
        placement.timeline_end = placement.timeline_start + placement.duration


def calculate_framing(source_width: int, source_height: int, width: int, height: int,
                      mode: str = "fill", zoom: float = 1.0, pixel_aspect_ratio: float = 1.0,
                      rotation: float = 0, focal_point: Optional[list] = None) -> Dict[str, Any]:
    if mode not in ("fill", "contain"):
        raise ValueError("Framing mode must be fill or contain.")
    if min(source_width, source_height, width, height) <= 0 or not math.isfinite(zoom) or zoom <= 0:
        raise ValueError("Framing needs positive source/output dimensions and zoom.")
    radians = math.radians(rotation % 180)
    sw = source_width * pixel_aspect_ratio
    sh = source_height
    display_width = abs(sw * math.cos(radians)) + abs(sh * math.sin(radians))
    display_height = abs(sw * math.sin(radians)) + abs(sh * math.cos(radians))
    fit = (max if mode == "fill" else min)(width / display_width, height / display_height)
    scale = fit * zoom
    position = [0.5, 0.5]
    # Focal coordinates refer to the displayed (rotation-corrected) frame.
    if focal_point and mode == "fill":
        for index, (output, rendered) in enumerate(((width, display_width * scale), (height, display_height * scale))):
            focal = max(0.0, min(1.0, float(focal_point[index])))
            center = output / 2 + (0.5 - focal) * rendered
            center = max(output - rendered / 2, min(rendered / 2, center)) if rendered >= output else output / 2
            position[index] = center / output
    return {"fit_mode": mode, "fit_scale": round(fit * 100, 8), "zoom": zoom,
            "position": position, "source_width": source_width, "source_height": source_height,
            "pixel_aspect_ratio": pixel_aspect_ratio, "source_rotation": rotation}


def framing_for_file(path: str, width: int, height: int, mode: str = "fill", zoom: float = 1.0,
                     focal_point: Optional[list] = None) -> Dict[str, Any]:
    try:
        geometry = source_facts(path)
        if not geometry["width"] or not geometry["height"]:
            return {"fit_mode": mode, "zoom": zoom}
        return calculate_framing(geometry["width"], geometry["height"], width, height, mode, zoom,
                                 geometry["pixel_aspect_ratio"], geometry["rotation"], focal_point)
    except OSError:
        return {"fit_mode": mode, "zoom": zoom}
