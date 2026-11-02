"""Read-only comparison of individually migrated scripts and live API content."""
import hashlib
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main():
    report = json.loads((ROOT / 'data/output/project-script-migration-report.json').read_text())
    for row in report['migrations']:
        if row.get('type') != 'copy_file':
            continue
        output = {'script': Path(row['source']).name, 'copies': []}
        for field in ('source', 'target'):
            path = Path(row[field])
            text = path.read_text(encoding='utf-8')
            output['copies'].append({'role': field, 'path': str(path),
                'revision': hashlib.sha256(text.encode()).hexdigest(),
                'heading': text.splitlines()[0], 'modified': path.stat().st_mtime})
        try:
            url = 'http://127.0.0.1:8765/api/script-assembly/script-content?' + urllib.parse.urlencode({'path': row['target']})
            # This endpoint reconciles registered compatibility copies; it starts no media jobs.
            data = json.load(urllib.request.urlopen(url, timeout=10))
            output['live'] = {'revision': data.get('revision'), 'heading': data.get('content', '').splitlines()[:1]}
        except Exception as exc:
            output['live_error'] = str(exc)
        print(json.dumps(output))


if __name__ == '__main__':
    main()
