# AE Captions Fixes + Rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline execution chosen by user). Steps use checkbox (`- [ ]`) syntax for tracking.
> Executor note: executed in-session by the plan author with full context; tricky code is inline, the rest is pinned by exact signatures + test cases.

**Goal:** Make the AE captions panel WYSIWYG (preview = AE output), rebuild generation as one-text-layer-per-caption with per-word animation, fix pill/overlap timing, and upgrade word-timestamp quality locally (WhisperX + guards).

**Architecture:** A new pure module `caption-model.js` becomes the single source of truth for grouping, 2-line wrap, easing, per-preset word animation, and caption timing; the panel preview and the config sent to ExtendScript both derive from it. The jsx builds text-animator + expression-selector captions from panel-supplied groups. Backend gains word sanitation + optional WhisperX alignment.

**Tech Stack:** CEP panel (vanilla ES modules, canvas), ExtendScript (ES3), FastAPI + faster-whisper 1.2.1 (+ whisperx optional), Node built-in test runner for JS tests, pytest for backend.

**Verification without AE:** panel served by backend at `http://127.0.0.1:8765/panel-ae/cep-loader.html` (browser-run, CSInterface absent → preview fully works); Node tests eval jsx + generated expressions; pytest + live local transcription of `tests/fixtures/short/interview_short.wav`.

---

## File map

| File | Responsibility |
|---|---|
| `cep-panel-ae/client/src/caption-model.js` | NEW. Pure logic: sentence-end regex (multilingual), `groupWords`, `wrapLines`, easings, `wordAnim`, `captionTiming`. No DOM, no AE. |
| `cep-panel-ae/client/src/captions-view.js` | Preview + UI. Imports caption-model. One `pxScale`. AE-font-driven canvas font. Per-preset draw. Sends groups in config. |
| `cep-panel-ae/extendscript/index.jsx` | Generation. Consumes panel groups. Single-layer captions via expression selector (+probe & fallback), pill timing fix, overlap timing, auto-shrink. |
| `cep-panel-ae/extendscript/caption_manager.jsx`, `utils.jsx` | DELETE (dead — never loaded). |
| `tests/caption-model.test.js` | Node tests for the model. |
| `tests/jsx-expressions.test.js` | Node: eval `index.jsx` (no AE globals at top level), call expression builders, eval generated expressions with mocked `time/textIndex/inPoint`, assert ramps. |
| `backend/services/subtitles/word_sanitizer.py` | NEW. `sanitize_words()` guards. |
| `backend/routes/subtitles.py` | `engine`, `vocab` params; sanitize output. |
| `backend/services/whisper_service.py` | `initial_prompt`/`hotwords` pass-through. |
| `backend/services/transcribe/whisperx_engine.py` | Use active model size; missing-timestamp tolerance. |
| `tests/unit/test_word_sanitizer.py` | pytest. |
| `docs/ae-captions-runbook.md` | NEW. In-AE verification checklist. |
| `.claude/launch.json` | Add `backend` config (python run.py) for browser verification. |

Constants shared by preview & jsx (defined once in caption-model, mirrored into cfg): inter-word gap `= fontSize*0.32`, pill pad `x=fontSize*0.28, y=fontSize*0.16`, line height `= fontSize*1.2`, auto-shrink threshold `0.94 * comp.width`.

---

## Phase 1 — caption-model + test rig

### Task 1.1: caption-model.js (TDD)

**Files:** Create `cep-panel-ae/client/src/caption-model.js`, `tests/caption-model.test.js`.

