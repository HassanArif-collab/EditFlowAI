"""Preview library source roles and script dependencies without changing any library."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from backend.services.source_migration import migration_preview
from backend.services.project_scripts import list_project_scripts
from backend.services.visual_library_service import visual_library_service


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--brand', required=True)
    parser.add_argument('--project')
    parser.add_argument('--output', help='Optional report destination; never changes source files or caches')
    args = parser.parse_args()
    scripts = []
    if args.project:
        project = list_project_scripts(args.project)
        if project['brand'].casefold() != args.brand.casefold():
            raise ValueError('Project does not belong to the selected brand.')
        scripts = [row['full_path'] for row in project['scripts']]
    report = migration_preview(visual_library_service.config_file, visual_library_service.index_file, args.brand, scripts)
    if args.output:
        output = Path(args.output).resolve()
        # A report cannot overwrite an input cache or a script being reviewed.
        protected = {Path(path).resolve() for path in report['cache_files']} | {Path(path).resolve() for path in scripts}
        if output in protected or output.exists():
            raise ValueError('Choose a new report filename, separate from source scripts and caches.')
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({'mode': report['mode'], 'applied': False, **report['summary'], 'output': args.output}))


if __name__ == '__main__':
    main()
