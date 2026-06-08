"""
EditFlow AI - Chat Engine (Simplified)
AI chat focused on video cutting decisions and pipeline control.
"""
import logging
import time
import uuid
from collections import OrderedDict
from datetime import datetime, timezone
from string import Template
from typing import Any, Dict, List, Optional

from ..config import get_settings
from ..models.schemas import ChatMessage, ChatResponse, MessageRole
from ..services.provider_service import provider_service

logger = logging.getLogger(__name__)


# ── Bounds (constants, tuned for a single-user dev tool) ──
_MAX_SESSIONS = 500
_SESSION_TTL_SECONDS = 60 * 60  # 1 hour
_MAX_MESSAGES_PER_SESSION = 100
_MAX_USER_MESSAGE_LEN = 8000


# Using string.Template + safe_substitute so user content with literal '{' or '}'
# characters does not raise KeyError out of str.format(). The body keeps the JSON
# examples readable because $-placeholders are unambiguous.
CUTTING_SYSTEM_PROMPT = Template("""You are EditFlow AI, an intelligent video editing assistant.
Your primary job is to help users cut and clean up their videos using AI.
You are integrated with Adobe Premiere Pro via a CEP panel extension.

CORE CAPABILITIES:
1. **Analyze Videos**: Scan folders of video files, transcribe speech, detect fillers/pauses/repetitions.
2. **Script-Based Cutting**: Given a script (English) and Urdu video recordings, find the best takes for each line and remove bad takes, fillers, pauses, and repetitions.
3. **Visual Placement**: Place visuals (images/video clips) at specific points in the cut video based on a mapping document.
4. **Provider Management**: Help users configure and manage LLM providers (Ollama, OpenAI-compatible APIs).
5. **Premiere Pro Control**: Interact with the user's Premiere Pro timeline - read sequences, scan project bins, and apply cuts directly to the timeline.

HOW TO RESPOND:
- Be helpful, concise, and actionable.
- When users ask to analyze videos, suggest using the Analyze tab or /api/pipeline/analyze endpoint.
- When users provide a script, suggest the Cut tab or /api/pipeline/cut endpoint.
- When users want to place visuals, suggest the Visuals tab or /api/pipeline/visuals endpoint.
- When users want to apply cuts to Premiere Pro, mention the "Send to Premiere" button or /api/premiere/edl endpoints.
- For technical questions about the pipeline, explain clearly.
- If unsure, ask for clarification.

CUTTING PIPELINE WORKFLOW:
1. First, analyze the video folder: POST /api/pipeline/analyze with a folder_path and language hint.
2. Then, provide the English script to match: POST /api/pipeline/cut with script_content, script_language and video_language.
3. Apply cuts to Premiere Pro timeline: POST /api/premiere/edl/from-cuts generates an EDL file that the CEP panel executes.
4. Optionally, place visuals: POST /api/pipeline/visuals with the mapping document and visual folder.

CROSS-LINGUAL MATCHING:
- Videos are in Urdu, scripts are in English
- The AI understands both languages and matches by semantic meaning
- Best takes are selected based on delivery quality (fewer fillers, no pauses, no repetitions)

PREMIERE PRO INTEGRATION:
- The CEP panel can scan the project, read sequence state, and apply EDL operations
- Use "Sync Sequence" in settings to update the AI's context about the current timeline
- Use "Scan Project" to load all project bins and media into the AI's context
- Cuts from the pipeline can be sent directly to the Premiere timeline via EDL

CONVERSATION CONTEXT:
$history

ANALYZED VIDEOS CONTEXT:
$video_context

PREMIERE PRO CONTEXT:
$premiere_context
""")


class ChatSession:
    """Manages a single chat session's context and history."""

    def __init__(self, session_id: Optional[str] = None):
        self.session_id = session_id or str(uuid.uuid4())[:8]
        self.messages: List[Dict[str, str]] = []
        self.context: Dict[str, Any] = {}
        self.created_at = datetime.now(timezone.utc)

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
        created_str = data.get("created_at") or datetime.now(timezone.utc).isoformat()
        try:
            session.created_at = datetime.fromisoformat(created_str)
        except ValueError:
            session.created_at = datetime.now(timezone.utc)
        return session

    def append_message(self, role: str, content: str) -> None:
        """Append a message and enforce the per-session cap."""
        self.messages.append({"role": role, "content": content})
        if len(self.messages) > _MAX_MESSAGES_PER_SESSION:
            # Drop oldest, keep the most recent N — preserves recency for the LLM
            self.messages = self.messages[-_MAX_MESSAGES_PER_SESSION:]


