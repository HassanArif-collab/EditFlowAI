"""Project paths and optional brand defaults, independent of the agent host."""
import json
from pathlib import Path
from .project_scripts import list_project_scripts


def project_context(project_folder: str) -> dict:
    info = list_project_scripts(project_folder)
    project = Path(info["project_folder"])
    root = Path(info["brand_root"] or project)
    voice = {}
    profile_paths = [root / workflow / "brand.editflow.json" for workflow in ("AI Workflow", "AI Automation")]
    profile_paths.append(project / "editflow.project.json")
    loaded = []
    for path in profile_paths:
        if path.is_file():
            data = json.loads(path.read_text(encoding="utf-8-sig"))
            if data.get("brand") and data["brand"].casefold() != info["brand"].casefold():
                raise ValueError(f"Brand profile mismatch: {path}")
            allowed = {"speaker", "model", "speed", "volume", "emotion", "dict_id"}
            voice.update({k:v for k,v in data.get("voice", {}).items() if k in allowed})
            loaded.append(str(path))
    from .script_catalog import list_script_catalog
    catalog = list_script_catalog(info['brand'], project_folder=str(project)) if info['brand'] else None
    return {**info, "profiles": loaded, "voice": voice, "captions_enabled": False,
            "script_library": catalog,
            "script_output_rule": "Save new scripts only in paths.scripts for this selected project. Previous scripts are references, not transcript evidence.",
            "paths": {"scripts": info["scripts_folder"], "voice": str(project / "Voice" / "Generated"),
                      "visuals": str(project / "Visuals"), "finals": str(project / "Finals"),
                      "brand_media": str(root)}}
