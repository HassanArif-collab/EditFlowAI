"""Scripts follow the edit's project, independently of shared brand footage."""
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from backend.services import project_scripts as library
from backend.routes import script_assembly_routes as routes


@pytest.fixture
def projects(tmp_path, monkeypatch):
    brands = tmp_path / "brands"
    brand = brands / "Brand A"
    first = brand / "2026-10-2 First edit"
    second = brand / "2026-10-30 Second edit"
    for project in (first, second):
        (project / "Finals").mkdir(parents=True)
    legacy = brand / "AI Automation" / "Scripts_15_30_45" / "Mix"
    legacy.mkdir(parents=True)
    (legacy / "Other campaign.md").write_text("# Legacy", encoding="utf-8")
    monkeypatch.setattr(library, "get_settings", lambda: SimpleNamespace(BRANDS_ROOT=brands))
    return SimpleNamespace(brands=brands, brand=brand, first=first, second=second, legacy=legacy)


def add_script(project, name="Script.md"):
    path = project / "Scripts" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("# Script\nThe actual dialogue.", encoding="utf-8")
    return path


def test_premiere_finals_resolves_to_own_dated_project(projects):
    saved = projects.first / "Finals" / "Edit.prproj"
    saved.touch()
    assert library.resolve_project_folder(saved) == projects.first
    assert library.resolve_project_folder(saved.parent) == projects.first


def test_empty_project_does_not_borrow_shared_or_sibling_scripts(projects):
    add_script(projects.first)
    result = library.list_project_scripts(projects.second / "Finals")
    assert result["scripts"] == []
    assert Path(result["project_folder"]) == projects.second
    assert Path(result["scripts_folder"]) == projects.second / "Scripts"


def test_script_subfolders_preserve_categories_and_exclude_previews(projects):
    script = add_script(projects.first, "Speaker/Script.MD")
    add_script(projects.first, "README.md")
    add_script(projects.first, "AGENTS.md")
    add_script(projects.first, "frame_samples/Preview.md")
    (projects.first / "Visuals").mkdir()
    (projects.first / "Visuals" / "Graphics Manifest.md").write_text("# Metadata")
    result = library.list_project_scripts(projects.first)
    assert [s["full_path"] for s in result["scripts"]] == [str(script)]
    assert result["scripts"][0]["category"] == "Speaker"
    assert Path(result["brand_root"]) == projects.brand


def test_existing_root_scripts_are_visible_without_scanning_other_folders(projects):
    path = projects.first / "Script at root.md"
    path.write_text("# Script")
    assert library.list_project_scripts(projects.first)["scripts"][0]["full_path"] == str(path)


def test_legacy_library_is_available_only_when_explicitly_selected(projects):
    result = library.list_project_scripts(projects.legacy.parent)
    assert result["total"] == 1
    assert result["scripts"][0]["name"] == "Other campaign.md"
    assert library.list_project_scripts(projects.brand)["total"] == 0


def test_projects_sort_by_calendar_date_and_stay_within_brand(projects):
    add_script(projects.first)
    other = projects.brands / "Brand B" / "2026-10-31 Other client"
    other.mkdir(parents=True)
    result = library.list_brand_projects("Brand A")
    assert [p["path"] for p in result["projects"]] == [str(projects.second), str(projects.first)]
    assert result["projects"][1]["script_count"] == 1
    with pytest.raises(ValueError):
        library.list_brand_projects("../Brand B")


def test_non_padded_dates_and_existing_double_dash_names():
    assert library.project_date("2026--5-11 Posts") == "2026-05-11"
    assert library.project_date("2026-2-30 Invalid") == ""


def test_prepare_creates_scripts_folder_inside_project(projects):
    result = library.ensure_scripts_folder(projects.second / "Finals")
    assert Path(result["scripts_folder"]) == projects.second / "Scripts"
    assert (projects.second / "Scripts").is_dir()
    assert not (projects.second / "Finals" / "Scripts").exists()


def test_missing_explicit_project_does_not_fall_back_to_resolver(projects, monkeypatch):
    monkeypatch.setattr(routes.media_resolver, "root_dir", str(projects.legacy.parent))
    app = FastAPI()
    app.include_router(routes.router, prefix="/api")
    client = TestClient(app)
    response = client.get("/api/script-assembly/scripts", params={"folder_path": str(projects.brand / "Missing")})
    assert response.status_code == 404


def test_compile_refuses_script_from_another_project(projects):
    script = add_script(projects.first)
    request = routes.CompileScriptRequest(script_path=str(script), project_folder=str(projects.second))
    with pytest.raises(HTTPException) as error:
        routes._resolve_script_input(request)
    assert error.value.status_code == 400


def test_filename_resolution_is_exact_scoped_and_detects_duplicates(projects):
    first = add_script(projects.first, "Script 01.md")
    add_script(projects.second, "Script 01.md")
    request = routes.CompileScriptRequest(script_filename="script 01.MD", project_folder=str(projects.first))
    assert routes._resolve_script_input(request) == str(first)
    add_script(projects.first, "Alternatives/Script 01.md")
    with pytest.raises(HTTPException) as error:
        routes._resolve_script_input(request)
    assert error.value.status_code == 409


def test_compiler_can_use_shared_brand_footage_without_changing_script_project(projects, monkeypatch):
    script = add_script(projects.first)
    monkeypatch.setattr(routes.media_resolver, "root_dir", str(projects.second))
    calls = []
    monkeypatch.setattr(routes.media_resolver, "index_directory", lambda **kwargs: calls.append(kwargs))
    routes._prepare_media_resolver(str(script), str(projects.first))
    assert calls == [{"root_dir": str(projects.brand), "force": False}]


def test_explicit_legacy_assignment_lists_original_and_allows_project_compile(projects):
    original = projects.legacy / 'Script 53.md'
    original.write_text('# Script 53\nCurrent original text')
    library.link_existing_project_scripts(str(projects.second), [str(original)], apply=True)
    info = library.list_project_scripts(projects.second)
    assert info['total'] == 1
    assert info['scripts'][0]['full_path'] == str(original)
    assert info['scripts'][0]['category'] == 'Linked'
    assert not (projects.second / 'Scripts/Script 53.md').exists()
    request = routes.CompileScriptRequest(script_path=str(original), project_folder=str(projects.second))
    assert routes._resolve_script_input(request) == str(original)
    with pytest.raises(ValueError):
        library.link_existing_project_scripts(str(projects.first), [str(original)], apply=True)


def test_legacy_assignment_cannot_import_foreign_or_other_project_scripts(projects):
    original = add_script(projects.first)
    with pytest.raises(ValueError):
        library.link_existing_project_scripts(str(projects.second), [str(original)], apply=True)
    foreign = projects.brands / 'Brand B/Private.md'
    foreign.parent.mkdir(); foreign.write_text('# Other brand')
    with pytest.raises(ValueError):
        library.link_existing_project_scripts(str(projects.second), [str(foreign)], apply=True)


def test_script_list_refresh_never_indexes_or_changes_media_context(projects, monkeypatch):
    monkeypatch.setattr(routes, '_prepare_media_resolver', lambda *a: pytest.fail('Listing scripts must not index media'))
    result = routes.list_available_scripts(str(projects.first))
    assert result['total'] == 0