- [ ] Write failing tests (node:test + assert), covering:
  - `SENTENCE_END`: true for `"end."`, `"ok?"`, `"ٹھیک۔"`, `"کیا؟"`, `"ठीक।"`, `"了。"`, false for `"word"`, `"a,b"`.
  - `groupWords`: breaks on gap > maxGap; on maxWords; on sentence end; on char budget `maxChars*maxLines`; keeps `idx/pill`; empty input → `[]`.
  - `wrapLines`: ≤ maxLines lines, each ≤ maxChars (unless single word longer), words in order, line assignment deterministic; maxLines=1 → single line.
  - `easings.ease_out(0)=0, (1)=1`, monotonic; all four named easings exist.
  - `wordAnim('fadeup_words', ...)`: at `t<start` → `{opacity:0, dy:slideDist}`; at `t=start+dur` → `{opacity:1, dy:0}`; popin: scale overshoots >1 within dur then settles 1; typewriter: opacity steps 0→1 at start (no dy); fade/fadeup: `captionLevel:true` flag.
  - `captionTiming(groups, {frameDur, overlapFrames:2, minDur:0.7, tailHold:0.5})`: `out[i] = max(in[i]+minDur, end[i])` capped/extended to `in[i+1] + overlapFrames*frameDur`; last group `end+tailHold`; `in[i]=group.start`; out never ≤ in.
- [ ] Run `node --test tests/caption-model.test.js` → FAIL (module missing).
- [ ] Implement `caption-model.js`. Key pieces:

```js
export const SENTENCE_END = /[.?!؟۔।؛。！？…]["')\]]?\s*$/;

export const EASINGS = {
  linear: (p) => p,
  ease_in: (p) => p * p * p,
  ease_out: (p) => 1 - Math.pow(1 - p, 3),
  ease_in_out: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
};

export function captionTiming(groups, opts) {
  const frameDur = opts.frameDur || 1 / 30;
  const overlap = (opts.overlapFrames != null ? opts.overlapFrames : 2) * frameDur;
  const minDur = opts.minDur != null ? opts.minDur : 0.7;
  const tailHold = opts.tailHold != null ? opts.tailHold : 0.5;
  return groups.map((g, i) => {
    const tIn = g.start;
    let tOut = Math.max(g.end, tIn + minDur);
    const next = groups[i + 1];
    if (next) tOut = next.start + overlap;          // hold until next + overlap
    else tOut = Math.max(tOut, g.end + tailHold);   // last caption tail
    if (tOut <= tIn) tOut = tIn + frameDur;
    return { in: tIn, out: tOut };
  });
}
```

  `groupWords(words, {maxWords,maxChars,maxDur,maxGap,maxLines})` ports the existing logic (char budget = `maxChars*maxLines`, sentence-end via SENTENCE_END). `wrapLines(group,{maxChars,maxLines})` greedy char-budget fill returning `[{startIdx,endIdx,text}]`. `wordAnim(preset,{start,fadeDur,slideDist,easing,intensity},t)` returns `{opacity,dy,scaleX,scaleY,captionLevel}` with popin = damped spring `1 - e^(-6t')*cos(3*2π*t')` normalized, bounce dy = `-160*i*e^(-6t')*cos(2*2π*t')`, squash from existing `ef_squashExpr` formula.
- [ ] Node ES-module note: repo has no package.json → node treats `.js` as CJS. Test file loads the model via `await import(pathToFileURL(...))` (works for ESM from CJS test) — if node complains about the `.js` extension being CJS, rename model to `caption-model.mjs`? NO — CEP needs `.js`. Instead run tests with `node --experimental-default-type=module` or read file + transform. Simplest reliable: dynamic `import()` of an ESM `.js` fails only when package.json exists with type=commonjs; with NO package.json, `import()` of `.js` defaults CJS → SyntaxError on `export`. Fix: add minimal `tests/package.json` `{"type":"module"}`? That doesn't affect the model path. Chosen approach: tests read the source, strip `export ` tokens via a tiny loader `tests/_load-esm.js` (regex `^export `), `eval` in a module-scope object. Keep loader <30 lines; reused by captions tests. (jsx test needs eval-loading anyway — same helper.)
- [ ] `node --test tests/caption-model.test.js` → PASS.
- [ ] Commit `feat(captions): shared caption model + node tests`.

### Task 1.2: panel uses the model + browser rig

**Files:** Modify `cep-panel-ae/client/src/captions-view.js` (grouping + sentence regex), `.claude/launch.json`.

