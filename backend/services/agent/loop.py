"""
EditFlow Agent — Control loop.

The agent loop reads the user's input and conversation history, calls
the LLM, parses the response, and either executes a tool (continuing
the loop) or returns a reply/ask to the frontend.

Max 6 tool-call iterations per user turn.  Each tool call result
feeds back into the LLM context so the agent can chain tools.
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Coroutine, Dict, List, Optional

from .parser import ParsedReply, parse_or_repair
from .prompts import SYSTEM_PROMPT, TOOL_SCHEMAS, FEW_SHOT_EXAMPLES
from . import tools, session as session_store

logger = logging.getLogger(__name__)

_MAX_ITERS = 6


def _looks_like_provider_fallback(text: str) -> bool:
    """Detect chat_engine / provider_service rule-based fallback output.

    When the LLM is unreachable, provider_service returns a canned text body
    instead of a real reply. If we feed that to the parser as if it were the
    model's tool-call JSON, parsing fails and the user sees confusing errors.
    Catching it explicitly lets us return a clean message instead.
    """
    if not text:
        return False
    markers = [
        "couldn't reach the chat model",
        "POST /api/",
        "use the /api/",
        "GET /api/",
        "currently in offline mode",
    ]
    low = text.lower()
    return any(m.lower() in low for m in markers)


def _build_tool_descriptions() -> str:
    """Build a compact text description of available tools for the LLM."""
    lines = []
    for schema in TOOL_SCHEMAS:
        name = schema["name"]
        desc = schema["description"]
        args_desc = ""
        for arg_name, arg_spec in schema.get("args", {}).items():
            arg_type = arg_spec.get("type", "any")
            arg_desc = arg_spec.get("description", "")
            args_desc += f"\n    - {arg_name} ({arg_type}): {arg_desc}"
        lines.append(f"- {name}: {desc}{args_desc}")
    return "\n".join(lines)


_TOOL_DESCRIPTIONS = _build_tool_descriptions()


async def step(
    session: session_store.AgentSession,
    event: str,
    payload: dict,
    ws_emit: Callable[..., Coroutine],
) -> List[Dict[str, Any]]:
    """Execute one agent turn.

    Returns a list of messages to send back to the frontend.
    """
    # Append the incoming event to session history
    if event == "init":
        # Init event — don't add to history, just trigger a scan/list
        session.append_event("init", {"text": "User started a new session. What's in the project?"})
    elif event == "scan_completed":
        # Scan result from frontend
        scan_data = payload.get("result") or payload
        session.context["scan_result"] = scan_data
        session.append_event("scan_completed", {"text": f"Scan complete: {len(scan_data.get('bins', []))} bins, {len(scan_data.get('items', []))} items."})
    elif event == "document_uploaded":
        # Stash document text into session context
        file_id = payload.get("file_id") or payload.get("filename") or "unknown"
        extracted_text = payload.get("full_text") or payload.get("text") or ""
        if extracted_text:
            session.context.setdefault("pending_documents", {})[file_id] = extracted_text
        session.append_event("document_uploaded", {"text": f"User uploaded document: {file_id}"})
    elif event == "tool_user_response":
        # User responded to an "ask" — e.g., approved a plan
        action = payload.get("action", "")
        if action == "approve_plan":
            session.append_event("tool_user_response", {"text": "User approved the plan. Apply it."})
        elif action == "regenerate":
            hint = payload.get("hint", "")
            session.append_event("tool_user_response", {"text": f"User wants to regenerate the plan. Hint: {hint}"})
        else:
            session.append_event("tool_user_response", payload)
    elif event == "extendscript_done":
        session.append_event("extendscript_done", {"text": "ExtendScript execution completed."})
        session.current_phase = "applied"
    else:
        # Default: user_message
        session.append_event(event, payload)

    messages_out: List[Dict[str, Any]] = []

    for i in range(_MAX_ITERS):
        # Build the prompt
        prompt = _build_prompt(session)

        # Call the LLM
        try:
            from ...services.provider_service import provider_service
            raw_result = await provider_service.chat(
                messages=prompt,
                temperature=0.2,
                max_tokens=512,
            )
            raw_text = raw_result.get("response") or ""
            # If provider_service returned a rule-based fallback (LLM unreachable),
            # surface a clear error instead of feeding the fallback text back as
            # the agent's reply. Without this, "I couldn't reach the chat model..."
            # gets treated like an LLM reply and the parser fails or worse, the
            # legacy docs-style fallback shows up in chat as if it were intentional.
            if raw_result.get("error") or _looks_like_provider_fallback(raw_text):
                err = raw_result.get("error") or ""
                logger.warning(f"Agent LLM unreachable. raw_result.error={err!r}")

                # Distinguish "Ollama crashed / disconnected" from "Ollama isn't
                # running at all" — they need different user actions.
                lower_err = err.lower()
                if any(s in lower_err for s in [
                    "server disconnected",
                    "remoteprotocolerror",
                    "readtimeout",
                    "connecttimeout",
                ]):
                    msg = (
                        "Ollama dropped the request before finishing. This usually means:\n"
                        "  - The model's cold-load took longer than allowed (try sending the "
                        "message again — the model is now in memory).\n"
                        "  - The system ran out of RAM (close other apps, or pick a smaller "
                        "model in Settings).\n"
                        "  - The model file is corrupted (`ollama pull <model>` to refresh)."
                    )
                else:
                    msg = (
                        "I couldn't reach the chat model. Open Settings -> Active "
                        "Chat Model and pick one marked 'local', or start Ollama "
                        "if it isn't running. The info icon in the header shows "
                        "live provider status."
                    )

                messages_out.append({"kind": "agent_text", "text": msg})
                return messages_out
        except Exception as e:
            logger.error(f"Agent LLM call failed: {e}")
            messages_out.append({
                "kind": "agent_text",
                "text": f"I had trouble thinking. The LLM service returned an error: {e}. Try again or check your model settings.",
            })
            return messages_out

        if not raw_text.strip():
            messages_out.append({
                "kind": "agent_text",
                "text": "I got an empty response from the model. Please try again.",
            })
            return messages_out

        # Parse the response
        from ...services.provider_service import provider_service
        parsed = await parse_or_repair(raw_text, provider_service.chat)

        if parsed.type == "tool_call":
            # Execute the tool
            tool_name = parsed.tool or ""
            tool_args = parsed.args or {}

            await ws_emit({
                "type": "agent_tool",
                "tool": tool_name,
                "status": "started",
            })

            result = await tools.dispatch(tool_name, tool_args, ws_emit, session=session)
            session.append_tool_call(tool_name, tool_args, result)

            await ws_emit({
                "type": "agent_tool",
                "tool": tool_name,
                "status": "completed",
            })

            if result.get("ui"):
                messages_out.append({"kind": "ui_card", "card": result["ui"]})

            # Check for special UI hints that require frontend action
            ui_kind = (result.get("ui") or {}).get("kind", "")
            if ui_kind == "request_scan":
                # The frontend needs to run the scan — return control
                messages_out.append({
                    "kind": "agent_text",
                    "text": "Let me scan your project. Please wait...",
                })
                return messages_out

            if ui_kind == "plan_apply_request":
                # The frontend needs to dispatch ExtendScript
                messages_out.append({
                    "kind": "agent_text",
                    "text": "Applying the plan in Premiere Pro...",
                })
                return messages_out

            # Continue the loop — the tool result feeds back to the LLM
            continue

        elif parsed.type == "reply":
            messages_out.append({"kind": "agent_text", "text": parsed.text or ""})
            session.append_assistant(parsed.text or "")
            return messages_out

        elif parsed.type == "ask":
            messages_out.append({
                "kind": "ask",
                "question": parsed.question or "",
                "options": parsed.options or [],
            })
            session.append_assistant_ask(parsed)
            return messages_out

        else:
            # Parse error — couldn't make sense of LLM output
            messages_out.append({
                "kind": "agent_text",
                "text": "I'm not sure what to do. Could you rephrase your request?",
            })
            return messages_out

    # Max iterations hit — bail out
    messages_out.append({
        "kind": "agent_text",
        "text": "I ran into a loop and stopped. Please tell me what you want next.",
    })
    return messages_out


def _build_prompt(session: session_store.AgentSession) -> List[Dict[str, str]]:
    """Build the full message list for the LLM call."""
    messages = []

    # System prompt with tool descriptions
    system_content = SYSTEM_PROMPT + "\n\nAvailable tools:\n" + _TOOL_DESCRIPTIONS
    messages.append({"role": "system", "content": system_content})

    # Add few-shot examples (only if session is fresh)
    if len(session.history) <= 2:
        for ex in FEW_SHOT_EXAMPLES:
            messages.append(ex)

    # Add session history (truncated)
    history = session.get_history_for_llm(max_turns=8)
    messages.extend(history)

    return messages
