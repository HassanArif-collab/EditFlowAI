# EditFlow AI — Architecture

A FastAPI backend + Adobe Premiere Pro CEP panel that drives an LLM agent through a video-editing pipeline: scan a project, transcribe takes with Whisper, match against a script, propose cuts, apply them via ExtendScript.

This doc is what you read **once per session** to remember how the pieces fit. It does not describe individual files in depth — `grep` and `Read` do that better. It describes the **invariants** that matter when adding code.

---

## Topology

```
┌────────────────────┐         ┌────────────────────────────────────┐
│  Premiere Pro      │   CEP   │  cep-panel/client/  (no build step)│
│  (CSInterface)     │◄───────►│  ES modules, vanilla JS, plain CSS │
└────────────────────┘         └──────────────┬─────────────────────┘
                                              │ HTTP + WebSocket
                                              ▼
                              ┌───────────────────────────────────┐
                              │  backend/  (FastAPI + uvicorn)    │
                              │  - 11 routes under /api           │
                              │  - SQLite registry                │
                              │  - file cache under data/         │
                              └─────────────┬─────────────────────┘
                                            │
                  ┌─────────────────────────┼─────────────────────────┐
                  ▼                         ▼                         ▼
          ┌─────────────┐         ┌─────────────────┐         ┌─────────────┐
          │ Ollama HTTP │         │ faster-whisper  │         │   ffmpeg    │
          │ (LLM)       │         │ (CT2, on disk)  │         │ (subprocess)│
          └─────────────┘         └─────────────────┘         └─────────────┘
```

The panel never talks to Premiere directly except through ExtendScript (CSInterface bridge). All AI work, model state, and file I/O lives in the backend. The CEP panel is a thin UI that calls HTTP routes and listens to a single WebSocket.

---

## The agent loop is the spine

Everything user-facing flows through `backend/services/agent/loop.py:step()`. Read this function once and the system makes sense.

```
User event ──► POST /api/agent/turn ──► loop.step()
                                            │
                                            ▼
                                  ┌─────────────────────┐
                                  │ 1. Build prompt from│
                                  │    session history  │
                                  └──────────┬──────────┘
                                             ▼
                                  ┌─────────────────────┐
                                  │ 2. Call LLM         │ ◄── provider_service
                                  └──────────┬──────────┘
                                             ▼
                                  ┌─────────────────────┐
                                  │ 3. Parse JSON reply │ ◄── parser.parse_or_repair
                                  │    (tool/reply/ask) │
                                  └──────────┬──────────┘
                                             │
                       ┌─────────────────────┼─────────────────────┐
                       ▼                     ▼                     ▼
                  type=reply           type=tool_call           type=ask
                       │                     │                     │
                       │                     ▼                     │
                       │            tools.dispatch(name, args)     │
                       │                     │                     │
                       │                     ▼                     │
                       │            (envelope: success/data/ui)    │
                       │                     │                     │
                       │           append to session, loop again   │
                       │                     │ (≤ 6 iterations)    │
                       │                     ▼                     │
                       └────────────► return messages ◄────────────┘
```

The loop tops out at 6 tool calls per user turn. Tool results are fed back into the next prompt iteration so the agent can chain (scan → list_bins → resolve_clips → transcribe). When a tool emits a `ui` field with `kind: "request_scan"` or `"plan_apply_request"`, the loop breaks early and hands control to the frontend (only the frontend can drive ExtendScript).

**Tools live in `backend/services/agent/tools.py`.** Each is `async def name_tool(args, ws_emit, session) -> dict`. The dict shape is fixed:

```python
{
    "tool": str,
    "success": bool,
    "summary": str,       # ≤300 tokens, fed back to LLM
    "data": dict | None,  # structured result kept in session.context
    "ui": dict | None,    # optional UI card hint for frontend
    "error": str | None,
}
```

Adding a tool means: write the async function, register it in the `TOOLS` dict at the bottom of `tools.py`, add a schema to `prompts.py`. Three places, all colocated.

---

## Routes (`backend/routes/*.py`)

