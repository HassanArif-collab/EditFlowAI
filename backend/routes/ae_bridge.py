"""EditFlow AI — AE agent bridge (dev tool, not a product feature).

Lets an agent execute panel ExtendScript calls over HTTP: the backend
forwards an eval job to the CEP panel over the existing WebSocket, the
panel runs it via callExtendScript and POSTs the result back here.

  POST /api/ae-bridge/eval          {fn, args, timeout} → {ok, result|error}
  POST /api/ae-bridge/result/{job}  panel → resolves the pending eval
  GET  /api/ae-bridge/health        {backend, panel, ae}
  GET  /api/ae-bridge/frame?t=1.2   PNG of the comp at time t

Mounted ONLY when EDITFLOW_AGENT_BRIDGE=1 (see main.py). Never expose the
backend outside the local network with the bridge enabled — eval means eval.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..utils.progress import manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ae-bridge", tags=["ae-bridge"])


class JobTimeout(Exception):
    pass


class PanelUnavailable(Exception):
    pass


_jobs: dict[str, asyncio.Future] = {}


def _panel_connected() -> bool:
    return len(manager.active_connections) > 0


async def _send_to_panel(msg: dict) -> bool:
    """Broadcast over the panel WebSocket. Job ids make stray listeners
    harmless; returns False when nobody is connected."""
    if not _panel_connected():
        return False
    await manager.broadcast(msg)
    return True


async def run_job(fn: str, args: list, timeout: float = 30) -> dict:
    job_id = uuid.uuid4().hex
    fut: asyncio.Future = asyncio.get_event_loop().create_future()
    _jobs[job_id] = fut
    try:
        sent = await _send_to_panel(
            {"type": "agent_eval", "job_id": job_id, "fn": fn, "args": args or []}
        )
        if not sent:
            raise PanelUnavailable(fn)
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            raise JobTimeout(f"{fn} after {timeout}s")
    finally:
        _jobs.pop(job_id, None)


def complete_job(job_id: str, payload: dict) -> bool:
    fut = _jobs.get(job_id)
    if fut and not fut.done():
        fut.set_result(payload)
        return True
    return False


class EvalReq(BaseModel):
    fn: str
    args: list = []
    timeout: float = 30


@router.post("/eval")
async def bridge_eval(req: EvalReq):
    try:
        return await run_job(req.fn, req.args, req.timeout)
    except PanelUnavailable:
        raise HTTPException(
            503, "Panel not connected — is AE open with the EditFlow extension loaded?"
        )
    except JobTimeout as e:
        raise HTTPException(504, f"ExtendScript call timed out: {e}")


class ResultReq(BaseModel):
    ok: bool
    result: Optional[Any] = None
    error: Optional[str] = None


@router.post("/result/{job_id}")
async def bridge_result(job_id: str, req: ResultReq):
    matched = complete_job(job_id, req.model_dump())
    return {"ok": True, "matched": matched}


@router.get("/health")
async def bridge_health():
    """Full-loop health: backend up (implicit), panel connected, AE answering."""
    if not _panel_connected():
        return {"backend": True, "panel": False, "ae": False}
    try:
        r = await run_job("ef_ping", [], timeout=5)
        return {"backend": True, "panel": True, "ae": r.get("result") == "pong"}
    except (PanelUnavailable, JobTimeout):
        return {"backend": True, "panel": True, "ae": False}


def _frames_dir() -> Path:
    from ..config import get_settings

    d = get_settings().DATA_DIR / "media_cache" / "bridge_frames"
    d.mkdir(parents=True, exist_ok=True)
    return d


@router.get("/frame")
async def bridge_frame(t: float):
    """Render the active comp at time t and return the PNG — the agent's eyes."""
    out = _frames_dir() / f"frame_{t:.3f}.png"
    try:
        r = await run_job("ef_renderFrameAt", [t, str(out)], timeout=60)
    except PanelUnavailable:
        raise HTTPException(503, "Panel not connected")
    except JobTimeout as e:
        raise HTTPException(504, str(e))
    if not r.get("ok"):
        raise HTTPException(500, r.get("error") or "render failed")
    if not out.exists():
        raise HTTPException(500, f"jsx reported success but {out} does not exist")
    return FileResponse(str(out), media_type="image/png")
