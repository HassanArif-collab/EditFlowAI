from types import SimpleNamespace
from backend.services.review_validation import validate_review
from backend.services.visual_library_service import VisualLibraryService


def test_changed_source_blocks_application(tmp_path):
    path = tmp_path / "graphic.png"
    path.write_bytes(b"original")
    stat = path.stat()
    plan = {"cuts":[{"source_file":str(path),"source_in":0,"source_out":3,"source_revision":f"{stat.st_size}:{stat.st_mtime_ns}"}]}
    assert validate_review(plan)["valid"]
    path.write_bytes(b"replacement graphic")
    assert not validate_review(plan)["valid"]


def test_missing_source_blocks_application(tmp_path):
    plan = {"broll_clips":[{"source_file":str(tmp_path/"missing.mp4"),"source_in":0,"source_out":3}]}
    assert not validate_review(plan)["valid"]


def test_generic_dialogue_does_not_select_unrelated_visual():
    from backend.services.broll_placement_engine import BrollPlacementEngine
    score = BrollPlacementEngine._score_candidate(
        {"stem":"microwave", "filename":"microwave.mp4", "category":"pure_broll", "tags":["kitchen"], "duration":10},
        ["donate", "today"], "", "Donate today", "general", "9:16", set(), None)
    assert score < 0


def test_reused_index_excludes_other_campaigns_and_talking_heads(tmp_path):
    root = tmp_path / "Brand"
    project = root / "2026-11-2 Campaign"
    shared = root / "Raw Data" / "Concrete"
    other = root / "2026-1-1 Old Campaign" / "Visuals"
    selected = project / "Visuals"
    rows = []
    for folder, name, category in ((shared,"concrete.mp4","broll"),(other,"old.mp4","broll"),(selected,"render.png","render"),(shared,"speaker.mp4","talking_head")):
        folder.mkdir(parents=True,exist_ok=True)
        path = folder/name;path.write_bytes(b"test")
        rows.append(SimpleNamespace(path=str(path),file_type="image" if name.endswith(".png") else "video",category=category,duration=0))
    service = VisualLibraryService(tmp_path / "index")
    count = service.reuse_media_index(SimpleNamespace(_media_by_path=dict(enumerate(rows))),"Brand",str(root),str(project))
    assert count == 2
    assert {i["filename"] for i in service.query_items(brand="Brand")} == {"concrete.mp4","render.png"}
