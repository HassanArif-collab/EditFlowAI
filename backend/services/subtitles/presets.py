"""Subtitle animation preset registry.

Built-in presets are code-keyframed by subtitle_manager.jsx (no MOGRT animation,
no After Effects) — each maps to an ``animation`` routine and a ``wordMode``.
Imported rich-MOGRT presets (Phase 3) will be appended here from a manifest;
for now the catalog is the built-ins.
"""
from __future__ import annotations


def _p(pid: str, label: str, animation: str, word_mode: str = "line") -> dict:
    return {"id": pid, "label": label, "engine": "builtin",
            "animation": animation, "wordMode": word_mode}


BUILTIN_PRESETS: list[dict] = [
    _p("none", "Plain (no animation)", "none"),
    _p("fade", "Fade in", "fade"),
    _p("pop", "Pop in", "pop"),
    _p("slide_up", "Slide up", "slide_up"),
    _p("bounce", "Bounce in", "bounce"),
    _p("word_pop", "Word-by-word · pop", "pop", "word"),
    _p("word_fade", "Word-by-word · fade", "fade", "word"),
]


def load_presets() -> list[dict]:
    """All available presets (built-ins; imported MOGRT presets later)."""
    return [dict(p) for p in BUILTIN_PRESETS]


def get_preset(preset_id: str) -> dict | None:
    for p in BUILTIN_PRESETS:
        if p["id"] == preset_id:
            return dict(p)
    return None
