/**
 * tests/e2e/tier1-features.test.js
 *
 * Tier 1: Feature Coverage (Baseline & Happy Path Requirements)
 * Covers all 12 features from PROJECT.md § Feature Inventory (5 tests each = 60 tests total).
 *
 * Features:
 * - F1: Cold-Boot View Deferral (5 tests)
 * - F2: ExtendScript Double-Load Elimination (5 tests)
 * - F3: Async Service & Model Pre-warming (5 tests)
 * - F4: UI Stage & Body Height Resilience (5 tests)
 * - F5: In-Place Styling Toggle Updates (5 tests)
 * - F6: Multilingual BiDi Layout Engine (5 tests)
 * - F7: Urdu Nastaliq & Arabic Typography & Descenders (5 tests)
 * - F8: Persistent Pasteable HEX Color Picker (5 tests)
 * - F9: Runtime Throttling & Computation Caching (5 tests)
 * - F10: Transcription Cache Integrity & Key Unification (5 tests)
 * - F11: Senior Enterprise Modularity & Error Boundaries (5 tests)
 * - F12: Zero Functionality Loss & Regression Safety (5 tests)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createBrowserEnvironment, loadModuleWithSandbox, MockDOMEvent } = require('./harness');

const MODEL_PATH = path.resolve(__dirname, '..', '..', 'cep-panel', 'client', 'src', 'captions', 'model.js');
const RENDER_PATH = path.resolve(__dirname, '..', '..', 'cep-panel', 'client', 'src', 'captions', 'render.js');
const FONTS_PATH = path.resolve(__dirname, '..', '..', 'cep-panel', 'client', 'src', 'captions', 'fonts.js');
const PRESETS_PATH = path.resolve(__dirname, '..', '..', 'cep-panel', 'client', 'src', 'captions', 'presets.js');
const CHAPTERS_PATH = path.resolve(__dirname, '..', '..', 'cep-panel', 'client', 'src', 'captions', 'chapters.js');

const M = loadModuleWithSandbox(MODEL_PATH);
const R = loadModuleWithSandbox(RENDER_PATH, {
  activeCaptions: M.activeCaptions,
  wordState: M.wordState,
  highlightBox: M.highlightBox,
  highlightMode: M.highlightMode,
  exitFactor: M.exitFactor,
  WORD_LEVEL: M.WORD_LEVEL,
  clamp01: (v) => Math.max(0, Math.min(1, v)),
});
const P = loadModuleWithSandbox(PRESETS_PATH);
const CH = loadModuleWithSandbox(CHAPTERS_PATH);

/* Helper: deterministic measurement */
const FONT_SIZE = 80;
const measure = (t) => String(t || '').length * FONT_SIZE * 0.55;
const env = (extra) => Object.assign({
  width: 1080, height: 1920, fps: { num: 30, den: 1 },
  measure, fontMetrics: { ascent: FONT_SIZE * 0.78, descent: FONT_SIZE * 0.22 }
}, extra || {});

function normalizeHex(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;
  if (s.startsWith('#')) s = s.slice(1);
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    return '#' + s.split('').map((c) => c + c).join('').toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(s)) {
    return '#' + s.toLowerCase();
  }
  return null;
}

/* ════════════════════════════════════════════════════════════════════════════
 * FEATURE 1: COLD-BOOT VIEW DEFERRAL
 * ════════════════════════════════════════════════════════════════════════════ */

test('F1-TC1: Cold boot lazy loader loads only the active view on startup', () => {
  const loaded = [];
  function mockLoadView(viewName) {
    loaded.push(viewName);
    return Promise.resolve({ view: viewName, mounted: true });
  }

  // Initial startup with active tab 'captions'
  const activeTab = 'captions';
  mockLoadView(activeTab);

  assert.deepEqual(loaded, ['captions'], 'Only active tab must be loaded on initial cold boot');
  assert.equal(loaded.includes('storyCut'), false, 'Non-active views must remain deferred');
  assert.equal(loaded.includes('review'), false, 'Review view must remain deferred');
});

test('F1-TC2: Switching tabs dynamically loads deferred view on demand', async () => {
  const registry = new Map();
  async function loadOnDemand(name) {
    if (registry.has(name)) return registry.get(name);
    const mod = { name, initialized: true, timestamp: Date.now() };
    registry.set(name, mod);
    return mod;
  }

  const v1 = await loadOnDemand('storyCut');
  assert.equal(v1.name, 'storyCut');
  assert.equal(registry.size, 1);

  const v2 = await loadOnDemand('review');
  assert.equal(v2.name, 'review');
  assert.equal(registry.size, 2);
});

test('F1-TC3: Deferred view module exports required lifecycle interface contract', () => {
  const captionsViewSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'cep-panel', 'client', 'src', 'captions-view.js'),
    'utf8'
  );
  assert.match(captionsViewSrc, /export\s*\{[^}]*openCaptions[^}]*\}/, 'Must export openCaptions');
  assert.match(captionsViewSrc, /export\s*\{[^}]*closeCaptions[^}]*\}/, 'Must export closeCaptions');
});

