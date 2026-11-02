"""Brand-scoped script references; no copying, media indexing or ownership guesses."""
import json
import os
from pathlib import Path

from . import project_scripts
from .script_sources import _read, _registry, revision, current_script, ScriptConflictError


def brand_root(brand):
    # Reuse existing brand-name validation and configured root.
    project_scripts.list_brand_projects(brand)
    return (project_scripts.get_settings().BRANDS_ROOT / brand).resolve()


def brand_script_setup(brand):
    root = brand_root(brand)
    previous, references, profiles, missing = [], [], [], []
    for workflow in ('AI Workflow', 'AI Automation'):
        profile = root / workflow / 'brand.editflow.json'
        if not profile.is_file():
            continue
        data = json.loads(profile.read_text(encoding='utf-8-sig'))
        if data.get('brand') and data['brand'].casefold() != brand.casefold():
            raise ValueError(f'Brand profile mismatch: {profile}')
        profiles.append(str(profile))
        setup = data.get('script_library', {})
        for key, destination in (('previous_folders', previous), ('reference_files', references)):
            for value in setup.get(key, []):
                path = (root / value).resolve()
                if not path.is_relative_to(root):
                    raise ValueError(f'Script library path is outside {brand}: {path}')
                if (path.is_dir() if key == 'previous_folders' else path.is_file()):
                    if str(path) not in destination:
                        destination.append(str(path))
                else:
                    missing.append(str(path))
    return {'brand': brand, 'brand_root': str(root), 'profiles': profiles,
            'previous_folders': previous, 'reference_files': references,
            'missing_paths': missing}


def _walk_scripts(folder, root):
    for current, dirs, files in os.walk(folder, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not d.startswith(('.', '_'))
                         and d.casefold() not in project_scripts._IGNORED_DIRS)
        for name in sorted(files):
            path = (Path(current) / name).resolve()
            if path.is_relative_to(root) and path.is_file() and project_scripts._is_script(path):
                yield path


def list_script_catalog(brand, query='', project_folder=None):
    setup = brand_script_setup(brand)
    root = Path(setup['brand_root'])
    entries = {}
    aliases = {}
    for row in _read(_registry()).get('scripts', []):
        canonical = Path(row['canonical']).resolve()
        for path in [row['canonical'], *row.get('aliases', [])]:
            aliases[str(Path(path).resolve()).casefold()] = canonical

    def add(path, project=None):
        path = aliases.get(str(path.resolve()).casefold(), path.resolve())
        if not path.is_relative_to(root) or not path.is_file():
            return
        key = str(path).casefold()
        if key in entries:
            return
        conflict = None
        try:
            path = current_script(path)
        except ScriptConflictError as exc:
            conflict = str(exc)
        text = path.read_text(encoding='utf-8-sig')
        heading = next((line.lstrip('# ').strip() for line in text.splitlines() if line.startswith('# ')), path.stem)
        if query and query.casefold() not in (path.name + '\n' + text).casefold():
            return
        entries[key] = {'name': path.name, 'title': heading, 'full_path': str(path),
                        'brand': brand, 'project_folder': str(project) if project else None,
                        'project_name': project.name if project else 'Previous scripts — unassigned',
                        'revision': revision(text), 'conflict': conflict,
                        'reference_only': not project_folder or project != Path(project_folder).resolve()}

    # Owned entries first: aliases subsequently encountered in old folders must not
    # erase known project ownership. No content-hash deduplication of independent scripts.
    for project in project_scripts.list_brand_projects(brand)['projects']:
        for item in project_scripts.list_project_scripts(project['path'])['scripts']:
            add(Path(item['full_path']), Path(project['path']).resolve())
    for folder in setup['previous_folders']:
        for path in _walk_scripts(folder, root):
            add(path)
    return {'success': True, **setup, 'scripts': list(entries.values()), 'total': len(entries),
            'notice': 'Previous scripts are references. Verify quotations and timing against original transcripts.'}


def read_catalog_script(brand, path):
    requested = Path(path).resolve()
    catalog = list_script_catalog(brand)
    item = next((item for item in catalog['scripts'] if Path(item['full_path']) == requested), None)
    if not item:
        raise ValueError('Choose a script listed in this brand\'s script catalog.')
    # Recheck after listing: an editor may have saved during catalog discovery.
    canonical = current_script(requested)
    text = canonical.read_text(encoding='utf-8')
    return {'success': True, **item, 'full_path': str(canonical), 'content': text,
            'revision': revision(text), 'reference_only': True}
