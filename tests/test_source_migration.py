import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.services.source_migration import migration_preview
from backend.services.source_registry import SourceRegistry
from backend.models.sqlite_registry import SQLiteRegistry


def test_migration_preview_keeps_mixed_roles_unassigned_and_never_changes_caches(tmp_path):
    raw = tmp_path / 'Raw Data'; raw.mkdir()
    one, two = raw / 'talker.mp4', raw / 'visual.mp4'
    one.write_bytes(b'Raw'); two.write_bytes(b'Visual')
    config = tmp_path / 'folders_config.json'
    config.write_text(json.dumps({'folders': [{'path': str(raw), 'brand': 'Brand A'}]}))
    index = tmp_path / 'library_index.json'
    index.write_text(json.dumps({'items': [{'id': 'one', 'path': str(one), 'category': 'talking_head'},
        {'id': 'two', 'path': str(two), 'category': 'pure_broll', 'verified': True, 'description': 'Human description'}]}))
    before = (config.read_bytes(), index.read_bytes(), one.read_bytes(), two.read_bytes())
    result = migration_preview(config, index, 'Brand A')
    assert result['mode'] == 'preview' and not result['applied']
    assert result['candidates'][0]['suggested_role'] is None
    assert result['candidates'][0]['mixed_content']
    assert result['summary']['verified_annotations_preserved'] == 1
    assert before == (config.read_bytes(), index.read_bytes(), one.read_bytes(), two.read_bytes())
    assert migration_preview(config, index, 'Brand B')['assets'] == []


def test_dependencies_distinguish_edited_sources_and_project_narration(tmp_path):
    config = tmp_path / 'config.json'; config.write_text('{"folders":[]}')
    index = tmp_path / 'index.json'; index.write_text('{"items":[]}')
    script = tmp_path / 'Script.md'
    script.write_text('# Script\nCurrent words', encoding='utf-8')
    package = {'script_revision': hashlib.sha256(script.read_text().encode()).hexdigest(), 'variants': [{'cuts': [
        {'source_file': str(tmp_path / 'Finals/edited.mp4'), 'kind': 'recorded_dialogue'},
        {'source_file': str(tmp_path / 'Voice/Generated/narration.wav'), 'kind': 'generated_narration'}]}]}
    script.with_suffix('.editflow.json').write_text(json.dumps(package))
    report = migration_preview(config, index, 'Brand A', [script])
    assert [row['status'] for row in report['dependencies']] == ['edited_source_needs_raw_replacement', 'project_asset']
    script.write_text('# Revised current script', encoding='utf-8')
    fresh = migration_preview(config, index, 'Brand A', [script])
    assert fresh['input_revision'] != report['input_revision']
    assert all(row['source'] != str(tmp_path / 'Finals/edited.mp4') for row in fresh['dependencies'])


def test_policy_endpoints_are_preview_only_and_do_not_initialize_the_visual_library(tmp_path, monkeypatch):
    from backend.routes import source_policy_routes as routes
    config, index = tmp_path / 'config.json', tmp_path / 'index.json'
    config.write_text('{"folders":[]}'); index.write_text('{"items":[]}')
    monkeypatch.setattr(routes, 'visual_library_service', SimpleNamespace(config_file=config, index_file=index))
    registry = SourceRegistry(SQLiteRegistry(SimpleNamespace(DB_PATH=tmp_path / 'db.sqlite3')))
    monkeypatch.setattr(routes, 'source_registry', registry)
    app = FastAPI(); app.include_router(routes.router, prefix='/api')
    client = TestClient(app)
    response = client.get('/api/library-sources/policy', params={'brand': 'Brand A'}).json()
    assert response['mode'] == 'preview' and not response['active']
    report = client.post('/api/library-sources/migration-preview', json={'brand': 'Brand A'}).json()
    assert report['summary']['folders'] == 0 and not report['applied']
    assert registry.revision() == 0 and registry.snapshot()['tables']['library_sources'] == []
    assert client.post('/api/library-sources/activate', json={}).status_code == 404
