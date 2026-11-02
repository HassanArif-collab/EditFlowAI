# Previously agreed source-library plan

Recorded: 2026-11-02. Status: preserved decisions, not implementation authorization
for this task. This records the agreed decisions from the conversation rather
than claiming to reproduce its original wording. Existing roadmap documents are
unchanged. The separate script-management plan does not replace this plan.

## Library organization

- Brand-shared libraries with explicit project overrides.
- **Raw Dialogue:** original recordings and their Whisper transcripts, eligible
  for quoted dialogue with verified source timing.
- **Visuals:** footage described through Gemma vision indexing; do not transcribe
  visual-only folders as dialogue.
- **References:** edited/final videos, usable for reference only, never silently
  promoted into raw dialogue or automatic source footage.
- Generated project voiceovers and cards remain project assets, not raw sources.

## Folder controls and source policy

- Add, remove, disable and replace registered folders without deleting originals
  or existing caches.
- Enforce the same source-role policy in the panel, agent context, MCP, CLI,
  compiler and EDL execution. No fallback to crawling an entire brand.
- Record provenance and policy revisions; invalidate affected selections and plans
  when the effective policy changes.
- Replacing edited-video transcripts with raw transcripts requires the raw media's
  own timing. Never transfer edited-video timestamps onto raw recordings.

## Visual indexing and processing

- Reuse the existing provider service with explicit vision-model selection.
- Cache frame-window descriptions and preserve human-verified annotations.
- Separate transcription and visual-indexing jobs, with progress, cancellation,
  pause and resume. Run only one GPU-heavy job at a time.

## Migration and verification

- Preview classification and dependency changes before applying migration.
- Review existing scripts such as Script 52 that rely on edited/captioned sources;
  flag those dependencies and link appropriate raw sources before raw-only assembly.
- Do not guess uncertain folder ownership or source roles.
- Retain original files and reusable caches throughout migration.
- Verify that removed/disabled/reference-only folders cannot leak into agent
  authoring context or executable assembly, including through legacy paths.

Implementation belongs to a separate future task. Do not treat this preserved
record as permission to execute the older library plan during script-management work.

## Requested addition: Premiere bins and implementation phases

Added 2026-11-02 at the user's request. The preceding agreed decisions are retained.

Visual libraries must support **Add folder** and **Add Premiere bin**. A selected
bin supplies an explicit set of original media paths; it is not treated as a disk
folder. Register those paths in the same brand/project library, retain their bin
provenance, and reuse existing indexing/caches. Never include sibling files just
because they share a physical folder with a selected clip.

The implementation sequence and acceptance checks are recorded separately in
[Visual library implementation phases](visual-library-implementation-phases.md).
This amendment and its companion are planning changes; no source-library runtime
behavior is implemented by saving them.
