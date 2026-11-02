"""Recheck the reviewed files immediately before sending timeline operations."""
import hashlib
import math
from pathlib import Path

from .media_framing import source_facts


def validate_review(plan: dict) -> dict:
    errors = []
    if plan.get("validation", {}).get("valid") is False:
        errors.extend(plan["validation"].get("errors", []))
    script = plan.get("script_path")
    if script:
        path = Path(script)
        if not path.is_file() or hashlib.sha256(path.read_text(encoding="utf-8").encode()).hexdigest() != plan.get("script_revision"):
            errors.append({"message": "The script changed or was removed. Compile it again."})
        sidecar = path.with_suffix(".editflow.json")
        revision = hashlib.sha256(sidecar.read_bytes()).hexdigest() if sidecar.is_file() else ""
        if revision != plan.get("execution_revision", ""):
            errors.append({"message": "The execution sidecar changed. Compile it again."})
    rows = [c for c in plan.get("cuts", []) if c.get("source_file")] + plan.get("broll_clips", [])
    for row in rows:
        path = Path(row.get("source_file", ""))
        if not path.is_file():
            errors.append({"message": f"Source removed: {path}"})
            continue
        stat = path.stat()
        revision = row.get("source_revision")
        if revision and revision != f"{stat.st_size}:{stat.st_mtime_ns}":
            errors.append({"message": f"Source changed after review: {path.name}. Compile again."})
        start, end = float(row.get("source_in", 0)), float(row.get("source_out", 0))
        if not all(math.isfinite(v) for v in (start, end)) or start < 0 or end <= start:
            errors.append({"message": f"Invalid source range: {path.name}"})
        if path.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp", ".tiff", ".bmp", ".psd"):
            duration = source_facts(str(path)).get("duration", 0)
            if duration > 0 and end > duration + 1 / float(plan.get("fps") or 30):
                errors.append({"message": f"Source range exceeds media duration: {path.name}"})
    return {"success": True, "valid": not errors, "errors": errors}
