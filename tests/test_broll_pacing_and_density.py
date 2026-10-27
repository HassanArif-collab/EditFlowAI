"""
Tests for EditFlow AI - High-Density B-Roll Placement, Pacing Presets, and Zero-Repetition.
"""
import pytest
from unittest.mock import MagicMock, patch

from backend.services.broll_placement_engine import BrollPlacementEngine, PACING_PRESETS
from backend.services.script_assembly_service import AssembledCut


@pytest.fixture
def sample_dialogue_cuts():
    """Create a realistic 45-second 6-cut sequence."""
    return [
        AssembledCut(
            cut_index=1,
            beat_index=1,
            speaker="Muhammad Hafiz Abdullah",
            source_file="D:/video1.mp4",
            source_stem="C1321 21",
            source_in=19.5,
            source_out=27.0,
            duration=7.5,
            timeline_start=0.0,
            timeline_end=7.5,
            quote="It's good news we grew out of our current parking lot. It only accommodates around 15 cars.",
            caption_text="Grew out of our current parking lot.",
        ),
        AssembledCut(
            cut_index=2,
            beat_index=2,
            speaker="Muhammad Hafiz Abdullah",
            source_file="D:/video2.mp4",
            source_stem="Video_B2",
            source_in=0.0,
            source_out=10.0,
            duration=10.0,
            timeline_start=7.5,
            timeline_end=17.5,
            quote="As you can see, currently the situation of our parking lot is actually very bad with damaged asphalt and broken ground.",
            caption_text="Situation of our parking lot is very bad.",
        ),
        AssembledCut(
            cut_index=3,
            beat_index=3,
            speaker="Muhammad Hafiz Abdullah",
            source_file="D:/video3.mp4",
            source_stem="Video_B2",
            source_in=34.0,
            source_out=42.0,
            duration=8.0,
            timeline_start=17.5,
            timeline_end=25.5,
            quote="The rest of them are parking like this on the grass on this side and on the driveway.",
            caption_text="Parking on the grass and driveway.",
        ),
        AssembledCut(
            cut_index=4,
            beat_index=4,
            speaker="Youth Speaker",
            source_file="D:/video4.mp4",
            source_stem="WhatsApp_Video",
            source_in=35.0,
            source_out=43.0,
            duration=8.0,
            timeline_start=25.5,
            timeline_end=33.5,
            quote="During winter we have heavy snowfall and cars cannot come inside at all.",
            caption_text="Heavy winter snowfall blocks cars.",
        ),
        AssembledCut(
            cut_index=5,
            beat_index=5,
            speaker="Muhammad Hafiz Abdullah",
            source_file="D:/video5.mp4",
            source_stem="C1325 25",
            source_in=2.7,
            source_out=9.7,
            duration=7.0,
            timeline_start=33.5,
            timeline_end=40.5,
            quote="To establish our parking lot of 77 parking spots, we have a concrete expansion plan.",
            caption_text="77 parking spots expansion plan.",
        ),
        AssembledCut(
            cut_index=6,
            beat_index=6,
            speaker="Muhammad Hafiz Abdullah",
            source_file="D:/video6.mp4",
            source_stem="1 v2",
            source_in=0.0,
            source_out=4.5,
            duration=4.5,
            timeline_start=40.5,
            timeline_end=45.0,
            quote="So we urgently ask for your support to help us establish this safe place as soon as possible.",
            caption_text="Please help us establish this urgently.",
        ),
    ]


@pytest.fixture
def mock_visual_library():
    """Mock a 25-asset raw data visual library covering various concepts."""
    items = []
    # 8 parking problem video clips
    for i in range(1, 9):
        items.append({
            "id": f"p_{i}",
            "stem": f"C124{i}",
            "filename": f"C124{i} 4{i}.mp4",
            "path": f"D:/RAW/C124{i} 4{i}.mp4",
            "category": "pure_broll",
            "file_type": "video",
            "duration": 9.0,
            "recommended_in": 1.5,
            "recommended_out": 5.5,
            "quality_score": 500.0 + i * 15,
            "aspect_ratio": "9:16",
            "tags": ["parking", "lot", "ground", "broken", "asphalt", "broll"],
        })
    # 6 car overflow clips
    for i in range(1, 7):
        items.append({
            "id": f"c_{i}",
            "stem": f"C129{i}",
            "filename": f"C129{i} 9{i}.mp4",
            "path": f"D:/RAW/C129{i} 9{i}.mp4",
            "category": "pure_broll",
            "file_type": "video",
            "duration": 8.0,
            "recommended_in": 1.0,
            "recommended_out": 5.0,
            "quality_score": 600.0 + i * 10,
            "aspect_ratio": "9:16",
            "tags": ["cars", "vehicles", "grass", "driveway", "broll"],
        })
    # 4 winter/weather clips
    for i in range(1, 5):
        items.append({
            "id": f"w_{i}",
            "stem": f"C133{i}",
            "filename": f"C133{i} 3{i}.mp4",
            "path": f"D:/RAW/C133{i} 3{i}.mp4",
            "category": "pure_broll",
            "file_type": "video",
            "duration": 7.5,
            "recommended_in": 0.5,
            "recommended_out": 4.5,
            "quality_score": 450.0 + i * 20,
            "aspect_ratio": "9:16",
            "tags": ["winter", "snow", "weather", "cold", "broll"],
        })
    # 1 still architectural graphic
    items.append({
        "id": "still_1",
        "stem": "Parking_Built",
        "filename": "Parking area built.png",
        "path": "D:/RAW/Parking area built.png",
        "category": "still_graphic",
        "file_type": "image",
        "duration": 5.0,
        "recommended_in": 0.0,
        "recommended_out": 4.0,
        "quality_score": 2700.0, # High synthetic score
        "aspect_ratio": "9:16",
        "tags": ["parking", "built", "77", "plan", "blueprint", "graphic"],
    })
    return items


