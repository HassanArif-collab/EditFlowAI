"""Assign explicit legacy scripts to a project without copying or moving their files."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from backend.services.project_scripts import link_existing_project_scripts

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', required=True)
    parser.add_argument('--script', action='append', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    print(json.dumps(link_existing_project_scripts(args.project, args.script, args.apply)))
