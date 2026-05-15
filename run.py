#!/usr/bin/env python3
"""
EditFlow AI - Quick Start Script
Run the backend server and optionally start tests.
"""
import sys
import os
import argparse

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
