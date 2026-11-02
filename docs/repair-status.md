# EditFlow repair status — 2026-11-02

The requested code repairs are implemented in the working tree. Existing project
scripts, media, provider controllers and production rules remain the starting point.

| Area | Implemented and checked |
|---|---|
| Script clipping | Exact curated source ranges; no arbitrary media fallback; missing/ambiguous sources block assembly; word-based subphrase edits require real word timestamps. |
| Project organization | Dated project Scripts folders, project selection, legacy compatibility junctions, separate shared brand media roots. |
| Multiple brands | Brand-scoped search, placement, indexing jobs and usage history; existing identified shared B-roll and selected-project visuals are reused without transcription. Other campaigns are excluded from this automatic reuse. |
| Visual relevance | Verified descriptions restored; preview images excluded; no unrelated fallback or repeated shots to meet density quotas; ownership words are excluded from imported visual tags. |
| Framing | Source dimensions, rotation and pixel aspect; proportional fill/contain; relative zoom and optional focal point; selected video ranges bounded to actual file duration. |
| Captions | English/Urdu text-aware font metrics; corrected symbols; consistent thumbnail scaling; shared preview/export renderer retained. |
| Agent workflow | Shared project context, readable Markdown plus optional revision-bound execution JSON, MCP/CLI compatibility, existing Cartesia named-voice resolver, project output paths and brand voice profiles. |
| Application reliability | No offline mutation replay; one CEP target; request deduplication; project/sequence checks; new/duplicated review sequences; stop at first failure; partial drafts labelled INCOMPLETE. |
| Stale reviews | Apply-time checks for changed scripts/sidecars/source files, missing media and invalid ranges; double-click assembly guard. |

Verification: 332 backend checks and 184 JavaScript checks pass. Live Premiere Pro
25.1 tests created a separate 1080×1920 draft at 24000/1001 fps, placed two timed
clips at 50% fitted scale and 54% punch-in, and successfully cloned/overlaid a QA
sequence without adding B-roll audio. The user's V1 sequence was compared before
and after and was unchanged. Caption preset previews were visually inspected.
QA sequences are named `_EditFlow QA ...`; the user's V1 was restored afterward.

The subsequent editorial-policy test used one real MCP batch and completed in
2.12 seconds: camera V1/A1, narration A2, and a transparent card V2. All six existing
Script 14 cards were checked for alpha and animated visible bounds; their placements
fit the lower safe zone. Existing helper aliases and controller rules were aligned.

Script freshness repair: the newer legacy Script 52 and older project copy are now
registered as tracked compatibility aliases, with backups and conflict detection.
Current Markdown takes precedence over stale execution JSON. Script assembly and
timeline analysis have separate plan origins; switching invalidates pending work.
Assembly cannot implicitly start transcription. A visible script is checked for
disk edits every three seconds and on focus, with an explicit Refresh script action.
The current 26-second/five-beat Script 52 was verified in the live panel. Its newly
referenced narration file is absent; older narration is not reused for different words.

Live brand checks returned Jamia and RAF assets without cross-brand results.
RAF Script 03 compiled to 15 seconds and passed apply-time validation.

Content requirements remain explicit: a script naming a missing end-card or a
placeholder narration WAV needs that asset generated or linked before assembly.
For example, the earlier RAF Script 04 end-card and Script 14 narration placeholders
must not be replaced by guessed files. Paid Cartesia/Magnific generation was not
run during repair; adapters were tested without consuming generation credits.
Complete creative review and final video export remain project-specific steps.

See [agent-workflow.md](agent-workflow.md) for the shared agent contract and
[project-scripts.md](project-scripts.md) for script locations and migration details.
Runtime verification output is under `data/output/`; test logs are under `data/logs/`.
