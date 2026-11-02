"""
EditFlow AI — Native Model Context Protocol (MCP) Server
========================================================
Provides any MCP-capable AI agent (Antigravity, Claude, Cursor, Windsurf) with
project-scoped control over both EditFlow AI (Visual Library, Brand Folders,
Whisper Transcription, Story Cut Assembly, Captions 3.0) and Adobe Premiere Pro
(Bins/Folders, Media Import, Multi-Track Timeline Editing, Markers, Effects).

Features:
- Auto-Sign-In & Self-Healing Backend Bootstrap: Automatically verifies and
  launches the EditFlow AI backend (http://127.0.0.1:8765) if not already running.
- Dual-Framing JSON-RPC 2.0 over stdio: Supports both newline-delimited JSON-RPC
  and Content-Length framed JSON-RPC.
- Zero external fragile dependencies: Runs with standard library + EditFlow venv.
- Automatic Cartesia Streaming WAV Repair: Rewrites 0xFFFFFFFF headers to exact
  byte length so Premiere Pro and DAWs see true durations instead of 13.5 hours.
- 1-Call Composition Builder (premiere_build_custom_sequence): Creates bin,
  generates voiceover, imports all media, creates sequence, places multi-track
  beats with validated timing, and stops the native batch at its first failure.
"""
from __future__ import annotations

import json
import importlib.util
import re
import math
import os
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import winreg
from pathlib import Path
from typing import Any, Dict, List, Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_URL = os.environ.get("EDITFLOW_BACKEND_URL", "http://127.0.0.1:8765").rstrip("/")
AGENT_SESSION_ID = "editflow-antigravity-master"
AGENT_CLIENT_ID = "antigravity-mcp-controller"

VIDEO_EXTENSIONS = {".mp4", ".mov", ".mxf", ".mkv", ".avi", ".webm", ".m4v", ".mts"}
AUDIO_EXTENSIONS = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
ALL_MEDIA_EXTENSIONS = VIDEO_EXTENSIONS | AUDIO_EXTENSIONS | IMAGE_EXTENSIONS

# Cartesia defaults
DEFAULT_CARTESIA_MODEL = "sonic-3.6"
DEFAULT_CARTESIA_SPEAKER_ID = "7e5b12de-1414-4909-bafe-5e292f40c415"  # Hafiz Abdullah(Raaf)
DEFAULT_CARTESIA_DICT_ID = "pdict_FnmqX43bWxW52pmXMDCCYV"  # Arabic & Urdu Islamic Terms


def get_cartesia_api_key() -> str:
    """Retrieve Cartesia API key from environment or Windows registry."""
    k = os.environ.get("CARTESIA_API_KEY", "").strip()
    if k and k.startswith("sk_car_"):
        return k
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Environment")
        reg_k, _ = winreg.QueryValueEx(key, "CARTESIA_API_KEY")
        if reg_k and reg_k.startswith("sk_car_"):
            return reg_k.strip()
    except Exception:
        pass
    return ""


