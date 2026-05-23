"""
EditFlow AI - Premiere Pro Integration Routes
Handles project context sync, sequence state, and EDL generation for the CEP panel.
"""
import json
import logging
import tempfile
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..models.schemas import (
    SequenceAnalyzeRequest,
    SequenceAnalyzeResponse,
    SequencePhraseRequest,
    SequencePhraseResponse,
)
from ..services.sequence_phrase_service import sequence_phrase_service
from ..utils.progress import ProgressReporter

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/premiere", tags=["premiere"])


# ── In-Memory Context Store ──
_project_context: Dict[str, Any] = {
    "items": [],
    "bins": [],
    "sequences": [],
    "last_updated": None,
}

# Capped LRU — uncapped dict would grow forever as users save snapshots.
_MAX_SNAPSHOTS = 50
_sequence_snapshots: "OrderedDict[str, Dict]" = OrderedDict()


# ── Models ──
class ProjectContext(BaseModel):
    items: List[Dict[str, Any]] = []
    bins: List[Dict[str, Any]] = []
    sequences: List[Dict[str, Any]] = []


class EDLOperation(BaseModel):
    action: str  # "add", "remove", "move", "modify"
    mediaPath: str = ""
    trackIndex: int = 0
    clipIndex: Optional[int] = None
    startTime: float = 0
    inPoint: float = 0
    outPoint: float = 0
    endTime: float = 0
    newStartTime: Optional[float] = None
    speed: Optional[float] = None
    labelIndex: Optional[int] = None


class EDLRequest(BaseModel):
    sequence_name: str = "EditFlow Cut"
    operations: List[EDLOperation] = []


class SequenceSnapshot(BaseModel):
    sequence_name: str = ""
    state: Dict[str, Any] = {}


# ── Context Endpoints ──

@router.post("/context")
async def update_project_context(context: ProjectContext):
    """Receive project context from the CEP panel (scanned bins, items, sequences)."""
    global _project_context
    _project_context = {
        "items": context.items,
        "bins": context.bins,
        "sequences": context.sequences,
        "last_updated": time.time(),
    }
    logger.info(f"Premiere context updated: {len(context.items)} items, {len(context.bins)} bins, {len(context.sequences)} sequences")
    return {"success": True, "items": len(context.items), "bins": len(context.bins)}


@router.get("/context")
async def get_project_context():
    """Get the current Premiere project context."""
    return _project_context


@router.post("/context/clear")
async def clear_project_context():
    """Clear the stored project context."""
    global _project_context
    _project_context = {
        "items": [],
        "bins": [],
        "sequences": [],
        "last_updated": None,
    }
    return {"success": True}


# ── Sequence Endpoints ──

@router.post("/snapshot")
async def save_sequence_snapshot(snapshot: SequenceSnapshot):
    """Store a sequence state snapshot for reference."""
    # Millisecond precision — second-precision IDs collided when two snapshots
    # were saved in the same second, silently overwriting one another.
    snapshot_id = f"snap_{int(time.time() * 1000)}"
    _sequence_snapshots[snapshot_id] = {
        "id": snapshot_id,
        "sequence_name": snapshot.sequence_name,
        "state": snapshot.state,
        "created_at": time.time(),
    }
    while len(_sequence_snapshots) > _MAX_SNAPSHOTS:
        _sequence_snapshots.popitem(last=False)
    logger.info(f"Sequence snapshot saved: {snapshot_id} ({snapshot.sequence_name})")
    return {"success": True, "snapshot_id": snapshot_id}


@router.get("/snapshots")
async def list_snapshots():
    """List all stored sequence snapshots."""
    return {
        "snapshots": [
            {
                "id": sid,
                "sequence_name": s["sequence_name"],
                "created_at": s["created_at"],
            }
            for sid, s in _sequence_snapshots.items()
        ]
    }


@router.get("/snapshots/{snapshot_id}")
async def get_snapshot(snapshot_id: str):
    """Get a specific sequence snapshot."""
    if snapshot_id not in _sequence_snapshots:
        raise HTTPException(status_code=404, detail="Snapshot not found")
    return _sequence_snapshots[snapshot_id]


# ── EDL Generation ──

