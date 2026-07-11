"""Caption rendering service — word-level captions → ProRes 4444 video with alpha.

Architecture:
    1. Render each frame to PNG using Pillow (text + animation per word)
    2. Encode PNG sequence → ProRes 4444 with alpha via ffmpeg
    3. Return the .mov file path for import into Premiere Pro

This is the "ProRes technique" from the research doc:
    - Single video overlay (not 100+ clips)
    - Any animation (rendered in Python, not limited by MOGRT/API)
    - Smooth playback (streamed video, not RAM-loaded clips)
    - Low memory (1 file, not 1000 PNGs on the timeline)

The editor state (words + style + preset) is pure data — the same JSON
can re-render with different settings without re-transcribing.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image, ImageDraw, ImageFont

logger = logging.getLogger(__name__)

# ── Easing functions (ported from Better-Captions-Premiere) ──

def ease_out_back(t: float) -> float:
    """Overshoot easing — gives the 'pop' feel."""
    c1 = 1.70158
    c3 = c1 + 1
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2

def ease_out_cubic(t: float) -> float:
    return 1 - (1 - t) ** 3

def ease_linear(t: float) -> float:
    return t


# ── Data classes ──

@dataclass
class CaptionWord:
    word: str
    start: float  # seconds
    end: float    # seconds

@dataclass
class CaptionStyle:
    font_family: str = "Arial"
    font_size: int = 80
    fill_color: Tuple[int, int, int, int] = (255, 255, 255, 255)  # RGBA
    stroke_color: Tuple[int, int, int, int] = (0, 0, 0, 200)
    stroke_width: int = 4
    position_y: float = 0.85  # 0-1, fraction of frame height
    position_x: float = 0.5   # 0-1, fraction of frame width
    preset: str = "pop"       # "fade" | "pop" | "bounce"

@dataclass
class RenderConfig:
    width: int = 1920
    height: int = 1080
    fps: float = 30.0
    duration: float = 0.0  # seconds; 0 = auto from words


# ── Font resolution ──

# Common font paths on Windows + Linux + macOS
_FONT_PATHS = {
    "Arial": [
        "C:\\Windows\\Fonts\\arialbd.ttf",      # Windows Bold
        "C:\\Windows\\Fonts\\arial.ttf",          # Windows Regular
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ],
    "Arial Black": [
        "C:\\Windows\\Fonts\\ariblk.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ],
    "Impact": [
        "C:\\Windows\\Fonts\\impact.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ],
    "Helvetica": [
        "/System/Library/Fonts/Helvetica.ttc",
        "C:\\Windows\\Fonts\\arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ],
    "Montserrat": [
        "C:\\Windows\\Fonts\\Montserrat-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ],
}

def _resolve_font(font_family: str, font_size: int) -> ImageFont.FreeTypeFont:
    """Resolve a font family name to a loadable font, with fallbacks."""
    paths = _FONT_PATHS.get(font_family, [])
    # Also try the name directly (in case it's a full path)
    paths.append(font_family)
    # Add a generic fallback
    paths.append("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")

    for path in paths:
        try:
            if os.path.exists(path):
                return ImageFont.truetype(path, font_size)
        except Exception:
            continue

    # Last resort: default font
    logger.warning("Could not load font '%s', using default", font_family)
    return ImageFont.load_default()


# ── Frame rendering ──

def _hex_to_rgba(hex_color: str, alpha: int = 255) -> Tuple[int, int, int, int]:
    """Convert '#RRGGBB' or '#RGB' to (R, G, B, A) tuple."""
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = h[0] * 2 + h[1] * 2 + h[2] * 2
    if len(h) == 6:
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        return (r, g, b, alpha)
    return (255, 255, 255, alpha)


def _get_active_word(words: List[CaptionWord], t: float) -> Optional[Tuple[CaptionWord, float]]:
    """Get the word active at time t, plus progress (0-1) into that word's animation."""
    for w in words:
        if w.start <= t < w.end:
            # Progress into the word's lifetime
            word_dur = w.end - w.start
            if word_dur <= 0:
                word_dur = 0.1
            progress = (t - w.start) / word_dur
            return (w, min(1.0, progress))
    # Check if we're in a gap between words — show the previous word fading out
    for i, w in enumerate(words):
        if i < len(words) - 1 and t >= w.end and t < words[i + 1].start:
            # In a gap — show nothing (or could show previous word fading)
            return None
    return None


