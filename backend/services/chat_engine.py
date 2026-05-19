"""
EditFlow AI - Chat Engine (Simplified)
AI chat focused on video cutting decisions and pipeline control.
"""
import json
import logging
import re
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from ..config import get_settings
from ..models.schemas import ChatMessage, ChatResponse, MessageRole
from ..services.provider_service import provider_service

logger = logging.getLogger(__name__)


CUTTING_SYSTEM_PROMPT = """You are EditFlow AI, an intelligent video editing assistant.
Your primary job is to help users cut and clean up their videos using AI.

CORE CAPABILITIES:
1. **Analyze Videos**: Scan folders of video files, transcribe speech, detect fillers/pauses/repetitions.
2. **Script-Based Cutting**: Given a script (English) and Urdu video recordings, find the best takes for each line and remove bad takes, fillers, pauses, and repetitions.
3. **Visual Placement**: Place visuals (images/video clips) at specific points in the cut video based on a mapping document.
4. **Provider Management**: Help users configure and manage LLM providers (Ollama, OpenAI-compatible APIs).

HOW TO RESPOND:
- Be helpful, concise, and actionable.
- When users ask to analyze videos, suggest using the /api/pipeline/analyze endpoint.
- When users provide a script, suggest the /api/pipeline/cut endpoint.
- When users want to place visuals, suggest the /api/pipeline/visuals endpoint.
- For technical questions about the pipeline, explain clearly.
- If unsure, ask for clarification.

CUTTING PIPELINE WORKFLOW:
1. First, analyze the video folder: POST /api/pipeline/analyze with {"folder_path": "/path/to/videos", "language": "ur"}
2. Then, provide the English script to match: POST /api/pipeline/cut with {"script_content": "...", "script_language": "en", "video_language": "ur"}
3. Optionally, place visuals: POST /api/pipeline/visuals with the mapping document and visual folder.

CROSS-LINGUAL MATCHING:
- Videos are in Urdu, scripts are in English
- The AI understands both languages and matches by semantic meaning
- Best takes are selected based on delivery quality (fewer fillers, no pauses, no repetitions)

CONVERSATION CONTEXT:
{history}

ANALYZED VIDEOS CONTEXT:
{video_context}
"""


class ChatSession:
    """Manages a single chat session's context and history."""

    def __init__(self, session_id: Optional[str] = None):
        self.session_id = session_id or str(uuid.uuid4())[:8]
        self.messages: List[Dict[str, str]] = []
        self.context: Dict[str, Any] = {}
        self.created_at = datetime.utcnow()

    def to_dict(self) -> Dict:
        return {
            "session_id": self.session_id,
            "messages": self.messages,
            "context": self.context,
            "created_at": self.created_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, data: Dict) -> "ChatSession":
        session = cls(session_id=data.get("session_id"))
        session.messages = data.get("messages", [])
        session.context = data.get("context", {})
        session.created_at = datetime.fromisoformat(
            data.get("created_at", datetime.utcnow().isoformat())
        )
        return session


