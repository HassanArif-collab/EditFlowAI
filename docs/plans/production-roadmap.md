# EditFlow AI — Production Roadmap & Full-System Audit

> The master plan: take a working-but-clunky prototype to an **installable,
> effortless, big-tech-grade app**. Living doc — refined continuously.
> Companion: `word-level-editor.md` (editor spec). Status tags: ✅ done ·
> 🚧 in progress · ⬜ planned.

## 0. North star

> *Install in one click. It sets up everything it needs. Point it at footage + a
> script; edit by reading and clicking words. No terminal, no remembered
> commands, no babysitting services. It feels like Google built it.*

**Principles** (every decision is checked against these):
1. **Zero-config** — first run installs/repairs its own dependencies.
2. **Discoverable, not memorized** — buttons & menus over slash-commands; `/`
   and `@` open menus.
3. **Explicit & reversible** — nothing expensive (transcribe/cut/build) runs
   without intent + progress + estimate + undo.
4. **Never a dead end** — errors are human, actionable, self-healing; the panel
   never freezes or blanks.
5. **Fast & calm** — instant feel; long work is backgrounded with progress + cancel.

---

## 1. System map (so any agent ramps fast)

```
Premiere ──loads──▶ CEP panel  (manifest MainPath = client/cep-loader.html, file://)
  cep-loader.html  : boot — ping backend, AUTO-SPAWN `python run.py --prod` via Node,
                     then load assets from  http://127.0.0.1:8765/panel/  (no-store).
                     ⚠ index.html is DEAD (nothing loads it) — delete or repurpose.
  src/main.js       : bootstraps; dynamic-imports orchestrator|agent (+ review-view)
                      with ?v=BUILD_TAG cache-buster; wires header buttons + WS.
  Frontends (3):
    orchestrator.js : legacy chat state-machine (DEFAULT). slash cmds, scan, paste-plan.
    agent-client.js : LLM-agent chat (when localStorage.editflow_agent_mode==='on').
    review-view.js  : NEW word-level editor (📝 / /review). The future primary surface.
  chat-ui.js        : message-card renderer for the chat frontends.
  autocomplete.js   : `/` command palette + `@` bin/clip mentions.
  extendscript.js   : Promise wrapper over CSInterface.evalScript → editflowDispatch.
extendscript/*.jsx  : Premiere host (index.jsx router → clip/sequence/marker/… managers).
                      processEDL builds the "EditFlow Cut" sequence.

Backend  (FastAPI, 127.0.0.1:8765, backend/main.py)
  routes/   review (word editor) · edit (analyze/plan/apply) · external_plan (paste) ·
            premiere (project context) · media · whisper_admin · providers · chat · agent
  services/ review_service (parse/tighten/classify/words) · review_media (proxy/peaks/
            silence) · whisper_service · provider_service (ollama) · cut_planner ·
            external_plan · script_matcher · gemini_transcript · media_fingerprint
  data/     proxies, peaks, plans, hf-cache (Whisper), tools/ffmpeg-*, review/

Cut apply backbone (reused by every path):
  kept spans → external_plan.build_plan_from_pasted_json → plan_store → /edit/plan/{id}/apply
  → ExtendScript processEDL → sequence in Premiere.
```

---

## 2. Full audit — what's clunky/broken (my findings + the user's)

**Discoverability / UX**
- ✅ `/` showed nothing → added a command palette. `@` mentions worked.
- ⬜ Three overlapping surfaces (orchestrator/agent/review); Review should be the
  **default**, with a top-level **Edit / Chat / Settings** switcher. Right now the
  default is the legacy chat and Review is a button/command.
- ⬜ No onboarding / empty-state guidance; the hero is just "Scan Project".
- ⬜ `index.html` is dead code that misleads (I edited it for an hour before
  realizing `cep-loader.html` is the panel). Delete it.

**Transcription**
- ✅ Picking a bin auto-transcribed the whole bin → made lazy.
- ⬜ **faster-whisper auto-downloads multi-GB models on first transcribe**, silently,
  with no estimate — the real "Whisper not managed correctly". Fix: never trigger a
  download implicitly; require an explicit "download (≈X GB)" with progress (the
  download-progress WS plumbing already exists in `whisper_admin.py`).
- ⬜ Install detection is heuristic (scans HF cache for `.incomplete`) and brittle;
  needs a robust state machine: not-installed / downloading(%) / ready / failed.
- ⬜ Whisper Urdu quality is poor (proven). Scribe is the real answer (below).

**Robustness / errors**
- ⬜ Sparse error handling; backend 500s can surface as a dead panel. Need a global
  frontend error surface + typed backend errors everywhere.
- ⬜ Long ops (proxy transcode, transcribe) run **synchronously in the request** with
  no cancel. Background them with progress + cancel.
- ⬜ Backend lifecycle: no single-instance lock; port-8765 conflicts; cep-loader
  spawns if ping fails — races possible. Add a lock + health + graceful restart.
- ✅ CEP asset cache mostly solved: no-store `/panel` + `?v=BUILD_TAG` dynamic
  imports + self-injecting `review.css`. Add a visible "Hard reload" affordance.
- ⬜ `/paste-plan` plan-card shows `""`/`0:00` (`_extractBeats` reads `beat.text`/
  `beat.start`, external cuts use `beat_text`/`source_in`) — display bug; and Build
  needs the "New Sequence" preset dialog OK'd. Fix mapping + auto-confirm/preset.

**Editor (word-level)** — see `word-level-editor.md`
- ✅ P1 word doc + waveform + karaoke + select/cut/restore + play original/plan + undo.
- 🚧 P2 word-level AI (currently segment-classify → words; make AI return word RANGES).
- ⬜ P3 Scribe word-times · P4 build-from-words(✅ backend)/multi-clip · P5 Takes tab.

