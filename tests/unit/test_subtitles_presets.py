"""Tests for the subtitle animation preset registry.

WHY: the view's preset picker and the ExtendScript placer both rely on every
preset carrying the fields they branch on (engine, animation, wordMode). A
preset missing one silently no-ops an animation or mis-routes the engine. These
pin the built-in catalog's shape and uniqueness.
"""
from __future__ import annotations

from backend.services.subtitles.presets import get_preset, load_presets

_REQUIRED = {"id", "label", "engine", "animation", "wordMode"}


def test_builtins_present_and_well_formed():
    presets = load_presets()
    assert len(presets) >= 5
    ids = [p["id"] for p in presets]
    assert len(ids) == len(set(ids))                 # unique ids
    assert {"none", "pop", "fade"} <= set(ids)        # the staples exist
    for p in presets:
        assert _REQUIRED <= set(p), f"{p.get('id')} missing {(_REQUIRED - set(p))}"
        assert p["engine"] == "builtin"
        assert p["wordMode"] in ("line", "word")


def test_word_mode_preset_exists():
    word = [p for p in load_presets() if p["wordMode"] == "word"]
    assert word, "need at least one word-by-word preset"


def test_get_preset_by_id():
    assert get_preset("pop")["animation"] == "pop"
    assert get_preset("does-not-exist") is None
