# AE Agent Dev Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent build, run, verify, and fix AE caption code **without a human clicking anything in After Effects** — local Adobe docs to consult, an HTTP bridge to execute ExtendScript in a live AE, machine-readable evidence (layer dumps + rendered frames + error logs), and hot reload of panel+jsx without restarting AE.

**Architecture:** The FastAPI backend (running on the AE PC) becomes the agent's remote control. The CEP panel keeps its existing WebSocket to the backend; a new `/api/agent/*` route forwards eval jobs over that socket, the panel runs them via `callExtendScript`, and posts results back. Verification evidence is JSON layer inventories (`ef_dumpLayers`), PNG frame renders (existing `saveFrameToPng` path), and the existing `/api/diag/log` sink extended with a tail endpoint. A file watcher pushes "reload" over the socket so code changes go live with zero clicks (a panel button covers the case where the socket is down).

**Tech Stack:** FastAPI + existing WS plumbing, CEP panel (vanilla JS), ExtendScript (ES3), `watchfiles` (already a FastAPI/uvicorn dep), git-cloned docsforadobe repos, pytest + node:test.

**Deployment reality:** AE 2026 lives on the other PC. The backend must run there. Two supported agent positions: (a) Claude Code running on the AE PC (simplest, recommended), (b) agent on this PC calling `http://<ae-pc>:8765` over LAN. The bridge is plain HTTP either way; nothing else changes.

