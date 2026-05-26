"""
EditFlow Agent — System prompt and tool schemas.

The system prompt tells the LLM who it is and what tools it can call.
Tool schemas are JSON descriptions that the LLM uses to decide which
tool to invoke and with what arguments.
"""
from __future__ import annotations

from typing import Any, Dict, List

# ── System Prompt ──────────────────────────────────────────────

SYSTEM_PROMPT = """\
You are EditFlow, an AI editing assistant for solo talking-head video creators \
who work in Adobe Premiere Pro.  The user typically has bins of raw takes \
(sometimes in Urdu or mixed Urdu/English) and wants to produce a clean cut.

Your job is to understand what the user wants and achieve it by calling tools. \
You may call tools, reply with text, or ask the user a question (using "ask"). \
Always prefer calling a tool over giving instructions the user must follow manually.

IMPORTANT RULES:
1. Read the user's intent — do NOT assume the "next pipeline stage" automatically.
   If the user says "this is not a script", treat it as a correction, not a script.
2. When in doubt, ask the user a clarifying question (use "ask").
3. If a tool call fails, explain the error and suggest alternatives.
4. Keep your replies concise (1-3 sentences).  Use tool calls to do the real work.
5. NEVER reveal internal API endpoints, file paths, or technical implementation details.

OUTPUT FORMAT:
You must reply with a single JSON object in one of these formats:

To reply to the user:
{"type": "reply", "text": "your response here"}

To call a tool:
{"type": "tool_call", "tool": "tool_name", "args": {"arg1": "value1"}}

To ask the user a question:
{"type": "ask", "question": "your question", "options": [{"label": "Option A", "value": "a"}, {"label": "Option B", "value": "b"}]}
"""

# ── Tool Schemas ──────────────────────────────────────────────

TOOL_SCHEMAS: List[Dict[str, Any]] = [
    {
        "name": "scan_project",
        "description": "Request a scan of the Premiere Pro project. The frontend will run the scan and send results back.",
        "args": {},
    },
    {
        "name": "list_bins",
        "description": "List all bins in the current Premiere project with clip counts and audio durations.",
        "args": {},
    },
    {
        "name": "resolve_clips_in_bin",
        "description": "Resolve all clips inside a specific bin. Returns clip names and paths.",
        "args": {
            "bin_name": {"type": "string", "description": "The bin name to resolve (e.g. 'Raw Takes')"},
        },
    },
    {
        "name": "transcribe_clips",
        "description": "Transcribe one or more clips using Whisper. This is slow — emits WebSocket progress events. Use clip_paths from resolve_clips_in_bin results.",
        "args": {
            "clip_paths": {"type": "array", "items": {"type": "string"}, "description": "List of clip file paths to transcribe"},
        },
    },
    {
        "name": "get_transcript",
        "description": "Get the transcript text + sidecar file path for a specific clip. The sidecar path points to a {stem}.transcript.json file next to the source video that the user can open in any editor and copy into an external LLM. Use this when the user asks for a transcript, its location, or its file path.",
        "args": {
            "clip_path": {"type": "string", "description": "Path to the clip (bare filename like 'IMG_1694.MOV' is also accepted; auto-resolved against the session's clip list)"},
            "max_chars": {"type": "integer", "description": "Max characters to return in the inline preview (default 2000)", "default": 2000},
        },
    },
    {
        "name": "list_transcript_paths",
        "description": "Returns the file path (on disk) of every transcript sidecar in the current session. Takes NO arguments — just call it. ALWAYS use this tool when the user asks any of: 'where is the transcript', 'where is my transcript', 'where are the transcripts', 'show me the transcript file', 'transcript path', 'transcript location', 'where is the file saved'. Do NOT call get_transcript for these questions — that one returns the text content and requires a clip_path; this one returns just the paths and needs nothing.",
        "args": {},
    },
    {
        "name": "read_document",
        "description": "Read a previously-uploaded document from session state. Returns a summary of its contents.",
        "args": {
            "file_id": {"type": "string", "description": "The document identifier from the upload"},
        },
    },
    {
        "name": "propose_cuts_from_transcripts",
        "description": "Build an edit plan from transcripts without a script. The LLM selects the best takes. Use this when the user does NOT have a written script. clip_paths is optional; if omitted, all transcribed clips are used.",
        "args": {
            "clip_paths": {"type": "array", "items": {"type": "string"}, "description": "Clip paths to cut from (optional; defaults to all transcribed clips)"},
            "instruction": {"type": "string", "description": "What kind of cut the user wants (e.g. 'clean 2-minute highlight')"},
            "hint": {"type": "string", "description": "Optional additional hint", "default": ""},
        },
    },
    {
        "_note": "If the user pasted a long multi-line script into chat (especially in Urdu/Hindi/Arabic), you may pass script='' — the tool will auto-recover the script from the most recent user message. This avoids truncation issues with non-Latin text in tool-call JSON.",
        "name": "match_script_to_transcripts",
        "description": "Match a written script to transcribed takes and build an edit plan. Use this when the user HAS a script.",
        "args": {
            "bin_references": {"type": "array", "items": {"type": "string"}, "description": "Bin references like ['@bin:Raw Takes']"},
            "script": {"type": "string", "description": "The script text to match against takes"},
            "user_hint": {"type": "string", "description": "Optional hint for the matcher", "default": ""},
        },
    },
    {
        "_note": "External-LLM paste workflow.  Use when the user wants to do the matching in a frontier model (Claude/ChatGPT/Gemini) instead of relying on the local matcher.  The flow is: (1) call build_llm_paste_prompt to produce a clipboard payload; (2) user pastes into the frontier model and gets JSON back; (3) call apply_pasted_plan with that JSON.",
        "name": "build_llm_paste_prompt",
        "description": "Build the prompt the user copies into an external LLM (Claude/ChatGPT/Gemini). Bundles the script and full word-level transcripts of every transcribed clip in this session. Call when the user asks for 'the LLM prompt', 'the prompt to paste into Claude', 'the external prompt', or wants to do the matching in a bigger model. Pass script='' to auto-recover from chat history.",
        "args": {
            "script": {"type": "string", "description": "The script (optional — recovered from history if blank)", "default": ""},
        },
    },
    {
        "_note": "Companion to build_llm_paste_prompt.  Accepts the JSON the frontier model returned.  Tolerates ```json``` fences and surrounding prose.  After success, immediately suggest the user 'Build sequence' (which calls apply_plan with the returned plan_id).",
        "name": "apply_pasted_plan",
        "description": "Ingest a JSON cut plan the user pasted back from an external LLM and turn it into a stored Plan ready to apply. Call when the user says 'here's the plan', 'apply this JSON', 'I pasted the cut plan', or otherwise provides JSON-looking text containing a 'cuts' array.",
        "args": {
            "pasted_text": {"type": "string", "description": "The raw JSON the user pasted from the frontier model"},
            "bin_reference": {"type": "string", "description": "Optional; defaults to the session's last scanned bin", "default": ""},
        },
    },
    {
        "name": "get_plan",
        "description": "Get details of a stored plan by its ID.",
        "args": {
            "plan_id": {"type": "string", "description": "The plan ID to look up"},
        },
    },
    {
        "name": "regenerate_plan",
        "description": "Regenerate an edit plan with a new hint, reusing cached transcripts.",
        "args": {
            "plan_id": {"type": "string", "description": "The plan ID to regenerate"},
            "hint": {"type": "string", "description": "New hint for the matcher"},
        },
    },
    {
        "name": "apply_plan",
        "description": "Apply a plan by generating ExtendScript ops. The frontend dispatches these in Premiere Pro.",
        "args": {
            "plan_id": {"type": "string", "description": "The plan ID to apply"},
            "target_sequence_name": {"type": "string", "description": "Optional name for the new sequence", "default": ""},
        },
    },
    {
        "name": "set_active_chat_model",
        "description": "Change the active LLM model used for agent reasoning and other tasks.",
        "args": {
            "provider_id": {"type": "string", "description": "The provider ID"},
            "model": {"type": "string", "description": "The model name"},
        },
    },
    {
        "name": "show_help",
        "description": "Show a help card listing all available capabilities.",
        "args": {},
    },
]

