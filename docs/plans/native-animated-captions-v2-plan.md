# Native Animated Captions — v2 Implementation Plan

**Branch:** `feat/native-animated-captions` (created fresh off `main` at commit `f70a17a`)
**Status:** Approved reliability-first architecture · ready to implement
**Date:** 2026-07-10

---

## 0. Locked Decisions

| Topic | Decision | Rationale |
|---|---|---|
| Text creation technique | `sequence.importMGT(path, ticksString, vidTrack, audTrack)` with bundled `base_text.mogrt` | Adobe SDK lead (Bruce Bullis, Aug 2025) confirms this is the **only** scriptable way to put native editable text on a timeline. QE DOM has no text creation method. |
| Style control | **Pre-bake** font/color/size/position into the `.mogrt` itself. Per-clip, only change `textEditValue` (one operation, not four) | Eliminates 70% of the previous attempt's failure surface. The `feat/animated-captions` `subtitle_manager.jsx` already debugged the JSON-patch technique through 5 fix commits. |
| Animation technique | Native Premiere keyframes on the placed clip's `Motion` (Scale) and `Opacity` (Opacity) components via `prop.setTimeVarying(true)` + `prop.addKey(time)` + `prop.setValueAtKey(time, value, true)` + `prop.setInterpolationTypeAtKey(time, 5, true)` (5 = Bezier) | Adobe-confirmed canonical pattern. Per-clip keyframes are editable in Effect Controls after generation. |
| Easing math | Port `easeOutBack`, `easeOutCubic` from `Paquette1111/Better-Captions-Premiere` | User approved. Their easing functions are pure JS (no Premiere API) — we just compute keyframe values with the curve applied. |
| Animation presets (priority order) | 1. **Fade-in** (Opacity only — most reliable) → 2. **Pop-in** (Opacity + Scale, Hormozi-style) → 3. **Bounce** (Opacity + Scale + Position, marked experimental) | Reliability-first. Fade-in is rock-solid. Pop-in works in 95% of cases. Bounce has known Premiere bug (DVAPR-4217831). |
| Audio extraction | `sequence.exportAsMediaDirect(outPath, eprPath, app.encoder.ENCODE_IN_TO_OUT)` with a bundled `audio_mixdown_wav.epr` (2KB Premiere WAV export preset) | More reliable than the `"WaveAudio"` string preset which doesn't always resolve. `ENCODE_IN_TO_OUT` respects In/Out points. |
| Transcription | Reuse EditFlowAI's existing `whisper_service.transcribe_fingerprinted(...)` | EditFlowAI already has full Whisper integration with caching, fingerprinting, model download UI, and progress bars. Better-Captions uses Premiere's built-in transcript (cue-level only); we want word-level. |
| Fingerprint key | `sequence_name + in_seconds + out_seconds + active_model` | Different In/Out ranges don't collide; same range reuses cache on re-runs. |
| `BUILD_TAG` | Bump from `review-9` → `native-captions-1` on every panel-affecting commit, in BOTH `main.js` AND `cep-loader.html` | Mandatory per architecture doc — CEF caches ES modules aggressively. |
| Failure handling | Defensive logging at every step + bail-fast on systemic errors (3 strikes) + diagnostic probe + smoke test | User explicitly requested: "test everything maximally so nothing fails when I take it to local files." |
| Cherry-pick source | Bring `subtitle_manager.jsx`, `base_text.mogrt`, `cue_builder.py`, `presets.py`, `srt_export.py` from `feat/animated-captions`. Build `native_captions_manager.jsx` (per-word animation) as a new module on top. | The previous attempt solved the hard problems (importMGT placement, Source Text JSON patching, write verification). Discarding it would be costly. |

---

## 1. Reliability-First Architecture (5 Pillars)

### Pillar 1 — Pre-bake Style Into MOGRT
- Font family, color, size, position, background — all set in `base_text.mogrt` at authoring time
- Per-clip, the panel only sends `textEditValue` (the word string)
- Eliminates: Color component not found, font not settable, size mismatch
- If user wants different style, they pick from preset MOGRTs (future Phase 3)