def sanitize_wav_header(wav_path: str | Path) -> float:
    """
    Repairs Cartesia streaming WAV headers (which set ChunkSize and Subchunk2Size
    to 0xFFFFFFFF / 4,294,967,295 bytes) to exact disk byte lengths so Premiere Pro
    and audio decoders see true durations (~27s instead of 13.5 hours).
    Returns exact duration in seconds.
    """
    import wave
    p = Path(wav_path)
    if not p.is_file() or p.stat().st_size < 44:
        return 0.0
    file_size = p.stat().st_size
    data = p.read_bytes()
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return 0.0

    needs_repair = False
    data_list = bytearray(data)

    riff_size = struct.unpack("<I", data[4:8])[0]
    if riff_size == 0xFFFFFFFF or riff_size > file_size or riff_size == 0:
        data_list[4:8] = struct.pack("<I", file_size - 8)
        needs_repair = True

    data_pos = data.find(b"data", 12)
    data_size = file_size - 44
    if data_pos != -1 and len(data) >= data_pos + 8:
        sub2_size = struct.unpack("<I", data[data_pos + 4 : data_pos + 8])[0]
        actual_data_size = file_size - (data_pos + 8)
        if sub2_size == 0xFFFFFFFF or sub2_size > file_size or sub2_size == 0:
            data_list[data_pos + 4 : data_pos + 8] = struct.pack("<I", actual_data_size)
            needs_repair = True
            data_size = actual_data_size
        else:
            data_size = sub2_size

    if needs_repair:
        try:
            p.write_bytes(bytes(data_list))
        except Exception:
            pass

    # Read true duration using standard wave module
    try:
        with wave.open(str(p), "rb") as wf:
            nframes = wf.getnframes()
            rate = wf.getframerate()
            if rate > 0 and nframes < 100000000:
                return round(float(nframes) / float(rate), 3)
    except Exception:
        pass

    # Fallback to byte calculation
    fmt_pos = data.find(b"fmt ", 12)
    sample_rate = 44100
    channels = 1
    bits = 16
    if fmt_pos != -1 and len(data) >= fmt_pos + 24:
        channels = struct.unpack("<H", data[fmt_pos + 10 : fmt_pos + 12])[0]
        sample_rate = struct.unpack("<I", data[fmt_pos + 12 : fmt_pos + 16])[0]
        bits = struct.unpack("<H", data[fmt_pos + 22 : fmt_pos + 24])[0]
    bytes_per_sec = sample_rate * channels * (bits // 8)
    return round(data_size / bytes_per_sec, 3) if bytes_per_sec > 0 else 0.0


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


def ensure_backend_online(max_retries: int = 5, retry_delay: float = 1.0) -> Dict[str, Any]:
    """Check if EditFlow backend is online; if offline, auto-start run.py in background."""
    for _ in range(2):
        health = _http_request("GET", "/api/premiere/bridge-status", timeout=3.0)
        if health.get("backend_online") or health.get("success") or health.get("ready"):
            return {"online": True, "auto_started": False, "backend_url": BACKEND_URL}
        time.sleep(0.3)

    run_py = REPO_ROOT / "run.py"
    venv_py = REPO_ROOT / ".venv" / "Scripts" / "python.exe"
    py_exec = str(venv_py) if venv_py.exists() else sys.executable

    creationflags = 0
    if sys.platform == "win32":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS

    try:
        subprocess.Popen(
            [py_exec, str(run_py), "--prod"],
            cwd=str(REPO_ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creationflags,
        )
    except Exception as e:
        return {"online": False, "error": f"Failed to auto-launch backend: {e}"}

    for attempt in range(max_retries):
        time.sleep(retry_delay)
        health = _http_request("GET", "/api/premiere/bridge-status", timeout=3.0)
        if health.get("backend_online") or health.get("success") or health.get("ready"):
            return {"online": True, "auto_started": True, "attempt": attempt + 1, "backend_url": BACKEND_URL}

    return {"online": False, "error": "Backend did not respond after auto-start attempt"}


def _call_premiere_rpc(
    command: str,
    payload: Optional[Dict[str, Any]] = None,
    target: str = "extendscript",
    timeout: float = 30.0,
    queue_if_offline: bool = False,
) -> Dict[str, Any]:
    """Dispatch a live command to Adobe Premiere Pro via the EditFlow WebSocket bridge."""
    body = {
        "command": command,
        "payload": payload or {},
        "target": target,
        "timeout": timeout,
        "queue_if_offline": queue_if_offline,
    }
    return _http_request("POST", "/api/premiere/rpc", body=body, timeout=timeout + 5.0)


def _rpc_value(response: Dict[str, Any]) -> Dict[str, Any]:
    value = response.get("result", {})
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            value = {"success": False, "error": value}
    if not response.get("success"):
        return {"success": False, "error": response.get("error") or (value.get("error") if isinstance(value, dict) else None) or "Premiere command failed."}
    return value if isinstance(value, dict) else {"success": False, "error": "Unexpected Premiere response."}


def _project_binding(folder: Optional[str]) -> Dict[str, Any]:
    project = _rpc_value(_call_premiere_rpc("getProjectDirectory", {}, queue_if_offline=False))
    if not project.get("success") or not project.get("projectPath"):
        return {"success": False, "error": project.get("error") or "Save and open the intended Premiere project before building."}
    context = _http_request("GET", "/api/script-assembly/project-context?" + urllib.parse.urlencode({"project_folder": folder or project["projectDirectory"]}))
    if not context.get("success"):
        return context
    if not Path(project["projectPath"]).resolve().is_relative_to(Path(context["project_folder"]).resolve()):
        return {"success": False, "error": "The open Premiere project differs from the reviewed production project."}
    return {**context, "premiere_project_path": project["projectPath"]}


# ── MCP Tool Definitions ──────────────────────────────────────────────────────

TOOLS = [
    {
        "name": "editflow_connect_and_status",
        "description": (
            "Authenticates the AI agent with EditFlow AI ('Maded Flow'), verifies that the "
            "backend is online (auto-starting it if needed), checks the Adobe Premiere Pro "
            "CEP panel bridge connection status, and returns all registered brand visual libraries."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "editflow_switch_view",
        "description": (
            "Switches the active view / tab inside the user's open EditFlow CEP panel in Adobe Premiere Pro. "
            "Available views: 'storyCut', 'captions', 'review', 'chat'."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "view": {
                    "type": "string",
                    "enum": ["storyCut", "captions", "review", "chat"],
                    "description": "View to display in the CEP panel UI.",
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
                    "description": "Brand name (e.g., 'default', 'Rahima Aziz Foundation', etc.).",
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
                    "description": "Brand identifier to associate this visual folder with.",
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
                    "description": "Brand name to transcribe and index.",
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
            "or matches the best visual cut for a given script line / visual cue / visual role."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "brand": {
                    "type": "string",
                    "description": "Brand name to search within.",
                },
                "query": {
                    "type": "string",
                    "description": "Search query: keyword, visual description, or spoken cue text.",
                },
                "duration": {
                    "type": "number",
                    "description": "Desired B-roll cut duration in seconds (default: 4.0).",
                },
                "visual_role": {
                    "type": "string",
                    "description": "Optional visual role (e.g., 'hook', 'pain_point', 'proof', 'transformation').",
                },
                "top_k": {
                    "type": "integer",
                    "description": "Maximum number of matched candidate clips to return (default: 5).",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "editflow_generate_voiceover",
        "description": (
            "Generates narration using the selected project's brand voice or an explicit Cartesia voice. "
            "Reuses the existing dynamic voice controller for names, repairs WAV headers and saves into the project."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "description": "The exact script / narrative text to synthesize.",
                },
                "project_folder": {"type": "string", "description": "Dated production project; scopes the voice profile and output."},
                "output_path": {
                    "type": "string",
                    "description": "Absolute output path for the .wav file (defaults to EditFlow scratch/output).",
                },
                "speaker": {
                    "type": "string",
                    "description": "Speaker name or voice UUID; otherwise use this brand/project profile.",
                },
                "speed": {
                    "type": "number",
                    "description": "Playback speed (default: 1.2).",
                },
                "volume": {
                    "type": "number",
                    "description": "Volume multiplier (default: 1.5).",
                },
                "emotion": {
                    "type": "string",
                    "description": "Emotion tag (default: 'content').",
                },
            },
            "required": ["text", "project_folder"],
        },
    },
    {
        "name": "editflow_assemble_story_cut",
        "description": (
            "Compiles a script into A-roll and B-roll visual beats and automatically assembles the multi-track "
            "edit directly on the active Adobe Premiere Pro timeline."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "script_text": {
                    "type": "string",
                    "description": "Full voiceover or dialogue script text with optional [visual: ...] tags.",
                },
                "script_path": {
                    "type": "string",
                    "description": "Markdown file in the selected dated project's Scripts folder.",
                },
                "project_folder": {
                    "type": "string",
                    "description": "Dated project folder; keeps script selection scoped to the intended edit.",
                },
                "preview_only": {
                    "type": "boolean",
                    "description": "Compile and return the plan for review without changing Premiere (default false).",
                },
                "variant_id": {"type": "string", "description": "Script version from the compiled variants list; default primary."},
                "sequence_name": {
                    "type": "string",
                    "description": "Target sequence name in Adobe Premiere Pro.",
                },
                "aspect_ratio": {
                    "type": "string",
                    "enum": ["9:16", "16:9", "1:1", "4:5"],
                    "description": "Sequence aspect ratio (default: '9:16').",
                },
            },
            "anyOf": [{"required": ["script_text"]}, {"required": ["script_path"]}],
        },
    },
    {
        "name": "editflow_list_projects",
        "description": "List a brand's dated projects and their project-local Scripts folders.",
        "inputSchema": {
            "type": "object",
            "properties": {"brand": {"type": "string"}},
            "required": ["brand"],
        },
    },
    {
        "name": "editflow_project_context",
        "description": "Read the dated project's existing media, transcript paths, and verified visuals for external script/storyboard authoring.",
        "inputSchema": {"type": "object", "properties": {"project_folder": {"type": "string"}}, "required": ["project_folder"]},
    },
    {
        "name": "editflow_script_catalog",
        "description": "Search same-brand previous and project scripts for reference; never reassigns or assembles them.",
        "inputSchema": {"type": "object", "properties": {"brand": {"type": "string"}, "query": {"type": "string"}}, "required": ["brand"]},
    },
    {
        "name": "editflow_read_script_reference",
        "description": "Read the current original script from a brand's catalog for style/reference. Verify dialogue against original transcripts.",
        "inputSchema": {"type": "object", "properties": {"brand": {"type": "string"}, "path": {"type": "string"}}, "required": ["brand", "path"]},
    },
    {
        "name": "editflow_list_project_scripts",
        "description": "List only the selected project's scripts and return the folder where new scripts belong.",
        "inputSchema": {
            "type": "object",
            "properties": {"project_folder": {"type": "string"}},
            "required": ["project_folder"],
        },
    },
    {
        "name": "editflow_prepare_project_scripts",
        "description": "Create a Scripts folder inside an existing dated project and return its canonical path.",
        "inputSchema": {
            "type": "object",
            "properties": {"project_folder": {"type": "string"}},
            "required": ["project_folder"],
        },
    },
    {
        "name": "premiere_scan_project",
        "description": (
            "Scans the open Adobe Premiere Pro project to list bins (folders), media items, and sequences. "
            "Returns a concise summary by default (compact=true) to save tokens."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "compact": {
                    "type": "boolean",
                    "description": "If true (default), returns a concise summary rather than raw DOM dump.",
                }
            },
        },
    },
    {
        "name": "premiere_get_sequence_state",
        "description": (
            "Reads the active sequence in Adobe Premiere Pro (resolution, FPS, duration, playhead, tracks, clips). "
            "Returns a compact structured summary by default (compact=true) to keep token usage minimal."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "compact": {
                    "type": "boolean",
                    "description": "If true (default), returns a concise track summary instead of full raw clip dump.",
                }
            },
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
                    "description": "Name or nested path of the bin to create (e.g. 'test' or 'Brands/RAF/B-Roll').",
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
        "name": "premiere_create_sequence",
        "description": (
            "Creates a new sequence in Adobe Premiere Pro, immediately focuses it in the Timeline panel, "
            "and optionally places it inside a target project bin (e.g. 'test') to keep the project clean."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "sequence_name": {
                    "type": "string",
                    "description": "Name for the new sequence.",
                },
                "aspect_ratio": {
                    "type": "string",
                    "enum": ["9:16", "16:9", "1:1", "4:5"],
                    "description": "Aspect ratio (default: '9:16').",
                },
                "bin_name": {
                    "type": "string",
                    "description": "Optional bin to place the sequence in (e.g. 'test').",
                },
            },
            "required": ["sequence_name"],
        },
    },
    {
        "name": "premiere_open_sequence",
        "description": "Opens and focuses an existing sequence in the Adobe Premiere Pro Timeline panel by name or ID.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "sequence_name": {
                    "type": "string",
                    "description": "Name (or substring) of the sequence to open.",
                },
                "sequence_id": {
                    "type": "string",
                    "description": "Exact sequenceID GUID if known.",
                },
            },
        },
    },
    {
        "name": "premiere_import_media",
        "description": (
            "Imports video, audio, or image files (or entire folders recursively) directly into a target "
            "bin in Adobe Premiere Pro. Automatically repairs any streaming WAV headers."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "paths": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of file paths or directory paths to import.",
                },
                "bin_name": {
                    "type": "string",
                    "description": "Target Premiere Pro bin name/path (created automatically if needed).",
                },
            },
            "required": ["paths"],
        },
    },
    {
        "name": "premiere_add_clip_to_timeline",
        "description": (
            "Places a video, B-roll visual, image, or audio clip onto the active Premiere Pro sequence "
            "at an exact timeline position and track. Trims both video and audio clips cleanly to exact duration."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "media_path": {
                    "type": "string",
                    "description": "Absolute path to the media file on disk.",
                },
                "start_time": {
                    "type": "number",
                    "description": "Timeline start position in seconds.",
                },
                "duration": {
                    "type": "number",
                    "description": "Clip duration on the timeline in seconds (trims clip explicitly).",
                },
                "in_point": {
                    "type": "number",
                    "description": "Source clip in-point in seconds (default: 0.0).",
                },
                "out_point": {
                    "type": "number",
                    "description": "Source clip out-point in seconds (default: 0.0).",
                },
                "video_track_index": {
                    "type": "integer",
                    "description": "0-based video track (0=V1, 1=V2 B-roll, -1=Audio-only).",
                },
                "audio_track_index": {
                    "type": "integer",
                    "description": "0-based audio track (0=A1 linked camera dialogue, 1=A2 generated narration, -1=silent B-roll, 2=A3).",
                },
                "scale": {
                    "type": "number",
                    "description": "Scale percentage (e.g., 108 for punch-in, 100 for default).",
                },
                "j_cut_frames": {
                    "type": "integer",
                    "description": "J-cut audio lead frame count (default: 0).",
                },
            },
            "required": ["media_path", "start_time"],
        },
    },
    {
        "name": "premiere_build_custom_sequence",
        "description": (
            "1-Call Atomic Composition Builder: creates the target bin, auto-generates voiceover "
            "(if voiceover_text provided), imports all assets, creates and focuses the sequence, "
            "places all video and audio beats with exact timing/scaling, and sets markers in one round-trip."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "sequence_name": {
                    "type": "string",
                    "description": "Name of the composition / sequence to create.",
                },
                "bin_name": {
                    "type": "string",
                    "description": "Target bin to create and hold all assets and the sequence (e.g. 'test').",
                },
                "aspect_ratio": {
                    "type": "string",
                    "enum": ["9:16", "16:9", "1:1", "4:5"],
                    "description": "Aspect ratio (default: '9:16').",
                },
                "voiceover_text": {
                    "type": "string",
                    "description": "Script text to synthesize via Cartesia Sonic 3.6 and place on Track A2.",
                },
                "voiceover_path": {
                    "type": "string",
                    "description": "Path to pre-existing voiceover file if not generating.",
                },
                "video_clips": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "media_path": {"type": "string"},
                            "start_time": {"type": "number"},
                            "duration": {"type": "number"},
                            "in_point": {"type": "number"},
                            "out_point": {"type": "number"},
                            "video_track_index": {"type": "integer"},
                            "audio_track_index": {"type": "integer"},
                            "scale": {"type": "number"},
                        },
                        "required": ["media_path", "start_time"],
                    },
                    "description": "List of video/image beat clips to place on the timeline.",
                },
                "audio_clips": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "media_path": {"type": "string"},
                            "start_time": {"type": "number"},
                            "duration": {"type": "number"},
                            "audio_track_index": {"type": "integer"},
                        },
                        "required": ["media_path", "start_time"],
                    },
                    "description": "Optional additional sound effects, nasheeds, or ambient audio clips.",
                },
                "markers": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "time": {"type": "number"},
                        },
                        "required": ["name", "time"],
                    },
                    "description": "Timeline chapter markers to add.",
                },
                "switch_view": {
                    "type": "string",
                    "enum": ["storyCut", "captions", "review", "chat"],
                    "description": "CEP panel view to switch to after building (default: 'storyCut').",
                },
            },
            "required": ["sequence_name", "bin_name", "video_clips"],
        },
    },
    {
        "name": "premiere_remove_timeline_ranges",
        "description": "Removes (ripple cuts) timeline ranges in seconds from the active sequence.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "ranges": {
                    "type": "array",
                    "items": {"type": "object"},
                    "description": "List of {start: float, end: float} time ranges.",
                },
                "preview_only": {
                    "type": "boolean",
                    "description": "If true, simulates cuts without modifying the timeline.",
                },
            },
            "required": ["ranges"],
        },
    },
    {
        "name": "premiere_add_markers",
        "description": "Adds sequence markers or YouTube chapter markers to the active sequence.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "markers": {
                    "type": "array",
                    "items": {"type": "object"},
                    "description": "List of marker objects ({name, time, comment, color}).",
                },
                "as_chapters": {
                    "type": "boolean",
                    "description": "If true, formats markers as YouTube chapter markers.",
                },
            },
            "required": ["markers"],
        },
    },
    {
        "name": "premiere_execute_edl",
        "description": "Executes one native EDL batch in Premiere Pro, enforcing camera audio links and transparent-card safe zones; stops on failure without transactional rollback.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "sequence_name": {"type": "string"},
                "operations": {"type": "array", "items": {"type": "object"}},
            },
            "required": ["operations"],
        },
    },
    {
        "name": "premiere_call_extendscript",
        "description": "Dispatches any ExtendScript command or module function directly inside Adobe Premiere Pro.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "ExtendScript command name."},
                "payload": {"type": "object", "description": "JSON payload."},
            },
            "required": ["command"],
        },
    },
]


