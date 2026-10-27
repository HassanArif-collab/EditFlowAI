"""
Tests for MediaResolverService and Media Resolver API routes.
Verifies stem normalization, legacy F: drive remapping, Person_Crossreference.md
parsing, audio-pair companions, fuzzy B-roll clustering, and REST endpoints.
"""
import os
import shutil
import tempfile
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.services.media_resolver import (
    MediaItem,
    MediaResolverService,
    SpeakerInfo,
    media_resolver,
)

SAMPLE_CROSSREFERENCE_MD = """# Person Cross-Reference — Master Speaker Identity & Footage Map
**Updated:** 2026-10-12

## 1. Verified Master Speaker Roster

| # | Speaker Name | Title / Community Role | Footage Eras & Files | Transcript Availability | Key Themes & Topics |
|---|-------------|------------------------|----------------------|-------------------------|---------------------|
| 1 | **Anees Ul Rehman** (Anees Bhai) | Community Leader / Project Committee | **March 2026:** Raw `6\\C6045.MP4`<br>**July 2026:** Raw `C4182.MP4`<br>**Sept 2026:** Raw `C5015.MP4`, `C5018.MP4` | Yes | Demolition complete |
| 2 | **Muhammad Nisar** (Nisar Sahib) | Fundraising Committee | **July 2026:** Finals `Nisar.mp4`<br>**Sept 2026:** Raw `C5024.MP4`, `C5025.MP4` | Yes | Cement in full swing |
| 3 | **M. Abdul Majeed** | Architect, Jamia Masjid Chicago | **March 2026:** `9 v5 abdul majeed.mp4`<br>**July 2026:** `C4181.MP4`<br>**Sept 2026:** `C5064.MP4` | Yes | Over 20 years waiting |
| 4 | **Syed Iqbal** | Civil Structure Engineer | **March 2026:** Raw `C6019.MP4`, `C6020.MP4` | Yes | 200+ structural drawings |
| 11 | **Abdullah** | Main Presenter / Host | **March 2026:** `C6041`<br>**Sept 2026:** Raw `C5031.MP4`, `C5032.MP4` | Yes | On-site walkthrough |
"""


@pytest.fixture
def temp_project_dir():
    """Create a temporary mock project folder structure mimicking Jamia Masjid Chicago."""
    temp_dir = tempfile.mkdtemp(prefix="editflow_test_media_")
    root = Path(temp_dir)

    # Subfolders
    (root / "AI Workflow").mkdir(parents=True)
    (root / "Raw Data" / "myairbridge").mkdir(parents=True)
    (root / "Voice" / "1 Abdullah").mkdir(parents=True)
    (root / "Raw_Transcriptions").mkdir(parents=True)
    (root / "Concrete Pouring").mkdir(parents=True)
    (root / "2026-4-4 Phase 2" / "Cassans").mkdir(parents=True)  # Notice typo
    (root / "Visuals").mkdir(parents=True)

    # Media files
    (root / "Raw Data" / "myairbridge" / "C5032.MP4").write_text("fake video")
    (root / "Raw Data" / "myairbridge" / "C5024.MP4").write_text("fake video 2")
    (root / "Raw Data" / "myairbridge" / "C6019.MP4").write_text("fake video 3")
    (root / "Voice" / "1 Abdullah" / "01 Abdullah-enhanced-v2.mp3").write_text("fake enhanced audio")
    (root / "Voice" / "1 Abdullah" / "01 Abdullah.mp3").write_text("fake raw audio")
    (root / "Raw_Transcriptions" / "C5032.json").write_text('{"text": "Caissons in ground"}')
    (root / "Raw_Transcriptions" / "C5032.srt").write_text("1\n00:00:00,000 --> 00:00:05,000\nCaissons")
    (root / "Concrete Pouring" / "1.mp4").write_text("fake concrete pouring broll")
    (root / "2026-4-4 Phase 2" / "Cassans" / "DJI_0003.MP4").write_text("fake drone broll")
    (root / "Visuals" / "3D Mosque Render.png").write_text("fake render still")

    # Person_Crossreference.md
    (root / "AI Workflow" / "Person_Crossreference.md").write_text(SAMPLE_CROSSREFERENCE_MD, encoding="utf-8")

    yield temp_dir

    shutil.rmtree(temp_dir, ignore_errors=True)


