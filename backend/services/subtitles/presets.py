"""Caption style preset registry.

Built-ins describe how a cue presents on the timeline: ``animation`` is
realized by the caption-track style (Tier-1) or the per-cue graphic
builder (Tier-2) — never by host expressions, which Premiere's API has
no equivalent of. ``word_mode`` selects cue-level vs word-level timing.
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
    """All available presets (built-ins; graphic-template imports later)."""
    return [dict(p) for p in BUILTIN_PRESETS]


def get_preset(preset_id: str) -> dict | None:
    for p in BUILTIN_PRESETS:
        if p["id"] == preset_id:
            return dict(p)
    return None
