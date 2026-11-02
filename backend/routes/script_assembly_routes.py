"""
EditFlow AI - Script Assembly API Routes
Endpoints for compiling Markdown scripts (CUT LIST tables and ad scenes) into
multi-track rough cut plans and ExtendScript EDL operations for Premiere Pro.
"""
from __future__ import annotations

import logging
import asyncio
import threading
import hashlib
import os
from pathlib import Path
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..services.script_assembly_service import script_assembly_service, AssembledScriptPlan
from ..services.media_resolver import media_resolver
from ..services.project_scripts import (
    ensure_scripts_folder, list_brand_projects, list_project_scripts, resolve_project_folder,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/script-assembly", tags=["script-assembly"])
_compile_lock = threading.RLock()


class CompileScriptRequest(BaseModel):
    script_content: Optional[str] = None
    script_path: Optional[str] = None
    script_filename: Optional[str] = None
    project_folder: Optional[str] = None
    brand: Optional[str] = None
    variant_id: str = "primary"
    allow_ai_generated: bool = False
    script_id: Optional[str] = "Script"
    title: Optional[str] = "Rough Cut"
    aspect_ratio: Optional[str] = "9:16"
    fps: Optional[float] = 30.0
    auto_broll: Optional[bool] = True
    pacing_style: Optional[str] = "editorial"


class PlanToOpsRequest(BaseModel):
    plan: Dict[str, Any]
    target_sequence_name: Optional[str] = None


class ProjectFolderRequest(BaseModel):
    project_folder: str


@router.get('/script-catalog')
def script_catalog(brand: str, query: str = '', project_folder: Optional[str] = None):
    from ..services.script_catalog import list_script_catalog
    try:
        return list_script_catalog(brand, query, project_folder)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.get('/script-reference')
def script_reference(brand: str, path: str):
    from ..services.script_catalog import read_catalog_script
    from ..services.script_sources import ScriptConflictError
    try:
        return read_catalog_script(brand, path)
    except ScriptConflictError as exc:
        raise HTTPException(409, str(exc))
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.post("/validate-plan")
def validate_reviewed_plan(req: PlanToOpsRequest) -> Dict[str, Any]:
    from ..services.review_validation import validate_review
    return validate_review(req.plan)


class FramingRequest(BaseModel):
    source_file: str
    width: int = Field(1080, gt=0)
    height: int = Field(1920, gt=0)
    fit_mode: str = "fill"
    zoom: float = Field(1, ge=1, le=3, allow_inf_nan=False)
    focal_point: Optional[List[float]] = None


@router.post("/framing")
def source_framing(req: FramingRequest) -> Dict[str, Any]:
    if not Path(req.source_file).is_file():
        raise HTTPException(404, "Source media is missing.")
    from ..services.media_framing import framing_for_file, source_facts
    if req.fit_mode not in ("fill", "contain"):
        raise HTTPException(400, "Choose fill or contain framing.")
    if req.focal_point and (len(req.focal_point) != 2 or any(not 0 <= v <= 1 for v in req.focal_point)):
        raise HTTPException(400, "Focal coordinates must be two normalized values from 0 to 1.")
    return {"success": True, "source": source_facts(req.source_file),
            "framing": framing_for_file(req.source_file, req.width, req.height, req.fit_mode, req.zoom, req.focal_point)}


def _resolve_script_input(req: CompileScriptRequest) -> str:
    if req.script_path:
        from ..services.script_sources import current_script
        path = current_script(Path(req.script_path).expanduser())
        if not path.is_file():
            raise HTTPException(status_code=404, detail=f"Script file not found: {path}")
        if req.project_folder:
            project = resolve_project_folder(req.project_folder)
            if not path.is_relative_to(project):
                # A migrated legacy Scripts directory may be a compatibility junction.
                linked = list_project_scripts(project)["scripts"]
                if not any(Path(script["full_path"]).resolve() == path for script in linked):
                    raise HTTPException(status_code=400, detail="The selected script belongs to another project.")
        return str(path)
    if req.script_content:
        return req.script_content
    if req.script_filename:
        folder = req.project_folder or media_resolver.root_dir
        if not folder:
            raise HTTPException(status_code=400, detail="project_folder is required to resolve a script filename.")
        matches = [
            script["full_path"] for script in list_project_scripts(folder)["scripts"]
            if script["name"].casefold() == req.script_filename.casefold()
        ]
        if len(matches) > 1:
            raise HTTPException(status_code=409, detail="Multiple project scripts have this filename. Use script_path.")
        if matches:
            return matches[0]
        raise HTTPException(status_code=404, detail="Script not found in the selected project.")
    raise HTTPException(status_code=400, detail="Either script_path, script_filename, or script_content must be provided.")


def _prepare_media_resolver(script_input: str, project_folder: Optional[str]) -> None:
    # Script storage follows the dated project; footage may live in the brand's shared Raw Data.
    if not project_folder and not os.path.isfile(script_input):
        return
    info = list_project_scripts(project_folder or Path(script_input).parent)
    media_root = Path(info["brand_root"] or info["project_folder"]).resolve()
    current = Path(media_resolver.root_dir).resolve() if media_resolver.root_dir else None
    if current != media_root or not media_resolver._media_by_path:
        media_resolver.index_directory(root_dir=str(media_root), force=False)
    if info["brand"]:
        from ..services.visual_library_service import visual_library_service
        visual_library_service.reuse_media_index(media_resolver, info["brand"], str(media_root), info["project_folder"])


def _compile_context(req: CompileScriptRequest, script_input: str) -> Dict[str, Any]:
    folder = req.project_folder or (str(Path(script_input).parent) if os.path.isfile(script_input) else None)
    info = list_project_scripts(folder) if folder else {}
    brand = info.get("brand") or req.brand or ""
    if req.brand and brand.casefold() != req.brand.casefold():
        raise HTTPException(status_code=400, detail="The project belongs to a different brand.")
    return {"brand": brand, "project_folder": info.get("project_folder", ""),
            "variant_id": req.variant_id, "allow_ai_generated": req.allow_ai_generated}


def _compile_locked(req: CompileScriptRequest) -> Dict[str, Any]:
    with _compile_lock:
        script_input = _resolve_script_input(req)
        _prepare_media_resolver(script_input, req.project_folder)
        plan = script_assembly_service.compile_script_to_plan(
            script_input=script_input, script_id=req.script_id or "Script", title=req.title or "Rough Cut",
            aspect_ratio=req.aspect_ratio or "9:16", fps=float(req.fps or 30), auto_broll=bool(req.auto_broll),
            pacing_style=req.pacing_style or "editorial", **_compile_context(req, script_input))
        name = f"Rough Cut - {plan.title}"
        ops = script_assembly_service.plan_to_edl_ops(plan, target_seq_name=name)
        return {"success": True, "plan": plan.to_dict(), "target_sequence_name": name, "edl_ops": ops,
                "total_ops": len(ops), "ready_to_assemble": plan.validation["valid"] and bool(ops)}


@router.post("/compile")
async def compile_script(req: CompileScriptRequest) -> Dict[str, Any]:
    try:
        # File indexing/probing must not block the event loop serving the CEP bridge.
        # The resolver is shared, so brand selection and compilation are one locked unit.
        return await asyncio.to_thread(_compile_locked, req)
    except HTTPException:
        raise
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        logger.exception("Script compilation failed")
        raise HTTPException(500, str(exc)) from exc


@router.post("/assemble")
async def compile_and_generate_ops(req: CompileScriptRequest) -> Dict[str, Any]:
    result = await compile_script(req)
    result["extendscript_ops"] = result["edl_ops"]
    return result


@router.get("/authoring-context")
def authoring_context(project_folder: str = Query(...)) -> Dict[str, Any]:
    from ..services.brand_context import project_context
    info = project_context(project_folder)
    with _compile_lock:
        _prepare_media_resolver("", info["project_folder"])
        from ..services.visual_library_service import visual_library_service
        assets = []
        transcripts = []
        for item in media_resolver._media_by_path.values():
            if visual_library_service._preview_asset(item.path):
                continue
            row = {"path": item.path, "name": item.name, "stem": item.stem, "kind": item.file_type,
                   "duration": item.duration, "speaker": item.speaker}
            if item.file_type == "transcript":
                transcripts.append(row)
            elif item.file_type in ("video", "audio", "image"):
                assets.append(row)
        return {"success": True, **info, "media_root": media_resolver.root_dir,
                "assets": assets, "transcripts": transcripts,
                "visuals": visual_library_service.query_items(brand=info["brand"], limit=5000) if info["brand"] else [],
                "execution_schema": "docs/agent-script-package.schema.json",
                "workflow": ["Read the brand/project production rules and source transcripts.",
                    "Write the readable script into this project's Scripts folder.",
                    "Quote recorded speech exactly. Label generated narration separately.",
                    "Link real media and exact source ranges in an optional matching .editflow.json sidecar.",
                    "Compile, resolve validation errors, review the storyboard, then build a new sequence."]}


@router.get("/project-context")
def get_project_context(project_folder: str = Query(...)) -> Dict[str, Any]:
    from ..services.brand_context import project_context
    try:
        return {"success": True, **project_context(project_folder)}
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/scripts")
def list_available_scripts(
    folder_path: Optional[str] = Query(None, description="Optional custom folder path to look for scripts"),
) -> Dict[str, Any]:
    """List only the chosen project's scripts, including when its folder is empty."""
    search_dir = folder_path or media_resolver.root_dir
    if not search_dir:
        raise HTTPException(status_code=400, detail="Choose a project folder first.")
    try:
        return list_project_scripts(search_dir)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/projects")
async def available_projects(brand: str = Query(...)) -> Dict[str, Any]:
    try:
        return list_brand_projects(brand)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/scripts-folder")
async def create_scripts_folder(req: ProjectFolderRequest) -> Dict[str, Any]:
    try:
        return ensure_scripts_folder(req.project_folder)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@router.get("/script-content")
async def get_script_content(path: str = Query(..., description="Path to script markdown file")) -> Dict[str, Any]:
    """Read the full content of a script markdown file."""
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"Script file not found: {path}")

    try:
        from ..services.script_sources import current_script, ScriptConflictError
        path = str(current_script(path))
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()
        sidecar = Path(path).with_suffix(".editflow.json")
        return {"success": True, "path": path, "content": content, "revision": hashlib.sha256(content.encode("utf-8")).hexdigest(),
                "execution_revision": hashlib.sha256(sidecar.read_bytes()).hexdigest() if sidecar.is_file() else ""}
    except ScriptConflictError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
