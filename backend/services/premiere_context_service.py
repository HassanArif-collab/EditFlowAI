"""
Durable Premiere project context storage for bin/item reference resolution.
"""
from __future__ import annotations

import hashlib
import re
from typing import Any, Dict, List

from ..models.sqlite_registry import sqlite_registry as db
from ..models.v2_schemas import AssetRegisterRequest, utc_now
from ..services.v2_registry_service import v2_registry_service


class PremiereContextService:
    def save_project_context(self, context: Dict[str, Any]) -> Dict[str, Any]:
        now = utc_now()
        bins = context.get("bins") or []
        items = context.get("items") or []

        db.execute("DELETE FROM premiere_bins")
        db.execute("DELETE FROM premiere_project_items")

        for bin_item in bins:
            name = str(bin_item.get("name") or "")
            bin_path = self._normalize_bin_path(bin_item.get("bin_path") or bin_item.get("binPath") or name)
            if not bin_path:
                continue
            bin_id = self._id("pbin", bin_path)
            db.execute(
                """
                INSERT INTO premiere_bins(id, name, bin_path, item_id, child_count, depth, metadata, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    bin_id,
                    name or bin_path.split("/")[-1],
                    bin_path,
                    str(bin_item.get("itemId") or bin_item.get("item_id") or ""),
                    int(bin_item.get("childCount") or bin_item.get("child_count") or 0),
                    int(bin_item.get("depth") or 0),
                    db.dumps(bin_item),
                    now,
                ),
            )
            db.upsert_fts("premiere_bin", bin_id, bin_path, name)

        for item in items:
            name = str(item.get("name") or "")
            media_path = str(item.get("mediaPath") or item.get("media_path") or "")
            bin_path = self._normalize_bin_path(item.get("bin_path") or item.get("binPath") or "")
            item_id = str(item.get("itemId") or item.get("item_id") or "")
            stable = item_id or media_path or f"{bin_path}/{name}"
            row_id = self._id("pitem", stable)
            media_type = str(item.get("mediaType") or item.get("media_type") or "")
            db.execute(
                """
                INSERT INTO premiere_project_items(
                    id, item_id, name, media_path, media_type, bin_path, duration,
                    has_video, has_audio, metadata, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row_id,
                    item_id,
                    name,
                    media_path,
                    media_type,
                    bin_path,
                    float(item.get("duration") or 0),
                    1 if self._item_has_media(item, "video") else 0,
                    1 if self._item_has_media(item, "audio") else 0,
                    db.dumps(item),
                    now,
                ),
            )
            db.upsert_fts("premiere_project_item", row_id, name, f"{bin_path} {media_path} {media_type}")

        return {
            "success": True,
            "bin_count": len(bins),
            "item_count": len(items),
            "updated_at": now,
        }

    def find_bin(self, bin_path: str) -> Dict[str, Any] | None:
        normalized = self._normalize_bin_path(bin_path)
        row = db.fetch_one("SELECT * FROM premiere_bins WHERE lower(bin_path) = lower(?)", (normalized,))
        if row:
            row["metadata"] = db.loads(row.get("metadata"), {})
        return row

    def find_bin_fuzzy(self, parent_alias: str, child_name: str) -> Dict[str, Any] | None:
        parent = self._normalize_bin_path(parent_alias)
        child = self._normalize_bin_path(child_name)
        candidates = [
            f"{parent}/{child}",
            f"{parent}/folder {child}",
            f"{parent}/Folder {child}",
        ]
        for candidate in candidates:
            found = self.find_bin(candidate)
            if found:
                return found
        rows = db.fetch_all(
            """
            SELECT * FROM premiere_bins
            WHERE lower(bin_path) LIKE lower(?)
            ORDER BY length(bin_path)
            LIMIT 1
            """,
            (f"%{parent}%{child}%",),
        )
        if rows:
            rows[0]["metadata"] = db.loads(rows[0].get("metadata"), {})
            return rows[0]
        return None

    def list_bins(self, limit: int = 200) -> List[Dict[str, Any]]:
        rows = db.fetch_all(
            """
            SELECT * FROM premiere_bins
            ORDER BY lower(bin_path)
            LIMIT ?
            """,
            (limit,),
        )
        for row in rows:
            row["metadata"] = db.loads(row.get("metadata"), {})
        return rows

    def items_in_bin(self, bin_path: str, recursive: bool = False) -> List[Dict[str, Any]]:
        normalized = self._normalize_bin_path(bin_path)
        if recursive:
            rows = db.fetch_all(
                """
                SELECT * FROM premiere_project_items
                WHERE lower(bin_path) = lower(?) OR lower(bin_path) LIKE lower(?)
                ORDER BY bin_path, name
                """,
                (normalized, f"{normalized}/%"),
            )
        else:
            rows = db.fetch_all(
                """
                SELECT * FROM premiere_project_items
                WHERE lower(bin_path) = lower(?)
                ORDER BY name
                """,
                (normalized,),
            )
        for row in rows:
            row["metadata"] = db.loads(row.get("metadata"), {})
        return rows

    def register_bin_items_as_assets(self, bin_path: str, recursive: bool = False) -> List[Dict[str, Any]]:
        assets = []
        for item in self.items_in_bin(bin_path, recursive=recursive):
            media_path = item.get("media_path") or ""
            if not media_path:
                continue
            assets.append(
                v2_registry_service.register_asset(
                    AssetRegisterRequest(
                        path=media_path,
                        source_type="premiere_bin",
                        name=item.get("name") or None,
                        tags=["premiere", "bin"],
                        metadata={
                            "premiere_item_id": item.get("item_id"),
                            "bin_path": item.get("bin_path"),
                            "premiere_name": item.get("name"),
                        },
                    )
                )
            )
        return assets

    def _normalize_bin_path(self, value: Any) -> str:
        text = str(value or "").strip().replace("\\", "/")
        text = re.sub(r"/+", "/", text)
        return text.strip("/")

    def _item_has_media(self, item: Dict[str, Any], media_kind: str) -> bool:
        if item.get(f"has_{media_kind}") is True:
            return True
        media_type = str(item.get("mediaType") or item.get("media_type") or "").lower()
        if media_kind == "video":
            return media_type in {"video", "av"} or "video" in media_type
        if media_kind == "audio":
            return media_type in {"audio", "av"} or "audio" in media_type
        return False

    def _id(self, prefix: str, seed: str) -> str:
        return f"{prefix}_{hashlib.sha1(seed.encode('utf-8')).hexdigest()[:12]}"


premiere_context_service = PremiereContextService()
