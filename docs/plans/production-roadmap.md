# EditFlow AI — Continuation Plan (handoff for the next agent)

> **Read me to pick up exactly where we left off.** This is a *handoff*, not the
> old roadmap. The big new direction (Review redesign + a Premiere-style
> **workspace** view) is fully designed and partly built; this file tells you what
> is done, what remains, and **how to implement each remaining piece, file by
> file.** Do **not** implement the multi-clip / installable-app items — those are
> out of scope (see §7).

## 0. Read these first
- **This file.**
- **Design spec:** `docs/superpowers/specs/2026-06-06-review-panel-redesign-design.md` (the approved redesign).
- **Mockups (the visual contract):** `docs/superpowers/mockups/*.html`. Serve them:
  `python -m http.server 5599 --directory docs/superpowers/mockups` (or the
  `.claude/launch.json` "mockups" server). Files: `index`=layout, `2-editing`=the
  selection model (**working JS to copy**), `3-font`=font, `4-panel`=full Edit
  panel, `5-takes`=Takes tab, `6-workspace`=the big workspace view.
- `ARCHITECTURE.md` (system map; note **`cep-loader.html` is the real panel**, not
  the now-deleted `index.html`).

## 1. Where we are (branch `v2-simple-start`, all pushed)
**Shipped this session:**
- Word-level Review editor (Phases 1–3): word doc + waveform + karaoke + word
  select/cut/restore + play + undo; deterministic word-level junk refine; **Scribe**
  integration (backend `scribe_service.py` + a "Transcribe with Scribe" UI).
- UX: `/` command palette (`autocomplete.js`); **lazy transcribe** (no more
  auto-transcribing the whole bin); global uncaught-error banner (`main.js`).
- **Fixes:** cut-word-spliced-into-build merge bug (backend `words_to_cuts` +
  frontend `_mergedKeptRanges`) `[b200362]`; `/paste-plan` card display
  (`_extractBeats`); **deleted dead `index.html`**.
- Docs: `ARCHITECTURE.md`, `docs/plans/word-level-editor.md`, this file, the
  redesign spec + 6 mockups.
- 129+ unit tests pass (`python -m pytest tests/unit -q`).

## 2. The finalized redesign (what to build) — decisions are locked
| Area | Decision |
|---|---|
| Video | **Show/hide only** (drop "pop out"). In the workspace it's a small panel. |
| Single tap on a word | **Seek there + play** (not toggle). |
| Cut/keep | **Only via selection**, using **native text selection** (start anywhere, gaps included). On `mouseup`, every word the selection touched flips; the **first word sets direction** (kept→cut, cut→restore). No buttons, no double-tap. |
| Font | **Noto Nastaliq Urdu** (bundled), tall line-height; cut = **faded red** (no strikethrough); now-playing = soft highlight. |
| Transport | **One Play/Pause**. Separate **"Preview cut"**, disabled until ≥1 cut, plays **only** kept words. |
| Toolbar | **Suggest · ‹live model›** + **Clean up ▾** menu (fillers / [non-speech] / repeated takes / restore all) + live **readout**. |
| AI | Suggest shows **progress + Cancel**; model name read **live** from Settings. |
| Views | Header tabs **Edit / Takes / Chat** + a **Compact ⊟ / Workspace ⛶** toggle. |
| Takes tab | Fold-the-repeats: beats = retake clusters; pick best take per beat (others auto-cut); per-take tag + ▶; coverage; "fine-trim in Edit". |
| **Workspace (big) view** | Four panels — **Controls, Video (small, top-left), Plan box (left, below video), Transcript (right)** — **movable/dockable like Premiere**. |
| Plan box | Dual: the **AI-generated plan shows there**, AND you can **paste an external model's plan** into it. |

## 3. Remaining implementation — step by step (file-level)

> All frontend work is in `cep-panel/client/`. After ANY panel change, bump
> `BUILD_TAG` in `src/main.js` **and** the `?v=` in `cep-loader.html` (CEF caches
> by URL). `review.css` already self-injects with a timestamp.

**A. Native-selection editing** — `src/review-view.js`. Replace `_bindDocEvents`
(the per-word mousedown/move drag) with the **native-selection** version: set
`.rv-doc { user-select: text }`; on `mouseup`, if `getSelection()` is
non-collapsed, collect `.rv-w` spans via `range.intersectsNode`, set mode from the
first covered word (`keep→cut`, else `restore`), flip all, snapshot, clear
selection; if collapsed, seek+play the word under the cursor. **Working reference
code is in `docs/superpowers/mockups/2-editing.html` `<script>`** (verified). Also
add on-screen ↶/↷ undo/redo buttons.

**B. Nastaliq font** — add `cep-panel/client/fonts/NotoNastaliqUrdu-*.woff2`
(download once; the mockups use the Google CDN, but **the panel must bundle it** —
CEF may be offline), `@font-face` + apply to `.rv-doc` in `styles/review.css`,
`line-height:~3.0`, `font-size:~15px`, `direction:rtl`. Change `.rv-w-cut` to
`color:var(--error);opacity:.4` (no `line-through`). English tokens stay Inter,
`unicode-bidi:isolate`.

**C. Transport rework** — `_renderEditor`: replace "▶ Original / ▶ Play kept only"
with **one round Play/Pause** (toggles `S.video`) + **"Preview cut"** that is
`disabled` when `_mergedKeptRanges()` is empty (tooltip "make some cuts first")
and otherwise plays the kept ranges hopping cut spans (the `_onTime` plan logic,
now correct after the merge fix).

