"""
EditFlow AI - Chat Engine
Natural language chat with intent classification and context management.
"""
import json
import logging
import re
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from ..config import Settings
from ..models.database import db
from ..models.schemas import ChatMessage, ChatResponse, MessageRole, PremiereAction, ScriptPreview
from ..services.ollama_service import ollama_service

logger = logging.getLogger(__name__)


SYSTEM_PROMPT = """You are EditFlow AI, an editing assistant for Adobe Premiere Pro.
You help users edit video by understanding their requests and returning structured commands.

ALWAYS respond with valid JSON in this exact format:
{{
  "intent": "<one of the intent types listed below>",
  "confidence": <0.0 to 1.0>,
  "parameters": {{ <intent-specific parameters> }},
  "response": "<friendly message to show the user>"
}}

INTENT TYPES AND THEIR PARAMETERS:

chat - General conversation. Parameters: {{}}
import_files - Import files from disk. Parameters: {{ "paths": ["/path/to/file"], "folder": "/path/to/folder", "targetBin": "optional bin name" }}
add_clips - Add clips to timeline. Parameters: {{ "source": "all"|"bin_name", "sequenceName": "optional", "filter": "all"|"video"|"audio", "trackIndex": 0 }}
insert_clip - Insert single clip. Parameters: {{ "clipName": "name", "trackIndex": 0, "startTime": 0, "trackType": "video" }}
remove_clips - Remove clips. Parameters: {{ "mode": "broll"|"label"|"name"|"all", "labelName": "", "clipName": "", "sequenceName": "" }}
clear_labels - Clear/reset timeline clip label colors. Parameters: {{ "labelName": "", "sequenceName": "" }}
move_clip - Move a clip. Parameters: {{ "clipName": "", "trackIndex": 0, "startTime": 0, "newStartTime": 5, "trackType": "video" }}
create_sequence - New sequence. Parameters: {{ "name": "Sequence Name" }}
query_project - Scan project. Parameters: {{}}
query_timeline - Read timeline state. Parameters: {{}}
apply_effect - Apply effect. Parameters: {{ "effectName": "Gaussian Blur", "trackIndex": 0, "clipIndex": 0 }}
apply_transition - Apply transition. Parameters: {{ "transitionName": "Cross Dissolve", "trackIndex": 0, "duration": 0.5 }}
set_audio - Set audio level. Parameters: {{ "levelDb": -3.0, "trackIndex": 0, "clipIndex": 0 }}
normalize_audio - Normalize audio. Parameters: {{ "targetDb": -3.0 }}
audio_fade - Fade audio. Parameters: {{ "fadeIn": 1.0, "fadeOut": 1.0, "trackIndex": 0, "clipIndex": 0 }}
export - Export sequence. Parameters: {{ "outputPath": "/path/to/output.mp4", "presetPath": "" }}
add_marker - Add marker. Parameters: {{ "time": 10.0, "name": "Marker Name", "comment": "", "duration": 0 }}
organize - Organize bins. Parameters: {{ "rules": [{{ "binName": "B-Roll", "filter": "video" }}] }}
label_clips - Set labels. Parameters: {{ "label": "Mango", "scope": "timeline", "filter": "broll" }}
set_speed - Change speed. Parameters: {{ "clipName": "", "speed": 2.0, "trackIndex": 0, "trackType": "video" }}
set_scale - Change scale. Parameters: {{ "clipName": "", "scale": 120, "trackIndex": 0, "trackType": "video" }}
generate_script - Generate edit script. Parameters: {{ "style": "rough_cut"|"highlight" }}
execute_script - Execute script. Parameters: {{}}
undo - Undo last action. Parameters: {{}}
manage_tracks - Track operations. Parameters: {{ "action": "add"|"mute"|"clear", "trackType": "video"|"audio", "trackIndex": 0, "mute": true }}

RULES:
1. Pick the SINGLE most appropriate intent.
2. Extract parameters from the user's natural language.
3. Use the current project/timeline context when the user says "this", "opened", "current", "that clip", or a sequence/clip name.
4. If the request is ambiguous and could damage the edit, use "chat" and ask one short clarification question.
5. Be concise in "response" - 1-2 sentences max.
6. If the user asks for "music" or "audio", include "filter": "audio" for add_clips.
7. Default trackIndex to 0 and trackType to "video" if not specified.
8. When returning an action, never say it is already done. Say what will be executed; the CEP panel reports success/failure after Premiere runs it.
9. If the request needs a Premiere operation not listed above, use "chat" and explain the missing capability briefly.

CURRENT PROJECT CONTEXT:
{project_context}

CURRENT TIMELINE CONTEXT:
{timeline_context}

CONVERSATION HISTORY:
{history}
"""