@router.post("/edl/generate")
async def generate_edl(request: EDLRequest):
    """Generate an EDL JSON file that the CEP panel can send to Premiere's ExtendScript.

    The EDL file is written to a temporary location and returned as a path.
    The CEP panel then calls processEDL(edlJsonPath) in ExtendScript to apply it.
    """
    # Reject any operation pointing at a non-existent file. Premiere will
    # silently no-op or crash later otherwise.
    missing: List[str] = []
    for op in request.operations:
        if op.action in {"add", "modify", "move"} and op.mediaPath:
            try:
                if not Path(op.mediaPath).is_file():
                    missing.append(op.mediaPath)
            except OSError:
                missing.append(op.mediaPath)
    if missing:
        raise HTTPException(
            status_code=400,
            detail={
                "message": "One or more mediaPath entries do not point at an existing file",
                "missing": missing[:10],
                "missing_count": len(missing),
            },
        )

    try:
        edl_data = {
            "sequence_name": request.sequence_name,
            "operations": [op.model_dump(exclude_none=True) for op in request.operations],
        }

        # Write to a temp file that ExtendScript can read
        output_dir = Path(tempfile.gettempdir()) / "editflow_edl"
        output_dir.mkdir(parents=True, exist_ok=True)

        # ms-precision filename — second-precision collided when two EDLs
        # were generated in the same second.
        filename = f"edl_{int(time.time() * 1000)}.json"
        edl_path = output_dir / filename

        with open(edl_path, 'w', encoding='utf-8') as f:
            json.dump(edl_data, f, indent=2)

        logger.info(f"EDL generated: {edl_path} ({len(request.operations)} operations)")
        return {
            "success": True,
            "edl_path": str(edl_path).replace('\\', '/'),
            "operation_count": len(request.operations),
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"EDL generation error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/edl/from-cuts")
async def generate_edl_from_cuts(cut_id: Optional[str] = None):
    """Generate an EDL from a previous cutting result stored in the database.

    This converts the cutting pipeline's output into an EDL that can be
    applied to the Premiere timeline.
    """
    try:
        from ..models.sqlite_registry import sqlite_registry

        # Get the latest cutting result if no ID specified
        if cut_id:
            result = sqlite_registry.fetch_one(
                "SELECT * FROM cutting_results WHERE id = ?", (cut_id,)
            )
        else:
            result = sqlite_registry.fetch_one(
                "SELECT * FROM cutting_results ORDER BY created_at DESC LIMIT 1"
            )

        if not result:
            raise HTTPException(status_code=404, detail="No cutting result found")

        # Parse the cuts
        cuts_data = result.get("cuts", "[]")
        if isinstance(cuts_data, str):
            cuts_data = json.loads(cuts_data)

        # Build EDL operations from cuts
        operations = []
        current_time = 0.0

        for cut in cuts_data:
            source = cut.get("source_file", "")
            start = cut.get("start", 0)
            end = cut.get("end", 0)
            duration = end - start

            operations.append({
                "action": "add",
                "mediaPath": source,
                "trackIndex": 0,
                "startTime": round(current_time, 3),
                "inPoint": round(start, 3),
                "outPoint": round(end, 3),
            })

            current_time += duration

        # Generate the EDL file
        edl_data = {
            "sequence_name": f"EditFlow Cut - {result.get('id', 'unknown')}",
            "operations": operations,
        }

        output_dir = Path(tempfile.gettempdir()) / "editflow_edl"
        output_dir.mkdir(parents=True, exist_ok=True)

        filename = f"edl_cut_{int(time.time() * 1000)}.json"
        edl_path = output_dir / filename

        with open(edl_path, 'w', encoding='utf-8') as f:
            json.dump(edl_data, f, indent=2)

        logger.info(f"EDL from cuts generated: {edl_path} ({len(operations)} operations)")
        return {
            "success": True,
            "edl_path": str(edl_path).replace('\\', '/'),
            "operation_count": len(operations),
            "total_duration": round(current_time, 2),
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"EDL from cuts error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Active Sequence Phrase Cuts ──

@router.post("/sequence/analyze", response_model=SequenceAnalyzeResponse)
async def analyze_active_sequence_audio(request: SequenceAnalyzeRequest):
    """Transcribe every audio clip in the active sequence and index words by
    timeline position. Required before /sequence/find-phrase can return matches."""
    if not request.audio_clips:
        raise HTTPException(
            status_code=400,
            detail="No audio clips were provided for sequence analysis",
        )
    progress = ProgressReporter(task_type="sequence_analyze", client_id=request.client_id)
    try:
        return await sequence_phrase_service.analyze_sequence(request, progress=progress)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Sequence audio analysis error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/sequence/find-phrase", response_model=SequencePhraseResponse)
async def find_phrase_in_sequence(request: SequencePhraseRequest):
    """Search the indexed sequence transcript for every occurrence of ``phrase``."""
    if not request.phrase.strip():
        raise HTTPException(status_code=400, detail="phrase cannot be empty")
    try:
        return sequence_phrase_service.find_phrase(
            sequence_id=request.sequence_id,
            sequence_name=request.sequence_name,
            phrase=request.phrase,
            padding_before=request.padding_before,
            padding_after=request.padding_after,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Sequence phrase search error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Utility Endpoints ──

@router.get("/bins")
async def list_bins():
    """List all bins from the current project context."""
    bins = _project_context.get("bins", [])
    return {"bins": bins, "total": len(bins)}


@router.get("/items")
async def list_items(bin_path: Optional[str] = None, limit: int = 100):
    """List project items, optionally filtered by bin path."""
    items = _project_context.get("items", [])

    if bin_path:
        items = [i for i in items if i.get("binPath", "").startswith(bin_path)]

    return {
        "items": items[:limit],
        "total": len(items),
        "showing": min(limit, len(items)),
    }


@router.get("/sequence-state")
async def get_sequence_state():
    """Get the current active sequence state from the stored context."""
    sequences = _project_context.get("sequences", [])
    if not sequences:
        return {"has_sequence": False}

    # Return the first (active) sequence
    return {"has_sequence": True, "sequence": sequences[0]}


@router.get("/health")
async def premiere_health():
    """Check if the Premiere Pro context is available."""
    has_context = _project_context.get("last_updated") is not None
    has_sequence = len(_project_context.get("sequences", [])) > 0
    return {
        "context_available": has_context,
        "sequence_available": has_sequence,
        "items_count": len(_project_context.get("items", [])),
        "bins_count": len(_project_context.get("bins", [])),
    }
