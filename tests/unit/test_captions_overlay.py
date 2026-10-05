"""Tests for the animated caption overlay (ASS generation).

WHY: the ASS text is the animation — a mistimed \\move, a dropped word, or
a wrong PlayRes and the Premiere overlay drifts, clips, or loses words.
ffmpeg rendering is verified by hand/eye on real frames; these pin the
script bytes that rendering consumes.
"""
from __future__ import annotations

from backend.services.subtitles.animated_overlay import (
    OverlayStyle,
    _assign_lines,
    build_ass,
    build_drawtext,
)


def _style(**kw):
    kw.setdefault("width", 1080)
    kw.setdefault("height", 1920)
    return OverlayStyle(**kw)


def _cue(words, text=None):
    if text is None:
        text = " ".join(w[0] for w in words)
    return {"text": text, "start": words[0][1], "end": words[-1][2],
            "words": [{"text": t, "start": s, "end": e} for t, s, e in words]}


def test_one_event_per_word_with_move_and_fade():
    cue = _cue([("Hello", 0.0, 0.4), ("world", 0.5, 0.9)])
    ass = build_ass([cue], _style())
    assert ass.count("Dialogue:") == 2
    # every word rises (\\move ends above its start) and fades in (\\fad)
    for line in ass.splitlines():
        if line.startswith("Dialogue:"):
            assert "\\move(" in line and "\\fad(" in line
            assert "Hello" in line or "world" in line


def test_words_persist_until_cue_end():
    # WHY: AE holds entered words visible until the cue clears — dropping
    # them at word-end would flicker the caption.
    cue = _cue([("a", 0.0, 0.2), ("b", 1.0, 1.2)])
    ass = build_ass([cue], _style())
    for line in ass.splitlines():
        if line.startswith("Dialogue:"):
            assert ",0:00:01.20," in line


def test_multiline_cue_puts_lines_on_different_rows():
    cue = _cue([("hello", 0.0, 0.4), ("big", 0.5, 0.8), ("world", 0.9, 1.2)],
               text="hello big\nworld")
    line_lists = _assign_lines(cue)
    assert [[w["text"] for w in ln] for ln in line_lists] == [["hello", "big"], ["world"]]
    ass = build_ass([cue], _style())
    ys = []
    for line in ass.splitlines():
        if line.startswith("Dialogue:"):
            m = line.split("\\move(")[1]
            ys.append(tuple(int(v) for v in m.split(")")[0].split(",")[:4]))
    assert ys[0][1] != ys[2][1]  # line 1 y differs from line 2 y
    # move target of first word equals its own rest position, rising up
    assert ys[0][0] == ys[0][2] and ys[0][1] - ys[0][3] > 0


def test_empty_cues_produce_header_only():
    ass = build_ass([], _style())
    assert "[Events]" in ass and "Dialogue:" not in ass


def test_playres_matches_style():
    ass = build_ass([], _style(width=1920, height=1080))
    assert "PlayResX: 1920" in ass and "PlayResY: 1080" in ass


def test_drawtext_one_filter_per_word_with_hold():
    # WHY: the render path must emit exactly one timed filter per word —
    # a missing filter drops a word from the video with no error.
    cue = _cue([("Hello", 0.5, 0.9), ("world", 1.0, 1.4)])
    filt, _pills = build_drawtext([cue], _style())
    assert filt.count("drawtext=") == 2
    # y is unquoted → escaped commas; alpha/enable are quoted → raw commas
    assert "enable='between(t,0.500,1.900)'" in filt
    assert "enable='between(t,1.000,1.900)'" in filt
    assert "\\,0)\\,1))" in filt  # escaped comma inside the y expression
    # words hold until cue end (AE behavior)
    assert "fontfile=" in filt and "alpha=" in filt


def test_drawtext_holds_until_next_cue():    # WHY: AE holds each caption until the next one starts — without this
    # rule captions blink out at the last word's end (seen live: black
    # frames from t=1.45 with cue authored to 2.0).
    c1 = _cue([("a", 0.0, 0.4)])
    c2 = _cue([("b", 2.0, 2.4)])
    filt, _pills = build_drawtext([c1, c2], _style())
    assert "between(t,0.000,2.000)" in filt  # held to next cue start
    assert "between(t,2.000,2.900)" in filt  # last cue: +0.5s tail


