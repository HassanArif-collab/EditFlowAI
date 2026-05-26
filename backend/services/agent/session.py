"""
EditFlow Agent — In-memory session storage with TTL and LRU eviction.

Each session holds the conversation history, accumulated context (scan
results, transcripts, documents, plan IDs), and the current phase.
Sessions expire after 24 hours of inactivity.  At most 100 sessions
are kept; the least-recently-used one is evicted when the cap is hit.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .parser import ParsedReply

logger = logging.getLogger(__name__)

_TTL_SECONDS = 24 * 3600  # 24 hours
_MAX_SESSIONS = 100


@dataclass
class AgentSession:
    """One agent conversation session."""
    id: str
    created_at: float = field(default_factory=time.time)
    last_used: float = field(default_factory=time.time)
    history: List[Dict[str, Any]] = field(default_factory=list)
    context: Dict[str, Any] = field(default_factory=lambda: {
        "scan_result": None,
        "selected_clips": [],
        "transcripts_ready": {},
        "current_plan_id": None,
        "pending_documents": {},
    })
    current_phase: str = "exploring"
    _turn_counter: int = field(default=0)

    # ── History appenders ──────────────────────────────────────

    def append_event(self, event: str, payload: dict) -> None:
        """Append an incoming event (user_message, scan_completed, etc.)."""
        self.touch()
        self.history.append({
            "role": "user",
            "content": payload.get("text") or str(payload),
            "meta": {"event": event},
        })

    def append_tool_call(self, tool: str, args: dict, result: dict) -> None:
        """Append a tool call + its result to the history."""
        self.touch()
        self.history.append({
            "role": "assistant",
            "content": None,
            "tool_call": {
                "tool": tool,
                "args": args,
                "result_summary": result.get("summary", ""),
            },
        })
        # Keep tool result data in session context, not in the LLM prompt
        self._update_context_from_tool(tool, result)

    def append_assistant(self, text: str) -> None:
        """Append an assistant text reply."""
        self.touch()
        self.history.append({"role": "assistant", "content": text})

    def append_assistant_ask(self, parsed: ParsedReply) -> None:
        """Append an assistant 'ask' (question with options)."""
        self.touch()
        self.history.append({
            "role": "assistant",
            "content": parsed.question or "",
            "meta": {"type": "ask", "options": parsed.options or []},
        })

    # ── History for LLM ───────────────────────────────────────

    def get_history_for_llm(self, max_turns: int = 8) -> List[Dict[str, str]]:
        """Return a truncated history suitable for the LLM context.

        Only the last *max_turns* user/assistant exchanges are included.
        Tool results use only the ``summary`` field (≤300 tokens each).
        """
        # Filter to only user and assistant messages
        relevant = []
        for entry in self.history:
            if entry.get("role") == "user":
                relevant.append({
                    "role": "user",
                    "content": entry.get("content") or "",
                })
            elif entry.get("role") == "assistant":
                if entry.get("tool_call"):
                    relevant.append({
                        "role": "assistant",
                        "content": f"[Tool call: {entry['tool_call']['tool']}]",
                    })
                    relevant.append({
                        "role": "user",
                        "content": f"[Tool result: {entry['tool_call'].get('result_summary', '')}]",
                    })
                else:
                    relevant.append({
                        "role": "assistant",
                        "content": entry.get("content") or "",
                    })

        # Keep last max_turns pairs
        if len(relevant) > max_turns * 2:
            # Summarize older context in one line
            older = relevant[:-max_turns * 2]
            recent = relevant[-max_turns * 2:]
            older_summary = "earlier in this session: "
            for msg in older:
                if msg["role"] == "user" and not msg["content"].startswith("[Tool"):
                    older_summary += msg["content"][:100] + "; "
            return [{"role": "system", "content": older_summary[:500]}] + recent

        return relevant

    # ── Turn ID ────────────────────────────────────────────────

    def next_turn_id(self) -> str:
        """Return a monotonically-increasing turn ID."""
        self._turn_counter += 1
        return f"turn-{self._turn_counter}"

    # ── Helpers ────────────────────────────────────────────────

    def touch(self) -> None:
        self.last_used = time.time()

    def _update_context_from_tool(self, tool: str, result: dict) -> None:
        """Stash tool results into session context for later access."""
        if not result.get("success"):
            return

        # NOTE: result["data"] is often explicitly None (e.g. scan_project's
        # envelope sets data=None — the actual scan happens on the frontend).
        # dict.get("data", {}) returns the stored None, NOT the default, so
        # we use `result.get("data") or {}` to coerce None into an empty dict
        # before chaining .get(). This is why init was throwing AttributeError
        # on every fresh session.
        data = result.get("data") or {}

        if tool == "scan_project" and data.get("scan"):
            self.context["scan_result"] = data["scan"]
        elif tool in ("list_bins",) and data.get("bins"):
            # Don't overwrite a full scan_result, but note bins are known
            pass
        elif tool == "resolve_clips_in_bin" and data.get("clips"):
            self.context["selected_clips"] = data["clips"]
        elif tool == "transcribe_clips" and data.get("clips"):
            for clip_info in data["clips"]:
                path = clip_info.get("path", "")
                if path:
                    self.context["transcripts_ready"][path] = clip_info.get("fingerprint", "done")
        elif tool in (
            "match_script_to_transcripts",
            "propose_cuts_from_transcripts",
            # apply_pasted_plan produces a Plan exactly like the matcher tools,
            # so its plan_id should flow into current_plan_id the same way —
            # otherwise a follow-up "Build sequence" can't find it.
            "apply_pasted_plan",
        ):
            plan_id = data.get("plan_id")
            if plan_id:
                self.context["current_plan_id"] = plan_id
                self.current_phase = "planning"
        elif tool == "apply_plan":
            self.current_phase = "applied"

        # Update phase based on context
        if tool == "transcribe_clips" and self.context.get("transcripts_ready"):
            if self.current_phase == "exploring":
                self.current_phase = "transcribing"


# ── Global session store ───────────────────────────────────────

_sessions: Dict[str, AgentSession] = {}


def get_or_create(session_id: str) -> AgentSession:
    """Return the session with *session_id*, creating it if absent."""
    if session_id in _sessions:
        s = _sessions[session_id]
        s.touch()
        return s

    s = AgentSession(id=session_id)
    _sessions[session_id] = s

    # Evict if over cap
    if len(_sessions) > _MAX_SESSIONS:
        evict_stale()

    return s


def evict_stale() -> int:
    """Remove expired sessions and evict LRU if over cap.  Returns number evicted."""
    now = time.time()
    evicted = 0

    # Remove TTL-expired
    stale = [sid for sid, s in _sessions.items() if now - s.last_used > _TTL_SECONDS]
    for sid in stale:
        del _sessions[sid]
        evicted += 1

    # If still over cap, evict LRU
    while len(_sessions) > _MAX_SESSIONS:
        oldest_id = min(_sessions, key=lambda sid: _sessions[sid].last_used)
        del _sessions[oldest_id]
        evicted += 1

    if evicted:
        logger.info(f"Session eviction: removed {evicted} session(s), {len(_sessions)} remaining")
    return evicted


def reset_session(session_id: str) -> None:
    """Delete a session (e.g., on 'new edit')."""
    _sessions.pop(session_id, None)


def get_all_sessions() -> Dict[str, AgentSession]:
    """Return all sessions (for debugging)."""
    return dict(_sessions)