**D. Clean-up menu (fix the broken buttons)** — the quick-cut chips don't work.
Replace with a **"Clean up ▾"** dropdown: remove fillers / remove [non-speech] /
remove repeated takes / restore all. Each mutates `S.words[].keep` then
`_afterMutate()`. Reuse the backend `refine_words` rules client-side, or add a
`/api/review/cleanup` endpoint. Unit-test each action.

**E. Live model name** — `_fetchModelName` runs once today. Re-fetch on `_suggest`
start and on a light interval / window-focus, and update the "Suggest · ‹model›"
label. Source: `GET /api/status` → `active_chat`.

**F. Tabs + view toggle** — header **Edit / Takes / Chat** and **⊟ Compact / ⛶
Workspace**. Compact = today's single column (video show/hide only). Workspace =
§3-H. Put these in `cep-loader.html`'s header + wire in `review-view.js`.

**G. Takes tab** — derive beats **client-side** from segments' `group_id`
(`classify` sets it; it's in the `/suggest` response — no new endpoint). Beat =
segments sharing a `group_id`; take = a segment; its words = words with that
`segment_id`. Row: winner radio · ▶ A/B · timecode · Nastaliq snippet · quality
tag (`clean`/`false start` [ends `--`]/`stumble`/`repeat`). Pick winner → its words
keep, the beat's other takes' words cut (same `S.words` state). Coverage badges;
"fine-trim in Edit". Mockup: `5-takes.html`.

**H. Workspace (big) view — the headline new feature.** Mockup: `6-workspace.html`.
Four panels: **Controls** (play/pause, time, Preview cut, Suggest, Clean up,
readout, Build), **Video** (small, top-left, show/hide), **Plan** (left, below
video), **Transcript** (right). **Dockability — the one open question the user
didn't finalize:** they said "movable/dockable like Premiere." Three options were
offered:
- **(A)** true drag-to-dock/tab/snap (most powerful, biggest build — consider a lib
  like `dockview`/`golden-layout`),
- **(B, recommended for v1)** a fixed arrangement with **draggable splitters to
  resize** + **show/hide** each panel + swap left/right (90% of the value, robust),
- **(C)** free-floating draggable panels.
Build **(B)** first (CSS grid + splitter drag handles + per-panel hide), and leave
a clean seam to upgrade to (A). **Plan box** = two tabs: *AI plan* (a list of the
kept spans: `tc · snippet`, click to seek) and *Paste a plan* (a textarea →
`/api/external-plan/ingest` or `/api/review/build`; the cuts highlight live in the
transcript). CEP can't truly fullscreen — trigger Workspace **responsively when
the panel is wide** plus the ⛶ toggle.

**I. "New Sequence" preset dialog** — `extendscript/clip_manager.jsx`
`createSequenceFromOps`: create the sequence from the source clip's settings/preset
(use the `preset_from_clip_path` already passed in the op) so Build doesn't pop a
modal. Test in Premiere.

**J. Split the file** — `review-view.js` is ~600 lines. Break into
`src/review/{shell,video,transcript,waveform,takes,workspace,api}.js` with small,
testable pure helpers (selection→ids, merge-by-index, beats-from-group_id).

## 4. Bug root-causes (status)
- Cut word spliced into build/preview → **FIXED** `[b200362]` (merge by consecutive
  id, not time gap; cut word ends the run).
- `/paste-plan` card empty/0:00 → **FIXED** (`_extractBeats`).
- Clean-up buttons do nothing → **TODO (D)**.
- Model name stale until restart → **TODO (E)**.
- "New Sequence" modal interrupts Build → **TODO (I)**.

## 5. Code map (where things live)
- **Panel entry:** `cep-panel/CSXS/manifest.xml` → `client/cep-loader.html` (loads
  `src/main.js` via the no-store `/panel` mount; `main.js` dynamic-imports
  `review-view.js` with the `BUILD_TAG` buster and exposes
  `window.__editflowOpenReview`).
- **Editor:** `src/review-view.js` + `styles/review.css`. Opened by the 📝 header
  button or `/review` (`orchestrator.js`).
- **Backend review:** `routes/review.py` (ingest/media/waveform/suggest/build +
  scribe/{status,key,estimate} + transcribe); `services/review_service.py`
  (parse/tighten/classify/words/refine/`words_to_cuts`); `review_media.py`
  (proxy/peaks/silence); `scribe_service.py`.
- **The one apply backbone (reuse, don't reinvent):**
  `external_plan.build_plan_from_pasted_json` → `plan_store` →
  `POST /api/edit/plan/{id}/apply` → ExtendScript `processEDL` → sequence.

## 6. Run & test
- Backend: `python run.py --prod` (panel auto-spawns it too). Tests:
  `python -m pytest tests/unit -q`. Smoke scripts: `data/proof/_smoke_*.py`.
- Panel: reload in Premiere → 📝 / `/review`. Test clip:
  `G:\YT Videos\…\TestingEditFlow\IMG_1694.MOV`; the real Scribe SRT is at
  `data/proof/VoiceOverFor_Testing_1_urd.srt`; the script at
  `data/proof/javed_script.txt`.

## 7. Out of scope (do NOT build now)
Multi-clip sessions, the installable-app/zero-config bootstrap, dropping Ollama,
packaging/signing. These were in an earlier audit and the user explicitly deferred
them. Focus only on §3 (the Review redesign + workspace) and §4 fixes.