class TestMediaResolverService:
    def test_normalize_stem(self):
        svc = MediaResolverService()
        assert svc.normalize_stem("C5032.MP4") == "C5032"
        assert svc.normalize_stem("01 Abdullah-enhanced-v2.mp3") == "01 ABDULLAH"
        assert svc.normalize_stem("Raw_Transcriptions\\C5032.MP4") == "C5032"
        assert svc.normalize_stem("DJI_0027 Enhanced.MP4") == "DJI_0027"

    def test_remap_legacy_path(self):
        svc = MediaResolverService()
        p = "F:/MARKETING/Jamia Masjid Chicago/Raw Data/C5032.MP4"
        remapped = svc.remap_legacy_path(p)
        assert "/" not in remapped
        if os.path.exists("D:\\MARKETING"):
            assert remapped.startswith("D:\\MARKETING\\")

    def test_parse_person_crossreference(self):
        svc = MediaResolverService()
        svc._parse_person_crossreference_markdown(SAMPLE_CROSSREFERENCE_MD)

        # Check Anees Ul Rehman
        anees = svc.get_speaker("Anees Ul Rehman")
        assert anees is not None
        assert anees.id == 1
        assert "Anees Bhai" in anees.aliases
        assert "C6045" in anees.clip_stems
        assert "C5015" in anees.clip_stems

        # Check alias lookup
        assert svc.get_speaker("Anees Bhai") == anees

        # Check clip stem to speaker lookup
        sp_c5024 = svc.get_speaker("C5024")
        assert sp_c5024 is not None
        assert sp_c5024.name == "Muhammad Nisar"

        sp_c6019 = svc.get_speaker("C6019")
        assert sp_c6019 is not None
        assert sp_c6019.name == "Syed Iqbal"

        # Check Abdullah single voice rule
        abdullah = svc.get_speaker("Abdullah")
        assert abdullah is not None
        assert abdullah.single_voice_rule is True

    def test_parse_entity_format_crossreference(self):
        """Verify format with '| Person | Files | Evidence |' used in modern projects."""
        sample_raf = """# Person Cross-Reference — RAF
| Person | Files | Evidence & Voice Characteristics |
|--------|-------|----------------------------------|
| **Muhammad Hafiz Abdullah** — Secretary RAF, VP Al Rahman Academy | C1308 08, C1310 10, C1321 21<br>• `Video A1.mp4` | Verified |
| **Separate Senior Speaker (Elder)** (NOT Hafiz Abdullah) | C1307 07 (565s senior interview) | Senior elder |
| **Youth / Community Speaker** (New) | WhatsApp Video 2026-10-20 at 12.32.12 AM.mp4 | Youth |
"""
        svc = MediaResolverService()
        svc._parse_person_crossreference_markdown(sample_raf)

        hafiz = svc.get_speaker("Muhammad Hafiz Abdullah")
        assert hafiz is not None
        assert hafiz.title == "Secretary RAF, VP Al Rahman Academy"
        assert "C1308" in hafiz.clip_stems
        assert "C1321 21" in hafiz.clip_stems
        assert "VIDEO A1" in hafiz.clip_stems or "Video A1" in hafiz.clip_stems
        assert hafiz.single_voice_rule is True

        senior = svc.get_speaker("Separate Senior Speaker")
        assert senior is not None
        assert "C1307" in senior.clip_stems

        youth = svc.get_speaker("Youth / Community Speaker")
        assert youth is not None

    def test_space_underscore_resilient_matching(self, temp_project_dir):
        """Verify C1321_21 matches C1321 21.mp4 and does not match 1.mp4."""
        svc = MediaResolverService(root_dir=temp_project_dir)
        # Create C1321 21.mp4 inside temp dir
        c1321_file = Path(temp_project_dir) / "Raw Data" / "myairbridge" / "C1321 21.mp4"
        c1321_file.write_text("c1321 content")
        svc.index_directory(temp_project_dir, force=True)

        # Query with underscore
        resolved = svc.resolve_media("C1321_21")
        assert resolved is not None
        assert resolved.name == "C1321 21.mp4"
        assert resolved.name != "1.mp4"

    def test_index_directory_and_resolution(self, temp_project_dir):
        svc = MediaResolverService(root_dir=temp_project_dir)
        stats = svc.index_directory(temp_project_dir, force=True)

        assert stats["success"] is True
        assert stats["total_items"] >= 9
        assert stats["verified_speakers"] == 5

        # 1. Resolve stem to real video file
        item_c5032 = svc.resolve_media("C5032")
        assert item_c5032 is not None
        assert item_c5032.name == "C5032.MP4"
        assert item_c5032.file_type == "video"
        assert os.path.exists(item_c5032.path)

        # 2. Resolve virtual script path "Raw_Transcriptions\C5032.MP4"
        item_from_script = svc.resolve_media("Raw_Transcriptions\\C5032.MP4")
        assert item_from_script is not None
        assert item_from_script.name == "C5032.MP4"

        # 3. Resolve audio pair (companion files)
        pair = svc.resolve_audio_pair("C5032")
        assert pair.video_item is not None
        assert pair.video_item.name == "C5032.MP4"
        assert pair.transcript_item is not None
        assert "C5032" in pair.transcript_item.name
        assert pair.speaker == "Abdullah"

        # 4. Fuzzy B-roll search: Concrete
        broll_concrete = svc.find_broll("Concrete trucks pouring foundation", limit=3)
        assert len(broll_concrete) > 0
        assert any("1.mp4" in b["path"] for b in broll_concrete)
        assert any(b["cluster"] == "concrete_trucks" for b in broll_concrete)

        # 5. Fuzzy B-roll search: Caissons (handles typo 'cassans' in folder)
        broll_caissons = svc.find_broll("74 caissons drilled deep into the ground", limit=3)
        assert len(broll_caissons) > 0
        assert any("DJI_0003.MP4" in b["path"] for b in broll_caissons)
        assert any(b["cluster"] == "caissons" for b in broll_caissons)

        # 6. Fuzzy B-roll search: 3D Render
        broll_render = svc.find_broll("3D render of completed mosque", limit=3)
        assert len(broll_render) > 0
        assert any("3D Mosque Render.png" in b["path"] for b in broll_render)


