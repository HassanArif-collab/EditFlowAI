"""Update existing agent skills/CLI shims to use dated project script folders."""
from __future__ import annotations

from datetime import datetime
import json
from pathlib import Path
import re
import shutil

REPO = Path(__file__).resolve().parent.parent
START = "<!-- editflow-project-scripts:start -->"
END = "<!-- editflow-project-scripts:end -->"
BLOCK = f"""{START}
## Project-specific script location

Identify the active brand and the dated production project before writing scripts.
Save scripts in `<Brand>/<YYYY-M-D Project name>/Scripts/`, with optional speaker
or concept subfolders. Existing shared script libraries are legacy sources.
Source footage and transcripts can remain in the brand's shared libraries.

Use `editflow_list_projects(brand=...)` and
`editflow_list_project_scripts(project_folder=...)` to discover the correct
location. `editflow_prepare_project_scripts(project_folder=...)` creates its
Scripts folder. Save new Markdown in the returned `scripts_folder` and retain
the existing cut-list format. When revising an edit, update its project copy.
Choose ownership from the brief/deliverables, not file timestamps or recording dates.

The CLI fallback is `D:/AI_VIDEO_AUTOMATION/EditFlowAI/scripts/editflow_cli.py`:
`projects --brand ...`, `scripts --project ... --prepare`, and
`compile-script --project ... --script ...`. Compilation is a review step and does
not edit Premiere. Pass `project_folder` with `script_path` when assembling.
Details: `D:/AI_VIDEO_AUTOMATION/EditFlowAI/docs/project-scripts.md`.

## Agent production workflow

These production rules supersede older examples below: NEVER assemble videos
clip-by-clip. Compile `/api/script-assembly/assemble`, then dispatch one `processEDL`
batch. V1 camera footage retains linked native audio on A1 and source handles;
generated narration belongs on A2. Never use `-an`/a monolithic stem for camera
speech or unlink it for inferred J-cuts. Fit footage first; use relative zoom.
For 1080x1920 talking heads, exclude graphics from Y300-1350 and confine the entire
visible animated card/badge to Y1350-1720. The MCP batch validates alpha bounds.
Write standalone `.py` utilities before executing them; no inline `python -c` or
PowerShell-fed Python. Reuse the existing OpenCode graphics delegator when available;
check its intended model, actual output directory and completed artifacts first.
One native batch avoids per-clip round trips; timing varies and rollback is not atomic.

Use `context --project ...` (MCP: `editflow_project_context`) to inspect existing
media, transcripts, verified visuals and provider defaults before proposing changes.
Write scripts and storyboards externally. A matching `.editflow.json` can link
exact sources using `docs/agent-script-package.schema.json`; keep its Markdown
revision current. Compile, resolve missing/ambiguous sources, review, then build a
new sequence. Preserve source ranges; label generated narration. Never infer word
timings from segment-only transcripts or use unrelated shots to fill a visual quota.
Captions stay opt-in. Provider defaults can live in the brand workflow folder's
`brand.editflow.json`, with project overrides in `editflow.project.json`. Pass
`project_folder` to narration generation. Use the existing Cartesia and Magnific
controllers. Details: `D:/AI_VIDEO_AUTOMATION/EditFlowAI/docs/agent-workflow.md`.
{END}
"""


def insert_block(text: str) -> str:
    if START in text:
        return re.sub(re.escape(START) + r".*?" + re.escape(END), lambda _: BLOCK.rstrip(), text, flags=re.S)
    if text.startswith("---\n"):
        boundary = text.find("\n---", 4)
        if boundary != -1:
            end = text.find("\n", boundary + 4)
            end = len(text) if end == -1 else end + 1
            return text[:end] + "\n" + BLOCK + "\n" + text[end:].lstrip("\n")
    return BLOCK + "\n" + text


