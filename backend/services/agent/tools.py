"""
EditFlow Agent — Thin tool wrappers over existing backend services.

Each tool is a small async function that calls an existing service and
returns a uniform envelope:
    {
        "tool": "tool_name",
        "success": bool,
        "summary": str,      # ≤300 tokens, goes back to LLM context
        "data": dict | None, # structured result kept in session state
        "ui": dict | None,   # optional UI card hint for the frontend
        "error": str | None,
    }

NO business logic lives here — only service calls + envelope shaping.
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any, Callable, Coroutine, Dict, List, Optional

logger = logging.getLogger(__name__)


# ── Return envelope helper ─────────────────────────────────────

def _envelope(
    tool: str,
    success: bool,
    summary: str,
    data: Any = None,
    ui: Any = None,
    error: Optional[str] = None,
) -> dict:
    """Build a uniform tool return envelope."""
    return {
        "tool": tool,
        "success": success,
        "summary": summary[:600],  # hard cap
        "data": data,
        "ui": ui,
        "error": error,
    }


# ── Tool: scan_project ─────────────────────────────────────────

async def scan_project_tool(args: dict, ws_emit: Callable, session: Any = None) -> dict:
    """Request a project scan from the frontend.

    The backend can't trigger a scan — only the CEP panel can.
    Returns a UI hint that the frontend should run the scan.
    """
    return _envelope(
        tool="scan_project",
        success=True,
        summary="Requested scan from frontend. Awaiting result.",
        data=None,
        ui={"kind": "request_scan"},
    )


# ── Tool: list_bins ────────────────────────────────────────────

async def list_bins_tool(args: dict, ws_emit: Callable, session: Any = None) -> dict:
    """List bins from the current Premiere project context."""
    try:
        from ...routes import premiere
        ctx = premiere._project_context
    except Exception:
        ctx = {}

    bins = ctx.get("bins", [])
    items = ctx.get("items", [])

    if not bins and not items:
        return _envelope(
            tool="list_bins",
            success=False,
            summary="No project scan available. Please scan the project first.",
            error="No project context",
        )

    # Build bin summaries
    bin_summaries = []
    for bin_info in bins:
        bin_name = bin_info.get("name", "Unknown")
        bin_path = bin_info.get("path", bin_info.get("binPath", ""))
        bin_items = [
            it for it in items
            if (it.get("binPath") or it.get("bin_path") or "") == bin_path
        ]
        audio_items = [
            it for it in bin_items
            if it.get("hasAudio") or it.get("has_audio") or
               any(it.get("mediaPath", it.get("media_path", "")).lower().endswith(ext)
                   for ext in (".mov", ".mp4", ".wav", ".mp3", ".m4a", ".mxf"))
        ]
        audio_dur = sum(it.get("duration", 0) for it in audio_items)
        has_audio = len(audio_items) > 0

        bin_summaries.append({
            "name": bin_name,
            "path": bin_path,
            "clip_count": len(bin_items),
            "has_audio": has_audio,
            "audio_duration": round(audio_dur, 1),
        })

    # Build summary string for the LLM
    summary_parts = []
    for b in bin_summaries:
        audio_str = f", {round(b['audio_duration'] / 60)}min audio" if b["has_audio"] else ", no audio"
        summary_parts.append(f"{b['name']} ({b['clip_count']} clips{audio_str})")
    summary = f"Bins: {'; '.join(summary_parts)}" if summary_parts else "No bins found."

    return _envelope(
        tool="list_bins",
        success=True,
        summary=summary,
        data={"bins": bin_summaries, "total_items": len(items)},
        ui={"kind": "bin_summary", "payload": {
            "intro": f"Found {len(bin_summaries)} bin(s) in your project.",
            "bins": bin_summaries,
        }},
    )


# ── Tool: resolve_clips_in_bin ─────────────────────────────────

async def resolve_clips_in_bin_tool(args: dict, ws_emit: Callable, session: Any = None) -> dict:
    """Resolve clips in a specific bin."""
    bin_name = args.get("bin_name", "")
    if not bin_name:
        return _envelope(
            tool="resolve_clips_in_bin",
            success=False,
            summary="bin_name is required.",
            error="Missing bin_name argument",
        )

    try:
        from ...routes import premiere
        ctx = premiere._project_context
        from ...services.bin_resolver import resolve as resolve_bins
        references = [f"@bin:{bin_name}"]
        clips = resolve_bins(references, ctx)
    except Exception as e:
        return _envelope(
            tool="resolve_clips_in_bin",
            success=False,
            summary=f"Failed to resolve bin '{bin_name}': {e}",
            error=str(e),
        )

    clip_infos = []
    for clip in clips:
        clip_infos.append({
            "path": clip.path,
            "name": clip.name,
            "duration": round(clip.duration, 1),
            "has_audio": clip.has_audio,
        })

    names = ", ".join(c["name"] for c in clip_infos[:10])
    summary = f"Resolved {len(clip_infos)} clips in bin '{bin_name}'. Names: {names}"
    if len(clip_infos) > 10:
        summary += f" and {len(clip_infos) - 10} more."

    return _envelope(
        tool="resolve_clips_in_bin",
        success=True,
        summary=summary,
        data={"clips": clip_infos, "bin_name": bin_name},
    )


# ── Tool: transcribe_clips ─────────────────────────────────────

def _recover_clip_path(p: str, session: Any) -> str:
    """If the LLM dropped the path and gave us only a filename, look it up in
    session.context['selected_clips'].

    Small local models (nemotron-3-nano:4b, gemma3:4b, etc.) frequently
    reduce a clip object like {path: 'C:/foo/IMG_1694.MOV', name: 'IMG_1694.MOV'}
    down to just 'IMG_1694.MOV' when they have to emit a tool-call JSON.
    The disk lookup then fails. Recovering from session context is what
    a smarter model would do internally — so we do it for it.

    Returns the original path if a recovery isn't available.
    """
    if not p or not session:
        return p
    # If it's already a real file, no recovery needed.
    try:
        if Path(p).is_file():
            return p
    except Exception:
        pass

    selected = (getattr(session, "context", {}) or {}).get("selected_clips") or []
    target_basename = Path(p).name.lower()
    for clip in selected:
        if not isinstance(clip, dict):
            continue
        clip_path = clip.get("path", "")
        clip_name = clip.get("name", "")
        if not clip_path:
            continue
        # Match by name, basename, or path-suffix — the model might mangle any of these
        if (
            clip_name.lower() == target_basename
            or Path(clip_path).name.lower() == target_basename
            or clip_path.lower().endswith(p.lower().replace("\\", "/").replace("/", ""))
        ):
            if Path(clip_path).is_file():
                logger.info(
                    f"transcribe_clips: recovered path {p!r} -> {clip_path!r} "
                    "from session.selected_clips (LLM dropped the path)"
                )
                return clip_path
    return p


async def transcribe_clips_tool(args: dict, ws_emit: Callable, session: Any = None) -> dict:
    """Transcribe clips using Whisper with WS progress events."""
    raw_paths = args.get("clip_paths", [])
    if not raw_paths:
        return _envelope(
            tool="transcribe_clips",
            success=False,
            summary="clip_paths is required and must be a non-empty list.",
            error="Missing clip_paths",
        )

    # Auto-recover paths the LLM truncated to bare filenames.
    paths = [_recover_clip_path(p, session) for p in raw_paths]

    await ws_emit({
        "type": "agent_tool",
        "tool": "transcribe_clips",
        "status": "started",
        "total": len(paths),
    })

    from ...services.whisper_service import whisper_service
    from ...utils.progress import ProgressReporter

    client_id = ""
    if session and hasattr(session, "id"):
        # Try to find the client_id from the session history
        pass

    results = []
    for i, p in enumerate(paths):
        # Pre-check the file exists on disk before calling Whisper.
        # Premiere's ExtendScript scan can hand back paths that look real but
        # aren't filesystem-resolvable (network drives that aren't mounted,
        # offline media, paths with stale drive letters, etc.). Catching this
        # upfront produces a much clearer error than a deep-stack FileNotFoundError
        # from compute_file_fingerprint() that was previously being swallowed
        # silently in this same except block.
        if not p or not Path(p).is_file():
            err_msg = f"Source file not found on disk: {p!r}"
            logger.error(f"transcribe_clips: {err_msg}")
            results.append({"path": p, "error": err_msg})
        else:
            try:
                # task_type must be keyword. The first positional arg is task_id.
                # Passing 'transcribe' positionally set task_id='transcribe' and
                # left task_type at the default 'generic' — every progress event
                # came through with task_type='generic' and the panel's regex
                # filter (/transcribe/i.test(msgType)) silently dropped them.
                # That's why the chat card sat at 'Starting...' for the whole
                # transcription. Every other route does this correctly.
                progress = ProgressReporter(task_type="transcribe", client_id=client_id)
                tr = await whisper_service.transcribe_fingerprinted(
                    source_path=p,
                    language=None,
                    progress=progress,
                )
                # Compute sidecar path so the chat can show it.  Matches the
                # logic in whisper_service._save_transcript_cache.
                src_path = Path(p)
                sidecar = src_path.with_name(src_path.stem + ".transcript.json")
                results.append({
                    "path": p,
                    "duration": round(tr.duration, 1),
                    "language": tr.language,
                    "segments": len(tr.segments),
                    "fingerprint": tr.content_hash,
                    "sidecar_path": str(sidecar),
                    "sidecar_exists": sidecar.is_file(),
                })
            except Exception as e:
                # Log the FULL exception (with traceback) so we can diagnose
                # what actually broke. Previously we just stored str(e) in the
                # result dict — the agent paraphrased it as "I encountered an
                # error" and the real cause vanished. Now both the user (via
                # the result envelope) AND the backend log get the truth.
                logger.exception(
                    f"transcribe_clips: Whisper failed for {p!r}"
                )
                results.append({
                    "path": p,
                    "error": f"{e.__class__.__name__}: {e}",
                })

        await ws_emit({
            "type": "agent_tool",
            "tool": "transcribe_clips",
            "status": "clip_done",
            "index": i + 1,
            "total": len(paths),
        })

    summary = _make_transcribe_summary(results)
    await ws_emit({
        "type": "agent_tool",
        "tool": "transcribe_clips",
        "status": "completed",
        "summary": summary,
    })

    return _envelope(
        tool="transcribe_clips",
        success=True,
        summary=summary,
        data={"clips": results},
    )


def _make_transcribe_summary(results: list) -> str:
    """Build a multi-line summary of transcription results.

    Each successful clip lists its sidecar path so the user can open the
    full transcript JSON in any text editor (Option B workflow — copy into
    an external LLM, get back a clean script, paste into the panel chat).
    """
    ok = [r for r in results if "error" not in r]
    fail = [r for r in results if "error" in r]
    lines = [f"Transcribed {len(ok)} clip(s)."]
    for r in ok[:5]:
        dur = r.get("duration", 0)
        lang = r.get("language", "?")
        name = Path(r["path"]).name
        line = f"  • {name} ({dur}s, {lang})"
        sidecar = r.get("sidecar_path")
        if sidecar and r.get("sidecar_exists"):
            line += f"\n    transcript file: {sidecar}"
        lines.append(line)
    if fail:
        lines.append(f"{len(fail)} clip(s) failed.")
    return "\n".join(lines)[:1200]


# ── Tool: get_transcript ───────────────────────────────────────

async def get_transcript_tool(args: dict, ws_emit: Callable, session: Any = None) -> dict:
    """Get transcript text for a clip (reads from cache).

    Also returns the sidecar file path (<stem>.transcript.json next to the
    source video) so the user can open the full transcript in any text editor
    and copy it into an external LLM.  See Option B workflow.
    """
    clip_path = args.get("clip_path", "")
    max_chars = args.get("max_chars", 2000)

    # Auto-recover bare filenames the LLM may have truncated (same defect
    # class as transcribe_clips). Lets the user ask "show me the transcript
    # for IMG_1694.MOV" without giving the full path.
    if clip_path:
        clip_path = _recover_clip_path(clip_path, session)

    # Fallback ladder for when the LLM omits clip_path OR recovery returned
    # something that isn't a real file:
    #   1. If exactly one clip in transcripts_ready → use that.
    #   2. If multiple → return a helpful error listing the candidates so
    #      the LLM can ask the user which one.
    transcripts_ready = (getattr(session, "context", {}) or {}).get("transcripts_ready") or {}
    if not clip_path or not Path(clip_path).is_file():
        ready_paths = list(transcripts_ready.keys())
        if len(ready_paths) == 1:
            clip_path = ready_paths[0]
            logger.info(
                f"get_transcript: no resolvable clip_path given, defaulting to "
                f"only transcript in session: {clip_path}"
            )
        elif len(ready_paths) > 1:
            return _envelope(
                tool="get_transcript",
                success=False,
                summary=(
                    f"Multiple transcripts in this session. Specify which one: "
                    + ", ".join(Path(p).name for p in ready_paths)
                ),
                error="ambiguous_clip",
                data={"available_clips": ready_paths},
            )
        else:
            return _envelope(
                tool="get_transcript",
                success=False,
                summary="No transcripts in this session yet. Transcribe a clip first.",
                error="no_transcripts_ready",
            )

    # Compute the sidecar path the user can copy from.  This mirrors the
    # path used by whisper_service._save_transcript_cache so the two always
    # agree.  We don't require the file to exist (it may not on read-only
    # volumes); we just report whether it does.
    src_path = Path(clip_path)
    sidecar_path = src_path.with_name(src_path.stem + ".transcript.json")
    sidecar_exists = sidecar_path.is_file()

    try:
        from ...services.whisper_service import whisper_service
        tr = await whisper_service.transcribe_fingerprinted(
            source_path=clip_path,
            language=None,
            force=False,  # cache-only
        )

        text = tr.full_text or ""
        total_words = sum(len(seg.words) for seg in tr.segments) if hasattr(tr, 'segments') else 0
        truncated = text[:max_chars]
        if len(text) > max_chars:
            truncated += f"...(truncated; {len(tr.segments)} segments, {total_words} words total)"

        # Lead the summary with the file path so the user sees where to copy
        # from at a glance.  The first 200 chars of text follow for context.
        path_hint = (
            f"Full transcript file: {sidecar_path}" if sidecar_exists
            else f"Sidecar not on disk (would be at: {sidecar_path})"
        )
        summary = (
            f"Transcript for {src_path.name} "
            f"({total_words} words, {tr.language}, {tr.duration:.1f}s).\n"
            f"{path_hint}\n"
            f"Preview: {truncated[:200]}"
            + ("..." if len(text) > 200 else "")
        )

        return _envelope(
            tool="get_transcript",
            success=True,
            summary=summary,
            data={
                "clip_path": clip_path,
                "sidecar_path": str(sidecar_path),
                "sidecar_exists": sidecar_exists,
                "text": truncated,
                "full_length": len(text),
                "duration": tr.duration,
                "language": tr.language,
                "segments": len(tr.segments),
                "words": total_words,
            },
        )
    except Exception as e:
        return _envelope(
            tool="get_transcript",
            success=False,
            summary=f"Transcript not available for {src_path.name}: {e}",
            error=str(e),
            data={"sidecar_path": str(sidecar_path), "sidecar_exists": sidecar_exists},
        )


# ── Tool: list_transcript_paths ───────────────────────────────

async def list_transcript_paths_tool(args: dict, ws_emit: Callable, session: Any = None) -> dict:
    """List the sidecar file paths for every transcribed clip in this session.

    Used when the user asks "where are my transcripts" or wants to copy them
    into an external LLM (Option B workflow).  Returns the absolute path of
    each <stem>.transcript.json sidecar next to the source video, along with
    whether the file actually exists on disk.
    """
    transcripts_ready = (getattr(session, "context", {}) or {}).get("transcripts_ready") or {}
    if not transcripts_ready:
        return _envelope(
            tool="list_transcript_paths",
            success=True,
            summary="No transcripts in this session yet. Transcribe some clips first.",
            data={"transcripts": []},
        )

    items = []
    for clip_path in transcripts_ready.keys():
        src = Path(clip_path)
        sidecar = src.with_name(src.stem + ".transcript.json")
        items.append({
            "clip_name": src.name,
            "clip_path": clip_path,
            "sidecar_path": str(sidecar),
            "sidecar_exists": sidecar.is_file(),
        })

    # Build a multi-line summary that prominently lists each path
    on_disk = [i for i in items if i["sidecar_exists"]]
    lines = [f"{len(on_disk)} transcript file(s) available:"]
    for i in items:
        marker = "✓" if i["sidecar_exists"] else "✗ (missing)"
        lines.append(f"  {marker}  {i['sidecar_path']}")
    summary = "\n".join(lines)

    return _envelope(
        tool="list_transcript_paths",
        success=True,
        summary=summary,
        data={"transcripts": items, "count": len(items), "on_disk_count": len(on_disk)},
    )


# ── Tool: read_document ────────────────────────────────────────

async def read_document_tool(args: dict, ws_emit: Callable, session: Any = None) -> dict:
    """Read a previously-uploaded document from session state."""
    file_id = args.get("file_id", "")
    if not file_id:
        return _envelope(
            tool="read_document",
            success=False,
            summary="file_id is required.",
            error="Missing file_id",
        )

    # Look up the document text in session context
    if not session or not hasattr(session, "context"):
        return _envelope(
            tool="read_document",
            success=False,
            summary="No session context available.",
            error="No session",
        )

    pending = session.context.get("pending_documents", {})
    doc_text = pending.get(file_id)
    if not doc_text:
        # Try a fuzzy match on filename
        for key, val in pending.items():
            if file_id in key or key in file_id:
                doc_text = val
                file_id = key
                break

    if not doc_text:
        return _envelope(
            tool="read_document",
            success=False,
            summary=f"Document '{file_id}' not found in session. Available: {list(pending.keys())}",
            error="Document not found",
        )

    text = str(doc_text)
    preview = text[:200]
    pages = text.count("\f") + 1 if text else 1

    return _envelope(
        tool="read_document",
        success=True,
        summary=f"Read document '{file_id}' ({pages} page(s)). First 200 chars: '{preview}...'",
        data={
            "file_id": file_id,
            "text": text[:8000],  # cap for session storage
            "page_count": pages,
            "total_chars": len(text),
        },
    )


# ── Tool: match_script_to_transcripts ──────────────────────────

def _extract_script_from_history(session: Any, min_lines: int = 2, min_chars: int = 40) -> Optional[str]:
    """Pull the most recent user message that looks like a pasted script.

    Small local LLMs frequently truncate multi-line / non-Latin script
    text when they have to embed it in a tool-call JSON argument.  The
    workaround: store the script in conversation history (which never
    truncates) and recover it here when the tool's ``script`` arg comes
    in empty.

    A message qualifies as a "script" if it has at least ``min_lines``
    newline-separated non-empty lines OR is at least ``min_chars`` long
    and contains common Urdu / Hindi / RTL characters.
    """
    if not session or not hasattr(session, "history"):
        return None
    # Walk history in reverse, skip the most recent (which may be the
    # current tool call) and pick the last "user" content that's long.
    for entry in reversed(getattr(session, "history", []) or []):
        if entry.get("role") != "user":
            continue
        content = entry.get("content") or ""
        if not isinstance(content, str):
            continue
        # Strip the "اسکرپٹ:" / "here is the script" preamble if present.
        cleaned = content
        for prefix_token in ("اسکرپٹ:", "اسکرپٹ", "Here is my script", "Here is the script", "Script:", "script:"):
            if prefix_token.lower() in cleaned.lower():
                # Take everything after the last occurrence of the marker
                idx = cleaned.lower().rfind(prefix_token.lower())
                cleaned = cleaned[idx + len(prefix_token):].strip(" :\n")
                break
        nonblank = [ln for ln in cleaned.splitlines() if ln.strip()]
        if len(nonblank) >= min_lines:
            return "\n".join(nonblank)
        if len(cleaned) >= min_chars:
            return cleaned
    return None


async def match_script_to_transcripts_tool(args: dict, ws_emit: Callable, session: Any = None) -> dict:
    """Wrap the existing /api/edit/analyze pipeline."""
    raw_bin_refs = args.get("bin_references", [])
    script = args.get("script", "")
    user_hint = args.get("user_hint", "")

    # If the LLM omitted or truncated the script (common with small local
    # models on long multi-line Urdu / Hindi text), recover the full text
    # from the most recent user message in session history.
    if not script.strip() or len(script.strip()) < 40:
        recovered = _extract_script_from_history(session)
        if recovered:
            logger.info(
                f"match_script_to_transcripts: LLM passed empty/short script "
                f"({len(script)} chars); recovered {len(recovered)} chars "
                f"from session history ({len(recovered.splitlines())} lines)"
            )
            script = recovered

    # Auto-recover bare filenames in bin_references the LLM may have
    # truncated (same defect class as transcribe_clips bare-filename bug).
    # Also fall back to all transcribed clips if bin_references is empty —
    # the user may say "match the script" after a transcribe without
    # restating which clips, and the LLM sometimes omits the arg.
    if raw_bin_refs:
        bin_references = [_recover_clip_path(ref, session) for ref in raw_bin_refs]
    else:
        # Default to all transcribed clips when the LLM omits bin_references.
        transcripts_ready = (getattr(session, "context", {}) or {}).get("transcripts_ready") or {}
        bin_references = list(transcripts_ready.keys()) if transcripts_ready else []
        if bin_references:
            logger.info(
                f"match_script_to_transcripts: no bin_references given, "
                f"falling back to {len(bin_references)} path(s) from transcripts_ready"
            )

    if not bin_references:
        return _envelope(
            tool="match_script_to_transcripts",
            success=False,
            summary="bin_references is required.",
            error="Missing bin_references",
        )
    if not script.strip():
        return _envelope(
            tool="match_script_to_transcripts",
            success=False,
            summary="script text is required.",
            error="Missing script",
        )

    # Filter out paths that still didn't resolve — they'd cause a confusing
    # ValueError deep in the matcher. Log each failure so the dev can see
    # which paths the LLM mangled beyond recovery.
    resolved = []
    for ref in bin_references:
        # bin_references can be @bin:XXX tokens (not file paths) — keep those as-is.
        if ref.startswith("@bin:"):
            resolved.append(ref)
        elif Path(ref).is_file():
            resolved.append(ref)
        else:
            logger.warning(
                f"match_script_to_transcripts: skipping unresolved path {ref!r}"
            )

    if not resolved:
        return _envelope(
            tool="match_script_to_transcripts",
            success=False,
            summary="None of the provided bin_references resolved to real paths or bins.",
            error="No valid bin_references after recovery",
        )

    try:
        from ...routes.edit import run_analyze, AnalyzeRequest
        req = AnalyzeRequest(
            bin_references=resolved,
            script=script,
            user_hint=user_hint or None,
        )
        result = await run_analyze(req)

        plan_id = result.get("plan_id", "unknown")
        summary_info = result.get("summary", {})
        total_dur = summary_info.get("total_duration", 0)
        beats = summary_info.get("beats", summary_info.get("matched", 0))
        unmatched = summary_info.get("unmatched", 0)

        summary = f"Built plan: {beats} cuts, {round(total_dur / 60, 1)}min total, {unmatched} unmatched. plan_id={plan_id}"

        return _envelope(
            tool="match_script_to_transcripts",
            success=True,
            summary=summary,
            data={"plan_id": plan_id, "result": result},
            ui={"kind": "plan_card", "payload": {
                "intro": f"I built a plan: {beats} cuts, {round(total_dur / 60, 1)}min total.",
                "plan_id": plan_id,
                "summary": summary_info,
                "warnings": result.get("warnings", []),
            }},
        )
    except Exception as e:
        logger.exception("match_script_to_transcripts failed")
        return _envelope(
            tool="match_script_to_transcripts",
            success=False,
            summary=f"Script matching failed: {e}",
            error=str(e),
        )


# ── Tool: propose_cuts_from_transcripts ────────────────────────

async def propose_cuts_from_transcripts_tool(args: dict, ws_emit: Callable, session: Any = None) -> dict:
    """Build an edit plan from transcripts without a script."""
    raw_paths = args.get("clip_paths", [])
    instruction = args.get("instruction", "clean cut")
    hint = args.get("hint", "")

    # When the LLM omits clip_paths entirely (or passes []), fall back to
    # all keys in session.context["transcripts_ready"]. The user can say
    # "cut the video" after a successful transcribe and get a plan card
    # without re-transcribing — the transcripts are already cached.
    if not raw_paths:
        transcripts_ready = (getattr(session, "context", {}) or {}).get("transcripts_ready") or {}
        raw_paths = list(transcripts_ready.keys()) if transcripts_ready else []
        if raw_paths:
            logger.info(
                f"propose_cuts_from_transcripts: no clip_paths given, "
                f"falling back to {len(raw_paths)} path(s) from transcripts_ready"
            )

    if not raw_paths:
        return _envelope(
            tool="propose_cuts_from_transcripts",
            success=False,
            summary="clip_paths is required. Transcribe clips first, then request cuts.",
            error="Missing clip_paths",
        )

    # Auto-recover paths the LLM truncated to bare filenames — mirrors the
    # _recover_clip_path pattern added in commit 177dd6e for transcribe_clips.
    clip_paths = [_recover_clip_path(p, session) for p in raw_paths]

    # Filter out paths that still didn't resolve — they'd cause a confusing
    # ValueError deep in cut_proposer. Log each failure so the dev can see
    # which paths the LLM mangled beyond recovery.
    resolved = []
    for p in clip_paths:
        if Path(p).is_file():
            resolved.append(p)
        else:
            logger.warning(
                f"propose_cuts_from_transcripts: skipping unresolved path {p!r}"
            )

    if not resolved:
        return _envelope(
            tool="propose_cuts_from_transcripts",
            success=False,
            summary="None of the provided clip_paths resolved to real files. Transcribe clips first.",
            error="No valid clip_paths after recovery",
        )

    try:
        from .cut_proposer import propose_cuts
        plan = await propose_cuts(
            clip_paths=resolved,
            instruction=instruction,
            hint=hint or None,
        )

        plan_id = plan.plan_id
        total_dur = plan.summary.get("total_duration", 0)
        num_cuts = len(plan.cuts)
        unmatched = plan.summary.get("unmatched", 0)

        summary = f"Built plan: {num_cuts} cuts, {round(total_dur / 60, 1)}min total, {unmatched} unmatched. plan_id={plan_id}"

        # Serialize plan for the UI card
        beats = []
        for c in plan.cuts:
            beats.append({
                "text": c.beat_text,
                "clipName": Path(c.take_source_file).name if c.take_source_file else "",
                "start": round(c.source_in, 2),
                "end": round(c.source_out, 2),
                "duration": round(c.duration, 2),
                "unmatched": False,
            })

        return _envelope(
            tool="propose_cuts_from_transcripts",
            success=True,
            summary=summary,
            data={"plan_id": plan_id},
            ui={"kind": "plan_card", "payload": {
                "intro": f"I built a plan from transcripts: {num_cuts} cuts, {round(total_dur / 60, 1)}min total.",
                "plan_id": plan_id,
                "plan": {"beats": beats, "totalDuration": total_dur, "unmatched": unmatched},
            }},
        )
    except Exception as e:
        logger.exception("propose_cuts_from_transcripts failed")
        return _envelope(
            tool="propose_cuts_from_transcripts",
            success=False,
            summary=f"Cut proposal failed: {e}",
            error=str(e),
        )


# ── Tool: get_plan ─────────────────────────────────────────────

async def get_plan_tool(args: dict, ws_emit: Callable, session: Any = None) -> dict:
    """Get a stored plan by ID."""
    plan_id = args.get("plan_id", "")
    if not plan_id:
        return _envelope(
            tool="get_plan",
            success=False,
            summary="plan_id is required.",
            error="Missing plan_id",
        )

    try:
        from ...services.plan_store import plan_store
        plan_data = plan_store.load(plan_id)
    except FileNotFoundError:
        return _envelope(
            tool="get_plan",
            success=False,
            summary=f"Plan {plan_id} not found.",
            error="Plan not found",
        )
    except Exception as e:
        return _envelope(
            tool="get_plan",
            success=False,
            summary=f"Failed to load plan: {e}",
            error=str(e),
        )

    cuts = plan_data.get("cuts", [])
    summary_info = plan_data.get("summary", {})
    total_dur = summary_info.get("total_duration", 0)

    # Build a short summary for the LLM
    beat_summaries = []
    for i, c in enumerate(cuts[:8]):
        text = c.get("beat_text", "")[:60]
        source = Path(c.get("take_source_file", "")).name if c.get("take_source_file") else "?"
        beat_summaries.append(f"Beat {i}: '{text}' from {source}")
    summary = f"Plan {plan_id}: {len(cuts)} cuts. " + "; ".join(beat_summaries)
    if len(cuts) > 8:
        summary += f"; ...and {len(cuts) - 8} more"

    return _envelope(
        tool="get_plan",
        success=True,
        summary=summary[:600],
        data=plan_data,
    )


# ── Tool: regenerate_plan ──────────────────────────────────────

async def regenerate_plan_tool(args: dict, ws_emit: Callable, session: Any = None) -> dict:
    """Regenerate a plan with a new hint."""
    plan_id = args.get("plan_id", "")
    hint = args.get("hint", "")

    if not plan_id:
        return _envelope(
            tool="regenerate_plan",
            success=False,
            summary="plan_id is required.",
            error="Missing plan_id",
        )

    try:
        from ...services.plan_store import plan_store
        old_plan = plan_store.load(plan_id)
    except FileNotFoundError:
        return _envelope(
            tool="regenerate_plan",
            success=False,
            summary=f"Plan {plan_id} not found.",
            error="Plan not found",
        )

    # Re-run analyze with the same inputs + new hint
    try:
        from ...routes.edit import run_analyze, AnalyzeRequest
        bin_ref = [old_plan.get("bin_reference", "")]
        script = old_plan.get("script", "")
        req = AnalyzeRequest(
            bin_references=bin_ref,
            script=script,
            user_hint=hint or None,
        )
        result = await run_analyze(req)

        new_plan_id = result.get("plan_id", "unknown")
        summary_info = result.get("summary", {})
        total_dur = summary_info.get("total_duration", 0)
        beats = summary_info.get("beats", summary_info.get("matched", 0))
        unmatched = summary_info.get("unmatched", 0)

        return _envelope(
            tool="regenerate_plan",
            success=True,
            summary=f"Regenerated plan: {beats} cuts, {round(total_dur / 60, 1)}min, {unmatched} unmatched. New plan_id={new_plan_id}",
            data={"plan_id": new_plan_id, "result": result},
            ui={"kind": "plan_card", "payload": {
                "intro": f"Regenerated plan: {beats} cuts, {round(total_dur / 60, 1)}min total.",
                "plan_id": new_plan_id,
                "summary": summary_info,
                "warnings": result.get("warnings", []),
            }},
        )
    except Exception as e:
        return _envelope(
            tool="regenerate_plan",
            success=False,
            summary=f"Regeneration failed: {e}",
            error=str(e),
        )


# ── Tool: apply_plan ───────────────────────────────────────────

async def apply_plan_tool(args: dict, ws_emit: Callable, session: Any = None) -> dict:
    """Apply a plan: generate ExtendScript ops for the frontend."""
    plan_id = args.get("plan_id", "")
    target_sequence_name = args.get("target_sequence_name", "")

    # Fallback: recover plan_id from session context when the LLM omits it.
    # The LLM frequently calls apply_plan right after match_script_to_transcripts
    # but forgets to thread plan_id through — session context always has it.
    if not plan_id and session:
        plan_id = (getattr(session, "context", {}) or {}).get("last_plan_id", "")
        if plan_id:
            logger.info(
                "apply_plan: plan_id missing from args, recovered from "
                "session.context.last_plan_id: %s", plan_id
            )

    if not plan_id:
        return _envelope(
            tool="apply_plan",
            success=False,
            summary="plan_id is required.",
            error="Missing plan_id",
        )

    try:
        from ...routes.edit import run_apply_plan, ApplyRequest
        req = ApplyRequest(target_sequence_name=target_sequence_name or None)
        result = await run_apply_plan(plan_id, req)

        ops = result.get("extendscript_ops", [])
        seq_name = result.get("target_sequence_name", "EditFlow Cut")
        cuts_applied = result.get("cuts_applied", len(ops))

        return _envelope(
            tool="apply_plan",
            success=True,
            summary=f"Generated {cuts_applied} ExtendScript ops for sequence '{seq_name}'. Frontend will dispatch via processEDL.",
            data={"plan_id": plan_id, "ops": ops, "sequence_name": seq_name},
            ui={"kind": "plan_apply_request", "payload": {
                "extendscript_ops": ops,
                "target_sequence_name": seq_name,
            }},
        )
    except Exception as e:
        return _envelope(
            tool="apply_plan",
            success=False,
            summary=f"Apply failed: {e}",
            error=str(e),
        )


# ── Tool: set_active_chat_model ────────────────────────────────

async def set_active_chat_model_tool(args: dict, ws_emit: Callable, session: Any = None) -> dict:
    """Change the active chat model."""
    provider_id = args.get("provider_id", "")
    model = args.get("model", "")

    if not provider_id or not model:
        return _envelope(
            tool="set_active_chat_model",
            success=False,
            summary="Both provider_id and model are required.",
            error="Missing arguments",
        )

    try:
        from ...services.provider_service import provider_service
        provider_service.set_active_chat(provider_id, model)
        return _envelope(
            tool="set_active_chat_model",
            success=True,
            summary=f"Active chat model set to {provider_id}/{model}.",
        )
    except Exception as e:
        return _envelope(
            tool="set_active_chat_model",
            success=False,
            summary=f"Failed to set model: {e}",
            error=str(e),
        )


# ── Tool: show_help ────────────────────────────────────────────

async def show_help_tool(args: dict, ws_emit: Callable, session: Any = None) -> dict:
    """Show a help card listing all capabilities."""
    help_text = (
        "I can help you with these tasks:\n"
        "- **Scan project** — See what bins and clips you have\n"
        "- **Transcribe clips** — Run Whisper on your footage\n"
        "- **Match script** — If you have a written script, I'll match it to your takes\n"
        "- **Cut from transcripts** — No script? I'll select the best takes\n"
        "- **Apply plan** — Build a sequence in Premiere Pro\n"
        "- **Change model** — Switch the LLM I use\n"
        "\nJust tell me what you want to do!"
    )
    return _envelope(
        tool="show_help",
        success=True,
        summary="Returned help card.",
        ui={"kind": "ack", "payload": {"text": help_text}},
    )


# ── Tool Registry ──────────────────────────────────────────────

# ── Tool: build_llm_paste_prompt ────────────────────────────────
# Option B / external-LLM workflow.  Bundles the user's script and the full
# word-level transcript of every clip in this session into a single prompt
# the user can paste into Claude / ChatGPT / Gemini.  The frontier model
# returns JSON which the user then pastes back via apply_pasted_plan.

async def build_llm_paste_prompt_tool(args: dict, ws_emit: Callable, session: Any = None) -> dict:
    """Produce the clipboard text for the external-LLM paste workflow.

    Call when the user asks for "the LLM prompt", "the prompt to paste into
    Claude", "give me the external prompt", etc.  Returns the full prompt in
    ``data.prompt`` so the frontend can copy it to the clipboard.

    Args (all optional — recovered from session if missing):
        script: the user's script.  If absent, recovered from chat history.
    """
    transcripts_ready = (getattr(session, "context", {}) or {}).get("transcripts_ready") or {}
    if not transcripts_ready:
        return _envelope(
            tool="build_llm_paste_prompt",
            success=False,
            summary="Transcribe at least one clip before building the LLM prompt.",
            error="no_transcripts_ready",
        )

    script = (args.get("script") or "").strip()
    if not script:
        recovered = _extract_script_from_history(session)
        if recovered:
            script = recovered
            logger.info("build_llm_paste_prompt: recovered script from history (%d chars)", len(script))
    if not script:
        return _envelope(
            tool="build_llm_paste_prompt",
            success=False,
            summary="No script in this session yet. Paste your script in chat first.",
            error="no_script",
        )

    # Pull word lists for every clip from the Whisper cache.
    from ...services.whisper_service import whisper_service
    word_lookup: dict = {}
    missing: list[str] = []
    for clip_path in transcripts_ready.keys():
        try:
            tr = await whisper_service.transcribe_fingerprinted(
                source_path=clip_path,
                language=None,
                force=False,
            )
            words = []
            for seg in getattr(tr, "segments", []) or []:
                for w in getattr(seg, "words", []) or []:
                    words.append(w)
            if words:
                word_lookup[clip_path] = words
            else:
                missing.append(Path(clip_path).name)
        except Exception as e:  # noqa: BLE001
            logger.warning("build_llm_paste_prompt: no cached transcript for %s: %s", clip_path, e)
            missing.append(Path(clip_path).name)

    if not word_lookup:
        return _envelope(
            tool="build_llm_paste_prompt",
            success=False,
            summary=f"Couldn't load word-level transcripts for any clip. Missing: {', '.join(missing)}",
            error="no_word_data",
        )

    from ...services.external_plan import build_paste_prompt
    prompt = build_paste_prompt(
        script=script,
        transcripts_ready=transcripts_ready,
        word_lookup=word_lookup,
    )

    # Frontend has no copy-to-clipboard UI handler (would require new UI
    # which the user explicitly declined).  Instead, write the prompt to a
    # file next to one of the source clips so the user can open it in any
    # text editor, select all, and paste into the frontier model.  We pick
    # the first clip's directory as the home — that's where the user
    # already has the transcripts and is the natural copy destination.
    prompt_path: Path | None = None
    try:
        first_clip = next(iter(word_lookup.keys()))
        home = Path(first_clip).parent
        prompt_path = home / "editflow_llm_prompt.txt"
        prompt_path.write_text(prompt, encoding="utf-8")
    except Exception as e:  # noqa: BLE001
        logger.warning("Couldn't write prompt file: %s", e)
        prompt_path = None

    # Build the summary so the path is the FIRST line — that's what the LLM
    # quotes back to the user and what makes the prompt actually findable.
    if prompt_path:
        summary_lines = [
            f"LLM prompt written to: {prompt_path}",
            f"({len(prompt):,} chars, "
            f"{sum(len(v) for v in word_lookup.values()):,} words, "
            f"{len(word_lookup)} clip(s)).",
            "Open that file, copy ALL of it, paste into Claude/ChatGPT/Gemini.",
            "When it replies with JSON, paste the JSON back in chat here.",
        ]
    else:
        summary_lines = [
            f"Built LLM prompt: {len(prompt):,} characters, "
            f"{sum(len(v) for v in word_lookup.values()):,} words across "
            f"{len(word_lookup)} clip(s). (Couldn't write to disk — see logs.)",
        ]
    if missing:
        summary_lines.append(f"(No word data for {', '.join(missing)} — skipped.)")

    return _envelope(
        tool="build_llm_paste_prompt",
        success=True,
        summary="\n".join(summary_lines),
        data={
            "prompt_chars": len(prompt),
            "prompt_path": str(prompt_path) if prompt_path else None,
            "prompt": prompt,
            "clips_included": list(word_lookup.keys()),
            "clips_missing": missing,
        },
        ui={"kind": "paste_prompt_card", "payload": {
            "prompt": prompt,
            "prompt_path": str(prompt_path) if prompt_path else None,
            "prompt_chars": len(prompt),
            "clips_included": list(word_lookup.keys()),
            "clips_missing": missing,
        }},
    )


# ── Tool: apply_pasted_plan ─────────────────────────────────────
# Companion to build_llm_paste_prompt.  Accepts the frontier model's JSON
# response, builds a Plan, returns its plan_id.  The user then applies it
# the same way as an auto-matched plan ("Build sequence" button).

async def apply_pasted_plan_tool(args: dict, ws_emit: Callable, session: Any = None) -> dict:
    """Ingest a JSON cut plan the user pasted back from a frontier LLM.

    Call when the user says something like "here's the plan", "apply this
    cut plan", "I pasted the JSON below", and provides JSON text.

    Args:
        pasted_text: the raw JSON the user copied from the frontier model.
            Tolerates ```json``` fences and surrounding prose.
        bin_reference: optional; defaults to the session's last scanned bin.
    """
    pasted_text = (args.get("pasted_text") or args.get("plan_json") or args.get("text") or "").strip()
    if not pasted_text:
        return _envelope(
            tool="apply_pasted_plan",
            success=False,
            summary="Provide the pasted JSON text in the 'pasted_text' argument.",
            error="empty_paste",
        )

    transcripts_ready = (getattr(session, "context", {}) or {}).get("transcripts_ready") or {}
    if not transcripts_ready:
        return _envelope(
            tool="apply_pasted_plan",
            success=False,
            summary="No transcribed clips in this session — can't resolve source files.",
            error="no_transcripts_ready",
        )

    script = (args.get("script") or "").strip() or (_extract_script_from_history(session) or "")
    bin_reference = (args.get("bin_reference") or "").strip()
    if not bin_reference:
        # Best-effort: pull last scan's bin from session context.
        ctx = getattr(session, "context", {}) or {}
        bin_reference = ctx.get("last_bin_reference") or "@external"

    from ...services.external_plan import (
        ExternalPlanError,
        build_plan_from_pasted_json,
    )

    try:
        plan = build_plan_from_pasted_json(
            pasted_text,
            bin_reference=bin_reference,
            script=script,
            transcripts_ready=transcripts_ready,
            user_hint="external_llm_paste",
        )
    except ExternalPlanError as exc:
        return _envelope(
            tool="apply_pasted_plan",
            success=False,
            summary=f"Couldn't build a plan from that JSON: {exc}",
            error=str(exc),
        )

    # plan_id is picked up by session._update_context_from_tool because we
    # registered "apply_pasted_plan" alongside the matcher tools — no manual
    # context write needed here.

    # Build a beats list so the plan_card UI has something to display.
    total_dur = plan.summary.get("total_duration", 0)
    beats = []
    for c in plan.cuts:
        beats.append({
            "text": getattr(c, "beat_text", "") or "",
            "clipName": Path(c.take_source_file).name if getattr(c, "take_source_file", None) else "",
            "start": round(getattr(c, "source_in", 0) or 0, 2),
            "end": round(getattr(c, "source_out", 0) or 0, 2),
            "duration": round(getattr(c, "duration", 0) or 0, 2),
            "unmatched": False,
        })

    return _envelope(
        tool="apply_pasted_plan",
        success=True,
        summary=(
            f"Built plan {plan.plan_id} from pasted JSON: "
            f"{len(plan.cuts)} cut(s), {len(plan.gaps)} skipped, "
            f"{total_dur:.1f}s total. "
            f"Ready to Build sequence (call apply_plan with plan_id={plan.plan_id})."
        ),
        data={
            "plan_id": plan.plan_id,
            "summary": plan.summary,
            "gaps": plan.gaps,
            "cuts_count": len(plan.cuts),
        },
        ui={"kind": "plan_card", "payload": {
            "intro": (
                f"Ingested pasted plan: {len(plan.cuts)} cut(s), "
                f"{round(total_dur / 60, 1)}min total."
            ),
            "plan_id": plan.plan_id,
            "plan": {
                "beats": beats,
                "totalDuration": total_dur,
                "unmatched": len(plan.gaps),
            },
        }},
    )


TOOLS: Dict[str, Callable] = {
    "scan_project": scan_project_tool,
    "list_bins": list_bins_tool,
    "resolve_clips_in_bin": resolve_clips_in_bin_tool,
    "transcribe_clips": transcribe_clips_tool,
    "get_transcript": get_transcript_tool,
    "list_transcript_paths": list_transcript_paths_tool,
    "read_document": read_document_tool,
    "match_script_to_transcripts": match_script_to_transcripts_tool,
    "propose_cuts_from_transcripts": propose_cuts_from_transcripts_tool,
    "build_llm_paste_prompt": build_llm_paste_prompt_tool,
    "apply_pasted_plan": apply_pasted_plan_tool,
    "get_plan": get_plan_tool,
    "regenerate_plan": regenerate_plan_tool,
    "apply_plan": apply_plan_tool,
    "set_active_chat_model": set_active_chat_model_tool,
    "show_help": show_help_tool,
}


async def dispatch(
    tool_name: str,
    args: dict,
    ws_emit: Callable,
    session: Any = None,
) -> dict:
    """Dispatch a tool call by name. Returns the tool's envelope."""
    fn = TOOLS.get(tool_name)
    if not fn:
        return _envelope(
            tool=tool_name,
            success=False,
            summary=f"Unknown tool: {tool_name}",
            error=f"Tool '{tool_name}' is not registered",
        )
    try:
        return await fn(args, ws_emit, session=session)
    except Exception as e:
        logger.exception(f"Tool '{tool_name}' threw an exception")
        return _envelope(
            tool=tool_name,
            success=False,
            summary=f"Tool failed: {e}",
            error=str(e),
        )
