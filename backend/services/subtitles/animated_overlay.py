"""Animated caption overlay — cues[] → ASS → transparent ProRes .mov.

Recreates the After Effects "fade up words" look (his build: fadeup_words,
expo-out, ~0.28s rise over ~28px at 1080p) inside Premiere, which has no
per-word text animation API. Each WORD becomes one ASS event with its own
\\move (rise) + \\fad (fade-in), positioned by measured pixels so the cue
stays centered like the AE caption box.

Pipeline: build_ass() [pure, tested — also useful as an .ass sidecar] and
build_drawtext() [pure, tested — the RENDER path]. Rendering uses a
drawtext chain (one filter per word, per-frame rise+fade expressions)
because drawtext preserves the transparent canvas alpha while the ass
filter flattens it (verified: alphaextract all-white with ass, correct
with drawtext). Final encode is prores_ks 4444 + yuva444p10le.
The .mov drops onto V2 via the existing importFiles + insertClip ops —
no new ExtendScript needed.
"""
from __future__ import annotations

import asyncio
import logging
import subprocess
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class OverlayStyle:
    width: int = 1080
    height: int = 1920
    fps: int = 30
    font_name: str = "Arial"
    font_file: str = r"C:\Windows\Fonts\arialbd.ttf"  # resolved by family/bold
    font_family: str = "Arial"
    font_bold: bool = True
    text_color: str = "#ffffff"
    stroke_color: str = "#000000"
    stroke_width: int = 0             # 0 = off (AE parity)
    shadow_enabled: bool = True
    shadow_color: str = "#000000"
    shadow_opacity: float = 0.6
    shadow_distance: int = 4
    shadow_blur: int = 5             # accepted; no drawtext equivalent (noted)
    font_size: int = 96
    pos_y_ratio: float = 0.78      # cue block center, fraction of height
    pos_x_ratio: float = 0.5       # block anchor, fraction of width (AE posX)
    box_width_ratio: float = 0.9   # caption box width, fraction of width
    rise_px: int = 60              # fade-up travel at 1080p (scales with width)
    rise_ms: int = 280             # entrance duration (his AE: 0.28s expo)
    fade_in_ms: int = 200
    motion: str = "rise"           # entrance shape (see ANIM_MOTION)
    caption_level: bool = False    # whole chunk animates from chunk start
    easing: str = "expo_out"       # expo_out | back_out | ease_out | ease_in_out | ease_in | linear
    intensity: float = 1.0         # bounce amplitude multiplier (AE animIntensity)
    slide_px: int = 60             # rise travel at 1080p (AE slideDist)
    pill_color: str = "#0a1a2e"    # merged pill background (AE default)
    pill_opacity: float = 0.85
    pill_outline: bool = True      # light-blue rim (AE pillStroke)
    pill_stroke_color: str = "#5c8cf0"
    pill_stroke_width: int = 2      # 0 = off
    pill_radius: float = 0.5        # 0 = square .. 1 = stadium
    pill_pad_x_em: float = 0.28    # AE LAYOUT.pillPadXEm
    pill_pad_y_em: float = 0.16    # AE LAYOUT.pillPadYEm
    outline: int = 3
    shadow: int = 2
    all_caps: bool = False


# Animate-preset → overlay motion (AE caption-model.js wordAnim parity).
# Per-word presets time from each word's start; caption-level ones (fade,
# fadeup) time from the chunk start. squash has no drawtext equivalent —
# pop's overshoot reads the same on screen.
ANIM_MOTION = {
    "fadeup_words": {"motion": "rise", "caption_level": False},
    "popin": {"motion": "back", "caption_level": False, "rise_ms": 180},
    "fadeup": {"motion": "rise", "caption_level": True},
    "bounce": {"motion": "bounce", "caption_level": False},
    "squash": {"motion": "back", "caption_level": False, "rise_ms": 180},
    "typewriter": {"motion": "cut", "caption_level": False},
    "fade": {"motion": "fade", "caption_level": True},
}


