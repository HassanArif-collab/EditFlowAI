"""
EditFlow AI - CleanSpeech Router
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from ..services.cleanspeech_service import cleanspeech_service

router = APIRouter(prefix="/cleanspeech", tags=["CleanSpeech"])

class ChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None

class CleanRequest(BaseModel):
    audioPath: str

@router.post("/chat")
async def chat(request: ChatRequest):
    # Simple chat fallback for now
    return {"response": f"I received your message: '{request.message}'. How can I help you clean your speech?"}

@router.post("/clean")
async def clean(request: CleanRequest):
    try:
        result = await cleanspeech_service.clean_timeline(request.audioPath)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/highlights")
async def highlights(request: CleanRequest):
    return {
        "success": False,
        "highlights": [],
        "message": "Highlight detection is handled by the v2 speech-candidate pipeline. Use /api/assets/{asset_id}/analyze.",
    }