- [ ] Replace `_groupWordsForPreview` body with `groupWords` from `./caption-model.js` (import at top; keep same call sites). Delete the local duplicated regex.
- [ ] Add launch.json config: `{"name":"backend","runtimeExecutable":"python","runtimeArgs":["run.py"],"port":8765}` (check run.py flags first).
- [ ] Start backend via preview_start, open `http://127.0.0.1:8765/panel-ae/cep-loader.html`, paste JSON transcript fixture (words array), verify: word list renders, groups shown, preview draws, play works. Console: no errors except expected CSInterface absence.
- [ ] Commit `feat(captions): panel grouping from shared model + browser rig`.

## Phase 2 — WYSIWYG preview

### Task 2.1: uniform scale + AE-font canvas rendering

**Files:** Modify `captions-view.js` `_updatePreview` (+`_fontFamilyFromPS` usage), `_renderPreview`.

- [ ] One `const pxScale = w / compW;` — font `S.fontSize*pxScale`, slide `S.slideDist*pxScale`, strokeWidth `S.strokeWidth*2*pxScale` (keep the ×2 canvas-stroke convention: AE stroke straddles glyph edge), shadow `*pxScale`, pill pads/space/lineHeight via model constants × pxScale. Delete `×1.5` and `h/270` and `w/480` bases.
- [ ] Canvas font from AE font list: find `S.fonts` entry by `ps===S.fontPS` → `family` + weight/italic inferred from `style` (`/bold|black|heavy|semi/i` → 700, `/italic|oblique/i`); quote family: `ctx.font = `${italic} ${weight} ${px}px "${family}", sans-serif``. Fallback to `_fontFamilyFromPS` when list empty (browser mode).
- [ ] Browser-verify at 16:9 and 9:16 (`compInfo` default vs mocked 1080×1920 via paste + no comp — add dev override: if no AE, a small aspect toggle in preview header, dev-only) — screenshot both.
- [ ] Commit `fix(captions): preview scale parity + real font rendering`.

### Task 2.2: per-preset preview animation

**Files:** Modify `captions-view.js` `_updatePreview` word loop; delete `_getFadeUp` (use model).

- [ ] Word draw uses `wordAnim(S.preset, {...}, t)`: apply `opacity`, `dy*pxScale`, per-word `scale` via `ctx.save/translate/scale/restore` around the word. Caption-level presets (fade/fadeup) compute one anim at group start applied to all words. Typewriter = word-staggered instant reveal.
- [ ] Browser-verify: sweep all 7 presets at a caption boundary; confirm visibly distinct motion; screenshots.
- [ ] Commit `feat(captions): preview renders each preset's real animation`.

### Task 2.3: 2-line preview + content-tab refresh + Max Lines real

**Files:** Modify `captions-view.js` (`_updatePreview` layout, `_renderTabContent` wiring).

- [ ] Layout per group: `wrapLines` → per-line word x positions (existing measure logic per line), line Y = blockCenter + (li - (nLines-1)/2) * lineHeight*pxScale. Pills span within a line (pill group split at line boundary).
- [ ] Segment-setting handlers (`max-words/chars/dur/lines`) re-render the word-list card (targeted innerHTML of `#cap-word-list` + rewire), not just the canvas.
- [ ] Max Lines slider: min 1 max 2, drives model `maxLines` (grouping char budget + wrap).
- [ ] Browser-verify: long caption wraps to 2 lines in preview; changing Max Words updates the caption headers immediately. Screenshot.
- [ ] Commit `feat(captions): two-line captions in preview + live content list`.

## Phase 3 — AE engine rebuild (jsx)

### Task 3.1: panel sends computed groups + timing

**Files:** Modify `captions-view.js` `_buildConfig`, `_onGenerate`, `_onAnimatePreview`.

