"""
Tests for ScriptAssemblyService, FrankenBiteTrimmer, and Script Assembly API routes.
Verifies CUT LIST table parsing, chain blocks, Franken-bite ellipsis trimming,
checkerboarded J-cuts, scale punch-in, and ExtendScript EDL operations.
"""
import os
import shutil
import tempfile
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.services.media_resolver import media_resolver
from backend.services.script_assembly_service import (
    FrankenBiteTrimmer,
    MicroCutSlice,
    ScriptAssemblyService,
    parse_timecode_to_seconds,
    script_assembly_service,
)

SAMPLE_CUT_LIST_SCRIPT = """# Script 20 — "One Sentence, Three Voices" (30s)
**Length:** 30 seconds

**CUT LIST (editor — total 30s, 3 fragments):**

| # | Person | Source file | Cut IN → OUT | Yields | Timeline | Handoff |
|---|---|-------------|--------------|--------|----------|---------|
| 1 | Muhammad Nisar | `Raw_Transcriptions\\C5024.MP4` | 02:44 → 02:48 ("best opportunity you can ever get") | 4s | 0:00–0:04 | J-cut out: Abdullah voice 4f early |
| 2 | Abdullah | `Raw_Transcriptions\\C5032.MP4` | 01:24 → 01:27 ("sponsor a truck, sponsor many") | 3s | 0:04–0:07 | Lands chain 1 |
| 3 | Abdullah | `Raw_Transcriptions\\C5032.MP4` | 00:40 → 00:51 ("Caissons in the ground… earth retention up… first concrete poured") | 11s → fit 0:07–0:14 | 0:07–0:14 | Same speaker Frankenbite |
"""

SAMPLE_AD_SCRIPT = """# Ultra-Short Ad Script - 15 Seconds

### **[0:00 - 0:05] HOOK**
**VISUAL:** Concrete trucks, construction site
**VOICEOVER:** "30-year-old masjid... broken... rebuilt."
**TEXT:** FROM BROKEN TO BLESSED

### **[0:05 - 0:10] THE NEED**
**VISUAL:** Concrete trucks pouring foundation
**VOICEOVER:** "720 concrete trucks needed. $5,000 each."
**TEXT:** 720 TRUCKS | $5,000 EACH

### **[0:10 - 0:15] CTA**
**VISUAL:** 3D mosque render
**VOICEOVER:** "Donate now. JamiaMasjidChicago.com"
**TEXT:** DONATE NOW
"""


@pytest.fixture
def temp_project_dir():
    """Create a temporary mock project folder structure mimicking Jamia Masjid Chicago."""
    temp_dir = tempfile.mkdtemp(prefix="editflow_assembly_test_")
    root = Path(temp_dir)

    # Subfolders
    (root / "Raw Data" / "myairbridge").mkdir(parents=True)
    (root / "Voice" / "1 Abdullah").mkdir(parents=True)
    (root / "Raw_Transcriptions").mkdir(parents=True)
    (root / "Concrete Pouring").mkdir(parents=True)
    (root / "Visuals").mkdir(parents=True)

    # Media files
    (root / "Raw Data" / "myairbridge" / "C5032.MP4").write_text("fake video")
    (root / "Raw Data" / "myairbridge" / "C5024.MP4").write_text("fake video 2")
    (root / "Voice" / "1 Abdullah" / "01 Abdullah-enhanced-v2.mp3").write_text("fake enhanced audio")
    (root / "Raw_Transcriptions" / "C5032.json").write_text(
        '{"segments": [{"start": 40.0, "end": 45.0, "text": "Caissons in the ground earth retention up"}, {"start": 47.0, "end": 51.0, "text": "first concrete poured"}]}'
    )
    (root / "Concrete Pouring" / "1.mp4").write_text("fake broll")
    (root / "Visuals" / "3D Mosque Render.png").write_text("fake render")

    # Index the mock directory
    media_resolver.index_directory(temp_dir, force=True)

    yield temp_dir

    shutil.rmtree(temp_dir, ignore_errors=True)


