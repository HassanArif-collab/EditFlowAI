"""Small, explicit visual-library selection using the Phase 1 registry."""
from pathlib import Path

from .source_registry import source_registry, canonical


def sources(brand, project):
    return [row for row in source_registry.sources(brand, project) if row['metadata'].get('basic_visuals')]


def register(brand, project, folder=None, project_path=None, bin_path=None, items=None):
    from .visual_library_service import VIDEO_EXTS, IMAGE_EXTS
    extensions = VIDEO_EXTS | IMAGE_EXTS
    if folder:
        root = Path(folder).resolve()
        if not root.is_dir():
            raise ValueError('Choose an existing folder.')
        paths = [path for path in root.rglob('*') if path.is_file() and path.suffix.lower() in extensions
                 and not set(part.casefold() for part in path.parts) & {'thumbs', 'thumbnails', 'frame_samples'}
                 and path.resolve().is_relative_to(root)]
        kind, locator, name = 'folder', {'path': canonical(root)}, root.name
    else:
        if not project_path or not bin_path:
            raise ValueError('Scan the open Premiere project and choose a bin first.')
        paths = [Path(item['mediaPath']) for item in (items or []) if item.get('mediaPath')
                 and not item.get('isSubclip') and item.get('type') != 'sequence'
                 and (item.get('binPath') == bin_path or item.get('binPath', '').startswith(bin_path + '/'))
                 and Path(item['mediaPath']).suffix.lower() in extensions and Path(item['mediaPath']).is_file()]
        kind = 'premiere_bin'
        locator = {'project_path': canonical(project_path), 'bin_id': bin_path}
        name = bin_path
    if not paths:
        raise ValueError('No online video or image files were found in this selection.')
    existing = next((row for row in sources(brand, project) if row['locator'] == locator), None)
    key = source_registry.put_source(brand=brand, project_folder=project, role='visuals', source_type=kind,
        locator=locator, source_id=existing['id'] if existing else None,
        metadata={'basic_visuals': True, 'name': name, 'removed': False})
    source_registry.replace_memberships(key, [{'path': str(path)} for path in sorted(set(paths))])
    return {'success': True, 'id': key, 'count': len(set(paths))}


def update(brand, project, source_id, enabled, removed=False):
    row = next((row for row in sources(brand, project) if row['id'] == source_id), None)
    if not row:
        raise ValueError('Source does not belong to the selected project.')
    source_registry.put_source(brand=brand, project_folder=project, source_id=source_id,
        role=row['role'], source_type=row['source_type'], locator=row['locator'], enabled=enabled and not removed,
        metadata={**row['metadata'], 'removed': removed})
    return {'success': True}


def selected_paths(brand, project):
    """None keeps the existing library; an empty selection stays empty."""
    rows = sources(brand, project)
    if not rows:
        return None
    state = source_registry.snapshot()
    snapshot = state['tables']
    ids = {row['id'] for row in rows}
    assets = {row['asset_id'] for row in snapshot['library_memberships'] if row['source_id'] in ids}
    paths = {row['path'] for row in snapshot['library_media_paths'] if row['asset_id'] in assets}
    return [path for path in sorted(paths) if Path(path).is_file() and
            source_registry.resolve(brand, path, 'visuals', project, _snapshot=state)['allowed']]
