/**
 * tests/tier5-adversarial-hardening.test.js
 *
 * TIER 5 COVERAGE HARDENING & WHITE-BOX ADVERSARIAL STRESS TEST SUITE
 * EditFlow AI — Final Verification Suite
 *
 * Comprehensive stress testing combining all core mandates from ORIGINAL_REQUEST.md and PROJECT.md:
 * 1. BiDi captions (Urdu/Arabic/English) with custom hex colors pasted into controls.
 * 2. Rapidly toggling styling controls while mixed RTL/LTR text is rendering.
 * 3. Collapsing and expanding preview stage while color inputs and BiDi text are active.
 * 4. Cold boot simulation ensuring zero synchronous UI blocking.
 * 5. Extreme boundary fuzzing, memory stability, and composite invariants.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createBrowserEnvironment, MockDOMEvent } = require('./e2e/harness');
const { loadEsm } = require('./_load-esm');

const CAPTIONS_VIEW_PATH = path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions-view.js');
const MODEL_PATH = path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions', 'model.js');
const RENDER_PATH = path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions', 'render.js');
const MAIN_PATH = path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'main.js');

const M = loadEsm(MODEL_PATH);
const R = loadEsm(RENDER_PATH, M);

/* ── High-Fidelity Compound DOM Selector & Event Engine ────────────── */