def _compute_anim_state(preset: str, progress: float) -> Dict[str, Any]:
    """Compute the animation state (scale, opacity) for a word at given progress.

    progress is 0-1 into the word's lifetime.
    Returns {scale: 0-1+, opacity: 0-1, offset_y: pixels}
    """
    # Intro animation happens in the first 20% of the word's lifetime
    intro_dur = 0.2
    if progress < intro_dur:
        # In intro phase
        intro_progress = progress / intro_dur  # 0-1

        if preset == "fade":
            scale = 1.0
            opacity = ease_out_cubic(intro_progress)
        elif preset == "pop":
            # Scale 0 → 110 (overshoot) → 100
            eased = ease_out_back(intro_progress)
            scale = min(1.1, eased * 1.1)  # cap at 110%
            opacity = min(1.0, intro_progress * 2)  # opacity snaps in fast
        elif preset == "bounce":
            # Scale 0 → 125 → 90 → 100
            if intro_progress < 0.4:
                scale = (intro_progress / 0.4) * 1.25
            elif intro_progress < 0.7:
                scale = 1.25 - ((intro_progress - 0.4) / 0.3) * 0.35  # 125 → 90
            else:
                scale = 0.9 + ((intro_progress - 0.7) / 0.3) * 0.1  # 90 → 100
            opacity = min(1.0, intro_progress * 3)
        else:
            scale = 1.0
            opacity = 1.0
    else:
        # Sustain phase — full scale + opacity
        scale = 1.0
        opacity = 1.0

    return {"scale": scale, "opacity": opacity}


