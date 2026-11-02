# EditFlow agent workflow

The creative agent remains external: Codex, Antigravity, OpenCode, or another MCP/CLI
host. EditFlow resolves and validates media, transcribes when needed, previews plans,
and executes deterministic Premiere operations. There is no internal LLM requirement.

Assemble through one `processEDL` batch, never per-clip agent calls. Camera footage
on V1 retains linked native A1 audio and source handles; generated narration uses A2.
The batch policy accepts legacy `path`, `time`, `in_point`, `out_point`, and `bin_path`
fields, restores native camera audio, and interprets legacy scale=108 as a fitted
relative punch. Transparent overlay bounds are checked across their animation and
placed in Y1350–1720 at 1080×1920, scaled proportionally for other output sizes.
Alpha quantization noise below 1% opacity is excluded from the visible bounds.
These checks are cached by asset revision. Write standalone Python utility scripts;
reuse the existing OpenCode delegation workflow for graphics without duplicate jobs.

1. Run `.venv/Scripts/python.exe scripts/editflow_cli.py status`.
2. Select the actual brand and dated project with `projects --brand "..."` and
   `scripts --project "..." --prepare`. Source footage may remain shared at brand level.
3. Run `context --project "..."`. Read existing local instructions, transcript files,
   speaker cross references, shot logs and the current brief. This command returns
   file paths and verified visual metadata; it does not generate scripts or consume
   provider credits. MCP equivalent: `editflow_project_context`.
4. Write `<project>/Scripts/<campaign>.md`, including exact quotes and source ranges.
   Explicitly label generated narration, graphics and any footage still required.
5. Optionally write `<campaign>.editflow.json` beside the Markdown. The schema is
   [agent-script-package.schema.json](agent-script-package.schema.json). Every cut
   links a real file, its type, and exact source IN/OUT. Alternative versions have
   unique IDs including `primary`. `script_revision` is SHA-256 of the Markdown text
   decoded as UTF-8 and encoded back to UTF-8, with normal text newline normalization.
6. Compile with `compile-script --project "..." --script "..." --variant primary`.
   Review cuts, durations, missing assets, narration, graphics and proposed B-roll.
   The API returns the entire intended plan even when sources are missing, but returns
   no executable operations until blocking errors are resolved. A changed Markdown
   revision blocks an outdated execution sidecar. The panel rechecks revisions on apply.
7. Apply the reviewed plan. Rough cuts create a new sequence; timeline overlays
   duplicate the current sequence first. The open Premiere project must match the
   selected dated project. A failure stops later operations and labels a partial
   draft INCOMPLETE. Premiere does not expose a transaction/rollback API for this batch;
   the original sequence remains the reference, and multiple undo steps may be needed.

Recorded dialogue must not be paraphrased into a fake quote. Segment-only transcripts
do not establish word timing. Reuse the fingerprinted Whisper cache/registry where
word timing exists; request transcription/alignment only for sources that need it.
An ellipsis is not permission to invent sub-phrase timings. Preserve curated ranges.

Visual selection is brand-scoped. Verified descriptions override filename heuristics.
Frame samples/thumbnails are excluded. Talking heads, banned assets and unapproved
AI assets are excluded from automatic B-roll. Relevant distinct shots take priority;
leave the speaker visible when the relevant pool is empty. Do not depict snow,
elderly drop-offs or other factual events with unrelated footage. `fill` fits footage
proportionally; `contain` protects diagrams/text. `zoom` is relative to the fitted size;
optional `focal_point` uses normalized coordinates in the displayed frame.

Captions remain opt-in and share one preview/export renderer. English metrics do not
inherit Urdu fallback glyph height; Urdu text retains calligraphy clearance.

Provider defaults can live in `<brand>/AI Automation/brand.editflow.json` or
`<brand>/AI Workflow/brand.editflow.json`; `<project>/editflow.project.json` overrides
them. The optional `voice` object accepts `speaker`, `model`, `speed`, `volume`,
`emotion`, and `dict_id`. Credentials remain in the existing provider configuration.
MCP narration requires `project_folder` and saves inside the project's `Voice/Generated`.
A brand without a configured voice must name its voice explicitly. Named voices use
the existing `voice_studio.py` controller; `EDITFLOW_CARTESIA_CONTROLLER` can relocate it.
Magnific keeps its existing host OAuth flow. Set `MAGNIFIC_TOKEN_PATH` when relocating
its token file; it must never choose an arbitrary token belonging to another service.

Disconnected edits fail immediately. Read bridge status and the actual sequence after
a timeout before retrying. The RPC API accepts an optional `request_id` to deduplicate
retries and `target_client_id` when several CEP sessions are connected. A timeout is
an unknown outcome, not permission to replay a mutation automatically.
