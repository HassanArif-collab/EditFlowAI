# Script-management implementation progress

Updated: 2026-11-02. Implements the first stages of
[the new script plan](script-management-and-brand-context.md).
The [preserved source-library plan](library-source-management-preserved.md)
remains separate and unimplemented by this task.

## Subsequent user-requested corrections

- Both supplied Script 52 WAVs are linked in the current Markdown and refreshed
  execution package, with backups of the former script/package. Their recorded
  wording is represented accurately. Existing talking-head ranges are preserved.
  Full recordings measure 7.04s and 12.64s; the complete plan is 41.33s after
  frame rounding (41.34s in the readable brief). No new audio was generated.
- Scripts 53/54 were in the shared `Mixed with Old Data` folder. They now have
  explicit membership in the 501(c)(3) project's profile and appear alongside
  Scripts 51/52, without creating duplicate editable files or moving originals.
- Empty projects are hidden by default, with **Show empty** available. The live
  Jamia picker shows nine projects with scripts rather than all 71 dated folders.
- Script membership refreshes automatically; listing scripts no longer prepares
  or rescans the media resolver.
- Latest checks: 44 focused Python tests and 25 JavaScript tests passed. The
  activated panel build `20261102-script-projects-2` was verified with all four
  project scripts, both linked A2 voiceovers and no compile errors or warnings.
  The live check started no transcription or timeline edits. Latest evidence is
  `data/output/script-library-live.json`.

The sections below record the preceding milestone. The former missing-narration
note at the bottom is superseded by the supplied-recordings correction above.

## Implemented and activated

- Brand-scoped script catalog across existing dated projects and explicitly
  registered previous-script roots. No bulk moves or script copies.
- Same-brand full-text search and on-demand reading through API, CLI and MCP.
- Project context includes previous-script references, configured instruction
  files, current-project scripts and an explicit new-script destination rule.
- Story Cut **All Scripts** reference browser shows project/unassigned labels,
  original paths, current revision and readable text. It cannot assemble a
  reference as if it belonged to the active project.
- Actual selected script path/revision visible in Story Cut.
- Reference selection and catalog responses guarded against out-of-order results
  and project/brand changes. Project changes clear reference state.
- Brand switches restore a remembered valid project; no silent newest-project
  selection when a brand has no remembered project.
- Jamia and RAF existing brand profiles and AGENTS instructions configured with
  backups in `data/output/script-library-setup-backups/`. Conflicting old script
  output convention corrected; other production instructions retained.
- Script 51's previously untracked copied original/project pair registered from
  verified equal content. Script 52 retains its existing registration. Both use
  content-based synchronization, backups and conflict preservation.
- Catalog entries reconcile tracked copies and surface divergent-copy conflicts.
  Unrelated equal-content scripts are not automatically merged.

## Verification

41 focused Python checks and 23 JavaScript checks pass. Checks include brand
isolation, forbidden cross-brand reference paths, atomic external-editor saves,
current catalog text, divergent-copy preservation, stale reference responses,
project-bound output context and no implicit transcription/assembly.

Live Premiere panel build: `20261102-script-library-1`.
Live catalog contained 92 Jamia entries (54 legacy/unassigned, plus project
history) and 15 RAF entries. These are catalog entries, not an assumption that
every file is an independently numbered script or belongs to one project.

Script 54 was opened from its original shared folder through the new browser;
the assembly selection remained the project copy of Script 52. Current API text
for both Scripts 51/52 matched their original and canonical files. The selected
Script 52 revision matched its current 26-second Markdown in the live panel.
No transcription/extract-audio requests were started by live verification.
No timeline edits, paid generation or bulk script migration were performed.
Evidence: `data/output/script-library-live.json`.

## Remaining in the new plan

- Stable script identity independent of paths, and protected project-bound
  creation/save with expected-revision checks.
- **Create project version** with explicit parent-script lineage.
- **Assign / Move to project** preview, relative-media-link dependency review,
  relocation mapping and missing-folder recovery.
- In-panel brand reference setup/editing (the current setup utility supports any
  brand; project selection and reference browsing are already in the panel).
- Full create/switch/resume/relocate end-to-end verification across agent hosts.

Existing Script 52 still requires its current-wording narration file. Reference
catalog access does not generate audio or validate old-script source provenance.
The older library plan remains responsible for raw/visual/reference source policy.
