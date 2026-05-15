"""
EditFlow AI v2 routes.
Foundation APIs for asset registry, script/visual-map ingestion, edit plans, dry-runs, and jobs.
"""
from __future__ import annotations

import asyncio
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..models.v2_schemas import (
    AssetAnalyzeRequest,
    AssetRegisterRequest,
    EditPlanCreateRequest,
    FolderScanRequest,
    ReferenceResolveRequest,
    ReferenceRootRequest,
    ScriptIngestRequest,
    VisualMapIngestRequest,
)
from ..services.premiere_context_service import premiere_context_service
from ..services.reference_resolver_service import reference_resolver_service
from ..services.v2_registry_service import v2_registry_service

router = APIRouter(tags=["v2"])
_background_tasks: set[asyncio.Task] = set()
_active_background_jobs: Dict[str, str] = {}


class PremiereSnapshotRequest(BaseModel):
    snapshot_type: str = "sequence"
    payload: Dict[str, Any]


class PremiereVerifyRequest(BaseModel):
    premiere_result: Dict[str, Any] = {}
    sequence_state: Optional[Dict[str, Any]] = None


@router.get("/system/status")
async def system_status():
    from ..services.provider_service import provider_service
    from ..services.whisper_service import whisper_service

    provider_health = await provider_service.health_check()
    active_chat = provider_service.get_active_chat()
    active_vision = provider_service.get_active_vision()
    recent_jobs = v2_registry_service.recent_jobs(limit=5)
    return {
        "server": "running",
        "capabilities": v2_registry_service.capabilities(),
        "database": v2_registry_service.health(),
        "providers": provider_health,
        "active_chat": active_chat,
        "active_vision": active_vision,
        "whisper_loaded": whisper_service._model is not None,
        "worker_queue": {
            "mode": "asyncio_background_tasks",
            "busy": bool(_active_background_jobs),
            "active_count": len(_active_background_jobs),
            "active_jobs": dict(_active_background_jobs),
            "current_job": recent_jobs[0] if recent_jobs else None,
        },
        "premiere_bridge": {
            "connected": None,
            "message": "Bridge status is supplied by the CEP panel snapshot/heartbeat in a later phase.",
        },
    }


@router.get("/system/capabilities")
async def system_capabilities():
    return {"capabilities": v2_registry_service.capabilities()}


@router.get("/references/roots")
async def list_reference_roots():
    return {"roots": reference_resolver_service.list_roots()}


@router.post("/references/roots")
async def set_reference_root(request: ReferenceRootRequest):
    try:
        return reference_resolver_service.set_root(request)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/references/resolve")
async def resolve_reference(request: ReferenceResolveRequest):
    return reference_resolver_service.resolve(request)


@router.get("/references/premiere-bins")
async def list_premiere_bins(limit: int = 200):
    return {"bins": premiere_context_service.list_bins(limit=limit)}


@router.post("/assets/register")
async def register_asset(request: AssetRegisterRequest):
    try:
        return v2_registry_service.register_asset(request)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/assets/scan-folder")
async def scan_folder(request: FolderScanRequest):
    try:
        return v2_registry_service.scan_folder(request)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/assets/search")
async def search_assets(q: str, limit: int = 20):
    return v2_registry_service.search_assets(q, limit)


@router.post("/assets/{asset_id}/analyze")
async def analyze_asset(asset_id: str, request: Optional[AssetAnalyzeRequest] = None):
    try:
        request = request or AssetAnalyzeRequest()
        return await v2_registry_service.analyze_asset(asset_id, request)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/assets/{asset_id}/analyze-async")
async def analyze_asset_async(asset_id: str, request: Optional[AssetAnalyzeRequest] = None):
    try:
        v2_registry_service.get_asset(asset_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))

    request = request or AssetAnalyzeRequest()
    job = v2_registry_service.create_job(
        "asset_analysis",
        asset_id,
        "queued",
        "Asset analysis queued",
        progress=0.0,
    )
    task = asyncio.create_task(_run_asset_analysis_job(job["id"], asset_id, request))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return job


