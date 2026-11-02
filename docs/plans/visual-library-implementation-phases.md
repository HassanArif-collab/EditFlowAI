# Visual library implementation phases

Date: 2026-11-02. Status: ready for implementation, no phases completed yet.
Base: [the agreed source-library plan](library-source-management-preserved.md).
This organizes that plan into phases and adds the requested Premiere-bin input.
It does not replace the source roles, raw-transcript requirements or existing
script-management work.

## User experience

Select the brand and production project. Choose **Add source → Folder** or
**Add source → Premiere bin**. For visuals, preview the included clips and their
real disk paths, then register the selection. **Index visuals** uses the selected
Gemma/vision provider to describe what appears on screen. **Transcribe dialogue**
is a separate action for raw speaking footage.

Example: select `Visuals / Construction` in Premiere. Its clips may live in
several disk folders. EditFlow registers exactly those files, including selected
sub-bins when enabled. The agent receives their approved paths and descriptions;
assembly uses those paths. No manual folder reorganization or duplicate import
is needed to register the library.

## Existing capabilities to reuse

- `project_scanner.jsx` already returns bins, each item's `binPath` and `mediaPath`,
  plus the Premiere project path. It does not currently expose stable item/bin
  identities, offline/proxy state or a complete source-selection contract.
- `/api/premiere/bins` and `/items` expose cached project context. The item route
  currently uses a string-prefix bin filter and defaults to 100 returned items.
  Registration must use a fresh, project-bound complete snapshot instead.
- The visual service already persists folders, media paths and curated metadata.
  Extend it with source membership rather than creating a second visual index.
- The existing provider service supports image analysis and explicit vision-model
  selection. Reuse it; do not add another internal agent or model server.
- Keep the existing MCP/CLI, project context, script compiler and one-batch native
  EDL assembly. Project-bin ingestion does not assemble or alter a timeline.

## Decisions applying to every phase

**Source type and source role are separate.** A source is a folder or a Premiere
bin. Its role is Raw Dialogue, Visuals or References. The bin feature initially
serves the requested visual workflow, using the common source-role model.

Registration specifies the brand and project/brand scope explicitly. A Premiere
bin defaults to the selected project; reusing its library across projects must
be explicit. Media can live outside the brand's disk folder when explicitly
registered for it; physical location alone never grants another brand access.

Store one media asset with multiple source memberships. Folder/bin overlap or
duplicate project items must not create repeated indexing or duplicate shots.
Retain distinct subclip ranges. Equal filenames do not establish asset identity.
Removing one membership preserves another approved membership. An explicit
project exclusion applies across all paths/memberships for that asset.

New and changed source selections carry a policy revision. Agent results and
reviewed assembly plans bind to that revision and media fingerprints. Changed
media at the same path must invalidate stale transcript/vision results too.

## Phase 1 — Register sources and enforce their roles

Deliver one source registry shared by the existing visual/transcript services.
Records include source ID/type, role, brand, scope/project, enabled state and
revision. Media records retain canonical paths, fingerprints and provenance;
memberships retain originating folder or Premiere project/bin/item information.

Implement one effective-source resolver for project overrides, exclusions and
role eligibility. References cannot supply raw dialogue or automatic visuals.
Overlapping contradictory classifications require review; importing the same
file through a bin must not bypass its restrictions. Source lookup must not
fall back to scanning the entire brand when a selection is empty.

Preview migration from existing folder configuration, preserving source files,
cached transcripts, descriptions and verified annotations. Record dependencies
on currently excluded edited/final footage before applying the new policy.

**Done when:** role filtering is deterministic; existing data can be previewed
and restored; exclusions cannot be bypassed through an alias or another source.
Do not mark the active project migrated until its effective source set is reviewed.

## Phase 2 — Add visuals from folders or Premiere bins

Keep the existing folder entry point and add **Premiere bin** alongside it.
Show the connected `.prproj` identity, a bin tree and an **Include sub-bins**
choice. Fetch the snapshot in a bounded batch, with complete enumeration rather
than one RPC per clip. Use pagination/chunking if needed without truncating lists.

Extend the scanner with host item/bin identifiers where supported, original
media paths, item kind, offline/proxy status and usable source ranges. Verify
available host capabilities during implementation. Retain project identity and
bin ancestry as provenance; bin names alone cannot identify a source.

Preview the exact files, duplicates, missing paths and skipped items. Register
only supported video/image media from the chosen bin and selected descendants.
Match ancestry by identifiers/path components: `Visuals` must not also select
`Visuals Old`. Never register an item's whole physical parent folder.

Use original/master paths for assembly. A proxy can be a recorded preview/indexing
derivative, never an untracked replacement for an unavailable original. Audio-only
items do not start transcription when registered as Visuals. Sequences, titles,
adjustment layers, dynamic-link items and unsupported image sequences are reported
as unsupported rather than assigned fake disk paths. Respect subclip IN/OUT;
if valid limits cannot be read, skip that subclip visibly instead of widening it.

Opening the source picker starts no indexing or transcription. A disconnected,
unsaved or changed Premiere project cannot silently reuse cached bins from another
project. Duplicate/renamed/moved bins must retain verified identity or show a
**Locate bin** action; never guess from the name.