| Prefix | File | Purpose |
|---|---|---|
| `/api/chat` | `chat.py` | Legacy direct-LLM chat + WebSocket endpoint `/ws/{client_id}` |
| `/api/agent` | `agent.py` | The agent — `POST /turn`, `POST /reset`, `GET /debug/{session_id}` |
| `/api/whisper` | `whisper_admin.py` | Model selection, install detection, preload-with-progress |
| `/api/premiere` | `premiere.py` | Project context sync, items/bins/sequences listing, ExtendScript dispatch |
| `/api/pipeline` | `pipeline.py` | Legacy non-agent flow: analyze → cut → visuals |
| `/api/media` | `media.py` | Direct transcribe endpoint (not used by agent flow) |
| `/api/providers` | `providers.py` | LLM provider CRUD (Ollama, OpenAI, etc.) |
| `/api/models` | `models_routes.py` | Model discovery per provider |
| `/api/preflight` | `preflight.py` | Startup health checks (ffmpeg, whisper backend, ollama) |
| `/api/edit` | `edit.py` | Edit-plan persistence + apply |
| `/script-extract` | `script_extract.py` | DOCX/PDF script parsing |

The agent route is the active surface. The legacy `pipeline.py` flow exists but is reachable only if the user disables agent mode in Settings (`localStorage.editflow_agent_mode`).

---

## State boundaries

Three places hold state. Knowing which is which saves you debugging the wrong layer.

| Layer | Where | Lifetime | Examples |
|---|---|---|---|
| **Process** | Python globals in services | until restart | `whisper_service._model`, `provider_service._providers`, `session_store._sessions` |
| **Disk JSON** | `data/*.json` | persists | `provider_config.json`, `whisper_config.json` |
| **SQLite** | `data/editflow_v2.sqlite3` | persists | source transcripts, transcript words, plans |
| **Browser** | `localStorage` | per-machine | `editflow_agent_mode`, draft chat |
| **Premiere session** | `state.session` in panel JS | per-page-load | `clientId` for WS routing |

The agent's per-turn memory is in `session_store.get_or_create(session_id)`. The session has `.history` (events fed back to the LLM), `.context` (typed slots like `scan_result`, `selected_clips`, `transcripts_ready`, `current_plan_id`), and `.current_phase` (string for the agent's coarse stage tracking).

---

## Whisper service

`backend/services/whisper_service.py` is the largest file (~1200 LOC) but only three entry points matter:

- `transcribe_fingerprinted(source_path, ...)` — Phase B entry. Computes a content hash, checks cache (in-memory → JSON → SQLite), and only runs the model on miss. **This is what tools call.**
- `set_active_model(name)` — Persists the choice to `whisper_config.json`. Discards in-memory model only if the name actually changed (deliberate dedup; was missing before commit `00fdf1d`).
- `_load_model_with_progress()` — Wraps the `_load_model` thread call with a poller that watches `*.incomplete` blob files in the HF cache and broadcasts `whisper_download_progress` WS events. Silent for warm loads (no `.incomplete` → no events).

The HF cache lives at `data/hf-cache/`. The redirect is set in two places (defense in depth) — `run.py` (before any import) and `backend/config.py` (when settings load). Don't add new HF imports above the env-var assignment in run.py.

Transcripts are fingerprint-keyed: same file → same hash → same transcript reused. The fingerprint includes file content, audio range, engine name, and model name, so changing models invalidates the cache automatically.

---

## CEP panel

`cep-panel/client/` is a vanilla ES-module app. No bundler, no transpiler, no build. The files load directly into Premiere's CEF (Chromium Embedded Framework). Adobe's CSInterface lib bridges to ExtendScript.

| File | Responsibility |
|---|---|
| `main.js` | Entry. Initializes state, loads orchestrator dynamically, wires WS. **Holds the `CLIENT_ID` that the agent must echo back for WS routing.** |
| `state.js` | Simple reducer over `state.session.clientId` + chat history. Subscribed to via `subscribe(fn)`. |
| `api.js` | `apiGet/apiPost/apiPut/apiDelete/apiUpload` + `connectWS(clientId)` with auto-reconnect. Emits typed events via `on(type, fn)`. |
| `chat-ui.js` | `appendMessage(kind, payload)` + `updateProgress(id, …)`. Renders the chat scroll. |
| `agent-client.js` | Active orchestrator when agent mode is on. `_postTurn(event, payload)` calls `/api/agent/turn` and renders the response. Owns `onWsProgress` for transcribe events. |
| `orchestrator.js` | Legacy state-machine orchestrator. Only loaded when agent mode is off. |
| `settings.js` | Settings panel. Whisper model picker, provider CRUD, Whisper download progress bar. |
| `extendscript.js` | `callExtendScript(fn, args)` wrapper + scan/cut helpers. |

