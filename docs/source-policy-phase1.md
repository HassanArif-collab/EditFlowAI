# Source registry and policy previews — Phase 1

The registry stores source permissions and provenance in the existing SQLite
database. It does not duplicate the visual description index or the transcript
cache. The source type (`folder` or `premiere_bin`) is separate from its role
(`raw_dialogue`, `visuals`, `references`). Bin selection remains Phase 2.

`SourceRegistry` supports explicit source registration, exact membership snapshots,
brand/project scope, project overrides, exclusions, restricted subclip ranges,
policy revisions and transactional snapshot/restore. Registration does not crawl
the source folder. Each file must appear in its reviewed membership snapshot.

Paths resolve to their real location. Multiple folder/bin memberships share one
asset, including discovered hardlink aliases. A project exclusion applies to all
those memberships. Removing a membership retains media and other approved
memberships. Conflicting enabled roles are denied rather than silently combining
permissions, including project registrations that contradict brand references.

File revision fingerprints combine file identity, size, nanosecond timestamps and
head/tail samples. They provide a conservative change guard, not a full-file
cryptographic identity. Existing content-addressed transcription cache keys remain
unchanged. Changed membership fingerprints require a refreshed snapshot; they do
not silently authorize old transcript/vision results for replaced media.

Source-policy generations increase after every successful mutation, including
restore. Callers can require an expected revision to prevent stale writes. Restore
touches only the new policy tables, retaining existing SQLite transcripts/assets,
visual JSON annotations and original media. File changes during registration and
invalid snapshots abort their transactions.

## Preview API

- `GET /api/library-sources/policy?brand=...&project_folder=...`
- `POST /api/library-sources/evaluate` with brand, project_folder, path, purpose
  and optional `[IN, OUT]` source_range.
- `POST /api/library-sources/migration-preview` with brand and optional project_folder.

These endpoints report **preview mode**. There is intentionally no project
activation endpoint or active role-control UI in Phase 1. The later integration
phase must route existing consumers through the resolver before controls can
claim to enforce the new policy on production assembly.

## Existing library migration

Run the repository's Python with `scripts/preview_source_migration.py --brand
"Brand name" --project "<project folder>" --output "<new report.json>"`.
The CLI reads existing folder config, cached index, current project scripts and
matching execution sidecars. It never calls library initialization, transcribes,
runs a vision model, moves footage, changes roles or rewrites caches.

Mixed/unknown folders stay unassigned. Suggested roles always require review;
folder names and old classification heuristics are not proof of source provenance.
The report identifies current script references to edited/final footage, project
assets, and references unresolved by the existing registered cache. Unresolved
does not necessarily mean the file is missing. Stale script sidecars are ignored.
The preview signature includes config/index and script/sidecar bytes.

Real previews are saved under `data/output/source-policy-phase1-*.json` locally.
They are not activated migrations. The registry remains available for the next
phase to register a reviewed source selection; existing live source assignments
are unchanged until that selection is reviewed and consumer integration is ready.
