import json
from pathlib import Path

from backend.services.visual_library_service import VisualItem, VisualLibraryService


def item(path, key, **extra):
    return VisualItem(id=key, path=str(path), filename=path.name, stem=path.stem, folder_path=str(path.parent),
                      file_type="video", category="pure_broll", duration=10, **extra)


def test_brand_filters_follow_registered_folder_and_never_include_previews(tmp_path):
    service = VisualLibraryService(tmp_path / "index")
    a, b = tmp_path / "A", tmp_path / "B"
    a.mkdir(); b.mkdir()
    service.add_folder(str(a), brand="Client A", auto_analyze=False)
    service.add_folder(str(b), brand="Client B", auto_analyze=False)
    service._items = {"a":item(a/"C0001.mp4","a"), "b":item(b/"C0001.mp4","b"),
                      "preview":item(a/"frame_samples"/"frame.jpg","preview")}
    assert [row["id"] for row in service.query_items(brand="Client A")] == ["a"]
    assert [row["id"] for row in service.query_items(brand="Client B")] == ["b"]


def test_verified_curated_metadata_is_restored_and_persisted(tmp_path):
    base = tmp_path / "index"
    service = VisualLibraryService(base)
    footage = tmp_path / "footage"
    footage.mkdir()
    service.add_folder(str(footage),brand="Client A",auto_analyze=False)
    current = item(footage/"C0001.mp4","a", tags=["wrong", "parking"])
    service._items[current.id] = current
    verified = current.to_dict()
    verified.update(verified=True,description="Bookshelf in a classroom",setting="classroom", concepts=["quran_madrasah_students"],tags=["books", "classroom"])
    (base/"visual_library_manifest.json").write_text(json.dumps({"items":[verified]}),encoding="utf-8")
    service.refresh_metadata(force=True)
    service._save_index()
    restored = VisualLibraryService(base)
    row = restored.query_items(brand="Client A")[0]
    assert row["verified"] and row["description"] == "Bookshelf in a classroom"
    assert row["tags"] == ["books", "classroom"]
    assert restored.query_items(query="parking",brand="Client A") == []


def test_no_relevant_visual_leaves_the_speaker_visible(monkeypatch):
    from backend.services.broll_placement_engine import BrollPlacementEngine
    from backend.services.script_assembly_service import AssembledCut
    from backend.services.visual_library_service import visual_library_service
    unrelated = item(Path("D:/clips/microwave.mp4"),"kitchen",description="Microwave ovens in a kitchen",setting="kitchen",tags=["kitchen", "microwave"],verified=True)
    monkeypatch.setattr(visual_library_service,"query_items",lambda **kw:[unrelated.to_dict()])
    cut = AssembledCut(1,1,"Speaker","D:/speaker.mp4","speaker",0,8,8,0,8,quote="Heavy snow makes winter drop-offs difficult for elderly people.")
    assert BrollPlacementEngine.place_broll_for_plan([cut],brand="Client A") == []