def install(user_dir: Path | None = None) -> dict:
    user = user_dir or Path.home()
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = REPO / "data/output/project-script-setup-backup" / stamp
    changed = []

    def write(path: Path, content: str, create: bool = False):
        if not path.exists() and not create:
            return
        before = path.read_text(encoding="utf-8-sig") if path.exists() else None
        if before == content:
            return
        try:
            relative = path.relative_to(user)
        except ValueError:
            relative = Path("brands") / path.drive.replace(":", "") / Path(*path.parts[1:])
        saved = backup / relative
        saved.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            shutil.copy2(path, saved)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        changed.append({"path": str(path), "backup": str(saved) if before is not None else None})

    skill_roots = [
        user / ".gemini/config/skills/brand-script-formulation",
        user / ".gemini/config/skills/editflow-controller",
        user / ".gemini/config/plugins/editflow/skills/editflow-controller",
        user / ".config/opencode/skills/brand-script-formulation",
        user / ".config/opencode/skills/editflow-controller",
    ]
    brands = Path("D:/MARKETING")
    for brand, workflow in [("Rahima Aziz Foundation", "AI Automation"), ("Jamia Masjid Chicago", "AI Workflow")]:
        root = brands / brand / workflow
        skill_roots.append(root / ".agents/skills/brand-script-formulation")
        instructions = root / "AGENTS.md"
        if instructions.exists():
            write(instructions, insert_block(instructions.read_text(encoding="utf-8-sig")))
    for root in skill_roots:
        skill = root / "SKILL.md"
        if skill.exists():
            text = insert_block(skill.read_text(encoding="utf-8-sig"))
            text = text.replace("Places the voiceover on Track A1", "Places generated voiceover on Track A2")
            text = text.replace("`0` for A1 dialogue/voiceover", "`0` for A1 linked camera dialogue, `1` for A2 generated voiceover")
            text = text.replace("with 108% punch-in scale", "with source-aware fit and optional relative zoom=1.08")
            write(skill, text)

    global_rules = user / ".config/opencode/AGENTS.md"
    if global_rules.exists():
        text = global_rules.read_text(encoding="utf-8-sig")
        text = text.replace("- Brand is **Rahima Aziz Foundation (RAF)** — never Jamia Masjid Chicago.",
                            "- Use the active project's brand. Read that brand's local context; never default another client's name.")
        text = text.replace("Every CTA names Rahima Aziz Foundation and a donation verb.",
                            "Every CTA names the active brand and its requested action.")
        text = text.replace("- Scripts → `Scripts_15_30_45\\`", "- Scripts → the dated project's `Scripts\\` folder")
        write(global_rules, insert_block(text))

    for root in skill_roots:
        cli = root / "scripts/editflow_cli.py"
        if cli.exists():
            wrapper = '''#!/usr/bin/env python3
"""Compatibility entry point for the maintained EditFlow repository CLI."""
import os
from pathlib import Path
import runpy

repo = Path(os.environ.get("EDITFLOW_REPO_ROOT", "D:/AI_VIDEO_AUTOMATION/EditFlowAI"))
runpy.run_path(str(repo / "scripts/editflow_cli.py"), run_name="__main__")
'''
            write(cli, wrapper)
        reference = root / "references/tools-and-api.md"
        if reference.exists():
            text = reference.read_text(encoding="utf-8-sig")
            text = text.replace('{"script_text": "..."}', '{"script_content": "...", "project_folder": "<dated project>"}')
            text = text.replace('{"sequence_name": "...", "aspect_ratio": "9:16", "beats": [...]}',
                                '{"script_path": "<project>/Scripts/Script.md", "project_folder": "<project>", "aspect_ratio": "9:16"}')
            write(reference, insert_block(text))
        rules = root / "references/agent-rules.md"
        if rules.exists():
            text = rules.read_text(encoding="utf-8-sig").replace("primary A-roll / spoken dialogue / voiceover", "primary A-roll with linked native camera dialogue")
            write(rules, insert_block(text))
    canonical = REPO / "skills/editflow-controller/SKILL.md"
    write(user / ".codex/skills/editflow-controller/SKILL.md", canonical.read_text(encoding="utf-8"), create=True)

    # Carry forward the existing RAF defaults only for RAF. Other brands require
    # their own explicit speaker selection instead of inheriting this identity.
    profile = brands / "Rahima Aziz Foundation/AI Automation/brand.editflow.json"
    if profile.parent.is_dir() and not profile.exists():
        import ast
        constants = {}
        for node in ast.parse((REPO / "backend/mcp_server.py").read_text(encoding="utf-8")).body:
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        constants[target.id] = node.value.value
        content = {"schema_version": 1, "brand": "Rahima Aziz Foundation", "voice": {
            "speaker": constants["DEFAULT_CARTESIA_SPEAKER_ID"], "dict_id": constants["DEFAULT_CARTESIA_DICT_ID"],
            "model": constants["DEFAULT_CARTESIA_MODEL"], "speed": 1.2, "volume": 1.5, "emotion": "content"}}
        write(profile, json.dumps(content, indent=2) + "\n", create=True)

    for toolkit in (user / ".gemini/config/plugins/magnific/skills/magnific-workflow/scripts/magnific_toolkit.py",
                    user / ".config/opencode/skills/magnific-workflow/scripts/magnific_toolkit.py"):
        if toolkit.exists():
            text = toolkit.read_text(encoding="utf-8-sig")
            if "import os\n" not in text:
                text = text.replace("import json\n", "import json\nimport os\n")
            text = re.sub(r'^TOKENS_PATH = Path\(r"[^\n]+"\)$',
                'TOKENS_PATH = Path(os.environ.get("MAGNIFIC_TOKEN_PATH", str(Path.home() / ".mcp-auth/mcp-remote-v1/d26f403b39e8b4247ae67c898076d604_tokens.json")))', text, flags=re.M)
            start = text.find("    if not TOKENS_PATH.exists():")
            end = text.find('    with open(target_path, "r", encoding="utf-8") as f:', start)
            if start >= 0 and end > start:
                text = text[:start] + '''    target_path = TOKENS_PATH
    if not target_path.is_file():
        raise RuntimeError("Magnific auth is not configured. Connect Magnific in the host or set MAGNIFIC_TOKEN_PATH to its token file.")

''' + text[end:]
            write(toolkit, text)
    return {"changed": changed, "backup_folder": str(backup)}


if __name__ == "__main__":
    print(json.dumps(install(), indent=2, ensure_ascii=False))