class TestFrankenBiteTrimmer:
    def test_single_phrase(self):
        trimmer = FrankenBiteTrimmer()
        slices = trimmer.trim_frankenbite(
            quote="This is the best opportunity you can ever get",
            gross_in=164.0,
            gross_out=168.0,
        )
        assert len(slices) == 1
        assert slices[0].source_in == 164.0
        assert slices[0].source_out == 168.0
        assert slices[0].duration == 4.0

    def test_ellipsis_split_proportional(self):
        trimmer = FrankenBiteTrimmer()
        slices = trimmer.trim_frankenbite(
            quote="Caissons in the ground… earth retention up… first concrete poured.",
            gross_in=40.0,
            gross_out=51.0,
            target_slot_sec=7.0,
        )
        assert len(slices) == 3
        assert slices[0].sub_text == "Caissons in the ground"
        assert slices[1].sub_text == "earth retention up"
        assert slices[2].sub_text == "first concrete poured."
        for sl in slices:
            assert sl.source_in >= 40.0
            assert sl.source_out <= 51.0
            assert sl.duration > 0.5


class TestScriptAssemblyService:
    def test_parse_timecode(self):
        assert parse_timecode_to_seconds("02:44") == 164.0
        assert parse_timecode_to_seconds("00:40") == 40.0
        assert parse_timecode_to_seconds("0:04") == 4.0
        assert parse_timecode_to_seconds("15s") == 15.0

    def test_parse_cut_list_table(self):
        svc = ScriptAssemblyService()
        beats = svc.parse_markdown_script(SAMPLE_CUT_LIST_SCRIPT)
        assert len(beats) == 3

        # Beat 1
        assert beats[0].speaker == "Muhammad Nisar"
        assert beats[0].clip_stem == "C5024"
        assert beats[0].source_in == 164.0
        assert beats[0].source_out == 168.0
        assert beats[0].timeline_in == 0.0
        assert beats[0].timeline_out == 4.0
        assert "j-cut" in beats[0].handoff_note.lower()

        # Beat 2
        assert beats[1].speaker == "Abdullah"
        assert beats[1].clip_stem == "C5032"
        assert beats[1].source_in == 84.0
        assert beats[1].source_out == 87.0

        # Beat 3 (Frankenbite)
        assert beats[2].clip_stem == "C5032"
        assert "…" in beats[2].quote or "..." in beats[2].quote

    def test_parse_ad_blocks(self):
        svc = ScriptAssemblyService()
        beats = svc.parse_markdown_script(SAMPLE_AD_SCRIPT)
        assert len(beats) == 3
        assert beats[0].timeline_in == 0.0
        assert beats[0].timeline_out == 5.0
        assert "Concrete trucks" in beats[0].visual_cue
        assert "30-year-old" in beats[0].quote
        assert beats[1].timeline_in == 5.0
        assert beats[1].timeline_out == 10.0

    def test_compile_script_to_plan(self, temp_project_dir):
        svc = ScriptAssemblyService()
        plan = svc.compile_script_to_plan(
            script_input=SAMPLE_CUT_LIST_SCRIPT,
            script_id="Script 20",
            title="One Sentence Three Voices",
            aspect_ratio="9:16",
            auto_broll=True,
        )

        assert plan.script_id == "Script 20"
        assert plan.aspect_ratio == "9:16"
        assert plan.width == 1080
        assert plan.height == 1920
        assert len(plan.cuts) >= 3

        # Verify J-cut detection on speaker handoff
        cuts = plan.cuts
        assert any(c.audio_lead_frames > 0 for c in cuts)

        # Verify same-clip splice scale punch-in (108%)
        assert any(c.scale_punch_in == 1.08 for c in cuts)

        # Verify markers generated
        assert len(plan.markers) >= 3

    def test_plan_to_edl_ops(self, temp_project_dir):
        svc = ScriptAssemblyService()
        plan = svc.compile_script_to_plan(SAMPLE_CUT_LIST_SCRIPT)
        ops = svc.plan_to_edl_ops(plan, target_seq_name="Test Sequence")

        assert len(ops) >= 6
        assert ops[0]["action"] == "beginUndoGroup"
        assert any(op["action"] == "create_sequence" for op in ops)
        assert any(op["action"] == "add" and op.get("video_track_index") == 0 for op in ops)
        assert any(op["action"] == "add_marker" for op in ops)
        assert ops[-1]["action"] == "endUndoGroup"


