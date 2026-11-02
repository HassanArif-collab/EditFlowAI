"""Project-local script discovery; media libraries can remain shared by a brand."""
from __future__ import annotations

import os
import re
from datetime import date
from pathlib import Path
from typing import Any
import json
import uuid
import shutil
import threading

from ..config import get_settings

_DATE_PREFIX = re.compile(r"^(\d{4})-+(\d{1,2})-(\d{1,2})(?:\D|$)")
_PROJECT_SUBFOLDERS = {
    "scripts", "scripts_15_30_45", "finals", "exports", "premiere",
    "premiere projects", "project files", "adobe premiere pro auto-save",
}
_IGNORED_NAMES = {
    "readme", "agents", "claude", "index", "instructions",
    "person_crossreference", "talking_segments", "agent_handoff",
}
_IGNORED_DIRS = {
    "node_modules", "__pycache__", "frame_samples", "thumbs", "thumbnails",
    "archive", "archives", "archived", "scratch",
}
_links_lock = threading.RLock()


def _validate_linked_script(project: Path, value: str) -> Path:
    path = (project / value).resolve()
    brand = _brand_root(project)
    if not brand or not path.is_relative_to(brand):
        raise ValueError('A linked script must stay inside the selected brand.')
    if not _is_script(path):
        raise ValueError('Link a Markdown script, not an instruction or index file.')
    relative = path.relative_to(brand)
    if project_date(relative.parts[0]) and brand / relative.parts[0] != project:
        raise ValueError('This script is stored in another production project. Create a project version instead.')
    return path


def _linked_script_paths(project: Path) -> list[Path]:
    profile = project / 'editflow.project.json'
    if not profile.is_file():
        return []
    values = json.loads(profile.read_text(encoding='utf-8-sig')).get('linked_scripts', [])
    if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
        raise ValueError('linked_scripts must be a list of script paths.')
    return [_validate_linked_script(project, value) for value in values]


def link_existing_project_scripts(folder: str, scripts: list[str], apply: bool = False) -> dict:
    """Explicitly assign existing legacy files without making another editable copy."""
    from .script_sources import _write
    project = resolve_project_folder(folder)
    brand = _brand_root(project)
    paths = [_validate_linked_script(project, value) for value in scripts]
    if any(not path.is_file() for path in paths):
        raise FileNotFoundError('An explicitly linked script is missing.')
    for other in brand.iterdir():
        if other == project or not other.is_dir() or not project_date(other.name):
            continue
        owned = {Path(row['full_path']).resolve() for row in list_project_scripts(other)['scripts']}
        if any(path in owned for path in paths):
            raise ValueError(f'A script is already assigned to {other.name}.')
    with _links_lock:
        profile = project / 'editflow.project.json'
        before = profile.read_text(encoding='utf-8-sig') if profile.is_file() else None
        data = json.loads(before) if before is not None else {}
        values = data.setdefault('linked_scripts', [])
        if not isinstance(values, list):
            raise ValueError('linked_scripts must be a list of script paths.')
        existing = {(project / value).resolve() for value in values}
        for path in paths:
            if path not in existing:
                values.append(os.path.relpath(path, project))
                existing.add(path)
        result = {'applied': apply, 'project_folder': str(project), 'linked_scripts': values}
        if apply:
            if (profile.read_text(encoding='utf-8-sig') if profile.is_file() else None) != before:
                raise ValueError('Project settings changed during assignment. Retry.')
            if profile.is_file():
                backup = getattr(get_settings(), 'DATA_DIR', project / '.editflow') / 'output/script-assignment-backups' / uuid.uuid4().hex
                backup.mkdir(parents=True)
                shutil.copy2(profile, backup / profile.name)
                result['backup'] = str(backup)
            _write(profile, json.dumps(data, indent=2))
        return result


def project_date(name: str) -> str:
    match = _DATE_PREFIX.match(name)
    if not match:
        return ""
    try:
        return date(*(int(part) for part in match.groups())).isoformat()
    except ValueError:
        return ""