class ChatEngine:
    def __init__(self):
        self.settings = get_settings()
        # OrderedDict gives us O(1) LRU bumps via move_to_end and popitem(last=False)
        self._sessions: "OrderedDict[str, ChatSession]" = OrderedDict()

    # ── Session lifecycle ──

    def _evict_stale(self) -> None:
        """Drop sessions past the TTL, then enforce the size cap."""
        now = time.time()
        stale = [
            sid for sid, s in self._sessions.items()
            if (now - s.created_at.timestamp()) > _SESSION_TTL_SECONDS
        ]
        for sid in stale:
            self._sessions.pop(sid, None)
        while len(self._sessions) > _MAX_SESSIONS:
            self._sessions.popitem(last=False)

    def _get_or_create_session(self, session_id: Optional[str] = None) -> ChatSession:
        if session_id and session_id in self._sessions:
            self._sessions.move_to_end(session_id)
            self._evict_stale()
            return self._sessions[session_id]
        session = ChatSession(session_id)
        self._sessions[session.session_id] = session
        self._evict_stale()
        return session

    def get_session(self, session_id: str) -> Optional[ChatSession]:
        """Public accessor used by the chat routes. Bumps LRU on hit."""
        session = self._sessions.get(session_id)
        if session:
            self._sessions.move_to_end(session_id)
        self._evict_stale()
        return session

    def create_new_session(self) -> ChatSession:
        """Public factory used by the chat routes."""
        session = ChatSession()
        self._sessions[session.session_id] = session
        self._evict_stale()
        return session

    # ── Context helpers ──

    def _format_history(self, messages: List[Dict[str, str]]) -> str:
        if not messages:
            return "No previous messages."
        return "\n".join(
            f"{m.get('role', 'user').upper()}: {m.get('content', '')}"
            for m in messages[-20:]
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
            lines = [
                f"  - {a.get('name', '?')} ({a.get('duration', 0):.1f}s, {a.get('language', '?')})"
                for a in assets
            ]
            return f"Analyzed videos ({len(assets)}):\n" + "\n".join(lines)
        except Exception:
            return "Video analysis data not available."

    def _get_premiere_context(self) -> str:
        """Get context about the current Premiere Pro state."""
        try:
            from ..routes.premiere import _project_context
            if not _project_context.get("last_updated"):
                return "Premiere Pro panel not connected or no context synced yet."
            items_count = len(_project_context.get("items", []))
            bins_count = len(_project_context.get("bins", []))
            sequences = _project_context.get("sequences", [])

            lines = [f"Project: {items_count} items, {bins_count} bins"]
            if sequences:
                for seq in sequences:
                    name = seq.get("name", "Unknown")
                    vt = len(seq.get("videoTracks", []))
                    at = len(seq.get("audioTracks", []))
                    total_clips = sum(len(t.get("clips", [])) for t in seq.get("videoTracks", []))
                    total_clips += sum(len(t.get("clips", [])) for t in seq.get("audioTracks", []))
                    lines.append(f"Sequence '{name}': {vt} video tracks, {at} audio tracks, {total_clips} clips")
            return "Premiere Pro context:\n" + "\n".join(lines)
        except Exception:
            return "Premiere Pro context not available."

    # ── Message processing ──

    async def process_message(
        self,
        message: str,
        session_id: Optional[str] = None,
        context: Optional[Dict[str, Any]] = None,
    ) -> ChatResponse:
        """Process a chat message and return an AI response about cutting/editing."""
        # Length cap — protects the LLM, our memory, and the WebSocket frame size
        if message and len(message) > _MAX_USER_MESSAGE_LEN:
            message = message[:_MAX_USER_MESSAGE_LEN]

        session = self._get_or_create_session(session_id)
        if context:
            session.context.update(context)
        session.append_message("user", message)

        deterministic = self._try_deterministic(message)
        if deterministic:
            response_text = deterministic
        else:
            try:
                history = self._format_history(session.messages)
                video_context = self._get_video_context()
                premiere_context = self._get_premiere_context()
                # safe_substitute ignores stray '{' / '}' in user content
                system = CUTTING_SYSTEM_PROMPT.safe_substitute(
                    history=history,
                    video_context=video_context,
                    premiere_context=premiere_context,
                )

                result = await provider_service.chat(
                    messages=[{"role": "user", "content": message}],
                    system=system,
                    temperature=0.4,
                    max_tokens=1024,
                )
                response_text = result.get("response") or (
                    "I'm having trouble connecting to an AI model. "
                    "Please check your provider settings."
                )
            except Exception as e:
                logger.error(f"Chat LLM call failed: {e}")
                response_text = self._fallback_response(message)

        session.append_message("assistant", response_text)

        return ChatResponse(
            message=ChatMessage(role=MessageRole.ASSISTANT, content=response_text),
            session_id=session.session_id,
        )

    def _try_deterministic(self, message: str) -> Optional[str]:
        """Handle common queries with deterministic responses."""
        msg = message.lower().strip()

        if msg in ["hello", "hi", "hey", "salam", "assalam"]:
            return (
                "Hello! I'm EditFlow AI, your video editing assistant. I can help you:\n"
                "1. Analyze video folders (transcribe, detect fillers/pauses)\n"
                "2. Cut videos based on a script (match Urdu video to English script)\n"
                "3. Place visuals at specific script lines\n"
                "4. Manage your AI providers\n"
                "5. Control Premiere Pro (scan project, apply cuts to timeline)\n\n"
                "What would you like to do?"
            )

        if any(w in msg for w in ["status", "what can you", "help", "commands"]):
            return (
                "EditFlow AI - Available Commands:\n\n"
                "**Video Analysis**: Send a folder path to analyze videos\n"
                "**Script Cutting**: Provide an English script to match against Urdu video\n"
                "**Visual Placement**: Upload a mapping document (docx/txt) with visual folder\n"
                "**Provider Settings**: Configure LLM providers (Ollama, OpenAI, etc.)\n"
                "**Premiere Pro**: Scan project, sync sequence, apply cuts to timeline\n\n"
                "You can also just describe what you want in natural language!"
            )

        return None

    def _fallback_response(self, message: str) -> str:
        """User-facing message when the LLM is unreachable.

        The previous version returned developer-doc strings like
        "use POST /api/pipeline/analyze ..." which leaked into the chat and
        confused users. Now we return ONE clear actionable message — the
        user shouldn't see internal API endpoint names in chat.
        """
        return (
            "I couldn't reach the chat model. Most common causes:\n"
            "  - Ollama isn't running (start it, then retry).\n"
            "  - The selected model isn't installed (open Settings -> Active "
            "Chat Model and pick one marked 'local').\n"
            "  - The model timed out (try a smaller model like "
            "nemotron-3-nano:4b).\n"
            "Click the info icon in the header for live provider status."
        )


# Global instance
chat_engine = ChatEngine()