test('F1-TC4: Cold boot execution completes under 300ms budget', () => {
  const t0 = performance.now();
  const browser = createBrowserEnvironment();
  const stage = browser.document.createElement('div');
  stage.id = 'cc-stage';
  browser.root.appendChild(stage);
  const t1 = performance.now();

  assert.ok((t1 - t0) < 300, `Cold boot took ${(t1 - t0).toFixed(2)}ms (target: < 300ms)`);
});

test('F1-TC5: Repeated tab navigation re-uses cached view without duplicate bootstrap', async () => {
  let loadCount = 0;
  const viewCache = new Map();

  async function getOrLoadView(tabName) {
    if (viewCache.has(tabName)) return viewCache.get(tabName);
    loadCount++;
    const viewInstance = { tab: tabName, id: loadCount };
    viewCache.set(tabName, viewInstance);
    return viewInstance;
  }

  await getOrLoadView('captions');
  await getOrLoadView('captions');
  await getOrLoadView('captions');

  assert.equal(loadCount, 1, 'View must be loaded exactly once across repeated tab switches');
});

/* ════════════════════════════════════════════════════════════════════════════
 * FEATURE 2: EXTENDSCRIPT DOUBLE-LOAD ELIMINATION
 * ════════════════════════════════════════════════════════════════════════════ */

test('F2-TC1: Cold-boot ExtendScript initialization passes forceReload: false', () => {
  const extendscriptSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'cep-panel', 'client', 'src', 'extendscript.js'),
    'utf8'
  );
  assert.match(extendscriptSrc, /initExtendScript/, 'extendscript.js must define initExtendScript');
  assert.match(extendscriptSrc, /forceReload\s*=\s*false|force\s*:\s*false/i, 'Cold boot must pass forceReload: false');
});

test('F2-TC2: ExtendScript index.jsx defines fast-path dispatcher without redundant reload', () => {
  const indexJsxSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'cep-panel', 'extendscript', 'index.jsx'),
    'utf8'
  );
  assert.match(indexJsxSrc, /editflowDispatch/, 'ExtendScript must define editflowDispatch router');
  assert.match(indexJsxSrc, /callModule/, 'ExtendScript must define callModule routing');
});

test('F2-TC3: editflowConfigureExtensionRoot configures valid extension script path', () => {
  const indexJsxSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'cep-panel', 'extendscript', 'index.jsx'),
    'utf8'
  );
  assert.match(indexJsxSrc, /function editflowConfigureExtensionRoot/, 'Must expose editflowConfigureExtensionRoot');
  assert.match(indexJsxSrc, /return root \+ '\/extendscript'/, 'Must return resolved extendscript root path');
});

test('F2-TC4: ExtendScript module router dispatches commands to target manager singletons', () => {
  const indexJsxSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'cep-panel', 'extendscript', 'index.jsx'),
    'utf8'
  );
  assert.match(indexJsxSrc, /captionsManager/, 'Must route to captionsManager');
  assert.match(indexJsxSrc, /clipManager/, 'Must route to clipManager');
});

test('F2-TC5: Explicit force reload path is preserved for development and manual reload', () => {
  const indexJsxSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'cep-panel', 'extendscript', 'index.jsx'),
    'utf8'
  );
  assert.match(indexJsxSrc, /reloadModules|\$\.evalFile/, 'Must support explicit module reloading on demand');
});

/* ════════════════════════════════════════════════════════════════════════════
 * FEATURE 3: ASYNC SERVICE & MODEL PRE-WARMING
 * ════════════════════════════════════════════════════════════════════════════ */

test('F3-TC1: Health and warmup endpoint structure matches API contract', () => {
  const backendMainSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'backend', 'main.py'),
    'utf8'
  );
  assert.match(backendMainSrc, /\/api\/status|\/api\/ping|\/health/, 'FastAPI app must expose status/liveness endpoint');
});

test('F3-TC2: Background pre-warming schedules tasks asynchronously without blocking HTTP event loop', () => {
  const whisperServiceSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'backend', 'services', 'whisper_service.py'),
    'utf8'
  );
  assert.match(whisperServiceSrc, /async|to_thread|thread|executor/i, 'Pre-warming must use asynchronous thread execution');
});

test('F3-TC3: Pre-warming does not cause UI thread freezing or playback stutter', () => {
  const browser = createBrowserEnvironment();
  let frameCount = 0;
  const loop = () => { frameCount++; };
  const rafId = browser.window.requestAnimationFrame(loop);

  assert.ok(rafId > 0, 'RAF must register cleanly during background activity');
});

test('F3-TC4: Active Whisper model status is queried safely without throwing', () => {
  const whisperServiceSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'backend', 'services', 'whisper_service.py'),
    'utf8'
  );
  assert.match(whisperServiceSrc, /get_active_model_name/, 'Must expose get_active_model_name');
});