def _ease_expr(easing: str, p: str) -> str:
    """Remaining-travel fraction (1 at p=0 → 0 at p=1) for unquoted y expr."""
    if easing == "linear":
        return f"(1-{p})"
    if easing == "ease_in":
        return f"pow(1-{p},3)"
    if easing == "ease_out":
        return f"(1-pow(1-{p},3))"
    if easing == "ease_in_out":
        return (f"if(lt({p},0.5),1-4*pow({p},3),pow(-2*{p}+2,3)/2)")
    if easing == "back_out":
        # 1 - back_out(p); overshoots above rest mid-flight (pop feel)
        return (f"(-(2.70158*pow({p}-1,3)+1.70158*pow({p}-1,2)))")
    # expo_out (AE default): snappy rise, long soft settle
    return f"pow(2,-10*{p})"


# Preset id (Style tab) → overlay motion. "pop" has no scale in a
# drawtext world — a faster rise reads the same on screen.
PRESET_MOTION = {
    "none": {"motion": "cut"},
    "fade": {"motion": "rise", "rise_px": 1, "fade_in_ms": 250},
    "word_fade": {"motion": "rise", "rise_px": 1, "fade_in_ms": 250},
    "slide_up": {"motion": "rise"},
    "pop": {"motion": "rise", "rise_ms": 180},
    "word_pop": {"motion": "rise", "rise_ms": 180},
    "bounce": {"motion": "bounce"},
}


def _measure(font_file: str, size: int, text: str) -> float:
    from PIL import ImageFont
    font = ImageFont.truetype(font_file, size)
    box = font.getbbox(text)
    return float(box[2] - box[0])


def _ass_ts(seconds: float) -> str:
    if seconds < 0:
        seconds = 0.0
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _assign_lines(cue: dict) -> list[list[dict]]:
    """Split a cue's words across its wrapped lines (cue['text'] \\n-split).

    Words are consumed in order; a line ends when the joined words equal the
    line text (whitespace-normalized). Falls back to a single line so no
    word is ever dropped.
    """
    words = cue.get("words") or []
    lines = [ln for ln in (cue.get("text") or "").split("\n")]
    if len(lines) <= 1 or not words:
        return [list(words)] if words else []
    norm = lambda s: " ".join(str(s).split())
    out: list[list[dict]] = []
    idx = 0
    for ln in lines:
        target = norm(ln)
        cur: list[dict] = []
        acc = ""
        while idx < len(words):
            w = words[idx]
            trial = (acc + " " + str(w.get("text") or "")).strip()
            cur.append(w)
            idx += 1
            acc = trial
            if norm(acc) == target:
                break
        if cur:
            out.append(cur)
    if idx < len(words):  # leftover words (rounding quirks) join the last line
        (out[-1] if out else out.append([]) or out[-1]).extend(words[idx:])
    return [l for l in out if l]


def build_ass(cues: list[dict], style: OverlayStyle) -> str:
    """Render cues as an ASS subtitle script with per-word rise+fade."""
    scale = style.width / 1080.0
    rise = max(1, round(style.rise_px * scale))
    line_h = round(style.font_size * scale * 1.25)
    base_y = round(style.height * style.pos_y_ratio)
    size = max(8, round(style.font_size * scale))
    face = _resolve_font_file(style.font_family, style.font_bold)

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {style.width}\n"
        f"PlayResY: {style.height}\n"
        "WrapStyle: 0\n"
        "ScaledBorderAndShadow: yes\n"
        "\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Cap,Arial,{size},&H00FFFFFF,&H000019FF,&H80000000,&H80000000,"
        f"-1,0,0,0,100,100,0,0,1,{style.outline},{style.shadow},5,40,40,40,1\n"
        "\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, "
        "Effect, Text\n"
    )
    space_w = _measure(face, size, " ")
    events: list[str] = []
    for cue in cues or []:
        words = cue.get("words") or []
        if not words:
            continue
        cue_end = max(float(w.get("end", 0) or 0) for w in words)
        line_lists = _assign_lines(cue)
        n_lines = max(1, len(line_lists))
        top_y = base_y - ((n_lines - 1) * line_h) // 2
        for li, line_words in enumerate(line_lists):
            texts = [str(w.get("text") or "") for w in line_words]
            if style.all_caps:
                texts = [t.upper() for t in texts]
            widths = [_measure(face, size, t) for t in texts]
            total = sum(widths) + space_w * max(0, len(texts) - 1)
            y = top_y + li * line_h
            x = (style.width - total) / 2.0
            for t, wpx, w in zip(texts, widths, line_words):
                cx = x + wpx / 2.0
                x += wpx + space_w
                ws = max(0.0, float(w.get("start", 0) or 0))
                rise_dur = min(style.rise_ms / 1000.0, max(0.05, cue_end - ws))
                t1 = round(rise_dur * 1000)
                tag = ("{\\an5\\move(%d,%d,%d,%d,0,%d)\\fad(%d,0)}" % (
                    round(cx), round(y + rise), round(cx), round(y),
                    t1, min(style.fade_in_ms, t1)))
                safe = t.replace("{", "(").replace("}", ")")
                events.append(
                    f"Dialogue: 0,{_ass_ts(ws)},{_ass_ts(cue_end)},Cap,,0,0,0,,{tag}{safe}"
                )
    return header + "".join(e + "\n" for e in events)


