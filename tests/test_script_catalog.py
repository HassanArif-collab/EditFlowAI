import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.services import project_scripts, script_catalog as catalog
from backend.services.script_sources import register_alias, revision


@pytest.fixture
def library(tmp_path, monkeypatch):
    root = tmp_path / 'brands'
    brand = root / 'Brand A'
    project = brand / '2026-11-2 Project'
    (project / 'Scripts').mkdir(parents=True)
    old = brand / 'AI Workflow' / 'Previous'
    old.mkdir(parents=True)
    (root / 'Brand B').mkdir()
    (brand / 'AI Workflow/brand.editflow.json').write_text(json.dumps({
        'brand': 'Brand A', 'script_library': {'previous_folders': ['AI Workflow/Previous']}}))
    monkeypatch.setattr(project_scripts, 'get_settings', lambda: SimpleNamespace(BRANDS_ROOT=root))
    monkeypatch.setattr(catalog, '_registry', lambda: tmp_path / 'aliases.json')
    return SimpleNamespace(root=root, brand=brand, project=project, old=old, registry=tmp_path / 'aliases.json')


def test_catalog_keeps_legacy_unassigned_and_does_not_copy(library):
    old = library.old / 'Script 54.md'
    old.write_text('# Unique donation hook\nLegacy words')
    current = library.project / 'Scripts/Script 55.md'
    current.write_text('# New script')
    result = catalog.list_script_catalog('Brand A', project_folder=str(library.project))
    assert result['total'] == 2
    legacy = next(row for row in result['scripts'] if row['name'] == old.name)
    assert legacy['project_folder'] is None and legacy['reference_only']
    assert list((library.project / 'Scripts').iterdir()) == [current]
    assert catalog.list_script_catalog('Brand B')['total'] == 0


def test_catalog_searches_dialogue_and_reads_current_text(library):
    old = library.old / 'Script 54.md'
    old.write_text('# Hook\nEvery dollar helps')
    assert catalog.list_script_catalog('Brand A', 'dollar')['total'] == 1
    first = catalog.read_catalog_script('Brand A', str(old))
    replacement = old.with_suffix('.tmp')
    replacement.write_text('# Changed hook\nNew words')
    replacement.replace(old)
    second = catalog.read_catalog_script('Brand A', str(old))
    assert second['revision'] != first['revision']
    assert 'New words' in second['content']
    assert catalog.list_script_catalog('Brand A', 'dollar')['total'] == 0


def test_registered_alias_is_one_owned_entry_not_two(library):
    old = library.old / 'Script 52.md'
    current = library.project / 'Scripts/Script 52.md'
    old.write_text('# Same script'); current.write_text('# Same script')
    register_alias(current, old, revision('# Same script'), library.registry)
    result = catalog.list_script_catalog('Brand A')
    assert result['total'] == 1
    assert result['scripts'][0]['project_folder'] == str(library.project)


def test_catalog_reconciles_registered_legacy_edits_and_surfaces_conflicts(library, monkeypatch):
    import backend.services.script_sources as sources
    monkeypatch.setattr(sources, '_registry', lambda path=None: Path(path) if path else library.registry)
    old = library.old / 'Script 51.md'
    current = library.project / 'Scripts/Script 51.md'
    old.write_text('# Baseline'); current.write_text('# Baseline')
    register_alias(current, old, revision('# Baseline'), library.registry)
    old.write_text('# New original hook')
    result = catalog.list_script_catalog('Brand A')
    assert result['scripts'][0]['title'] == 'New original hook'
    assert current.read_text() == '# New original hook'
    old.write_text('# Different old edit'); current.write_text('# Different project edit')
    assert catalog.list_script_catalog('Brand A')['scripts'][0]['conflict']
    with pytest.raises(sources.ScriptConflictError):
        catalog.read_catalog_script('Brand A', str(current))


def test_equal_content_independent_scripts_are_not_merged(library):
    for name in ('First.md', 'Second.md'):
        (library.old / name).write_text('# Same wording')
    assert catalog.list_script_catalog('Brand A')['total'] == 2


def test_cross_brand_profile_and_arbitrary_reference_reads_are_rejected(library):
    foreign = library.root / 'Brand B/Private.md'
    foreign.write_text('# Other client')
    with pytest.raises(ValueError):
        catalog.read_catalog_script('Brand A', str(foreign))
    profile = library.brand / 'AI Workflow/brand.editflow.json'
    profile.write_text(json.dumps({'script_library': {'previous_folders': ['../Brand B']}}))
    with pytest.raises(ValueError):
        catalog.list_script_catalog('Brand A')


def test_reference_api_is_brand_scoped_and_starts_no_media_jobs(library, monkeypatch):
    from backend.routes import script_assembly_routes as routes
    monkeypatch.setattr(routes, '_prepare_media_resolver', lambda *a: pytest.fail('Catalog must not index media'))
    old = library.old / 'Script.md'
    old.write_text('# Old hook')
    app = FastAPI(); app.include_router(routes.router, prefix='/api')
    client = TestClient(app)
    assert client.get('/api/script-assembly/script-catalog', params={'brand': 'Brand A'}).json()['total'] == 1
    assert client.get('/api/script-assembly/script-reference', params={'brand': 'Brand A', 'path': str(old)}).json()['content'] == '# Old hook'
    assert client.get('/api/script-assembly/script-reference', params={'brand': 'Brand B', 'path': str(old)}).status_code == 400


def test_project_context_keeps_output_separate_from_previous_script_references(library):
    from backend.services.brand_context import project_context
    (library.old / 'Script 54.md').write_text('# Prior work')
    context = project_context(str(library.project))
    assert context['scripts'] == []
    assert context['script_library']['total'] == 1
    assert context['paths']['scripts'] == str(library.project / 'Scripts')
    assert 'selected project' in context['script_output_rule']
