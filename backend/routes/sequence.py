"""
EditFlow AI - Sequence & Script API Routes
"""
import logging
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException, Body

from ..models.schemas import (
    APIResponse, EDLInstruction, ScriptPreview, SequenceState,
)
from ..models.database import db
from ..services.script_engine import script_engine, template_manager
from ..services.sequence_manager import sequence_manager
from ..utils.progress import ProgressReporter

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/sequence", tags=["sequence"])


# ── Sequence State ──

@router.get("/state", response_model=SequenceState)
async def get_sequence_state():
    """Get current Premiere Pro sequence state."""
    return await sequence_manager.get_sequence_state()


@router.post("/state")
async def update_sequence_state(state: SequenceState):
    """Update sequence state (called by ExtendScript or simulation)."""
    await sequence_manager.update_sequence_state(state)
    return {"success": True}


# ── Templates ──

@router.get("/templates")
async def list_templates():
    """List available edit templates."""
    return template_manager.list_templates()


@router.get("/templates/{template_id}")
async def get_template(template_id: str):
    """Get a specific template."""
    template = template_manager.get_template(template_id)
    if not template:
        raise HTTPException(status_code=404, detail=f"Template '{template_id}' not found")
    return template


# ── Script Generation ──

@router.post("/generate-script")
async def generate_script(
    payload: Dict = Body(default_factory=dict),
    template_id: str = "jamia_masjid",
    instructions: str = "",
    client_id: Optional[str] = None,
):
    """Generate an edit script from available transcripts and catalog."""
    template_id = payload.get("template_id", payload.get("templateId", template_id))
    instructions = payload.get("instructions", instructions)
    client_id = payload.get("client_id", payload.get("clientId", client_id))
    progress = ProgressReporter(task_type="generate", client_id=client_id)

    try:
        # Load available transcripts
        transcripts = []
        transcript_data = db.load("transcripts")
        if transcript_data and isinstance(transcript_data, list):
            transcripts = transcript_data
        elif transcript_data and isinstance(transcript_data, dict):
            transcripts = transcript_data.get("files", [])

        # Load available catalog
        catalog = []
        for name in ["default", "jamia_masjid"]:
            cat_data = db.load(f"catalog_{name}")
            if cat_data and isinstance(cat_data, list):
                catalog.extend(cat_data)

        if not transcripts and not catalog:
            raise HTTPException(
                status_code=400,
                detail="No transcripts or catalog data available. Please transcribe and catalog your media first."
            )

        result = await script_engine.generate_script(
            transcripts=transcripts,
            catalog=catalog,
            template_id=template_id,
            instructions=instructions,
            progress=progress,
        )
        return result.dict()

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Script generation error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/refine-script/{script_id}")
async def refine_script(
    script_id: str,
    payload: Dict = Body(default_factory=dict),
    feedback: str = "",
    client_id: Optional[str] = None,
):
    """Refine an existing script based on user feedback."""
    feedback = payload.get("feedback", feedback)
    client_id = payload.get("client_id", payload.get("clientId", client_id))
    progress = ProgressReporter(task_type="refine", client_id=client_id)

    script_data = db.get_script(script_id)
    if not script_data:
        raise HTTPException(status_code=404, detail=f"Script '{script_id}' not found")

    try:
        script = ScriptPreview(**script_data)
        result = await script_engine.refine_script(
            script=script,
            feedback=feedback,
            progress=progress,
        )
        return result.dict()
    except Exception as e:
        logger.error(f"Script refinement error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/script/{script_id}")
async def get_script(script_id: str):
    """Get a saved script."""
    script_data = db.get_script(script_id)
    if not script_data:
        raise HTTPException(status_code=404, detail=f"Script '{script_id}' not found")
    return script_data


# ── Execution ──

@router.post("/execute/{script_id}")
async def execute_script(script_id: str):
    """Execute a script on the Premiere Pro timeline."""
    script_data = db.get_script(script_id)
    if not script_data:
        raise HTTPException(status_code=404, detail=f"Script '{script_id}' not found")

    try:
        script = ScriptPreview(**script_data)
        edl = script_engine.script_to_edl(script)
        result = await sequence_manager.execute_edl(edl)
        return result
    except Exception as e:
        logger.error(f"Script execution error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/undo")
async def undo_last():
    """Undo the last executed action."""
    result = await sequence_manager.undo_last()
    return result


@router.get("/history")
async def get_execution_history():
    """Get execution history."""
    return sequence_manager.get_execution_history()