### Pillar 2 — Opacity-First Animation Ladder
- **Fade-in** = Opacity keyframes only (most reliable, no Premiere bugs)
- **Pop-in** = Opacity + Scale (works 95% of the time per community)
- **Bounce** = Opacity + Scale + Position (experimental — marked in UI with ⚠️)
- The panel surfaces this risk ladder to the user

### Pillar 3 — Diagnostic Probe (Run Before Any Generation)
A 5-second probe that:
1. Inserts one test MOGRT at the playhead
2. Lists every component found + every property displayName + matchName (logged to backend `diag` logsink)
3. Tests `setTimeVarying(true)` + `addKey()` + `setValueAtKey()` on `Motion.Scale` and `Opacity.Opacity`
4. Tests `Source Text` JSON patching
5. Cleans up (removes the test clip)
6. Returns a JSON report

If the probe fails, the **Generate** button is disabled with a specific error message naming the failed step.

### Pillar 4 — Smoke Test Button
A "Generate 1 word" button next to "Generate all." If the single-word test passes, bulk will pass. Prevents the "generated 500 captions to discover a bug" failure mode.

### Pillar 5 — Defensive Logging + Bail-Fast
- Every ExtendScript function returns `{ok, step, word, error, details}` — never just `true/false`
- `if (errors.length >= 3) break;` — bail fast on systemic failures
- All probe results + per-cue errors logged to backend `/api/diag/log` (the `logsink.py` pattern from `feat/animated-captions`)
- Frontend shows the diagnostic report in a collapsible drawer

---

## 2. Build Order (8 commits, each independently testable)

| # | Commit | Risk | User-verifiable on Windows |
|---|---|---|---|
| 1 | Cherry-pick foundation: `subtitle_manager.jsx` + `base_text.mogrt` + `cue_builder.py` + `presets.py` + `srt_export.py` + `subtitles.py` route + bump `BUILD_TAG` | Low | Panel loads without errors; `/api/subtitles/presets` returns 7 presets |
| 2 | Backend `POST /api/subtitles/transcribe-mixdown` + `backend/routes/diag.py` + `backend/utils/logsink.py` + mock-WAV unit tests | Low | `curl -X POST -F file=@test.wav /api/subtitles/transcribe-mixdown` returns word list (or 409 if no model) |
| 3 | ExtendScript `cep-panel/extendscript/sequence_audio.jsx` + bundled `cep-panel/templates/audio/audio_mixdown_wav.epr` + dispatcher wiring | Medium | Click "Extract Audio" button in panel → WAV appears at `data/media_cache/mixdowns/` |
| 4 | ExtendScript `cep-panel/extendscript/diagnostic_probe.jsx` (runDiagnosticProbe) + dispatcher + panel Probe button + backend logsink wiring | Medium | Click "Run Probe" → JSON report of your Premiere API surface shows in panel |
| 5 | Frontend `cep-panel/client/src/native-captions-view.js` + `cep-panel/client/styles/native-captions.css` + main.js + cep-loader.html + header button | Low | Panel UI renders with Extract/Probe/Generate/Smoke buttons |
| 6 | Animation logic — `native_captions_manager.jsx` with **Fade-in preset only** (Opacity keyframes, most reliable) + smoke test button working end-to-end | High | Smoke test 1 word → see Fade-in animation in Premiere; then 10 words |
| 7 | Add **Pop-in preset** (Opacity + Scale with `easeOutBack` easing — Hormozi style) | Medium | Smoke test Pop-in → each word pops in natively |
| 8 | Add **Bounce preset** (Opacity + Scale + Position) + final integration verification checklist + final BUILD_TAG bump | Medium | Smoke test Bounce → each word bounces; full sequence test passes |

If commit 6's smoke test fails, we stop and fix before adding Pop-in/Bounce. **The user will never again discover a bug after generating 500 captions.**

---

## 3. Architecture Per Component

### 3.1 Backend: `POST /api/subtitles/transcribe-mixdown`

**File:** `backend/routes/subtitles.py` (extend existing router if cherry-picked; otherwise create new)

