"""Preview/apply brand script references without moving scripts or processing media."""
import argparse
from datetime import datetime
import json
import re
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from backend.services.script_catalog import brand_root
from backend.services.script_sources import register_migration_copies


def setup(brand, previous_folders, reference_files=(), apply=False):
    root = brand_root(brand)
    workflow = next((root / name for name in ('AI Workflow', 'AI Automation') if (root / name).is_dir()), root / 'AI Automation')
    profile = workflow / 'brand.editflow.json'
    data = json.loads(profile.read_text(encoding='utf-8-sig')) if profile.is_file() else {'brand': brand}
    if data.get('brand') and data['brand'].casefold() != brand.casefold():
        raise ValueError('Brand profile mismatch')
    library = data.setdefault('script_library', {})
    for key, values, directory in [('previous_folders', previous_folders, True), ('reference_files', reference_files, False)]:
        target = library.setdefault(key, [])
        for value in values:
            path = (root / value).resolve()
            if not path.is_relative_to(root) or not (path.is_dir() if directory else path.is_file()):
                raise ValueError(f'Missing or cross-brand reference: {path}')
            relative = path.relative_to(root).as_posix()
            if relative not in target:
                target.append(relative)
    result = {'applied': apply, 'profile': str(profile), 'configuration': data}
    if apply:
        backup = ROOT / 'data/output/script-library-setup-backups' / datetime.now().strftime('%Y%m%d-%H%M%S-%f')
        backup.mkdir(parents=True)
        if profile.exists():
            shutil.copy2(profile, backup / profile.name)
        profile.parent.mkdir(parents=True, exist_ok=True)
        profile.write_text(json.dumps(data, indent=2), encoding='utf-8')
        instructions = workflow / 'AGENTS.md'
        if instructions.is_file():
            before = instructions.read_text(encoding='utf-8-sig')
            start, end = '<!-- editflow-script-library:start -->', '<!-- editflow-script-library:end -->'
            block = f'''{start}
## Script references and active project

Load `editflow_project_context(project_folder=...)` before drafting. It returns
the active brand, canonical Scripts output folder, existing media/transcript
references and a same-brand script catalog. Use `editflow_script_catalog(brand=...,
query=...)` and `editflow_read_script_reference(brand=..., path=...)` to read old
scripts on demand. CLI equivalents are `context`, `script-catalog` and
`read-script-reference` in the maintained EditFlow CLI.

Previous scripts remain references; validate quoted words and timing against
original transcripts. New work saves ONLY to the selected production project's
returned `paths.scripts`, regardless of older shared-folder examples below.
Selecting a new brand/project never moves or reassigns previous scripts.
{end}'''
            text = re.sub(re.escape(start) + r'.*?' + re.escape(end), lambda _: block, before, flags=re.S) if start in before else block + '\n\n' + before
            text = re.sub(r'^- Scripts →.*$', "- Scripts → the selected production project's returned `paths.scripts` folder.", text, flags=re.M)
            if text != before:
                shutil.copy2(instructions, backup / 'AGENTS.md')
                instructions.write_text(text, encoding='utf-8')
        result['migration_aliases'] = register_migration_copies()
        (backup / 'setup.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--brand', required=True)
    parser.add_argument('--previous-folder', action='append', default=[])
    parser.add_argument('--reference', action='append', default=[])
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    result = setup(args.brand, args.previous_folder, args.reference, args.apply)
    print(json.dumps({key: result[key] for key in ('applied', 'profile')} |
                     {'migration_aliases': result.get('migration_aliases', [])}, indent=2))
