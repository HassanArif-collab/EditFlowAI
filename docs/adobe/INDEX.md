# Adobe docs mirror — where to look

Local snapshots of the official AE/CEP references (cloned 2026-07-19 from
docsforadobe + Adobe-CEP, .git stripped). **Grep here FIRST** for any AE
scripting, expression, or CEP question; web-search only if the answer is
missing or version-ambiguous — and note the gap here when that happens.

| Question | Look in |
|---|---|
| ExtendScript API — Layer, CompItem, TextDocument, addProperty, property() | `scripting-guide/docs/` (e.g. `text/textdocument.md`, `layer/textlayer.md`) |
| Match names (ADBE Text Animator, selectors, effects) | `scripting-guide/docs/matchnames/` |
| Text animators / expression selectors via scripting | `scripting-guide/docs/matchnames/layer/textlayer.md` + `scripting-guide/docs/other/textdocument.md` |
| Expression language — textIndex, textTotal, selectorValue, ease, wiggle | `expressions/docs/` |
| What changed per AE version (API availability) | `scripting-guide/docs/introduction/changelog.md` |
| CEP panel — manifest, CSInterface, evalScript, events, lifecycle | `cep/CEP_12.x/Documentation/CEP 12 HTML Extension Cookbook.md` |
| CEP debugging (remote debugger, logs, .debug file) | `cep/CEP_12.x/Documentation/Debugging Handbook.md` |
| CSInterface API surface (the actual shipped JS) | `cep/CEP_12.x/CSInterface.js` |

Refresh: re-run the clone commands in
`docs/superpowers/plans/2026-07-18-ae-agent-dev-loop.md` (Phase 0, Task 0.1).

Known gaps (add entries as found):
- `saveFrameToPng` is undocumented in the scripting guide snapshot; behavior
  confirmed empirically in this repo (`ef_getCurrentFrame`, commit f087828).