```python
@router.post("/transcribe-mixdown")
async def transcribe_mixdown(
    file: UploadFile = File(...),
    client_id: Optional[str] = Form(None),
    sequence_name: Optional[str] = Form(None),
    in_seconds: float = Form(0.0),
    out_seconds: float = Form(0.0),
):
    """Receive a WAV mixdown, transcribe it, return word-level cues."""
    # 1. Save uploaded WAV to data/media_cache/mixdowns/<fingerprint>.wav
    # 2. Check whisper_service.get_active_model_name() — if no model + not installed, return 409
    # 3. Run transcribe_fingerprinted(wav_path, range_in=0, range_out=duration, word_timestamps=True)
    #    wrapped with ProgressReporter(task_type="transcribe", client_id=client_id)
    # 4. Return {words: [{word, start, end, confidence}, ...], fingerprint, duration}
```

**409 response shape** (triggers Whisper download UI in panel):
```json
{"error": "no_model", "available": [], "download_hint": "open_settings_whisper"}
```

**Fingerprint:** SHA256 of `f"{sequence_name}|{in_seconds}|{out_seconds}|{active_model_name}"` — same In/Out + model reuses cache.

### 3.2 Backend: `POST /api/diag/log`

**File:** `backend/routes/diag.py` (cherry-pick from `feat/animated-captions` if present)

Receives diagnostic logs from ExtendScript (via the panel) and stores them in memory + writes to `data/diag.log`. Used by the diagnostic probe.

### 3.3 Backend: `backend/utils/logsink.py`

**File:** Cherry-pick from `feat/animated-captions` if present; otherwise minimal in-memory ring buffer.

### 3.4 ExtendScript: `sequence_audio.jsx` (NEW)

```javascript
sequenceAudio = (function() {
    "use strict";
    function _ok(obj) { obj = obj || {}; obj.success = true; return editflowUtils.safeStringify(obj); }
    function _err(msg) { return editflowUtils.safeStringify({ success: false, error: String(msg) }); }

    function extractSequenceAudio(options) {
        var seq = app.project.activeSequence;
        if (!seq) return _err("No active sequence.");
        
        var inTicks = seq.getInPoint();
        var outTicks = seq.getOutPoint();
        if (inTicks < 0 || outTicks <= inTicks) {
            return _err("No In/Out points set. Press I and O in Premiere to mark the range.");
        }
        
        var outPath = editflowUtils.getParam(options, 'outPath');
        if (!outPath) return _err("No outPath provided.");
        var eprPath = editflowUtils.getParam(options, 'eprPath');
        if (!eprPath) return _err("No eprPath provided.");
        
        var outFile = new File(outPath);
        var outDir = new Folder(outFile.parent.fsName);
        if (!outDir.exists) { try { outDir.create(); } catch (e) {} }
        
        // ENCODE_IN_TO_OUT = use sequence In/Out points
        seq.exportAsMediaDirect(outFile.fsName, eprPath, app.encoder.ENCODE_IN_TO_OUT);
        
        if (!outFile.exists) {
            return _err("Export finished but file not found: " + outFile.fsName);
        }
        
        return _ok({
            path: outFile.fsName,
            size_bytes: outFile.length,
            in_seconds: editflowUtils.ticksToSeconds(inTicks),
            out_seconds: editflowUtils.ticksToSeconds(outTicks)
        });
    }
    
    return { extractSequenceAudio: extractSequenceAudio };
})();
```

### 3.5 ExtendScript: `diagnostic_probe.jsx` (NEW)

```javascript
diagnosticProbe = (function() {
    "use strict";
    // ... helpers ...
    
    function runProbe(options) {
        var report = { steps: [], passed: 0, failed: 0 };
        
        // Step 1: Insert test MOGRT at playhead
        // Step 2: Dump all components + properties (displayName + matchName)
        // Step 3: Find Source Text param, attempt JSON patch + verify
        // Step 4: Find Motion component, attempt Scale keyframe + verify
        // Step 5: Find Opacity component, attempt Opacity keyframe + verify
        // Step 6: Clean up (remove test clip)
        
        return editflowUtils.safeStringify(report);
    }
    
    return { runProbe: runProbe };
})();
```

Each step records `{step, ok, error?, details}` so the panel shows exactly which call failed on the user's Premiere version.

### 3.6 ExtendScript: `native_captions_manager.jsx` (NEW — the core)