- [ ] `_buildConfig(words)` → adds `groups: [{words:[{text,start,end,pill}], start, end, lines:[{startIdx,endIdx}], tIn, tOut}]` computed via model (`groupWords`+`wrapLines`+`captionTiming` with comp frameDur, overlapFrames from new setting `S.overlapFrames` default 2, minDur `S.minDisplayDur` default 0.7, tailHold 0.5). Batch slicing already group-based — pass `nextBatchStart` so last group's tOut caps correctly (compute timing over ALL groups first, then slice).
- [ ] Add "Timing" subgroup in Animate tab: Overlap (frames 0–10, default 2), Min duration (0.3–2.0s, default 0.7). Persisted in SETTINGS_KEYS.
- [ ] Node test addition: `captionTiming` respects batch boundary (next start beyond batch).
- [ ] Commit `feat(captions): panel computes groups/lines/timing, sends to jsx`.

### Task 3.2: jsx single-layer engine

**Files:** Modify `cep-panel-ae/extendscript/index.jsx` (new builders; `ef_createCaptions` consumes `cfg.groups`; keep legacy path when `cfg.groups` absent).

- [ ] Selector probe (once per `ef_createCaptions` run):

```js
function ef_probeExpressionSelector(comp) {
    var L = null, ok = false;
    try {
        L = comp.layers.addText("probe");
        var anim = L.property("ADBE Text Animators").addProperty("ADBE Text Animator");
        ok = anim.property("ADBE Text Selectors").canAddProperty("ADBE Text Expressible Selector");
    } catch (e) { ok = false; }
    if (L) { try { L.remove(); } catch (e2) {} }
    return ok;
}
```

- [ ] Word-selector Amount expression builder (times relative to layer inPoint; ES3-safe; returns 0–100 where 100 = fully "entered"):

```js
function ef_wordProgressExpr(relTimes, dur, easing) {
    var ts = [];
    for (var i = 0; i < relTimes.length; i++) ts.push(Math.round(relTimes[i] * 1000) / 1000);
    var easeBody;
    if (easing === "ease_out") easeBody = "e=1-Math.pow(1-p,3);";
    else if (easing === "ease_in") easeBody = "e=p*p*p;";
    else if (easing === "ease_in_out") easeBody = "e=(p<0.5)?4*p*p*p:1-Math.pow(-2*p+2,3)/2;";
    else easeBody = "e=p;";
    return "var ts=[" + ts.join(",") + "];" +
        "var i=textIndex-1; if(i>=ts.length)i=ts.length-1; if(i<0)i=0;" +
        "var p=(time-thisLayer.inPoint-ts[i])/" + (dur || 0.3) + ";" +
        "if(p<0)p=0; if(p>1)p=1; var e;" + easeBody + "(1-e)*100;";
}
```

  Animators per preset (`ef_applyWordAnimators(layer, preset, relTimes, cfg)`):
  - fadeup_words: animator A (Opacity=0, selector expr above) + animator B (Position=[0, slideDist], same expr).
  - popin: Scale animator ([-100,-100] so weight 100 → scale 0) with spring-shaped expr `(1-spring(p))*100` + Opacity=0 quick reveal expr (dur 0.1).
  - bounce: Position [0,-160*intensity] with `e^(-6t)cos(2*2πt)` expr; Opacity reveal.
  - squash: Scale asymmetric via two animators (X: `[dev,0]`, Y: `[-dev,0]`) sharing squash expr; Opacity reveal.
  - typewriter: Opacity=0 with step expr (`p<0?100:0`, dur→0).
  - fade / fadeup: no selector — layer-level `ef_buildFadeUpOp/Pos` (existing) at caption start.
  Selector setup per animator: `addProperty("ADBE Text Expressible Selector")`, set `("ADBE Text Range Type2")` to Words value (probe enum at runtime: try setValue(3); runbook step confirms label shows "Words"), `("ADBE Text Expressible Amount").expression = expr`.
