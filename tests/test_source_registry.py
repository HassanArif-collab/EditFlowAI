import copy
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.models.sqlite_registry import SQLiteRegistry
from backend.services.source_registry import SourceRegistry, PolicyConflict, canonical


@pytest.fixture
def library(tmp_path):
    folder = tmp_path / 'footage'
    folder.mkdir()
    media = folder / 'clip.mp4'
    media.write_bytes(b'Original footage')
    db = SQLiteRegistry(SimpleNamespace(DB_PATH=tmp_path / 'registry.sqlite3'))
    return SourceRegistry(db), folder, media


def source(registry, folder, media, role='visuals', brand='Brand A', project=None, bin=False):
    kind = 'premiere_bin' if bin else 'folder'
    locator = {'project_path': str(folder / 'edit.prproj'), 'bin_id': 'node-1'} if bin else {'path': str(folder)}
    key = registry.put_source(brand=brand, role=role, source_type=kind, locator=locator, project_folder=project)
    registry.replace_memberships(key, [{'path': str(media)}])
    return key


@pytest.mark.parametrize('role', ['raw_dialogue', 'visuals', 'references'])
def test_only_the_explicit_role_is_eligible(library, role):
    registry, folder, media = library
    source(registry, folder, media, role)
    for purpose in ('raw_dialogue', 'visuals', 'references'):
        assert registry.resolve('Brand A', media, purpose)['allowed'] == (role == purpose)


def test_a_folder_does_not_imply_its_sibling_files_are_approved(library):
    registry, folder, media = library
    source(registry, folder, media)
    sibling = folder / 'not selected.mp4'; sibling.write_bytes(b'Unrelated')
    assert registry.resolve('Brand A', sibling, 'visuals')['reason'] == 'not_registered'
    assert registry.resolve('Other brand', media, 'visuals')['reason'] == 'not_registered'


def test_folder_and_bin_deduplicate_asset_without_losing_memberships(library):
    registry, folder, media = library
    first = source(registry, folder, media)
    second = source(registry, folder, media, bin=True)
    result = registry.resolve('Brand A', media, 'visuals')
    assert result['allowed'] and set(result['source_ids']) == {first, second}
    assert len(registry.snapshot()['tables']['library_media']) == 1
    registry.put_source(source_id=first, brand='Brand A', role='visuals', source_type='folder', locator={'path': str(folder)}, enabled=False)
    assert registry.resolve('Brand A', media, 'visuals')['source_ids'] == [second]
    registry.replace_memberships(second, [])
    assert registry.resolve('Brand A', media, 'visuals')['reason'] == 'disabled'
    assert media.read_bytes() == b'Original footage'


def test_reference_restriction_cannot_be_bypassed_through_a_bin_or_project_override(library, tmp_path):
    registry, folder, media = library
    source(registry, folder, media, 'references')
    source(registry, folder, media, 'visuals', project=str(tmp_path / 'project'), bin=True)
    decision = registry.resolve('Brand A', media, 'visuals', tmp_path / 'project')
    assert not decision['allowed'] and decision['reason'] == 'role_conflict'


def test_project_override_and_exclusion_do_not_affect_sibling_projects(library, tmp_path):
    registry, folder, media = library
    source(registry, folder, media)
    project = str(tmp_path / 'project')
    local = source(registry, folder, media, project=project, bin=True)
    registry.put_source(source_id=local, brand='Brand A', role='visuals', source_type='premiere_bin',
        locator={'project_path': str(folder / 'edit.prproj'), 'bin_id': 'node-1'}, project_folder=project, enabled=False)
    assert registry.resolve('Brand A', media, 'visuals', project)['reason'] == 'disabled'
    assert registry.resolve('Brand A', media, 'visuals', tmp_path / 'other')['allowed']
    registry.exclude('Brand A', media, 'Not suitable for this campaign', tmp_path / 'other')
    assert registry.resolve('Brand A', media, 'visuals', tmp_path / 'other')['reason'] == 'excluded'
    assert registry.resolve('Brand A', media, 'visuals')['allowed']


def test_hardlink_cannot_bypass_an_exclusion(library, tmp_path):
    registry, folder, media = library
    alias = tmp_path / 'alias.mp4'
    os.link(media, alias)
    source(registry, folder, media)
    # The alias is not a folder descendant; explicit bin membership can register it.
    source(registry, folder, alias, bin=True)
    registry.exclude('Brand A', media, 'Excluded asset')
    assert registry.resolve('Brand A', alias, 'visuals')['reason'] == 'excluded'
    assert len(registry.snapshot()['tables']['library_media']) == 1