class TestMediaResolverAPI:
    def test_api_endpoints(self, temp_project_dir):
        client = TestClient(app)

        # Index via API
        idx_resp = client.post("/api/media-resolver/index", json={"root_dir": temp_project_dir, "force": True})
        assert idx_resp.status_code == 200
        data = idx_resp.json()
        assert data["success"] is True
        assert data["total_items"] >= 9

        # Stats
        stats_resp = client.get("/api/media-resolver/stats")
        assert stats_resp.status_code == 200
        assert stats_resp.json()["total_items"] >= 9

        # Resolve stem
        res_resp = client.get("/api/media-resolver/resolve?query=C5032")
        assert res_resp.status_code == 200
        assert res_resp.json()["item"]["name"] == "C5032.MP4"

        # Audio pair
        pair_resp = client.get("/api/media-resolver/pair?query=C5032")
        assert pair_resp.status_code == 200
        pair_data = pair_resp.json()["pair"]
        assert pair_data["video_item"]["name"] == "C5032.MP4"
        assert pair_data["speaker"] == "Abdullah"

        # B-roll search
        broll_resp = client.get("/api/media-resolver/broll?cue=concrete+trucks+pouring")
        assert broll_resp.status_code == 200
        matches = broll_resp.json()["matches"]
        assert len(matches) > 0

        # Speakers list
        sp_resp = client.get("/api/media-resolver/speakers")
        assert sp_resp.status_code == 200
        speakers = sp_resp.json()["speakers"]
        assert len(speakers) == 5
        names = [s["name"] for s in speakers]
        assert "Anees Ul Rehman" in names
        assert "Muhammad Nisar" in names
        assert "Abdullah" in names

        # 404 for nonexistent stem
        res_404 = client.get("/api/media-resolver/resolve?query=NONEXISTENT_STEM_9999")
        assert res_404.status_code == 404
