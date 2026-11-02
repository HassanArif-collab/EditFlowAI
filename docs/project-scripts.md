# Scripts belong to their dated project

Use the brand's existing dated production folders:

```text
D:/MARKETING/<Brand>/<YYYY-M-D Project name>/
  Scripts/
    Script 01 - Descriptive title.md
    Script 02 - Another concept.md
  Visuals/
  Voiceovers/
  Finals/
```

Speaker or concept subfolders inside `Scripts/` are supported. Existing names and
dates do not need renaming. The script's production project is separate from its
source footage: a dated edit can use the brand's shared footage and transcripts.

In Story Cut, choose **Brand**, then **Project**. The script dropdown contains
only that project's scripts. A project without scripts stays empty; discovery
never climbs into another campaign. A Premiere project saved under `Finals/`
still selects its enclosing dated project. The settings drawer shows a copyable
Scripts folder path. Script selection and pasted drafts are remembered separately
for each project.

For external agents, use the existing controller:

```powershell
.venv/Scripts/python.exe scripts/editflow_cli.py projects --brand "Brand name"
.venv/Scripts/python.exe scripts/editflow_cli.py scripts --project "D:/MARKETING/Brand/2026-10-30 Campaign" --prepare
.venv/Scripts/python.exe scripts/editflow_cli.py compile-script --project "D:/MARKETING/Brand/2026-10-30 Campaign" --script "D:/MARKETING/Brand/2026-10-30 Campaign/Scripts/Script 01.md"
```

Equivalent MCP tools are `editflow_list_projects`, `editflow_list_project_scripts`,
and `editflow_prepare_project_scripts`. `editflow_assemble_story_cut` accepts
`project_folder`, `script_path`, and `preview_only: true` for compilation without
timeline changes. Continue using the existing Markdown cut-list format.

Save new scripts in the returned `scripts_folder`. Keep brand context documents,
transcripts, provider settings, and reusable assets in their existing libraries.
Choose the production project from the brief and existing deliverables, not just
the recording date. When reusing an old script for a new edit, copy it into the new
project and revise that copy.

Legacy script folders remain readable when explicitly selected. Known folder
migrations retain Windows junctions at the old locations so older automation
paths continue to work. Individual scripts copied from a shared campaign retain
their original as a tracked compatibility alias when its common revision is
verified. Single-sided edits are synchronized with backups; divergent edits are
blocked and preserved. The project file remains the canonical home.

## Previous scripts without moving files

Existing legacy originals can be explicitly assigned using the project's
`editflow.project.json` field `linked_scripts`. These files appear in that
project's script selector and compile under its project context, while remaining
at their original location. Use `scripts/link_existing_project_scripts.py
--project ... --script ...` to preview; add `--apply` to assign. It rejects
cross-brand files and scripts already owned by another project. New work still
saves in the project's Scripts folder. This does not perform a physical move.

The project picker hides empty projects by default. **Show empty** reveals them
for new work; an explicitly selected empty project remains accessible. The active
project's script list refreshes without restarting or indexing media.

Story Cut's **All Scripts** button reads a same-brand catalog. It does not add
legacy references to the project's assembly dropdown or create duplicate files.
Search includes existing script text. Select a result to read its current original
text, actual path and revision. Project ownership and unassigned legacy scripts
are labeled separately.

Agent context includes `script_library` and an authoritative `script_output_rule`.
Read references on demand with `editflow_script_catalog(brand, query)` and
`editflow_read_script_reference(brand, path)`, or CLI `script-catalog --brand ...
--query ...` and `read-script-reference --brand ... --path ...`.

Configure a brand once with `scripts/setup_script_library.py --brand ...
--previous-folder <brand-relative-folder> --reference <brand-relative-file>`.
It previews by default; `--apply` backs up/updates the existing brand profile and
agent instructions, and registers verified migration copies. It never moves scripts
or processes media. The profile's `script_library.previous_folders` and
`script_library.reference_files` stay separate from provider credentials.

Old scripts provide style/history, not verified transcript evidence. New scripts
still save only to the selected project's Scripts folder. Automated assignment,
relocation and project-version creation remain later steps in the separate
[script management plan](plans/script-management-and-brand-context.md).

The backend's `EDITFLOW_BRANDS_ROOT` setting defaults to `D:/MARKETING` and can
point to another brand-library root. Migration is explicit and hash-verified:
`scripts/migrate_project_scripts.py --plan <mapping.json>` previews the supplied
map; `--apply --report <report.json>` applies it. Unknown ownership is left for
assignment instead of being inferred from file timestamps.
