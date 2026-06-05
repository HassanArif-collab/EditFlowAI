# EditFlow AI — Production Roadmap

> The master plan: turn a working-but-clunky prototype into an **installable,
> effortless, big-tech-grade app**. Living document — refined continuously.
> Companion to `word-level-editor.md` (the editor's detailed spec).

## 0. North star

> *Anyone installs it in one click. It sets up everything it needs. You point it
> at footage + a script, and you edit by reading and clicking words. No terminal,
> no remembering commands, no babysitting services. It feels like Google built it.*

Design principles (every decision is checked against these):
1. **Zero-config.** First run installs/repairs its own dependencies.
2. **Discoverable, not memorized.** Buttons & menus over slash-commands. `/` and
   `@` open menus. Nothing requires recall.
3. **Explicit & reversible.** Nothing expensive (transcribe, cut, build) happens
   without intent, a progress bar, a cost/time estimate, and an undo.
4. **Never a dead end.** Errors are human, actionable, and self-heal where
   possible. The panel never freezes or goes blank.
5. **Fast & calm.** Instant feel; long work is backgrounded with progress+cancel.

## 1. Honest audit of what's clunky today

| Area | Problem |
|---|---|
| Discoverability | Must *remember* `/review`. `/` shows no command menu; `@` shows no file/bin menu (autocomplete broken/limited). |
| Transcription | Picking a bin **auto-transcribes everything** with Whisper (slow, unasked-for). No estimate, no cancel. |
| Whisper mgmt | Model download/select/delete is fragile (wrong cache dir, partial downloads, "model not found" spam). |
| LLM cuts | Weak local model decided whole-sentence keep/cut (wrong granularity — fixed by the word editor). |
| Robustness | Sparse error handling; 500s surface as dead UI; CEP asset cache silently serves stale code. |
| Setup | Requires Python, ffmpeg, ollama, Whisper models installed by hand. Not an "app". |
| Surface | Three overlapping frontends (orchestrator / agent / review); Review is hidden behind a command. |

## 2. Workstreams

### A. Word-level editor (core) — see `word-level-editor.md`
Descript-style word doc + waveform; karaoke; click-word-to-seek; select→cut/
restore; play original/plan; AI cleanup with **dynamic active-model label**;
Scribe word-times; "Takes" tab. Phases A1–A5 there.

### B. Effortless interaction layer
- **Command menu on `/`** — floating list (Review, Transcribe, Cut plan, New edit,
  Settings…) with descriptions + ↑↓/Enter. Fix `autocomplete.js`.
- **`@` mention menu** — live list of project bins/clips/files to insert.
- **Review is a top-level mode**, not a hidden command: a header **Edit / Chat /
  Settings** switcher; Edit (the word editor) is the default landing.
- Inline affordances everywhere; remove the need to recall any command.

### C. Transcription done right (Whisper + Scribe)
- **No auto-transcribe.** Transcription is an explicit action with estimate +
  progress + cancel; results cached by content fingerprint.
- **Scribe integration** (`scribe_v2`, word timestamps, `language_code`, diarize
  off): API key in Settings (stored outside the repo), per-minute cost estimate,
  fingerprint cache. Recommended path.
- **Whisper = offline fallback** with a real **model manager** (list/download w/
  progress/select/delete/disk-usage; correct HF cache dir; resume partials).
- A **TranscriptionProvider** abstraction (`scribe | whisper | paste`) so the
  editor is source-agnostic and always gets `{words[], segments[]}`.

### D. Robustness & error handling
- Backend: typed exceptions → clean 4xx with actionable detail; never silent 500.
- Frontend: global error surface; inline ret/ dismiss; the panel can always recover.
- Backend lifecycle: health endpoint, single-instance lock, graceful auto-restart,
  hardened `cep-loader` boot.
- **CEP cache solved once**: every asset URL carries a build-stamped `?v=`; modules
  load via the no-store `/panel` mount; a "Hard reload" affordance.
- Diagnostics panel surfaces live state + last errors + log tail.

### E. The installable app (zero-config bootstrap)
- **First-run Setup wizard** (in-panel) that detects & installs/repairs:
  - **ffmpeg** — bundled; verify & self-locate. ✅ mostly done.
  - **Python + backend** — ship a **bundled portable Python** + pinned deps so no
    system Python is required; backend auto-starts (already via cep-loader).
  - **Ollama** — *decision:* prefer to **drop the hard ollama dependency** (use
    Scribe + deterministic + optional paste). If kept, detect/offer install + pull
    a default model.
  - **Whisper models** — download on demand with progress.
- **Packaging**: signed **ZXP** for the CEP extension + a **one-click installer**
  (Inno Setup / NSIS) that lays down the extension, the bundled runtime, registers
  CEP, and launches. A "Repair" button re-checks/fixes the environment.

### F. Production polish
- Design system (tokens/spacing/motion), onboarding, empty states, tooltips,
  keyboard map, virtualized long transcripts, a11y, high-DPI, RTL (done).

## 3. Sequenced roadmap

- **P1 — Word editor MVP + discoverability.** Word doc + waveform + karaoke +
  select/cut/restore + play original/plan; **fix `/` & `@` menus**; **Review as a
  top-level Edit tab**; **stop auto-transcribe**. *(in progress)*
- **P2 — AI cleanup + robustness.** Word-range AI cleanup (dynamic model label);
  backend/frontend error-handling pass; CEP cache solved.
- **P3 — Transcription providers.** Scribe (word times, key, cost, cache) +
  Whisper model-manager UI + provider abstraction.
- **P4 — Build & scale.** Build-from-words + multi-clip selector/aggregate +
  fix `/paste-plan` build.
- **P5 — Takes tab.** Take-grouping (best-take-per-beat) + script-beat coloring.
- **P6 — Installable app.** Setup wizard + dependency auto-install + packaging +
  repair.
- **P7 — Polish.** Design system, onboarding, perf, a11y.

## 4. Open decisions (flag for user)
- **Drop ollama?** Scribe + deterministic + paste likely cover cuts → far simpler
  install. (Recommended.)
- **Bundle Python runtime?** +size, −friction. (Recommended for the "app".)
- **Installer signing** (avoids SmartScreen warnings) — needs a cert.

## 5. Definition of done (per the user)
No clunk, no subtle errors, full error handling, effortless + smooth, installs
itself, looks built by a big tech company.
