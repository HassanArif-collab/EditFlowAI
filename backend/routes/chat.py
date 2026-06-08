"""
EditFlow AI - Chat API Routes
Real-time AI chat for video cutting decisions.
"""
import logging

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from ..models.schemas import ChatRequest, ChatResponse
from ..services.chat_engine import chat_engine
from ..utils.progress import manager

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/chat", tags=["chat"])

_MAX_INCOMING_MESSAGE_LEN = 8000


@router.post("/message", response_model=ChatResponse)
async def send_message(request: ChatRequest):
    """Send a chat message and get AI response about video editing/cutting."""
    if request.message and len(request.message) > _MAX_INCOMING_MESSAGE_LEN:
        raise HTTPException(
            status_code=413,
            detail=f"message too long (max {_MAX_INCOMING_MESSAGE_LEN} chars)",
        )
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
    session = chat_engine.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session.messages


@router.post("/session/new")
async def new_session():
    """Create a new chat session."""
    session = chat_engine.create_new_session()
    return {"session_id": session.session_id}


@router.websocket("/ws/{client_id}")
async def websocket_chat(websocket: WebSocket, client_id: str):
    """WebSocket endpoint for real-time chat and progress updates."""
    accepted_id = await manager.connect(websocket, client_id)
    if accepted_id is None:
        # connect() refused the socket because the cap is reached
        return
    try:
        while True:
            data = await websocket.receive_json()
            msg_type = (data or {}).get("type")
            if msg_type == "chat":
                user_msg = (data.get("message") or "")
                if len(user_msg) > _MAX_INCOMING_MESSAGE_LEN:
                    await manager.send_to(accepted_id, {
                        "type": "error",
                        "payload": {"message": "message too long"},
                    })
                    continue
                try:
                    response = await chat_engine.process_message(
                        message=user_msg,
                        session_id=data.get("session_id"),
                        context=data.get("context"),
                    )
                    await manager.send_to(accepted_id, {
                        "type": "chat_response",
                        "payload": response.model_dump(),
                    })
                except Exception as e:
                    await manager.send_to(accepted_id, {
                        "type": "error",
                        "payload": {"message": str(e)},
                    })
            else:
                await manager.send_to(accepted_id, {
                    "type": "error",
                    "payload": {"message": f"Unknown message type: {msg_type!r}"},
                })
    except WebSocketDisconnect:
        manager.disconnect(accepted_id)
