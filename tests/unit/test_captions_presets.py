"""Tests for the caption preset registry.

WHY: the panel picker renders whatever this returns — a malformed entry
(unknown wordMode, missing animation) breaks the Generate step. These
pin the catalog shape the panel contract depends on.
"""
from __future__ import annotations

from backend.services.subtitles.presets import get_preset, load_presets


def test_builtin_catalog_shape():
    presets = load_presets()
    assert len(presets) == 7
    for p in presets:
        assert set(p) == {"id", "label", "engine", "animation", "wordMode"}
        assert p["wordMode"] in ("line", "word")


def test_word_presets_exist():
    assert get_preset("word_pop")["wordMode"] == "word"
    assert get_preset("word_fade")["wordMode"] == "word"
    assert get_preset("none")["animation"] == "none"


def test_unknown_preset_returns_none():
    assert get_preset("does-not-exist") is None
