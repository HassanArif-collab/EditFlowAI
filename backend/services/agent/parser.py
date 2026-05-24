"""
EditFlow Agent — JSON tool-call parser with one-shot repair.

The LLM is instructed to output a single JSON object per reply.
This module extracts, parses, and validates that JSON.  If parsing
fails, one repair attempt is made by re-prompting the LLM.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine, Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class ParsedReply:
    """Structured representation of a parsed LLM reply."""
    type: str  # "tool_call" | "reply" | "ask" | "error"
    tool: Optional[str] = None
    args: Optional[Dict[str, Any]] = None
    text: Optional[str] = None
    question: Optional[str] = None
    options: Optional[List[Dict[str, str]]] = None
    error: Optional[str] = None


# Regex to find the first balanced {…} block (non-greedy inside)
_BRACE_RE = re.compile(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', re.DOTALL)


def _extract_json_block(text: str) -> Optional[str]:
    """Return the first balanced {…} block found in *text*, or None."""
    # Strip ```json … ``` fences first
    fenced = re.search(r'```(?:json)?\s*\n?(.*?)\n?\s*```', text, re.DOTALL)
    if fenced:
        return fenced.group(1).strip()

    # Try the whole text if it looks like JSON
    stripped = text.strip()
    if stripped.startswith('{') and stripped.endswith('}'):
        return stripped

    # Fall back to first balanced brace block
    m = _BRACE_RE.search(text)
    return m.group(0) if m else None


def parse(text: str) -> Optional[ParsedReply]:
    """Parse raw LLM output into a ParsedReply.

    Returns None when the text cannot be interpreted at all.
    """
    block = _extract_json_block(text)
    if not block:
        # No JSON found — treat the whole text as a plain reply
        return ParsedReply(type="reply", text=text.strip())

    try:
        obj = json.loads(block)
    except json.JSONDecodeError:
        return None

    if not isinstance(obj, dict):
        return None

    reply_type = obj.get("type", "")

    if reply_type == "tool_call":
        tool_name = obj.get("tool") or obj.get("name") or obj.get("function")
        if not tool_name:
            return ParsedReply(type="error", error="tool_call missing 'tool' field")
        return ParsedReply(
            type="tool_call",
            tool=str(tool_name),
            args=obj.get("args") or obj.get("arguments") or {},
        )

    if reply_type == "ask":
        return ParsedReply(
            type="ask",
            question=obj.get("question") or obj.get("text") or "",
            options=obj.get("options") or [],
        )

    if reply_type == "reply" or reply_type == "text" or "text" in obj:
        return ParsedReply(
            type="reply",
            text=obj.get("text") or obj.get("content") or "",
        )

    # If the object has a "tool" key but no explicit "type", treat as tool_call
    if "tool" in obj or "name" in obj or "function" in obj:
        tool_name = obj.get("tool") or obj.get("name") or obj.get("function")
        return ParsedReply(
            type="tool_call",
            tool=str(tool_name),
            args=obj.get("args") or obj.get("arguments") or {},
        )

    # If there's a "question" key, treat as ask
    if "question" in obj:
        return ParsedReply(
            type="ask",
            question=obj.get("question", ""),
            options=obj.get("options") or [],
        )

    # Fallback: treat the JSON object as a reply with text
    return ParsedReply(
        type="reply",
        text=obj.get("text") or obj.get("content") or json.dumps(obj),
    )


async def parse_or_repair(
    text: str,
    provider_chat: Callable[..., Coroutine[Any, Any, Dict[str, Any]]],
) -> ParsedReply:
    """Parse LLM output, attempting one repair if initial parse fails.

    *provider_chat* is an async callable matching ``provider_service.chat()``.
    """
    parsed = parse(text)
    if parsed is not None:
        return parsed

    # One repair attempt — tell the LLM its output was invalid
    logger.warning("Agent parser: initial parse failed, attempting repair")
    try:
        repair_prompt = (
            f"Your last reply was not valid JSON or could not be parsed. "
            f"Raw output (truncated): {text[:500]}\n\n"
            f"Please reply with a single JSON object using one of these formats:\n"
            f'{{"type": "reply", "text": "your response"}}\n'
            f'{{"type": "tool_call", "tool": "tool_name", "args": {{}}}}\n'
            f'{{"type": "ask", "question": "your question", "options": []}}\n'
        )
        repair_result = await provider_chat(
            messages=[{"role": "user", "content": repair_prompt}],
            temperature=0.1,
            max_tokens=256,
        )
        repair_text = repair_result.get("response") or ""
        parsed = parse(repair_text)
        if parsed is not None:
            return parsed
    except Exception as e:
        logger.warning(f"Agent parser: repair attempt failed: {e}")

    return ParsedReply(
        type="error",
        error=f"Could not parse LLM output: {text[:200]}",
    )
