"""
EditFlow AI - Sequence State Manager
Tracks current Premiere Pro sequence state and manages EDL execution.
"""
import json
import logging
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..config import Settings
from ..models.schemas import (
    EDLClip, EDLInstruction, ExecutionStatus, SequenceClip, SequenceState,
)
from ..models.database import db

logger = logging.getLogger(__name__)


class SequenceManager:
    """Manages sequence state and EDL execution workflow.

    In the real system, sequence state comes from ExtendScript
    reading the Premiere Pro timeline. In dev/test mode, we
    simulate this with a JSON-backed store.
    """

    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or Settings()
        self.edl_dir = self.settings.EDL_DIR
        self.edl_dir.mkdir(parents=True, exist_ok=True)
        self._execution_history: List[Dict] = []

    async def get_sequence_state(self) -> SequenceState:
        """Get current sequence state.

        In production, this would call ExtendScript to read the timeline.
        In dev mode, returns the last known state or a default.
        """
        state_data = db.load("sequence_state")
        if state_data:
            try:
                return SequenceState(**state_data)
            except Exception as e:
                logger.warning(f"Failed to parse sequence state: {e}")

        return SequenceState()

    async def update_sequence_state(self, state: SequenceState):
        """Update the stored sequence state (called after ExtendScript reports changes)."""
        db.save("sequence_state", state.dict())

    async def execute_edl(self, edl: EDLInstruction) -> Dict[str, Any]:
        """Execute an EDL instruction by writing it to a temp file for ExtendScript.

        The actual execution flow:
        1. Write EDL JSON to temp file
        2. ExtendScript watches for new EDL files
        3. ExtendScript reads and applies changes
        4. ExtendScript writes result back

        In dev mode, we simulate this.
        """
        # Write EDL to file
        edl_path = self.edl_dir / f"edl_{edl.id}.json"
        with open(edl_path, "w", encoding="utf-8") as f:
            json.dump(edl.dict(), f, indent=2, default=str)

        logger.info(f"EDL written to {edl_path}")

        # Record in execution history
        execution_record = {
            "edl_id": edl.id,
            "script_id": edl.script_id,
            "status": ExecutionStatus.PENDING,
            "clips_count": len(edl.clips),
            "undo_group": edl.undo_group,
            "started_at": datetime.utcnow().isoformat(),
            "edl_path": str(edl_path),
        }
        self._execution_history.append(execution_record)

        return {
            "edl_id": edl.id,
            "status": "pending",
            "edl_path": str(edl_path),
            "message": "EDL file written. Waiting for Premiere execution.",
        }

    async def undo_last(self) -> Dict[str, Any]:
        """Undo the last executed EDL.

        In Premiere Pro, this uses the undo group to revert all changes.
        """
        if not self._execution_history:
            return {"success": False, "message": "No actions to undo"}

        last = self._execution_history[-1]
        if last.get("status") != ExecutionStatus.SUCCESS:
            return {"success": False, "message": "Last action already failed or undone"}

        # Write undo instruction
        undo_id = str(uuid.uuid4())[:8]
        undo_path = self.edl_dir / f"undo_{undo_id}.json"
        with open(undo_path, "w") as f:
            json.dump({
                "action": "undo",
                "undo_group": last.get("undo_group"),
                "edl_id": last.get("edl_id"),
            }, f, indent=2)

        last["status"] = ExecutionStatus.ROLLED_BACK
        last["undone_at"] = datetime.utcnow().isoformat()

        return {
            "success": True,
            "message": f"Undo submitted for EDL {last.get('edl_id')}",
            "undo_path": str(undo_path),
        }

    def get_execution_history(self) -> List[Dict]:
        """Get history of all EDL executions."""
        return self._execution_history



    def set_sequence_from_extendscript(self, state_data: Dict):
        """Called when ExtendScript reports the current sequence state.

        This is the production path - ExtendScript reads the timeline
        and sends the state to the backend.
        """
        state = SequenceState(**state_data)
        db.save("sequence_state", state.dict())
        return state


# Global service instance
sequence_manager = SequenceManager()