class TestScriptAssemblyAPI:
    def test_compile_and_assemble_api(self, temp_project_dir):
        client = TestClient(app)

        # Test /api/script-assembly/compile
        resp = client.post(
            "/api/script-assembly/compile",
            json={
                "script_content": SAMPLE_CUT_LIST_SCRIPT,
                "script_id": "Script 20",
                "aspect_ratio": "9:16",
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert "plan" in data
        assert len(data["plan"]["cuts"]) >= 3

        # Test /api/script-assembly/assemble (one-shot EDL ops)
        assemble_resp = client.post(
            "/api/script-assembly/assemble",
            json={
                "script_content": SAMPLE_AD_SCRIPT,
                "script_id": "15s Ad",
                "aspect_ratio": "9:16",
            },
        )
        assert assemble_resp.status_code == 200
        ass_data = assemble_resp.json()
        assert ass_data["success"] is True
        assert "extendscript_ops" in ass_data
        assert ass_data["total_ops"] > 0

        # Test Aspect Ratios (16:9 and 1:1)
        r_169 = client.post(
            "/api/script-assembly/compile",
            json={
                "script_content": SAMPLE_CUT_LIST_SCRIPT,
                "aspect_ratio": "16:9",
            },
        )
        assert r_169.status_code == 200
        assert r_169.json()["plan"]["width"] == 1920
        assert r_169.json()["plan"]["height"] == 1080

        # Test Audio Preview streaming
        fake_vid = str(Path(temp_project_dir) / "Raw Data" / "myairbridge" / "C5032.MP4")
        prev_resp = client.get("/api/media-resolver/audio-preview", params={"path": fake_vid})
        assert prev_resp.status_code == 200
        assert "video/mp4" in prev_resp.headers.get("content-type", "")

    def test_fractional_timecode_and_quotes(self, temp_project_dir):
        """Verify fractional timecodes (.05) parse correctly and quote fields are populated."""
        script_md = """# Script Test
| # | Person | Source file | Cut IN → OUT | Yields | Timeline | Role in Story |
|---|---|---|---|---|---|---|
| 1 | M. Abdul Majeed | C4181.MP4 | 00:17.05 → 00:25.05 | 6.5s | 0:00–0:06.5 | Hook |
| 2 | Muhammad Nisar | C5024.MP4 | 01:03.00 → 01:09.00 | 3.5s | 0:06.5–0:10.0 | Once in a lifetime |

**Audio — Muhammad Nisar (`C5024.MP4` 01:03.00–01:09.00):**
> "Allah gave this kind of opportunity once in a life for someone."
"""
        beats = script_assembly_service.parse_markdown_script(script_md)
        assert len(beats) == 2
        assert beats[0].source_in == 17.05
        assert beats[0].source_out == 25.05
        assert beats[1].source_in == 63.0
        assert beats[1].source_out == 69.0
        assert "Allah gave this kind" in beats[1].quote

        plan = script_assembly_service.compile_script_to_plan(script_md, title="Fractional Test")
        assert len(plan.cuts) >= 2
        # Verify Nisar C5024 was NOT hijacked to 164s
        nisar_cut = next(c for c in plan.cuts if "C5024" in c.source_stem or "Nisar" in c.speaker)
        assert nisar_cut.source_in < 75.0  # Around 63s, NOT 164s!
        assert nisar_cut.quote != ""
        assert "Allah gave this kind" in nisar_cut.quote