def resolve_project_folder(folder: str | Path) -> Path:
    """Recognize a dated project even when Premiere is saved under Finals/."""
    root = Path(str(folder).strip().strip('"')).expanduser().resolve()
    if root.is_file():
        root = root.parent
    if not root.is_dir():
        raise FileNotFoundError(f"Project folder not found: {root}")
    for candidate in (root, *root.parents):
        if project_date(candidate.name):
            return candidate
    while root.name.casefold() in _PROJECT_SUBFOLDERS and root.parent != root:
        root = root.parent
    return root


def _brand_root(project: Path) -> Path | None:
    brands_root = get_settings().BRANDS_ROOT.expanduser().resolve()
    try:
        relative = project.relative_to(brands_root)
    except ValueError:
        return None
    return brands_root / relative.parts[0] if relative.parts else None


def _scripts_folder(project: Path) -> Path:
    children = {child.name.casefold(): child for child in project.iterdir() if child.is_dir()}
    return children.get("scripts") or children.get("scripts_15_30_45") or project / "Scripts"


def _is_script(path: Path) -> bool:
    return (
        path.suffix.casefold() == ".md"
        and not path.name.startswith((".", "00_"))
        and path.stem.casefold() not in _IGNORED_NAMES
        and not path.stem.casefold().startswith("readme")
    )


def list_project_scripts(folder: str | Path) -> dict[str, Any]:
    project = resolve_project_folder(folder)
    scripts_folder = _scripts_folder(project)
    paths: list[Path] = []
    if scripts_folder.is_dir():
        for current, dirs, files in os.walk(scripts_folder, followlinks=False):
            dirs[:] = sorted(
                d for d in dirs
                if not d.startswith((".", "_")) and d.casefold() not in _IGNORED_DIRS
            )
            paths.extend(Path(current) / name for name in files if _is_script(Path(name)))
    # Support existing project-local scripts without crawling Visuals/ or other projects.
    paths.extend(path for path in project.iterdir() if path.is_file() and _is_script(path))
    linked = _linked_script_paths(project)
    paths.extend(path for path in linked if path.is_file())
    scripts = []
    for path in sorted(set(paths), key=lambda p: (p.name.casefold(), str(p).casefold())):
        base = scripts_folder if path.is_relative_to(scripts_folder) else (project if path.is_relative_to(project) else path.parent)
        relative = path.relative_to(base)
        scripts.append({
            "name": path.name,
            "rel_path": str(relative),
            "full_path": str(path),
            "category": "Linked" if path in linked else (relative.parts[0] if len(relative.parts) > 1 else "General"),
        })
    brand_root = _brand_root(project)
    return {
        "success": True,
        "project_folder": str(project),
        "project_name": project.name,
        "brand": brand_root.name if brand_root else "",
        "brand_root": str(brand_root) if brand_root else "",
        "scripts_folder": str(scripts_folder),
        "folder": str(scripts_folder),
        "scripts": scripts,
        "total": len(scripts),
        "missing_linked_scripts": [str(path) for path in linked if not path.is_file()],
    }


def list_brand_projects(brand: str) -> dict[str, Any]:
    if not brand or brand in (".", "..") or any(c in brand for c in "/\\:"):
        raise ValueError("Choose a valid brand name.")
    root = get_settings().BRANDS_ROOT.expanduser().resolve() / brand
    if not root.is_dir():
        raise FileNotFoundError(f"Brand folder not found: {root}")
    projects = []
    for folder in root.iterdir():
        dated = project_date(folder.name)
        if folder.is_dir() and dated:
            info = list_project_scripts(folder)
            projects.append({
                "name": folder.name,
                "path": str(folder),
                "date": dated,
                "scripts_folder": info["scripts_folder"],
                "script_count": info["total"],
            })
    projects.sort(key=lambda p: (p["date"], p["name"].casefold()), reverse=True)
    return {"success": True, "brand": brand, "brand_root": str(root), "projects": projects}


def ensure_scripts_folder(folder: str | Path) -> dict[str, Any]:
    info = list_project_scripts(folder)
    Path(info["scripts_folder"]).mkdir(parents=True, exist_ok=True)
    return info
