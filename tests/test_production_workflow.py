import hashlib
import json
from pathlib import Path

import pytest

from backend.services.media_framing import calculate_framing
from backend.services.media_resolver import MediaItem
from backend.services.script_assembly_service import ScriptAssemblyService
import backend.services.script_assembly_service as assembly_module


@pytest.fixture
def compiler(tmp_path, monkeypatch):
    from backend.services.media_resolver import MediaResolverService
    resolver = MediaResolverService()
    resolver.root_dir = str(tmp_path)
    resolver._cache_dir = tmp_path / 'resolver-cache'
    monkeypatch.setattr(assembly_module, "media_resolver", resolver)
    monkeypatch.setattr(assembly_module, "framing_for_file", lambda *args: {})
    return ScriptAssemblyService(), resolver, tmp_path


def source(resolver, root, name, kind="video", duration=90):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"test media")
    item = MediaItem(stem=path.stem.upper(), name=path.name, path=str(path), file_type=kind, ext=path.suffix, duration=duration)
    resolver._media_by_path[str(path).lower()] = item
    return item


def script(reference="C1316.MP4", source_range="00:10 → 00:15"):
    return f"""# Five second cut
| # | Person | Source file | Cut IN → OUT | Yields | Timeline | Quote |
|---|---|---|---|---|---|---|
| 1 | Speaker | {reference} | {source_range} | 5s | 0:00–0:05 | Exact spoken words here. |
"""


def test_exact_range_never_expands_to_transcript_segment(compiler, monkeypatch):
    svc, resolver, root = compiler
    source(resolver, root, "C1316.MP4")
    monkeypatch.setattr(svc, "_snap_to_complete_sentences", lambda *a, **kw: pytest.fail("Curated ranges must not be rewritten"))
    plan = svc.compile_script_to_plan(script(), auto_broll=False)
    assert plan.validation["valid"]
    assert (plan.cuts[0].source_in, plan.cuts[0].source_out) == (10, 15)
    assert plan.summary["total_duration"] == 5
    assert plan.cuts[0].quote == "Exact spoken words here."


def test_missing_source_preserves_review_without_substitution(compiler):
    svc, resolver, root = compiler
    source(resolver, root, "UNRELATED.MP4")
    plan = svc.compile_script_to_plan(script(), auto_broll=False)
    assert not plan.validation["valid"]
    assert plan.cuts[0].source_file == ""
    assert plan.summary["total_duration"] == 5
    assert svc.plan_to_edl_ops(plan) == []


def test_ambiguous_stems_require_full_path(compiler):
    svc, resolver, root = compiler
    source(resolver, root, "day1/C1316.MP4")
    chosen = source(resolver, root, "day2/C1316.MP4")
    plan = svc.compile_script_to_plan(script(), auto_broll=False)
    assert "Ambiguous" in plan.cuts[0].resolution_error
    exact = svc.compile_script_to_plan(script(chosen.path), auto_broll=False)
    assert exact.validation["valid"]
    assert exact.cuts[0].source_file == chosen.path


def test_catalogue_json_cannot_become_a_video(compiler):
    svc, resolver, root = compiler
    source(resolver, root, "catalogue.json", "transcript")
    plan = svc.compile_script_to_plan(script("catalogue.json"), auto_broll=False)
    assert not plan.validation["valid"]
    assert svc.plan_to_edl_ops(plan) == []


def test_explicit_workspace_source_map_is_used(compiler):
    svc,resolver,root=compiler
    media=source(resolver,root,"recording.mp4")
    content=script("Finals/short.mp4")+f"\n**Source File Paths on Workspace:**\n- `short.mp4` → `{media.path}`\n"
    # Windows workspace paths are the supported format used by these scripts.
    if not Path(media.path).drive:
        pytest.skip('Windows workspace mapping')
    plan=svc.compile_script_to_plan(content,auto_broll=False)
    assert plan.validation['valid'] and plan.cuts[0].source_file==media.path