**Done when:** one selected bin can register files from several disk folders;
1,000+ items are complete; same-name bins, nested bins, mixed media and offline
files behave correctly; folder registration continues working.

## Phase 3 — Separate dialogue transcription and visual indexing

Raw Dialogue uses existing Whisper transcription and timing caches. Visuals use
frame samples/windows and the explicitly configured Gemma/vision model; save
descriptions, useful ranges and provenance. Human-verified annotations remain
authoritative. References stay reference-only; generated VO/cards stay project
assets rather than joining the raw dialogue corpus.

Describe subjects/actions, shot type, orientation and useful time windows so the
matcher can choose varied shots. Flag visible baked-in captions/overlays for
review rather than assuming every video is clean footage. Validate structured
model output and keep uncertain descriptions explicit.

Reuse unchanged cached results across folder/bin memberships. Cache keys include
media fingerprint, frame window and relevant model/settings revisions. Model
availability errors are visible; never silently switch to an unrelated model.

Separate jobs expose queued/running/completed/failed status, progress, pause,
resume and cancel. Run one GPU-heavy job at a time and reuse the existing provider
service. Source disable/removal during a job prevents results from re-enabling
that source or leaking into the active catalog.

**Done when:** indexing a visual-only bin makes no Whisper calls; dialogue
transcription makes no vision calls; interrupted jobs resume cached work and
replaced media at an unchanged path is recognized as changed.

## Phase 4 — Manage and refresh the chosen library

Give folders and bins the same **Enable / Disable / Remove / Replace / Refresh**
controls. Removing a source disconnects membership; it does not delete media,
Premiere items or reusable caches. Show impact on pending scripts/plans before
applying a replacement or role change.

A bin registration keeps its last confirmed membership snapshot and timestamp.
**Refresh** compares a fresh scan with it and previews added, removed and relinked
items. Apply the membership change and source revision together. Bin changes do
not silently rewrite an already edited timeline. Lightweight host change signals
can mark a source as needing refresh; avoid repeatedly scanning the whole project.

When its originating Premiere project is closed, cached paths/descriptions remain
available to the agent with their last-refresh state. Do not pretend that cached
membership is live. Before assembly, validate current files, scope and source
revision; a confirmed snapshot can supply disk assets even when its original
source project is closed. Refreshing that bin requires the correct project.

Replacing final-video transcription with raw transcription uses the raw files'
own timing. Never reuse an edited video's source ranges on the raw recording.

**Done when:** disable/remove/replace works identically for folders and bins;
shared assets survive removal of one membership; changed selections invalidate
pending plans; missing sources have a clear recovery action.

## Phase 5 — Use the same library in agents and video assembly

Expose the effective source set through existing project context, MCP and CLI:
selected sources/roles, current revision, raw transcript references, visual
descriptions/windows, approved media paths and missing/stale source states.
Keep previous scripts as style references under the separate script plan.

Apply the same resolver to search, B-roll matching, script compilation,
apply-time validation and EDL execution. Legacy paths, filename matching,
curated metadata imports and existing `reuse_media_index` must not reintroduce
disabled, reference-only or other-brand assets.

Reuse current fit/contain/relative-zoom and safe-zone policies. Select relevant,
distinct shots from the approved visual windows, respecting recent usage and
keeping a talking head visible when suitable B-roll is unavailable. Preserve
exact source timing and native camera V1/A1 audio; generated narration uses A2.
Assemble with the existing single `processEDL` batch.

**Done when:** the agent can create a script from approved raw transcripts and
suggest bin-linked visuals by their actual paths; an outdated policy or media
revision blocks obsolete assembly; no UI/MCP/CLI/EDL route bypasses eligibility.

## Phase 6 — Migrate and verify Jamia and RAF

Preview the existing source registrations for each brand. Identify edited/final
videos separately, retain cached work and link approved raw dialogue and visual
sources. Scripts 51–54 require dependency review where they reference edited
footage. Script 52's supplied narration remains a project asset; do not regenerate it.

Verify folder-only, bin-only and mixed-source projects; brand/project switches;
bin rename/reparent and media relink; duplicate memberships; >100-item bins;
disabled/reference assets; exact raw timings; captions; framing; and shot variety.
Use existing cached annotations for initial checks. Do not start paid generation
or reprocess whole libraries merely to register sources.

**Done when:** real projects compile using only approved assets, the agent sees
the same effective library as the panel, and a reviewed preview/assembly confirms
correct paths, timing, framing and exclusions. Report missing raw media or content
as unresolved dependencies rather than silently substituting another clip.

## Delivery boundaries

Implement and verify one phase at a time. Phase 1 provides the shared policy;
Phase 2 delivers the requested bin-based path linking. Do not bundle unrelated
caption/editor redesign or script-storage changes into this work. Update a
separate progress record after each phase with checks, completed behavior and
remaining dependencies. The phases above are proposed work, not completed features.
Source restriction controls must not be presented as effective while any active
consumer still bypasses the resolver; keep unfinished integration in preview mode.