async def _run_asset_analysis_job(job_id: str, asset_id: str, request: AssetAnalyzeRequest):
    _active_background_jobs[job_id] = asset_id
    v2_registry_service.update_job(job_id, status="running", progress=0.05, message="Asset analysis started")
    try:
        result = await v2_registry_service.analyze_asset(asset_id, request)
        v2_registry_service.update_job(
            job_id,
            status="completed",
            progress=1.0,
            message="Asset analysis completed",
            result=result,
        )
    except Exception as e:
        v2_registry_service.update_job(
            job_id,
            status="failed",
            progress=1.0,
            message="Asset analysis failed",
            error=str(e),
        )
    finally:
        _active_background_jobs.pop(job_id, None)


@router.get("/assets/{asset_id}/transcript")
async def get_asset_transcript(asset_id: str):
    return v2_registry_service.get_transcript(asset_id)


@router.get("/assets/{asset_id}/speech-candidates")
async def get_speech_candidates(asset_id: str):
    return {
        "asset_id": asset_id,
        "candidates": v2_registry_service.get_speech_candidates(asset_id),
    }


@router.get("/assets/{asset_id}/candidates")
async def get_asset_candidates_alias(asset_id: str):
    return await get_speech_candidates(asset_id)


@router.post("/scripts/ingest")
async def ingest_script(request: ScriptIngestRequest):
    if not request.content.strip():
        raise HTTPException(status_code=400, detail="Script content is empty")
    return v2_registry_service.ingest_script(request)


@router.get("/scripts/{script_id}/lines")
async def get_script_lines(script_id: str):
    return {"script_id": script_id, "lines": v2_registry_service.get_script_lines(script_id)}


@router.post("/visual-maps/ingest")
async def ingest_visual_map(request: VisualMapIngestRequest):
    if not request.content.strip():
        raise HTTPException(status_code=400, detail="Visual map content is empty")
    return v2_registry_service.ingest_visual_map(request)


@router.get("/visual-maps/{visual_map_id}/entries")
async def get_visual_map_entries(visual_map_id: str):
    return {
        "visual_map_id": visual_map_id,
        "entries": v2_registry_service.get_visual_map_entries(visual_map_id),
    }


@router.post("/edit-plans/create")
async def create_edit_plan(request: EditPlanCreateRequest):
    try:
        return v2_registry_service.create_edit_plan(request)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/chat/plan")
async def chat_plan_alias(request: EditPlanCreateRequest):
    return await create_edit_plan(request)


@router.post("/jobs/{plan_id}/dry-run")
async def dry_run_job(plan_id: str):
    try:
        return v2_registry_service.dry_run_plan(plan_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/edit-plans/{plan_id}/dry-run")
async def dry_run_plan_alias(plan_id: str):
    return await dry_run_job(plan_id)


@router.post("/jobs/{plan_id}/execute")
async def execute_job(plan_id: str):
    try:
        return v2_registry_service.execute_plan(plan_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/edit-plans/{plan_id}/execute")
async def execute_plan_alias(plan_id: str):
    return await execute_job(plan_id)


@router.post("/jobs/{plan_id}/verify")
async def verify_job(plan_id: str, request: Optional[PremiereVerifyRequest] = None):
    try:
        request = request or PremiereVerifyRequest()
        return v2_registry_service.verify_plan(
            plan_id,
            premiere_result=request.premiere_result,
            sequence_state=request.sequence_state,
        )
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/edit-plans/{plan_id}/verify")
async def verify_plan_alias(plan_id: str, request: Optional[PremiereVerifyRequest] = None):
    return await verify_job(plan_id, request)


@router.get("/jobs/recent")
async def recent_jobs(limit: int = 20):
    return {"jobs": v2_registry_service.recent_jobs(limit)}


@router.get("/jobs/{job_id}")
async def get_job(job_id: str):
    try:
        return v2_registry_service.get_job(job_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/jobs/{job_id}/status")
async def get_job_status(job_id: str):
    return await get_job(job_id)


@router.post("/premiere/snapshot")
async def premiere_snapshot(request: PremiereSnapshotRequest):
    return v2_registry_service.save_premiere_snapshot(request.snapshot_type, request.payload)
