"""MVP Task M1: bin_resolver tests"""
import unittest
import pytest
from backend.services.bin_resolver import resolve, AmbiguousReferenceError

PROJECT_SCAN_FIXTURE = {
    "bins": [
        {"name": "MyTakes", "path": "MyTakes", "itemCount": 3, "depth": 0},
        {"name": "Subs", "path": "MyTakes/Subs", "itemCount": 2, "depth": 1},
        {"name": "Other", "path": "Other", "itemCount": 0, "depth": 0},
    ],
    "items": [
        {"name": "take_01.mp4", "binPath": "MyTakes", "mediaPath": "C:/a/take_01.mp4", "hasAudio": True, "duration": 12.4},
        {"name": "take_02.mp4", "binPath": "MyTakes", "mediaPath": "C:/a/take_02.mp4", "hasAudio": True, "duration": 18.7},
        {"name": "extra.png",   "binPath": "MyTakes", "mediaPath": "C:/a/extra.png",   "hasAudio": False, "duration": 0},
        {"name": "deep.mp4",    "binPath": "MyTakes/Subs", "mediaPath": "C:/b/deep.mp4", "hasAudio": True, "duration": 30},
    ],
}

class TestBinResolver(unittest.TestCase):
    def test_bin_direct_children_only(self):
        out = resolve(["@bin:MyTakes"], PROJECT_SCAN_FIXTURE)
        assert [c.name for c in out] == ["take_01.mp4", "take_02.mp4"]

    def test_bin_recursive(self):
        out = resolve(["@bin:MyTakes/**"], PROJECT_SCAN_FIXTURE)
        # _resolve_bin sorts alphabetically by name
        assert [c.name for c in out] == ["deep.mp4", "take_01.mp4", "take_02.mp4"]

    def test_clip_lookup(self):
        out = resolve(["@clip:take_02.mp4"], PROJECT_SCAN_FIXTURE)
        assert len(out) == 1 and out[0].name == "take_02.mp4"

    def test_ambiguous_raises(self):
        scan = {**PROJECT_SCAN_FIXTURE,
                "bins": PROJECT_SCAN_FIXTURE["bins"] + [
                    {"name": "MyTakes", "path": "Other/MyTakes", "itemCount": 0, "depth": 1}
                ]}
        with self.assertRaises(AmbiguousReferenceError):
            resolve(["@MyTakes"], scan)

    def test_empty_references(self):
        out = resolve([], PROJECT_SCAN_FIXTURE)
        assert out == []

    def test_dedup_by_path(self):
        out = resolve(["@bin:MyTakes", "@clip:take_01.mp4"], PROJECT_SCAN_FIXTURE)
        paths = [c.path for c in out]
        assert len(paths) == len(set(paths))  # no duplicates

if __name__ == "__main__":
    unittest.main()