def render_frame(
    words: List[CaptionWord],
    style: CaptionStyle,
    config: RenderConfig,
    t: float,
    font: ImageFont.FreeTypeFont,
) -> Image.Image:
    """Render a single frame at time t (seconds).

    Returns an RGBA PIL Image of size config.width × config.height.
    """
    # Create transparent background
    img = Image.new("RGBA", (config.width, config.height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    active = _get_active_word(words, t)
    if not active:
        return img  # transparent frame (no caption)

    word, progress = active
    anim = _compute_anim_state(style.preset, progress)

    if anim["opacity"] <= 0.01:
        return img  # fully transparent

    # Prepare the text color with opacity
    fill = style.fill_color[:3] + (int(style.fill_color[3] * anim["opacity"]),)
    stroke = style.stroke_color[:3] + (int(style.stroke_color[3] * anim["opacity"]),)

    # Calculate text position
    text = word.word.upper()  # Hormozi-style: uppercase
    center_x = int(config.width * style.position_x)
    center_y = int(config.height * style.position_y)

    # Measure text
    try:
        bbox = draw.textbbox((0, 0), text, font=font, stroke_width=style.stroke_width)
        text_w = bbox[2] - bbox[0]
        text_h = bbox[3] - bbox[1]
    except Exception:
        text_w, text_h = font.getsize(text)

    # Apply scale
    scale = anim["scale"]
    scaled_w = int(text_w * scale)
    scaled_h = int(text_h * scale)

    # Draw at scaled size (we render at full size then resize for quality)
    # Create a separate image for the text, then paste with scale
    if scale != 1.0 and abs(scale - 1.0) > 0.01:
        # Render text at 2x for downscale quality
        render_size = 2
        render_font = _resolve_font(style.font_family, int(style.font_size * render_size))
        temp_img = Image.new("RGBA", (config.width * render_size, config.height * render_size), (0, 0, 0, 0))
        temp_draw = ImageDraw.Draw(temp_img)
        temp_bbox = temp_draw.textbbox((0, 0), text, font=render_font, stroke_width=style.stroke_width * render_size)
        temp_w = temp_bbox[2] - temp_bbox[0]
        temp_h = temp_bbox[3] - temp_bbox[1]

        # Draw text centered on temp image
        temp_x = (config.width * render_size - temp_w) // 2 - temp_bbox[0]
        temp_y = (config.height * render_size - temp_h) // 2 - temp_bbox[1] - int((config.height * render_size) * (1 - style.position_y) * -1)

        # Adjust for position
        temp_x = int(config.width * render_size * style.position_x) - temp_w // 2 - temp_bbox[0]
        temp_y = int(config.height * render_size * style.position_y) - temp_h // 2 - temp_bbox[1]

        temp_draw.text(
            (temp_x, temp_y), text, font=render_font, fill=fill,
            stroke_width=style.stroke_width * render_size, stroke_fill=stroke,
        )

        # Resize temp image to final size with scale applied
        final_size = (int(config.width * scale), int(config.height * scale))
        scaled_img = temp_img.resize(final_size, Image.LANCZOS)

        # Paste centered on the main image
        paste_x = center_x - final_size[0] // 2
        paste_y = center_y - final_size[1] // 2
        img.paste(scaled_img, (paste_x, paste_y), scaled_img)
    else:
        # No scaling — draw directly
        x = center_x - text_w // 2
        y = center_y - text_h // 2
        draw.text(
            (x, y), text, font=font, fill=fill,
            stroke_width=style.stroke_width, stroke_fill=stroke,
        )

    return img


# ── Full video rendering ──

async def render_caption_video(
    words: List[Dict[str, Any]],
    style_config: Dict[str, Any],
    render_config: Dict[str, Any],
    output_path: Path,
    progress_callback=None,
) -> Path:
    """Render animated captions to a ProRes 4444 video with alpha.

    Args:
        words: [{word: str, start: float, end: float}, ...]
        style_config: {font_family, font_size, fill_color, stroke_color, ...}
        render_config: {width, height, fps, duration}
        output_path: where to save the .mov file
        progress_callback: async callback(progress: float, message: str)

    Returns:
        Path to the rendered .mov file
    """
    # Parse inputs
    caption_words = [
        CaptionWord(
            word=str(w.get("word", w.get("text", ""))),
            start=float(w["start"]),
            end=float(w["end"]),
        )
        for w in words
        if w.get("word") or w.get("text")
    ]
    if not caption_words:
        raise ValueError("No words to render")

    style = CaptionStyle(
        font_family=style_config.get("font_family", "Arial"),
        font_size=style_config.get("font_size", 80),
        fill_color=_hex_to_rgba(style_config.get("fill_color", "#ffffff"), 255),
        stroke_color=_hex_to_rgba(style_config.get("stroke_color", "#000000"), 200),
        stroke_width=style_config.get("stroke_width", 4),
        position_y=style_config.get("position_y", 0.85),
        position_x=style_config.get("position_x", 0.5),
        preset=style_config.get("preset", "pop"),
    )

    config = RenderConfig(
        width=render_config.get("width", 1920),
        height=render_config.get("height", 1080),
        fps=render_config.get("fps", 30.0),
        duration=render_config.get("duration", 0.0),
    )

    # Auto-calculate duration from words if not specified
    if config.duration <= 0:
        config.duration = caption_words[-1].end + 0.5  # 0.5s padding

    # Total frames
    total_frames = int(config.duration * config.fps)
    if total_frames <= 0:
        raise ValueError(f"Invalid total_frames: {total_frames}")

    logger.info(
        f"Rendering {total_frames} frames ({config.duration:.1f}s @ {config.fps}fps) "
        f"to {output_path}"
    )

    # Create temp directory for PNG frames
    temp_dir = Path(tempfile.mkdtemp(prefix="editflow_caption_"))
    frames_pattern = temp_dir / "frame_%06d.png"

    try:
        # Load font once
        font = _resolve_font(style.font_family, style.font_size)

        # Render frames (in thread pool to avoid blocking event loop)
        def _render_all_frames():
            for i in range(total_frames):
                t = i / config.fps
                frame = render_frame(caption_words, style, config, t, font)
                frame.save(temp_dir / f"frame_{i:06d}.png")

        await asyncio.to_thread(_render_all_frames)

        if progress_callback:
            await progress_callback(0.7, "Encoding ProRes 4444 video...")

        # Encode with ffmpeg: PNG sequence → ProRes 4444 with alpha
        cmd = [
            "ffmpeg", "-y",
            "-framerate", str(config.fps),
            "-i", str(frames_pattern),
            "-c:v", "prores_ks",
            "-profile:v", "4",           # 4 = ProRes 4444
            "-pix_fmt", "yuva444p10le",  # 4:4:4 + alpha, 10-bit
            "-alpha_bits", "16",         # 16-bit alpha for smooth edges
            "-q:v", "5",                 # quality (1-5, lower = better)
            "-r", str(config.fps),
            str(output_path),
        ]

        logger.info(f"Running ffmpeg: {' '.join(cmd)}")
        result = await asyncio.to_thread(
            subprocess.run, cmd, capture_output=True, text=True, timeout=300
        )

        if result.returncode != 0:
            logger.error(f"ffmpeg failed: {result.stderr[-500:]}")
            raise RuntimeError(f"ffmpeg encoding failed: {result.stderr[-200:]}")

        if not output_path.exists():
            raise RuntimeError("ffmpeg did not produce output file")

        file_size = output_path.stat().st_size
        logger.info(f"Rendered {output_path} ({file_size / 1024 / 1024:.1f} MB)")

        if progress_callback:
            await progress_callback(1.0, f"Done ({file_size / 1024 / 1024:.1f} MB)")

        return output_path

    finally:
        # Clean up temp PNGs
        try:
            shutil.rmtree(temp_dir)
        except Exception:
            pass


def compute_render_fingerprint(
    words: List[Dict[str, Any]],
    style_config: Dict[str, Any],
    render_config: Dict[str, Any],
) -> str:
    """Compute a content-addressed fingerprint for caching.

    Same words + style + render config → same fingerprint → same video.
    """
    data = {
        "words": words,
        "style": style_config,
        "render": render_config,
    }
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()[:16]