def test_high_density_editorial_placement(sample_dialogue_cuts, mock_visual_library):
    """Verify that Editorial pacing produces high density (>= 10 micro-visuals) across a 45s cut."""
    with patch("backend.services.visual_library_service.visual_library_service.query_items", return_value=mock_visual_library):
        placements = BrollPlacementEngine.place_broll_for_plan(
            sample_dialogue_cuts,
            aspect_ratio="9:16",
            pacing_style="editorial"
        )

        print(f"Total placements: {len(placements)}")
        assert len(placements) >= 10, f"Expected at least 10 micro-visuals in Editorial mode, got {len(placements)}"

        # Every cut from 1 to 5 should have received at least 2 micro-visuals
        for c in sample_dialogue_cuts[:5]:
            assert len(c.broll_placements) >= 2, f"Cut #{c.cut_index} should have >= 2 micro-visuals, got {len(c.broll_placements)}"


def test_high_density_dynamic_viral_placement(sample_dialogue_cuts, mock_visual_library):
    """Verify that Dynamic (viral) pacing produces even higher density (>= 14 micro-visuals)."""
    with patch("backend.services.visual_library_service.visual_library_service.query_items", return_value=mock_visual_library):
        placements = BrollPlacementEngine.place_broll_for_plan(
            sample_dialogue_cuts,
            aspect_ratio="9:16",
            pacing_style="dynamic"
        )

        assert len(placements) >= 14, f"Expected at least 14 micro-visuals in Dynamic mode, got {len(placements)}"


def test_zero_repetition_across_sequence(sample_dialogue_cuts, mock_visual_library):
    """Verify that NO visual clip repeats across the entire sequence."""
    with patch("backend.services.visual_library_service.visual_library_service.query_items", return_value=mock_visual_library):
        placements = BrollPlacementEngine.place_broll_for_plan(
            sample_dialogue_cuts,
            aspect_ratio="9:16",
            pacing_style="editorial"
        )

        used_files = [p.name for p in placements]
        unique_files = set(used_files)
        assert len(used_files) == len(unique_files), f"Visual repetition detected! Duplicates: {[f for f in unique_files if used_files.count(f) > 1]}"


def test_speaker_face_anchor_guarantee(sample_dialogue_cuts, mock_visual_library):
    """Verify that every cut establishes the speaker on Track V1 for >= 0.8s before first B-roll starts."""
    with patch("backend.services.visual_library_service.visual_library_service.query_items", return_value=mock_visual_library):
        placements = BrollPlacementEngine.place_broll_for_plan(
            sample_dialogue_cuts,
            aspect_ratio="9:16",
            pacing_style="editorial"
        )

        for cut in sample_dialogue_cuts:
            cut_brolls = [p for p in placements if p.cut_index == cut.cut_index]
            if cut_brolls:
                first_broll = cut_brolls[0]
                lead_time = first_broll.timeline_start - cut.timeline_start
                assert lead_time >= 0.79, f"Cut #{cut.cut_index} speaker face anchor violated! Lead time was {lead_time}s, expected >= 0.8s"


def test_concept_alignment(sample_dialogue_cuts, mock_visual_library):
    """Verify that cut 4 (winter) gets a winter clip, and cut 5 (77 spots plan) gets the blueprint."""
    with patch("backend.services.visual_library_service.visual_library_service.query_items", return_value=mock_visual_library):
        placements = BrollPlacementEngine.place_broll_for_plan(
            sample_dialogue_cuts,
            aspect_ratio="9:16",
            pacing_style="editorial"
        )

        cut4_brolls = [p for p in placements if p.cut_index == 4]
        # At least one B-roll on Cut 4 should be winter related (C133x)
        assert any("C133" in p.name for p in cut4_brolls), "Cut 4 (winter snow) should have matched a winter clip!"

        cut5_brolls = [p for p in placements if p.cut_index == 5]
        # Cut 5 mentions 77 spots plan, should match architectural blueprint
        assert any("Parking area built" in p.name for p in cut5_brolls), "Cut 5 (77 spots plan) should have matched Parking area built.png!"