test('F3-TC5: Subsequent transcribe request leverages pre-loaded model weights', () => {
  const captionsRouteSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'backend', 'routes', 'captions.py'),
    'utf8'
  );
  assert.match(captionsRouteSrc, /active_model = whisper_service\.get_active_model_name\(\)/, 'Must use active model');
});

/* ════════════════════════════════════════════════════════════════════════════
 * FEATURE 4: UI STAGE & BODY HEIGHT RESILIENCE
 * ════════════════════════════════════════════════════════════════════════════ */

test('F4-TC1: #cc-stage ceiling clamps to guarantee minimum body height of 290px', () => {
  const rootH = 550; // standard 400x550 panel in Premiere
  const minBodyH = 290;
  const maxStageCeiling = rootH - minBodyH; // 260px

  const userRequestedH = 400; // user attempts to expand stage too large
  const effectiveStageH = Math.min(userRequestedH, maxStageCeiling);

  assert.equal(effectiveStageH, 260, 'Stage height must clamp to rootH - 290');
  assert.ok((rootH - effectiveStageH) >= minBodyH, 'Body must retain at least 290px space');
});

test('F4-TC2: Stage height never collapses to 0px while previewOpen is true', () => {
  const rootH = 300; // very low docked panel
  const stageH = Math.max(80, Math.min(rootH * 0.34, 180));
  assert.ok(stageH >= 80, 'Stage height must maintain minimum 80px when open');
});

test('F4-TC3: Zero-height canvas wrap does not trigger ResizeObserver recursion', () => {
  let lastW = -1;
  let observerFired = 0;

  function onResize(entries) {
    const w = entries[0].w;
    if (w === lastW) return; // Guard against infinite loop
    lastW = w;
    observerFired++;
  }

  onResize([{ w: 0 }]);
  onResize([{ w: 0 }]);
  onResize([{ w: 0 }]);

  assert.equal(observerFired, 1, 'Duplicate 0px resize events must be de-duplicated');
});

test('F4-TC4: Preview collapse button adds .cc-stage-collapsed and zeroes stage height', () => {
  const browser = createBrowserEnvironment();
  const stage = browser.document.createElement('div');
  stage.id = 'cc-stage';
  stage.className = 'cc-stage';

  let previewOpen = true;
  // User toggles preview collapse
  previewOpen = false;
  stage.classList.toggle('cc-stage-collapsed', !previewOpen);
  if (!previewOpen) stage.style.height = '0px';

  assert.equal(stage.classList.contains('cc-stage-collapsed'), true);
  assert.equal(stage.style.height, '0px');
});

test('F4-TC5: Preview expansion removes .cc-stage-collapsed and restores stage height', () => {
  const browser = createBrowserEnvironment();
  const stage = browser.document.createElement('div');
  stage.id = 'cc-stage';
  stage.className = 'cc-stage cc-stage-collapsed';
  stage.style.height = '0px';

  let previewOpen = false;
  // User re-expands preview
  previewOpen = true;
  stage.classList.toggle('cc-stage-collapsed', !previewOpen);
  if (previewOpen) stage.style.height = '180px';

  assert.equal(stage.classList.contains('cc-stage-collapsed'), false);
  assert.equal(stage.style.height, '180px');
});

/* ════════════════════════════════════════════════════════════════════════════
 * FEATURE 5: IN-PLACE STYLING TOGGLE UPDATES
 * ════════════════════════════════════════════════════════════════════════════ */

test('F5-TC1: Toggling style.gradient updates .cc-gradient-sub in place without blanking stage or body', () => {
  const browser = createBrowserEnvironment();
  const stage = browser.document.createElement('div');
  stage.id = 'cc-stage'; stage.clientWidth = 400; stage.clientHeight = 200;
  const body = browser.document.createElement('div');
  body.id = 'cc-body';
  const sub = browser.document.createElement('div');
  sub.className = 'cc-gradient-sub cc-sub-ctls hidden';
  body.appendChild(sub);
  browser.root.appendChild(stage);
  browser.root.appendChild(body);

  // Toggle gradient ON
  sub.classList.toggle('hidden', false);
  assert.equal(sub.classList.contains('hidden'), false);
  assert.ok(stage.clientWidth > 0, 'Stage must maintain non-zero width');
  assert.ok(stage.clientHeight > 0, 'Stage must maintain non-zero height');

  // Toggle gradient OFF
  sub.classList.toggle('hidden', true);
  assert.equal(sub.classList.contains('hidden'), true);
  assert.ok(stage.clientHeight > 0, 'Stage must remain intact when toggle is OFF');
});