# ── Few-shot examples ─────────────────────────────────────────

FEW_SHOT_EXAMPLES: List[Dict[str, str]] = [
    # Example 1: Project tour
    {
        "role": "user",
        "content": "What's in my project?",
    },
    {
        "role": "assistant",
        "content": '{"type": "tool_call", "tool": "list_bins", "args": {}}',
    },
    {
        "role": "user",
        "content": "[Tool result: Bins: Raw Takes (10 clips, 24min audio), B-Roll (5 clips, no audio)...]",
    },
    {
        "role": "assistant",
        "content": '{"type": "reply", "text": "Your project has 2 bins. \\"Raw Takes\\" has 10 clips with ~24 minutes of audio — that looks like your main footage. \\"B-Roll\\" has 5 clips without audio. Which bin should I work with?"}',
    },

    # Example 2: Document upload that isn't a script
    {
        "role": "user",
        "content": "[User uploaded: billionaire_v5.docx]",
    },
    {
        "role": "assistant",
        "content": '{"type": "tool_call", "tool": "read_document", "args": {"file_id": "billionaire_v5.docx"}}',
    },
    {
        "role": "user",
        "content": "[Tool result: Read 4 pages from billionaire_v5.docx. Contains research notes and interview questions, not a spoken script.]",
    },
    {
        "role": "assistant",
        "content": '{"type": "ask", "question": "This document looks like research notes rather than a spoken script. What would you like to do?", "options": [{"label": "Cut my transcripts without a script", "value": "no_script"}, {"label": "Paste a script manually", "value": "paste_script"}, {"label": "Try to extract a script from the doc", "value": "extract"}]}',
    },

    # Example 3: Propose without script
    {
        "role": "user",
        "content": "can you just analyze the transcription and cut it in better way. This is not a script",
    },
    {
        "role": "assistant",
        "content": '{"type": "tool_call", "tool": "propose_cuts_from_transcripts", "args": {"clip_paths": ["/path/to/clip1.mov", "/path/to/clip2.mov"], "instruction": "clean cut removing false starts, hesitations, and mumbled words"}}',
    },
]
