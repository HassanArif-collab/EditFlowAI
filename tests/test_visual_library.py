import os
import tempfile
import pytest
from pathlib import Path
from PIL import Image

from backend.services.visual_library_service import (
    LibraryFolder,
    VisualItem,
    VisualLibraryService,
)


@pytest.fixture
def temp_library_env(tmp_path):
    # Setup temporary base directory for visual library
    base_dir = tmp_path / "visual_library"
    service = VisualLibraryService(base_dir=base_dir)

    # Setup temporary raw folder with dummy images
    raw_dir = tmp_path / "raw_footage"
    raw_dir.mkdir()

    img1 = Image.new("RGB", (640, 360), color=(100, 150, 200))
    img1.save(str(raw_dir / "parking_area_broken.png"))

    img2 = Image.new("RGB", (360, 640), color=(50, 50, 50))
    img2.save(str(raw_dir / "drone_overhead_lot.jpg"))

    return service, raw_dir


class TestVisualLibraryService:
    def test_add_and_list_folders(self, temp_library_env):
        service, raw_dir = temp_library_env
        res = service.add_folder(str(raw_dir), auto_analyze=False)

        assert res["success"] is True
        folders = service.list_folders()
        assert len(folders) == 1
        assert folders[0]["path"] == str(raw_dir)

    def test_analyze_folder_indexes_images_and_thumbs(self, temp_library_env):
        service, raw_dir = temp_library_env
        service.add_folder(str(raw_dir), auto_analyze=False)

        stats = service.analyze_folder(str(raw_dir))
        assert stats["success"] is True
        assert stats["indexed_count"] == 2

        items = service.query_items()
        assert len(items) == 2

        # Check aspect ratio detection
        items_by_stem = {it["stem"]: it for it in items}
        assert items_by_stem["parking_area_broken"]["aspect_ratio"] == "16:9"
        assert items_by_stem["drone_overhead_lot"]["aspect_ratio"] == "9:16"

    def test_remove_folder(self, temp_library_env):
        service, raw_dir = temp_library_env
        service.add_folder(str(raw_dir), auto_analyze=True)
        assert len(service.list_folders()) == 1
        assert len(service.query_items()) == 2

        res = service.remove_folder(str(raw_dir))
        assert res["success"] is True
        assert len(service.list_folders()) == 0
        assert len(service.query_items()) == 0

    def test_query_filter(self, temp_library_env):
        service, raw_dir = temp_library_env
        service.add_folder(str(raw_dir), auto_analyze=True)

        # Search by keyword
        res_drone = service.query_items(query="drone")
        assert len(res_drone) == 1
        assert res_drone[0]["stem"] == "drone_overhead_lot"

        # Search by aspect ratio
        res_vertical = service.query_items(aspect_ratio="9:16")
        assert len(res_vertical) == 1
        assert res_vertical[0]["stem"] == "drone_overhead_lot"