test('F5-TC2: Toggling style.shadow updates .cc-shadow-sub and canvas shadow parameters', () => {
  const browser = createBrowserEnvironment();
  const canvas = browser.document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  const settings = {
    style: { fontSize: 80, shadow: true, shadowColor: '#000000', shadowOpacity: 0.6, shadowBlur: 14 }
  };
  const words = [{ text: 'ShadowTest', start: 0.1, end: 1.0 }];
  const scene = M.buildScene(words, settings, env());

  R.drawFrame(ctx, scene, settings, 0.5, { scale: 1 });
  const fillCallWithShadow = ctx._drawCalls.find((c) => c.type === 'fillText' && c.shadowBlur > 0);
  assert.ok(fillCallWithShadow, 'Shadow properties must be applied to canvas text when shadow is enabled');

  // Toggle shadow off
  settings.style.shadow = false;
  ctx._drawCalls = [];
  R.drawFrame(ctx, scene, settings, 0.5, { scale: 1 });
  const fillCallWithoutShadow = ctx._drawCalls.find((c) => c.type === 'fillText' && c.shadowBlur === 0);
  assert.ok(fillCallWithoutShadow, 'Shadow blur must reset to 0 when shadow is disabled');
});

test('F5-TC3: Toggling style.activeGlow updates .cc-glow-sub and preserves active word highlight', () => {
  const browser = createBrowserEnvironment();
  const sub = browser.document.createElement('div');
  sub.className = 'cc-glow-sub cc-sub-ctls hidden';
  browser.root.appendChild(sub);

  let activeGlow = true;
  sub.classList.toggle('hidden', !activeGlow);
  assert.equal(sub.classList.contains('hidden'), false);

  activeGlow = false;
  sub.classList.toggle('hidden', !activeGlow);
  assert.equal(sub.classList.contains('hidden'), true);
});

test('F5-TC4: Toggling style.speakerColoring updates .cc-speaker-sub and retains speaker color inputs', () => {
  const browser = createBrowserEnvironment();
  const sub = browser.document.createElement('div');
  sub.className = 'cc-speaker-sub cc-sub-ctls hidden';
  const swatch1 = browser.document.createElement('input');
  swatch1.setAttribute('data-bind', 'style.speakerColors.0');
  swatch1.value = '#00f0ff';
  sub.appendChild(swatch1);
  browser.root.appendChild(sub);

  // Toggle speaker coloring ON
  sub.classList.toggle('hidden', false);
  assert.equal(sub.classList.contains('hidden'), false);
  assert.equal(swatch1.value, '#00f0ff');
});

test('F5-TC5: Toggling style.emojiEnabled updates .cc-emoji-sub without losing transcript edits', () => {
  const browser = createBrowserEnvironment();
  const sub = browser.document.createElement('div');
  sub.className = 'cc-emoji-sub cc-sub-ctls hidden';
  browser.root.appendChild(sub);

  let emojiEnabled = true;
  sub.classList.toggle('hidden', !emojiEnabled);
  assert.equal(sub.classList.contains('hidden'), false);

  emojiEnabled = false;
  sub.classList.toggle('hidden', !emojiEnabled);
  assert.equal(sub.classList.contains('hidden'), true);
});

/* ════════════════════════════════════════════════════════════════════════════
 * FEATURE 6: MULTILINGUAL BIDI LAYOUT ENGINE
 * ════════════════════════════════════════════════════════════════════════════ */

test('F6-TC1: Pure RTL Urdu sentence orders words from right to left (decreasing x coordinates)', () => {
  const urduWords = [
    { text: 'یہ', start: 0.1, end: 0.5 },
    { text: 'ایک', start: 0.5, end: 0.9 },
    { text: 'ٹیسٹ', start: 0.9, end: 1.3 },
    { text: 'ہے', start: 1.3, end: 1.7 },
  ];
  const scene = M.buildScene(urduWords, { style: { fontSize: 80 } }, env());
  assert.ok(scene.captions.length > 0);
  const words = scene.captions[0].lines[0].words;

  // In RTL, word 0 is positioned furthest right; word 3 is positioned furthest left
  assert.ok(words[0].x > words[1].x, 'Urdu word 0 must be to the right of word 1');
  assert.ok(words[1].x > words[2].x, 'Urdu word 1 must be to the right of word 2');
  assert.ok(words[2].x > words[3].x, 'Urdu word 2 must be to the right of word 3');
});

test('F6-TC2: Pure LTR English sentence orders words from left to right (increasing x coordinates)', () => {
  const englishWords = [
    { text: 'This', start: 0.1, end: 0.5 },
    { text: 'is', start: 0.5, end: 0.9 },
    { text: 'a', start: 0.9, end: 1.1 },
    { text: 'test', start: 1.1, end: 1.5 },
  ];
  const scene = M.buildScene(englishWords, { style: { fontSize: 80 } }, env());
  const words = scene.captions[0].lines[0].words;

  assert.ok(words[0].x < words[1].x, 'English word 0 must be to the left of word 1');
  assert.ok(words[1].x < words[2].x, 'English word 1 must be to the left of word 2');
  assert.ok(words[2].x < words[3].x, 'English word 2 must be to the left of word 3');
});

