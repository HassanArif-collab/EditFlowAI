"""
EditFlow AI — Native Model Context Protocol (MCP) Server
========================================================
Provides any MCP-capable AI agent (Antigravity, Claude, Cursor, Windsurf) with
full, zero-error control over both EditFlow AI (Visual Library, Brand Folders,
Whisper Transcription, Story Cut Assembly, Captions 3.0) and Adobe Premiere Pro
(Bins/Folders, Media Import, Multi-Track Timeline Editing, Markers, Effects).

Features:
- Auto-Sign-In & Self-Healing Backend Bootstrap: Automatically verifies and
  launches the EditFlow AI backend (http://127.0.0.1:8765) if not already running.
- Dual-Framing JSON-RPC 2.0 over stdio: Supports both newline-delimited JSON-RPC
  and Content-Length framed JSON-RPC.
- Zero external fragile dependencies: Runs with standard library + EditFlow venv.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_URL = os.environ.get("EDITFLOW_BACKEND_URL", "http://127.0.0.1:8765").rstrip("/")
AGENT_SESSION_ID = "editflow-antigravity-master"
AGENT_CLIENT_ID = "antigravity-mcp-controller"

VIDEO_EXTENSIONS = {".mp4", ".mov", ".mxf", ".mkv", ".avi", ".webm", ".m4v", ".mts"}
AUDIO_EXTENSIONS = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"}


def _http_request(
    method: str,
    path: str,
    body: Optional[Dict[str, Any]] = None,
    timeout: float = 30.0,
) -> Dict[str, Any]:
    """Perform an HTTP JSON request against the EditFlow AI backend."""
    url = f"{BACKEND_URL}{path}"
    data = None
    headers = {
        "Accept": "application/json",
        "X-EditFlow-Client": AGENT_CLIENT_ID,
        "X-EditFlow-Session": AGENT_SESSION_ID,
    }
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            if not raw.strip():
                return {"success": True}
            return json.loads(raw)
    except urllib.error.HTTPError as e:
        err_body = ""
        try:
            err_body = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        try:
            parsed = json.loads(err_body)
            return {"success": False, "status_code": e.code, "error": parsed.get("detail", parsed)}
        except Exception:
            return {"success": False, "status_code": e.code, "error": err_body or str(e)}
    except Exception as e:
        return {"success": False, "error": str(e)}


def ensure_backend_online() -> Dict[str, Any]:
    """Verify the EditFlow AI backend is running; auto-start it if offline."""
    ping = _http_request("GET", "/api/premiere/health", timeout=2.5)
    if "context_available" in ping or ping.get("success") is True:
        return {"online": True, "auto_started": False, "backend_url": BACKEND_URL}

    # Try starting the backend via pythonw.exe / python.exe
    venv_pythonw = REPO_ROOT / ".venv" / "Scripts" / "pythonw.exe"
    venv_python = REPO_ROOT / ".venv" / "Scripts" / "python.exe"
    exe = str(venv_pythonw if venv_pythonw.exists() else (venv_python if venv_python.exists() else Path(sys.executable)))
    run_script = REPO_ROOT / "run.py"

    if run_script.exists():
        creationflags = 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW
        try:
            subprocess.Popen(
                [exe, str(run_script), "--prod"],
                cwd=str(REPO_ROOT),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=creationflags,
            )
        except Exception as e:
            return {"online": False, "error": f"Failed to auto-start EditFlow backend: {e}"}

        for _ in range(20):
            time.sleep(0.4)
            check = _http_request("GET", "/api/premiere/health", timeout=2.0)
            if "context_available" in check or check.get("success") is True:
                return {"online": True, "auto_started": True, "backend_url": BACKEND_URL}

    return {"online": False, "error": f"EditFlow backend at {BACKEND_URL} did not respond."}


def _call_premiere_rpc(
    command: str,
    payload: Optional[Dict[str, Any]] = None,
    target: str = "extendscript",
    timeout: float = 25.0,
) -> Dict[str, Any]:
    """Send a live command to the Premiere Pro CEP panel via the backend RPC bridge."""
    ensure_backend_online()
    return _http_request(
        "POST",
        "/api/premiere/rpc",
        body={
            "command": command,
            "payload": payload or {},
            "target": target,
            "timeout": timeout,
            "queue_if_offline": True,
        },
        timeout=timeout + 5.0,
    )


# ── MCP Tool Definitions ──────────────────────────────────────────────────────

TOOLS: List[Dict[str, Any]] = [
    {
        "name": "editflow_connect_and_status",
        "description": (
            "Automatically signs in and connects to EditFlow AI and Adobe Premiere Pro. "
            "Auto-starts the EditFlow backend if offline, checks the live CEP panel WebSocket bridge, "
            "and returns active sequence info, visual library brands, and project counts. "
            "Call this first when taking control of EditFlow AI."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "editflow_switch_view",
        "description": (
            "Switches the active tab inside the EditFlow AI CEP extension panel in Premiere Pro "
            "('captions', 'storyCut', 'review', or 'chat')."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "view": {
                    "type": "string",
                    "enum": ["captions", "storyCut", "review", "chat"],
                    "description": "Target view to open in the EditFlow AI extension.",
                }
            },
            "required": ["view"],
        },
    },
    {
        "name": "editflow_list_brands",
        "description": "Lists all brands in the EditFlow AI Visual Library with folder and indexed clip counts.",
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "editflow_list_brand_folders",
        "description": (
            "Lists all registered visual video folders for a specific brand, showing which folders "
            "are already added, how many videos they contain, and whether they are transcribed and indexed."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "brand": {
                    "type": "string",
                    "description": "Brand name (e.g., 'default', 'Al-Khair', etc.). Defaults to 'default'.",
                }
            },
        },
    },
    {
        "name": "editflow_add_brand_folder",
        "description": (
            "Registers a local folder of videos into a brand's Visual Library in EditFlow AI "
            "(recursively discovers MP4/MOV/WhatsApp videos) and optionally starts transcription & indexing."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "folder_path": {
                    "type": "string",
                    "description": "Absolute path to the folder containing visual/B-roll videos.",
                },
                "brand": {
                    "type": "string",
                    "description": "Brand identifier to associate this visual folder with (default: 'default').",
                },
                "auto_index": {
                    "type": "boolean",
                    "description": "If true, immediately triggers transcription and visual indexing after adding.",
                },
            },
            "required": ["folder_path"],
        },
    },
    {
        "name": "editflow_transcribe_and_index_brand",
        "description": (
            "Transcribes and indexes all visual folders registered for a brand (or a specific folder path) "
            "so B-roll clips are searchable by speech, visual description, and semantic role."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "brand": {
                    "type": "string",
                    "description": "Brand name to transcribe and index (default: 'default').",
                },
                "folder_path": {
                    "type": "string",
                    "description": "Optional specific folder path to index.",
                },
            },
        },
    },
    {
        "name": "editflow_search_visuals",
        "description": (
            "Searches indexed B-roll and visual assets in the EditFlow Visual Library for a brand, "
            "or matches the best visual cut for a given script line / visual role."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "brand": {
                    "type": "string",
                    "description": "Brand name to search within (default: 'default').",
                },
                "query": {
                    "type": "string",
                    "description": "Optional text or visual role query to match B-roll against.",
                },
                "duration": {
                    "type": "number",
                    "description": "Target cut duration in seconds when matching a beat (default: 4.0).",
                },
            },
        },
    },
    {
        "name": "editflow_assemble_story_cut",
        "description": (
            "Compiles a script into A-roll and B-roll visual beats and automatically assembles "
            "the multi-track edit onto the Adobe Premiere Pro timeline."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "script_text": {
                    "type": "string",
                    "description": "Full script text or beat lines to compile and assemble.",
                },
                "sequence_name": {
                    "type": "string",
                    "description": "Target sequence name in Premiere Pro (default: 'EditFlow Story Cut').",
                },
                "aspect_ratio": {
                    "type": "string",
                    "enum": ["9:16", "16:9", "1:1", "4:5"],
                    "description": "Sequence aspect ratio (default: '9:16').",
                },
            },
            "required": ["script_text"],
        },
    },
    {
        "name": "premiere_scan_project",
        "description": (
            "Scans the open Adobe Premiere Pro project to list all bins (folders), media items, "
            "and sequences, and syncs the project context with EditFlow AI."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "premiere_get_sequence_state",
        "description": (
            "Reads the active sequence in Adobe Premiere Pro, including resolution, FPS, duration, "
            "playhead position, video tracks, audio tracks, and placed clips."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "premiere_create_bin",
        "description": (
            "Creates a folder (bin) inside the Adobe Premiere Pro project. Supports nested folder "
            "paths such as 'Visuals/Brand_A/Raw_September' or specifying a parent_bin."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "bin_name": {
                    "type": "string",
                    "description": "Name or nested path of the bin to create (e.g. 'B-Roll/Brand_Visuals').",
                },
                "parent_bin": {
                    "type": "string",
                    "description": "Optional parent bin path.",
                },
            },
            "required": ["bin_name"],
        },
    },
    {
        "name": "premiere_import_media",
        "description": (
            "Imports media files (or all video/audio files inside a directory) directly into a "
            "target bin (folder) in Adobe Premiere Pro."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "paths": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of file paths or directory paths to import into Premiere Pro.",
                },
                "bin_name": {
                    "type": "string",
                    "description": "Target Premiere Pro bin name/path (created automatically if it does not exist).",
                },
            },
            "required": ["paths"],
        },
    },
    {
        "name": "premiere_add_clip_to_timeline",
        "description": (
            "Places a video, B-roll visual, or audio clip onto the active Premiere Pro sequence "
            "at an exact timeline position and track index. Supports 108% punch-in scale and J-cuts."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "media_path": {
                    "type": "string",
                    "description": "Absolute file path of the video or audio clip.",
                },
                "start_time": {
                    "type": "number",
                    "description": "Timeline placement start time in seconds.",
                },
                "in_point": {
                    "type": "number",
                    "description": "Source clip In point in seconds (default: 0).",
                },
                "out_point": {
                    "type": "number",
                    "description": "Source clip Out point in seconds (0 = full clip).",
                },
                "video_track_index": {
                    "type": "integer",
                    "description": "0-based video track index (0 = V1 A-roll, 1 = V2 B-roll, 2 = V3 overlay).",
                },
                "audio_track_index": {
                    "type": "integer",
                    "description": "0-based audio track index (-1 for silent video-only B-roll, 0 = A1, 2 = A3).",
                },
                "scale": {
                    "type": "number",
                    "description": "Optional Motion Scale percentage (e.g. 108 for punch-in).",
                },
                "j_cut_frames": {
                    "type": "integer",
                    "description": "Optional J-cut audio lead in frames (e.g. 4).",
                },
            },
            "required": ["media_path", "start_time"],
        },
    },
    {
        "name": "premiere_remove_timeline_ranges",
        "description": (
            "Ripple-deletes specified time ranges (e.g. silences, retakes, filler words) from the "
            "active Premiere Pro sequence in reverse chronological order."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "ranges": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "start": {"type": "number"},
                            "end": {"type": "number"},
                            "label": {"type": "string"},
                        },
                        "required": ["start", "end"],
                    },
                    "description": "List of {start, end} ranges in seconds to ripple-cut from the timeline.",
                },
                "preview_only": {
                    "type": "boolean",
                    "description": "If true, calculates merged ranges and time saved without cutting.",
                },
            },
            "required": ["ranges"],
        },
    },
    {
        "name": "premiere_add_markers",
        "description": "Adds sequence markers or YouTube chapter markers to the active Premiere Pro sequence.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "markers": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "time": {"type": "number"},
                            "name": {"type": "string"},
                            "comment": {"type": "string"},
                            "color": {"type": "integer"},
                        },
                        "required": ["time", "name"],
                    },
                    "description": "Array of markers with time (seconds), name, optional comment and color index.",
                },
                "as_chapters": {
                    "type": "boolean",
                    "description": "If true, creates chapter markers via setChapterMarkers.",
                },
            },
            "required": ["markers"],
        },
    },
    {
        "name": "premiere_execute_edl",
        "description": (
            "Executes a batch of EDL operations atomically in Premiere Pro (supports: ensure_bin, "
            "import_file, create_sequence, add, move, modify, remove, add_marker, add_captions)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "sequence_name": {
                    "type": "string",
                    "description": "Optional sequence name to create or target.",
                },
                "operations": {
                    "type": "array",
                    "items": {"type": "object"},
                    "description": "List of EDL operation objects.",
                },
            },
            "required": ["operations"],
        },
    },
    {
        "name": "premiere_call_extendscript",
        "description": (
            "Low-level power tool: dispatches any EditFlow ExtendScript command or module function "
            "(e.g., command='callModule', payload={'module': 'captionsManager', 'fn': 'sequenceInfo'}) "
            "directly inside Adobe Premiere Pro."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "ExtendScript command name in editflowDispatch (or 'callModule').",
                },
                "payload": {
                    "type": "object",
                    "description": "JSON payload passed to the ExtendScript command.",
                },
            },
            "required": ["command"],
        },
    },
]


# ── Tool Execution Dispatcher ─────────────────────────────────────────────────

def execute_tool(name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    """Execute an MCP tool call and return a structured result dict."""
    boot = ensure_backend_online()
    if not boot.get("online"):
        return {"success": False, "error": boot.get("error", "Backend offline")}

    if name == "editflow_connect_and_status":
        bridge = _http_request("GET", "/api/premiere/bridge-status")
        brands = _http_request("GET", "/api/visual-library/brands")
        vl_status = _http_request("GET", "/api/visual-library/status")
        # Initialize agent session automatically so the agent is signed in
        _http_request(
            "POST",
            "/api/agent/turn",
            body={
                "session_id": AGENT_SESSION_ID,
                "client_id": AGENT_CLIENT_ID,
                "event": "init",
                "payload": {},
            },
        )
        return {
            "success": True,
            "signed_in": True,
            "session_id": AGENT_SESSION_ID,
            "client_id": AGENT_CLIENT_ID,
            "backend": boot,
            "premiere_bridge": bridge,
            "visual_library_brands": brands.get("brands", []),
            "visual_library_status": vl_status,
        }

    elif name == "editflow_switch_view":
        view = args.get("view", "captions")
        return _call_premiere_rpc("switch_view", {"view": view}, target="ui")

    elif name == "editflow_list_brands":
        return _http_request("GET", "/api/visual-library/brands")

    elif name == "editflow_list_brand_folders":
        brand = args.get("brand") or "default"
        q = urllib.parse.urlencode({"brand": brand})
        return _http_request("GET", f"/api/visual-library/folders?{q}")

    elif name == "editflow_add_brand_folder":
        folder_path = args.get("folder_path", "")
        brand = args.get("brand") or "default"
        auto_index = bool(args.get("auto_index", False))
        res = _http_request(
            "POST",
            "/api/visual-library/folders",
            body={"folder_path": folder_path, "brand": brand},
        )
        if auto_index and res.get("success", True):
            idx_res = _http_request(
                "POST",
                "/api/visual-library/transcribe-and-index",
                body={"brand": brand, "folder_path": folder_path, "client_id": AGENT_CLIENT_ID},
                timeout=60.0,
            )
            res["indexing_triggered"] = idx_res
        return res

    elif name == "editflow_transcribe_and_index_brand":
        brand = args.get("brand") or "default"
        folder_path = args.get("folder_path")
        body: Dict[str, Any] = {"brand": brand, "client_id": AGENT_CLIENT_ID}
        if folder_path:
            body["folder_path"] = folder_path
        return _http_request("POST", "/api/visual-library/transcribe-and-index", body=body, timeout=120.0)

    elif name == "editflow_search_visuals":
        brand = args.get("brand") or "default"
        query = (args.get("query") or "").strip()
        duration = float(args.get("duration") or 4.0)
        if query:
            params = urllib.parse.urlencode({"text": query, "duration": duration, "brand": brand})
            match_res = _http_request("GET", f"/api/visual-library/match-cut?{params}")
            items_res = _http_request("GET", f"/api/visual-library/items?{urllib.parse.urlencode({'brand': brand})}")
            items = items_res.get("items", [])
            q_lower = query.lower()
            filtered = [
                it for it in items
                if q_lower in json.dumps(it, ensure_ascii=False).lower()
            ]
            return {
                "success": True,
                "brand": brand,
                "query": query,
                "best_match_cut": match_res,
                "matching_items": filtered[:25],
                "total_brand_items": len(items),
            }
        else:
            return _http_request("GET", f"/api/visual-library/items?{urllib.parse.urlencode({'brand': brand})}")

    elif name == "editflow_assemble_story_cut":
        script_text = args.get("script_text", "")
        seq_name = args.get("sequence_name") or "EditFlow Story Cut"
        aspect = args.get("aspect_ratio") or "9:16"
        compile_res = _http_request(
            "POST",
            "/api/script-assembly/compile",
            body={"script_text": script_text, "client_id": AGENT_CLIENT_ID},
            timeout=120.0,
        )
        if not compile_res.get("beats") and not compile_res.get("success"):
            return compile_res
        beats = compile_res.get("beats", [])
        assemble_res = _http_request(
            "POST",
            "/api/script-assembly/assemble",
            body={
                "sequence_name": seq_name,
                "aspect_ratio": aspect,
                "beats": beats,
            },
            timeout=60.0,
        )
        edl_ops = assemble_res.get("ops") or assemble_res.get("operations")
        edl_path = assemble_res.get("edl_path")
        premiere_exec = None
        if edl_ops:
            premiere_exec = _call_premiere_rpc("processEDL", {"sequence_name": seq_name, "ops": edl_ops})
        elif edl_path:
            premiere_exec = _call_premiere_rpc("callModule", {"module": "clipManager", "fn": "processEDL", "edlJsonPath": edl_path})
        return {
            "success": True,
            "compiled_beats": len(beats),
            "assembly": assemble_res,
            "premiere_execution": premiere_exec,
        }

    elif name == "premiere_scan_project":
        return _call_premiere_rpc("scanProject", {})

    elif name == "premiere_get_sequence_state":
        return _call_premiere_rpc("getSequenceState", {})

    elif name == "premiere_create_bin":
        bin_name = args.get("bin_name", "EditFlow Output")
        parent_bin = args.get("parent_bin")
        payload = {"bin_name": bin_name}
        if parent_bin:
            payload["parent_bin"] = parent_bin
        return _call_premiere_rpc("createBin", payload)

    elif name == "premiere_import_media":
        raw_paths = args.get("paths") or []
        bin_name = args.get("bin_name") or "EditFlow Imports"
        expanded_files: List[str] = []
        for p_str in raw_paths:
            p = Path(p_str)
            if p.is_dir():
                for child in sorted(p.rglob("*")):
                    if child.is_file() and child.suffix.lower() in (VIDEO_EXTENSIONS | AUDIO_EXTENSIONS):
                        expanded_files.append(str(child.resolve()))
            elif p.is_file():
                expanded_files.append(str(p.resolve()))
            else:
                expanded_files.append(p_str)
        if not expanded_files:
            return {"success": False, "error": f"No media files found in paths: {raw_paths}"}
        return _call_premiere_rpc("importFiles", {"paths": expanded_files, "bin_name": bin_name})

    elif name == "premiere_add_clip_to_timeline":
        payload = {
            "mediaPath": args.get("media_path"),
            "startTime": float(args.get("start_time", 0.0)),
            "inPoint": float(args.get("in_point", 0.0)),
            "outPoint": float(args.get("out_point", 0.0)),
        }
        if "video_track_index" in args and args["video_track_index"] is not None:
            payload["video_track_index"] = int(args["video_track_index"])
        if "audio_track_index" in args and args["audio_track_index"] is not None:
            payload["audio_track_index"] = int(args["audio_track_index"])
        if "scale" in args and args["scale"] is not None:
            payload["scale"] = float(args["scale"])
        if "j_cut_frames" in args and args["j_cut_frames"] is not None:
            payload["j_cut_frames"] = int(args["j_cut_frames"])
        return _call_premiere_rpc("insertClipAtTime", payload)

    elif name == "premiere_remove_timeline_ranges":
        return _call_premiere_rpc(
            "removeTimelineRanges",
            {
                "ranges": args.get("ranges", []),
                "previewOnly": bool(args.get("preview_only", False)),
            },
        )

    elif name == "premiere_add_markers":
        markers = args.get("markers", [])
        if args.get("as_chapters"):
            return _call_premiere_rpc("setChapterMarkers", {"chapters": markers})
        ops = [
            {
                "action": "add_marker",
                "time": m.get("time", 0),
                "name": m.get("name", "Marker"),
                "comments": m.get("comment", ""),
                "color_index": m.get("color", 4),
            }
            for m in markers
        ]
        return _call_premiere_rpc("processEDL", {"ops": ops})

    elif name == "premiere_execute_edl":
        return _call_premiere_rpc(
            "processEDL",
            {
                "sequence_name": args.get("sequence_name"),
                "ops": args.get("operations", []),
            },
        )

    elif name == "premiere_call_extendscript":
        return _call_premiere_rpc(
            args.get("command", ""),
            args.get("payload") or {},
        )

    return {"success": False, "error": f"Unknown tool: {name}"}


# ── Stdio JSON-RPC 2.0 Server Loop ────────────────────────────────────────────

def _send_message(msg: Dict[str, Any], use_content_length: bool = False) -> None:
    raw = json.dumps(msg, ensure_ascii=False)
    encoded = raw.encode("utf-8")
    if use_content_length:
        header = f"Content-Length: {len(encoded)}\r\n\r\n".encode("ascii")
        sys.stdout.buffer.write(header + encoded)
        sys.stdout.buffer.flush()
    else:
        sys.stdout.buffer.write(encoded + b"\n")
        sys.stdout.buffer.flush()


def _handle_rpc_request(req: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    method = req.get("method", "")
    req_id = req.get("id")
    params = req.get("params") or {}

    # Notifications (no id) require no response
    if req_id is None:
        return None

    if method == "initialize":
        client_proto = params.get("protocolVersion", "2024-11-05")
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": client_proto,
                "capabilities": {
                    "tools": {"listChanged": False},
                    "resources": {"listChanged": False},
                    "prompts": {"listChanged": False},
                },
                "serverInfo": {
                    "name": "editflow-mcp",
                    "version": "3.0.0",
                },
            },
        }

    elif method == "ping":
        return {"jsonrpc": "2.0", "id": req_id, "result": {}}

    elif method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}}

    elif method == "resources/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"resources": []}}

    elif method == "prompts/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"prompts": []}}

    elif method == "tools/call":
        tool_name = params.get("name", "")
        tool_args = params.get("arguments") or {}
        try:
            out = execute_tool(tool_name, tool_args)
            is_err = isinstance(out, dict) and out.get("success") is False and "error" in out
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps(out, indent=2, ensure_ascii=False),
                        }
                    ],
                    "isError": bool(is_err),
                },
            }
        except Exception as e:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps({"success": False, "error": str(e)}, indent=2),
                        }
                    ],
                    "isError": True,
                },
            }

    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


def main() -> None:
    """Run the MCP stdio server loop supporting both newline and Content-Length framing."""
    use_content_length = False
    stdin_buf = sys.stdin.buffer

    while True:
        line = stdin_buf.readline()
        if not line:
            break

        stripped = line.strip()
        if not stripped:
            continue

        if stripped.lower().startswith(b"content-length:"):
            use_content_length = True
            length = int(stripped.split(b":", 1)[1].strip())
            # Consume remaining headers until empty line
            while True:
                hdr = stdin_buf.readline()
                if not hdr or hdr.strip() == b"":
                    break
            body_bytes = stdin_buf.read(length)
            if not body_bytes:
                break
            try:
                req = json.loads(body_bytes.decode("utf-8", errors="replace"))
            except Exception:
                continue
        else:
            try:
                req = json.loads(stripped.decode("utf-8", errors="replace"))
            except Exception:
                continue

        resp = _handle_rpc_request(req)
        if resp is not None:
            _send_message(resp, use_content_length=use_content_length)


if __name__ == "__main__":
    main()
