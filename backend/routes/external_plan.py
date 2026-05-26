"""HTTP route for ingesting an externally-generated cut plan.

Companion to ``backend/services/external_plan.py``.  The frontend POSTs the
raw text the user pasted back from the frontier LLM; we parse it, build a
Plan, store it, and return the plan_id.  The existing /plan/{id}/apply
route then takes over.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services.external_plan import (
    ExternalPlanError,
    build_plan_from_pasted_json,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/external-plan", tags=["external-plan"])


class IngestRequest(BaseModel):
    pasted_text: str
    bin_reference: str
    script: str
    transcripts_ready: dict
    user_hint: Optional[str] = None


@router.post("/ingest")
async def ingest(req: IngestRequest):
    """Build a Plan from pasted JSON. Returns ``{plan_id, summary, gaps}``.

    Frontend should already have these in session state — we accept them as
    request body so this route stays stateless (callable from the agent
    tool layer too).
    """
    try:
        plan = build_plan_from_pasted_json(
            req.pasted_text,
            bin_reference=req.bin_reference,
            script=req.script,
            transcripts_ready=req.transcripts_ready,
            user_hint=req.user_hint,
        )
    except ExternalPlanError as exc:
        logger.warning("External plan ingest failed: %s", exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {
        "plan_id": plan.plan_id,
        "summary": plan.summary,
        "gaps": plan.gaps,
        "cuts_count": len(plan.cuts),
    }