`main.js` dynamically imports `agent-client.js` or `orchestrator.js` based on a `localStorage` flag. The import URL includes `?v=${BUILD_TAG}` so cache busting works across deploys (CEF caches modules aggressively otherwise; see `PLATFORM.md`).

Static panel assets are served by `_NoCacheStatic` in `backend/main.py` — a `StaticFiles` subclass that adds `Cache-Control: no-store` to every response. Without this, CEF refuses to refetch JS even after the file changes on disk.

---

## WebSocket contract

One WS per panel session. URL: `/api/chat/ws/{client_id}`. The client_id is generated by `main.js` and stored in `state.session.clientId`. **Every HTTP request that wants to push WS messages must echo this client_id in the body** (see `agent.py`'s `TurnRequest.client_id`).

Message envelope:

```json
{ "type": "<event_type>", "payload": { ... } }
```

Event types the panel handles:

| Type | Direction | Producer | Renderer |
|---|---|---|---|
| `progress` | server→panel | `ProgressReporter` (any route) | `onWsProgress` in agent-client.js / orchestrator.js |
| `agent_tool` | server→panel | `loop.step()` + tool internals | `onWsProgress` (tool start/clip_done/completed) |
| `whisper_download_progress` | server→panel | `whisper_service._load_model_with_progress` | `onWhisperDownloadProgress` in settings.js |

`progress` events broadcast (no `client_id` filter) because `transcribe_clips_tool` doesn't currently thread the client_id through. `agent_tool` events use `manager.send_to(client_id, msg)` and require correct client_id wiring on both ends.

---

## Provider service

`provider_service.py` is the multi-LLM abstraction. Providers are stored in `data/provider_config.json`. Each has an `endpoint`, optional `api_key`, a `chat_model`, optionally a `vision_model`. `provider_service.chat(messages, ...)` picks the active provider, formats payload for that flavor (Ollama, OpenAI-compatible, etc.), handles errors, and returns `{response, model, error?}`.

The active chat model is also persisted; on a fresh boot it falls back to `settings.DEFAULT_CHAT_MODEL` (which we deliberately changed away from `gemma3:4b` since it caused 404 spam — see commit `5bdfb87`).

Ollama-specific behavior: 180s timeout (cold loads of 4B+ models are slow), `keep_alive=30m` so the model stays in memory between calls.

---

## SQLite registry

`backend/models/sqlite_registry.py` initializes `data/editflow_v2.sqlite3`. Three tables matter:

- `source_transcripts` — one row per `(content_hash, range_in, range_out, engine, model)`. Stores full transcript JSON.
- `transcript_words` — per-word timing rows. Indexed by transcript id.
- `edit_plans` — versioned cut plans tied to a session.

The registry is **mostly a cache** — its data can be deleted and the system rebuilds (slowly) on next transcribe. Schema migrations are not yet a thing; if you add a column, you add a `CREATE TABLE IF NOT EXISTS` for the new shape and accept that old DBs lose any conflicting state. Don't ALTER TABLE without a migration plan.

---

## What lives in `data/` (gitignored)

```
data/
├── hf-cache/                # HuggingFace models (1.5–3 GB each, lives ON G: drive)
│   └── models--Systran--faster-whisper-medium/snapshots/.../model.bin
├── media_cache/             # Extracted .wav from videos + JSON transcripts
│   └── transcripts/<fingerprint>.json
├── output/                  # User-facing exports (edit plans, EDLs)
├── tools/                   # Bundled ffmpeg binary
│   └── ffmpeg-8.1.1-full_build/bin/ffmpeg.exe
├── provider_config.json     # LLM providers (persists across restart)
├── whisper_config.json      # Active Whisper model name
└── editflow_v2.sqlite3      # The registry
```

Everything under `data/` is runtime state. The repo doesn't ship any of it. The user populates `data/tools/ffmpeg-*/` once at setup; Whisper models download on first preload.

---

## Conventions that aren't enforceable by lint

- **Tools never raise.** Wrap real work in `try/except`, return `success=False` with an `error` string. The agent loop's outer try/except is a safety net, not a primary handler.
- **`logger.exception` for exceptions you swallow, `logger.warning` for recoverable, `logger.info` for happy-path milestones.** Silent `except: pass` is a bug waiting to be found.
- **Path manipulation uses `pathlib.Path`.** String paths sneak in around the ExtendScript boundary; coerce on entry.
- **Async callers, sync helpers.** Heavy CPU work (Whisper inference, ffmpeg) goes through `asyncio.to_thread`. Don't `time.sleep` in an async function.
- **The progress bar invariants:** `ProgressReporter(task_type="transcribe", client_id="")` for any user-facing transcribe-ish task. Wrong `task_type` silently drops events on the panel side — see commit `5b58a4f`.
- **Build tag bumps on every panel-affecting change.** `BUILD_TAG` in `main.js` AND `?v=...` in `cep-loader.html`. Without both, CEF serves stale modules.

---

## Where to look first when something breaks

| Symptom | First place to look |
|---|---|
| Panel shows old behavior after a fix | `BUILD_TAG` not bumped, or CEF cache. See `PLATFORM.md` § CEF cache. |
| `/api/agent/turn` returns 500 | Top-level try/except in `agent.py` wraps it now; the panel shows the exception class+message. Real cause is in the backend log. |
| Tool ran but agent didn't see the result | Check `_envelope()` shape — `data=None` is fine, `data.get(...)` on `None` is not. |
| Transcription completes but chat doesn't update | `task_type` not `"transcribe"`, or `_progressMsgId` is stale. Both are easy to verify with `print` in `agent-client.js`. |
| Ollama disconnects mid-chat | RAM pressure or the cold-load took >180s. Try a smaller model. |
| New HF download lands on C: not G: | Something imported `huggingface_hub` before `run.py` set `HF_HUB_CACHE`. |

When in doubt: the backend log is honest. The panel UI is a derived view.

---

## Review editor (v2) — the emerging primary surface

Newer than the agent loop above. A **transcript-first, word-level cut editor**
(`cep-panel/client/src/review-view.js`, opened by the 📝 header button or
`/review`). You paste a transcript (ElevenLabs **Scribe SRT** or Gemini JSON),
see every **word**, play/scrub with a karaoke highlight, **select a span and
Cut/Restore** it (so you keep part of a sentence), preview **Play plan** (kept
words only), then **Build**.

Backend: `backend/routes/review.py` + `services/review_service.py`
(parse/tighten/classify/**words**) + `services/review_media.py` (H.264 **proxy**
so HEVC plays in CEF, **waveform peaks**, **silencedetect** for tightening).
Endpoints: `POST /api/review/ingest` → `{words[], media_url, word_summary}`,
`GET /media/{id}` (range-streamed proxy), `GET /waveform/{id}`,
`POST /suggest`, `POST /build {kept_word_ids}`.

Word times are **approximate** today (interpolated from SRT cue spans by char
length); **Scribe** will supply exact per-word times (roadmap P3). The editor is
source-agnostic — it only needs `{words[]}`.

## The one cut-apply backbone (every path funnels here)

```
kept spans → external_plan.build_plan_from_pasted_json → plan_store (data/plans/)
           → POST /api/edit/plan/{id}/apply → ExtendScript processEDL → "EditFlow Cut"
```

The Review editor, the legacy matcher (`/api/edit/analyze`), and the `/paste-plan`
command all converge on this. **Don't write new timeline code — emit cuts and
reuse this path.**

## Gotchas added since the original doc
- **`cep-panel/client/index.html` is DEAD.** The manifest's MainPath is
  `client/cep-loader.html`, which serves the panel and loads `main.js` from the
  no-store `/panel` mount. Edit `cep-loader.html`, not `index.html`.
- `review.css` self-injects from `review-view.js` with a `?v=<timestamp>` so it
  dodges CEF's stylesheet cache (a plain `<link>` got stuck on a cached miss).
- `review-view.js` is dynamic-imported by `main.js` with the `BUILD_TAG` buster
  and exposed as `window.__editflowOpenReview` (so `/review` in the orchestrator
  can open it without a second un-busted import).

## Plans (read for direction)
- **`docs/plans/production-roadmap.md`** — master plan + full-system audit (start here).
- **`docs/plans/word-level-editor.md`** — the word-editor spec & phases.
