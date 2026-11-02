# Visual library implementation progress

Updated: 2026-11-02. Companion:
[implementation phases](visual-library-implementation-phases.md).

## Phase 1 — Implemented in preview mode

- Added source, membership, media-path, exclusion and revision tables to the
  existing SQLite registry. Existing assets/transcripts and cached visual data
  remain separate and preserved.
- Implemented the common role resolver with explicit memberships, scoped project
  overrides, conflicts, physical path/alias handling, exclusions and subclip limits.
- Added file-revision guards, optimistic policy revision checks, and transactional
  policy snapshot/restore without deleting media or old cache data.
- Added read-only API and CLI migration previews. No activation UI or active
  project migration has been introduced. Current production consumers retain
  their existing behavior until the planned consumer integration is ready.

Verification: 16 new focused tests and 44 existing project/script checks passed
(60 total). Live preview endpoints matched the saved inputs for Jamia and RAF,
confirming that cache/config and reviewed script bytes were retained.

## Actual migration findings

- Jamia: two registered folders, 873 cached assets, one mixed-content folder.
- RAF: six registered folders, 126 cached assets, two mixed-content folders;
  all 113 existing verified annotations remain accounted for.
- Folder roles are suggestions only. Mixed folders remain unassigned.
- Script references to edited footage and unresolved legacy sources are listed
  for review rather than substituted or silently approved.
- Existing project voiceovers/cards remain project assets, outside raw dialogue.

Reports: `data/output/source-policy-phase1-jamia.json`,
`data/output/source-policy-phase1-raf.json`, and
`data/output/source-policy-phase1-live.json`.

The extra existing-work check found that Script 52's project and shared copies
had already been edited differently. Its existing reconciliation guard blocks
compilation and preserves both. Phase 1 did not edit those copies or resolve the
wording conflict. That check is recorded as blocked, not passed.

## Next

Phase 2: the folder/bin picker, fresh project-bound bin snapshots, complete item
enumeration, and exact original-file path registration. No Phase 2 work is marked
complete by this milestone. Migration review and active consumer integration
remain required before a live project adopts the new source policy.
