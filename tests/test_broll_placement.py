import pytest
from backend.services.broll_placement_engine import (
    BrollPlacementEngine,
    broll_placement_engine,
)
from backend.services.script_assembly_service import AssembledCut
from backend.services.visual_library_service import (
    VisualItem,
    VisualLibraryService,
    visual_library_service,
)


@pytest.fixture
def populated_library(tmp_path):
    service = VisualLibraryService(base_dir=tmp_path / "vl")
    service.initialize()

    # Add mock items to visual library
    item1 = VisualItem(
        id="item1",
        path="D:/footage/parking_lot_drone.mp4",
        filename="parking_lot_drone.mp4",
        stem="parking_lot_drone",
        folder_path="D:/footage",
        file_type="video",
        category="pure_broll",
        duration=10.0,
        aspect_ratio="9:16",
        quality_score=850.0,
        recommended_in=2.0,
        recommended_out=6.0,
        recommended_duration=4.0,
        tags=["parking", "drone", "lot", "broll", "aerial"],
    )

    item2 = VisualItem(
        id="item2",
        path="D:/footage/cracked_asphalt_ground.mp4",
        filename="cracked_asphalt_ground.mp4",
        stem="cracked_asphalt_ground",
        folder_path="D:/footage",
        file_type="video",
        category="pure_broll",
        duration=8.0,
        aspect_ratio="9:16",
        quality_score=720.0,
        recommended_in=1.0,
        recommended_out=5.0,
        recommended_duration=4.0,
        tags=["asphalt", "cracked", "mud", "broken", "ground"],
    )

    service._items[item1.id] = item1
    service._items[item2.id] = item2
    return service


class TestBrollPlacementEngine:
    def test_placement_matches_dialogue_and_cue(self, populated_library, monkeypatch):
        monkeypatch.setattr(
            "backend.services.broll_placement_engine.visual_library_service",
            populated_library,
        )

        cuts = [
            AssembledCut(
                cut_index=0,
                beat_index=0,
                speaker="Hafiz",
                source_file="D:/videos/speaker.mp4",
                source_stem="speaker",
                source_in=0.0,
                source_out=5.0,
                duration=5.0,
                timeline_start=0.0,
                timeline_end=5.0,
                quote="currently the situation of our parking lot is actually very bad",
                marker_comment="drone aerial view of broken lot",
            ),
            AssembledCut(
                cut_index=1,
                beat_index=1,
                speaker="Hafiz",
                source_file="D:/videos/speaker.mp4",
                source_stem="speaker",
                source_in=5.0,
                source_out=10.0,
                duration=5.0,
                timeline_start=5.0,
                timeline_end=10.0,
                quote="see the mud and cracked asphalt right here",
                marker_comment="broken ground detail",
            ),
        ]

        placements = BrollPlacementEngine.place_broll_for_plan(
            cuts, aspect_ratio="9:16", pacing_style="editorial_insert"
        )

        assert len(placements) >= 2
        p0, p1 = placements[0], placements[1]

        # First cut should match parking lot drone
        assert p0.source_file == "D:/footage/parking_lot_drone.mp4"
        assert p0.track == 1  # Track V2
        assert p0.timeline_start == 1.0  # Face anchor delay

        # Second placement should match cracked asphalt (diversity & topic alignment)
        assert p1.source_file == "D:/footage/cracked_asphalt_ground.mp4"
        assert p1.timeline_start == 2.8
