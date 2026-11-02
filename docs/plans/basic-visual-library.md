# Basic visual library — implemented scope

This is the smaller working version requested instead of implementing the full
phased system now. The larger plan remains a reference for later improvements.

In Story Cut, open the settings drawer using the three-dot button. Under
**Visual sources for this project**:

- Paste a folder path and choose **Link folder**.
- Or choose **Choose Premiere bin**, select a bin, then **Link bin and sub-bins**.
- Inspect registered **File paths**, enable/disable a source, or remove it.
- Re-add the same source to refresh its exact membership snapshot.

Selections persist for the chosen brand/project. Files stay at their original
paths. Bin selection uses a fresh native project scan, includes complete selected
descendants, and excludes similarly named sibling bins. Unsupported subclips,
sequences and offline files are skipped. The basic version supports video/images.

The existing visual library remains in use until a first source is explicitly
linked. After linking, only eligible selected paths feed script visual matching
and agent visual context; disabling/removing all sources produces an empty visual
selection rather than restoring unrelated footage. Timeline visual matching also
receives the selected project context.

Existing cached descriptions and verified annotations are reused. New unindexed
files have filename metadata only; this small version does not implement the
larger Gemma indexing queue, automatic transcript migration or full raw/reference
policy integration. Adding a visual source starts no transcription or generation.

Verification: 42 focused backend checks and 12 panel checks passed. The live
panel displayed the controls and enumerated 38 bins in the current Premiere
project. No real source selection or timeline was modified by that live check.
