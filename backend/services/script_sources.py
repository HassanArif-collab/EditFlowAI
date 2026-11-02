"""Tracked compatibility aliases for scripts copied during project migration.

Editors may save atomically, so filesystem hardlinks are insufficient. Registered
copies synchronize only a single changed revision; divergent edits stop with a
conflict and retain both originals.
"""
import hashlib
import json
import os
import tempfile
import threading
import uuid
from pathlib import Path
from ..config import get_settings

_lock = threading.RLock()


class ScriptConflictError(ValueError):
    pass


def revision(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def _registry(path=None):
    return Path(path) if path else get_settings().DATA_DIR / 'script_aliases.json'


def _read(path):
    return json.loads(path.read_text(encoding='utf-8')) if path.is_file() else {'scripts':[]}


def _write(path, text):
    path.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w',encoding='utf-8',dir=path.parent,delete=False,suffix='.tmp') as stream:
        stream.write(text)
        name=stream.name
    os.replace(name,path)


def register_alias(canonical, alias, baseline, registry=None):
    path=_registry(registry)
    with _lock:
        data=_read(path)
        key=str(Path(canonical).resolve())
        if not any(row['canonical'].casefold()==key.casefold() for row in data['scripts']):
            data['scripts'].append({'canonical':key,'aliases':[str(Path(alias).resolve())],'revision':baseline})
            _write(path,json.dumps(data,indent=2))


def register_migration_copies(report_path=None, registry=None):
    """Register proven identical migration pairs; never guess between divergent copies."""
    report_path = Path(report_path) if report_path else get_settings().DATA_DIR / 'output/project-script-migration-report.json'
    if not report_path.is_file():
        return []
    results = []
    with _lock:
        known = _read(_registry(registry))['scripts']
        for row in _read(report_path).get('migrations', []):
            if row.get('type') != 'copy_file' or row.get('status') != 'copied':
                continue
            canonical, alias = Path(row['target']).resolve(), Path(row['source']).resolve()
            if any(Path(item['canonical']).resolve() == canonical for item in known):
                continue
            if not canonical.is_file() or not alias.is_file():
                continue
            first, second = canonical.read_text(encoding='utf-8'), alias.read_text(encoding='utf-8')
            if first != second:
                results.append({'canonical': str(canonical), 'status': 'conflict',
                                'alias': str(alias)})
                continue
            register_alias(canonical, alias, revision(first), registry)
            results.append({'canonical': str(canonical), 'status': 'registered'})
    return results


def current_script(path, registry=None):
    requested=Path(path).resolve()
    store=_registry(registry)
    with _lock:
        data=_read(store)
        row=next((r for r in data['scripts'] if str(requested).casefold() in
                  [str(Path(p).resolve()).casefold() for p in [r['canonical'],*r['aliases']]]),None)
        if not row:
            return requested
        canonical=Path(row['canonical'])
        if not canonical.is_file():
            raise FileNotFoundError(f'Project script was removed: {canonical}')
        paths=[Path(p) for p in [row['canonical'],*row['aliases']] if Path(p).is_file()]
        texts={p:p.read_text(encoding='utf-8') for p in paths}
        changed={revision(text):text for text in texts.values() if revision(text)!=row['revision']}
        if len(changed)>1:
            raise ScriptConflictError('Both the project script and its legacy copy changed differently. Both files were preserved; reconcile them before compiling: '+str(canonical))
        if changed:
            text=next(iter(changed.values()))
            backup=store.parent/'output/script-sync-backups'/uuid.uuid4().hex
            # Verify the read snapshot before replacing any registered copy.
            if any(p.read_text(encoding='utf-8')!=old for p,old in texts.items()):
                raise ScriptConflictError('Script changed during refresh. Retry after the editor finishes saving.')
            for index,(p,old) in enumerate(texts.items()):
                if old!=text:
                    _write(backup/f'{index}-{p.name}',old)
                    _write(p,text)
            row['revision']=revision(text)
            _write(store,json.dumps(data,indent=2))
        return canonical


def script_locations(path):
    requested=str(Path(path).resolve()).casefold()
    data=_read(_registry())
    for row in data['scripts']:
        paths=[row['canonical'],*row['aliases']]
        if requested in [str(Path(p).resolve()).casefold() for p in paths]:
            return [Path(p) for p in paths]
    return [Path(path)]