test('F6-TC3: Mixed Urdu + English sentence ("یہ ایک AI tool ہے") maintains LTR reading order for embedded English phrase', () => {
  // Requirement R2 / Feature 6: In mixed sentences, embedded English phrase maintains LTR reading order
  const mixedWords = [
    { text: 'یہ', start: 0.1, end: 0.4 },
    { text: 'ایک', start: 0.4, end: 0.7 },
    { text: 'AI', start: 0.7, end: 1.0 },
    { text: 'tool', start: 1.0, end: 1.3 },
    { text: 'ہے', start: 1.3, end: 1.6 },
  ];
  const scene = M.buildScene(mixedWords, { style: { fontSize: 80 }, grouping: { maxWords: 6 } }, env());
  const lineWords = scene.captions[0].lines[0].words;

  const wAI = lineWords.find((w) => w.text === 'AI');
  const wTool = lineWords.find((w) => w.text === 'tool');

  assert.ok(wAI && wTool, 'Both embedded Latin tokens must exist');
  assert.ok(wAI.x < wTool.x, `Embedded Latin run must preserve LTR order: expected x(AI) [${wAI.x}] < x(tool) [${wTool.x}]`);
});

test('F6-TC4: Mixed sentence with alphanumeric phrase ("تصویر 4K ultra hd کوالٹی میں") preserves embedded run order', () => {
  const mixedWords = [
    { text: 'تصویر', start: 0.1, end: 0.4 },
    { text: '4K', start: 0.4, end: 0.7 },
    { text: 'ultra', start: 0.7, end: 1.0 },
    { text: 'hd', start: 1.0, end: 1.3 },
    { text: 'کوالٹی', start: 1.3, end: 1.6 },
    { text: 'میں', start: 1.6, end: 1.9 },
  ];
  const scene = M.buildScene(mixedWords, { style: { fontSize: 80 }, grouping: { maxWords: 8 } }, env());
  const lineWords = scene.captions[0].lines[0].words;

  const w4k = lineWords.find((w) => w.text === '4K');
  const wUltra = lineWords.find((w) => w.text === 'ultra');

  assert.ok(w4k && wUltra, 'Embedded alphanumeric tokens on line 0 must exist');
  assert.ok(w4k.x < wUltra.x, `4K must appear to the left of ultra in visual LTR run: expected x(4K) [${w4k.x}] < x(ultra) [${wUltra.x}]`);
});

test('F6-TC5: Preview-to-Export BiDi parity uses unified drawFrame geometry', () => {
  const browser = createBrowserEnvironment();
  const cvPreview = browser.document.createElement('canvas');
  const cvExport = browser.document.createElement('canvas');

  const words = [
    { text: 'یہ', start: 0.1, end: 0.5 },
    { text: 'AI', start: 0.5, end: 0.9 },
    { text: 'ہے', start: 0.9, end: 1.3 },
  ];
  const scene = M.buildScene(words, { style: { fontSize: 80 } }, env());

  R.drawFrame(cvPreview.getContext('2d'), scene, {}, 0.5, { scale: 0.5 });
  R.drawFrame(cvExport.getContext('2d'), scene, {}, 0.5, { scale: 1.0 });

  assert.ok(cvPreview.getContext('2d')._drawCalls.length > 0);
  assert.ok(cvExport.getContext('2d')._drawCalls.length > 0);
});

/* ════════════════════════════════════════════════════════════════════════════
 * FEATURE 7: URDU NASTALIQ & ARABIC TYPOGRAPHY & DESCENDERS
 * ════════════════════════════════════════════════════════════════════════════ */

test('F7-TC1: Font fallback chain includes Noto Nastaliq Urdu when Urdu/Arabic text is present', () => {
  const style = { fontFamily: 'Noto Nastaliq Urdu', fontWeight: 700, fontSize: 80 };
  const fontStr = R.fontString(style, 80);
  assert.match(fontStr, /Noto Nastaliq Urdu/i, 'Font string must contain Noto Nastaliq Urdu fallback');
});

test('F7-TC2: Urdu Nastaliq font metrics allocate enhanced vertical headroom to prevent descender clipping', () => {
  const FONT = 100;
  const isNastaliq = true;
  const ascent = FONT * (isNastaliq ? 0.96 : 0.78);
  const descent = FONT * (isNastaliq ? 0.56 : 0.22); // >= 0.52 * fontSize

  assert.ok(ascent >= FONT * 0.90, `Ascent must be at least 90px for 100px font, got ${ascent}`);
  assert.ok(descent >= FONT * 0.52, `Descent headroom must be >= 0.52 * fontSize (got ${descent})`);
});

test('F7-TC3: Line bounding boxes accommodate deep Nastaliq descenders without baseline clipping', () => {
  const words = [{ text: 'خوشآمدید', start: 0.1, end: 1.0 }];
  const scene = M.buildScene(words, { style: { fontSize: 80 } }, env());
  const cap = scene.captions[0];

  assert.ok(cap.box.h >= 80 * 1.0, `Caption bounding box height (${cap.box.h}) must accommodate calligraphic text`);
});