def test_drawtext_escapes_filter_metachars():
    cue = _cue([("it's a:b", 0.0, 0.5)])
    filt, _pills = build_drawtext([cue], _style())
    # inside single quotes only backslash + quote are escaped
    assert "it\\'s a:b" in filt


def test_drawtext_escapes_semicolon_in_words():
    # WHY: a semicolon inside a word split the filtergraph live
    # ("No such filter" 500) — quotes do NOT protect ';' in ffmpeg.
    cue = _cue([("hey;listen", 0.0, 0.5)])
    filt, _pills = build_drawtext([cue], _style())
    assert "hey\\;listen" in filt


def test_drawtext_fontfile_quoted_for_spaced_paths():
    # WHY: the repo path contains spaces — an unquoted absolute fontfile
    # splits the filter description and the render dies ("Invalid
    # argument", seen live). The production path always quotes it.
    cue = _cue([("hi", 0.0, 0.5)])
    filt, _pills = build_drawtext([cue], _style(),
                          filter_font="'data/output/captions/overlay-font.ttf'")
    assert "fontfile='data/output/captions/overlay-font.ttf'" in filt


def test_drawtext_motion_variants():
    from backend.services.subtitles.animated_overlay import PRESET_MOTION
    cue = _cue([('go', 0.5, 0.9)])
    bounce, _ = build_drawtext([cue], _style(motion='bounce'))
    assert 'sin(' in bounce  # damped oscillation, not a plain rise
    cut, _ = build_drawtext([cue], _style(motion='cut'))
    assert 'pow(' not in cut and 'sin(' not in cut  # static on
    assert set(PRESET_MOTION) == {'none','fade','word_fade','slide_up','pop','word_pop','bounce'}



def test_build_style_maps_request_fields():
    # WHY: the Style tab and the render must agree on every knob — a dropped
    # field silently renders defaults while the UI shows custom values.
    from backend.routes.captions import OverlayReq, _build_style
    req = OverlayReq(cues=[], preset="slide_up", animate_preset="bounce",
                     font_size=80, all_caps=True,
                     pos_y_ratio=0.7, pos_x_ratio=0.4, box_width_ratio=0.8,
                     pill_color="#ff0000", pill_opacity=0.5, pill_outline=False,
                     rise_ms=100, easing="ease_out", intensity=1.5, slide_px=40,
                     font_family="Verdana", font_bold=False, text_color="#ff0000",
                     stroke_color="#00ff00", stroke_width=4, shadow_enabled=False,
                     pill_stroke_color="#0000ff", pill_stroke_width=5, pill_radius=0.2)
    st = _build_style(req)
    assert (st.motion, st.font_size, st.all_caps) == ("bounce", 80, True)
    assert (st.pos_y_ratio, st.pos_x_ratio, st.box_width_ratio) == (0.7, 0.4, 0.8)
    assert (st.pill_color, st.pill_opacity, st.pill_outline) == ("#ff0000", 0.5, False)
    assert (st.easing, st.intensity) == ("ease_out", 1.5)
    assert st.rise_ms == 100
    assert (st.font_family, st.font_bold, st.text_color) == ("Verdana", False, "#ff0000")
    assert (st.stroke_color, st.stroke_width, st.shadow_enabled) == ("#00ff00", 4, False)
    assert (st.pill_stroke_color, st.pill_stroke_width, st.pill_radius) == ("#0000ff", 5, 0.2)


def test_build_style_pop_preset_no_duplicate_kwarg():
    # WHY: PRESET_MOTION["pop"] carries its own rise_ms — passing it plus
    # the explicit one raised "multiple values for keyword argument"
    # (500 live). Every preset must build.
    from backend.routes.captions import OverlayReq, _build_style
    for pid in ("none", "fade", "word_fade", "slide_up", "pop", "word_pop", "bounce"):
        st = _build_style(OverlayReq(cues=[], preset=pid))
        assert st.motion in ("rise", "bounce", "cut")
    assert _build_style(OverlayReq(cues=[], animate_preset="popin")).rise_ms == 180


def test_build_style_all_animate_presets():
    # WHY: every Animate-tab preset must resolve to a motion — an unknown
    # id silently falling back hides a typo'd preset forever.
    from backend.routes.captions import OverlayReq, _build_style
    from backend.services.subtitles.animated_overlay import ANIM_MOTION
    seen = {}
    for pid in ("fadeup_words", "popin", "fadeup", "bounce", "squash",
                "typewriter", "fade"):
        st = _build_style(OverlayReq(cues=[], animate_preset=pid))
        seen[pid] = (st.motion, st.caption_level)
    assert seen == {
        "fadeup_words": ("rise", False), "popin": ("back", False),
        "fadeup": ("rise", True), "bounce": ("bounce", False),
        "squash": ("back", False), "typewriter": ("cut", False),
        "fade": ("fade", True),
    }
    assert set(ANIM_MOTION) == set(seen)