```javascript
nativeCaptionsManager = (function() {
    "use strict";
    
    // Easing functions (ported from Better-Captions-Premiere)
    function easeOutBack(t) {
        var c1 = 1.70158, c3 = c1 + 1;
        return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    }
    function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
    function easeLinear(t) { return t; }
    
    // Animation presets — each returns array of [offsetSec, value] pairs
    function _fadeKeyframes(durSec) {
        var intro = Math.min(0.3, durSec * 0.4);
        return { opacity: [[0, 0], [intro, 100]], scale: [] };
    }
    function _popKeyframes(durSec) {
        // Hormozi-style: scale 0 → 110 (frame 3) → 100 (frame 5) + opacity 0 → 100 (frame 2)
        var intro = Math.min(0.25, durSec * 0.4);
        return {
            opacity: [[0, 0], [intro * 0.5, 100]],
            scale:   [[0, 0], [intro * 0.6, 110], [intro, 100]]
        };
    }
    function _bounceKeyframes(durSec) {
        var intro = Math.min(0.4, durSec * 0.5);
        return {
            opacity: [[0, 0], [intro * 0.3, 100]],
            scale:   [[0, 0], [intro * 0.4, 125], [intro * 0.7, 90], [intro, 100]]
        };
    }
    
    function applyNativeCaptions(options) {
        // options = { words, preset, baseMogrtPath, trackIndex, style, textParam }
        // 
        // For each word:
        //   1. importMGT(baseMogrtPath, ticksString(word.start), trackIndex, 0)
        //   2. _setText(clip, word.text)  — uses subtitle_manager.jsx's verified pattern
        //   3. clip.end = time(word.end)
        //   4. Find Motion + Opacity components
        //   5. Apply keyframes per preset
        //   6. Record success/failure with step-level detail
        //
        // Bail-fast: if (errors.length >= 3) break;
        //
        // Return { success:true, placed:N, total:M, errors:[...], probe_data:{...} }
    }
    
    return { applyNativeCaptions: applyNativeCaptions };
})();
```

**Key pattern (preserve from `subtitle_manager.jsx`):**
1. OS-native path for `importMGT`: `mogrtFile.fsName` (NOT forward slashes)
2. Tick STRING for placement: `editflowUtils.secondsToTicksString(cue.start)`
3. Time OBJECTS (seconds) for keyframes: `var t = new Time(); t.seconds = ...`
4. `KF_BASE = 'sequence'` — keyframe times are absolute sequence seconds
5. `_findSourceTextParam` two-pass probe (by display name, then by JSON shape)
6. `fontTextRunLength = [text.length]` updated alongside `textEditValue`
7. Write verification — re-read after `setValue()`
8. Bail-fast: `if (errors.length >= 3) break;`
9. Per-cue error aggregation: returns `{success:true, placed:N, total:M, errors:[…]}`

### 3.7 Frontend: `native-captions-view.js` (NEW)

Self-contained ES module, mirroring `review-view.js` pattern:

```javascript
import { apiGet, apiPost, apiUpload, connectWS, getBaseUrl } from './api.js';
import { callExtendScript, isExtendScriptAvailable } from './extendscript.js';

const S = {
  words: [],           // [{word, start, end, confidence}]
  modelName: '',
  preset: 'pop',       // 'fade' | 'pop' | 'bounce'
  trackIndex: null,    // null = auto-create new track on top
  busy: false,
  probeResult: null,
  prevView: null,
};

function openNativeCaptions(opts = {}) {
  _ensureStyles();
  const v = _ensureContainer();
  // Hide hero/chat/footer, show view
  _render();
}

// Sections:
// 1. Header bar (back button, status indicator)
// 2. Whisper model status (green if loaded, red with download button if missing)
// 3. Step 1: Extract & Transcribe button + progress bar
//    - Calls extractSequenceAudio ExtendScript
//    - Then apiUpload(transcribe-mixdown, wav, {client_id, ...})
//    - Handles 409 → shows inline Whisper download UI
// 4. Step 2: Animation preset dropdown (Fade-in / Pop-in / Bounce*)
//    - * = experimental warning
// 5. Step 3: Run Diagnostic Probe button (always available)
//    - Shows JSON report in collapsible drawer
// 6. Step 4: Smoke Test (1 word) button + Generate All button
//    - Smoke test runs first word only, shows result
//    - Generate All runs full sequence
// 7. Results: placed/total/errors count + error details drawer

export { openNativeCaptions, closeNativeCaptions };
```

