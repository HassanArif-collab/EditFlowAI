"""Plan persistence – saves/loads plans as JSON files on disk.

Each plan is stored as ``data/plans/{plan_id}.json``.  Writes are atomic
(write to ``.tmp`` then ``os.replace``) so a crash never leaves a partial file.
"""

import json
import logging
import os
from pathlib import Path
from typing import Optional

from ..config import get_settings

logger = logging.getLogger(__name__)


class PlanStore:
    """File-system backed store for CutPlan / plan-like objects."""

    def __init__(self, base_dir: Optional[Path] = None):
        self.base_dir = base_dir or get_settings().DATA_DIR / "plans"
        self.base_dir.mkdir(parents=True, exist_ok=True)

    # ── helpers ──────────────────────────────────────────────────────────

    def _path(self, plan_id: str) -> Path:
        return self.base_dir / f"{plan_id}.json"

    @staticmethod
    def _serialize(plan) -> str:
        """Return a JSON string for *plan*."""
        if hasattr(plan, "model_dump_json"):
            raw = plan.model_dump_json()
            # model_dump_json may already return a string
            return raw if isinstance(raw, str) else json.dumps(raw, indent=2)
        if hasattr(plan, "model_dump"):
            return json.dumps(plan.model_dump(), indent=2)
        # Fallback: vars() or __dict__
        return json.dumps(vars(plan), indent=2, default=str)

    # ── public API ───────────────────────────────────────────────────────

    def save(self, plan) -> Path:
        """Write plan to ``data/plans/{plan.plan_id}.json``. Returns the path.

        Uses atomic write (write to ``.tmp``, rename) to avoid partial writes.
        """
        plan_id = plan.plan_id
        target = self._path(plan_id)
        tmp = target.with_suffix(".json.tmp")

        payload = self._serialize(plan)

        tmp.write_text(payload, encoding="utf-8")
        os.replace(tmp, target)

        logger.info("Saved plan %s → %s", plan_id, target)
        return target

    def save_raw(self, plan_id: str, data: dict) -> Path:
        """Write a raw dict as plan JSON. Used for in-place updates (e.g. beat override).

        Uses atomic write (write to ``.tmp``, rename) to avoid partial writes.
        """
        target = self._path(plan_id)
        tmp = target.with_suffix(".json.tmp")

        payload = json.dumps(data, indent=2, default=str)

        tmp.write_text(payload, encoding="utf-8")
        os.replace(tmp, target)

        logger.info("Saved raw plan %s → %s", plan_id, target)
        return target

    def load(self, plan_id: str) -> dict:
        """Read plan from disk. Raises ``FileNotFoundError`` if missing."""
        path = self._path(plan_id)
        if not path.exists():
            raise FileNotFoundError(f"Plan not found: {plan_id}")

        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            logger.error("Corrupted plan file %s: %s", path, exc)
            raise ValueError(f"Corrupted plan file: {plan_id}") from exc

        return data

    def list(self, limit: int = 50) -> list[dict]:
        """Return ``[{plan_id, created_at, bin_reference, summary}]`` of most-recent plans.

        Reads only the metadata keys from each JSON without loading the full plan.
        """
        results: list[dict] = []

        for path in self.base_dir.glob("*.json"):
            try:
                with path.open(encoding="utf-8") as fh:
                    data = json.load(fh)
            except (json.JSONDecodeError, OSError) as exc:
                logger.warning("Skipping corrupted plan file %s: %s", path, exc)
                continue

            results.append({
                "plan_id": data.get("plan_id", path.stem),
                "created_at": data.get("created_at"),
                "bin_reference": data.get("bin_reference"),
                "summary": data.get("summary"),
            })

        # Sort newest first; push entries without created_at to the end
        results.sort(
            key=lambda r: r["created_at"] or "",
            reverse=True,
        )
        return results[:limit]

    def delete(self, plan_id: str) -> bool:
        """Delete the plan file. Returns ``True`` if deleted, ``False`` if not found."""
        path = self._path(plan_id)
        if not path.exists():
            return False
        path.unlink()
        logger.info("Deleted plan %s", plan_id)
        return True


# Module-level singleton for convenience
plan_store = PlanStore()
