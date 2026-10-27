"""
EditFlow AI - Script Assembly API Routes
Endpoints for compiling Markdown scripts (CUT LIST tables and ad scenes) into
multi-track rough cut plans and ExtendScript EDL operations for Premiere Pro.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..services.script_assembly_service import script_assembly_service, AssembledScriptPlan
from ..services.media_resolver import media_resolver

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/script-assembly", tags=["script-assembly"])


class CompileScriptRequest(BaseModel):
    script_content: Optional[str] = None
    script_path: Optional[str] = None
    script_filename: Optional[str] = None
    script_id: Optional[str] = "Script"
    title: Optional[str] = "Rough Cut"
    aspect_ratio: Optional[str] = "9:16"
    fps: Optional[float] = 30.0
    auto_broll: Optional[bool] = True
    pacing_style: Optional[str] = "editorial"


class PlanToOpsRequest(BaseModel):
    plan: Dict[str, Any]
    target_sequence_name: Optional[str] = None


@router.post("/compile")
async def compile_script(req: CompileScriptRequest) -> Dict[str, Any]:
    """Compile a Markdown script into an AssembledScriptPlan with ExtendScript EDL ops."""
    try:
        script_input = req.script_path or req.script_content
        if not script_input and req.script_filename:
            # Resolve filename across active project or media_resolver root
            roots_to_check = []
            if media_resolver.root_dir:
                roots_to_check.append(Path(media_resolver.root_dir))
            for r in roots_to_check:
                if r.exists():
                    for p in r.rglob("*.md"):
                        if p.name.lower() == req.script_filename.lower() or req.script_filename.lower() in p.name.lower():
                            script_input = str(p)
                            break
                    if script_input:
                        break
            if not script_input:
                script_input = req.script_filename

        if not script_input:
            raise HTTPException(status_code=400, detail="Either script_path, script_filename, or script_content must be provided.")

        # If compiling from a script file, ensure media_resolver indexes the parent project root
        if script_input and os.path.exists(script_input):
            script_path_obj = Path(script_input).resolve()
            curr_root = Path(media_resolver.root_dir).resolve() if media_resolver.root_dir else None
            needs_reindex = (
                not curr_root or
                not str(script_path_obj).startswith(str(curr_root)) or
                len(media_resolver._media_by_path) == 0
            )
            if needs_reindex:
                logger.info(f"[script_assembly_routes] Auto-indexing project root for script: {script_path_obj}")
                media_resolver.index_directory(root_dir=str(script_path_obj.parent), force=True)

        plan = script_assembly_service.compile_script_to_plan(
            script_input=script_input,
            script_id=req.script_id or "Script",
            title=req.title or "Rough Cut",
            aspect_ratio=req.aspect_ratio or "9:16",
            fps=float(req.fps or 30.0),
            auto_broll=bool(req.auto_broll),
            pacing_style=req.pacing_style or "editorial",
        )

        ops = script_assembly_service.plan_to_edl_ops(
            plan=plan,
            target_seq_name=f"Rough Cut - {plan.title}",
        )

        return {
            "success": True,
            "plan": plan.to_dict(),
            "target_sequence_name": f"Rough Cut - {plan.title}",
            "edl_ops": ops,
            "total_ops": len(ops),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[script_assembly_routes] Compilation error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/assemble")
async def compile_and_generate_ops(req: CompileScriptRequest) -> Dict[str, Any]:
    """One-shot: compile script and generate ExtendScript EDL operations for Premiere Pro."""
    try:
        script_input = req.script_path or req.script_content
        if not script_input:
            raise HTTPException(status_code=400, detail="Either script_path or script_content must be provided.")

        plan = script_assembly_service.compile_script_to_plan(
            script_input=script_input,
            script_id=req.script_id or "Script",
            title=req.title or "Rough Cut",
            aspect_ratio=req.aspect_ratio or "9:16",
            fps=float(req.fps or 30.0),
            auto_broll=bool(req.auto_broll),
            pacing_style=req.pacing_style or "editorial",
        )

        ops = script_assembly_service.plan_to_edl_ops(plan)

        return {
            "success": True,
            "plan": plan.to_dict(),
            "target_sequence_name": f"Rough Cut - {plan.title}",
            "extendscript_ops": ops,
            "total_ops": len(ops),
        }
    except Exception as e:
        logger.error(f"[script_assembly_routes] Assembly error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/scripts")
async def list_available_scripts(
    folder_path: Optional[str] = Query(None, description="Optional custom folder path to look for scripts"),
) -> Dict[str, Any]:
    """List all available Markdown scripts in the workflow scripts directory."""
    search_dir: Optional[str] = folder_path

    if not search_dir or not Path(search_dir).exists():
        if media_resolver.root_dir and Path(media_resolver.root_dir).exists():
            search_dir = media_resolver.root_dir
        else:
            raf = Path("D:/MARKETING/Rahima Aziz Foundation/AI Automation")
            if raf.exists():
                search_dir = str(raf)
            elif Path("D:/MARKETING/Rahima Aziz Foundation").exists():
                search_dir = "D:/MARKETING/Rahima Aziz Foundation"
            else:
                search_dir = os.getcwd()

    p = Path(search_dir)
    if not p.exists():
        return {"success": True, "scripts": [], "folder": str(p), "total": 0}

    # If the directory or any subfolder has a dedicated Scripts folder, prioritize it
    scan_root = p
    if (p / "Scripts_15_30_45").is_dir():
        scan_root = p / "Scripts_15_30_45"
    elif (p / "AI Automation" / "Scripts_15_30_45").is_dir():
        scan_root = p / "AI Automation" / "Scripts_15_30_45"
    elif (p / "Scripts").is_dir():
        scan_root = p / "Scripts"

    scripts: List[Dict[str, Any]] = []
    ignore_stems = ("readme", "instructions", "person_crossreference", "talking_segments", "index")

    try:
        for root, dirs, files in os.walk(str(scan_root)):
            for f in files:
                if f.endswith(".md") and not f.startswith("00_"):
                    stem_l = Path(f).stem.lower()
                    if any(ign in stem_l for ign in ignore_stems):
                        continue
                    full_p = os.path.join(root, f)
                    rel = os.path.relpath(full_p, str(scan_root))
                    cat = Path(rel).parts[0] if len(Path(rel).parts) > 1 else "General"
                    scripts.append({
                        "name": f,
                        "rel_path": rel,
                        "full_path": full_p,
                        "category": cat,
                    })

        scripts.sort(key=lambda s: s["name"])
        return {"success": True, "total": len(scripts), "scripts": scripts, "folder": str(scan_root)}
    except Exception as e:
        logger.error(f"[script_assembly_routes] Error listing scripts: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/script-content")
async def get_script_content(path: str = Query(..., description="Path to script markdown file")) -> Dict[str, Any]:
    """Read the full content of a script markdown file."""
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"Script file not found: {path}")

    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()
        return {"success": True, "path": path, "content": content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