def test_junction_or_symlink_cannot_widen_a_folder_snapshot(library, tmp_path):
    registry, folder, media = library
    external = tmp_path / 'external.mp4'; external.write_bytes(b'Outside the folder')
    source_id = registry.put_source(brand='Brand A', role='visuals', source_type='folder', locator={'path': str(folder)})
    with pytest.raises(ValueError):
        registry.replace_memberships(source_id, [{'path': str(external)}])
    assert registry.snapshot()['tables']['library_media'] == []


def test_replaced_content_cannot_reuse_old_membership_fingerprint(library):
    registry, folder, media = library
    key = source(registry, folder, media)
    asset = registry.resolve('Brand A', media, 'visuals')['asset_id']
    replacement = folder / 'replacement.tmp'; replacement.write_bytes(b'Updated footage!'); replacement.replace(media)
    assert registry.resolve('Brand A', media, 'visuals')['reason'] == 'media_changed'
    registry.replace_memberships(key, [{'path': str(media)}])
    result = registry.resolve('Brand A', media, 'visuals')
    assert result['allowed'] and result['asset_id'] == asset


def test_subclips_keep_ranges_and_reject_widening(library):
    registry, folder, media = library
    key = source(registry, folder, media, bin=True)
    registry.replace_memberships(key, [{'path': str(media), 'range_in': 1, 'range_out': 3},
                                       {'path': str(media), 'range_in': 7, 'range_out': 9}])
    result = registry.resolve('Brand A', media, 'visuals')
    assert set(result['ranges']) == {(1, 3), (7, 9)}
    assert registry.resolve('Brand A', media, 'visuals', source_range=(1, 2))['allowed']
    assert registry.resolve('Brand A', media, 'visuals', source_range=(2, 8))['reason'] == 'outside_registered_range'
    with pytest.raises(ValueError):
        registry.replace_memberships(key, [{'path': str(media), 'range_in': 0, 'range_out': float('nan')}])


def test_restore_is_atomic_monotonic_and_preserves_existing_caches(library, tmp_path):
    registry, folder, media = library
    key = source(registry, folder, media)
    registry.db.execute("INSERT INTO assets(id,path,name,created_at,updated_at) VALUES(?,?,?,?,?)",
                        ('cached-media', str(media), media.name, '2026-11-02', '2026-11-02'))
    registry.db.execute("INSERT INTO transcripts(id,asset_id,full_text,created_at) VALUES(?,?,?,?)",
                        ('cached-transcript', 'cached-media', 'Verified original transcript', '2026-11-02'))
    cache = tmp_path / 'visual_index.json'; cache.write_text('{"verified":true,"description":"Human annotation"}')
    snapshot = registry.snapshot()
    registry.replace_memberships(key, [])
    latest = registry.revision()
    with pytest.raises(PolicyConflict):
        registry.restore(snapshot, expected_revision=snapshot['revision'])
    registry.restore(snapshot, expected_revision=latest)
    assert registry.revision() > latest
    assert registry.resolve('Brand A', media, 'visuals')['allowed']
    assert cache.read_text() == '{"verified":true,"description":"Human annotation"}'
    assert media.read_bytes() == b'Original footage'
    assert registry.db.fetch_one('SELECT full_text FROM transcripts WHERE id=?', ('cached-transcript',))['full_text'] == 'Verified original transcript'
    bad = copy.deepcopy(snapshot)
    bad['tables']['library_memberships'][0]['source_id'] = 'nonexistent'
    import sqlite3
    before = registry.snapshot()
    with pytest.raises(sqlite3.IntegrityError):
        registry.restore(bad, expected_revision=registry.revision())
    assert registry.snapshot() == before


def test_registration_does_not_change_source_ownership_or_overwrite_a_changed_policy(library):
    registry, folder, media = library
    key = source(registry, folder, media)
    revision = registry.revision()
    with pytest.raises(PolicyConflict):
        registry.replace_memberships(key, [], expected_revision=revision - 1)
    with pytest.raises(ValueError):
        registry.put_source(source_id=key, brand='Another brand', role='visuals', source_type='folder', locator={'path': str(folder)})
    assert registry.revision() == revision
    assert registry.resolve('Brand A', media, 'visuals')['allowed']