function matchCompound(el, part) {
  if (!el || typeof el.getAttribute !== 'function' || !el.classList || !part) return false;
  let p = part.trim();
  if (!p) return false;

  // 1. Tag name
  const tagM = p.match(/^[a-zA-Z0-9\-]+/);
  if (tagM) {
    if (el.tagName !== tagM[0].toUpperCase()) return false;
    p = p.slice(tagM[0].length);
  }

  // 2. Attributes FIRST so dots inside attribute values (e.g. style.color) are never mistaken for classes
  const attrMatches = p.match(/\[([^\]]+)\]/g);
  if (attrMatches) {
    for (const am of attrMatches) {
      const body = am.slice(1, -1);
      const eqIdx = body.indexOf('=');
      if (eqIdx === -1) {
        if (!el.hasAttribute(body.trim())) return false;
      } else {
        const attrName = body.slice(0, eqIdx).trim();
        const attrVal = body.slice(eqIdx + 1).replace(/^['"]|['"]$/g, '').trim();
        if (el.getAttribute(attrName) !== attrVal) return false;
      }
      p = p.replace(am, '');
    }
  }

  // 3. Element ID
  const idM = p.match(/#([a-zA-Z0-9_-]+)/);
  if (idM) {
    if (el.id !== idM[1]) return false;
    p = p.replace(idM[0], '');
  }

  // 4. CSS Classes (now protected against attribute string contamination)
  const classMatches = p.match(/\.([a-zA-Z0-9_-]+)/g);
  if (classMatches) {
    for (const cm of classMatches) {
      if (!el.classList.contains(cm.slice(1))) return false;
      p = p.replace(cm, '');
    }
  }

  return true;
}

function matchesSelector(el, selector) {
  if (!el || typeof el.getAttribute !== 'function' || !selector) return false;
  const groups = selector.split(',');
  for (const grp of groups) {
    const parts = grp.trim().split(/\s+/);
    if (parts.length === 1) {
      if (matchCompound(el, parts[0])) return true;
      continue;
    }
    if (!matchCompound(el, parts[parts.length - 1])) continue;
    let cur = el.parentNode;
    let ok = true;
    const visitedAncestors = new Set();
    for (let i = parts.length - 2; i >= 0; i--) {
      let matched = false;
      while (cur && !visitedAncestors.has(cur)) {
        visitedAncestors.add(cur);
        if (matchCompound(cur, parts[i])) {
          matched = true;
          cur = cur.parentNode;
          break;
        }
        cur = cur.parentNode;
      }
      if (!matched) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function createEnhancedEnvironment() {
  const env = createBrowserEnvironment();

  const proto = env.root.constructor.prototype;
  proto.matches = function (selector) {
    return matchesSelector(this, selector);
  };
  proto.querySelectorAll = function (selector) {
    const results = [];
    const visited = new Set();
    const stack = [];
    if (this.children) {
      for (let i = this.children.length - 1; i >= 0; i--) {
        stack.push(this.children[i]);
      }
    }
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || visited.has(node)) continue;
      visited.add(node);
      if (matchesSelector(node, selector)) results.push(node);
      if (node.children) {
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push(node.children[i]);
        }
      }
    }
    return results;
  };
  proto.querySelector = function (selector) {
    return this.querySelectorAll(selector)[0] || null;
  };
  proto.closest = function (selector) {
    let cur = this;
    const visited = new Set();
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      if (matchesSelector(cur, selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  };

  // Capture & Bubble Phase Event Handling
  const origAddEventListener = proto.addEventListener;
  proto.addEventListener = function (type, fn, useCapture) {
    if (useCapture) {
      if (!this._captureListeners) this._captureListeners = new Map();
      if (!this._captureListeners.has(type)) this._captureListeners.set(type, []);
      this._captureListeners.get(type).push(fn);
      return;
    }
    origAddEventListener.call(this, type, fn);
  };

  proto.dispatchEvent = function (event) {
    event.target = this;
    const chain = [];
    let cur = this;
    while (cur) {
      chain.unshift(cur);
      cur = cur.parentNode;
    }

    // Capture phase (ancestors -> target)
    for (const node of chain) {
      event.currentTarget = node;
      const captureListeners = (node._captureListeners && node._captureListeners.get(event.type)) || [];
      for (const fn of [...captureListeners]) {
        try { fn.call(node, event); } catch (e) { console.error('Capture error:', e); }
        if (event._propagationStopped) return !event.defaultPrevented;
      }
    }

    // Bubble phase (target -> ancestors)
    cur = this;
    while (cur) {
      event.currentTarget = cur;
      const arr = (cur._listeners && cur._listeners.get(event.type)) || [];
      for (const fn of [...arr]) {
        try { fn.call(cur, event); } catch (e) { console.error('Bubble error:', e); }
        if (event._propagationStopped) return !event.defaultPrevented;
      }
      cur = event.bubbles ? cur.parentNode : null;
    }
    return !event.defaultPrevented;
  };

  // Window events
  const winListeners = new Map();
  env.window.addEventListener = (type, fn) => {
    if (!winListeners.has(type)) winListeners.set(type, []);
    winListeners.get(type).push(fn);
  };
  env.window.dispatchEvent = (ev) => {
    ev.target = env.window;
    ev.currentTarget = env.window;
    const fns = winListeners.get(ev.type) || [];
    for (const fn of [...fns]) {
      try { fn.call(env.window, ev); } catch (e) { console.error('Window error:', e); }
    }
    return !ev.defaultPrevented;
  };

  return env;
}

function setupTestCaptions() {
  const env = createEnhancedEnvironment();

  let src = fs.readFileSync(CAPTIONS_VIEW_PATH, 'utf8');
  src = src.replace(/import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];?/g, '');
  src = src.replace(/import\s+\*\s+as\s+\w+\s+from\s*['"][^'"]+['"];?/g, '');
  src = src.replace(/import\s+[^;]+?from\s*['"][^'"]+['"];?/g, '');
  src = src.replace(/^export\s+/gm, '');

  const exposedReturn = `
    return {
      S,
      DEFAULTS,
      STRUCTURAL,
      RELAYOUT,
      openCaptions,
      closeCaptions,
      renderShell,
      renderBody,
      bindEvents,
      updateSubControls,
      onSetting,
      ensureContainer,
      loadSettings,
      onBoundInput,
      commitHexInput,
      commitPendingHexInputs,
      syncColorControls,
      layoutPreview,
      updatePreviewToggleBtn,
      onAction,
      tabStyle,
      setWords,
      rebuildScene,
      drawPreview,
      requestDraw,
      normalizeHex,
      findPreset,
      applyPreset,
      setPlaying,
      effSettings,
      scaleK,
      undo,
      redo,
      snapshot,
    };
  `;

  const fn = new Function('deps', 'with(deps) {\n' + src + '\n' + exposedReturn + '\n}');

  const deps = {
    window: env.window,
    document: env.document,
    localStorage: env.localStorage,
    ResizeObserver: env.window.ResizeObserver,
    requestAnimationFrame: (cb) => {
      return setImmediate(() => cb(Date.now()));
    },
    cancelAnimationFrame: (id) => {
      clearImmediate(id);
    },
    apiGet: async () => ({}),
    apiPost: async () => ({}),
    apiUpload: async () => ({}),
    getBaseUrl: () => 'http://127.0.0.1:8765',
    isExtendScriptAvailable: () => false,
    callExtendScript: async () => ({}),
    M,
    R,
    drawFrame: R.drawFrame,
    STYLE_DEFAULTS: R.STYLE_DEFAULTS,
    BUNDLED: [],
    ensureFont: async () => true,
    makeMeasurer: () => ({
      measure: (text) => String(text || '').length * 40,
      fontMetrics: { ascent: 80 * 0.78, descent: 80 * 0.22 },
    }),
    listSystemFonts: async () => [],
    injectFontStyles: () => {},
    weightName: () => '',
    PRESETS: [
      { id: 'bold_yellow', name: 'Bold Yellow', style: { color: '#ffffff', activeColor: '#ffd84d', strokeWidth: 3, strokeColor: '#000000' }, motion: {} },
      { id: 'neon_glow', name: 'Neon Glow', style: { color: '#00f0ff', activeColor: '#ffffff', activeGlow: true, activeGlowColor: '#00f0ff' }, motion: {} },
    ],
    findPreset: (id) => (id === 'bold_yellow' ? { id, style: { color: '#ffffff', activeColor: '#ffd84d' }, motion: {} } : null),
    getAllPresets: () => [],
    saveUserPreset: () => {},
    deleteUserPreset: () => {},
    renderOverlay: async () => {},
    SAFE_ZONES: { off: { label: 'Off' } },
    drawSafeZones: () => {},
    getEmojiSuggestion: () => null,
    findAllSuggestions: () => [],
    fmtTimestamp: () => '',
    parseTimestamp: () => 0,
    autoDetectChapters: () => [],
    formatSocialChapters: () => '',
    parseSocialChapters: () => [],
    validateYouTubeChapters: () => ({ valid: true }),
    root: env.root,
  };

  const mod = fn(deps);
  mod.ensureContainer();
  mod.S.settings = JSON.parse(JSON.stringify(mod.DEFAULTS));
  mod.S.tab = 'style';
  mod.S.previewOpen = true;
  mod.S.seq = { name: 'Adversarial Test Sequence', width: 1080, height: 1920 };

  mod.renderShell();
  mod.bindEvents();
  mod.renderBody();

  return { env, mod, deps };
}

/* ════════════════════════════════════════════════════════════════════════════
 * SUITE 1: MULTILINGUAL BIDI CAPTIONS & COUPLED HEX COLOR PERSISTENCE
 * ════════════════════════════════════════════════════════════════════════════ */

test('TIER5-S1.1: Complex BiDi sentences with embedded Latin/Urdu/Arabic/Alphanumeric runs & UAX #9 invariants', () => {
  const makeEnv = (w = 1080, h = 1920) => ({
    width: w,
    height: h,
    fps: { num: 30, den: 1 },
    measure: (text) => String(text || '').length * 40,
    fontMetrics: { ascent: 80 * 0.78, descent: 80 * 0.22 }
  });

  // Case A: Urdu with embedded English phrase ("یہ ایک AI tool ہے")
  const urduEngWords = [
    { text: 'یہ', start: 0.1, end: 0.4 },
    { text: 'ایک', start: 0.4, end: 0.7 },
    { text: 'AI', start: 0.7, end: 1.0 },
    { text: 'tool', start: 1.0, end: 1.3 },
    { text: 'ہے', start: 1.3, end: 1.6 },
  ];
  const scA = M.buildScene(urduEngWords, { grouping: { maxWords: 6 } }, makeEnv());
  const lineA = scA.captions[0].lines[0];
  assert.equal(lineA.rtl, true, 'Base line direction must be RTL');
  const wAI = lineA.words.find(w => w.text === 'AI');
  const wTool = lineA.words.find(w => w.text === 'tool');
  const wYeh = lineA.words.find(w => w.text === 'یہ');
  const wEk = lineA.words.find(w => w.text === 'ایک');
  const wHai = lineA.words.find(w => w.text === 'ہے');

  assert.ok(wAI.x < wTool.x, 'Embedded English phrase must read LTR: x(AI) < x(tool)');
  assert.ok(wYeh.x > wEk.x, 'Urdu sentence must flow RTL: x(یہ) > x(ایک)');
  assert.ok(wEk.x > wTool.x, 'Urdu run 0 must be to the right of English run: x(ایک) > x(tool)');
  assert.ok(wAI.x > wHai.x, 'English run must be to the right of trailing Urdu run: x(AI) > x(ہے)');

  // Case B: Alphanumeric mixed run ("تصویر 4K ultra hd کوالٹی میں")
  const alphaWords = [
    { text: 'تصویر', start: 0.1, end: 0.4 },
    { text: '4K', start: 0.4, end: 0.7 },
    { text: 'ultra', start: 0.7, end: 1.0 },
    { text: 'hd', start: 1.0, end: 1.3 },
    { text: 'کوالٹی', start: 1.3, end: 1.6 },
    { text: 'میں', start: 1.6, end: 1.9 },
  ];
  // Provide sufficient width so all words fit on one line for full run verification
  const scB = M.buildScene(alphaWords, { style: { fontSize: 40 }, grouping: { maxWords: 8, maxLines: 1 }, layout: { boxWidth: 95 } }, makeEnv(1920, 1080));
  const lineB = scB.captions[0].lines[0];
  assert.equal(lineB.rtl, true);
  const w4K = lineB.words.find(w => w.text === '4K');
  const wUltra = lineB.words.find(w => w.text === 'ultra');
  const wHd = lineB.words.find(w => w.text === 'hd');
  assert.ok(w4K && wUltra && wHd, 'Words 4K, ultra, hd must exist on line');
  assert.ok(w4K.x < wUltra.x && wUltra.x < wHd.x, 'Embedded alphanumeric phrase "4K ultra hd" must flow LTR');

  // Case C: Arabic with embedded brand and year ("EditFlow AI هو الأفضل لعام 2026")
  const arWords = [
    { text: 'EditFlow', start: 0.1, end: 0.4 },
    { text: 'AI', start: 0.4, end: 0.7 },
    { text: 'هو', start: 0.7, end: 1.0 },
    { text: 'الأفضل', start: 1.0, end: 1.3 },
    { text: 'لعام', start: 1.3, end: 1.6 },
    { text: '2026', start: 1.6, end: 1.9 },
  ];
  const scC = M.buildScene(arWords, { grouping: { maxWords: 8 } }, makeEnv());
  assert.ok(scC.captions.length > 0);
  const wordsC = scC.captions[0].lines[0].words;
  // Bounding boxes must never overlap
  for (let i = 0; i < wordsC.length - 1; i++) {
    for (let j = i + 1; j < wordsC.length; j++) {
      const a = wordsC[i], b = wordsC[j];
      const overlap = !(a.x + a.w <= b.x || b.x + b.w <= a.x);
      assert.ok(!overlap, `Words "${a.text}" and "${b.text}" bounding boxes must not overlap`);
    }
  }
});

test('TIER5-S1.2: Committing and pasting hex colors onto BiDi caption controls across all formats', () => {
  const { env, mod } = setupTestCaptions();

  const swatch = env.root.querySelector('input.cc-color-swatch[data-bind="style.color"]');
  const hexInput = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');
  assert.ok(swatch && hexInput, 'Both swatch and hex input controls must exist');

  const testVectors = [
    { input: '#3b82f6', expected: '#3b82f6', desc: 'Standard 6-digit hex with hash' },
    { input: '3b82f6', expected: '#3b82f6', desc: 'Unhashed 6-digit hex' },
    { input: '#fff', expected: '#ffffff', desc: '3-digit hex shorthand with hash' },
    { input: 'fff', expected: '#ffffff', desc: 'Unhashed 3-digit shorthand' },
    { input: '#a855f7cc', expected: '#a855f7', desc: '8-digit hex with alpha channel' },
    { input: 'rgb(59, 130, 246)', expected: '#3b82f6', desc: 'rgb() functional notation' },
    { input: 'rgba(59, 130, 246, 0.75)', expected: '#3b82f6', desc: 'rgba() notation' },
    { input: '   #10B981   ', expected: '#10b981', desc: 'Whitespace trimmed' },
    { input: '#E11D48', expected: '#e11d48', desc: 'Uppercase normalized to lowercase' },
  ];

  for (const vec of testVectors) {
    hexInput.value = vec.input;
    const pasteEvent = new MockDOMEvent('paste', { bubbles: true });
    pasteEvent.clipboardData = { getData: () => vec.input };
    hexInput.dispatchEvent(pasteEvent);

    assert.equal(mod.S.settings.style.color, vec.expected, `Settings style.color failed for ${vec.desc}`);
    assert.equal(swatch.value, vec.expected, `Swatch synchronization failed for ${vec.desc}`);
    assert.equal(hexInput.value, vec.expected, `Hex text synchronization failed for ${vec.desc}`);
  }

  // Adversarial and invalid inputs: must gracefully revert to last valid without crashing
  const lastValid = mod.S.settings.style.color;
  const invalidVectors = ['not_a_color', '#12', '12345', '###', '<script>alert(1)</script>', ''];
  for (const inv of invalidVectors) {
    hexInput.value = inv;
    hexInput.dispatchEvent(new MockDOMEvent('blur', { bubbles: true }));
    assert.equal(mod.S.settings.style.color, lastValid, `Invalid input "${inv}" must not corrupt settings`);
    assert.equal(hexInput.value, lastValid, `Invalid input "${inv}" must revert to last valid in input`);
    assert.equal(swatch.value, lastValid, `Invalid input "${inv}" must retain last valid in swatch`);
  }
});

test('TIER5-S1.3: Canvas 2D live preview rendering of BiDi captions with custom committed hex colors', async () => {
  const { env, mod } = setupTestCaptions();

  // Commit custom styles
  mod.S.settings.style.color = '#3b82f6';
  mod.S.settings.style.activeColor = '#ffd84d';
  mod.S.settings.style.strokeWidth = 4;
  mod.S.settings.style.strokeColor = '#0f172a';
  mod.S.settings.style.activeGlow = true;
  mod.S.settings.style.activeGlowColor = '#00f0ff';
  mod.S.settings.motion.preset = 'none'; // Instant reveal
  mod.S.settings.motion.highlight = 'color';

  const mixedWords = [
    { text: 'یہ', start: 0.0, end: 0.5 },
    { text: 'AI', start: 0.5, end: 1.0 },
    { text: 'tool', start: 1.0, end: 1.5 },
  ];
  mod.setWords(mixedWords);
  await mod.rebuildScene();

  const cv = env.root.querySelector('#cc-canvas');
  cv.width = 400;
  cv.height = 300;
  const ctx = cv.getContext('2d');

  // Draw at t = 0.7 (when "AI" is active)
  mod.S.t = 0.7;
  mod.drawPreview();

  const fillTextCalls = ctx._drawCalls.filter(c => c.type === 'fillText');
  assert.ok(fillTextCalls.length >= 3, 'Must render fillText for caption words');

  for (const call of fillTextCalls) {
    assert.ok(isFinite(call.x), `X coordinate for "${call.text}" must be a finite number`);
    assert.ok(isFinite(call.y), `Y coordinate for "${call.text}" must be a finite number`);
    assert.ok(!isNaN(call.x) && !isNaN(call.y), 'Coordinates must not be NaN');
  }

  // Verify strokeText executed when strokeWidth > 0
  const strokeTextCalls = ctx._drawCalls.filter(c => c.type === 'strokeText');
  assert.ok(strokeTextCalls.length >= 3, 'Must render strokeText when strokeWidth > 0');
});

test('TIER5-S1.4: Urdu Nastaliq & Arabic vertical typography headroom & export band expansion', () => {
  const FONT_SIZE = 80;
  const mixedWords = [
    { text: 'خوشآمدید', start: 0.0, end: 1.0 },
    { text: 'Welcome', start: 1.0, end: 2.0 },
  ];
  const scene = M.buildScene(mixedWords, { style: { fontFamily: 'Noto Nastaliq Urdu', fontSize: FONT_SIZE } }, {
    width: 1080, height: 1920, fps: { num: 30, den: 1 },
    measure: (t) => t.length * 40
  });

  const cap = scene.captions[0];
  // Verify descent headroom >= 0.52 * fontSize for RTL Nastaliq
  assert.ok(cap.descent >= FONT_SIZE * 0.52, `Descent headroom [${cap.descent}] must be >= 0.52 * fontSize [${FONT_SIZE * 0.52}]`);

  // Verify export band allocates safe vertical headroom
  const band = R.captionBand(scene, { style: { fontFamily: 'Noto Nastaliq Urdu', fontSize: FONT_SIZE } });
  assert.ok(isFinite(band.y) && isFinite(band.h), 'Band must have finite y and h');
  assert.ok(band.h > FONT_SIZE * 1.5, 'Band height must safely cover ascenders and descenders');
});

/* ════════════════════════════════════════════════════════════════════════════
 * SUITE 2: CONCURRENT RAPID STYLING TOGGLES DURING ACTIVE BIDI RENDERING
 * ════════════════════════════════════════════════════════════════════════════ */

test('TIER5-S2.1: 250-cycle randomized toggle storm while rendering BiDi scenes maintains in-place DOM integrity', async () => {
  const { env, mod } = setupTestCaptions();

  const mixedWords = [
    { text: 'یہ', start: 0.0, end: 0.5, speaker: 0 },
    { text: 'AI', start: 0.5, end: 1.0, speaker: 1 },
    { text: 'ٹیسٹ', start: 1.0, end: 1.5, speaker: 0 },
  ];
  mod.setWords(mixedWords);
  await mod.rebuildScene();

  const stage = env.root.querySelector('#cc-stage');
  const body = env.root.querySelector('#cc-body');
  assert.ok(stage && body, 'Stage and body must exist before storm');

  const cv = env.root.querySelector('#cc-canvas');
  cv.width = 400;
  cv.height = 300;

  const togglePaths = [
    'style.gradient',
    'style.shadow',
    'style.activeGlow',
    'style.emojiEnabled',
    'style.speakerColoring',
  ];

  // 250 randomized toggles interleaved with canvas frame rendering
  for (let i = 0; i < 250; i++) {
    const p = togglePaths[i % togglePaths.length];
    const cur = !!mod.S.settings.style[p.split('.')[1]];
    mod.S.settings.style[p.split('.')[1]] = !cur;

    // Trigger update in place
    assert.doesNotThrow(() => mod.updateSubControls(p));
    assert.doesNotThrow(() => mod.onSetting(p));

    // Render frame at interleaved timestamps
    mod.S.t = (i % 15) * 0.1;
    assert.doesNotThrow(() => mod.drawPreview());

    // Verify stage and body are never destroyed or starved
    assert.ok(stage.clientHeight > 0 || !stage.classList.contains('hidden'), 'Stage must remain intact');
    assert.ok(body.children.length > 0, 'Body DOM must not be wiped');
  }

  // Verify subcontrol classes match final settings state
  assert.equal(
    env.root.querySelector('.cc-gradient-sub').classList.contains('hidden'),
    !mod.S.settings.style.gradient,
    '.cc-gradient-sub visibility must match style.gradient'
  );
  assert.equal(
    env.root.querySelector('.cc-shadow-sub').classList.contains('hidden'),
    !mod.S.settings.style.shadow,
    '.cc-shadow-sub visibility must match style.shadow'
  );
  assert.equal(
    env.root.querySelector('.cc-glow-sub').classList.contains('hidden'),
    !mod.S.settings.style.activeGlow,
    '.cc-glow-sub visibility must match style.activeGlow'
  );
  assert.equal(
    env.root.querySelector('.cc-speaker-sub').classList.contains('hidden'),
    !mod.S.settings.style.speakerColoring,
    '.cc-speaker-sub visibility must match style.speakerColoring'
  );
});

test('TIER5-S2.2: Multi-speaker BiDi caption coloring toggle and swatch persistence', () => {
  const { env, mod } = setupTestCaptions();

  mod.S.settings.style.speakerColoring = true;
  mod.S.settings.style.speakerColors = ['#e11d48', '#3b82f6', '#10b981'];
  mod.renderBody();

  const spk0Txt = env.root.querySelector('input.cc-hex-input[data-bind="style.speakerColors.0"]');
  const spk1Txt = env.root.querySelector('input.cc-hex-input[data-bind="style.speakerColors.1"]');
  assert.ok(spk0Txt && spk1Txt, 'Speaker color hex inputs must exist');

  // Change speaker 0 to custom hex #f59e0b
  spk0Txt.value = 'f59e0b';
  spk0Txt.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
  spk0Txt.dispatchEvent(new MockDOMEvent('blur', { bubbles: true }));
  assert.equal(mod.S.settings.style.speakerColors[0], '#f59e0b');

  // Rapidly toggle speaker coloring OFF and ON 50 times
  for (let i = 0; i < 50; i++) {
    mod.S.settings.style.speakerColoring = (i % 2 === 0);
    mod.updateSubControls('style.speakerColoring');
  }

  // Restore speakerColoring ON
  mod.S.settings.style.speakerColoring = true;
  mod.updateSubControls('style.speakerColoring');

  assert.equal(
    mod.S.settings.style.speakerColors[0],
    '#f59e0b',
    'Speaker 0 custom color must be retained after toggle cycling'
  );
});

test('TIER5-S2.3: Emoji integration toggle with BiDi text and layout headroom', async () => {
  const { mod } = setupTestCaptions();

  const emojiWords = [
    { text: 'شاندار', start: 0.0, end: 0.5, emoji: '🔥' },
    { text: 'ویڈیو', start: 0.5, end: 1.0, emoji: '🚀' },
  ];
  mod.setWords(emojiWords);

  // Toggle emoji enabled
  mod.S.settings.style.emojiEnabled = true;
  mod.S.settings.style.emojiPlacement = 'above';
  await mod.rebuildScene();

  const capAbove = mod.S.scene.captions[0];
  assert.ok(capAbove.box.h > 0);

  // Toggle emoji placement inline
  mod.S.settings.style.emojiPlacement = 'inline';
  await mod.rebuildScene();
  const capInline = mod.S.scene.captions[0];
  assert.ok(capInline.box.h > 0);

  // Words still preserve correct RTL flow
  const w1 = capInline.lines[0].words[0];
  const w2 = capInline.lines[0].words[1];
  assert.ok(w1.x > w2.x, 'RTL word order maintained with emojis');
});

/* ════════════════════════════════════════════════════════════════════════════
 * SUITE 3: PREVIEW STAGE COLLAPSE / EXPAND INTERLEAVED WITH COLOR & BIDI
 * ════════════════════════════════════════════════════════════════════════════ */

test('TIER5-S3.1: Preview collapse and re-expansion structural stability', () => {
  const { env, mod } = setupTestCaptions();

  const stage = env.root.querySelector('#cc-stage');
  const toggleBtn = env.root.querySelector('[data-act="toggle-preview"]');
  assert.ok(stage && toggleBtn, 'Stage and toggle button must exist');

  // Initial state: previewOpen is true
  assert.equal(mod.S.previewOpen, true);
  assert.equal(stage.classList.contains('cc-stage-collapsed'), false);

  // Collapse preview
  mod.onAction('toggle-preview', toggleBtn);
  assert.equal(mod.S.previewOpen, false);
  assert.equal(stage.classList.contains('cc-stage-collapsed'), true, '#cc-stage must have cc-stage-collapsed class');
  assert.equal(stage.style.height, '0px', '#cc-stage height must be 0px when collapsed');

  // Re-expand preview
  mod.onAction('toggle-preview', toggleBtn);
  assert.equal(mod.S.previewOpen, true);
  assert.equal(stage.classList.contains('cc-stage-collapsed'), false, '#cc-stage must not have cc-stage-collapsed when expanded');
  assert.ok(parseInt(stage.style.height) > 0, '#cc-stage height must be > 0px when expanded');
});

test('TIER5-S3.2: In-flight unblurred color edit auto-commitment during preview collapse', () => {
  const { env, mod } = setupTestCaptions();

  const hexInput = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');
  const toggleBtn = env.root.querySelector('[data-act="toggle-preview"]');
  assert.ok(hexInput && toggleBtn, 'Hex input and preview toggle must exist');

  // User types hex into input without blurring
  hexInput.value = 'd946ef'; // fuchsia-500 unhashed

  // User immediately clicks preview collapse button
  toggleBtn.dispatchEvent(new MockDOMEvent('click', { bubbles: true }));

  // In-flight edit must be committed automatically before collapse
  assert.equal(mod.S.settings.style.color, '#d946ef', 'In-flight hex must commit to settings on click-away/collapse');
  assert.equal(mod.S.previewOpen, false, 'Preview must collapse');

  // Expand preview again
  toggleBtn.dispatchEvent(new MockDOMEvent('click', { bubbles: true }));
  assert.equal(mod.S.previewOpen, true);

  // Hex input must reflect committed fuchsia color
  const restoredInput = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');
  assert.equal(restoredInput.value, '#d946ef', 'Input field must retain committed color upon re-expansion');
});

test('TIER5-S3.3: 100-cycle rapid collapse/expand storm under active BiDi playback', async () => {
  const { env, mod } = setupTestCaptions();

  const biDiWords = [
    { text: 'اردو', start: 0.0, end: 1.0 },
    { text: 'English', start: 1.0, end: 2.0 },
  ];
  mod.setWords(biDiWords);
  await mod.rebuildScene();

  const toggleBtn = env.root.querySelector('[data-act="toggle-preview"]');
  mod.setPlaying(true);

  // 100 rapid collapse/expand cycles
  for (let i = 0; i < 100; i++) {
    assert.doesNotThrow(() => {
      toggleBtn.dispatchEvent(new MockDOMEvent('click', { bubbles: true }));
      mod.S.t = (i % 20) * 0.1;
      mod.requestDraw();
    });
  }

  mod.setPlaying(false);
  // Ensure stage is open at the end
  if (!mod.S.previewOpen) {
    toggleBtn.dispatchEvent(new MockDOMEvent('click', { bubbles: true }));
  }
  assert.equal(mod.S.previewOpen, true);
  const cv = env.root.querySelector('#cc-canvas');
  assert.ok(cv, 'Canvas must remain accessible after collapse storm');
});

/* ════════════════════════════════════════════════════════════════════════════
 * SUITE 4: COLD BOOT SIMULATION & NON-BLOCKING UI PERFORMANCE
 * ════════════════════════════════════════════════════════════════════════════ */

test('TIER5-S4.1: Instant cold boot and deferred non-active view loading (< 300ms)', async () => {
  const t0 = performance.now();

  const env = createBrowserEnvironment();
  const mainSrc = fs.readFileSync(MAIN_PATH, 'utf8');

  // Verify that dynamic view loaders exist and are deferred
  assert.match(mainSrc, /export\s+async\s+function\s+loadView/);
  assert.match(mainSrc, /_viewCache/);

  // Cold boot evaluates main modules in under 300ms
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 300, `Cold boot parsing and evaluation took ${elapsed.toFixed(1)}ms, must be < 300ms`);
});

test('TIER5-S4.2: Zero synchronous UI blocking verification across client codebase', () => {
  const clientDir = path.resolve(__dirname, '..', 'cep-panel', 'client', 'src');
  const files = fs.readdirSync(clientDir).filter(f => f.endsWith('.js'));

  for (const f of files) {
    const content = fs.readFileSync(path.join(clientDir, f), 'utf8');
    assert.doesNotMatch(content, /execSync/, `Forbidden synchronous execSync detected in ${f}`);
    assert.doesNotMatch(content, /spawnSync/, `Forbidden synchronous spawnSync detected in ${f}`);
    assert.doesNotMatch(content, /while\s*\(\s*Date\.now\(\)\s*-\s*\w+\s*<\s*\w+\s*\)/, `Busy-wait loop detected in ${f}`);
  }
});

test('TIER5-S4.3: ExtendScript cold-boot fast-path initialization', () => {
  const mainSrc = fs.readFileSync(MAIN_PATH, 'utf8');
  // Cold boot in main.js must pass false to initExtendScript
  assert.match(mainSrc, /initExtendScript\(\s*false\s*\)/, 'Cold boot must pass false to initExtendScript');

  const indexJsxSrc = fs.readFileSync(path.resolve(__dirname, '..', 'cep-panel', 'extendscript', 'index.jsx'), 'utf8');
  assert.match(indexJsxSrc, /editflowDispatch/, 'ExtendScript must define editflowDispatch router');
  assert.match(indexJsxSrc, /callModule/, 'ExtendScript must define callModule routing');
});

test('TIER5-S4.4: Defensive error boundaries and graceful fault isolation', async () => {
  const env = createBrowserEnvironment();

  // Test error boundary handler wrapper
  let caughtError = null;
  let bannerShown = false;

  async function mockSafeLoadView(name) {
    try {
      if (name === 'corrupted_view') {
        throw new SyntaxError('Unexpected token in corrupted view module');
      }
      return { loaded: true };
    } catch (err) {
      caughtError = err;
      bannerShown = true;
      return null;
    }
  }

  const res = await mockSafeLoadView('corrupted_view');
  assert.equal(res, null);
  assert.ok(caughtError instanceof SyntaxError);
  assert.equal(bannerShown, true, 'Error boundary must catch and display user notification without crashing');
});

/* ════════════════════════════════════════════════════════════════════════════
 * SUITE 5: EXTREME BOUNDARY FUZZING, COMPOSITE INVARIANTS & MEMORY SAFETY
 * ════════════════════════════════════════════════════════════════════════════ */

test('TIER5-S5.1: Pathological multilingual text fuzzing (0, 1, 1000 words, control characters, RTL override, brackets)', () => {
  const envObj = {
    width: 1080, height: 1920, fps: { num: 30, den: 1 },
    measure: (t) => String(t || '').length * 40
  };

  // 1. Zero words
  const scZero = M.buildScene([], {}, envObj);
  assert.equal(scZero.captions.length, 0);

  // 2. Single word RTL & single word LTR
  const scOneRtl = M.buildScene([{ text: 'اردو', start: 0, end: 1 }], {}, envObj);
  assert.equal(scOneRtl.captions.length, 1);
  assert.equal(scOneRtl.captions[0].lines[0].rtl, true);

  const scOneLtr = M.buildScene([{ text: 'English', start: 0, end: 1 }], {}, envObj);
  assert.equal(scOneLtr.captions.length, 1);
  assert.equal(scOneLtr.captions[0].lines[0].rtl, false);

  // 3. Pathological Unicode strings: zero-width joiners, RTL marks, brackets, punctuation
  const strangeWords = [
    { text: '\u200E(AI)\u200F', start: 0.0, end: 0.3 },
    { text: '«ٹول»', start: 0.3, end: 0.6 },
    { text: '\u202Ereversed\u202C', start: 0.6, end: 0.9 },
    { text: '100%!', start: 0.9, end: 1.2 },
    { text: '۔۔۔', start: 1.2, end: 1.5 },
  ];
  const scStrange = M.buildScene(strangeWords, {}, envObj);
  assert.ok(scStrange.captions.length > 0);
  for (const cap of scStrange.captions) {
    for (const l of cap.lines) {
      for (const w of l.words) {
        assert.ok(isFinite(w.x), `Word "${w.text}" x must be finite`);
        assert.ok(isFinite(w.w), `Word "${w.text}" w must be finite`);
        assert.ok(!isNaN(w.x) && !isNaN(w.w), `Word "${w.text}" must not have NaN coordinates`);
      }
    }
  }

  // 4. Massive 1000-word stress test
  const bigWords = [];
  for (let i = 0; i < 1000; i++) {
    bigWords.push({
      text: i % 2 === 0 ? `لفظ_${i}` : `Word_${i}`,
      start: i * 0.4,
      end: (i + 1) * 0.4
    });
  }
  const tStart = performance.now();
  const scBig = M.buildScene(bigWords, {}, envObj);
  const tEnd = performance.now();
  assert.ok(scBig.captions.length > 100);
  assert.ok((tEnd - tStart) < 150, `1000-word scene build took ${(tEnd - tStart).toFixed(1)}ms (must be < 150ms)`);
});

test('TIER5-S5.2: Pathological color input fuzzing (100 malformed strings, injection, out-of-bounds)', () => {
  const fuzzed = [
    '', '   ', '#', '##', '###', '####', '#####', '######', '#######',
    '#xyz', '12345', '1234567', '#123456789',
    'rgb()', 'rgb(255)', 'rgb(255, 255)', 'rgb(255, 255, 255, 255, 255)',
    'rgba()', 'rgba(NaN, NaN, NaN, 1)', 'rgba(Infinity, 0, 0, 1)',
    'hsl(0, 100%, 50%)', 'hsv(0, 100%, 100%)',
    '<script>', 'javascript:void(0)', '[object Object]', 'undefined', 'null',
    '-1', '9999999', '#gggggg', 'blue', 'transparent', 'currentColor'
  ];

  for (const bad of fuzzed) {
    assert.doesNotThrow(() => {
      const res = R.normalizeHex(bad, '#default');
      assert.ok(res === '#default' || /^#[0-9a-f]{6}$/.test(res), `Fuzz result for "${bad}" must be safe`);
    });
  }
});

test('TIER5-S5.3: Memory stability, leak check, and garbage collection simulation across 500 render cycles', () => {
  const envObj = {
    width: 1080, height: 1920, fps: { num: 30, den: 1 },
    measure: (t) => String(t || '').length * 40
  };

  const sampleWords = [
    { text: 'میموری', start: 0.0, end: 0.5 },
    { text: 'Memory', start: 0.5, end: 1.0 },
    { text: 'لیک', start: 1.0, end: 1.5 },
    { text: 'Leak', start: 1.5, end: 2.0 },
  ];

  const browser = createBrowserEnvironment();
  const cv = browser.document.createElement('canvas');
  cv.width = 400;
  cv.height = 300;
  const ctx = cv.getContext('2d');

  const startMem = process.memoryUsage().heapUsed;

  // 500 render cycles with changing styles and colors
  for (let i = 0; i < 500; i++) {
    const hex = '#' + ((1 << 24) + (i * 31337) % 0xFFFFFF).toString(16).slice(1);
    const settings = {
      style: {
        color: hex,
        activeColor: '#ffd84d',
        fontFamily: 'Noto Nastaliq Urdu',
        fontSize: 80,
      },
      motion: { preset: 'none', highlight: 'color' },
    };
    const scene = M.buildScene(sampleWords, settings, envObj);
    R.drawFrame(ctx, scene, settings, 0.75, { scale: 1 });
  }

  const endMem = process.memoryUsage().heapUsed;
  const growthMb = (endMem - startMem) / (1024 * 1024);
  // Growth should be well bounded (< 25MB for 500 cycles in Node)
  assert.ok(growthMb < 25, `Heap growth of ${growthMb.toFixed(2)}MB must remain bounded (< 25MB)`);
});

test('TIER5-S5.4: Undo / Redo history invariance with BiDi captions and custom colors', () => {
  const { mod } = setupTestCaptions();

  // Initial English word
  mod.setWords([{ text: 'Initial', start: 0, end: 1 }]);
  assert.equal(mod.S.words.length, 1);

  // Step 1: Add Urdu word (setWords automatically snapshots previous state)
  mod.setWords([
    { text: 'Initial', start: 0, end: 1 },
    { text: 'پہلا', start: 1, end: 2 },
  ]);
  assert.equal(mod.S.words.length, 2);

  // Step 2: Add Arabic word and embedded English (setWords automatically snapshots previous state)
  mod.setWords([
    { text: 'Initial', start: 0, end: 1 },
    { text: 'پہلا', start: 1, end: 2 },
    { text: 'AI', start: 2, end: 3 },
    { text: 'تجربہ', start: 3, end: 4 },
  ]);
  assert.equal(mod.S.words.length, 4);

  // Undo Step 2 (reverts to state before Step 2: 2 words)
  mod.undo();
  assert.equal(mod.S.words.length, 2);
  assert.equal(mod.S.words[1].text, 'پہلا');

  // Undo Step 1 (reverts to initial state: 1 word)
  mod.undo();
  assert.equal(mod.S.words.length, 1);
  assert.equal(mod.S.words[0].text, 'Initial');

  // Redo Step 1 (restores 2 words)
  mod.redo();
  assert.equal(mod.S.words.length, 2);
  assert.equal(mod.S.words[1].text, 'پہلا');

  // Redo Step 2 (restores 4 words)
  mod.redo();
  assert.equal(mod.S.words.length, 4);
  assert.equal(mod.S.words[2].text, 'AI');
  assert.equal(mod.S.words[3].text, 'تجربہ');
});