def _resolve_font_file(family: str, bold: bool) -> str:
    """Map a font family + weight to a real TTF for measurement/rendering.

    Only Arial faces are guaranteed on Windows; everything else falls
    back to Arial (same metrics family). Measurement MUST use the face
    that renders, or word positions drift.
    """
    fam = (family or "").lower()
    if bold or "black" in fam or "bold" in fam:
        return r"C:\Windows\Fonts\arialbd.ttf"
    return r"C:\Windows\Fonts\arial.ttf"


def _hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = (h or "").strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    try:
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except (ValueError, IndexError):
        return (10, 26, 46)  # AE pill default


def _render_pill_png(path: Path, w: int, h: int, fill: tuple[int, int, int],
                     alpha: int, outline_rgb: tuple[int, int, int] | None,
                     outline_w: int, radius_ratio: float = 0.5) -> None:
    """Paint a rounded pill with alpha + optional rim."""
    from PIL import Image, ImageDraw
    w, h = max(1, w), max(1, h)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius_ratio = max(0.0, min(float(radius_ratio), 1.0))
    d.rounded_rectangle([0, 0, w - 1, h - 1],
                        radius=max(0, int(min(w, h) * 0.5 * radius_ratio)),
                        fill=(*fill, alpha),
                        outline=(*outline_rgb, 255) if outline_rgb and outline_w > 0 else None,
                        width=max(1, outline_w))
    img.save(path)


def _dt_esc(text: str) -> str:
    """Escape literal text for a SINGLE-QUOTED drawtext value.

    Quotes protect option separators (`,`, `:`) but NOT `;` (proven live:
    "No such filter" split the graph on a semicolon inside a word). So
    backslash, quote, and semicolon are escaped; everything else is raw.
    """
    return text.replace("\\", "\\\\").replace("'", "\\'").replace(";", "\\;")


def _e(expr: str) -> str:
    """Escape an ffmpeg expression for embedding in a filtergraph.

    Commas separate filters, so every comma INSIDE an expression
    (min/max/if/between/pow args) must be backslash-escaped, or the
    graph splits mid-expression ("No option name near ..." errors).
    """
    return expr.replace(",", "\\,")


