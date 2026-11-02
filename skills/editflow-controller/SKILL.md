---
name: editflow-controller
description: Inspect and operate the existing EditFlow Premiere extension, create project-specific scripts and storyboards from existing transcripts, and compile reviewed cuts with exact media links. Use for EditFlow video production and troubleshooting across brands.
---

Use the existing backend, CEP bridge, Cartesia voice controller and Magnific plugin.
Never assemble a video by repeatedly calling insertClipAtTime or placing clips
one-by-one. Compile `/api/script-assembly/assemble` and send its operations to
`processEDL` in one batch. Single-clip tools are only for a requested individual fix.
Camera footage stays on V1 with linked native A1 audio and source handles; never
render it with `-an` or replace it with a monolithic audio stem. Dedicated generated
narration belongs on A2. Do not unlink camera audio for inferred J-cuts.
In 1080×1920 talking-head edits, exclude graphics from Y300–1350; all card/badge
content, including animation, belongs within Y1350–1720. Scale these coordinates
proportionally for other vertical resolutions. The MCP batch applies alpha-bound
safe-zone fitting to transparent overlays. Use fitted scale with relative zoom.
Write utilities/background tasks to standalone `.py` files before execution; avoid
PowerShell `python -c` and stdin Python snippets. Reuse the existing OpenCode
delegator for graphics when available; verify its model/output project and finished
files before claiming completion. Never launch duplicate rendering jobs.
Resolve the repository from `EDITFLOW_REPO_ROOT` or `D:/AI_VIDEO_AUTOMATION/EditFlowAI`.
Run its `scripts/editflow_cli.py` with the repository's `.venv/Scripts/python.exe`.

1. Run `status`, identify the open Premiere project, then `projects --brand "..."`.
2. Run `scripts --project "<dated project>" --prepare` and `context --project "<dated project>"`.
3. Read that brand's existing production rules, speaker cross references, transcripts,
   shot logs and brief. Reuse cached transcripts and verified assets before generating more.
4. Save readable Markdown in that project's returned Scripts folder. Keep project
   ownership separate from the brand's shared footage and transcript libraries.
5. Recorded dialogue must use exact quotations and source IN/OUT. Label generated
   narration explicitly. Never invent a word timestamp from a segment timestamp.
6. For reliable links, add a matching `<script>.editflow.json` using the schema in
   `docs/agent-script-package.schema.json` and the workflow in `docs/agent-workflow.md`.
   The sidecar must name the brand/project and SHA-256 of the current Markdown text.
7. Run `compile-script --project "..." --script "..." [--variant primary]`.
   Show the intended cuts/storyboard, missing assets, duration warnings and proposed visuals.
   Resolve blocking errors before applying. Do not substitute unrelated sources.
8. Build a new sequence after the user's review. Use the native bridge; do not add
   another editing server or an internal cloud/local LLM dependency. Overlay placement
   duplicates the source sequence. A failed partial assembly is marked INCOMPLETE.

Use proportional fill for footage, contain for text/diagrams, and verified focal
coordinates when available. Prefer relevant distinct shots; leave the speaker visible
when no relevant footage exists. Keep generated visual claims explicit. Captions are
opt-in; use the shared preview/export renderer. Narration belongs in the project's
Voice/Generated folder, with a voice selected explicitly or in its brand/project profile.

Disconnected mutations must fail immediately. Inspect the live sequence before retrying
a timed-out edit. A repeated request ID must not dispatch the edit twice.
