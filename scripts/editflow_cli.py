#!/usr/bin/env python3
"""EditFlow AI & Adobe Premiere Pro Direct Controller CLI.

Provides a fast, zero-dependency command-line interface for AI agents to control
EditFlow AI ("Maded Flow") and Adobe Premiere Pro directly when MCP tools are
unavailable or when scripting batch workflows.

Automatically signs in with the master session header and auto-starts the backend
if it is offline.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.mcp_server import (  # noqa: E402
    _http_request,
    ensure_backend_online,
    execute_tool,
)


def _print_json(data: object) -> None:
    out = json.dumps(data, indent=2, ensure_ascii=False)
    sys.stdout.buffer.write((out + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()


def cmd_status(_args: argparse.Namespace) -> None:
    _print_json(execute_tool("editflow_connect_and_status", {}))


def cmd_brands(_args: argparse.Namespace) -> None:
    _print_json(execute_tool("editflow_list_brands", {}))


def cmd_projects(args: argparse.Namespace) -> None:
    _print_json(execute_tool("editflow_list_projects", {"brand": args.brand}))


def cmd_scripts(args: argparse.Namespace) -> None:
    tool = "editflow_prepare_project_scripts" if args.prepare else "editflow_list_project_scripts"
    _print_json(execute_tool(tool, {"project_folder": args.project}))


def cmd_compile_script(args: argparse.Namespace) -> None:
    _print_json(execute_tool("editflow_assemble_story_cut", {
        "project_folder": args.project,
        "script_path": args.script,
        "aspect_ratio": args.aspect,
        "preview_only": True,
        "variant_id": args.variant,
    }))


def cmd_context(args: argparse.Namespace) -> None:
    ensure_backend_online()
    _print_json(_http_request("GET", "/api/script-assembly/authoring-context?" + urllib.parse.urlencode({"project_folder": args.project}), timeout=120))


def cmd_script_catalog(args: argparse.Namespace) -> None:
    _print_json(execute_tool('editflow_script_catalog', {'brand': args.brand, 'query': args.query}))


def cmd_script_reference(args: argparse.Namespace) -> None:
    _print_json(execute_tool('editflow_read_script_reference', {'brand': args.brand, 'path': args.path}))


def cmd_folders(args: argparse.Namespace) -> None:
    _print_json(execute_tool("editflow_list_brand_folders", {"brand": args.brand}))


def cmd_add_folder(args: argparse.Namespace) -> None:
    _print_json(
        execute_tool(
            "editflow_add_brand_folder",
            {
                "brand": args.brand,
                "folder_path": args.path,
                "auto_index": bool(args.auto_index),
            },
        )
    )


def cmd_index(args: argparse.Namespace) -> None:
    _print_json(
        execute_tool(
            "editflow_transcribe_and_index_brand",
            {"brand": args.brand, "folder_path": args.folder},
        )
    )


def cmd_search_visuals(args: argparse.Namespace) -> None:
    _print_json(
        execute_tool(
            "editflow_search_visuals",
            {
                "query": args.query,
                "brand": args.brand,
                "top_k": args.top_k,
                "visual_role": args.role,
            },
        )
    )


def cmd_voiceover(args: argparse.Namespace) -> None:
    _print_json(
        execute_tool(
            "editflow_generate_voiceover",
            {
                "text": args.text,
                "project_folder": args.project,
                "output_path": args.out,
                "speaker": args.speaker,
                "speed": args.speed,
                "volume": args.volume,
                "emotion": args.emotion,
            },
        )
    )


def cmd_scan_project(args: argparse.Namespace) -> None:
    _print_json(execute_tool("premiere_scan_project", {"compact": not args.full}))


def cmd_sequence_info(args: argparse.Namespace) -> None:
    _print_json(execute_tool("premiere_get_sequence_state", {"compact": not args.full}))


def cmd_create_bin(args: argparse.Namespace) -> None:
    _print_json(
        execute_tool(
            "premiere_create_bin",
            {"bin_name": args.name, "parent_bin": args.parent},
        )
    )


def cmd_create_sequence(args: argparse.Namespace) -> None:
    _print_json(
        execute_tool(
            "premiere_create_sequence",
            {"sequence_name": args.name, "aspect_ratio": args.aspect, "bin_name": args.bin},
        )
    )


def cmd_open_sequence(args: argparse.Namespace) -> None:
    _print_json(
        execute_tool(
            "premiere_open_sequence",
            {"sequence_name": args.name, "sequence_id": args.id},
        )
    )


def cmd_import_media(args: argparse.Namespace) -> None:
    _print_json(
        execute_tool(
            "premiere_import_media",
            {"paths": args.paths, "bin_name": args.bin},
        )
    )


def cmd_place_clip(args: argparse.Namespace) -> None:
    clip_spec: dict[str, object] = {
        "media_path": args.media,
        "start_time": args.start_time,
        "video_track_index": args.track,
        "audio_track_index": args.audio_track,
        "scale": args.scale,
    }
    if args.duration is not None:
        clip_spec["duration"] = args.duration
    if args.in_point is not None:
        clip_spec["in_point"] = args.in_point
    if args.out_point is not None:
        clip_spec["out_point"] = args.out_point
    _print_json(execute_tool("premiere_add_clip_to_timeline", clip_spec))


def cmd_build_sequence(args: argparse.Namespace) -> None:
    with open(args.spec_json, "r", encoding="utf-8") as f:
        spec = json.load(f)
    _print_json(execute_tool("premiere_build_custom_sequence", spec))


def cmd_switch_view(args: argparse.Namespace) -> None:
    _print_json(execute_tool("editflow_switch_view", {"view": args.view}))


def cmd_reload_panel(_args: argparse.Namespace) -> None:
    ensure_backend_online()
    _print_json(_http_request("POST", "/api/premiere/reload-panel", body={}))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="editflow_cli.py",
        description="EditFlow AI ('Maded Flow') & Adobe Premiere Pro Agent Controller CLI",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    context = sub.add_parser("context", help="Export the selected project's existing media, transcripts and verified visual metadata")
    context.add_argument("--project", required=True)
    context.set_defaults(func=cmd_context)

    catalog = sub.add_parser('script-catalog', help='Search a brand\'s project and previous scripts without copying them')
    catalog.add_argument('--brand', required=True)
    catalog.add_argument('--query', default='')
    catalog.set_defaults(func=cmd_script_catalog)
    reference = sub.add_parser('read-script-reference', help='Read a previous script for reference, without assembling it')
    reference.add_argument('--brand', required=True)
    reference.add_argument('--path', required=True)
    reference.set_defaults(func=cmd_script_reference)

    p_status = sub.add_parser("status", help="Auto-sign-in and check backend + Premiere bridge health")
    p_status.set_defaults(func=cmd_status)

    p_brands = sub.add_parser("brands", help="List all registered brands in the Visual Library")
    p_brands.set_defaults(func=cmd_brands)

    p_projects = sub.add_parser("projects", help="List dated projects and their script folders for one brand")
    p_projects.add_argument("--brand", required=True)
    p_projects.set_defaults(func=cmd_projects)

    p_scripts = sub.add_parser("scripts", help="List only the selected project's scripts")
    p_scripts.add_argument("--project", required=True, help="Dated project folder, or its Premiere Finals folder")
    p_scripts.add_argument("--prepare", action="store_true", help="Create the project's Scripts folder if needed")
    p_scripts.set_defaults(func=cmd_scripts)

    p_compile = sub.add_parser("compile-script", help="Compile a project script for review without editing Premiere")
    p_compile.add_argument("--project", required=True)
    p_compile.add_argument("--script", required=True)
    p_compile.add_argument("--aspect", choices=["9:16", "16:9", "1:1", "4:5"], default="9:16")
    p_compile.add_argument("--variant", default="primary")
    p_compile.set_defaults(func=cmd_compile_script)

    p_folders = sub.add_parser("folders", help="List registered visual folders for a brand")
    p_folders.add_argument("--brand", default="default", help="Brand name")
    p_folders.set_defaults(func=cmd_folders)

    p_add = sub.add_parser("add-folder", help="Add a visual folder to a brand")
    p_add.add_argument("--brand", required=True, help="Brand name")
    p_add.add_argument("--path", required=True, help="Absolute folder path containing videos")
    p_add.add_argument("--auto-index", action="store_true", help="Immediately transcribe & index after adding")
    p_add.set_defaults(func=cmd_add_folder)

    p_idx = sub.add_parser("index", help="Transcribe and index all videos for a brand")
    p_idx.add_argument("--brand", required=True, help="Brand name")
    p_idx.add_argument("--folder", default=None, help="Optional single folder path")
    p_idx.set_defaults(func=cmd_index)

    p_search = sub.add_parser("search-visuals", help="Semantic B-roll & visual search")
    p_search.add_argument("--query", required=True, help="Visual or spoken query")
    p_search.add_argument("--brand", default=None, help="Optional brand filter")
    p_search.add_argument("--role", default=None, help="Optional visual role tag")
    p_search.add_argument("--top-k", type=int, default=5, help="Max results")
    p_search.set_defaults(func=cmd_search_visuals)

    p_vo = sub.add_parser("generate-voiceover", help="Generate Cartesia voiceover with exact WAV duration")
    p_vo.add_argument("--text", required=True, help="Script text")
    p_vo.add_argument("--project", required=True, help="Dated production project")
    p_vo.add_argument("--out", default=None, help="Target WAV output path")
    p_vo.add_argument("--speaker", default=None, help="Speaker name or ID; otherwise use the brand/project profile")
    p_vo.add_argument("--speed", type=float, default=1.2, help="Speed")
    p_vo.add_argument("--volume", type=float, default=1.5, help="Volume")
    p_vo.add_argument("--emotion", default="content", help="Emotion")
    p_vo.set_defaults(func=cmd_voiceover)

    p_scan = sub.add_parser("scan-project", help="Scan live Premiere Pro project bins and items")
    p_scan.add_argument("--full", action="store_true", help="Output full uncompacted details")
    p_scan.set_defaults(func=cmd_scan_project)

    p_seq = sub.add_parser("sequence-info", help="Get active Premiere Pro sequence state and playhead")
    p_seq.add_argument("--full", action="store_true", help="Output full uncompacted details")
    p_seq.set_defaults(func=cmd_sequence_info)

    p_bin = sub.add_parser("create-bin", help="Create a folder/bin (supports nested paths) in Premiere Pro")
    p_bin.add_argument("--name", required=True, help="Bin name or nested path (e.g. 'Brands/RAF/B-Roll')")
    p_bin.add_argument("--parent", default=None, help="Optional parent bin path")
    p_bin.set_defaults(func=cmd_create_bin)

    p_cr_seq = sub.add_parser("create-sequence", help="Create and focus a new sequence inside a target bin")
    p_cr_seq.add_argument("--name", required=True, help="Sequence name")
    p_cr_seq.add_argument("--aspect", choices=["9:16", "16:9", "1:1", "4:5"], default="9:16", help="Aspect ratio")
    p_cr_seq.add_argument("--bin", default=None, help="Bin to place sequence into (e.g. 'test')")
    p_cr_seq.set_defaults(func=cmd_create_sequence)

    p_op_seq = sub.add_parser("open-sequence", help="Open and focus an existing sequence in Timeline panel")
    p_op_seq.add_argument("--name", default=None, help="Sequence name or substring")
    p_op_seq.add_argument("--id", default=None, help="Sequence GUID")
    p_op_seq.set_defaults(func=cmd_open_sequence)

    p_imp = sub.add_parser("import-media", help="Import files from disk into a Premiere Pro bin")
    p_imp.add_argument("--bin", default="EditFlow Imports", help="Target bin name or nested path")
    p_imp.add_argument("--paths", nargs="+", required=True, help="One or more absolute file paths")
    p_imp.set_defaults(func=cmd_import_media)

    p_place = sub.add_parser("place-clip", help="Place a video/image/audio clip onto the Premiere Pro timeline")
    p_place.add_argument("--media", required=True, help="Absolute path to media file")
    p_place.add_argument("--start-time", type=float, required=True, help="Timeline start time in seconds")
    p_place.add_argument("--duration", type=float, default=None, help="Clip duration on timeline in seconds")
    p_place.add_argument("--in-point", type=float, default=0.0, help="Source in-point in seconds")
    p_place.add_argument("--out-point", type=float, default=0.0, help="Source out-point in seconds")
    p_place.add_argument("--track", type=int, default=0, help="0-based video track index (0 = V1, 1 = V2)")
    p_place.add_argument("--audio-track", type=int, default=-1, help="0-based audio track index (-1 = none, 0 = A1)")
    p_place.add_argument("--scale", type=float, default=None, help="Explicit legacy scale percentage; by default fit the source proportionally")
    p_place.set_defaults(func=cmd_place_clip)

    p_build = sub.add_parser("build-sequence", help="1-call atomic composition builder from a JSON spec file")
    p_build.add_argument("--spec-json", required=True, help="Path to JSON spec file")
    p_build.set_defaults(func=cmd_build_sequence)

    p_view = sub.add_parser("switch-view", help="Switch active tab inside the Premiere Pro EditFlow panel")
    p_view.add_argument("--view", choices=["chat", "captions", "storyCut", "broll", "review"], required=True)
    p_view.set_defaults(func=cmd_switch_view)

    p_reload = sub.add_parser("reload-panel", help="Hot-reload the CEP panel UI inside Premiere Pro")
    p_reload.set_defaults(func=cmd_reload_panel)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