def test_alternative_tables_are_selectable(compiler):
    svc, resolver, root = compiler
    source(resolver, root, "C1316.MP4")
    content = script() + "\n## Alternative 3 seconds\n" + script(source_range="00:20 → 00:23").split('\n', 1)[1].replace("0:00–0:05", "0:00–0:03")
    plan = svc.compile_script_to_plan(content, auto_broll=False, variant_id="variant-2")
    assert len(plan.variants) == 2
    assert plan.summary["total_duration"] == 3
    assert plan.cuts[0].source_in == 20


def test_agent_package_links_narration_and_blocks_stale_script(compiler):
    svc, resolver, root = compiler
    source(resolver, root, "narration.wav", "audio")
    md = root / "campaign.md"
    md.write_text("# Campaign\nApproved narration.\n", encoding="utf-8")
    package = {"schema_version": 1, "project_folder": str(root), "brand": "Client A", "title": "Campaign",
               "script_revision": hashlib.sha256(md.read_text().encode()).hexdigest(), "variants": [{"id": "primary", "cuts": [
                   {"kind": "generated_narration", "source_file": "narration.wav", "source_in": 0, "source_out": 5, "quote": "Approved narration."}]}]}
    md.with_suffix(".editflow.json").write_text(json.dumps(package), encoding="utf-8")
    plan = svc.compile_script_to_plan(str(md), project_folder=str(root), brand="Client A", auto_broll=False)
    assert plan.validation["valid"]
    assert plan.cuts[0].video_track == -1
    assert plan.cuts[0].audio_track == 1
    assert plan.cuts[0].kind == "generated_narration"
    md.write_text("Revised narration", encoding="utf-8")
    stale = svc.compile_script_to_plan(str(md), project_folder=str(root), brand="Client A", auto_broll=False)
    assert not stale.validation["valid"]
    assert svc.plan_to_edl_ops(stale) == []
    assert all(c.quote != "Approved narration." for c in stale.cuts)
    assert any("Revised narration" in c.quote for c in stale.cuts)


def test_stale_sidecar_cannot_override_new_valid_markdown_ranges(compiler):
    svc,resolver,root=compiler
    media=source(resolver,root,'C1316.MP4')
    md=root/'changed.md'
    original=script(media.path)
    md.write_text(original,encoding='utf-8')
    package={'schema_version':1,'project_folder':str(root),'brand':'Client A','title':'OLD TITLE',
             'script_revision':hashlib.sha256(original.encode()).hexdigest(),'variants':[{'id':'primary','cuts':[
                 {'source_file':media.path,'source_in':10,'source_out':15,'quote':'OLD WORDS'}]}]}
    md.with_suffix('.editflow.json').write_text(json.dumps(package),encoding='utf-8')
    md.write_text(script(media.path,'00:20 → 00:23').replace('Exact spoken words here.','NEW CURRENT WORDS'),encoding='utf-8')
    plan=svc.compile_script_to_plan(str(md),project_folder=str(root),brand='Client A',auto_broll=False)
    assert plan.validation['valid']
    assert plan.cuts[0].source_in==20 and plan.cuts[0].source_out==23
    assert plan.cuts[0].quote=='NEW CURRENT WORDS'
    assert plan.title!='OLD TITLE'


@pytest.mark.parametrize("source,output,mode,expected", [
    ((2160,3840),(1080,1920),"fill",50),
    ((478,850),(1080,1920),"fill",1080/478*100),
    ((1920,1080),(1080,1920),"fill",1920/1080*100),
    ((752,1344),(1080,1920),"contain",1920/1344*100),
])
def test_framing_is_proportional(source, output, mode, expected):
    result = calculate_framing(*source, *output, mode, zoom=1.08)
    assert result["fit_scale"] == pytest.approx(expected)
    assert result["zoom"] == 1.08


def test_rotated_source_and_focal_position():
    rotated = calculate_framing(3840,2160,1080,1920, rotation=90)
    assert rotated["fit_scale"] == pytest.approx(50)
    focal = calculate_framing(3840,2160,1080,1920, focal_point=[0.75,0.5])
    assert focal["position"][0] < 0.5