- [ ] `ef_buildCaptionLayer(comp, g, cfg)`: text = lines joined by `"\r"` (allCaps applied); styleDoc; static anchor via sourceRect at `g.tIn+0.05`; Position posX/posY; `layer.inPoint=g.tIn; layer.outPoint=g.tOut;` animators; drop shadow; auto-shrink: `var r2=layer.sourceRectAtTime(g.tIn+0.05,false); var maxW=comp.width*0.94; if(r2.width>maxW){var s=maxW/r2.width*100; layer.property("Scale").setValue([s,s]);}`.
- [ ] Pills: `ef_measureWordSpans(comp, g, cfg)` — temp text layer per line with same style; for each word boundary set `sourceText` to prefix, read `sourceRectAtTime(...).width`; span = {left,right,lineIdx}; remove temp. Pill shape per merged pill run (within a line): sized from spans+pads, Position at span center/line Y, **`inPoint = firstWord.start`**, `outPoint = g.tOut`, Scale/Opacity expressions keyed to `inPoint` (existing builders), `moveAfter(textLayer)`.
- [ ] `ef_createCaptions`: if `cfg.groups` present → skip `ef_groupWords`, use given groups verbatim (times already offset-applied panel-side? NO — keep offset application in jsx for both paths: apply `off` to group/word times too). Probe once; `cfg.forceLegacy` or probe-fail → existing per-word-layer path (kept as `ef_buildGroupLegacy`, the current `ef_buildGroup`). Update `ef_endsSentence` regex to the multilingual set (legacy path parity).
- [ ] Commit `feat(ae): single-layer captions with per-word expression selectors, pill timing + overlap`.

### Task 3.3: dead code deletion

- [ ] `git rm cep-panel-ae/extendscript/caption_manager.jsx cep-panel-ae/extendscript/utils.jsx` (never `$.evalFile`d; verified via grep).
- [ ] Commit `chore(ae): remove dead extendscript files`.

### Task 3.4: expression + jsx eval tests

**Files:** Create `tests/jsx-expressions.test.js`.

- [ ] Loader: read `index.jsx` as text, `vm.runInNewContext(src, sandbox)` with sandbox stubs `{app:{}, Folder:{temp:{fsName:''}}, File:function(){}, CompItem:function(){}, FootageItem:function(){}, ParagraphJustification:{CENTER_JUSTIFY:1}, KeyframeInterpolationType:{}, TextDocument:function(){}, system:{}, $:{}}` — top-level of index.jsx only defines vars/functions, so this parses (ES3 ⊂ ES5) and exposes `ef_*` builders in sandbox. This IS the jsx syntax gate.
- [ ] Tests:
  - `ef_wordProgressExpr([0,0.4,0.9], 0.3, 'ease_out')` evaluated with mock `{time, textIndex, thisLayer:{inPoint:10}}` for word 2 (textIndex=2): at `time=10.39` → 100 (not started: 10.39-10-0.4 <0 → p=0 → (1-0)*100=100 = fully weighted = INVISIBLE since animator opacity 0); at `time=10.4+0.3` → 0 (fully entered/visible); mid at 10.55 strictly between; word 3 untouched at word-2 time (textIndex=3 → 100).
  - popin/bounce/squash exprs: numeric sanity (no NaN across t∈[-0.2, 1.5], settles near 0 weight by t=1.2).
  - `ef_groupWords` (legacy) sentence-break on `"ٹھیک۔"`.
  - Generated expressions contain no ES5+ tokens (`=>`, `let `, `const `, `.map(`) — regex guard (AE expressions on legacy engine are ES3; user comps may use legacy engine).
- [ ] `node --test tests/jsx-expressions.test.js` → PASS. Commit `test(ae): eval-based verification of jsx expression builders`.

### Task 3.5: config plumbing verification (browser)

- [ ] In browser, click Generate with no AE → confirm the built cfg (log it in dev mode) contains groups/lines/tIn/tOut consistent with the preview's captions (dump + eyeball one caption). Commit if any fix needed.

## Phase 4 — transcription quality (local-only)

### Task 4.1: word sanitizer (TDD)

**Files:** Create `backend/services/subtitles/word_sanitizer.py`, `tests/unit/test_word_sanitizer.py`.

- [ ] Failing tests: overlapping words clamped (`end>next.start` → `end=next.start`); zero/negative duration → min 0.02s (shift end, never start); missing/zero timestamps between good neighbors → linear interpolation; leading missing → snap to next start − 0.02; strictly non-decreasing starts; idempotent; empty list ok.
- [ ] Implement:

