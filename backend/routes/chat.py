"""
EditFlow AI - Chat API Routes
"""
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from ..models.schemas import APIResponse, ChatRequest, ChatResponse
from ..services.chat_engine import chat_engine
from ..utils.progress import ConnectionManager, manager

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/chat", tags=["chat"])


@router.post("/message", response_model=ChatResponse)
async def send_message(request: ChatRequest):
    """Send a chat message and get AI response."""
    try:
        response = await chat_engine.process_message(
            message=request.message,
            session_id=request.session_id,
            context=request.context,
        )
        return response
    except Exception as e:
        logger.error(f"Chat error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/history/{session_id}")
async def get_history(session_id: str):
    """Get chat history for a session."""
    from ..models.database import db
    session_data = db.get_session(session_id)
    if not session_data:
        raise HTTPException(status_code=404, detail="Session not found")
    return session_data.get("messages", [])


@router.post("/session/new")
async def new_session():
    """Create a new chat session."""
    from ..services.chat_engine import ChatSession
    session = ChatSession()
    from ..models.database import db
    db.save_session(session.session_id, session.to_dict())
    return {"session_id": session.session_id}


@router.websocket("/ws/{client_id}")
async def websocket_chat(websocket: WebSocket, client_id: str):
    """WebSocket endpoint for real-time chat and progress updates."""
    await manager.connect(websocket, client_id)
    try:
        while True:
            data = await websocket.receive_json()
            # Process chat messages via WebSocket too
            if data.get("type") == "chat":
                request = ChatRequest(
                    message=data.get("message", ""),
                    session_id=data.get("session_id"),
                    context=data.get("context"),
                )
                try:
                    response = await chat_engine.process_message(
                        message=request.message,
                        session_id=request.session_id,
                        context=request.context,
                    )
                    await manager.send_to(client_id, {
                        "type": "chat_response",
                        "payload": response.dict(),
                    })
                except Exception as e:
                    await manager.send_to(client_id, {
                        "type": "error",
                        "payload": {"message": str(e)},
                    })
    except WebSocketDisconnect:
        manager.disconnect(client_id)
