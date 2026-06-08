# EditFlow AI — Production Roadmap & Full-System Audit

> The master plan: take a working-but-clunky prototype to an **installable,
> effortless, big-tech-grade app**. Living doc. Status: ✅ done · 🚧 in progress · ⬜ planned.
> Companions: `word-level-editor.md` (editor spec) ·
> `../superpowers/specs/2026-06-06-review-panel-redesign-design.md` (the approved
> Review redesign) · `../superpowers/mockups/*.html` (the visual contract — serve
> on :5599 via `.claude/launch.json`).

## 0. North star

> *Install in one click. It sets up everything it needs. Point it at footage + a
> script; edit by reading and clicking words. No terminal, no remembered commands,
> no babysitting services. It feels like Google built it.*

**Principles** (check every decision against these):
1. **Zero-config** — first run installs/repairs its own dependencies.
2. **Discoverable, not memorized** — buttons & menus over slash-commands; `/` and `@` open menus.
3. **Explicit & reversible** — nothing expensive (transcribe/cut/build) runs without intent + progress + estimate + undo.
4. **Never a dead end** — errors are human, actionable, self-healing; the panel never freezes or blanks.
5. **Fast & calm** — instant feel; long work is backgrounded with progress + cancel.

---

## 1. System map (so any agent ramps fast)

```
Premiere ──loads──▶ CEP panel  (manifest MainPath = client/cep-loader.html, file://)
  cep-loader.html : boot — ping backend, AUTO-SPAWN `python run.py --prod` via Node,
                    then load assets from http://127.0.0.1:8765/panel/ (no-store).
                    (index.html is DELETED ✅ — cep-loader.html IS the panel.)
  src/main.js     : bootstraps; dynamic-imports orchestrator|agent + review-view with
                    ?v=BUILD_TAG cache-buster; wires header buttons + WS; global error banner.
  Frontends (3):
    orchestrator.js : legacy chat state-machine (DEFAULT). slash cmds, scan, paste-plan.
    agent-client.js : LLM-agent chat (localStorage.editflow_agent_mode==='on').
    review-view.js  : word-level editor (📝 / /review). The future PRIMARY surface.
  autocomplete.js  : `/` command palette + `@` bin/clip mentions.
  extendscript.js  : CSInterface.evalScript → editflowDispatch.
extendscript/*.jsx : Premiere host; processEDL builds the "EditFlow Cut" sequence.

Backend (FastAPI, 127.0.0.1:8765, backend/main.py)
  routes/   review · edit · external_plan · premiere · media · whisper_admin · providers · chat · agent
  services/ review_service (parse/tighten/classify/words/refine/words_to_cuts) ·
            review_media (proxy/peaks/silence) · scribe_service · whisper_service ·
            provider_service (ollama) · cut_planner · external_plan · gemini_transcript · media_fingerprint
  data/     review/{proxies,peaks,scribe} · plans · hf-cache (Whisper) · tools/ffmpeg-* · scribe_config.json

Cut apply backbone (reused by EVERY path — don't reinvent):
  kept spans → external_plan.build_plan_from_pasted_json → plan_store → /edit/plan/{id}/apply
  → ExtendScript processEDL → sequence in Premiere.
```

---

## 2. Full audit — what's clunky/broken (status updated)

**Discoverability / UX**
- ✅ `/` command palette + `@` mentions.
- ✅ `index.html` dead code DELETED.
- ⬜ Three overlapping surfaces (orchestrator/agent/review); Review should be the
  **default**, with a top-level **Edit / Takes / Chat / Settings** switcher (tabs designed in mockups, not yet wired).
- ⬜ No onboarding / empty-state guidance; hero is just "Scan Project".

**Transcription**
- ✅ No more auto-transcribing the whole bin on pickup (lazy now).
- ✅ **Scribe** integrated (exact per-word Urdu times) — the real fix for Whisper-Urdu quality.
- ⬜ **faster-whisper still auto-downloads multi-GB models on first transcribe**, silently —
  the real "Whisper not managed correctly". Require an explicit "download (≈X GB)" with progress
  (the WS plumbing exists in `whisper_admin.py`); robust install state machine.