def test_drawtext_textfile_mode_writes_words(tmp_path):
    # WHY: inline quoting cannot survive apostrophes (Chicago's broke a
    # production render) — production always uses textfile mode.
    cue = _cue([("Chicago's", 0.5, 0.9)])
    filt, _pills = build_drawtext([cue], _style(), words_dir=tmp_path / "w")
    assert "textfile=" in filt and "text='" not in filt
    assert (tmp_path / "w" / "w0000.txt").read_text(encoding="utf-8") == "Chicago's"


def test_drawtext_constant_fontsize_everywhere():
    # WHY: shrinking long lines made sizes inconsistent across cues (seen
    # live) — AE keeps one size; over-wide lines split into chunks instead.
    import re
    cue = _cue([(f"w{i}", i * 0.3, i * 0.3 + 0.2) for i in range(12)])
    filt, _pills = build_drawtext([cue], _style())
    sizes = set(re.findall(r":fontsize=(\d+)", filt))
    assert sizes == {"96"}, sizes


def test_drawtext_wide_line_splits_into_chunks():
    # WHY: a line wider than the box must become sequential chunks — never
    # bleed off frame, never shrink.
    cue = _cue([(f"word{i:02d}", i * 0.3, i * 0.3 + 0.2) for i in range(10)])
    filt, _pills = build_drawtext([cue], _style(width=400))
    assert filt.count("drawtext=") == 10


def _pill_cue(tmp_path):
    words = [
        {"text": "hot", "start": 0.5, "end": 0.8, "pill": True},
        {"text": "take", "start": 0.9, "end": 1.2, "pill": True},
        {"text": "now", "start": 1.3, "end": 1.6, "pill": False},
    ]
    cue = {"text": "hot take now", "start": 0.5, "end": 1.6, "words": words}
    return build_drawtext([cue], _style(), words_dir=tmp_path / "w")


def test_pill_adjacent_words_merge_into_one_box(tmp_path):
    # WHY: AE merges adjacent pill words into a single background — two
    # boxes with a seam reads as a glitch.
    filt, pills = _pill_cue(tmp_path)
    assert len(pills) == 1
    assert pills[0]["t0"] == 0.5 and pills[0]["x"] < pills[0]["y"] * 2
    assert "overlay=" in filt and "movie=" in filt
    assert (tmp_path / "w" / "pill0000.png").exists()


def test_pill_png_is_rounded_transparent(tmp_path):
    # Stadium shape: corners must stay transparent, middle opaque.
    from PIL import Image
    _pill_cue(tmp_path)
    im = Image.open(tmp_path / "w" / "pill0000.png").convert("RGBA")
    w, h = im.size
    assert w > 10 and h > 10
    assert im.getpixel((0, 0))[3] == 0, "corner must be transparent (rounded)"
    assert im.getpixel((w // 2, h // 2))[3] > 200, "middle must be opaque"


def test_pill_box_covers_glyphs_not_empty_text(tmp_path):
    # WHY: geometry entries once lost the word text, so boxes measured ""
    # and rendered as 20px slivers (seen live). Box must cover real glyphs.
    cue = _cue([("hot take", 0.5, 1.2)])
    cue["words"] = [
        {"text": "hot", "start": 0.5, "end": 0.8, "pill": True},
        {"text": "take", "start": 0.9, "end": 1.2, "pill": True},
    ]
    filt, pills = build_drawtext([cue], _style(), words_dir=tmp_path / "w")
    assert len(pills) == 1
    from PIL import Image
    im = Image.open(tmp_path / "w" / "pill0000.png").convert("RGBA")
    assert im.size[1] > 48, im.size  # glyph-height box, not an empty sliver


def test_no_pills_means_linear_chain_without_movie(tmp_path):
    cue = _cue([("plain", 0.5, 0.9)])
    filt, pills = build_drawtext([cue], _style(), words_dir=tmp_path / "w")
    assert pills == []
    assert "movie=" not in filt and "overlay=" not in filt