# Supplemental optional fields shared by direct agent adapters.
for _tool in TOOLS:
    _props = _tool["inputSchema"]["properties"]
    if _tool["name"] == "premiere_build_custom_sequence":
        _props.update(project_folder={"type":"string","description":"Dated project; otherwise infer it from the saved Premiere project."},
                      fps={"type":"number","description":"Output frame rate; default 30."})
    if _tool["name"] == "premiere_add_clip_to_timeline":
        _props.update(fit_mode={"type":"string","enum":["fill","contain"]}, zoom={"type":"number","description":"Zoom relative to proportional fit; default 1."})


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
        return {
            "success": True,
            "controller_ready": bool(bridge.get("cep_panel_connected")),
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
        top_k = int(args.get("top_k") or 5)
        if query:
            # Pass cue=query to match-cut (NOT text=query which causes HTTP 422)
            params = urllib.parse.urlencode({"cue": query, "aspect_ratio": "9:16", "limit": top_k, "brand": brand})
            match_res = _http_request("GET", f"/api/visual-library/match-cut?{params}")
            items_res = _http_request("GET", "/api/visual-library/items?" + urllib.parse.urlencode({"query": query, "brand": brand, "limit": 25}))
            items = items_res.get("items", [])
            return {
                "success": True,
                "brand": brand,
                "query": query,
                "best_match_cut": match_res,
                "matching_items": items[:top_k],
                "total_matches": len(items),
            }
        else:
            return _http_request("GET", "/api/visual-library/items?" + urllib.parse.urlencode({"brand": brand, "limit": 25}))

    elif name == "editflow_generate_voiceover":
        text = (args.get("text") or "").strip()
        if not text:
            return {"success": False, "error": "No script text provided"}
        if not args.get("project_folder"):
            return {"success": False, "error": "project_folder is required so narration uses the correct brand and output folder."}
        context = _http_request("GET", "/api/script-assembly/project-context?" + urllib.parse.urlencode({"project_folder": args["project_folder"]}))
        if not context.get("success"):
            return context
        defaults = context.get("voice", {})
        speaker_id = args.get("speaker") or defaults.get("speaker")
        if not speaker_id:
            return {"success": False, "error": "Choose a Cartesia voice for this brand or set voice.speaker in its brand.editflow.json profile."}
        api_key = get_cartesia_api_key()
        if not api_key:
            return {"success": False, "error": "CARTESIA_API_KEY not found in environment or registry"}

        if not re.fullmatch(r"[0-9a-fA-F-]{36}", speaker_id):
            # Reuse the already-working dynamic voice controller for named voices.
            controller = Path(os.environ.get("EDITFLOW_CARTESIA_CONTROLLER", str(Path.home() / ".config/opencode/skills/cartesia-voice-workflow/scripts/voice_studio.py")))
            if not controller.is_file():
                return {"success": False, "error": "Use a voice UUID or configure EDITFLOW_CARTESIA_CONTROLLER for named voice resolution."}
            try:
                spec = importlib.util.spec_from_file_location("editflow_voice_controller", controller)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                env = module.load_env()
                env["CARTESIA_API_KEY"] = api_key
                speaker_id, _ = module.resolve_voice_id(env, speaker_id)
            except Exception as exc:
                return {"success": False, "error": f"Voice resolution failed: {exc}"}
            if not re.fullmatch(r"[0-9a-fA-F-]{36}", speaker_id):
                return {"success": False, "error": "The named voice did not resolve to a Cartesia voice UUID."}

        speed = float(args.get("speed") or defaults.get("speed") or 1.2)
        volume = float(args.get("volume") or defaults.get("volume") or 1.5)
        emotion = args.get("emotion") or defaults.get("emotion") or "content"
        dict_id = args.get("dict_id") or defaults.get("dict_id")
        model_id = defaults.get("model") or DEFAULT_CARTESIA_MODEL

        payload = {
            "model_id": model_id,
            "transcript": text,
            "voice": {"mode": "id", "id": speaker_id},
            "output_format": {
                "container": "wav",
                "encoding": "pcm_s16le",
                "sample_rate": 44100,
            },
            "generation_config": {
                "speed": speed,
                "volume": volume,
                "emotion": emotion,
            },
            "pronunciation_dict_id": dict_id,
        }
        if not dict_id:
            payload.pop("pronunciation_dict_id", None)

        req = urllib.request.Request(
            "https://api.cartesia.ai/tts/bytes",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Cartesia-Version": "2026-08-14",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        out_str = args.get("output_path")
        if not out_str:
            out_dir = Path(context["paths"]["voice"])
            out_dir.mkdir(parents=True, exist_ok=True)
            out_str = str(out_dir / f"voiceover_{int(time.time())}.wav")

        out_path = Path(out_str)
        if not out_path.resolve().is_relative_to(Path(context["project_folder"]).resolve()):
            return {"success": False, "error": "Save narration inside the selected project."}
        if out_path.exists():
            return {"success": False, "error": "This narration file already exists. Reuse it or choose a new filename."}
        out_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            with urllib.request.urlopen(req, timeout=60.0) as resp:
                raw_wav = resp.read()
                out_path.write_bytes(raw_wav)
        except urllib.error.HTTPError as e:
            err_b = e.read().decode("utf-8", errors="replace")
            return {"success": False, "status_code": e.code, "error": err_b}
        except Exception as e:
            return {"success": False, "error": str(e)}

        exact_dur = sanitize_wav_header(out_path)
        return {
            "success": True,
            "file_path": str(out_path),
            "duration_seconds": exact_dur,
            "speaker_id": speaker_id,
            "model": model_id,
        }

    elif name == "editflow_list_projects":
        query = urllib.parse.urlencode({"brand": args.get("brand", "")})
        return _http_request("GET", f"/api/script-assembly/projects?{query}")

    elif name == "editflow_project_context":
        query = urllib.parse.urlencode({"project_folder": args.get("project_folder", "")})
        return _http_request("GET", f"/api/script-assembly/authoring-context?{query}", timeout=120)

    elif name in ("editflow_script_catalog", "editflow_read_script_reference"):
        reference = name == "editflow_read_script_reference"
        query = urllib.parse.urlencode({"brand": args.get("brand", ""),
            **({"path": args.get("path", "")} if reference else {"query": args.get("query", "")})})
        endpoint = "script-reference" if reference else "script-catalog"
        return _http_request("GET", f"/api/script-assembly/{endpoint}?{query}")

    elif name == "editflow_list_project_scripts":
        query = urllib.parse.urlencode({"folder_path": args.get("project_folder", "")})
        return _http_request("GET", f"/api/script-assembly/scripts?{query}")

    elif name == "editflow_prepare_project_scripts":
        return _http_request("POST", "/api/script-assembly/scripts-folder",
                             body={"project_folder": args.get("project_folder", "")})

    elif name == "editflow_assemble_story_cut":
        if not args.get("project_folder") and not args.get("script_path"):
            return {"success": False, "error": "Select project_folder before compiling script text."}
        seq_name = args.get("sequence_name") or "EditFlow Story Cut"
        aspect = args.get("aspect_ratio") or "9:16"
        body = {"title": seq_name, "aspect_ratio": aspect}
        if args.get("script_path"):
            body["script_path"] = args["script_path"]
        else:
            body["script_content"] = args.get("script_text", "")
        if args.get("project_folder"):
            body["project_folder"] = args["project_folder"]
        if args.get("variant_id"):
            body["variant_id"] = args["variant_id"]
        compile_res = _http_request(
            "POST",
            "/api/script-assembly/compile",
            body=body,
            timeout=120.0,
        )
        if not compile_res.get("success"):
            return compile_res
        edl_ops = compile_res.get("edl_ops", [])
        if args.get("preview_only"):
            return {"success": True, "status": "compiled" if edl_ops else "needs_sources", "assembly": compile_res, "premiere_execution": None}
        if not edl_ops:
            return {"success": False, "error": "Resolve the plan's validation errors before assembly.", "assembly": compile_res}
        binding = _project_binding(args.get("project_folder") or compile_res.get("plan", {}).get("project_folder"))
        if not binding.get("success"):
            return binding
        for op in edl_ops:
            if op.get("action") == "create_sequence":
                op["name"] = seq_name
        premiere_exec = _call_premiere_rpc("processEDL", {"sequence_name": seq_name, "ops": edl_ops, "expected_project_path": binding["premiere_project_path"]}, queue_if_offline=False, timeout=120)
        inner = premiere_exec.get("result") or {}
        if isinstance(inner, str):
            try:
                inner = json.loads(inner)
            except (ValueError, TypeError):
                inner = {"success": False, "error": inner}
        completed = (bool(premiere_exec.get("success")) and not premiere_exec.get("queued")
                     and isinstance(inner, dict) and inner.get("success") is True
                     and not inner.get("failedCount"))
        return {
            "success": completed,
            "status": "completed" if completed else ("queued" if premiere_exec.get("queued") else "failed"),
            "compiled_beats": len(compile_res.get("plan", {}).get("cuts", [])),
            "assembly": compile_res,
            "premiere_execution": premiere_exec,
            "error": None if completed else (inner.get("error") if isinstance(inner, dict) else None) or premiere_exec.get("error") or "Premiere has not completed the edit.",
        }

    elif name == "premiere_scan_project":
        res = _call_premiere_rpc("scanProject", {})
        if args.get("compact", True) and res.get("success") and isinstance(res.get("result"), dict):
            r = res["result"]
            bins_list = [b.get("name") or b.get("path") for b in r.get("bins", []) if isinstance(b, dict)]
            seqs_list = [s.get("name") for s in r.get("sequences", []) if isinstance(s, dict)]
            return {
                "success": True,
                "project_name": r.get("name") or r.get("projectName"),
                "total_items": r.get("itemCount") or len(r.get("items", [])),
                "bins_count": len(bins_list),
                "bins": bins_list[:20],
                "sequences_count": len(seqs_list),
                "sequences": seqs_list,
            }
        return res

    elif name == "premiere_get_sequence_state":
        res = _call_premiere_rpc("getSequenceState", {})
        if args.get("compact", True) and res.get("success") and isinstance(res.get("result"), dict):
            r = res["result"]
            v_tracks = []
            for vt in r.get("videoTracks", []):
                clips = vt.get("clips", [])
                clip_summaries = [f"{c.get('name')} ({round(c.get('startTime',0),1)}s-{round(c.get('endTime',0),1)}s)" for c in clips]
                v_tracks.append({"track": vt.get("name", f"Video {vt.get('index',0)+1}"), "clips_count": len(clips), "clips": clip_summaries[:10]})
            a_tracks = []
            for at in r.get("audioTracks", []):
                clips = at.get("clips", [])
                clip_summaries = [f"{c.get('name')} ({round(c.get('startTime',0),1)}s-{round(c.get('endTime',0),1)}s)" for c in clips]
                a_tracks.append({"track": at.get("name", f"Audio {at.get('index',0)+1}"), "clips_count": len(clips), "clips": clip_summaries[:10]})
            return {
                "success": True,
                "sequence_name": r.get("name"),
                "id": r.get("id"),
                "dimensions": f"{r.get('width')}x{r.get('height')}",
                "fps": round(r.get("fps", 0), 2),
                "duration_seconds": round(r.get("duration", 0), 2),
                "video_tracks": v_tracks,
                "audio_tracks": a_tracks,
            }
        return res

    elif name == "premiere_create_bin":
        bin_name = args.get("bin_name", "EditFlow Output")
        parent_bin = args.get("parent_bin")
        payload = {"bin_name": bin_name}
        if parent_bin:
            payload["parent_bin"] = parent_bin
        return _call_premiere_rpc("createBin", payload)

    elif name == "premiere_create_sequence":
        name_seq = args.get("sequence_name") or args.get("name") or "EditFlow Story Cut"
        aspect = args.get("aspect_ratio") or "9:16"
        bin_name = args.get("bin_name") or args.get("bin")
        payload = {"name": name_seq, "aspect_ratio": aspect}
        if bin_name:
            payload["bin_name"] = bin_name
        create_res = _call_premiere_rpc("createSequence", payload)
        try:
            _call_premiere_rpc("openSequence", {"name": name_seq})
        except Exception:
            pass
        return create_res

    elif name == "premiere_open_sequence":
        name_seq = args.get("sequence_name") or args.get("name")
        seq_id = args.get("sequence_id") or args.get("id")
        return _call_premiere_rpc("openSequence", {"name": name_seq, "id": seq_id})

    elif name == "premiere_import_media":
        raw_paths = args.get("paths") or []
        bin_name = args.get("bin_name") or "EditFlow Imports"
        expanded_files: List[str] = []
        for p_str in raw_paths:
            p = Path(p_str)
            if p.is_dir():
                for child in sorted(p.rglob("*")):
                    if child.is_file() and child.suffix.lower() in ALL_MEDIA_EXTENSIONS:
                        if child.suffix.lower() == ".wav":
                            sanitize_wav_header(child)
                        expanded_files.append(str(child.resolve()))
            elif p.is_file():
                if p.suffix.lower() == ".wav":
                    sanitize_wav_header(p)
                expanded_files.append(str(p.resolve()))
            else:
                expanded_files.append(p_str)
        if not expanded_files:
            return {"success": False, "error": f"No media files found in paths: {raw_paths}"}
        return _call_premiere_rpc("importFiles", {"paths": expanded_files, "bin_name": bin_name})

    elif name == "premiere_add_clip_to_timeline":
        media_path = args.get("media_path")
        if media_path and str(media_path).lower().endswith(".wav"):
            sanitize_wav_header(media_path)
        payload = {
            "mediaPath": media_path,
            "startTime": float(args.get("start_time", 0.0)),
            "inPoint": float(args.get("in_point", 0.0)),
            "outPoint": float(args.get("out_point", 0.0)),
        }
        if "duration" in args and args["duration"] is not None:
            payload["duration"] = float(args["duration"])
        if "video_track_index" in args and args["video_track_index"] is not None:
            payload["video_track_index"] = int(args["video_track_index"])
        if "audio_track_index" in args and args["audio_track_index"] is not None:
            payload["audio_track_index"] = int(args["audio_track_index"])
        if "scale" in args and args["scale"] is not None:
            payload["scale"] = float(args["scale"])
        if "j_cut_frames" in args and args["j_cut_frames"] is not None:
            payload["j_cut_frames"] = int(args["j_cut_frames"])
        sequence = _rpc_value(_call_premiere_rpc("getSequenceState", {}, queue_if_offline=False))
        if not sequence.get("success"):
            return sequence
        payload["expected_sequence_id"] = sequence.get("id")
        if args.get("scale") is None and payload.get("video_track_index", 0) >= 0:
            path = Path(payload["mediaPath"])
            geometry = _http_request("POST", "/api/script-assembly/framing", body={"source_file":str(path),
                "width":sequence.get("width") or 1080, "height":sequence.get("height") or 1920,
                "fit_mode":args.get("fit_mode") or ("contain" if path.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp", ".tiff") else "fill"),
                "zoom":args.get("zoom") or 1})
            if not geometry.get("success"):
                return geometry
            payload.update(geometry.get("framing", {}))
        return _call_premiere_rpc("insertClipAtTime", payload, queue_if_offline=False)

    elif name == "premiere_build_custom_sequence":
        context = _project_binding(args.get("project_folder"))
        if not context.get("success"):
            return context
        seq_name = args.get("sequence_name") or "EditFlow Story Cut"
        bin_name = args.get("bin_name") or "EditFlow Output"
        aspect = args.get("aspect_ratio") or "9:16"
        width, height = {"9:16":(1080,1920), "16:9":(1920,1080), "1:1":(1080,1080), "4:5":(1080,1350)}[aspect]
        video_clips = list(args.get("video_clips") or [])
        audio_clips = list(args.get("audio_clips") or [])
        voice = None
        vo_path = args.get("voiceover_path")
        if args.get("voiceover_text") and not vo_path:
            voice = execute_tool("editflow_generate_voiceover", {"text":args["voiceover_text"], "project_folder":context["project_folder"],
                "speaker":args.get("speaker"), "output_path":str(Path(context["paths"]["voice"]) / f"{re.sub(r'[^a-zA-Z0-9_-]', '_', seq_name)}_VO.wav")})
            if not voice.get("success"):
                return voice
            vo_path = voice["file_path"]
        if vo_path:
            audio_clips.insert(0, {"media_path":vo_path, "start_time":0, "audio_track_index":1})
        clips = [(clip, False) for clip in video_clips] + [(clip, True) for clip in audio_clips]
        if not clips:
            return {"success":False, "error":"Provide linked media clips before building a sequence."}
        imports = []
        additions = []
        duration = 0.0
        for clip, audio_only in clips:
            path = Path(clip.get("media_path") or "")
            if not path.is_file() or not path.resolve().is_relative_to(Path(context["paths"]["brand_media"]).resolve()):
                return {"success":False, "error":f"Missing media or media outside the selected brand: {path}"}
            path = path.resolve()
            is_image = path.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp", ".tiff", ".bmp")
            geometry = _http_request("POST", "/api/script-assembly/framing", body={"source_file":str(path), "width":width, "height":height,
                "fit_mode":clip.get("fit_mode") or ("contain" if is_image else "fill"), "zoom":clip.get("zoom") or 1.0})
            if not geometry.get("success"):
                return geometry
            source_in = float(clip.get("in_point") or 0)
            source_out = float(clip.get("out_point") or 0)
            start_time = float(clip.get("start_time") or 0)
            source_duration = float(geometry.get("source", {}).get("duration") or 0)
            if source_out <= source_in:
                source_out = source_in + float(clip.get("duration") or (5 if is_image else source_duration - source_in))
            if not all(math.isfinite(v) for v in (start_time, source_in, source_out)) or start_time < 0 or source_in < 0 or source_out <= source_in or (not is_image and source_duration > 0 and source_out > source_duration + 0.04):
                return {"success":False, "error":f"Invalid timeline/source range for {path.name}."}
            if str(path) not in imports:
                imports.append(str(path))
            payload = {"action":"add", "mediaPath":str(path), "startTime":start_time, "inPoint":source_in, "outPoint":source_out,
                "video_track_index":-1 if audio_only else int(clip.get("video_track_index",0)),
                "audio_track_index":int(clip.get("audio_track_index",1 if audio_only else (-1 if is_image or int(clip.get("video_track_index",0)) > 0 else 0))),
                "preserve_linked_audio":True, **geometry.get("framing", {})}
            if clip.get("scale") is not None:
                payload.pop("fit_mode", None)
                payload.pop("fit_scale", None)
                payload["scale"] = float(clip["scale"])
            additions.append(payload)
            duration = max(duration, start_time + source_out - source_in)
        ops = [{"action":"ensure_bin", "bin_name":bin_name}]
        ops.extend({"action":"import_file", "mediaPath":path, "bin_name":bin_name} for path in imports)
        ops.append({"action":"create_sequence", "name":seq_name, "bin_name":bin_name,
                    "preset_from_clip_path":imports[0], "width":width, "height":height, "fps":float(args.get("fps") or 30)})
        ops.extend(additions)
        ops.extend({"action":"add_marker", "time":float(m.get("time") or 0), "name":m.get("name", "Beat"), "comments":m.get("comment", "")} for m in args.get("markers", []))
        execution = _call_premiere_rpc("processEDL", {"ops":ops, "expected_project_path":context["premiere_project_path"]}, queue_if_offline=False, timeout=120)
        result = _rpc_value(execution)
        success = result.get("success") is True and not result.get("failedCount")
        if success and args.get("switch_view", "storyCut"):
            _call_premiere_rpc("switch_view", {"view":args.get("switch_view", "storyCut")}, target="ui")
        return {"success":success, "sequence_name":seq_name, "bin":bin_name, "aspect_ratio":aspect,
                "video_clips_placed":len(video_clips) if success else 0, "voiceover":voice,
                "total_duration_seconds":round(duration,3), "premiere_execution":execution, "error":None if success else result.get("error")}

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
                    "version": "3.1.0",
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
            res = execute_tool(tool_name, tool_args)
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": json.dumps(res, ensure_ascii=False, indent=2)}],
                    "isError": not res.get("success", True),
                },
            }
        except Exception as e:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32603, "message": str(e)},
            }

    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


def main() -> None:
    """Stdio loop supporting both newline-delimited JSON-RPC and Content-Length framing."""
    use_content_length = False
    stdin_buf = sys.stdin.buffer

    while True:
        try:
            line_bytes = stdin_buf.readline()
            if not line_bytes:
                break

            line_str = line_bytes.decode("utf-8", errors="replace").strip()
            if not line_str:
                continue

            if line_str.lower().startswith("content-length:"):
                use_content_length = True
                try:
                    content_len = int(line_str.split(":", 1)[1].strip())
                except ValueError:
                    continue

                while True:
                    sep = stdin_buf.readline().strip()
                    if not sep:
                        break

                body_bytes = stdin_buf.read(content_len)
                if not body_bytes:
                    break
                req = json.loads(body_bytes.decode("utf-8", errors="replace"))
            else:
                req = json.loads(line_str)

            resp = _handle_rpc_request(req)
            if resp is not None:
                _send_message(resp, use_content_length=use_content_length)

        except (KeyboardInterrupt, SystemExit):
            break
        except Exception as e:
            err_msg = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": f"Parse error: {e}"},
            }
            _send_message(err_msg, use_content_length=use_content_length)


if __name__ == "__main__":
    main()