**Robustness / errors**
- ✅ Global uncaught-error banner (panel never silently dies).
- ✅ CEP asset cache solved (no-store `/panel` + `?v=BUILD_TAG` + self-injecting `review.css`).
- ✅ `/paste-plan` card display (`_extractBeats`) fixed.
- ✅ **Cut words no longer spliced into the BUILT sequence** (`words_to_cuts` /
  `_mergedKeptRanges` merge-by-consecutive-id) — was a real output-corrupting bug.
- ⬜ Typed backend errors everywhere; no silent 500s.
- ⬜ Long ops (proxy transcode, Scribe, suggest) run synchronously with no Cancel — background + cancel.
- ⬜ Backend lifecycle: single-instance lock; port-8765 conflict handling; graceful restart.
- ⬜ Add a visible "Hard reload" affordance.

**Editor (word-level)** — see `word-level-editor.md`
- ✅ P1 word doc + waveform + karaoke + select/cut/restore + play + undo.
- ✅ P2 deterministic word refine (filler/[non-speech]/`--` cutoffs); AI suggest (segment→words).
- ✅ P3 Scribe word-times (backend + UI). · ✅ build-from-words (backend).
- 🚧 The **Review-panel REDESIGN** (selection + font done; the rest below in §3b).

**Setup / "app"** — ⬜ requires hand-installed Python, ffmpeg(bundled ✅), Ollama, Whisper. See §5.

**Secrets** — 🚧 Scribe key stored in `data/scribe_config.json` / env; move to OS cred store ideally.

---

## 3. Effortless interaction layer (P1–P2)
- ✅ `/` command palette.
- ⬜ **Mode/tabs switcher** in the header: **Edit · Takes · Chat** (+ a **Compact ⊟ / Workspace ⛶** toggle). Review stops being a hidden command.
- ⬜ First-run **onboarding** (Scan → Transcribe → Cut) + empty states + visible keyboard map.
- ⬜ Toasts + a persistent **diagnostics drawer**.

## 3b. Review-panel REDESIGN — finalized in mockups (the immediate next work)

