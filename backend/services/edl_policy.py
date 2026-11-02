"""Editorial rules applied once to a native batch, including older agent helpers."""
import copy
import hashlib
import json
import math
from functools import lru_cache
from pathlib import Path

from PIL import Image
from ..config import get_settings
from ..utils.subprocess_utils import run_silent
from .media_framing import source_facts, framing_for_file


@lru_cache(maxsize=128)
def _alpha_bounds(path: str, size: int, mtime: int, width: int, height: int):
    key = hashlib.sha256(f"{path}:{size}:{mtime}:v2".encode()).hexdigest()
    cache = get_settings().DATA_DIR / "cache/graphics_bounds" / f"{key}.json"
    if cache.is_file():
        return json.loads(cache.read_text())
    sw, sh = 270, max(1, round(270 * height / width))
    result = run_silent([get_settings().FFMPEG_PATH, "-v", "error", "-threads", "2", "-i", path,
        "-an", "-filter_threads", "1", "-vf", f"alphaextract,scale={sw}:{sh}:flags=area:in_range=full:out_range=full,format=gray",
        "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], capture_output=True, timeout=90)
    if result.returncode:
        raise ValueError(f"Cannot validate graphic alpha: {Path(path).name}")
    frame_bytes = sw * sh
    bounds = None
    for offset in range(0, len(result.stdout) - frame_bytes + 1, frame_bytes):
        # ProRes introduces alpha=1 in transparent pixels. Exclude only this
        # sub-1% quantization noise so it cannot shrink every card to a thumbnail.
        box = Image.frombytes("L", (sw, sh), result.stdout[offset:offset+frame_bytes]).point(lambda a:255 if a>2 else 0).getbbox()
        if box:
            bounds = box if bounds is None else (min(bounds[0],box[0]),min(bounds[1],box[1]),max(bounds[2],box[2]),max(bounds[3],box[3]))
    if not bounds:
        raise ValueError(f"Graphic is completely transparent: {Path(path).name}")
    # Include a conservative pixel margin around the downsampled alpha union.
    bounds = [max(0,bounds[0]-1)*width/sw, max(0,bounds[1]-1)*height/sh,
              min(sw,bounds[2]+1)*width/sw, min(sh,bounds[3]+1)*height/sh]
    cache.parent.mkdir(parents=True,exist_ok=True)
    cache.write_text(json.dumps(bounds))
    return bounds


def graphic_transform(bounds, source_width, source_height, width, height):
    x0,y0,x1,y1 = bounds
    if x1 <= x0 or y1 <= y0:
        raise ValueError("Graphic bounds are empty.")
    top,bottom = height*1350/1920, height*1720/1920
    margin = width*40/1080
    scale = min(1.0, (width-2*margin)/(x1-x0), (bottom-top)/(y1-y0))
    cx,cy = (x0+x1)/2, (y0+y1)/2
    return {"fit_scale":scale*100,"zoom":1,"fit_mode":"contain",
            "position":[(width/2-(cx-source_width/2)*scale)/width,
                        ((top+bottom)/2-(cy-source_height/2)*scale)/height],
            "graphic_overlay":True,"safe_zone":[top,bottom]}


def prepare_batch(payload: dict) -> dict:
    output = copy.deepcopy(payload)
    operations = output.get("ops", output.get("operations", []))
    width,height = 1080,1920
    for op in operations:
        for old,new in (("path","mediaPath"),("time","startTime"),("in_point","inPoint"),("out_point","outPoint"),("bin_path","bin_name")):
            if old in op and new not in op:
                op[new] = op[old]
        if op.get("action") == "create_sequence":
            width,height = int(op.get("width") or width),int(op.get("height") or height)
        if op.get("action") != "add":
            continue
        path = op.get("mediaPath") or op.get("path")
        if not path or not Path(path).is_file():
            continue  # Native importer reports missing media without touching existing edits.
        facts = source_facts(path)
        raw_track = op.get("video_track_index",0)
        video_track = -1 if raw_track == "auto" else int(raw_track)
        if raw_track == "auto":
            op.update(video_track_index=-1,auto_detect_track=True)
        audio_only = video_track < 0 and not op.get("auto_detect_track")
        if audio_only:
            if op.get("kind") == "generated_narration" or Path(path).stem.lower().startswith(("vo_", "voiceover")):
                op["audio_track_index"] = 1
            if Path(path).suffix.lower() in (".wav", ".mp3", ".m4a", ".aac", ".flac") and "audio_track_index" not in op:
                op["audio_track_index"] = 1
            continue
        if video_track == 0 and facts.get("width") and not facts.get("has_alpha") and Path(path).suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
            op.update(audio_track_index=0,preserve_linked_audio=True,audio_lead_frames=0)
        if (facts.get("has_alpha") and (video_track > 0 or op.get("auto_detect_track"))) or op.get("graphic_overlay"):
            if not facts.get("has_alpha"):
                raise ValueError(f"A card overlay needs a transparent source: {Path(path).name}")
            if facts.get("duration",0) > 120:
                raise ValueError("Split graphics longer than 120 seconds before safe-zone validation.")
            stat = Path(path).stat()
            bounds = _alpha_bounds(str(Path(path).resolve()),stat.st_size,stat.st_mtime_ns,facts["width"],facts["height"])
            op.update(graphic_transform(bounds,facts["width"],facts["height"],width,height))
            op["audio_track_index"] = -1
        elif not op.get("fit_scale"):
            # Older helpers used scale=108 as a punch, incorrectly cropping 4K media.
            zoom = float(op.get("zoom") or op.get("scale_punch_in") or float(op.get("scale") or 100)/100)
            if not math.isfinite(zoom) or zoom <= 0:
                raise ValueError("Invalid relative zoom.")
            op.update(framing_for_file(path,width,height,op.get("fit_mode") or "fill",zoom))
    return output
