# Plan — Diagnostics Log Sink

> **Goal:** every layer's errors (backend Python, panel JS, ExtendScript) funnel
> into **one file on disk** the user can drag into chat — no copy-paste, no
> screenshots. One-click bundle + open the logs folder.
>
> **Why:** driving Premiere via computer-use was slow/flaky; the user now drives
> Premiere from numbered runbooks while failures are captured automatically. The
> `importMGT returned null` bug only showed in a tiny status line — this sink
> would have surfaced it instantly. See [[workflow-guide-dont-drive-premiere]].

## What gets captured

| Layer | Captures | Mechanism |
|---|---|---|
| Backend (Python) | all logs + tracebacks | `RotatingFileHandler` → `data/logs/editflow.log` |
| Panel (JS) | `console.error/warn`, `window.onerror`, unhandled rejections | extend `diagnostics.js`; buffer + flush |
| ExtendScript | **every `callExtendScript` call + result/error** | wrap `callExtendScript` in `extendscript.js` |
| Relay | panel/jsx events → same log file | `POST /api/diag/log` |

## Components

### Backend
- **`backend/utils/logsink.py`** — `init_file_logging()`: attach a
  `RotatingFileHandler` (5 MB × 3) to the root logger →
  `<DATA_DIR>/logs/editflow.log`, same format as the console handler. Idempotent
  (don't double-add). Call once at `main.py` import (after `basicConfig`) so
  startup is captured; create the `logs/` dir itself.
- **`backend/routes/diag.py`** (register in `main.py`, prefix `/api/diag`):
  - `POST /log` — body `{events:[{ts,level,source,msg,data}], build?, session?}`.
    Writes each event to the logger tagged `[panel]`/`[jsx]` + build + session.
    Tolerant: bad/oversized events are skipped, never 500s.
  - `POST /bundle` — body `{build?, premiere?, session?}`. Builds
    `<DATA_DIR>/logs/diag-<UTCstamp>.txt`:
    1. header — build tag, Premiere/CEP version (from body), OS/platform,
       timestamp, preflight snapshot (ffmpeg / whisper / ollama via existing
       `services/preflight`), active models.
    2. tail of `editflow.log` (~800 lines).
    Then `os.startfile(logs_dir)` (Windows) best-effort to open Explorer.
    Returns `{path, bytes}`. Never raises — folder-open failure is non-fatal.

### Panel
- **`cep-panel/client/src/diagnostics.js`** (extend):
  - `installGlobalCapture(sessionId, buildTag)` — `window.onerror`,
    `window.onunhandledrejection`, patch `console.error`/`console.warn` to also
    `enqueue()` (keep original console behavior).
  - event buffer (cap ~500) + `flush()` → `POST /api/diag/log`; flush every ~3 s,
    immediately on an error-level event, and on `beforeunload`. Never throw from
    the logger (diagnostics must not break the app).
  - `logEvent(level, source, msg, data)` exported for explicit logging.
  - `saveBundle()` — `POST /api/diag/bundle` with `{build, premiere, session}`;
    show the returned path in the popover.
- **`cep-panel/client/src/extendscript.js`** — wrap `callExtendScript`: on every
  call `logEvent('info'|'error','jsx', fnName, {ok, error})`. This auto-captures
  the `importMGT returned null` class of failure.
- **UI** — reuse the existing `#btn-diagnostics` popover (it already shows status):
  add a **"Save diagnostics bundle"** button in the popover → `saveBundle()` →
  shows the file path + "folder opened". Call `installGlobalCapture()` from
  `main.js` boot. Bump `BUILD_TAG`.

## Verification
- **Unit (pytest):** bundle builder (header fields present, tail length bounded,
  missing log file tolerated); `/api/diag/log` accepts a batch and is junk-safe;
  `init_file_logging` is idempotent.
- **Live (user-driven):** trigger a known failure (place subtitles with no
  sequence) → click Save diagnostics → confirm the file contains the backend line
  + the `[jsx] placeSubtitleClips {ok:false,...}` event.

## Scope
1 backend util + 1 route + 2 panel edits + 1 button. Backend is TDD-able; panel
is verified live via the runbook.

## Touch-points
- `backend/main.py` — `basicConfig` (line ~17), router registration (line ~111), lifespan.
- `backend/config.py` — `DATA_DIR`.
- `backend/services/preflight.py` — preflight snapshot for the bundle header.
- `cep-panel/client/src/diagnostics.js`, `extendscript.js`, `main.js` (BUILD_TAG + boot wiring).
- `cep-panel/client/cep-loader.html` — existing `#btn-diagnostics` / `#diagnostics-popover`.
