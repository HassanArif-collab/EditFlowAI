from types import SimpleNamespace

from backend.models.sqlite_registry import SQLiteRegistry
from backend.services.source_registry import SourceRegistry, canonical
from backend.services import basic_visual_sources as basic


def test_folder_bin_selection_persists_and_never_falls_back_after_removal(tmp_path, monkeypatch):
    registry = SourceRegistry(SQLiteRegistry(SimpleNamespace(DB_PATH=tmp_path/'db.sqlite3')))
    monkeypatch.setattr(basic, 'source_registry', registry)
    folder = tmp_path/'Visuals'; folder.mkdir()
    first = folder/'construction.mp4'; first.write_bytes(b'clip')
    sibling = folder/'sibling.mp4'; sibling.write_bytes(b'other')
    project = str(tmp_path/'project')
    assert basic.selected_paths('Brand', project) is None
    scan = [{'mediaPath':str(first),'binPath':'Root/Visuals','type':'clip'},
            {'mediaPath':str(sibling),'binPath':'Root/Visuals Old','type':'clip'}]
    result = basic.register('Brand',project,project_path=str(tmp_path/'edit.prproj'),bin_path='Root/Visuals',items=scan)
    assert basic.selected_paths('Brand',project)==[canonical(first)]
    from backend.services import visual_library_service as visual_module
    from backend.services import media_framing
    monkeypatch.setattr(visual_module, 'get_settings', lambda: SimpleNamespace(DATA_DIR=tmp_path))
    monkeypatch.setattr(media_framing, 'source_facts', lambda path: {'duration': 8, 'width': 1920, 'height': 1080})
    service = visual_module.VisualLibraryService(tmp_path/'visual_library')
    assert [row['path'] for row in service.query_items(brand='Brand',project_folder=project)] == [canonical(first)]
    assert basic.selected_paths('Another brand',project) is None
    basic.update('Brand',project,result['id'],False)
    assert basic.selected_paths('Brand',project)==[]
    assert service.query_items(brand='Brand',project_folder=project) == []
    basic.update('Brand',project,result['id'],True)
    assert basic.selected_paths('Brand',project)==[canonical(first)]
    basic.update('Brand',project,result['id'],False,removed=True)
    assert basic.selected_paths('Brand',project)==[]
    assert first.read_bytes()==b'clip'
    linked = basic.register('Brand',project,folder=str(folder))
    assert set(basic.selected_paths('Brand',project))=={canonical(first),canonical(sibling)}
    assert SourceRegistry(registry.db).sources('Brand',project)
