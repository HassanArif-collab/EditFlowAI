"""Move known script folders into their projects and retain legacy directory links.

Run with --plan mapping.json to inspect; add --apply to execute that exact map.
Individual files can be copied when their legacy directory is shared by campaigns.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _checked_entry(entry: dict) -> tuple[Path, Path, Path]:
    scope = Path(entry["brand_root"]).resolve(strict=True)
    source = Path(entry["source"]).absolute()
    target = Path(entry["target"]).absolute()
    if not source.resolve().is_relative_to(scope) or not target.resolve().is_relative_to(scope):
        raise ValueError("Both paths must stay inside the explicitly selected brand folder.")
    if source == scope or target == scope or source == target:
        raise ValueError("Migration must name distinct script locations, never a brand root.")
    if target.resolve().is_relative_to(source.resolve()) and target.resolve() != source.resolve():
        raise ValueError("Cannot move scripts into their own descendant.")
    if entry["type"] not in ("directory", "copy_file"):
        raise ValueError("Expected directory or copy_file migration.")
    if entry["type"] == "directory":
        if target.exists() and source.exists() and os.path.samefile(source, target):
            return scope, source, target
        if not source.is_dir() or target.exists():
            raise ValueError(f"Source folder missing or destination already exists: {source} -> {target}")
    elif not source.is_file() or (target.exists() and _digest(source) != _digest(target)):
        raise ValueError(f"Source file missing or destination has different content: {source} -> {target}")
    return scope, source, target


def _legacy_directory_link(link: Path, target: Path) -> None:
    if os.name == "nt":
        env = dict(os.environ, EDITFLOW_MIGRATION_LINK=str(link), EDITFLOW_MIGRATION_TARGET=str(target))
        subprocess.run([
            "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
            "New-Item -ItemType Junction -Path $env:EDITFLOW_MIGRATION_LINK -Target $env:EDITFLOW_MIGRATION_TARGET -ErrorAction Stop | Out-Null",
        ], env=env, check=True, capture_output=True, text=True)
    else:
        link.symlink_to(target, target_is_directory=True)


def migrate(entries: list[dict], apply: bool = False) -> list[dict]:
    # Validate the full map before changing any source directory.
    checked = [_checked_entry(entry) for entry in entries]
    results = []
    for entry, (scope, source, target) in zip(entries, checked):
        if target.exists() and (entry["type"] == "copy_file" or os.path.samefile(source, target)):
            results.append({**entry, "status": "already_organized"})
            continue
        if not apply:
            results.append({**entry, "status": "planned"})
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.parent.resolve().is_relative_to(scope):
            raise ValueError("Destination escaped the selected brand folder.")
        if entry["type"] == "copy_file":
            shutil.copy2(source, target)
            if _digest(source) != _digest(target):
                raise RuntimeError(f"Copy verification failed: {target}")
            results.append({**entry, "status": "copied", "legacy_original_preserved": True})
            continue
        hashes = {str(p.relative_to(source)): _digest(p) for p in source.rglob("*") if p.is_file()}
        os.rename(source, target)
        try:
            _legacy_directory_link(source, target)
        except Exception:
            os.rename(target, source)
            raise
        if any(_digest(target / rel) != digest or _digest(source / rel) != digest for rel, digest in hashes.items()):
            raise RuntimeError(f"Migration verification failed: {target}")
        results.append({**entry, "status": "moved_with_legacy_link", "verified_files": len(hashes)})
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--report")
    args = parser.parse_args()
    entries = json.loads(Path(args.plan).read_text(encoding="utf-8"))["migrations"]
    result = {"applied": args.apply, "migrations": migrate(entries, args.apply)}
    output = json.dumps(result, indent=2, ensure_ascii=False)
    if args.report:
        Path(args.report).write_text(output + "\n", encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()
