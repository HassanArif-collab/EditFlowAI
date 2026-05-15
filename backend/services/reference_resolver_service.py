"""
Reference resolver for human editing references.
Turns phrases like "folder 6 in the raw folder" into exact Premiere bins or local paths/assets.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..models.sqlite_registry import sqlite_registry as db
from ..models.v2_schemas import (
    AssetRegisterRequest,
    FolderScanRequest,
    ReferenceResolveRequest,
    ReferenceRootRequest,
    utc_now,
)
from ..services.premiere_context_service import premiere_context_service
from ..services.v2_registry_service import MEDIA_EXTS, v2_registry_service


class ReferenceResolverService:
    ROOT_ALIASES = {
        "raw": ["raw", "raw folder", "raw files", "raw footage"],
        "broll": ["broll", "b-roll", "b roll", "visuals"],
    }

    def set_root(self, request: ReferenceRootRequest) -> Dict[str, Any]:
        alias = self._normalize_alias(request.alias)
        path = Path(request.path).expanduser()
        resolved = path.resolve() if path.exists() else path
        now = utc_now()
        existing = db.fetch_one("SELECT * FROM reference_roots WHERE alias = ?", (alias,))
        db.execute(
            """
            INSERT INTO reference_roots(alias, path, description, metadata, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(alias) DO UPDATE SET
                path=excluded.path,
                description=excluded.description,
                metadata=excluded.metadata,
                updated_at=excluded.updated_at
            """,
            (
                alias,
                str(resolved),
                request.description,
                db.dumps(request.metadata),
                existing["created_at"] if existing else now,
                now,
            ),
        )
        db.upsert_fts("reference_root", alias, alias, f"{resolved} {request.description}")
        return self.get_root(alias)

    def get_root(self, alias: str) -> Dict[str, Any]:
        row = db.fetch_one("SELECT * FROM reference_roots WHERE alias = ?", (self._normalize_alias(alias),))
        if not row:
            raise KeyError(f"Reference root not configured: {alias}")
        row["metadata"] = db.loads(row.get("metadata"), {})
        row["exists"] = Path(row["path"]).exists()
        return row

    def list_roots(self) -> List[Dict[str, Any]]:
        rows = db.fetch_all("SELECT * FROM reference_roots ORDER BY alias")
        for row in rows:
            row["metadata"] = db.loads(row.get("metadata"), {})
            row["exists"] = Path(row["path"]).exists()
        return rows

    def resolve(self, request: ReferenceResolveRequest) -> Dict[str, Any]:
        text = request.text or ""
        explicit_bin = self._extract_explicit_bin(text)
        if explicit_bin:
            return self._resolve_bin_path(explicit_bin, request)

        explicit_path = self._extract_explicit_path(text)
        if explicit_path and request.kind not in {"bin", "premiere_bin"}:
            return self._resolve_folder_path(explicit_path, request)

        alias = self._normalize_alias(request.root_alias or self._infer_root_alias(text))
        folder_name = (request.folder_name or self._extract_folder_name(text)).strip()
        should_try_bin = (
            request.kind in {"bin", "premiere_bin", "bin_or_folder"}
            or (
                request.kind not in {"folder", "local_folder"}
                and alias
                and folder_name
            )
            or self._looks_like_premiere_bin_reference(text)
        )
        if should_try_bin:
            bin_result = self._resolve_bin_reference(request)
            if bin_result.get("success") or request.kind in {"bin", "premiere_bin"}:
                return bin_result

        if not alias:
            return self._unresolved(
                text,
                ["root_alias"],
                "I could not tell which Premiere bin or root folder you meant. Use @bin:Raw/6 or set a root like raw = F:\\Project\\raw.",
            )

        root = db.fetch_one("SELECT * FROM reference_roots WHERE alias = ?", (alias,))
        if not root:
            return self._unresolved(
                text,
                [f"reference_root:{alias}"],
                f"The {alias} folder is not configured yet. Set it in the V2 panel or POST /api/references/roots.",
            )

        root_path = Path(root["path"])
        if not root_path.exists():
            return self._unresolved(
                text,
                [f"missing_path:{root_path}"],
                f"The configured {alias} folder does not exist: {root_path}",
            )

        if not folder_name:
            return self._resolve_folder_path(root_path, request, root_alias=alias)

        candidates = [
            root_path / folder_name,
            root_path / f"folder {folder_name}",
            root_path / f"Folder {folder_name}",
        ]
        for candidate in candidates:
            if candidate.exists() and candidate.is_dir():
                return self._resolve_folder_path(candidate, request, root_alias=alias, folder_name=folder_name)

        return self._unresolved(
            text,
            [f"folder:{folder_name}"],
            f"I found the {alias} root, but not folder '{folder_name}' inside {root_path}.",
            root_alias=alias,
            root_path=str(root_path),
        )

    def _resolve_folder_path(
        self,
        folder_path: Path,
        request: ReferenceResolveRequest,
        root_alias: str = "",
        folder_name: str = "",
    ) -> Dict[str, Any]:
        path = Path(folder_path).expanduser()
        resolved = path.resolve() if path.exists() else path
        if not resolved.exists() or not resolved.is_dir():
            return self._unresolved(
                request.text,
                [f"missing_path:{resolved}"],
                f"Folder does not exist: {resolved}",
                root_alias=root_alias,
            )

        media_files = self._media_files(resolved, request.recursive)
        assets = []
        if request.register_assets:
            for file_path in media_files:
                assets.append(
                    v2_registry_service.register_asset(
                        AssetRegisterRequest(
                            path=str(file_path),
                            source_type="resolved_folder",
                            tags=[tag for tag in [root_alias, "resolved"] if tag],
                        )
                    )
                )

        return {
            "success": True,
            "kind": "folder",
            "text": request.text,
            "root_alias": root_alias,
            "folder_name": folder_name,
            "resolved_path": str(resolved),
            "media_count": len(media_files),
            "media_paths": [str(p) for p in media_files],
            "asset_ids": [a["id"] for a in assets],
            "assets": assets,
            "warnings": [] if media_files else ["No usable media files found in the resolved folder."],
        }

    def _resolve_bin_reference(self, request: ReferenceResolveRequest) -> Dict[str, Any]:
        text = request.text or ""
        explicit_bin = self._extract_explicit_bin(text)
        if explicit_bin:
            return self._resolve_bin_path(explicit_bin, request)

        parent = self._normalize_alias(request.root_alias or self._infer_root_alias(text))
        folder_name = (request.folder_name or self._extract_folder_name(text)).strip()
        if not parent or not folder_name:
            return self._unresolved(
                text,
                ["bin_reference"],
                "I could not resolve the Premiere bin. Use @bin:Raw/6 or mention the parent bin and child folder.",
            )

        bin_row = premiere_context_service.find_bin_fuzzy(parent, folder_name)
        if not bin_row:
            return self._unresolved(
                text,
                [f"bin:{parent}/{folder_name}"],
                f"I could not find Premiere bin {parent}/{folder_name}. Click Scan Project first or check the bin name.",
                root_alias=parent,
            )
        return self._resolve_bin_path(bin_row["bin_path"], request)

    def _resolve_bin_path(self, bin_path: str, request: ReferenceResolveRequest) -> Dict[str, Any]:
        found = premiere_context_service.find_bin(bin_path)
        if not found:
            return self._unresolved(
                request.text,
                [f"bin:{bin_path}"],
                f"I could not find Premiere bin {bin_path}. Click Scan Project first or check the bin path.",
            )

        items = premiere_context_service.items_in_bin(found["bin_path"], recursive=request.recursive)
        assets = (
            premiere_context_service.register_bin_items_as_assets(found["bin_path"], recursive=request.recursive)
            if request.register_assets else []
        )
        usable_items = [item for item in items if item.get("media_path")]
        return {
            "success": True,
            "kind": "bin",
            "text": request.text,
            "bin_path": found["bin_path"],
            "resolved_path": found["bin_path"],
            "media_count": len(usable_items),
            "items": items,
            "asset_ids": [asset["id"] for asset in assets],
            "assets": assets,
            "warnings": [] if usable_items else ["No usable media-path clips found in the resolved Premiere bin."],
        }

    def _media_files(self, folder: Path, recursive: bool) -> List[Path]:
        iterator = folder.rglob("*") if recursive else folder.iterdir()
        return sorted(
            p for p in iterator
            if p.is_file() and p.suffix.lower() in MEDIA_EXTS and MEDIA_EXTS[p.suffix.lower()] in {"video", "audio", "image"}
        )

    def _unresolved(
        self,
        text: str,
        missing: List[str],
        message: str,
        root_alias: str = "",
        root_path: str = "",
    ) -> Dict[str, Any]:
        return {
            "success": False,
            "kind": "unresolved",
            "text": text,
            "root_alias": root_alias,
            "root_path": root_path,
            "missing": missing,
            "message": message,
            "suggestions": [
                "Click Scan Project in the V2 panel so Premiere bins are indexed.",
                "Use an exact Premiere bin reference, for example @bin:Raw/6.",
                "Set the raw root in the V2 panel.",
                "Use an exact folder path, for example F:\\Project\\raw\\6.",
                "Use @folder:path when chatting, for example @folder:F:\\Project\\raw\\6.",
            ],
        }

    def _extract_explicit_path(self, text: str) -> Optional[Path]:
        folder_ref = re.search(r"@folder:([A-Za-z]:\\[^\n\r\"']+)", text)
        if folder_ref:
            return Path(folder_ref.group(1).strip())
        path_ref = re.search(r"([A-Za-z]:\\[^\n\r\"']+)", text)
        if path_ref:
            return Path(path_ref.group(1).strip())
        return None

    def _extract_explicit_bin(self, text: str) -> str:
        quoted = re.search(r"@bin:(?:\"([^\"]+)\"|'([^']+)')", text, flags=re.IGNORECASE)
        if quoted:
            return (quoted.group(1) or quoted.group(2) or "").strip().strip("/")
        match = re.search(r"@bin:([^\s,;]+)", text, flags=re.IGNORECASE)
        return match.group(1).strip().strip("/") if match else ""

    def _looks_like_premiere_bin_reference(self, text: str) -> bool:
        lowered = text.lower()
        return (
            "@bin:" in lowered
            or "bin" in lowered
            or "premiere" in lowered
            or "pr pro" in lowered
            or "project panel" in lowered
        )

    def _infer_root_alias(self, text: str) -> str:
        lowered = text.lower()
        for alias, phrases in self.ROOT_ALIASES.items():
            if any(phrase in lowered for phrase in phrases):
                return alias
        return ""

    def _extract_folder_name(self, text: str) -> str:
        match = re.search(r"\bfolder\s+([A-Za-z0-9_.-]+)", text, flags=re.IGNORECASE)
        if match:
            return match.group(1)
        return ""

    def _normalize_alias(self, alias: Optional[str]) -> str:
        value = (alias or "").strip().lower()
        value = value.replace(" folder", "")
        return re.sub(r"[^a-z0-9_-]+", "_", value).strip("_")


reference_resolver_service = ReferenceResolverService()