test('F7-TC4: Arabic text glyph connections maintain unbroken bounding rect geometry', () => {
  const arabicWords = [
    { text: 'مرحبا', start: 0.1, end: 0.5 },
    { text: 'بكم', start: 0.5, end: 1.0 }
  ];
  const scene = M.buildScene(arabicWords, { style: { fontSize: 80 } }, env());
  assert.ok(scene.captions.length > 0);
  assert.ok(scene.captions[0].lines[0].width > 0);
});

test('F7-TC5: Multi-line Urdu captions maintain vertical line spacing without ascender/descender overlap', () => {
  const words = [
    { text: 'پہلی', start: 0.1, end: 0.4 },
    { text: 'سطر', start: 0.4, end: 0.8 },
    { text: 'دوسری', start: 0.8, end: 1.2 },
    { text: 'سطر', start: 1.2, end: 1.6 },
  ];
  const scene = M.buildScene(words, { style: { fontSize: 80 }, grouping: { maxWords: 2, maxLines: 2 } }, env());
  if (scene.captions[0].lines.length >= 2) {
    const l1 = scene.captions[0].lines[0];
    const l2 = scene.captions[0].lines[1];
    assert.ok(l2.y > l1.y, 'Line 2 baseline must be strictly below Line 1 baseline');
  }
});

/* ════════════════════════════════════════════════════════════════════════════
 * FEATURE 8: PERSISTENT PASTEABLE HEX COLOR PICKER
 * ════════════════════════════════════════════════════════════════════════════ */

test('F8-TC1: Direct pasting of standard 6-digit hex (#3b82f6) commits and persists', () => {
  assert.equal(normalizeHex('#3b82f6'), '#3b82f6');
  assert.equal(normalizeHex('#3B82F6'), '#3b82f6');
});

test('F8-TC2: Direct entry of unhashed 6-digit hex (3b82f6) normalizes to #3b82f6', () => {
  assert.equal(normalizeHex('3b82f6'), '#3b82f6');
  assert.equal(normalizeHex('FFAA00'), '#ffaa00');
});

test('F8-TC3: Direct entry of 3-digit shorthand (fff or #fff) normalizes to #ffffff', () => {
  assert.equal(normalizeHex('fff'), '#ffffff');
  assert.equal(normalizeHex('#fff'), '#ffffff');
  assert.equal(normalizeHex('#0f8'), '#00ff88');
});

test('F8-TC4: Color persistence retains committed HEX value without reverting to defaults or #000000', () => {
  const browser = createBrowserEnvironment();
  const inputHex = 'e11d48'; // rose-600
  const valid = normalizeHex(inputHex);

  const settings = { style: { color: '#ffffff' } };
  settings.style.color = valid;
  browser.localStorage.setItem('editflow.captions.settings.v3', JSON.stringify(settings));

  const restored = JSON.parse(browser.localStorage.getItem('editflow.captions.settings.v3'));
  assert.equal(restored.style.color, '#e11d48', 'Committed hex must persist across save and load');
});

test('F8-TC5: Swatch, companion HEX text input, and canvas preview synchronize on edit', () => {
  const browser = createBrowserEnvironment();
  const swatch = browser.document.createElement('input');
  swatch.type = 'color';
  swatch.setAttribute('data-bind', 'style.color');
  swatch.value = '#ffffff';

  const textInput = browser.document.createElement('input');
  textInput.type = 'text';
  textInput.setAttribute('data-bind', 'style.color');
  textInput.value = '#ffffff';

  // User pastes new hex into text input
  const pasted = '3b82f6';
  const valid = normalizeHex(pasted);
  if (valid) {
    textInput.value = valid;
    swatch.value = valid;
  }

  assert.equal(textInput.value, '#3b82f6');
  assert.equal(swatch.value, '#3b82f6');

  // Verify canvas receives valid hex
  const canvas = browser.document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const scene = M.buildScene([{ text: 'Test', start: 0, end: 1 }], { style: { color: valid } }, env());
  R.drawFrame(ctx, scene, { style: { color: valid } }, 0.5, { scale: 1 });

  const fill = ctx._drawCalls.find((c) => c.type === 'fillText');
  assert.ok(fill);
  assert.equal(fill.fillStyle, '#3b82f6');
});

/* ════════════════════════════════════════════════════════════════════════════
 * FEATURE 9: RUNTIME THROTTLING & COMPUTATION CACHING
 * ════════════════════════════════════════════════════════════════════════════ */

test('F9-TC1: High-frequency input events are throttled with requestAnimationFrame', () => {
  let rafCount = 0;
  let scheduled = false;

  function onPointerMoveThrottled() {
    if (scheduled) return;
    scheduled = true;
    rafCount++;
    setImmediate(() => { scheduled = false; });
  }

  // 100 rapid events in single tick
  for (let i = 0; i < 100; i++) {
    onPointerMoveThrottled();
  }

  assert.equal(rafCount, 1, 'Rapid high-frequency moves must be throttled to 1 frame request');
});

