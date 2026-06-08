#!/usr/bin/env python3
"""
EditFlow AI - Quick Start Script
Run the backend server and optionally start tests.
"""
import sys
import os
import argparse
from pathlib import Path

# ── CRITICAL: redirect HuggingFace cache to G: BEFORE any HF-aware module
# imports. huggingface_hub captures HF_HUB_CACHE into a module-level constant
# at import time — any change AFTER import is ignored, and downloads quietly
# land in the default ~/.cache/huggingface (C:\Users\<u>\.cache\huggingface
# on Windows). C: drive on this machine is at 99%; that path doesn't work.
#
# This block MUST be the first thing in run.py, before backend.config or
# anything that transitively imports huggingface_hub. config.py also sets
# the same vars as defense-in-depth, but if HF is already imported when
# config.py runs, that redirect arrives too late.
_PROJECT_ROOT = Path(__file__).resolve().parent
_HF_CACHE = _PROJECT_ROOT / "data" / "hf-cache"
_HF_CACHE.mkdir(parents=True, exist_ok=True)
os.environ["HF_HUB_CACHE"] = str(_HF_CACHE)
os.environ.setdefault("HF_HOME", str(_HF_CACHE.parent))

# Add project to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def main():
    parser = argparse.ArgumentParser(description="Run the EditFlow AI backend server.")
    parser.add_argument("--prod", action="store_true", help="Run without the development reload watcher.")
    args = parser.parse_args()

    if args.prod:
        os.environ["EDITFLOW_DEBUG"] = "false"

    from backend.main import run_server

    print("=" * 50)
    print("  EditFlow AI - Starting Backend Server")
    print("=" * 50)
    run_server()


if __name__ == "__main__":
    main()