```python
MIN_DUR = 0.02

def sanitize_words(words: list[dict]) -> list[dict]:
    """Monotonic, non-overlapping, min-duration word times; interpolate gaps."""
```

  (missing = `start`/`end` absent, None, or both ≤ 0 while a previous word ends later; interpolate runs of missing between anchors proportionally to text length.)
- [ ] pytest → PASS. Wire into `transcribe_mixdown` before building `words_out`. Commit `feat(subtitles): word timestamp sanitizer`.

### Task 4.2: custom vocabulary (hotwords + initial_prompt)

**Files:** Modify `backend/services/whisper_service.py` (transcribe + transcribe_fingerprinted signatures, default None), `backend/routes/subtitles.py` (`vocab: str = Form("")`), `captions-view.js` (Transcribe tab textarea, persisted key `customVocab`, sent as `vocab`).

- [ ] Pass `initial_prompt=vocab or None, hotwords=vocab or None` into `self._model.transcribe(...)` (verified: both params exist in faster-whisper 1.2.1). Vocab joins into the cache fingerprint string.
- [ ] pytest: route accepts vocab (monkeypatched service asserts pass-through). Commit `feat(subtitles): custom vocabulary biasing (hotwords/initial_prompt)`.

### Task 4.3: WhisperX alignment toggle

**Files:** Modify `backend/routes/subtitles.py`, `backend/services/transcribe/whisperx_engine.py`, `captions-view.js` (Transcribe tab select: `Alignment: Accurate (WhisperX) / Fast (Whisper)`, param `engine`).

- [ ] `pip install whisperx` (attempt; on failure document and set default to whisper — decision recorded in commit message).
- [ ] Route: `engine: str = Form("auto")`; `auto|whisperx` → try `WhisperXEngine(model_size=<active model resolved to size string>, device="auto")` `.is_available()` → transcribe; failure/unavailable → existing whisper path. Response `engine` field already exists. Words → `sanitize_words` either way (also fixes whisperx unaligned-word `start=0` defaults).
- [ ] whisperx_engine: accept full model name mapping (`Systran/faster-whisper-large-v3` → `large-v3`); device default `"cuda"`→auto-detect stays.
- [ ] Live test: `curl -F file=@tests/fixtures/short/interview_short.wav -F engine=whisperx ... /api/subtitles/transcribe-mixdown` (server running) → words non-empty, engine="whisperx", monotonic times; repeat `engine=whisper`. Compare first 5 word starts (expect visible deltas — record in commit).
- [ ] Commit `feat(subtitles): WhisperX forced-alignment engine option for captions`.

## Phase 5 — in-AE runbook

**Files:** Create `docs/ae-captions-runbook.md`.

- [ ] Numbered checklist: (1) open 9:16 comp + audio, transcribe; (2) Test First Caption — expect ONE text layer + pill timed to its word; (3) probe log line says expression selector OK + Based On shows "Words"; (4) font size matches preview proportion; (5) preset sweep popin/bounce; (6) overlap: caption N visible until N+1 starts +2 frames; (7) Clear Existing removes all. Each step lists expected result + what to report back if it fails.
- [ ] Commit `docs(ae): in-AE verification runbook`.

---

## Self-review

- Spec coverage: issues 1–10 → Tasks 2.2/2.1/2.1/3.2/3.2/3.1+3.2/1.2+3.1/1.1+4.x/2.3+3.2/3.3. WhisperX addition → 4.3. Runbook → P5. ✓
- No placeholders: every task pins files, behavior, tests, commands. ✓
- Naming consistency: `caption-model.js` exports (`SENTENCE_END, EASINGS, groupWords, wrapLines, wordAnim, captionTiming`) used identically in 1.2/2.x/3.1; jsx names `ef_probeExpressionSelector, ef_wordProgressExpr, ef_applyWordAnimators, ef_buildCaptionLayer, ef_measureWordSpans, ef_buildGroupLegacy`. ✓
- Risk register: Based-On enum value (runtime-confirmed in runbook step 3); node ESM loading (loader helper, Task 1.1); whisperx install weight (fallback decision point, Task 4.3).