**Setup / "app"**
- ⬜ Requires hand-installed Python, ffmpeg(bundled ✅), Ollama, Whisper models.
  Not an app. See §5.

**Secrets**
- ⬜ Scribe API key must be stored securely (OS cred store or at least outside the
  repo / not in plain localStorage synced anywhere).

---

## 3. Effortless interaction layer (P1–P2)
- ✅ `/` command palette.
- ⬜ **Mode switcher** in the header: **Edit** (word editor, default) · **Chat**
  (legacy power-user) · **Settings**. Review stops being a hidden command.
- ⬜ First-run **onboarding**: 3 steps (Scan → Transcribe → Cut) with inline hints.
- ⬜ Consistent empty states, tooltips, a visible **keyboard map** (the editor is
  keyboard-first).
- ⬜ Toasts for success/'undo' affordances; a persistent **status/diagnostics**
  drawer instead of silent failures.

## 4. Transcription done right (P3)
- **Scribe** (recommended): `client.speech_to_text.convert(model_id="scribe_v2",`
  `file=<audio>, language_code="ur", timestamps_granularity="word", diarize=False)`
  → exact per-word times. Key in **Settings** (secure). Per-minute **cost estimate**
  before the call; **cache by content fingerprint**. New `scribe_service.py` +
  routes; word editor consumes its `words[]` directly.
- **Whisper = offline fallback**: explicit model **download manager** (never
  implicit); robust install state; correct HF cache dir (already redirected).
- **`TranscriptionProvider` abstraction** (`scribe | whisper | paste`) so the editor
  is source-agnostic → always `{words[], segments[]}`.

## 5. The installable app (P6) — the big one
**Goal:** double-click installer → Premiere shows EditFlow, fully working.

**Packaging**
- **CEP extension** → signed **ZXP** (ZXPSignCmd) so it installs without dev mode;
  or ship via an installer that drops it into the CEP extensions dir + sets
  `PlayerDebugMode`.
- **One-click installer** (Inno Setup / NSIS on Windows) that lays down:
  1. the extension folder (→ `%APPDATA%/Adobe/CEP/extensions/com.editflow.ai`),
  2. a **bundled portable Python** + a pre-built venv with pinned deps (so no system
     Python needed) — or a PyInstaller-frozen backend exe,
  3. **ffmpeg** (already bundled under `data/tools`),
  4. optional models,
  then registers CEP and launches.
- **Auto-update**: version check + download new ZXP/installer.
- **Signing**: code-sign the installer to avoid SmartScreen.

**Dependency strategy (key decision)**
- **Drop the hard Ollama dependency.** Use **Scribe** (transcription) + **deterministic
  word cleanup** + **optional paste-a-model** for cuts. This removes the heaviest,
  flakiest install (a local LLM runtime + multi-GB model) and makes the app viable
  for non-technical users. Keep Ollama as an *optional advanced* offline mode.
- **Whisper** likewise becomes *optional offline mode*; Scribe is the default path.
- Net: the minimal install = extension + bundled Python backend + ffmpeg + a Scribe
  key. Everything else is opt-in.

**First-run Setup wizard (in-panel)**
- Detects & reports: backend up?, ffmpeg?, Scribe key set?, (optional) Whisper/Ollama.
- One **"Set up / Repair"** button that fixes what it can and links what it can't.
- Health re-check any time from Settings.

## 6. Best UI for editing (the user's question)
- **A. Word document (Descript)** — chosen primary. Best for precision + trust.
- **B. + Waveform strip** — chosen; adds frame-level scrubbing.
- **C. Take-grouping tab** — chosen (P5); best for retake-heavy footage (this clip).
- **D. Chat-driven** (legacy) — keep as optional power-user surface, not default.
- **Recommendation (in build):** A+B as the default Edit surface, C as a second tab,
  D demoted to "Chat". This matches Premiere's own Text-Based Editing + Descript, the
  two products users already expect.

## 7. Production polish (P7)
Design tokens/spacing/motion; virtualized long transcripts; a11y; high-DPI; RTL
(done in editor); localized strings; crash/error telemetry; signed builds.

## 8. Sequenced roadmap (status)
- **P1 — Word editor + discoverability.** ✅ word doc+waveform+karaoke+cut/restore+
  play+undo · ✅ `/` palette · ✅ lazy transcribe · ⬜ Edit/Chat mode switcher · ⬜ delete dead index.html.
- **P2 — AI cleanup + robustness.** 🚧 word-range AI (dynamic model label ✅) ·
  ⬜ error-handling pass · ⬜ background long ops + cancel · ⬜ fix `/paste-plan` card+build.
- **P3 — Transcription providers.** ⬜ Scribe (key/cost/cache/word-times) · ⬜ Whisper
  download-only-on-demand manager · ⬜ provider abstraction.
- **P4 — Build & scale.** ✅ build-from-words (backend) · ⬜ multi-clip selector/aggregate.
- **P5 — Takes tab** + script-beat coloring.
- **P6 — Installable app** (drop hard Ollama/Whisper deps; bundle Python; ZXP +
  installer; setup wizard; auto-update; signing).
- **P7 — Polish** (design system, onboarding, perf, a11y, telemetry).

## 9. Open decisions (need a yes)
- **Drop Ollama as a hard dep?** (Recommended — Scribe + deterministic + paste cover it.)
- **Bundle a portable Python / freeze backend?** (Recommended for the app.)
- **Pay for code-signing certs** (installer + ZXP) to avoid security warnings?
- **Remove the agent-mode frontend** to cut surface area? (Likely yes once Review is default.)

## 10. Definition of done (per the user)
No clunk, no subtle errors, full error handling, effortless & smooth, installs
itself + its services, looks built by a big tech company.