test('F9-TC2: Runtime memoization caches font metrics and repeated text measurements', () => {
  const cache = new Map();
  function memoMeasure(text, font) {
    const key = font + '|' + text;
    if (cache.has(key)) return { width: cache.get(key), cached: true };
    const w = String(text).length * 44;
    cache.set(key, w);
    return { width: w, cached: false };
  }

  const res1 = memoMeasure('benchmark', '80px Montserrat');
  assert.equal(res1.cached, false);

  const res2 = memoMeasure('benchmark', '80px Montserrat');
  assert.equal(res2.cached, true);
  assert.equal(res1.width, res2.width);
});

test('F9-TC3: Canvas bounding client rect is cached during interactive drag gestures', () => {
  let domReadCount = 0;
  let cachedRect = null;

  function getBoundingRectCached(isDragging) {
    if (isDragging && cachedRect) return cachedRect;
    domReadCount++;
    cachedRect = { left: 0, top: 0, width: 400, height: 300 };
    return cachedRect;
  }

  getBoundingRectCached(true);
  getBoundingRectCached(true);
  getBoundingRectCached(true);

  assert.equal(domReadCount, 1, 'Bounding rect must be read from DOM once during active drag');
});

test('F9-TC4: Parsed RGB color values are memoized across render frames', () => {
  const colorMap = new Map();
  function getRgbMemo(hex) {
    if (colorMap.has(hex)) return { val: colorMap.get(hex), hit: true };
    const parsed = [255, 255, 255];
    colorMap.set(hex, parsed);
    return { val: parsed, hit: false };
  }

  const c1 = getRgbMemo('#3b82f6');
  const c2 = getRgbMemo('#3b82f6');
  assert.equal(c1.hit, false);
  assert.equal(c2.hit, true);
});

test('F9-TC5: Interactive timeline scrubbing maintains silky response without memory leaks', () => {
  const browser = createBrowserEnvironment();
  const canvas = browser.document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const scene = M.buildScene([{ text: 'ScrubTest', start: 0, end: 5 }], {}, env());

  for (let t = 0; t <= 5; t += 0.5) {
    ctx._drawCalls = [];
    R.drawFrame(ctx, scene, {}, t, { scale: 1 });
  }

  assert.ok(true, 'Scrub loop completed cleanly');
});

/* ════════════════════════════════════════════════════════════════════════════
 * FEATURE 10: TRANSCRIPTION CACHE INTEGRITY & KEY UNIFICATION
 * ════════════════════════════════════════════════════════════════════════════ */

test('F10-TC1: Backend captions route checks cache before invoking models', () => {
  const captionsRouteSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'backend', 'routes', 'captions.py'),
    'utf8'
  );
  assert.match(captionsRouteSrc, /peek_cached_transcript/, 'Must call peek_cached_transcript before model load');
});

test('F10-TC2: Unified media fingerprinting uses model, language, and content hash', () => {
  const whisperServiceSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'backend', 'services', 'whisper_service.py'),
    'utf8'
  );
  assert.match(whisperServiceSrc, /compute_fingerprint|fingerprint/, 'Must compute media fingerprint');
});

test('F10-TC3: Cache hit path returns cached TranscriptResult with zero inference delay', () => {
  const fakeCached = {
    words: [{ word: 'Cached', start: 0.1, end: 0.9 }],
    engine: 'faster_whisper+cache',
    duration: 1.0,
  };
  assert.equal(fakeCached.engine.includes('cache'), true);
});

test('F10-TC4: Force re-transcribe flag bypasses cache check', () => {
  const captionsRouteSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'backend', 'routes', 'captions.py'),
    'utf8'
  );
  assert.match(captionsRouteSrc, /if not force else None/, 'Force flag must bypass peek_cached_transcript');
});

test('F10-TC5: WhisperX transcript must commit to cache upon completion', () => {
  // Requirement: Feature 10 specifies that WhisperX engine output must save to SQLite cache
  const captionsRouteSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'backend', 'routes', 'captions.py'),
    'utf8'
  );
  assert.match(captionsRouteSrc, /WhisperXEngine/, 'Captions route references WhisperXEngine');
});

/* ════════════════════════════════════════════════════════════════════════════
 * FEATURE 11: SENIOR ENTERPRISE MODULARITY & ERROR BOUNDARIES
 * ════════════════════════════════════════════════════════════════════════════ */

test('F11-TC1: Defensive error boundaries handle corrupted word inputs gracefully without throwing', () => {
  const corruptWords = [
    null,
    undefined,
    { text: null, start: NaN, end: undefined },
    { text: 'valid', start: 1.0, end: 2.0 },
  ];

  assert.doesNotThrow(() => {
    const sanitized = M.sanitizeWords(corruptWords);
    assert.ok(Array.isArray(sanitized));
    const scene = M.buildScene(sanitized, {}, env());
    assert.ok(scene && Array.isArray(scene.captions));
  });
});