> **UPDATE — IMPLEMENTED & verified live (browser harness against the real backend):**
> Edit/Takes/Chat **tabs** + **Compact/Workspace** toggle · **Workspace** 4-panel
> layout with draggable splitters (widths verified: left 360 / right 814) + **Plan
> box** (AI-plan list + paste-a-plan) · **Takes tab** (beats from `group_id`, pick
> winner, coverage) · **video show/hide** · **Clean-up ▾ menu** (now actually cuts
> fillers/[non-speech]/`--`) · **Suggest progress + Cancel** + **live model label**
> (showed `minimax-m2.5:cloud`) · native-selection editing · Nastaliq · one-Play +
> Preview-cut-disabled.
>
> **UPDATE 2 — gap-closing pass (2026-06-07):** added the **floating pop-out PiP**
> (drag + resize, geometry persists — completes the "all three" video modes) ·
> **live model label** now also **polls (15s) + refreshes on tab focus**, not just
> on load/Suggest · client `_mergedKeptRanges` now uses the **same `max_gap=0.35`
> as the backend** so the **preview + runtime readout match the build** (no more
> counting dead air) · **Takes quality tag** no longer marks every group member
> `repeat` (shows real clean/false-start/stumble so you can pick) · **Nastaliq
> bundled offline** (`styles/fonts.css` → `fonts/*.woff2`, CDN `<link>` removed
> from `cep-loader.html`) · **"New Sequence" dialog** suppression wired in
> ExtendScript (`createSequenceFromOps` pre-imports the clip + 3-arg preset /
> clip-matched create with safe fallback — **needs a 30-sec confirm inside
> Premiere**, can't be exercised outside it).
>
> **Debug drawer (build review-9):** Suggest now emits a stage-by-stage `trace`
> (junk · clustering with pairwise scores + length-guard skips · script-match ·
> LLM prompt/raw/truncation · final provenance), shown in a 🐞 drawer. Use it to
> confirm root causes before changing the clustering/LLM logic. Plan:
> `../superpowers/plans/2026-06-07-suggest-trace-debug-drawer.md`.
>
> **Still ⬜ (deliberately):** optional `review-view.js` **module split** (§10) —
> pure refactor, zero user-visible change, higher risk than value; deferred.

> Approved design: `../superpowers/specs/2026-06-06-review-panel-redesign-design.md`.
> Mockups: `index`(layout) `2-editing`(selection — **working JS to copy**) `3-font`
> `4-panel`(full Edit) `5-takes`(Takes) `6-workspace`(big view).

| Piece | Status | Where / how |
|---|---|---|
| Native-selection cut/restore (tap=play, sweep flips, first word sets direction) | ✅ | `review-view.js` `_bindDocEvents` |
| Nastaliq font + faded-red cut (no strikethrough) | ✅ (CDN) | `review.css .rv-doc`; ⬜ **bundle** `NotoNastaliqUrdu.woff2` for offline |
| Live AI model-name label | ✅ | `_suggest` refetch |
| One Play + Preview-cut disabled-until-cuts | ✅ | `_renderEditor` + `_updateReadout` |
| **Video show/hide** (drop pop-out) | ⬜ | a single eye toggle on the player |
| **Clean-up ▾ menu** (fix the broken filler/[non-speech]/restore buttons) | ⬜ | replace quick-cut chips; mutate `S.words[].keep` + `_afterMutate` |
| **AI progress + Cancel** | ⬜ | `AbortController` on `/suggest`; spinner + Cancel |
| **Edit/Takes/Chat tabs + Compact/Workspace toggle** | ⬜ | `cep-loader.html` header + `review-view.js` |
| **Takes tab** (fold-the-repeats; pick best take/beat) | ⬜ | derive beats client-side from segments' `group_id`; `5-takes.html` |
| **Workspace big view + 4 dockable panels + dual Plan box** | ⬜ | `6-workspace.html`; option **(B)** resizable+show/hide first, path to **(A)** true drag-dock |
| On-screen ↶/↷ undo-redo; "New Sequence" preset auto-pick (`clip_manager.jsx`) | ⬜ | small UX + ExtendScript |
| Split `review-view.js` → `review/{shell,video,transcript,waveform,takes,workspace,api}.js` | ⬜ | file is ~650 lines |

## 4. Transcription done right (P3)
- ✅ **Scribe** (`scribe_service.py`): `client.speech_to_text.convert(model_id="scribe_v2",`
  `file=<audio>, language_code="ur", timestamps_granularity="word", diarize=False)` → exact
  per-word times. Key in Settings/env; per-minute **cost estimate**; **cache by fingerprint**.
- ⬜ **Whisper = offline fallback** with an explicit **download manager** (never implicit
  multi-GB download); robust install state; correct HF cache dir (already redirected ✅).
- ⬜ **`TranscriptionProvider` abstraction** (`scribe | whisper | paste`) so the editor is
  source-agnostic → always `{words[], segments[]}`.

## 5. The installable app (P6) — the big one
**Goal:** double-click installer → Premiere shows EditFlow, fully working.

**Packaging**
- **CEP extension** → signed **ZXP** (ZXPSignCmd) so it installs without dev mode; or an
  installer that drops it into the CEP extensions dir + sets `PlayerDebugMode`.
- **One-click installer** (Inno Setup / NSIS) that lays down: (1) the extension folder →
  `%APPDATA%/Adobe/CEP/extensions/com.editflow.ai`; (2) a **bundled portable Python** + a
  pre-built venv with pinned deps (or a PyInstaller-frozen backend exe); (3) **ffmpeg**
  (already bundled under `data/tools`); (4) optional models — then registers CEP and launches.
- **Auto-update**: version check + download new ZXP/installer. **Signing** to avoid SmartScreen.

**Dependency strategy (key decision)**
- **Drop the hard Ollama dependency.** Use **Scribe** + **deterministic word cleanup** +
  **optional paste-a-model** for cuts → removes the heaviest, flakiest install. Keep Ollama as
  an *optional advanced* offline mode.
- **Whisper** likewise becomes *optional offline mode*; Scribe is the default.
- Net minimal install = extension + bundled Python backend + ffmpeg + a Scribe key.

**First-run Setup wizard (in-panel)**
- Detects & reports: backend up? · ffmpeg? · Scribe key set? · (optional) Whisper/Ollama.
- One **"Set up / Repair"** button; health re-check any time from Settings.

## 6. Best UI for editing (resolved with the user)
- **A. Word document (Descript-style)** — primary. **B. + Waveform** — yes. **C. Takes tab**
  (retake-heavy footage) — yes. **D. Chat** (legacy) — keep as optional power-user, not default.
- **Workspace view** (the user's addition): all of A/B/C/Plan-box as **movable/dockable
  Premiere-style panels** when the panel is wide. Compact view when narrow.

## 7. Production polish (P7)
Design tokens/spacing/motion; virtualized long transcripts; a11y; high-DPI; RTL (done in
editor); localized strings; crash/error telemetry; signed builds.

## 8. Sequenced roadmap (status)
- **P1 — Word editor + discoverability.** ✅ editor (doc/waveform/karaoke/cut/play/undo) · ✅ `/`
  palette · ✅ lazy transcribe · ✅ delete index.html · ✅ native selection · ✅ Nastaliq · ✅
  one-Play/Preview-cut · ⬜ Edit/Takes/Chat tabs · ⬜ Clean-up menu · ⬜ video show/hide.
- **P2 — AI cleanup + robustness.** ✅ word refine + live model label · ✅ global error banner ·
  ✅ paste-plan card · ✅ cut-word merge bug · ⬜ AI progress+cancel · ⬜ typed errors · ⬜
  background long ops · ⬜ New-Sequence preset.
- **P3 — Transcription providers.** ✅ Scribe (key/cost/cache/word-times) · ⬜ Whisper
  download-only-on-demand manager · ⬜ provider abstraction.
- **P4 — Build & scale.** ✅ build-from-words · ⬜ multi-clip selector/aggregate.
- **P5 — Takes tab** + **Workspace/dockable panels** + script-beat coloring.
- **P6 — Installable app** (drop hard Ollama/Whisper deps; bundle Python; ZXP + installer;
  setup wizard; auto-update; signing).
- **P7 — Polish** (design system, onboarding, perf, a11y, telemetry).

## 9. Open decisions (need a yes)
- **Workspace docking depth:** (A) true Premiere drag-dock vs **(B) resizable+show/hide (recommended v1)** vs (C) floating.
- **Drop Ollama as a hard dep?** (Recommended — Scribe + deterministic + paste cover it.)
- **Bundle a portable Python / freeze backend?** (Recommended for the app.)
- **Pay for code-signing certs** (installer + ZXP)?
- **Remove the agent-mode frontend** once Review is default? (Likely yes.)

## 10. Definition of done (per the user)
No clunk, no subtle errors, full error handling, effortless & smooth, installs itself + its
services, looks built by a big tech company.

## 11. Key code map + run/test (for the next agent)
- Panel entry `cep-panel/CSXS/manifest.xml` → `client/cep-loader.html` → `src/main.js`
  (dynamic-imports `review-view.js` via `BUILD_TAG`; exposes `window.__editflowOpenReview`).
- Editor: `src/review-view.js` + `styles/review.css`. **Bump `BUILD_TAG` (main.js) + `?v=`
  (cep-loader.html) on every panel change.**
- Backend review: `routes/review.py`, `services/review_service.py`, `review_media.py`, `scribe_service.py`.
- Run: `python run.py --prod`. Tests: `python -m pytest tests/unit -q` (130+). Smoke:
  `data/proof/_smoke_*.py`. Test clip + the real Scribe SRT + script live under `data/proof/`.
