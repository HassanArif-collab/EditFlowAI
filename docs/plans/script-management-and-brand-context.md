# Script management and brand context

Created: 2026-11-02. User authorized implementation after saving this plan.
Companion: [preserved library plan](library-source-management-preserved.md).
This plan changes script organization and agent context, not the older library plan.

## Outcome in plain language

Select a brand and a production project. The agent receives that brand's rules,
the project's output folder, previous scripts and existing transcript/visual
references. It reads older scripts for inspiration and saves new scripts to the
selected project. The extension and agent read the same current script.

## What exists and what is missing

- Project-specific script listing, folder preparation, CLI/MCP authoring context,
  optional execution sidecars and revision checking already exist; reuse them.
- Existing shared scripts are organized by speaker/source groups rather than
  necessarily by production project. Do not infer ownership from that structure.
- Only Scripts 51 and 52 were individually copied to the 501(c)(3) project.
  Script 52 has a tracked compatibility alias; Script 51 was not registered.
- Jamia's instructions contain both current project-folder rules and older shared
  output conventions. A structured project context must supply one effective path.
- The user's reported 54 scripts need inventory, not an assumed file count:
  variants, indexes, copies and linked folders can produce different counts.

## 1. Storage: one home, many ways to find it

New work lives at `D:/MARKETING/<Brand>/<dated production project>/Scripts/`.
Existing project folders and names remain intact; speaker/concept subfolders work.
Markdown remains the editable source. Execution sidecars remain optional and must
match its revision. New scripts receive stable identities separate from filenames
and display numbers; numbering must not overwrite an existing script.

**All Scripts is a catalog, not a physical folder of copied scripts.** It lists
project scripts and explicitly registered previous-script folders. Each entry
shows its real location, current revision, brand and known project ownership.
Duplicate paths through junctions are deduplicated. Equal content alone does not
prove two independently created scripts are the same logical script.

## 2. Existing scripts: keep access before reorganizing

Initially leave existing shared scripts in place and register their folder as
**Previous Scripts** for the appropriate brand. Do not move all 54, rename them,
or assign them all to the 501(c)(3) project.

Known migrated copies must resolve to one canonical entry. Restore missing
compatibility registrations using migration records and a verified common
revision. Back up replaced text. If both copies changed differently, preserve
both and show a conflict; never select the newest timestamp as the winner.

Provide a later explicit **Assign / Move to project** workflow: preview the
destination and affected relative media links, confirm identity, move once,
update catalog/aliases and verify content. Leave uncertain scripts unassigned.
Keep migration mapping and backups. Do not turn reference-only browsing into
permission to edit, move or assemble an old script.

## 3. Reading old scripts and making something fresh

Agent context includes a searchable, brand-scoped previous-script catalog with
titles, paths, project labels and revisions. Retrieve summaries/search results
first, then read selected full scripts on demand to conserve credits.

Example: "For this Jamia project, read Script 52 and our previous donation
scripts. Use a similar style, avoid repeating hooks and create a fresh script
from the available raw transcripts."

Old scripts supply style, concepts and prior hooks; their quotes, factual claims
and timecodes are not automatically validated media evidence. Verify quotes and
source ranges against eligible original transcripts. Similarity warnings assist
review; do not promise semantic uniqueness from a keyword or hash check.
Cross-brand references require an explicit request and retain their brand labels.

## 4. Brand setup and the agent's starting context

Reuse existing brand profiles in `AI Workflow/brand.editflow.json` or
`AI Automation/brand.editflow.json`, with project overrides in
`editflow.project.json`. Do not add a competing configuration system.

A one-time brand setup registers:

- Existing instruction/identity documents and production standards.
- Previous-script roots, without relocating their files.
- References to existing transcript indexes, speaker references and visual logs.
- Existing provider defaults; credentials remain in provider configuration.

Do not silently scan unrelated brands, finals, or the whole brand tree for sources.
This task exposes configured source references; the older plan will supply the
full role-policy enforcement. Show this limitation until that plan is implemented.

The shared context response for panel, CLI and MCP includes brand/project identity,
current Scripts path, current-project scripts, previous-script references,
instruction/transcript/visual reference paths, effective defaults and missing setup.
File paths are accompanied by revisions where applicable. Merely opening context
does not transcribe, index visuals, generate voice or modify Premiere.

Conflicting old instructions are reported, with the structured selected-project
output path authoritative for new script creation. Agent-specific skills should
point to this shared context rather than each storing a different folder map.

## 5. Switching, resuming and creating projects

Switching to another brand loads that brand's setup and previous scripts. Remember
the last selected project per brand for convenience but display it clearly.
Do not silently select the newest dated folder or create a project from today's
date. Brand-only browsing is allowed; new script creation needs a chosen project.

When the user chooses a new production folder, prepare its Scripts folder there;
the previous project's Scripts folder remains in the previous project. Switching
does not move scripts, recreate old folders elsewhere or transfer ownership.
Returning to the previous project restores its selection and reads its current file.

Missing/renamed project or library folders show **Locate folder**, preserve their
identity and require an explicit path replacement. No guessed fallback directory.
Context changes invalidate pending script results so a slow agent/request cannot
save or display another project's work under the new selection.

## 6. Current text must be what the user reviews and assembles

Fix the immediate Script 51/52 stale-copy problem before expanding discovery.
Read through canonical resolution everywhere, show the actual editable path and
revision, refresh disk changes and ignore stale execution sidecars. A failed
refresh/conflict must be visible and block assembly of an obsolete reviewed plan.

Saving through an agent checks expected revision and project ownership. External
editor saves are detected by content revision, including atomic file replacement.
Reusing an old script in a different project creates an explicitly new project
version with parent identity; it never silently reassigns the original.

## 7. User-facing controls

- **This Project:** editable scripts that belong to the selected project.
- **Previous Scripts:** same-brand references from registered libraries/projects.
- **All Scripts:** searchable combined catalog, clearly labeled by project/legacy.
- **Open original**, **Use as reference**, **Create project version** and
  **Assign / Move to project** have distinct meanings.
- Setup shows selected brand/project, where new work saves and missing references.

Do not insert previous-script references into the current project's assembly
dropdown as if all of them belonged there. No automatic background processing.

## 8. Implementation order and completion checks

1. Save these two documents separately. Fix tracked migrated-copy coverage and
   verify current Script 51/52 content without generating narration or building.
2. Add a brand-scoped previous-script catalog and profile configuration; connect
   it to existing context, CLI and MCP. Test isolation, duplicate aliases and
   unassigned ownership, with no mass file migration.
3. Add setup/reference browsing to the panel and shared project-bound script
   creation/versioning. Make actual paths and stale/conflicting states visible.
4. Add explicit assignment/relocation preview and reconciled agent instructions.
5. Verify end to end: review old Jamia scripts, create a new Jamia project script,
   switch to RAF, return to Jamia, revise through original/canonical paths and
   confirm the same current content. Context access starts no paid or media jobs.

Complete only when those behaviors work across the panel, CLI and MCP. Record
finished steps and remaining work separately; never label a planned feature as
implemented. Leave the older source-library plan untouched throughout.