class ChatEngine:
    def __init__(self):
        self.settings = get_settings()
        self._sessions: Dict[str, ChatSession] = {}

    def _get_or_create_session(self, session_id: Optional[str] = None) -> ChatSession:
        if session_id and session_id in self._sessions:
            return self._sessions[session_id]
        session = ChatSession(session_id)
        self._sessions[session.session_id] = session
        return session

    def _format_history(self, messages: List[Dict[str, str]]) -> str:
        if not messages:
            return "No previous messages."
        return "\n".join(
            f"{m.get('role', 'user').upper()}: {m.get('content', '')}"
            for m in messages[-20:]  # Keep last 20 messages
        )

    def _get_video_context(self) -> str:
        """Get context about analyzed videos from the registry."""
        try:
            from ..models.sqlite_registry import sqlite_registry
            assets = sqlite_registry.fetch_all(
                "SELECT name, duration, language, status FROM assets WHERE status = 'analyzed' LIMIT 20"
            )
            if not assets:
                return "No videos have been analyzed yet."
            lines = [f"  - {a['name']} ({a.get('duration', 0):.1f}s, {a.get('language', '?')})" for a in assets]
            return f"Analyzed videos ({len(assets)}):\n" + "\n".join(lines)
        except Exception:
            return "Video analysis data not available."

    async def process_message(
        self,
        message: str,
        session_id: Optional[str] = None,
        context: Optional[Dict[str, Any]] = None,
    ) -> ChatResponse:
        """Process a chat message and return an AI response about cutting/editing."""
        session = self._get_or_create_session(session_id)
        if context:
            session.context.update(context)
        session.messages.append({"role": "user", "content": message})

        # Try deterministic commands first
        deterministic = self._try_deterministic(message)
        if deterministic:
            response_text = deterministic
        else:
            # Use LLM for natural conversation
            try:
                history = self._format_history(session.messages)
                video_context = self._get_video_context()
                system = CUTTING_SYSTEM_PROMPT.format(
                    history=history,
                    video_context=video_context,
                )

                result = await provider_service.chat(
                    messages=[{"role": "user", "content": message}],
                    system=system,
                    temperature=0.4,
                    max_tokens=1024,
                )
                response_text = result.get("response", "I'm having trouble connecting to an AI model. Please check your provider settings.")
            except Exception as e:
                logger.error(f"Chat LLM call failed: {e}")
                response_text = self._fallback_response(message)

        session.messages.append({"role": "assistant", "content": response_text})

        return ChatResponse(
            message=ChatMessage(role=MessageRole.ASSISTANT, content=response_text),
            session_id=session.session_id,
        )

    def _try_deterministic(self, message: str) -> Optional[str]:
        """Try to handle common queries with deterministic responses."""
        msg = message.lower().strip()

        # Greeting
        if msg in ["hello", "hi", "hey", "salam", "assalam"]:
            return (
                "Hello! I'm EditFlow AI, your video editing assistant. I can help you:\n"
                "1. Analyze video folders (transcribe, detect fillers/pauses)\n"
                "2. Cut videos based on a script (match Urdu video to English script)\n"
                "3. Place visuals at specific script lines\n"
                "4. Manage your AI providers\n\n"
                "What would you like to do?"
            )

        # Status
        if any(w in msg for w in ["status", "what can you", "help", "commands"]):
            return (
                "EditFlow AI - Available Commands:\n\n"
                "**Video Analysis**: Send a folder path to analyze videos\n"
                "**Script Cutting**: Provide an English script to match against Urdu video\n"
                "**Visual Placement**: Upload a mapping document (docx/txt) with visual folder\n"
                "**Provider Settings**: Configure LLM providers (Ollama, OpenAI, etc.)\n\n"
                "You can also just describe what you want in natural language!"
            )

        return None

    def _fallback_response(self, message: str) -> str:
        """Rule-based fallback when LLM is unavailable."""
        msg = message.lower()

        if any(w in msg for w in ["analyze", "transcribe", "scan"]):
            return "To analyze videos, use: POST /api/pipeline/analyze with your video folder path."

        if any(w in msg for w in ["cut", "script", "edit", "clean"]):
            return "To cut video based on a script, use: POST /api/pipeline/cut with your English script content."

        if any(w in msg for w in ["visual", "image", "overlay", "place"]):
            return "To place visuals, use: POST /api/pipeline/visuals with your mapping document and visual folder."

        if any(w in msg for w in ["provider", "model", "ollama", "openai"]):
            return "To manage providers, use the /api/providers endpoints. Check /api/models/list for available models."

        return (
            "I'm currently in offline mode. For full AI capabilities, please configure an LLM provider. "
            "Type 'help' for available commands."
        )


# Global instance
chat_engine = ChatEngine()
