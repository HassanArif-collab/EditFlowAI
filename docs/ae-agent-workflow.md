# AE Agent Workflow — build, run, verify without a human in the loop

How an agent develops against a live After Effects using the bridge.
Companion docs: `docs/adobe/INDEX.md` (API reference mirror),
`docs/ae-captions-runbook.md` (human sign-off checklist).

## One-time human setup (per session, on the AE PC)

1. Start the backend with the bridge enabled:
   ```powershell
   $env:EDITFLOW_AGENT_BRIDGE = "1"; python run.py
   ```
2. Open After Effects, open the EditFlow extension (Window → Extensions).
3. Done — walk away. Everything below is agent-side.

Security: the bridge is remote eval. It only mounts with
`EDITFLOW_AGENT_BRIDGE=1`, and the backend must never be exposed beyond the
local network while enabled.

## The loop

```
health → edit code → node tests → (watcher auto-reloads panel+jsx)
       → eval smoke → dumpLayers asserts → frame renders → log tail on ANY failure
       → fix → repeat
```

1. **Health** — is the full chain alive?
   ```bash
   curl http://127.0.0.1:8765/api/ae-bridge/health
   # {"backend":true,"panel":true,"ae":true}  ← all three or stop and report
   ```
2. **Edit code.** jsx + panel changes hot-reload ~2s after save (backend
   file watcher pushes `dev_reload`; the panel re-evals index.jsx and
   reloads itself). Manifest.xml changes are the ONE thing that still
   needs an AE restart.
3. **Node tests** — `node --test tests/caption-model.test.js tests/jsx-expressions.test.js`
4. **Bootstrap a comp** (fresh AE, no project needed):
   ```bash
   curl -X POST http://127.0.0.1:8765/api/ae-bridge/eval -H "Content-Type: application/json" \
     -d '{"fn":"ef_setupTestComp","args":["<repo>/tests/fixtures/ae/caption-smoke.wav"]}'
   ```
5. **Exercise the code under test** — any `ef_*` function, e.g.
   ```bash
   curl -X POST http://127.0.0.1:8765/api/ae-bridge/eval -H "Content-Type: application/json" \
     -d '{"fn":"ef_createCaptions","args":["{\"groups\":[...],\"preset\":\"fadeup_words\",\"fontSize\":80}"]}'
   ```
   (Panel-shaped payloads: see `_buildGroupsPayload`/`_buildConfig` in
   captions-view.js for the exact cfg the panel sends.)
6. **Structural assertions** — `{"fn":"ef_dumpLayers"}` returns every
   layer with name/comment/in/out/position/scale/text/animators/selector
   expressions. Assert against it (one `Caption:` layer per group, `EF Word
   Fade` + `EF Word Rise` animators, pill `inPoint` == its word's start …).
7. **Visual proof** — render frames and LOOK at them:
   ```bash
   curl -o /tmp/f.png "http://127.0.0.1:8765/api/ae-bridge/frame?t=1.2"
   ```
   Read the PNG. A word mid-fade at its start time, pills under the right
   words, nothing outside the comp.
8. **Errors** — after ANY failure:
   ```bash
   curl "http://127.0.0.1:8765/api/diag/log/tail?n=100"
   ```
   Panel window errors, jsx `ERROR:` returns, and agent_eval failures all
   land in this sink.

## Evidence standard (CLAUDE.md Rule 10)

A change is **AE-verified** only with (a) a dumpLayers assertion AND
(b) at least one rendered frame showing the behavior. Otherwise commits and
reports say "not yet AE-verified" and point at the runbook.

## When the human is needed

- manifest.xml / CSXS changes (AE restart)
- installing fonts or models, license dialogs
- taste calls ("does this animation feel right?") — attach frame PNGs
- first-time extension install (`install-editflow-ae.bat`)

## Endpoint reference

| Endpoint | Purpose |
|---|---|
| `GET  /api/ae-bridge/health` | backend/panel/AE liveness |
| `POST /api/ae-bridge/eval` `{fn,args,timeout}` | run any ef_* in AE |
| `GET  /api/ae-bridge/frame?t=` | PNG of active comp at time t |
| `GET  /api/diag/log/tail?n=` | last n log lines (panel+jsx errors) |
| `POST /api/diag/log` | (panel-internal) error relay |

Useful jsx tools: `ef_ping`, `ef_getCompInfo`, `ef_setupTestComp(wav)`,
`ef_dumpLayers`, `ef_renderFrameAt(t, path)`, `ef_createCaptions(cfgJson)`,
`ef_clearCaptions`, `ef_readDebugLog`.
