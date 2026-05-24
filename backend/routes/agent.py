"""
EditFlow Agent — HTTP route.

Single endpoint: POST /api/agent/turn

The CEP panel sends events (user_message, scan_completed,
document_uploaded, tool_user_response, init) and receives
one or more messages back (agent_text, ui_card, ask).
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..services.agent import loop, session as session_store
from ..utils.progress import manager

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/agent", tags=["agent"])


class TurnRequest(BaseModel):
    """One agent turn request from the frontend."""
    session_id: str
    event: str  # "user_message" | "scan_completed" | "document_uploaded" | "tool_user_response" | "init" | "extendscript_done"
    payload: Dict[str, Any] = Field(default_factory=dict)
    client_id: Optional[str] = None


@router.post("/turn")
async def agent_turn(req: TurnRequest):
    """Execute one agent turn and return messages for the frontend.

    Wrapped in a top-level try/except so any exception inside the loop is
    converted into a chat message instead of an opaque 500. The full
    traceback is still logged server-side; the user sees a debuggable
    in-chat error with the exception type and message.
    """
    session = session_store.get_or_create(req.session_id)

    async def ws_emit(msg: dict):
        if req.client_id:
            try:
                await manager.send_to(req.client_id, msg)
            except Exception:
                pass

    # Handle document_uploaded: stash the extracted text into session
    if req.event == "document_uploaded":
        file_id = req.payload.get("file_id") or req.payload.get("filename") or "unknown"
        extracted_text = req.payload.get("full_text") or req.payload.get("text") or ""
        if extracted_text:
            session.context.setdefault("pending_documents", {})[file_id] = extracted_text

    try:
        messages = await loop.step(session, req.event, req.payload, ws_emit)
    except Exception as e:
        # Don't let exceptions become opaque 500s on the panel.
        # Log the full traceback for diagnosis, return a useful in-chat message.
        logger.exception(
            f"Agent loop crashed handling event={req.event!r} for session={req.session_id!r}"
        )
        err_name = e.__class__.__name__
        err_text = str(e) or repr(e)
        messages = [
            {
                "kind": "agent_text",
                "text": (
                    f"Internal error in the agent: {err_name}: {err_text}. "
                    f"Check the backend log for the full traceback (search for "
                    f"'Agent loop crashed handling event={req.event!r}')."
                ),
            }
        ]

    return {
        "session_id": session.id,
        "turn_id": session.next_turn_id(),
        "messages": messages,
        "session_state": {
            "current_phase": session.current_phase,
            "context_size": len(session.history),
        },
    }


@router.post("/reset")
async def agent_reset(req: TurnRequest):
    """Reset an agent session (e.g., on 'new edit')."""
    session_store.reset_session(req.session_id)
    return {"success": True, "session_id": req.session_id}


@router.get("/debug/{session_id}")
async def agent_debug(session_id: str):
    """Debug endpoint: dump a session's history and context."""
    sessions = session_store.get_all_sessions()
    s = sessions.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    return {
        "id": s.id,
        "current_phase": s.current_phase,
        "created_at": s.created_at,
        "last_used": s.last_used,
        "history_length": len(s.history),
        "history": s.history[-20:],  # last 20 entries
        "context_keys": list(s.context.keys()),
        "context": {
            k: (v if not isinstance(v, (str, bytes)) or len(str(v)) < 200 else str(v)[:200] + "...")
            for k, v in s.context.items()
        },
    }
