"""Smoke tests for the Phase-A fixtures.

These run with **zero** external dependencies (no Whisper, no TTS, no ffmpeg).
They verify that the hand-authored canonical/expected JSON files are internally
consistent — so a future Phase-B / -C / -E test can rely on them as ground truth.

Run with:
    python -m unittest tests.test_fixtures_smoke -v
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from tests.fixtures.conftest import (
    flatten_canonical_words,
    load_fixture,
    timing_drift_ms,
    wer,
)


class FixtureLoaderTests(unittest.TestCase):
    def test_short_fixture_loads(self):
        fx = load_fixture("short")
        self.assertEqual(fx.name, "short")
        self.assertGreater(len(fx.canonical["takes"]), 0)
        self.assertGreater(len(fx.expected_takes["takes"]), 0)
        self.assertGreater(len(fx.scripts), 0)
        self.assertGreater(len(fx.expected_plans), 0)

    def test_unknown_fixture_raises(self):
        with self.assertRaises(FileNotFoundError):
            load_fixture("definitely_does_not_exist")


class CanonicalShapeTests(unittest.TestCase):
    def setUp(self):
        self.fx = load_fixture("short")
        self.canonical = self.fx.canonical

    def test_required_top_level_keys(self):
        for key in ("fixture_id", "spec_version", "duration", "language", "takes", "vad_segments"):
            self.assertIn(key, self.canonical, f"canonical missing {key!r}")

    def test_three_takes(self):
        self.assertEqual(len(self.canonical["takes"]), 3,
                         "interview_short was designed with 3 takes")

    def test_takes_are_in_temporal_order(self):
        prev_end = -1.0
        for take in self.canonical["takes"]:
            self.assertGreaterEqual(take["source_start"], prev_end,
                                    "takes must not overlap or go backwards")
            self.assertGreater(take["source_end"], take["source_start"],
                               "take must have positive duration")
            prev_end = take["source_end"]

    def test_take_words_are_within_take_boundary(self):
        for take in self.canonical["takes"]:
            for w in take["words"]:
                self.assertGreaterEqual(
                    w["start"], take["source_start"] - 0.1,
                    f"word {w['text']!r} starts before its take {take['take_index']}",
                )
                self.assertLessEqual(
                    w["end"], take["source_end"] + 0.1,
                    f"word {w['text']!r} ends after its take {take['take_index']}",
                )

    def test_take_words_are_in_order(self):
        for take in self.canonical["takes"]:
            prev_end = take["source_start"] - 1.0
            for w in take["words"]:
                self.assertGreaterEqual(w["start"], prev_end - 0.01,
                                        f"word {w['text']!r} starts before previous word ends")
                self.assertGreater(w["end"], w["start"],
                                   f"word {w['text']!r} has non-positive duration")
                prev_end = w["end"]

    def test_vad_segments_cover_full_duration(self):
        segs = self.canonical["vad_segments"]
        self.assertGreater(len(segs), 0)
        self.assertAlmostEqual(segs[0]["source_start"], 0.0, places=2)
        self.assertAlmostEqual(segs[-1]["source_end"], self.canonical["duration"], places=2)
        for i in range(len(segs) - 1):
            self.assertAlmostEqual(segs[i]["source_end"], segs[i + 1]["source_start"], places=2,
                                   msg=f"vad gap between segment {i} and {i + 1}")

    def test_vad_alternates_kinds(self):
        for i in range(len(self.canonical["vad_segments"]) - 1):
            self.assertNotEqual(
                self.canonical["vad_segments"][i]["kind"],
                self.canonical["vad_segments"][i + 1]["kind"],
                f"VAD segments {i} and {i + 1} have the same kind — merge them",
            )

    def test_fillers_are_in_lexicon(self):
        # Every word marked is_filler must be in our English filler lexicon.
        # When the lexicon is finalised in Phase C, update this set.
        english_fillers = {"uh", "um", "uhm", "ah", "er", "erm", "like", "you know"}
        for take in self.canonical["takes"]:
            for w in take["words"]:
                if w.get("is_filler"):
                    norm = "".join(c.lower() for c in w["text"] if c.isalnum() or c == " ")
                    self.assertIn(norm.strip(), english_fillers,
                                  f"{w['text']!r} marked filler but not in lexicon")


class ExpectedTakesConsistencyTests(unittest.TestCase):
    def setUp(self):
        self.fx = load_fixture("short")

    def test_expected_takes_count_matches_canonical(self):
        self.assertEqual(
            len(self.fx.expected_takes["takes"]),
            len(self.fx.canonical["takes"]),
        )

    def test_expected_takes_boundaries_match_canonical(self):
        for canon, exp in zip(self.fx.canonical["takes"], self.fx.expected_takes["takes"]):
            self.assertAlmostEqual(canon["source_start"], exp["source_start"], places=2)
            self.assertAlmostEqual(canon["source_end"], exp["source_end"], places=2)
            self.assertEqual(canon["take_index"], exp["take_index"])

    def test_expected_takes_filler_count_matches_canonical(self):
        for canon, exp in zip(self.fx.canonical["takes"], self.fx.expected_takes["takes"]):
            canon_fillers = sum(1 for w in canon["words"] if w.get("is_filler"))
            self.assertEqual(canon_fillers, exp["filler_count"],
                             f"take {exp['take_index']}: canonical has {canon_fillers} fillers, expected says {exp['filler_count']}")

    def test_expected_scores_are_in_legal_range(self):
        for exp in self.fx.expected_takes["takes"]:
            self.assertGreaterEqual(exp["expected_overall_score"], 0.0)
            self.assertLessEqual(exp["expected_overall_score"], 1.0)

    def test_score_ordering_reflects_quality_intent(self):
        # Take 2 (clean, no fillers) should score higher than takes 0 and 1.
        scores = {t["take_index"]: t["expected_overall_score"]
                  for t in self.fx.expected_takes["takes"]}
        self.assertGreater(scores[2], scores[0])
        self.assertGreater(scores[2], scores[1])


class ExpectedPlansConsistencyTests(unittest.TestCase):
    def setUp(self):
        self.fx = load_fixture("short")

    def test_both_scripts_have_a_plan(self):
        self.assertIn("script_v1_literal", self.fx.expected_plans)
        self.assertIn("script_v2_paraphrased", self.fx.expected_plans)

    def test_plan_cuts_reference_real_takes(self):
        valid_take_indices = {t["take_index"] for t in self.fx.canonical["takes"]}
        for script_id, plan in self.fx.expected_plans.items():
            for cut in plan["cuts"]:
                self.assertIn(cut["take_index"], valid_take_indices,
                              f"{script_id} cut references unknown take {cut['take_index']}")

    def test_plan_cuts_are_in_timeline_order(self):
        for script_id, plan in self.fx.expected_plans.items():
            prev_pos = -1.0
            for cut in plan["cuts"]:
                self.assertGreaterEqual(cut["timeline_position"], prev_pos,
                                        f"{script_id} cuts go backwards on timeline")
                prev_pos = cut["timeline_position"] + cut["duration"]

    def test_plan_source_ranges_are_within_take(self):
        takes_by_index = {t["take_index"]: t for t in self.fx.canonical["takes"]}
        for script_id, plan in self.fx.expected_plans.items():
            tol = plan["tolerance"]["source_in_ms"] / 1000.0
            for cut in plan["cuts"]:
                take = takes_by_index[cut["take_index"]]
                # Allow small overshoot for VAD-snap padding outside the take's literal word boundaries
                self.assertGreaterEqual(cut["source_in"], take["source_start"] - 0.5 - tol,
                                        f"{script_id} cut source_in before take start")
                self.assertLessEqual(cut["source_out"], take["source_end"] + 0.5 + tol,
                                     f"{script_id} cut source_out after take end")

    def test_plan_v1_uses_takes_0_and_1(self):
        # v1 is literal → should pick the takes that contain the literal text
        plan = self.fx.expected_plans["script_v1_literal"]
        picked = [c["take_index"] for c in plan["cuts"]]
        self.assertEqual(picked, [0, 1],
                         "v1 literal script should match take 0 then take 1")

    def test_plan_v2_prefers_high_quality_take_2(self):
        # v2 is paraphrased → matcher should prefer take 2 (no fillers)
        plan = self.fx.expected_plans["script_v2_paraphrased"]
        picked = [c["take_index"] for c in plan["cuts"]]
        self.assertTrue(all(t == 2 for t in picked),
                        "v2 paraphrased should resolve to take 2 only")

    def test_durations_sum_correctly(self):
        for script_id, plan in self.fx.expected_plans.items():
            total = sum(c["duration"] for c in plan["cuts"])
            self.assertAlmostEqual(total, plan["summary"]["total_duration"], places=2)


class WerHelperTests(unittest.TestCase):
    def test_identical_words(self):
        self.assertEqual(wer(["hello", "world"], ["hello", "world"])["wer"], 0.0)

    def test_one_substitution(self):
        r = wer(["hello", "world"], ["hello", "earth"])
        self.assertEqual(r["wer"], 0.5)
        self.assertEqual(r["sub"], 1)
        self.assertEqual(r["ins"], 0)
        self.assertEqual(r["del"], 0)

    def test_one_deletion(self):
        r = wer(["hello", "world"], ["hello"])
        self.assertEqual(r["del"], 1)

    def test_one_insertion(self):
        r = wer(["hello"], ["hello", "world"])
        self.assertEqual(r["ins"], 1)

    def test_empty_reference(self):
        self.assertEqual(wer([], [])["wer"], 0.0)
        self.assertEqual(wer([], ["a"])["wer"], 1.0)


class TimingDriftHelperTests(unittest.TestCase):
    def test_no_snapshot_returns_empty(self):
        fx = load_fixture("short")
        # No snapshot present yet — should be a no-op equivalent
        drifts = timing_drift_ms(fx.canonical, {"words": []})
        self.assertEqual(drifts, [])

    def test_identical_snapshot_is_zero_drift(self):
        fx = load_fixture("short")
        # Build a synthetic snapshot from the canonical itself
        snap_words = []
        for take in fx.canonical["takes"]:
            for w in take["words"]:
                snap_words.append({"text": w["text"], "start": w["start"], "end": w["end"]})
        drifts = timing_drift_ms(fx.canonical, {"words": snap_words})
        self.assertEqual(len(drifts), 52)
        for d in drifts:
            self.assertEqual(d, 0.0)


class FilesPresentTests(unittest.TestCase):
    """The fixture skeleton must contain every file referenced by the README."""

    def setUp(self):
        self.short = Path(__file__).resolve().parent / "fixtures" / "short"
        self.build = Path(__file__).resolve().parent / "fixtures" / "build"

    def test_short_has_all_files(self):
        for name in ("spec.md", "canonical.json", "takes.expected.json",
                     "script_v1_literal.txt", "script_v2_paraphrased.txt",
                     "plan_v1.expected.json", "plan_v2.expected.json"):
            self.assertTrue((self.short / name).is_file(), f"missing {name}")

    def test_build_scripts_present(self):
        for name in ("build_short_tts.py", "build_short_silence.py", "capture_truth.py"):
            self.assertTrue((self.build / name).is_file(), f"missing {name}")

    def test_readme_present(self):
        readme = Path(__file__).resolve().parent / "fixtures" / "README.md"
        self.assertTrue(readme.is_file())


if __name__ == "__main__":
    unittest.main()