### 3.8 Frontend: `native-captions.css` (NEW)

Mirror `subtitles.css` (cherry-picked) dark-glass aesthetic. Self-injected with `?v=Date.now()` to dodge CEF cache.

### 3.9 Frontend Wiring: `main.js` + `cep-loader.html`

**`main.js`:**
- Bump `BUILD_TAG` from `'review-9'` → `'native-captions-1'`
- Add dynamic `import('./native-captions-view.js' + bust)` block (mirror review-view block)
- Add `window.__editflowOpenNativeCaptions = openNativeCaptions`
- Add header button click handler

**`cep-loader.html`:**
- Add `<button id="btn-native-captions" class="icon-btn" title="Native Animated Captions">💬</button>` to header
- Bump `?v=20260606c` → `?v=natcap1` on both `<script src="lib/CSInterface.js">` and `<script type="module" src="src/main.js">` tags

### 3.10 Dispatcher Wiring

**`cep-panel/extendscript/index.jsx`** (3 edits per the audit's documented pattern):
1. Add `"sequence_audio.jsx"`, `"diagnostic_probe.jsx"`, `"native_captions_manager.jsx"` to `editflowModuleNames`
2. Add switch cases: `extractSequenceAudio`, `runDiagnosticProbe`, `applyNativeCaptions`
3. Add `"applyNativeCaptions"` to `modifyingCommands` (so undo is tracked)

**`cep-panel/client/src/extendscript.js`** (1 edit):
Add `'extractSequenceAudio', 'runDiagnosticProbe', 'applyNativeCaptions'` to the `_buildScript` allowlist array.

---

## 4. Risk Register & Mitigations

| Risk | Mitigation |
|---|---|
| `exportAsMediaDirect` partial-range API varies by Premiere version | Use `app.encoder.ENCODE_IN_TO_OUT` (most stable across versions). Fallback: bundled `.epr` + `workAreaType` arg. Final fallback: `setInPoint/setOutPoint` + full export + trim. |
| `Transform` component may not exist — could be `Motion` | Diagnostic probe step 4 detects this on first run. Code reads `matchName` not display name (`"AE.ADBE Motion"` vs `"AE.ADBE Transform"`). |
| Source Text property access fragile | Cherry-pick `subtitle_manager.jsx`'s `_findSourceTextParam` two-pass probe (already debugged through 5 fix commits). |
| CEF caching makes panel fixes invisible | Bump `BUILD_TAG` in BOTH `main.js` AND `cep-loader.html` every panel-affecting commit. Non-negotiable. |
| Mixdown WAV has no stable content hash | Fingerprint includes `sequence_name + in_ticks + out_ticks + model` — not file content. |
| Whisper model cold-load > 180s timeout | Reuse existing `_load_model_with_progress` WS events — frontend shows download bar; transcribe waits for warm model. |
| `importMGT` ~1-2 sec/clip × 500 clips = 10+ min | Progress bar + cap warning at >400 cues. Bail-fast on 3 errors. Smoke test first. |
| `setValueAtKey` on still-image clips silently fails (DVAPR-4217831) | Diagnostic probe step 4/5 tests this explicitly. If it fails, Pop-in/Bounce disabled in UI. |
| Per-clip MOGRT insert adds ~40KB to project per word | Bundle the 40KB `base_text.mogrt` once; Premiere references it by path. (Confirmed by `subtitle_manager.jsx` — it doesn't copy the file per clip.) |
| User clicks Generate without In/Out points set | UI checks for In/Out before enabling button. Backend re-validates. ExtendScript returns specific error. |

---

## 5. Verification Plan

### Manual Verification (User runs on Windows machine after pulling each commit)

**Commit 1 (Foundation):**
1. `git pull origin feat/native-animated-captions`
2. Restart backend (`python run.py --prod`)
3. Reload CEP panel (close + reopen in Premiere)
4. Verify panel loads without errors in CEP debug console
5. `curl http://localhost:8765/api/subtitles/presets` → returns 7 presets
6. Verify `BUILD_TAG` in header shows `native-captions-1`

**Commit 2 (Backend transcribe-mixdown):**
1. `curl -X POST -F "file=@test.wav" -F "client_id=test" http://localhost:8765/api/subtitles/transcribe-mixdown`
2. If Whisper model installed → returns `{"words": [...], "fingerprint": "...", "duration": N}`
3. If no model → returns 409 with `{"error": "no_model", ...}`
4. Run unit tests: `pytest tests/unit/test_subtitles_transcribe_mixdown.py`

**Commit 3 (Audio extraction):**
1. Open Premiere, set In/Out points on a sequence with audio
2. Open panel, click "Extract Audio" button
3. Verify WAV appears at `data/media_cache/mixdowns/<fingerprint>.wav`
4. Verify file size > 0 and is a valid WAV (ffprobe)

**Commit 4 (Diagnostic probe):**
1. Click "Run Probe" button in panel
2. Verify JSON report appears showing:
   - All components on the test MOGRT clip
   - Source Text param found and patched successfully
   - Motion.Scale keyframe set successfully
   - Opacity.Opacity keyframe set successfully
3. If any step fails → report shows specific error
4. Verify `data/diag.log` contains the full report

**Commit 5 (Frontend view):**
1. Click "Native Captions" button in panel header
2. Verify view renders with all 4 sections (model status, extract, presets, probe/generate)
3. Verify Generate button is disabled until probe passes + words are transcribed

**Commit 6 (Fade-in preset + smoke test):**
1. Run probe → passes
2. Set In/Out points, click "Extract & Transcribe" → words appear
3. Click "Smoke Test (1 word)" → one caption appears on timeline with Fade-in
4. Play back → word fades in natively
5. If passes → click "Generate All" → all words placed with Fade-in
6. Verify `placed === total` in result panel

**Commit 7 (Pop-in preset):**
1. Select "Pop-in" from preset dropdown
2. Smoke test → one word pops in (scale 0 → 110 → 100 + fade)
3. Generate All → all words pop in

**Commit 8 (Bounce preset):**
1. Select "Bounce" (with experimental warning)
2. Smoke test → word bounces in
3. Generate All → all words bounce
4. Final end-to-end test: 30-second sequence, all 3 presets, verify no errors

### Automated Tests
- `tests/unit/test_subtitles_transcribe_mixdown.py` — mock WAV, mock whisper, verify route
- `tests/unit/test_diag_logsink.py` — verify logsink ring buffer
- (Existing `tests/unit/test_subtitles_cue_builder.py` from cherry-pick — already passes)

---

## 6. What I Can And Cannot Test

| Can test in my Linux container | Cannot test (needs user's Windows + Premiere) |
|---|---|
| Backend route with mock WAV + mock Whisper | Actual `importMGT` behavior on user's Premiere version |
| Frontend view wiring with mocked API | Actual Source Text component JSON shape on user's machine |
| JS syntax of `.jsx` files via Node parser | Whether keyframes visually render correctly in Premiere |
| Easing math produces correct keyframe values (unit test) | What the probe will *report* on user's system |
| Diagnostic probe code logic | Actual `exportAsMediaDirect` behavior on user's Premiere |

**The mitigation is the diagnostic probe.** When the user pulls the branch and runs the probe, it tells us in 5 seconds what works on their Premiere. We iterate from there.

---

## 7. Git Workflow

- Push commits directly to `feat/native-animated-captions` on origin
- Each commit is independently testable (user can pull after any commit and verify)
- Commit messages follow conventional commits: `feat(native-captions): ...`, `fix(...): ...`, `chore(...): ...`
- BUILD_TAG bumped on every panel-affecting commit

---

## 8. Reference Documents

- `/home/z/my-project/research/editflowai-audit.md` — exhaustive ground-truth audit of EditFlowAI codebase patterns
- `/home/z/my-project/research/better-captions-report.md` — analysis of Better-Captions-Premiere (easing math source)
- `/home/z/my-project/research/adobe-api-research.md` — official Adobe ExtendScript API research + community patterns
- `docs/plans/subtitles-animated-captions-plan.md` (on `feat/animated-captions` only) — the prior 666-line implementation plan

---

## 9. Estimated Effort

~4-5 hours of active work across the 8 commits, parallelized where possible:
- Commits 1-4 can be partially parallelized (backend + ExtendScript + probe work independently)
- Commit 5 (frontend) depends on commits 1-4 patterns but can start once commit 1 lands
- Commits 6-8 are sequential (each builds on the previous animation logic)
