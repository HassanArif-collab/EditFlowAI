"""Register and reconcile the known Script 52 migration copies without guessing."""
import json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
from backend.services.script_sources import register_alias,current_script

def main():
    report=json.loads((ROOT/'data/output/project-script-migration-report.json').read_text())
    rows=report.get('results', report.get('entries', []))
    if not rows:
        rows=next(v for v in report.values() if isinstance(v,list))
    row=next(r for r in rows if r.get('type')=='copy_file' and Path(r['source']).name.startswith('Script_52_'))
    canonical=Path(row['target'])
    package=json.loads(canonical.with_suffix('.editflow.json').read_text(encoding='utf-8'))
    register_alias(canonical,row['source'],package['script_revision'])
    path=current_script(canonical)
    print(json.dumps({'canonical':str(path),'heading':path.read_text(encoding='utf-8').splitlines()[0]}))

if __name__=='__main__':main()