**Scope discipline (builder's-trap guard):** Phases 1–3 are the loop and are small. Phase 0 is an hour of cloning. Phase 5 (single-layer pills) is the first real consumer and the proof the loop works. Nothing speculative beyond that — no dashboards, no CI, no multi-app abstraction.

---

## File map

| File | Responsibility |
|---|---|
| `docs/adobe/` | NEW. Cloned official docs (scripting guide, expressions, CEP). Read-only reference. |
| `docs/adobe/INDEX.md` | NEW. Map: which question → which folder/file. |
| `backend/routes/agent_bridge.py` | NEW. `/api/agent/eval`, `/api/agent/result/{job}`, `/api/agent/health`, `/api/agent/frame`. |
| `backend/routes/diag.py` | Modify. Add `GET /api/diag/log/tail?n=`. |
| `backend/main.py` (or router registry) | Modify. Mount agent_bridge behind `EDITFLOW_AGENT_BRIDGE=1`. |
| `cep-panel-ae/client/src/agent-bridge.js` | NEW. WS `agent_eval` handler → `callExtendScript` → POST result. Plus `devReload()`. |
| `cep-panel-ae/client/src/main.js` | Modify. Route WS messages `agent_eval` / `dev_reload` to agent-bridge.js; add 🔁 button to header. |
| `cep-panel-ae/extendscript/index.jsx` | Modify. Add `ef_dumpLayers`, `ef_renderFrameAt`, `ef_setupTestComp`, `ef_reloadJsx` support. |
| `backend/services/dev_watch.py` | NEW. watchfiles → WS broadcast `dev_reload`. Dev-only. |
| `tests/unit/test_agent_bridge.py` | NEW. pytest: job queue, timeout, result routing, auth gate. |
| `tests/jsx-expressions.test.js` | Modify. Sandbox-eval coverage for `ef_dumpLayers` serialization helper. |
| `tests/fixtures/ae/` | NEW. `caption-smoke.wav` (2s tone) used by `ef_setupTestComp`. |
| `docs/ae-agent-workflow.md` | NEW. The agent's operating manual (loop, endpoints, assertions). |
| `CLAUDE.md` | Modify. Two rules: consult `docs/adobe/` before web; use the bridge before claiming AE code works. |

---

## Phase 0 — Adobe docs mirror

### Task 0.1: clone official docs into `docs/adobe/`

**Files:** Create `docs/adobe/INDEX.md`; cloned repos (checked in as plain files, no submodules — agents can't fetch mid-task).

- [ ] **Step 1: Clone doc sources (docs content only, shallow)**

```bash
cd docs && mkdir adobe && cd adobe
git clone --depth 1 https://github.com/docsforadobe/after-effects-scripting-guide scripting-guide
git clone --depth 1 https://github.com/docsforadobe/after-effects-expression-reference expressions
git clone --depth 1 https://github.com/Adobe-CEP/CEP-Resources cep
# strip .git dirs so these are plain files in our repo
rm -rf scripting-guide/.git expressions/.git cep/.git
# CEP repo is huge — keep only CEP 12 docs + Getting Started guides
```

Keep: `cep/CEP_12.x/` docs + `Documentation/` cookbook HTML/MD. Delete sample-app payloads over ~1 MB.

- [ ] **Step 2: Write `docs/adobe/INDEX.md`**

```markdown
# Adobe docs mirror — where to look

Cloned from docsforadobe + Adobe-CEP (July 2026). Refresh: re-run the clone
commands in docs/superpowers/plans/2026-07-18-ae-agent-dev-loop.md Task 0.1.

| Question | Look in |
|---|---|
| ExtendScript API (Layer, TextDocument, addProperty, match names) | `scripting-guide/docs/` (search *.md, e.g. `text/textdocument.md`, `matchnames/`) |
| Expression language (textIndex, selectorValue, ease) | `expressions/docs/` |
| CEP manifest, CSInterface, evalScript, panel lifecycle, debugging | `cep/CEP_12.x/Documentation/` |
| What AE version supports what | `scripting-guide/docs/introduction/changelog.md` |

Rule: for AE/CEP API questions, grep here FIRST. Web search only if the
answer is missing or version-ambiguous — then record what was missing here.
```

- [ ] **Step 3: Add the rule to `CLAUDE.md`**

```markdown
## Rule 9 — AE/CEP API questions: local docs first
Grep `docs/adobe/` (INDEX.md maps topics) before web-searching AE scripting,
expressions, or CEP questions. Cite the file you used.
```

- [ ] **Step 4: Commit** — `docs(adobe): mirror official AE scripting/expression/CEP docs + index`

---

## Phase 1 — Agent bridge (execute ExtendScript over HTTP)

### Task 1.1: backend bridge routes (TDD)

**Files:** Create `backend/routes/agent_bridge.py`, `tests/unit/test_agent_bridge.py`. Modify router registration (same place `diag.py` is mounted).

- [ ] **Step 1: Write failing tests**

```python
# tests/unit/test_agent_bridge.py
import asyncio
import pytest
from backend.routes import agent_bridge as ab

@pytest.mark.asyncio
async def test_eval_roundtrip():
    """A job forwarded to the panel resolves when the panel posts its result —
    the core contract the whole agent loop depends on."""
    sent = []
    ab._send_to_panel = lambda msg: sent.append(msg) or True
    task = asyncio.create_task(ab.run_job("ef_ping", [], timeout=5))
    await asyncio.sleep(0)
    job_id = sent[0]["job_id"]
    ab.complete_job(job_id, {"ok": True, "result": "pong"})
    assert (await task)["result"] == "pong"

@pytest.mark.asyncio
async def test_eval_timeout_returns_error_not_hang():
    ab._send_to_panel = lambda msg: True
    with pytest.raises(ab.JobTimeout):
        await ab.run_job("ef_ping", [], timeout=0.05)

@pytest.mark.asyncio
async def test_eval_without_panel_fails_fast():
    ab._send_to_panel = lambda msg: False   # no panel connected
    with pytest.raises(ab.PanelUnavailable):
        await ab.run_job("ef_ping", [], timeout=5)
```

- [ ] **Step 2: Run** `pytest tests/unit/test_agent_bridge.py -v` → FAIL (module missing).

- [ ] **Step 3: Implement `backend/routes/agent_bridge.py`**

```python
"""Agent bridge: lets an agent execute panel ExtendScript calls over HTTP.
Enabled only when EDITFLOW_AGENT_BRIDGE=1 (dev tool, not a product feature)."""
import asyncio, os, uuid
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/agent", tags=["agent"])

class JobTimeout(Exception): ...
class PanelUnavailable(Exception): ...

_jobs: dict[str, asyncio.Future] = {}

def _send_to_panel(msg: dict) -> bool:
    """Send over the existing panel WebSocket. Wired to the ws manager at
    startup (same broadcast used for transcription progress). Returns False
    when no panel is connected."""
    raise NotImplementedError  # patched in main.py wiring / tests

async def run_job(fn: str, args: list, timeout: float = 30):
    job_id = uuid.uuid4().hex
    fut: asyncio.Future = asyncio.get_event_loop().create_future()
    _jobs[job_id] = fut
    try:
        if not _send_to_panel({"type": "agent_eval", "job_id": job_id, "fn": fn, "args": args}):
            raise PanelUnavailable(fn)
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            raise JobTimeout(f"{fn} after {timeout}s")
    finally:
        _jobs.pop(job_id, None)

def complete_job(job_id: str, payload: dict):
    fut = _jobs.get(job_id)
    if fut and not fut.done():
        fut.set_result(payload)

class EvalReq(BaseModel):
    fn: str
    args: list = []
    timeout: float = 30

@router.post("/eval")
async def agent_eval(req: EvalReq):
    try:
        return await run_job(req.fn, req.args, req.timeout)
    except PanelUnavailable:
        raise HTTPException(503, "Panel not connected — is AE open with the extension loaded?")
    except JobTimeout as e:
        raise HTTPException(504, f"ExtendScript call timed out: {e}")

class ResultReq(BaseModel):
    ok: bool
    result: object = None
    error: str | None = None

@router.post("/result/{job_id}")
async def agent_result(job_id: str, req: ResultReq):
    complete_job(job_id, req.model_dump())
    return {"ok": True}

@router.get("/health")
async def agent_health():
    """Full-loop health: backend up, panel connected, AE answering."""
    try:
        r = await run_job("ef_ping", [], timeout=5)
        return {"backend": True, "panel": True, "ae": r.get("result") == "pong"}
    except PanelUnavailable:
        return {"backend": True, "panel": False, "ae": False}
    except JobTimeout:
        return {"backend": True, "panel": True, "ae": False}
```

- [ ] **Step 4: Mount behind env flag** (in the same module that mounts `diag.router`):

```python
if os.environ.get("EDITFLOW_AGENT_BRIDGE") == "1":
    app.include_router(agent_bridge.router)
    agent_bridge._send_to_panel = ws_manager.send_to_active_panel  # actual ws send
```

If `send_to_active_panel` doesn't exist on the ws manager yet, add it: send JSON to the most recent panel client, return `False` when none.

- [ ] **Step 5: Run tests** → PASS. **Commit** `feat(dev): agent bridge — HTTP eval of panel ExtendScript`.

### Task 1.2: panel-side executor

**Files:** Create `cep-panel-ae/client/src/agent-bridge.js`. Modify `cep-panel-ae/client/src/main.js` (WS message routing — same switch that handles transcription progress).

- [ ] **Step 1: Implement `agent-bridge.js`**

```js
/* Executes agent_eval jobs pushed over the backend WebSocket and posts the
   result back. Dev tool: does nothing unless a job arrives. */
import { callExtendScript } from './extendscript.js';
import { apiPost } from './api.js';   // match the panel's existing helper name

export async function handleAgentEval(msg) {
  const { job_id, fn, args } = msg;
  let payload;
  try {
    const result = await callExtendScript(fn, ...(args || []));
    payload = { ok: true, result };
  } catch (e) {
    payload = { ok: false, error: String(e.message || e) };
  }
  try { await apiPost(`/api/agent/result/${job_id}`, payload); } catch (_) {}
}
```

- [ ] **Step 2: Route it in `main.js`** WS handler: `if (msg.type === 'agent_eval') return handleAgentEval(msg);`

- [ ] **Step 3: Verify without AE (browser rig):** open `http://127.0.0.1:8765/panel-ae/cep-loader.html` with `EDITFLOW_AGENT_BRIDGE=1`, then `curl -X POST http://127.0.0.1:8765/api/agent/eval -H "Content-Type: application/json" -d '{"fn":"ef_ping"}'` → expect `{"ok": false, "error": "CSInterface not available"}` routed back through the full loop (proves plumbing; AE just isn't there).

- [ ] **Step 4: Commit** `feat(dev): panel executes agent bridge jobs`.

---

## Phase 2 — Evidence: layer dumps, frame renders, log tail

### Task 2.1: `ef_dumpLayers` (jsx)

**Files:** Modify `cep-panel-ae/extendscript/index.jsx`; extend `tests/jsx-expressions.test.js`.

- [ ] **Step 1: Implement**

```js
/* Machine-readable inventory of caption layers — the agent's eyes.
   Includes text-animator structure so word-by-word wiring is assertable. */
function ef_dumpLayers() {
    try {
        var comp = ef_getComp();
        if (!comp) return ef_err("No comp");
        var out = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            var d = { name: L.name, comment: L.comment || "",
                      inPoint: L.inPoint, outPoint: L.outPoint };
            try { d.position = L.property("Position").value; } catch (e1) {}
            try { d.scale = L.property("Scale").value; } catch (e2) {}
            try { d.text = L.property("Source Text").value.text; } catch (e3) {}
            try {
                var anims = L.property("ADBE Text Properties").property("ADBE Text Animators");
                if (anims && anims.numProperties) {
                    d.animators = [];
                    for (var a = 1; a <= anims.numProperties; a++) {
                        var an = anims.property(a);
                        var ad = { name: an.name, selectors: [] };
                        var sels = an.property("ADBE Text Selectors");
                        for (var s = 1; s <= sels.numProperties; s++) {
                            var sel = sels.property(s);
                            var sd = { matchName: sel.matchName };
                            try { sd.basedOn = sel.property("ADBE Text Range Type2").value; } catch (e4) {}
                            try { sd.expr = String(sel.property("ADBE Text Expressible Amount").expression).substr(0, 300); } catch (e5) {}
                            ad.selectors.push(sd);
                        }
                        d.animators.push(ad);
                    }
                }
            } catch (e6) {}
            out.push(d);
        }
        return ef_json({ comp: comp.name, width: comp.width, height: comp.height,
                         frameRate: comp.frameRate, layers: out });
    } catch (e) { return ef_err("dumpLayers: " + e.toString()); }
}
```

- [ ] **Step 2: Node test** (vm sandbox already loads index.jsx): assert `typeof sandbox.ef_dumpLayers === 'function'`; call with a mocked `ef_getComp` returning a fake comp of stub layers and assert JSON shape (`layers[0].inPoint` present). Run `node --test tests/jsx-expressions.test.js` → PASS.

- [ ] **Step 3: Commit** `feat(dev): ef_dumpLayers — layer inventory for agent assertions`.

### Task 2.2: frame render endpoint

**Files:** Modify `index.jsx` (add `ef_renderFrameAt`), `backend/routes/agent_bridge.py`.

- [ ] **Step 1: jsx — reuse the WORKING saveFrameToPng path** from `ef_getCurrentFrame` (index.jsx:149, verified in AE per commit f087828), parameterized by time:

```js
function ef_renderFrameAt(t, outPath) {
    // identical to ef_getCurrentFrame's [5d] saveFrameToPng branch, but at
    // time t and writing to outPath; returns {"path": outPath, "time": t}
}
```

Extract the shared body into `ef_saveFrame(comp, t, outFile)` used by both — don't duplicate the fallback chain.

- [ ] **Step 2: backend**

```python
@router.get("/frame")
async def agent_frame(t: float):
    out = str(FRAMES_DIR / f"frame_{t:.3f}.png")   # backend temp dir
    r = await run_job("ef_renderFrameAt", [t, out], timeout=30)
    if not r.get("ok"): raise HTTPException(500, r.get("error", "render failed"))
    return FileResponse(out, media_type="image/png")
```

- [ ] **Step 3: Verification is AE-gated** — record in commit message: "verified via bridge on AE PC" or "pending AE". The agent on the AE PC runs: `curl -o f.png "http://127.0.0.1:8765/api/agent/frame?t=1.2"` then **Reads the PNG** to see the caption.

- [ ] **Step 4: Commit** `feat(dev): frame render endpoint — agent can SEE the comp`.

### Task 2.3: error log auto-read

**Files:** Modify `backend/routes/diag.py`, `cep-panel-ae/client/src/main.js`, `index.jsx`.

- [ ] **Step 1: diag tail endpoint** (pytest first, in existing `tests/unit/test_diag_logsink.py` style):

```python
@router.get("/log/tail")
async def diag_log_tail(n: int = 200):
    lines = _read_sink_lines()          # existing sink file
    return {"lines": lines[-n:]}
```

- [ ] **Step 2: panel — forward ALL errors to the sink.** In `main.js`: `window.onerror` + `window.onunhandledrejection` + a wrapper so every `callExtendScript` rejection POSTs `/api/diag/log` with `{source:"panel", fn, error}`. jsx already returns `ERROR:` strings — they arrive via those rejections, so no jsx change needed.

- [ ] **Step 3: Commit** `feat(dev): log tail endpoint + panel error forwarding`.

### Task 2.4: self-contained test comp

**Files:** Modify `index.jsx`; create `tests/fixtures/ae/caption-smoke.wav` (generate: `python -c "..."` 2s 440 Hz tone, or ffmpeg `-f lavfi -i sine=frequency=440:duration=2`).

- [ ] **Step 1: `ef_setupTestComp(audioPath)`** — imports the wav, creates `EF Smoke 1080x1920x30fps` comp (duration = audio + 1s), adds the audio layer, opens it in the viewer, returns comp info JSON. Idempotent: reuse existing comp by name.
- [ ] **Step 2: Commit** `feat(dev): ef_setupTestComp — agent bootstraps a comp on fresh AE`.

---

## Phase 3 — Zero-click reload

### Task 3.1: reload machinery

**Files:** Modify `agent-bridge.js`, `main.js`, `index.jsx` (nothing — jsx re-eval is driven from the panel).

- [ ] **Step 1: `devReload()` in agent-bridge.js**

```js
export async function devReload() {
  // Re-eval index.jsx inside AE (functions are globals — redefinition is hot
  // swap, no AE restart), then reload the panel page for fresh client code.
  try {
    const ext = window.__adobe_cep__ ? new CSInterface().getSystemPath(SystemPath.EXTENSION) : null;
    if (ext) await evalScriptRaw('$.evalFile(new File("' + (ext + '/extendscript/index.jsx').replace(/\\/g, '/') + '"))');
  } catch (e) { /* logged via the callExtendScript error forwarder */ }
  location.reload();
}
```

(`evalScriptRaw` = the existing raw helper in extendscript.js:106.)

- [ ] **Step 2: 🔁 button** in the panel header (`main.js`), calls `devReload()`. This is the ONE thing the user ever clicks, and only when the WS is down.
- [ ] **Step 3: WS trigger:** `if (msg.type === 'dev_reload') return devReload();`
- [ ] **Step 4: Commit** `feat(dev): one-click panel+jsx hot reload`.

**Known limit (document in workflow doc):** CSXS `manifest.xml` changes still need an AE restart — nothing can hot-swap the manifest.

### Task 3.2: file watcher → auto reload

**Files:** Create `backend/services/dev_watch.py`; wire in app startup behind the same env flag.

- [ ] **Step 1: Implement**

```python
"""Watch cep-panel-ae/ and push dev_reload to the panel. Dev-only."""
from watchfiles import awatch

async def watch_panel(ws_manager, root):
    async for changes in awatch(root / "cep-panel-ae"):
        ws_manager.send_to_active_panel({"type": "dev_reload",
            "files": [str(p) for _, p in changes]})
```

Startup: `asyncio.create_task(watch_panel(...))` when `EDITFLOW_AGENT_BRIDGE=1`.

- [ ] **Step 2: Loop closes:** agent edits index.jsx → watcher fires → panel re-evals jsx + reloads → agent's next `/api/agent/eval` runs the NEW code. No human.
- [ ] **Step 3: Commit** `feat(dev): file watcher auto-reloads panel+jsx on change`.

---

## Phase 4 — Codify the workflow

### Task 4.1: `docs/ae-agent-workflow.md` + CLAUDE.md rule

- [ ] **Step 1: Write the operating manual.** Contents (complete, not TBD):
  1. **Setup (human, once per session):** on AE PC run `EDITFLOW_AGENT_BRIDGE=1 python run.py`, open AE, open the EditFlow extension. Done — walk away.
  2. **Agent loop:** `GET /api/agent/health` (all three true?) → edit code → node tests → *(watcher auto-reloads)* → `POST /api/agent/eval {"fn":"ef_setupTestComp","args":[...]}` → eval the function under test → `POST eval ef_dumpLayers` + assert → `GET /api/agent/frame?t=...` + Read PNG → `GET /api/diag/log/tail` after ANY failure → fix → repeat.
  3. **Evidence standards:** a change is "AE-verified" only with a dumpLayers assertion AND a frame render showing it. Otherwise commit says "not yet AE-verified".
  4. **When the human is needed:** manifest changes (AE restart), font installs, license dialogs, visual taste calls (attach the frame PNGs to the question).
  5. Endpoint reference table with curl examples.
- [ ] **Step 2: CLAUDE.md Rule 10:** "AE code claims require bridge evidence (dumpLayers + frame) when the bridge is reachable; otherwise say 'not yet AE-verified'."
- [ ] **Step 3: Commit** `docs(dev): AE agent workflow manual`.

---

## Phase 5 — First consumer: single-layer pills (agent-verified)

Pills join the one-layer-per-caption engine (user decision 2026-07-18: single layer even with pills). Built LAST deliberately: pill geometry (word spans on wrapped, auto-shrunk, centered text) is exactly the code that fails blind — the agent verifies it via the bridge with frame renders.

### Task 5.1: word-span measurement + pills in `ef_buildCaptionLayer`

**Files:** Modify `cep-panel-ae/extendscript/index.jsx`; extend `tests/jsx-expressions.test.js` (pure-geometry helper tests).

- [ ] **Step 1: `ef_measureWordSpans(comp, g, cfg, lineTexts)`** — one temp text layer styled via `ef_styleDoc`; per line: set `sourceText` to the full line → `lineWidth`; per word k: prefix `words[0..k]` joined `" "` → `right_k = width(prefix)`, `left_k = right_k - width(word_k alone)`; span in comp coords: `lineLeft = centerX - lineWidth/2`, plus line Y = `posYpx + (li - (nLines-1)/2) * fontSize*1.2`. Remove temp layer in `finally`-style try/catch. Return `[{left,right,lineIdx}]` per word.
- [ ] **Step 2: pure split-out for node tests:** the arithmetic (`left/right from prefix widths`, line Y from index) goes in `ef_pillSpanMath(prefixWidths, wordWidths, lineWidths, opts)` — testable in the vm sandbox with fake widths; the AE-API measuring stays thin.
- [ ] **Step 3: pills in `ef_buildCaptionLayer`:** merge adjacent pill words per line (reuse the run-merging shape from `ef_buildGroup`), pill shape per run: size from span + pads (`x=fontSize*0.28, y=fontSize*0.16`), `inPoint = firstWord.start`, `outPoint = g.tOut`, existing `ef_buildPillScale`/`ef_buildFadeUpOp` expressions, `moveAfter(textLayer)`. **Auto-shrink coupling:** if the text layer got scaled by factor `s`, transform every span about (posX,posY): `x' = cx + (x-cx)*s`, sizes ×= s, line Y likewise.
- [ ] **Step 4: route pill groups to the single-layer builder** — in `ef_createCaptions` drop the `!ef_groupHasPill(groups[i])` condition; keep `ef_buildGroup` as the probe-failure fallback only.
- [ ] **Step 5: node tests** for `ef_pillSpanMath` (spans ordered, within line bounds, shrink transform correct) → PASS.
- [ ] **Step 6: agent verification via bridge:** setupTestComp → generate a 2-line caption with pills on words 2–3 → `ef_dumpLayers` asserts: ONE `Caption:` text layer, N pill shapes with `inPoint == their word's start` → frame renders at word-2 start ±0.1s show the pill appearing under the right word → attach PNGs to the commit message summary.
- [ ] **Step 7: Commit** `feat(ae): pills join the single-layer caption engine (agent-verified)`.

---

## Self-review

- **Coverage vs request:** docs folder → Phase 0; agent checks on its own → Phases 1–2; error logging + agent reads errors → Task 2.3; reload button instead of reopening AE/extension → Phase 3 (button + zero-click watcher); single-layer pills → Phase 5. ✓
- **Ordering rationale:** loop before pills, so the first risky geometry code is born verified. ✓
- **Names consistent:** `run_job/complete_job/_send_to_panel`, `handleAgentEval`, `devReload`, `ef_dumpLayers`, `ef_renderFrameAt`, `ef_setupTestComp`, `ef_measureWordSpans`, `ef_pillSpanMath` used identically across tasks. ✓
- **Risks:** WS single-client assumption (panel reconnect races — `send_to_active_panel` returns False, agent retries per workflow doc); `saveFrameToPng` availability (already probed/fallback-chained in existing code); evalScript payload limits (already handled by 10-group batching); LAN exposure (env-flag gate + bind address documented in workflow doc — never enable outside the home network).
- **Not in scope:** CI, multi-app abstraction, Premiere parity, auto-fix daemons. YAGNI until the loop has been used for a week.
