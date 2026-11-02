"""Source-role permissions and provenance; never reads transcripts or runs models.

Phase 1 deliberately exposes policy previews only. Existing execution consumers
will adopt this resolver in the later integration phase before project activation.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import uuid

from ..models.sqlite_registry import SQLiteRegistry, sqlite_registry

ROLES = {'raw_dialogue', 'visuals', 'references'}
TABLES = ('library_sources', 'library_media', 'library_media_paths',
          'library_memberships', 'library_exclusions')


class PolicyConflict(ValueError):
    pass


def canonical(path):
    return os.path.normcase(str(Path(path).expanduser().resolve()))


def file_facts(path):
    """Cheap content sample plus nanosecond file revision; no decoding/model work."""
    path = Path(path).resolve()
    before = path.stat()
    if not path.is_file():
        raise ValueError(f'Expected a media file: {path}')
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        digest.update(stream.read(65536))
        if before.st_size > 65536:
            stream.seek(max(65536, before.st_size - 65536))
            digest.update(stream.read(65536))
    after = path.stat()
    fields = lambda stat: (stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_dev, stat.st_ino)
    if fields(before) != fields(after):
        raise PolicyConflict(f'File changed while checking it: {path}')
    digest.update(json.dumps(fields(after)).encode())
    return {'path': canonical(path), 'file_key': f'{after.st_dev}:{after.st_ino}' if after.st_ino else 'path:' + canonical(path),
            'fingerprint': digest.hexdigest()}


class SourceRegistry:
    def __init__(self, database: SQLiteRegistry):
        self.db = database

    @contextmanager
    def transaction(self, expected_revision=None):
        self.db.initialize()
        with self.db._lock, self.db.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            current = conn.execute('SELECT generation FROM library_policy_state').fetchone()[0]
            if expected_revision is not None and expected_revision != current:
                raise PolicyConflict('The source policy changed. Refresh its preview before applying.')
            yield conn
            conn.execute('UPDATE library_policy_state SET generation = generation + 1')

    def revision(self):
        return self.db.fetch_one('SELECT generation FROM library_policy_state')['generation']

    def sources(self, brand, project_folder=None):
        if not brand or not brand.strip():
            raise ValueError('Choose a brand.')
        project = canonical(project_folder) if project_folder else ''
        rows = self.db.fetch_all('SELECT * FROM library_sources WHERE lower(brand)=lower(?) AND project_key IN (?, ?) ORDER BY id',
                                 (brand.strip(), '', project))
        return [{**row, 'locator': json.loads(row['locator']), 'metadata': json.loads(row['metadata'])} for row in rows]

    def put_source(self, *, brand, role, source_type, locator, project_folder=None,
                   enabled=True, source_id=None, metadata=None, expected_revision=None):
        if not brand or not brand.strip() or role not in ROLES or source_type not in {'folder', 'premiere_bin'}:
            raise ValueError('A brand, supported source type and explicit source role are required.')
        locator = dict(locator)
        if source_type == 'folder':
            if not locator.get('path') or not Path(locator['path']).is_dir():
                raise ValueError('Choose an existing source folder.')
            locator['path'] = canonical(locator['path'])
        elif not locator.get('project_path') or not locator.get('bin_id'):
            raise ValueError('A bin needs its originating Premiere project path and verified bin identity.')
        else:
            locator['project_path'] = canonical(locator['project_path'])
        source_id = source_id or uuid.uuid4().hex
        project = canonical(project_folder) if project_folder else ''
        with self.transaction(expected_revision) as conn:
            old = conn.execute('SELECT * FROM library_sources WHERE id=?', (source_id,)).fetchone()
            if old and (old['brand'].casefold() != brand.strip().casefold() or old['project_key'] != project or old['source_type'] != source_type):
                raise ValueError('Source ownership/type cannot be changed in place. Register a separate source.')
            if old and json.loads(old['locator']) != locator:
                raise ValueError('Replacing a source location requires a new membership preview.')
            conn.execute('''INSERT INTO library_sources(id,brand,source_type,locator,role,project_key,enabled,revision,metadata)
                VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                role=excluded.role,enabled=excluded.enabled,revision=excluded.revision,metadata=excluded.metadata''',
                (source_id, brand.strip(), source_type, json.dumps(locator), role, project, int(enabled),
                 old['revision'] + 1 if old else 1,
                 json.dumps(metadata) if metadata is not None else (old['metadata'] if old else '{}')))
        return source_id

    def replace_memberships(self, source_id, members, expected_revision=None):
        """A reviewed exact snapshot, not an implicit recursive folder scan."""
        prepared = []
        for member in members:
            facts = file_facts(member['path'])
            start, end = member.get('range_in'), member.get('range_out')
            if (start is None) != (end is None) or (start is not None and
                (not all(math.isfinite(v) for v in (start, end)) or start < 0 or end <= start)):
                raise ValueError('Subclip ranges require finite IN/OUT with OUT after IN.')
            prepared.append((facts, start, end, member.get('provenance', {})))
        with self.transaction(expected_revision) as conn:
            source = conn.execute('SELECT * FROM library_sources WHERE id=?', (source_id,)).fetchone()
            if not source:
                raise ValueError('Source is not registered.')
            if source['source_type'] == 'folder':
                root = Path(json.loads(source['locator'])['path'])
                if any(not Path(facts['path']).is_relative_to(root) for facts, *_ in prepared):
                    raise ValueError('A folder snapshot cannot include files outside its real folder.')
            if any(file_facts(facts['path']) != facts for facts, *_ in prepared):
                raise PolicyConflict('Media changed while preparing source membership. Refresh the preview.')
            conn.execute('DELETE FROM library_memberships WHERE source_id=?', (source_id,))
            for facts, start, end, provenance in prepared:
                row = conn.execute('SELECT asset_id FROM library_media_paths WHERE path=?', (facts['path'],)).fetchone()
                if not row:
                    row = conn.execute('SELECT id AS asset_id FROM library_media WHERE file_key=? ORDER BY id LIMIT 1', (facts['file_key'],)).fetchone()
                asset_id = row['asset_id'] if row else uuid.uuid4().hex
                conn.execute('''INSERT INTO library_media(id,canonical_path,file_key,fingerprint) VALUES(?,?,?,?)
                    ON CONFLICT(id) DO UPDATE SET canonical_path=excluded.canonical_path,file_key=excluded.file_key,fingerprint=excluded.fingerprint''',
                    (asset_id, facts['path'], facts['file_key'], facts['fingerprint']))
                conn.execute('''INSERT INTO library_media_paths(path,asset_id,file_key) VALUES(?,?,?)
                    ON CONFLICT(path) DO UPDATE SET asset_id=excluded.asset_id,file_key=excluded.file_key''',
                    (facts['path'], asset_id, facts['file_key']))
                range_key = '' if start is None else json.dumps([start, end])
                conn.execute('''INSERT INTO library_memberships(source_id,asset_id,range_key,range_in,range_out,fingerprint,provenance)
                    VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_id,asset_id,range_key) DO UPDATE SET
                    fingerprint=excluded.fingerprint,provenance=excluded.provenance''',
                    (source_id, asset_id, range_key, start, end, facts['fingerprint'], json.dumps(provenance)))
            conn.execute('UPDATE library_sources SET revision=revision+1 WHERE id=?', (source_id,))

    def exclude(self, brand, path, reason, project_folder=None, expected_revision=None):
        facts = file_facts(path)
        with self.transaction(expected_revision) as conn:
            row = conn.execute('SELECT id FROM library_media WHERE file_key=? ORDER BY id LIMIT 1', (facts['file_key'],)).fetchone()
            location = conn.execute('SELECT asset_id AS id FROM library_media_paths WHERE path=?', (facts['path'],)).fetchone()
            asset_id = (location or row)['id'] if (location or row) else None
            if not asset_id:
                raise ValueError('Register the asset before adding an exclusion.')
            conn.execute('INSERT OR REPLACE INTO library_exclusions VALUES(?,?,?,?)',
                (brand.strip(), canonical(project_folder) if project_folder else '', asset_id, reason))

    def resolve(self, brand, path, purpose, project_folder=None, source_range=None, _snapshot=None):
        if purpose not in ROLES:
            raise ValueError('Choose raw_dialogue, visuals or references.')
        if not brand or not brand.strip():
            raise ValueError('Choose a brand.')
        if source_range is not None and (len(source_range) != 2 or
            not all(math.isfinite(value) for value in source_range) or source_range[0] < 0 or source_range[1] <= source_range[0]):
            raise ValueError('The requested source range is invalid.')
        snapshot = _snapshot if _snapshot is not None else self.snapshot()
        project = canonical(project_folder) if project_folder else ''
        sources = [row for row in snapshot['tables']['library_sources'] if
                   row['brand'].casefold() == brand.strip().casefold() and row['project_key'] in ('', project)]
        facts = file_facts(path)
        location = next((row for row in snapshot['tables']['library_media_paths'] if row['path'] == facts['path']), None)
        asset = next((row for row in snapshot['tables']['library_media'] if
                      row['id'] == location['asset_id']), None) if location else next((row for row in
                      snapshot['tables']['library_media'] if row['file_key'] == facts['file_key']), None)
        result = {'allowed': False, 'reason': 'not_registered', 'path': facts['path'],
                  'policy_revision': snapshot['revision'], 'source_ids': [], 'ranges': []}
        if not asset:
            return result
        result['asset_id'] = asset['id']
        denied = next((row for row in snapshot['tables']['library_exclusions'] if
                      row['brand'].casefold() == brand.strip().casefold() and row['asset_id'] == asset['id'] and
                      row['project_key'] in ('', project)), None)
        if denied:
            return {**result, 'reason': 'excluded', 'detail': denied['reason']}
        rows = [row for row in snapshot['tables']['library_memberships'] if row['asset_id'] == asset['id']]
        by_id = {source['id']: source for source in sources}
        rows = [{**row, 'source': by_id[row['source_id']]} for row in rows if row['source_id'] in by_id]
        all_roles = {row['source']['role'] for row in rows if row['source']['enabled']}
        if len(all_roles) > 1:
            return {**result, 'reason': 'role_conflict'}
        # A project-specific registration explicitly overrides brand defaults for
        # this asset. Contradictory registrations at the same scope never blend.
        local = [row for row in rows if row['source']['project_key'] == project and project]
        rows = local or rows
        enabled = [row for row in rows if row['source']['enabled']]
        if not enabled:
            return {**result, 'reason': 'disabled' if rows else 'not_registered'}
        roles = {row['source']['role'] for row in enabled}
        if len(roles) != 1:
            return {**result, 'reason': 'role_conflict'}
        if purpose not in roles:
            return {**result, 'reason': 'role_mismatch', 'role': next(iter(roles))}
        current = [row for row in enabled if row['fingerprint'] == facts['fingerprint']]
        if len(current) != len(enabled):
            return {**result, 'reason': 'media_changed'}
        ranges = [(row['range_in'], row['range_out']) for row in current]
        if source_range is not None and not any(start is None or
            (source_range[0] >= start and source_range[1] <= end) for start, end in ranges):
            return {**result, 'reason': 'outside_registered_range'}
        return {**result, 'allowed': True, 'reason': 'eligible', 'role': purpose,
                'source_ids': sorted({row['source_id'] for row in current}),
                'ranges': sorted(set(ranges), key=str), 'fingerprint': facts['fingerprint']}

    def snapshot(self):
        self.db.initialize()
        with self.db._lock, self.db.connect() as conn:
            conn.execute('BEGIN')
            return {'schema_version': 1,
                    'revision': conn.execute('SELECT generation FROM library_policy_state').fetchone()[0],
                    'tables': {table: [dict(row) for row in conn.execute(f'SELECT * FROM {table} ORDER BY rowid')] for table in TABLES}}

    def restore(self, snapshot, expected_revision):
        if snapshot.get('schema_version') != 1 or set(snapshot.get('tables', {})) != set(TABLES):
            raise ValueError('Unsupported source-registry snapshot.')
        with self.transaction(expected_revision) as conn:
            for table in reversed(TABLES):
                conn.execute(f'DELETE FROM {table}')
            for table in TABLES:
                columns = [row['name'] for row in conn.execute(f'PRAGMA table_info({table})')]
                for row in snapshot['tables'][table]:
                    if set(row) != set(columns):
                        raise ValueError('Snapshot fields do not match this source registry.')
                    conn.execute(f'INSERT INTO {table}({",".join(columns)}) VALUES({",".join("?" for _ in columns)})',
                                 [row[column] for column in columns])


source_registry = SourceRegistry(sqlite_registry)
