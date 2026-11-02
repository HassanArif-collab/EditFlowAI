"""Read-only migration preview for existing folder configuration and annotations."""
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import uuid

from .source_registry import canonical


def path_is_reference(path):
    return bool(set(str(path).replace('\\', '/').casefold().split('/')) & {'finals', 'exports', 'final', 'edited'})


def read_json(path, default):
    return json.loads(path.read_text(encoding='utf-8-sig')) if path.is_file() else default


def migration_preview(config_path, index_path, brand, script_paths=()):
    if not brand or not brand.strip():
        raise ValueError('Choose a brand for the migration preview.')
    config_path, index_path = Path(config_path), Path(index_path)
    config = read_json(config_path, {'folders': []})
    index = read_json(index_path, {'items': []})
    folders = [row for row in config.get('folders', []) if str(row.get('brand', '')).casefold() == brand.casefold()]
    # Read the legacy cache directly: initialize()/refresh_metadata() may rewrite it.
    items = [row for row in index.get('items', []) if row.get('path')]
    candidates, assets = [], {}
    for folder in folders:
        root = Path(canonical(folder['path']))
        members = [row for row in items if Path(canonical(row['path'])).is_relative_to(root)]
        categories = Counter(row.get('category', 'unknown') for row in members)
        mixed = bool(categories.get('talking_head') and sum(count for category, count in categories.items() if category != 'talking_head'))
        suggested = 'references' if path_is_reference(root) else (
            'raw_dialogue' if members and set(categories) == {'talking_head'} else
            'visuals' if members and set(categories).issubset({'pure_broll', 'demonstration_broll', 'still_graphic'}) else None)
        source_id = uuid.uuid5(uuid.NAMESPACE_URL, brand.casefold() + '|' + str(root)).hex
        candidates.append({'candidate_id': source_id, 'path': str(root), 'brand': brand,
            'enabled': folder.get('is_active', True), 'suggested_role': suggested,
            'review_required': True, 'mixed_content': mixed, 'missing_folder': not root.is_dir(),
            'categories': dict(categories), 'cached_assets': len(members),
            'note': 'Suggestions are not applied. Verify source provenance before assigning roles.'})
        for item in members:
            key = canonical(item['path'])
            record = assets.setdefault(key, {'path': key, 'candidate_sources': [],
                'category': item.get('category'), 'verified': bool(item.get('verified')),
                'cache_item_id': item.get('id'), 'missing': not Path(key).is_file(),
                'reference_path': path_is_reference(key)})
            record['candidate_sources'].append(source_id)
    dependencies = []
    from .script_assembly_service import ScriptAssemblyService
    parser = ScriptAssemblyService()
    scripts = sorted({Path(path).resolve() for path in script_paths}, key=str)
    for script in scripts:
        content = script.read_text(encoding='utf-8')
        sidecar = read_json(script.with_suffix('.editflow.json'), {})
        if sidecar.get('script_revision') == hashlib.sha256(content.encode()).hexdigest():
            cuts = [{'source': row['source_file'], 'kind': row.get('kind', 'recorded_dialogue')}
                    for variant in sidecar.get('variants', []) for row in variant['cuts']]
        else:
            cuts = [{'source': beat.source_ref, 'kind': beat.kind} for beat in parser.parse_markdown_script(content)]
        # Preserve explicit workspace mappings, without searching the entire brand.
        mappings = {short.casefold(): full for short, full in re.findall(r'`([^`]+)`\s*→\s*`([^`]+)`', content)
                    if Path(full).is_absolute()}
        for cut in cuts:
            reference = mappings.get(cut['source'].casefold(), cut['source'])
            path = Path(reference)
            if not path.is_absolute():
                local = script.parent / path
                path = local if local.is_file() else path
            asset = assets.get(canonical(path)) if path.is_absolute() else None
            generated = cut['kind'] in {'generated_narration', 'graphic'}
            status = ('project_asset' if generated else 'edited_source_needs_raw_replacement' if path_is_reference(path)
                      else 'review_source_role' if asset else 'unregistered_or_unresolved_source')
            dependencies.append({'script': str(script), 'source': str(path), 'kind': cut['kind'], 'status': status})
    signature = hashlib.sha256()
    signature.update(brand.casefold().encode())
    for path in (config_path, index_path, *scripts, *(script.with_suffix('.editflow.json') for script in scripts)):
        signature.update(str(path).encode())
        signature.update(path.read_bytes() if path.is_file() else b'<missing>')
    return {'success': True, 'mode': 'preview', 'applied': False, 'brand': brand,
            'input_revision': signature.hexdigest(), 'candidates': candidates,
            'assets': list(assets.values()), 'dependencies': dependencies,
            'summary': {'folders': len(candidates), 'cached_assets': len(assets),
                'verified_annotations_preserved': sum(row['verified'] for row in assets.values()),
                'mixed_folders': sum(row['mixed_content'] for row in candidates),
                'dependencies_requiring_review': sum(row['status'] != 'project_asset' for row in dependencies)},
            'cache_files': [str(config_path), str(index_path)],
            'notice': 'Nothing was moved, reclassified, transcribed, indexed or activated.'}