def build_drawtext(cues: list[dict], style: OverlayStyle,
                   filter_font: str | None = None,
                   words_dir: Path | None = None
                   ) -> tuple[str, list[dict]]:
    """Render cues as a drawtext filter chain (one filter per word).

    Each word gets per-frame expressions: expo-out rise (his AE easing)
    plus fade-in, active only between word-start and cue-end (words hold
    visible like the AE caption box). Positions are PIL-measured pixels so
    cues stay centered; drawtext draws only glyphs, so canvas alpha survives.

    ``filter_font`` is the font path as seen by the filtergraph (a staged
    relative copy); ``style.font_file`` is still used for measurement.

    ``words_dir``: when given, each word is written to wNNNN.txt and passed
    via textfile= instead of inline text=. Inline quoting cannot survive
    apostrophes (proven live: "Chicago's" broke the graph — \\' inside
    '...' does not escape in this ffmpeg's parser), so production renders
    always use textfile; inline stays for tests.

    Returns (filtergraph, pills): pills are merged background boxes for
    consecutive pill-flagged words (AE behavior), each with its PNG path
    (rendered only when words_dir is given), box, and window. When pills
    exist the graph is label-chained (movie + overlay before the text);
    otherwise it stays a plain linear chain.
    """
    scale = style.width / 1080.0
    rise = max(0, round(style.slide_px * scale))
    line_h = round(style.font_size * scale * 1.25)
    base_y = round(style.height * style.pos_y_ratio)
    size = max(8, round(style.font_size * scale))
    dur = max(0.05, style.rise_ms / 1000.0)
    fade = max(0.05, style.fade_in_ms / 1000.0)
    motion = style.motion if style.motion in (
        "rise", "back", "bounce", "cut", "fade", "fadeup") else "rise"
    caption_level = bool(getattr(style, "caption_level", False))
    easing = style.easing if style.easing in (
        "expo_out", "back_out", "ease_out", "ease_in_out",
        "ease_in", "linear") else "expo_out"
    intensity = max(0.1, min(float(style.intensity or 1.0), 3.0))
    face = _resolve_font_file(style.font_family, style.font_bold)
    fontfile = (filter_font or face).replace("\\", "/").replace(":", "\\:")
    space_w = _measure(face, size, " ")
    # Caption-box layout (AE parity: fixed size + placement + box width).
    # - ONE font size for every word, always. Shrinking long lines made
    #   sizes inconsistent across cues (seen live) — AE keeps size constant
    #   and shows fewer words instead.
    # - Every wrapped line becomes its own timed unit, laid out inside the
    #   box [margin, width-margin] anchored at pos_x/pos_y. A line wider
    #   than the box splits into sequential word-chunks (timing preserved,
    #   nothing ever bleeds off frame).
    margin = max(0.0, style.width * (1.0 - style.box_width_ratio) / 2.0)
    max_w = max(1.0, style.width - 2.0 * margin)
    units: list[dict] = []
    for cue in (cues or []):
        for ln in _assign_lines(cue):
            if ln:
                units.append(ln)
    # Greedy chunk-split: walk each line, cutting chunks that fit the box.
    chunks: list[list[dict]] = []
    for ln in units:
        texts = [str(w.get("text") or "") for w in ln]
        if style.all_caps:
            texts = [t.upper() for t in texts]
        widths = [_measure(face, size, t) for t in texts]
        cur: list[dict] = []
        cur_w = 0.0
        for w, wpx in zip(ln, widths):
            add = wpx if not cur else space_w + wpx
            if cur and cur_w + add > max_w:
                chunks.append(cur)
                cur, cur_w = [], 0.0
                add = wpx
            cur.append(w)
            cur_w += add
        if cur:
            chunks.append(cur)
    starts = [min(float(w.get("start", 0) or 0) for w in c) for c in chunks]
    ends = [max(float(w.get("end", 0) or 0) for w in c) for c in chunks]
    order = sorted(range(len(chunks)), key=lambda i: starts[i])
    holds: dict[int, float] = {}
    for k, i in enumerate(order):
        if k + 1 < len(order) and starts[order[k + 1]] > ends[i]:
            holds[i] = starts[order[k + 1]]
        else:
            holds[i] = ends[i] + (0.5 if k + 1 >= len(order) else 0.0)
    dparts: list[str] = []   # bare drawtext bodies (labels added at assembly)
    geo: list[dict] = []     # per-word geometry for pill merging
    wnum = 0
    if words_dir is not None:
        words_dir = Path(words_dir)
        words_dir.mkdir(parents=True, exist_ok=True)
        # Emit word files as CWD-relative (no drive colon) + quoted (spaces
        # safe — proven; absolute + quoted still splits on the colon).
        try:
            emit_base = words_dir.resolve().relative_to(Path.cwd().resolve())
        except (OSError, ValueError):
            emit_base = words_dir
    for ci, line_words in enumerate(chunks):
        texts = [str(w.get("text") or "") for w in line_words]
        if style.all_caps:
            texts = [t.upper() for t in texts]
        widths = [_measure(face, size, t) for t in texts]
        total = sum(widths) + space_w * max(0, len(texts) - 1)
        y0 = base_y
        chunk_start = min(float(w.get("start", 0) or 0) for w in line_words)
        # Anchor the block at pos_x inside the margins; clamp so it never
        # leaves the box even with rounding.
        cx_block = style.width * style.pos_x_ratio
        x0 = cx_block - total / 2.0
        x0 = min(max(x0, margin), max(margin, style.width - margin - total))
        x = x0
        hold = holds[ci]
        for t, wpx, w in zip(texts, widths, line_words):
            if not t:
                x += space_w
                continue
            t0 = max(0.0, float(w.get("start", 0) or 0))
            cx = x + wpx / 2.0
            x += wpx + space_w
            dt = f"(t-{t0:.3f})"
            # Entrance motion. y is UNQUOTED so its commas are escaped
            # (_e); alpha/enable are single-quoted so their commas stay
            # raw (quotes protect them; backslashes would leak into eval).
            # caption_level (AE fade/fadeup): the whole chunk animates from
            # the chunk start instead of per-word starts.
            anchor = chunk_start if caption_level else t0
            adt = f"(t-{anchor:.3f})"
            if motion == "bounce":
                # Damped sine around the rest position (AE bounce feel,
                # amplitude scaled by intensity). Built raw, escaped ONCE —
                # escaping twice would emit literal backslashes into eval.
                amp = f"{rise}*({intensity:.2f})"
                y_raw = (f"{y0}-{amp}*abs(sin(14*{dt}))"
                         f"*pow(2.71828,-3.5*{dt})")
                y = _e(f"if(lt({dt},1.2),{y_raw},{y0})")
            elif motion in ("rise", "back", "fadeup"):
                # Traveling rise with the selected easing (AE wordEasing);
                # fadeup == rise timed at chunk level.
                p_raw = f"min(max({adt}/{dur:.3f},0),1)"
                y = _e(f"{y0}+{rise}*{_ease_expr(easing, p_raw)}")
            elif motion == "fade":
                y = f"{y0}"
            else:  # "cut": instant on, no travel
                y = f"{y0}"
            a = (f"if(lt(t,{anchor:.3f}),0,"
                 f"min(max((t-{anchor:.3f})/{fade:.3f},0),1))")
            en = f"between(t,{t0:.3f},{hold:.3f})"
            if words_dir is not None:
                wpath = words_dir / f"w{wnum:04d}.txt"
                wnum += 1
                wpath.write_text(t, encoding="utf-8")
                textopt = f"textfile='{(emit_base / wpath.name).as_posix()}'"
            else:
                textopt = f"text='{_dt_esc(t)}'"
            # Style colors (AE parity): 0xRRGGBB ffmpeg hex; shadow alpha
            # appended (@opacity). stroke_width 0 disables the border.
            tc = _hex_to_rgb(style.text_color)
            sc = _hex_to_rgb(style.stroke_color)
            shc = _hex_to_rgb(style.shadow_color)
            sh_on = bool(style.shadow_enabled)
            dparts.append(
                "drawtext="
                f"fontfile={fontfile}:{textopt}"
                f":fontsize={size}:fontcolor=0x{tc[0]:02X}{tc[1]:02X}{tc[2]:02X}"
                f":borderw={max(0, style.stroke_width)}"
                f":bordercolor=0x{sc[0]:02X}{sc[1]:02X}{sc[2]:02X}"
                f":shadowcolor=0x{shc[0]:02X}{shc[1]:02X}{shc[2]:02X}@{style.shadow_opacity if sh_on else 0}"
                f":shadowx=0:shadowy={style.shadow_distance if sh_on else 0}"
                f":x={cx - wpx / 2.0:.1f}:y={y}:alpha='{a}'"
                f":enable='{en}'"
            )
            geo.append({"x0": cx - wpx / 2.0, "x1": cx + wpx / 2.0,
                        "y0": y0, "t0": t0, "hold": hold, "text": t,
                        "pill": bool(w.get("pill", False)), "chunk": ci})
    # ── Pill runs: consecutive pill-flagged words in one chunk share one
    # background box (AE merges adjacent pills). Rendered with PIL (true
    # rounded rects — drawbox cannot do radius) and composited UNDER the
    # text via movie+overlay, timed to the run's window.
    pills: list[dict] = []
    run: list[dict] = []
    def _flush_run() -> None:
        if not run or words_dir is None:
            return
        from PIL import ImageFont
        pad_x = round(style.pill_pad_x_em * size)
        pad_y = round(0.10 * size)
        # Center on the TIGHT glyph box (measured), not the line box: the
        # old line-box centering sat ~15px low (seen live as misaligned).
        try:
            _f = ImageFont.truetype(face, size)
            # Coordinate calibration: PIL y=0 sits at the ascender top while
            # drawtext y=0 sits at the glyph top — they differ by exactly the
            # cap-top bearing (measured, not assumed: 18px @96 Arial Bold).
            # Without this the box floats ~15px low (seen live, measured).
            _cap_top = _f.getbbox("H")[1]
            _tops, _bots = [], []
            for g in run:
                _b = _f.getbbox(str(g.get("text") or ""))
                _tops.append(_b[1] - _cap_top)
                _bots.append(_b[3] - _cap_top)
            gtop, gbot = min(_tops), max(_bots)
        except Exception:  # noqa: BLE001 — fall back to cap-height estimate
            gtop, gbot = int(size * 0.19), int(size * 0.90)
        bx0 = max(0, int(min(g["x0"] for g in run) - pad_x))
        bx1 = min(style.width, int(max(g["x1"] for g in run) + pad_x))
        by = max(0, int(run[0]["y0"] + gtop - pad_y))
        bh = int((gbot - gtop) + 2 * pad_y)
        if bx1 <= bx0 or bh <= 0:
            return
        n = len(pills)
        png = Path(words_dir) / f"pill{n:04d}.png"
        try:
            emit_rel = png.resolve().relative_to(Path.cwd().resolve()).as_posix()
        except (OSError, ValueError):
            emit_rel = png.as_posix()
        _render_pill_png(
            png, bx1 - bx0, bh, _hex_to_rgb(style.pill_color),
            max(0, min(255, round(style.pill_opacity * 255))),
            _hex_to_rgb(style.pill_stroke_color) if style.pill_outline else None,
            style.pill_stroke_width if style.pill_outline else 0,
            style.pill_radius,
        )
        pills.append({
            "png": str(png), "rel": emit_rel,
            "x": bx0, "y": by,
            "t0": min(g["t0"] for g in run),
            "t1": max(g["hold"] for g in run),
        })
    for g in geo:
        if g["pill"] and (not run or run[-1]["chunk"] == g["chunk"]):
            run.append(g)
        else:
            _flush_run()
            run = [g] if g["pill"] else []
    _flush_run()
    if not pills:
        return ",".join(dparts), []
    # Labeled assembly: base → pill overlays → word animators.
    segs = ["format=yuva444p10le,geq=r='0':g='0':b='0':a='0'[base]"]
    for i, p in enumerate(pills):
        # No :loop on movie — loop=0 hung the render; a single still plus
        # overlay's default eof_action=repeat covers the whole window.
        segs.append(f"movie='{p['rel']}',format=yuva444p10le[m{i}]")
    cur = "base"
    for i, p in enumerate(pills):
        nxt = f"b{i}"
        segs.append(f"[{cur}][m{i}]overlay={p['x']}:{p['y']}"
                    f":enable='between(t,{p['t0']:.3f},{p['t1']:.3f})'[{nxt}]")
        cur = nxt
    for j, d in enumerate(dparts):
        nxt = f"d{j}" if j < len(dparts) - 1 else "out"
        # Final filter feeds the encoder directly (no output label needed,
        # but a trailing label is harmless — keep the chain uniform by
        # omitting it only on the last one... simplest: always label
        # except last).
        segs.append(f"[{cur}]{d}" + (f"[{nxt}]" if j < len(dparts) - 1 else ""))
        cur = nxt
    return ";".join(segs), pills