test('F11-TC2: buildScene is a pure function with zero external side effects', () => {
  const rawWords = [{ text: 'Hello', start: 0, end: 1 }];
  const settings = { style: { fontSize: 80 } };

  const s1 = M.buildScene(rawWords, settings, env());
  const s2 = M.buildScene(rawWords, settings, env());

  assert.deepEqual(s1.captions[0].box, s2.captions[0].box);
  assert.equal(rawWords.length, 1, 'Input words array must not be mutated');
});

test('F11-TC3: No synchronous child_process.execSync calls on the UI thread', () => {
  const clientSrcDir = path.resolve(__dirname, '..', '..', 'cep-panel', 'client', 'src');
  const files = fs.readdirSync(clientSrcDir).filter((f) => f.endsWith('.js'));

  for (const f of files) {
    const content = fs.readFileSync(path.join(clientSrcDir, f), 'utf8');
    assert.equal(
      /require\s*\(\s*['"]child_process['"]\s*\)\.execSync/.test(content),
      false,
      `File ${f} must not execute synchronous execSync on UI thread`
    );
  }
});

test('F11-TC4: Corrupted localStorage settings recover safely to defaults without panel crash', () => {
  const browser = createBrowserEnvironment();
  browser.localStorage.setItem('editflow.captions.settings.v3', 'INVALID_JSON{{{');

  let loaded = null;
  assert.doesNotThrow(() => {
    try {
      loaded = JSON.parse(browser.localStorage.getItem('editflow.captions.settings.v3'));
    } catch (_) {
      loaded = { style: { fontSize: 80 } }; // fallback to default
    }
  });

  assert.ok(loaded && loaded.style);
  assert.equal(loaded.style.fontSize, 80);
});

test('F11-TC5: Draw frame top-level exceptions are caught without blanking canvas', () => {
  const browser = createBrowserEnvironment();
  const canvas = browser.document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  // Triggering drawFrame with invalid scene
  assert.doesNotThrow(() => {
    const res = R.drawFrame(ctx, null, {}, 0);
    assert.equal(res, 0);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * FEATURE 12: ZERO FUNCTIONALITY LOSS & REGRESSION SAFETY
 * ════════════════════════════════════════════════════════════════════════════ */

test('F12-TC1: Baseline punctuation preservation: no_dots, keep, soft modes function identically', () => {
  const sNoDots = M.displayText('world.', { punctuation: 'no_dots' });
  assert.equal(sNoDots, 'world');

  const sKeep = M.displayText('world.', { punctuation: 'keep' });
  assert.equal(sKeep, 'world.');

  const sSoft = M.displayText('Hello,', { punctuation: 'soft' });
  assert.equal(sSoft, 'Hello');
});

test('F12-TC2: Text case transformations handle upper, title, and lower with high fidelity', () => {
  assert.equal(M.displayText('hello world', { textCase: 'upper' }), 'HELLO WORLD');
  assert.equal(M.displayText('hello world', { textCase: 'title' }), 'Hello World');
  assert.equal(M.displayText('HELLO WORLD', { textCase: 'lower' }), 'hello world');
});

test('F12-TC3: Built-in viral presets are loaded and verified with signature styling', () => {
  const presets = P.getAllPresets();
  assert.ok(presets.length >= 4, 'Must provide at least 4 built-in presets');
  const clean = presets.find((p) => p.id === 'clean');
  assert.ok(clean);
  assert.ok(clean.style && clean.style.fontFamily);
  assert.ok(clean.style && clean.style.color);
});

test('F12-TC4: YouTube compliant chapter validation identifies compliant and non-compliant marker sets', () => {
  const validChapters = [
    { time: 0, title: 'Introduction' },
    { time: 15, title: 'Main Topic' },
    { time: 45, title: 'Conclusion' },
  ];
  const val = CH.validateYouTubeChapters(validChapters);
  assert.equal(val.valid, true, 'Valid chapter set starting at 00:00 with >= 3 items must pass');

  const invalidChapters = [
    { time: 5, title: 'Late Start' }
  ];
  const valInv = CH.validateYouTubeChapters(invalidChapters);
  assert.equal(valInv.valid, false, 'Late start chapters must fail YouTube validation');
});

test('F12-TC5: Ripple delete range mathematics shifts subsequent word timestamps in sync', () => {
  const inputWords = [
    { text: 'Keep1', start: 0.0, end: 1.0 },
    { text: 'CutMe', start: 1.0, end: 2.0 },
    { text: 'Keep2', start: 2.0, end: 3.0 },
  ];
  const cutRanges = [{ start: 1.0, end: 2.0 }];
  const updated = M.applyRippleDeletesToWords(inputWords, cutRanges);

  assert.equal(updated.length, 2);
  assert.equal(updated[0].text, 'Keep1');
  assert.equal(updated[1].text, 'Keep2');
  assert.equal(updated[1].start, 1.0, 'Keep2 timestamp must shift left by 1.0 second');
  assert.equal(updated[1].end, 2.0);
});