class ChatSession:
    """Manages a single chat session's context and history."""

    def __init__(self, session_id: Optional[str] = None):
        self.session_id = session_id or str(uuid.uuid4())[:8]
        self.messages: List[Dict[str, str]] = []
        self.current_script: Optional[ScriptPreview] = None
        self.context: Dict[str, Any] = {}
        self.created_at = datetime.utcnow()

    def to_dict(self) -> Dict:
        return {
            "session_id": self.session_id,
            "messages": self.messages,
            "current_script": self.current_script.dict() if self.current_script else None,
            "context": self.context,
            "created_at": self.created_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, data: Dict) -> "ChatSession":
        session = cls(session_id=data.get("session_id"))
        session.messages = data.get("messages", [])
        if data.get("current_script"):
            session.current_script = ScriptPreview(**data["current_script"])
        session.context = data.get("context", {})
        session.created_at = datetime.fromisoformat(data.get("created_at", datetime.utcnow().isoformat()))
        return session


class ChatEngine:
    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or Settings()
        self._sessions: Dict[str, ChatSession] = {}

    def _get_or_create_session(self, session_id: Optional[str] = None) -> ChatSession:
        if session_id and session_id in self._sessions:
            return self._sessions[session_id]
        if session_id:
            session_data = db.get_session(session_id)
            if session_data:
                session = ChatSession.from_dict(session_data)
                self._sessions[session_id] = session
                return session
        session = ChatSession(session_id)
        self._sessions[session.session_id] = session
        return session

    def _save_session(self, session_id: str, session: ChatSession):
        db.save_session(session_id, session.to_dict())

    def _format_history(self, messages: List[Dict[str, str]]) -> str:
        return "".join(f"{m.get('role', 'user').upper()}: {m.get('content', '')}\n" for m in messages)

    async def _get_project_context(self) -> dict:
        try:
            from ..routes.premiere import PROJECT_CONTEXT

            return PROJECT_CONTEXT
        except ImportError:
            return {}

    def _format_project_context(self, ctx: dict) -> str:
        if not ctx or not ctx.get("items"):
            return "No project data available."
        items = ctx["items"]
        lines = [
            f"Project has {ctx.get('total_items', len(items))} media items.",
            f"Video: {ctx.get('video_items', '?')} | Audio: {ctx.get('audio_items', '?')}",
        ]
        bins = ctx.get("bins") or []
        if bins:
            lines.append("Bins: " + ", ".join(str(b) for b in bins[:20]))
        sequences = ctx.get("sequences") or []
        if sequences:
            names = [str(s.get("name", "unknown")) if isinstance(s, dict) else str(s) for s in sequences[:20]]
            lines.append("Sequences: " + ", ".join(names))
        for item in items[:40]:
            if isinstance(item, dict):
                line = "  - " + str(item.get("name", "unknown"))
                if item.get("duration"):
                    line += f" ({float(item['duration']):.1f}s)"
                if item.get("bin_path"):
                    line += f" in {item['bin_path']}"
                lines.append(line)
        return "\n".join(lines)

    def _format_timeline_context(self, context: Optional[Dict[str, Any]]) -> str:
        if not context:
            return "No live timeline context was sent by the panel."
        state = context.get("sequence") or context.get("timeline") or context
        if not isinstance(state, dict):
            return "Timeline context was sent, but it was not readable."
        clips = state.get("clips") or []
        lines = [
            f"Sequence: {state.get('name') or 'unknown'}",
            f"Resolution: {state.get('width', '?')}x{state.get('height', '?')} @ {state.get('fps', '?')}fps",
            f"Tracks: {state.get('video_tracks', state.get('videoTracks', '?'))}V {state.get('audio_tracks', state.get('audioTracks', '?'))}A",
            f"Clips: {len(clips) if isinstance(clips, list) else 0}",
        ]
        if isinstance(clips, list):
            for clip in clips[:50]:
                if isinstance(clip, dict):
                    lines.append(
                        "  - "
                        + str(clip.get("name") or "unknown")
                        + f" [{clip.get('track_type', clip.get('trackType', 'video'))} "
                        + f"{clip.get('track_index', clip.get('trackIndex', 0))}]"
                    )
        return "\n".join(lines)

    async def process_message(
        self,
        message: str,
        session_id: str = None,
        context: Optional[Dict[str, Any]] = None,
    ) -> ChatResponse:
        session = self._get_or_create_session(session_id)
        if context:
            session.context.update(context)
        session.messages.append({"role": "user", "content": message})

        history = self._format_history(session.messages[-10:])
        project_context = self._format_project_context(await self._get_project_context())
        timeline_context = self._format_timeline_context(context or session.context)

        system = SYSTEM_PROMPT.format(
            project_context=project_context,
            timeline_context=timeline_context,
            history=history,
        )

        parsed = self._deterministic_command(message)
        if parsed is None:
            try:
                raw_response_data = await ollama_service.chat_with_fallback(
                    messages=[{"role": "user", "content": message}],
                    system=system,
                    temperature=0.3,
                    max_tokens=1024,
                )
                parsed = self._parse_llm_response(raw_response_data.get("response", ""))
            except Exception as e:
                logger.error(f"LLM call failed: {e}")
                parsed = self._rule_based_fallback(message)

        intent = parsed.get("intent", "chat")
        parameters = parsed.get("parameters", {})
        response_text = parsed.get("response", "I'll help you with that.")
        action = self._build_action(intent, parameters)

        session.messages.append({"role": "assistant", "content": response_text})
        self._save_session(session.session_id, session)

        return ChatResponse(
            message=ChatMessage(role=MessageRole.ASSISTANT, content=response_text),
            intent=intent,
            actions=[PremiereAction(**action)] if action else [],
            parameters=parameters,
            session_id=session.session_id,
        )

    def _parse_llm_response(self, raw: str) -> dict:
        text = raw.strip()
        if text.startswith("```"):
            text = "\n".join(line for line in text.split("\n") if not line.strip().startswith("```"))

        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass

        match = re.search(r"\{[\s\S]*\}", text)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass

        return {"intent": "chat", "confidence": 0.5, "parameters": {}, "response": raw}

    def _build_action(self, intent: str, parameters: dict) -> dict | None:
        intent_to_command = {
            "import_files": "importFiles",
            "add_clips": "addAllBinClips",
            "insert_clip": "insertClipAtTime",
            "remove_clips": "removeTimelineClips",
            "clear_labels": "clearTimelineLabels",
            "move_clip": "moveClip",
            "create_sequence": "createSequence",
            "query_project": "scanProject",
            "query_timeline": "getSequenceState",
            "apply_effect": "applyEffect",
            "apply_transition": "applyTransitionToAll",
            "set_audio": "setAudioLevel",
            "normalize_audio": "normalizeAudio",
            "audio_fade": "audioFade",
            "export": "exportSequence",
            "add_marker": "addMarker",
            "organize": "organizeBin",
            "label_clips": "setClipLabel",
            "set_speed": "modifyClip",
            "set_scale": "modifyClip",
            "undo": "undoAction",
            "manage_tracks": "manageTracks",
        }

        if intent == "chat":
            return None
        if intent == "generate_script":
            return {"type": "generate_script", "parameters": parameters}
        if intent == "v2_folder_sequence":
            return {"type": "v2_folder_sequence", "parameters": parameters}
        if intent == "query_timeline":
            return {"type": "query_sequence", "parameters": parameters}
        if intent == "execute_script":
            return {"type": "execute_script", "parameters": parameters}

        command = intent_to_command.get(intent)
        if not command:
            return None
        return {
            "type": "premiere_command",
            "command": command,
            "parameters": self._normalize_action_parameters(parameters),
        }

    def _normalize_action_parameters(self, parameters: dict) -> dict:
        if not isinstance(parameters, dict):
            return {}
        aliases = {
            "target_bin": "targetBin",
            "bin_name": "binName",
            "sequence_name": "sequenceName",
            "clip_name": "clipName",
            "track_index": "trackIndex",
            "track_type": "trackType",
            "start_time": "startTime",
            "new_start_time": "newStartTime",
            "label_name": "labelName",
            "effect_name": "effectName",
            "transition_name": "transitionName",
            "clip_index": "clipIndex",
            "level_db": "levelDb",
            "target_db": "targetDb",
            "fade_in": "fadeIn",
            "fade_out": "fadeOut",
            "output_path": "outputPath",
            "preset_path": "presetPath",
        }
        normalized = dict(parameters)
        for old, new in aliases.items():
            if old in normalized and new not in normalized:
                normalized[new] = normalized[old]
        if normalized.get("mode") == "label" and "labelName" not in normalized and normalized.get("label"):
            normalized["labelName"] = normalized["label"]
        if "rules" in normalized and isinstance(normalized["rules"], list):
            normalized["rules"] = [
                self._normalize_action_parameters(rule) if isinstance(rule, dict) else rule
                for rule in normalized["rules"]
            ]
        return normalized

    def _deterministic_command(self, message: str) -> Optional[dict]:
        msg = message.lower()
        labels = ["violet", "iris", "caribbean", "lavender", "cerulean", "forest", "rose", "mango"]
        label_name = next((label.title() for label in labels if re.search(rf"\b{re.escape(label)}\b", msg)), "")
        sequence_name = self._extract_sequence_name(message)
        folder_name = self._extract_folder_name(message)
        bin_path = self._extract_bin_path(message)

        if (folder_name or bin_path) and ("raw" in msg or "@folder:" in msg or "@bin:" in msg or "bin" in msg) and re.search(r"\b(combine|polish|polished|make|create|sequence|edit)\b", msg):
            return {
                "intent": "v2_folder_sequence",
                "confidence": 0.98,
                "parameters": {
                    "request": message,
                    "kind": "bin" if bin_path else "bin_or_folder",
                    "rootAlias": "raw" if "raw" in msg else "",
                    "folderName": folder_name,
                    "binPath": bin_path,
                    "operation": "combine_folder_videos_new_sequence",
                    "target": "@new_sequence",
                },
                "response": "I'll resolve that folder or Premiere bin first, create a v2 dry run, and only execute after the exact media is known.",
            }

        if label_name and re.search(r"\b(remove|clear|reset)\b", msg) and ("label" in msg or "color" in msg):
            return {
                "intent": "clear_labels",
                "confidence": 0.98,
                "parameters": {
                    "labelName": label_name,
                    "sequenceName": sequence_name,
                },
                "response": f"I'll clear the {label_name} label color from the matching clips in the target sequence.",
            }

        if re.search(r"\b(remove|delete)\b", msg) and re.search(r"\bb[- ]?rolls?\b", msg):
            return {
                "intent": "remove_clips",
                "confidence": 0.96,
                "parameters": {
                    "mode": "broll",
                    "sequenceName": sequence_name,
                },
                "response": "I'll remove B-roll clips from the target sequence.",
            }

        if "copy" in msg and "selected clip" in msg:
            return {
                "intent": "chat",
                "confidence": 0.9,
                "parameters": {},
                "response": "Copying selected timeline clips is not wired into the Premiere bridge yet. I can still move, insert, remove, label, organize, add markers, adjust audio, and export with the current command set.",
            }

        return None

    def _extract_sequence_name(self, message: str) -> str:
        patterns = [
            r"sequence\s+(?:called|named|of)\s+(.+)$",
            r"from\s+the\s+sequence\s+(.+)$",
            r"in\s+the\s+sequence\s+(.+)$",
        ]
        for pattern in patterns:
            match = re.search(pattern, message, flags=re.IGNORECASE)
            if match:
                return match.group(1).strip().strip("\"'")
        return ""

    def _extract_folder_name(self, message: str) -> str:
        match = re.search(r"\bfolder\s+([A-Za-z0-9_.-]+)", message, flags=re.IGNORECASE)
        return match.group(1).strip() if match else ""

    def _extract_bin_path(self, message: str) -> str:
        quoted = re.search(r"@bin:(?:\"([^\"]+)\"|'([^']+)')", message, flags=re.IGNORECASE)
        if quoted:
            return (quoted.group(1) or quoted.group(2) or "").strip().strip("/")
        explicit = re.search(r"@bin:([^\s,;]+)", message, flags=re.IGNORECASE)
        if explicit:
            return explicit.group(1).strip().strip("/")
        natural = re.search(r"\bbin\s+([A-Za-z0-9_. -]+/[A-Za-z0-9_. /-]+)", message, flags=re.IGNORECASE)
        return natural.group(1).strip().strip("/") if natural else ""

    def _rule_based_fallback(self, message: str) -> dict:
        msg = message.lower()
        if "hello" in msg or "hi" in msg:
            return {
                "intent": "chat",
                "response": "Hello! I am EditFlow AI. How can I help you edit today?",
                "parameters": {},
            }
        if "timeline" in msg or "sequence" in msg:
            return {"intent": "query_timeline", "response": "Let me check the timeline for you.", "parameters": {}}
        return {"intent": "chat", "response": "I'm offline right now, please check my configuration.", "parameters": {}}


chat_engine = ChatEngine()
