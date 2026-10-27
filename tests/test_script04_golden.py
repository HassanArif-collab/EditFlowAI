"""Golden editorial tests for B-roll relevance (Script 04).
These test WHAT is placed, not just mechanics. Ground truth: Visual_Library/ground_truth.json.
Run: .venv\\Scripts\\python.exe -m pytest tests/test_script04_golden.py -v  (from the repo root, so data/visual_library loads)
"""
import json
from pathlib import Path

import pytest

from backend.services.broll_placement_engine import BrollPlacementEngine
from backend.services.script_assembly_service import AssembledCut

GT_PATH = Path(r"D:\MARKETING\Rahima Aziz Foundation\AI Automation\Visual_Library\ground_truth.json")
if not GT_PATH.exists():
    pytest.skip("ground_truth.json not available", allow_module_level=True)
GT = json.loads(GT_PATH.read_text(encoding="utf-8"))
TALKING = {s.lower() for s in GT["talking_heads"]}
AI_GEN = {s.lower() for s in GT["ai_generated"]}

LINES = [  # (key, text, caption, start, end)
    ("winter", "And once the winter hits, they cannot come inside at all because they cannot park on the grass.", "ONCE WINTER HITS · NO PARKING ON THE GRASS", 0.0, 6.0),
    ("ibadah", "this Masjid has brought an opportunity for many people and many Muslims to come and seek ibadah", "AN OPPORTUNITY FOR MUSLIMS TO SEEK IBADAH", 6.0, 12.18),
    ("cars", "At the moment, we could only accommodate around 15 to 20 cars in our parking lot and then the rest of them are parking like this on the grass.", "ONLY 15 TO 20 CARS · REST PARKING ON THE GRASS", 12.18, 20.68),
    ("elders", "They're actually coming and then dropping the elders off and then having to go back outside.", "DROPPING ELDERS OFF · DRIVERS TURNED AWAY", 20.68, 26.18),
    ("infra", "rather it's an essential infrastructure of an institution.", "NOT A CONVENIENCE · ESSENTIAL INFRASTRUCTURE", 26.18, 31.94),
    ("appeal", "So if you can help us establish our parking lot as soon as possible, it will be helpful, and of course it will be as-sadqa-jariya.", "HELP US ESTABLISH OUR PARKING LOT · AS SADAQAH JARIYAH", 31.94, 40.08),
]

IBADAH_OK = {"C1340 40", "C1346 46", "C1351 51", "C1350 50", "C1348 48", "C1349 49", "C1275 75", "C1234 34", "C1242 42", "C1273 73", "C1270 70", "C1280 80", "C1277 77", "C1278 78", "C1254 54"}
CARS_OK = {"C1322 22", "C1327 27", "C1330 30", "C1352 52", "C1328 28", "C1329 29", "C1331 31", "C1332 32", "C1333 33", "C1354 54", "C1355 55", "C1356 56", "C1353 53"}
NEVER_ON_PARKING = {"C1335 35", "C1284 84", "C1303 03", "C1304 04", "C1334 34", "C1336 36", "C1337 37", "C1338 38", "C1339 39"}


@pytest.fixture(scope="module")
def placements_by_line():
    cuts = []
    for i, (key, txt, cap, st, en) in enumerate(LINES):
        cuts.append(AssembledCut(
            cut_index=i + 1, beat_index=i + 1, speaker="Speaker", source_file="src.mp4", source_stem="src",
            source_in=0.0, source_out=round(en - st, 2), duration=round(en - st, 2),
            timeline_start=st, timeline_end=en, quote=txt, caption_text=txt, marker_comment=cap,
        ))
    pls = BrollPlacementEngine.place_broll_for_plan(cuts=cuts, aspect_ratio="9:16", pacing_style="editorial")
    out = {k: [] for k, *_ in LINES}
    for p in pls:
        out[LINES[p.cut_index - 1][0]].append(Path(p.source_file).stem)
    return out


def _all(pbl):
    return [s for v in pbl.values() for s in v]


def test_never_places_talking_heads(placements_by_line):
    bad = [s for s in _all(placements_by_line) if s.lower() in TALKING]
    assert not bad, f"Talking heads placed as B-roll: {bad}"


def test_no_ai_generated_by_default(placements_by_line):
    bad = [s for s in _all(placements_by_line) if s.lower() in AI_GEN]
    assert not bad, f"AI-generated assets placed: {bad}"


def test_ibadah_line_shows_masjid_or_quran(placements_by_line):
    got = placements_by_line["ibadah"]
    assert got, "No visuals on ibadah line"
    assert all(s in IBADAH_OK for s in got), f"Ibadah line got non-ibadah clips: {got}"


def test_cars_line_shows_cars_on_grass(placements_by_line):
    got = placements_by_line["cars"]
    assert got, "No visuals on cars line"
    assert all(s in CARS_OK for s in got), f"Cars line got: {got}"


def test_kitchen_or_soccer_never_on_parking_lines(placements_by_line):
    parking_lines = placements_by_line["winter"] + placements_by_line["cars"] + placements_by_line["elders"]
    bad = [s for s in parking_lines if s in NEVER_ON_PARKING]
    assert not bad, f"Irrelevant clips on parking lines: {bad}"


def test_built_graphic_not_on_problem_lines(placements_by_line):
    problem = placements_by_line["winter"] + placements_by_line["cars"] + placements_by_line["elders"]
    assert "Parking area built" not in problem, "Solution graphic shown while describing the problem"