def _stage_font(out_dir: Path, src: str) -> str:
    """Copy the measurement font next to the output and return a relative
    forward-slash path for the filtergraph.

    A relative path avoids the Windows drive colon, which the filter parser
    would otherwise split on ("No option name near ..." errors).
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    dst = out_dir / "overlay-font.ttf"
    try:
        if not dst.exists() or dst.stat().st_size != Path(src).stat().st_size:
            dst.write_bytes(Path(src).read_bytes())
    except OSError:
        pass
    return dst.as_posix()


def _ffmpeg_path() -> str:
    import shutil
    from ...config import get_settings
    try:
        s = get_settings()
        p = getattr(s, "FFMPEG_PATH", "ffmpeg")
        if p and p != "ffmpeg" and Path(str(p)).exists():
            return str(p)
    except Exception:  # noqa: BLE001
        pass
    found = shutil.which("ffmpeg")
    if found:
        return found
    root = Path(__file__).parent.parent.parent
    for cand in sorted((root / "data" / "tools").glob("ffmpeg-*/bin/ffmpeg.exe")):
        return str(cand)
    return "ffmpeg"


async def render_overlay(cues: list[dict], duration: float, style: OverlayStyle,
                         out_path: Path) -> Path:
    """Draw animated words onto a transparent canvas → ProRes 4444 .mov.

    drawtext draws only glyphs, so the canvas alpha survives (verified via
    alphaextract; the ass-filter path flattened it). Also writes the .ass
    sidecar next to the .mov for NLEs that prefer it.
    """
    from ...utils.error_helpers import check_and_prune_disk_space, clean_system_error

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    check_and_prune_disk_space(out_path.parent, min_mb=250, auto_prune=True, prune_pattern="*.mov", keep_count=5)
    staged = _stage_font(out_path.parent, _resolve_font_file(style.font_family, style.font_bold))
    # Filtergraph-safe font reference: relative to the backend CWD (no
    # drive colon) and single-quoted (the repo path contains spaces —
    # an unquoted absolute path splits the filter description and the
    # render dies with "Invalid argument"). Falls back to the absolute
    # path if a relative one cannot be built (different drive).
    try:
        rel = Path(staged).resolve().relative_to(Path.cwd().resolve()).as_posix()
    except (OSError, ValueError):
        rel = Path(staged).as_posix()
    filt, _pills = build_drawtext(cues, style, filter_font=f"'{rel}'",
                                   words_dir=out_path.parent / (out_path.stem + "_words"))
    if not filt:
        raise RuntimeError("no words to render")
    # Canvas: nullsrc has no alpha plane, and the color source's @0 alpha
    # is lost in yuv420p — so promote to yuva and zero all channels with
    # geq (verified via alphaextract: transparent bg, opaque glyphs).
    # drawtext then draws only glyphs, preserving that transparency.
    filt = ("format=yuva444p10le,geq=r='0':g='0':b='0':a='0'," + filt)
    # -t caps total length: pill movies loop forever by design, so the
    # muxer needs an explicit stop (else the render never terminates).
    total = max(0.5, duration + 0.5)
    cmd = [
        _ffmpeg_path(), "-y",
        "-f", "lavfi",
        "-i", (f"nullsrc=s={style.width}x{style.height}"
               f":r={style.fps}:d={total}"),
        "-vf", filt,
        "-t", str(total),
        "-c:v", "prores_ks", "-profile:v", "4444",
        "-pix_fmt", "yuva444p10le",
        "-r", str(style.fps),
        str(out_path),
    ]
    logger.info("overlay render: %ss at %dx%d (%d drawtext)",
                round(duration, 2), style.width, style.height, filt.count("drawtext="))
    # NOTE bytes (not text=True): ffmpeg echoes the filtergraph — including
    # Urdu words — to stderr, and the Windows console codec (cp1252) cannot
    # decode it. Decode as UTF-8 with replacement instead.
    proc = await asyncio.to_thread(
        subprocess.run, cmd, capture_output=True, text=False, timeout=900,
    )
    err = (proc.stderr or b"").decode("utf-8", errors="replace")
    if proc.returncode != 0 or not out_path.exists():
        # Full stderr goes to the backend log (the 500 detail is truncated);
        # without this, production failures are undiagnosable.
        logger.error("overlay ffmpeg full stderr:\n%s", err)
        raise RuntimeError(clean_system_error(err, target_path=out_path))
    ass_path = out_path.with_suffix(".ass")
    try:
        ass_path.write_text(build_ass(cues, style), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001 — sidecar is bonus, mov is the product
        logger.debug("overlay .ass sidecar failed: %s", exc)
    return out_path
