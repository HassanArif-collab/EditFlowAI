/**
 * tests/challenger-m2-color-stress.test.js
 *
 * EMPIRICAL ADVERSARIAL CHALLENGER SUITE — MILESTONE 2
 * Persistent Color Picker, Format Pasting & State Synchronization Stress
 *
 * Verifies:
 * 1. Direct pasting of all color formats:
 *    #3b82f6, 3b82f6, #fff, fff, #3b82f680, rgb(59, 130, 246), rgba(59, 130, 246, 0.5)
 * 2. Blur persistence across element blur, window.blur, pagehide, and click-away
 * 3. Tab switching persistence across Style, Motion, Export, Transcript tabs
 * 4. Quad-lock real-time synchronization: swatch === textInput === S.settings.style === canvas preview
 * 5. Rapid input typing storms (high-frequency keystrokes, rapid pasting bursts, and invalid input resilience)
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

const M = loadEsm(MODEL_PATH);
const R = loadEsm(RENDER_PATH, M);

function matchCompound(el, part) {
  if (!el || typeof el.getAttribute !== 'function' || !part) return false;
  let p = part.trim();

  // 1. Extract and verify attributes first (so dots in attr values like [data-bind="style.color"] aren't confused for classes)
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
        const actualVal = el.getAttribute(attrName);
        if (actualVal !== attrVal) return false;
      }
      p = p.replace(am, '');
    }
  }

  // 2. Tag name
  const tagM = p.match(/^[a-zA-Z0-9]+/);
  if (tagM) {
    if (el.tagName !== tagM[0].toUpperCase()) return false;
    p = p.slice(tagM[0].length);
  }

  // 3. ID
  const idM = p.match(/#([a-zA-Z0-9_-]+)/);
  if (idM) {
    if (el.id !== idM[1]) return false;
    p = p.replace(idM[0], '');
  }

  // 4. Classes
  const classMatches = p.match(/\.([a-zA-Z0-9_-]+)/g);
  if (classMatches) {
    for (const cm of classMatches) {
      if (!el.classList.contains(cm.slice(1))) return false;
      p = p.replace(cm, '');
    }
  }

  return p.trim().length === 0;
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
    for (let i = parts.length - 2; i >= 0; i--) {
      let matched = false;
      while (cur && typeof cur.getAttribute === 'function') {
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

/**
 * Creates an enhanced browser environment with full capture/bubble event propagation
 * and multi-part CSS selector support for window, document, root, and child nodes.
 */
function createEnhancedEnvironment() {
  const env = createBrowserEnvironment();

  // Override matches, querySelectorAll, and closest on DOMElement prototype
  const proto = env.root.constructor.prototype;
  proto.matches = function (selector) {
    return matchesSelector(this, selector);
  };
  proto.querySelectorAll = function (selector) {
    const results = [];
    const check = (node) => {
      if (node !== this && matchesSelector(node, selector)) results.push(node);
      if (node.children) {
        for (const c of node.children) check(c);
      }
    };
    check(this);
    return results;
  };
  proto.querySelector = function (selector) {
    return this.querySelectorAll(selector)[0] || null;
  };
  proto.closest = function (selector) {
    let cur = this;
    while (cur) {
      if (matchesSelector(cur, selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  };

  // Window event listeners
  const winListeners = new Map();
  env.window.addEventListener = (type, fn) => {
    if (!winListeners.has(type)) winListeners.set(type, []);
    winListeners.get(type).push(fn);
  };
  env.window.removeEventListener = (type, fn) => {
    const arr = winListeners.get(type);
    if (arr) {
      const idx = arr.indexOf(fn);
      if (idx !== -1) arr.splice(idx, 1);
    }
  };
  env.window.dispatchEvent = (ev) => {
    ev.target = env.window;
    ev.currentTarget = env.window;
    const fns = winListeners.get(ev.type) || [];
    for (const fn of [...fns]) {
      try { fn.call(env.window, ev); } catch (e) { console.error('Window event error:', e); }
    }
    return !ev.defaultPrevented;
  };

  // Enhance DOMElement.prototype.dispatchEvent for capture & bubbling
  env.root.constructor.prototype.dispatchEvent = function (event) {
    event.target = this;

    // Build ancestor chain: target -> ... -> root -> body -> html
    const chain = [];
    let cur = this;
    while (cur) {
      chain.unshift(cur);
      cur = cur.parentNode;
    }

    // Capture phase
    for (const node of chain) {
      event.currentTarget = node;
      const captureListeners = (node._captureListeners && node._captureListeners.get(event.type)) || [];
      for (const fn of [...captureListeners]) {
        try { fn.call(node, event); } catch (e) { console.error('Capture error:', e); }
        if (event._propagationStopped) return !event.defaultPrevented;
      }
    }

    // Bubble phase (or target only if not bubbling)
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

  // Enhance addEventListener to support useCapture
  const origAddEventListener = env.root.constructor.prototype.addEventListener;
  env.root.constructor.prototype.addEventListener = function (type, fn, useCapture) {
    if (useCapture) {
      if (!this._captureListeners) this._captureListeners = new Map();
      if (!this._captureListeners.has(type)) this._captureListeners.set(type, []);
      this._captureListeners.get(type).push(fn);
      return;
    }
    origAddEventListener.call(this, type, fn);
  };

  return env;
}

/**
 * Initializes the captions-view module with mock dependencies and sandbox.
 */
function setupTestModule() {
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
      openCaptions,
      closeCaptions,
      renderShell,
      renderBody,
      bindEvents,
      ensureContainer,
      onSetting,
      onBoundInput,
      commitHexInput,
      commitPendingHexInputs,
      drawPreview,
      requestDraw,
      normalizeHex,
      setWords,
      rebuildScene,
      findPreset,
      applyPreset,
    };
  `;

  const fn = new Function('deps', 'with(deps) {\n' + src + '\n' + exposedReturn + '\n}');

  const deps = Object.assign({}, {
    R,
    normalizeHex: R.normalizeHex,
    window: env.window,
    document: env.document,
    localStorage: env.localStorage,
    ResizeObserver: env.window.ResizeObserver,
    requestAnimationFrame: (cb) => {
      // Synchronous execution for deterministic test assertions
      cb(Date.now());
      return 1;
    },
    cancelAnimationFrame: () => {},
    apiGet: async () => ({}),
    apiPost: async () => ({}),
    apiUpload: async () => ({}),
    getBaseUrl: () => 'http://127.0.0.1:8765',
    isExtendScriptAvailable: () => false,
    callExtendScript: async () => ({}),
    M,
    drawFrame: R.drawFrame,
    STYLE_DEFAULTS: R.STYLE_DEFAULTS,
    BUNDLED: [],
    ensureFont: async () => true,
    makeMeasurer: () => ({ measure: (t) => (t ? t.length * 30 : 50), fontMetrics: () => ({ ascent: 60, descent: 20 }) }),
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
  });

  const mod = fn(deps);
  mod.ensureContainer();
  mod.S.settings = JSON.parse(JSON.stringify(mod.DEFAULTS));
  mod.S.settings.motion.highlight = 'color'; // ensure activeColor control is rendered in Style tab
  mod.S.tab = 'style';
  mod.S.previewOpen = true;
  mod.S.seq = { name: 'Test Sequence', width: 1080, height: 1920, fps: 30 };
  mod.S.t = 0.25;

  mod.renderShell();
  mod.bindEvents();
  mod.renderBody();

  // Seed sample words and build scene for canvas draw testing
  const sampleWords = [
    { text: 'Empirical', start: 0.0, end: 0.5, speaker: 0 },
    { text: 'Color', start: 0.5, end: 1.0, speaker: 0 },
    { text: 'Sync', start: 1.0, end: 1.5, speaker: 0 },
  ];
  mod.S.words = sampleWords;
  mod.S.scene = M.buildScene(sampleWords, mod.S.settings, {
    width: 1080, height: 1920, fps: 30,
    measure: (t) => (t ? t.length * 30 : 50),
    fontMetrics: () => ({ ascent: 60, descent: 20 }),
  });

  // Configure canvas mock dimensions
  const cv = env.root.querySelector('#cc-canvas');
  if (cv) {
    cv.width = 1080;
    cv.height = 1920;
  }

  return { env, mod, deps };
}

/* ════════════════════════════════════════════════════════════════════════════
 * SUITE 1: DIRECT FORMAT PASTING & NORMALIZATION STRESS
 * ════════════════════════════════════════════════════════════════════════════ */

test('SUITE 1.1: Paste standard 6-digit hex (#3b82f6) normalizes and updates swatch & state', () => {
  const { env, mod } = setupTestModule();
  const txt = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');
  const swatch = env.root.querySelector('input.cc-color-swatch[data-bind="style.color"]');

  assert.ok(txt, 'Text input for style.color must exist');
  assert.ok(swatch, 'Swatch for style.color must exist');

  // Simulate user paste
  txt.value = '#3b82f6';
  txt.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));

  assert.equal(swatch.value, '#3b82f6', 'Swatch value must update to #3b82f6');
  assert.equal(mod.S.settings.style.color, '#3b82f6', 'S.settings.style.color must update to #3b82f6');
});

test('SUITE 1.2: Paste unhashed 6-digit hex (3b82f6) normalizes with prepended hash', () => {
  const { env, mod } = setupTestModule();
  const txt = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');
  const swatch = env.root.querySelector('input.cc-color-swatch[data-bind="style.color"]');

  txt.value = '3b82f6';
  txt.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));

  assert.equal(swatch.value, '#3b82f6', 'Swatch value must update to #3b82f6');
  assert.equal(mod.S.settings.style.color, '#3b82f6', 'S.settings.style.color must commit #3b82f6');

  // On blur, input field itself formats with '#'
  txt.dispatchEvent(new MockDOMEvent('blur', { bubbles: true }));
  assert.equal(txt.value, '#3b82f6', 'Text input must normalize to #3b82f6 on blur');
});

test('SUITE 1.3: Paste 3-digit shorthand (#fff and fff) expands to 6-digit hex (#ffffff)', () => {
  const { env, mod } = setupTestModule();
  const txt = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');
  const swatch = env.root.querySelector('input.cc-color-swatch[data-bind="style.color"]');

  // Test #fff
  txt.value = '#fff';
  txt.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
  assert.equal(swatch.value, '#ffffff');
  assert.equal(mod.S.settings.style.color, '#ffffff');

  // Test unhashed fff on activeColor
  const activeTxt = env.root.querySelector('input.cc-hex-input[data-bind="style.activeColor"]');
  const activeSwatch = env.root.querySelector('input.cc-color-swatch[data-bind="style.activeColor"]');
  assert.ok(activeTxt && activeSwatch);

  activeTxt.value = 'fff';
  activeTxt.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
  assert.equal(activeSwatch.value, '#ffffff');
  assert.equal(mod.S.settings.style.activeColor, '#ffffff');

  activeTxt.dispatchEvent(new MockDOMEvent('blur', { bubbles: true }));
  assert.equal(activeTxt.value, '#ffffff');
});

test('SUITE 1.4: Paste 8-digit hex with alpha (#3b82f680 and 3b82f680) extracts 6-digit color', () => {
  const { env, mod } = setupTestModule();
  const txt = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');
  const swatch = env.root.querySelector('input.cc-color-swatch[data-bind="style.color"]');

  // Hashed 8-digit
  txt.value = '#3b82f680';
  txt.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
  assert.equal(swatch.value, '#3b82f6');
  assert.equal(mod.S.settings.style.color, '#3b82f6');

  // Unhashed 8-digit
  txt.value = '3b82f680';
  txt.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
  assert.equal(swatch.value, '#3b82f6');
  assert.equal(mod.S.settings.style.color, '#3b82f6');

  txt.dispatchEvent(new MockDOMEvent('blur', { bubbles: true }));
  assert.equal(txt.value, '#3b82f6');
});

test('SUITE 1.5: Paste rgb(59, 130, 246) functional notation converts to #3b82f6', () => {
  const { env, mod } = setupTestModule();
  const txt = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');
  const swatch = env.root.querySelector('input.cc-color-swatch[data-bind="style.color"]');

  txt.value = 'rgb(59, 130, 246)';
  txt.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
  assert.equal(swatch.value, '#3b82f6');
  assert.equal(mod.S.settings.style.color, '#3b82f6');

  txt.dispatchEvent(new MockDOMEvent('blur', { bubbles: true }));
  assert.equal(txt.value, '#3b82f6');
});

test('SUITE 1.6: Paste rgba(59, 130, 246, 0.5) converts to #3b82f6 ignoring alpha channel for hex', () => {
  const { env, mod } = setupTestModule();
  const txt = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');
  const swatch = env.root.querySelector('input.cc-color-swatch[data-bind="style.color"]');

  txt.value = 'rgba(59, 130, 246, 0.5)';
  txt.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
  assert.equal(swatch.value, '#3b82f6');
  assert.equal(mod.S.settings.style.color, '#3b82f6');

  txt.dispatchEvent(new MockDOMEvent('blur', { bubbles: true }));
  assert.equal(txt.value, '#3b82f6');
});

test('SUITE 1.7: Case-insensitive paste tolerance (uppercase hex and uppercase RGB/RGBA)', () => {
  const { env, mod } = setupTestModule();
  const txt = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');

  txt.value = '#3B82F6';
  txt.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
  assert.equal(mod.S.settings.style.color, '#3b82f6');

  txt.value = 'RGB(59, 130, 246)';
  txt.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
  assert.equal(mod.S.settings.style.color, '#3b82f6');

  txt.value = 'RGBA(59, 130, 246, 0.8)';
  txt.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
  assert.equal(mod.S.settings.style.color, '#3b82f6');
});

test('SUITE 1.8: Pasting across multiple color controls (stroke, shadow, background, glow)', () => {
  const { env, mod } = setupTestModule();

  const pairs = [
    { bind: 'style.strokeColor', raw: '10b981', expected: '#10b981' },
    { bind: 'style.shadowColor', raw: '#1e293b', expected: '#1e293b' },
    { bind: 'style.bgColor', raw: 'rgb(244, 63, 94)', expected: '#f43f5e' },
    { bind: 'style.emphasisColor', raw: '#f59e0b', expected: '#f59e0b' },
  ];

  for (const { bind, raw, expected } of pairs) {
    const input = env.root.querySelector(`input.cc-hex-input[data-bind="${bind}"]`);
    assert.ok(input, `Input for ${bind} must exist`);
    input.value = raw;
    input.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
    input.dispatchEvent(new MockDOMEvent('blur', { bubbles: true }));

    const swatch = env.root.querySelector(`input.cc-color-swatch[data-bind="${bind}"]`);
    assert.equal(swatch.value, expected, `Swatch for ${bind} must match`);
    assert.equal(input.value, expected, `Input for ${bind} must match`);
  }
});

/* ════════════════════════════════════════════════════════════════════════════
 * SUITE 2: BLUR PERSISTENCE, DISRUPTION & RESILIENCE
 * ════════════════════════════════════════════════════════════════════════════ */

test('SUITE 2.1: Element blur commits uncommitted hex without reverting', () => {
  const { env, mod } = setupTestModule();
  const txt = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');

  // User enters value without firing input event directly
  txt.value = 'e11d48';
  txt.dispatchEvent(new MockDOMEvent('blur', { bubbles: true }));

  assert.equal(mod.S.settings.style.color, '#e11d48');
  assert.equal(txt.value, '#e11d48');
});

test('SUITE 2.2: window.blur (Premiere timeline click) commits all pending inputs', () => {
  const { env, mod } = setupTestModule();
  const txt = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');
  const activeTxt = env.root.querySelector('input.cc-hex-input[data-bind="style.activeColor"]');

  txt.value = '06b6d4'; // cyan-500
  activeTxt.value = 'ec4899'; // pink-500

  // User clicks timeline outside CEP window -> window.blur fires
  env.window.dispatchEvent(new MockDOMEvent('blur'));

  assert.equal(mod.S.settings.style.color, '#06b6d4', 'style.color must commit on window.blur');
  assert.equal(mod.S.settings.style.activeColor, '#ec4899', 'style.activeColor must commit on window.blur');
  assert.equal(txt.value, '#06b6d4');
  assert.equal(activeTxt.value, '#ec4899');
});

test('SUITE 2.3: window.pagehide commits pending inputs before teardown', () => {
  const { env, mod } = setupTestModule();
  const txt = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');

  txt.value = '8b5cf6'; // violet-500
  env.window.dispatchEvent(new MockDOMEvent('pagehide'));

  assert.equal(mod.S.settings.style.color, '#8b5cf6', 'style.color must commit on window.pagehide');
});

test('SUITE 2.4: Click-away to canvas or preset commits text input', () => {
  const { env, mod } = setupTestModule();
  const txt = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');
  const stage = env.root.querySelector('#cc-stage');

  txt.value = 'f97316'; // orange-500

  // Click-away causes txt blur, then stage click
  txt.dispatchEvent(new MockDOMEvent('blur', { bubbles: true }));
  stage.dispatchEvent(new MockDOMEvent('click', { bubbles: true }));

  assert.equal(mod.S.settings.style.color, '#f97316', 'Click away must commit hex value');
});

test('SUITE 2.5: Enter key commits, normalizes, and blurs input', () => {
  const { env, mod } = setupTestModule();
  const txt = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');

  txt.value = '14b8a6'; // teal-500
  const enterEv = new MockDOMEvent('keydown', { bubbles: true });
  enterEv.key = 'Enter';
  txt.dispatchEvent(enterEv);

  assert.equal(mod.S.settings.style.color, '#14b8a6');
  assert.equal(txt.value, '#14b8a6');
});

test('SUITE 2.6: Escape key reverts uncommitted edits to last saved state', () => {
  const { env, mod } = setupTestModule();
  const txt = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');

  // Established committed state
  txt.value = '#3b82f6';
  txt.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
  txt.dispatchEvent(new MockDOMEvent('blur', { bubbles: true }));
  assert.equal(mod.S.settings.style.color, '#3b82f6');

  // User types garbage and presses Escape
  txt.value = 'invalid-garbage';
  const escEv = new MockDOMEvent('keydown', { bubbles: true });
  escEv.key = 'Escape';
  txt.dispatchEvent(escEv);

  assert.equal(txt.value, '#3b82f6', 'Escape must revert text input to last valid setting');
  assert.equal(mod.S.settings.style.color, '#3b82f6', 'Setting must remain unchanged');
});

test('SUITE 2.7: Invalid input on blur safely reverts to last valid state without corruption', () => {
  const { env, mod } = setupTestModule();
  const txt = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');

  // Set known valid state
  txt.value = '#22c55e';
  txt.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
  txt.dispatchEvent(new MockDOMEvent('blur', { bubbles: true }));
  assert.equal(mod.S.settings.style.color, '#22c55e');

  // Enter invalid inputs and blur
  const invalids = ['not-a-color', '#12', '12345', 'gggggg', ''];
  for (const inv of invalids) {
    txt.value = inv;
    txt.dispatchEvent(new MockDOMEvent('blur', { bubbles: true }));
    assert.equal(txt.value, '#22c55e', `Invalid input "${inv}" on blur must revert to last valid hex`);
    assert.equal(mod.S.settings.style.color, '#22c55e');
  }
});

/* ════════════════════════════════════════════════════════════════════════════
 * SUITE 3: TAB SWITCHING PERSISTENCE MATRIX ACROSS ALL TABS
 * ════════════════════════════════════════════════════════════════════════════ */

test('SUITE 3.1: Sequential tab traversal (Style -> Motion -> Export -> Transcript -> Style) retains committed HEX', () => {
  const { env, mod } = setupTestModule();
  const txt = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');

  // Commit #a855f7 (purple-500)
  txt.value = 'a855f7';
  txt.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
  txt.dispatchEvent(new MockDOMEvent('blur', { bubbles: true }));
  assert.equal(mod.S.settings.style.color, '#a855f7');

  const tabs = ['motion', 'export', 'transcript', 'style'];
  for (const t of tabs) {
    const tabBtn = env.root.querySelector(`.cc-tab[data-tab="${t}"]`);
    assert.ok(tabBtn, `Tab button for ${t} must exist`);
    tabBtn.dispatchEvent(new MockDOMEvent('click', { bubbles: true }));
    assert.equal(mod.S.tab, t);
    assert.equal(mod.S.settings.style.color, '#a855f7', `Color must not drop when navigating to tab ${t}`);
  }

  // Back on Style tab, verify DOM inputs are reconstructed with exact color
  const restoredTxt = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');
  const restoredSwatch = env.root.querySelector('input.cc-color-swatch[data-bind="style.color"]');
  assert.equal(restoredTxt.value, '#a855f7');
  assert.equal(restoredSwatch.value, '#a855f7');
});

test('SUITE 3.2: In-flight unblurred edit is committed automatically when clicking a tab', () => {
  const { env, mod } = setupTestModule();
  const txt = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');

  // User types hex and immediately clicks 'motion' tab without blurring
  txt.value = 'd946ef'; // fuchsia-500
  const motionTab = env.root.querySelector('.cc-tab[data-tab="motion"]');
  motionTab.dispatchEvent(new MockDOMEvent('click', { bubbles: true }));

  assert.equal(mod.S.tab, 'motion');
  assert.equal(mod.S.settings.style.color, '#d946ef', 'In-flight edit must commit before tab switch');

  // Switch back to style tab
  const styleTab = env.root.querySelector('.cc-tab[data-tab="style"]');
  styleTab.dispatchEvent(new MockDOMEvent('click', { bubbles: true }));

  const restoredTxt = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');
  assert.equal(restoredTxt.value, '#d946ef');
});

test('SUITE 3.3: Cross-tab color editing synchronization between Style and Motion tabs', () => {
  const { env, mod } = setupTestModule();

  // 1. Edit style.color in Style tab
  const txtColor = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');
  txtColor.value = '#ef4444'; // red-500
  txtColor.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
  txtColor.dispatchEvent(new MockDOMEvent('blur', { bubbles: true }));

  // 2. Switch to Motion tab
  env.root.querySelector('.cc-tab[data-tab="motion"]').dispatchEvent(new MockDOMEvent('click', { bubbles: true }));
  assert.equal(mod.S.tab, 'motion');

  // 3. Edit style.hlBoxColor in Motion tab
  const txtHlBox = env.root.querySelector('input.cc-hex-input[data-bind="style.hlBoxColor"]');
  assert.ok(txtHlBox, 'style.hlBoxColor must be present in Motion tab');
  txtHlBox.value = '3b82f6';
  txtHlBox.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
  txtHlBox.dispatchEvent(new MockDOMEvent('blur', { bubbles: true }));
  assert.equal(mod.S.settings.style.hlBoxColor, '#3b82f6');

  // 4. Switch to Export tab and verify both are retained
  env.root.querySelector('.cc-tab[data-tab="export"]').dispatchEvent(new MockDOMEvent('click', { bubbles: true }));
  assert.equal(mod.S.settings.style.color, '#ef4444');
  assert.equal(mod.S.settings.style.hlBoxColor, '#3b82f6');

  // 5. Return to Style tab
  env.root.querySelector('.cc-tab[data-tab="style"]').dispatchEvent(new MockDOMEvent('click', { bubbles: true }));
  assert.equal(env.root.querySelector('input.cc-hex-input[data-bind="style.color"]').value, '#ef4444');
});

test('SUITE 3.4: Color persistence survives localStorage serialization and reload', () => {
  const { env, mod } = setupTestModule();
  const txt = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');

  txt.value = '6366f1'; // indigo-500
  txt.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
  txt.dispatchEvent(new MockDOMEvent('blur', { bubbles: true }));

  // Simulate localStorage save and read
  env.localStorage.setItem('editflow.captions.settings.v3', JSON.stringify(mod.S.settings));
  const retrieved = JSON.parse(env.localStorage.getItem('editflow.captions.settings.v3'));

  assert.equal(retrieved.style.color, '#6366f1');
});

/* ════════════════════════════════════════════════════════════════════════════
 * SUITE 4: 4-WAY REAL-TIME SYNCHRONIZATION (QUAD-LOCK)
 * Swatch === TextInput === S.settings.style === Canvas Preview Color
 * ════════════════════════════════════════════════════════════════════════════ */

test('SUITE 4.1: Text input edit synchronizes swatch, settings, and canvas preview fillStyle', () => {
  const { env, mod } = setupTestModule();
  mod.S.settings.motion.highlight = 'none'; // isolate base text color
  mod.S.t = 0.25;

  const txt = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');
  const swatch = env.root.querySelector('input.cc-color-swatch[data-bind="style.color"]');
  const cv = env.root.querySelector('#cc-canvas');
  const ctx = cv.getContext('2d');

  // Set color via text input
  txt.value = '3b82f6';
  txt.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
  txt.dispatchEvent(new MockDOMEvent('blur', { bubbles: true }));

  // Trigger preview draw
  mod.drawPreview();

  // Find fillText draw call for caption
  const textWordCall = ctx._drawCalls.find((c) => c.type === 'fillText' && c.text === 'Empirical');
  assert.ok(textWordCall, 'Canvas must have executed fillText calls for captions');

  const renderedColor = textWordCall.fillStyle;

  // Assert Quad-Lock
  assert.equal(swatch.value, '#3b82f6', '1. Swatch must equal #3b82f6');
  assert.equal(txt.value, '#3b82f6', '2. Text input must equal #3b82f6');
  assert.equal(mod.S.settings.style.color, '#3b82f6', '3. S.settings.style.color must equal #3b82f6');
  assert.equal(renderedColor, '#3b82f6', '4. Canvas fillText fillStyle must equal #3b82f6');
});

test('SUITE 4.2: Swatch edit synchronizes text input, settings, and canvas preview fillStyle', () => {
  const { env, mod } = setupTestModule();
  mod.S.settings.motion.highlight = 'none'; // isolate base text color
  mod.S.t = 0.25;

  const txt = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');
  const swatch = env.root.querySelector('input.cc-color-swatch[data-bind="style.color"]');
  const cv = env.root.querySelector('#cc-canvas');
  const ctx = cv.getContext('2d');

  // Set color via swatch
  swatch.value = '#eab308'; // yellow-500
  swatch.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));

  mod.drawPreview();

  const textWordCall = ctx._drawCalls.find((c) => c.type === 'fillText' && c.text === 'Empirical');
  assert.ok(textWordCall, 'Canvas must execute fillText for caption words');
  const renderedColor = textWordCall.fillStyle;

  // Assert Quad-Lock
  assert.equal(swatch.value, '#eab308');
  assert.equal(txt.value, '#eab308');
  assert.equal(mod.S.settings.style.color, '#eab308');
  assert.equal(renderedColor, '#eab308');
});

test('SUITE 4.3: Outline strokeColor synchronizes swatch, text input, settings, and canvas strokeStyle', () => {
  const { env, mod } = setupTestModule();
  mod.S.settings.style.strokeWidth = 4; // enable outline

  const txt = env.root.querySelector('input.cc-hex-input[data-bind="style.strokeColor"]');
  const swatch = env.root.querySelector('input.cc-color-swatch[data-bind="style.strokeColor"]');
  const cv = env.root.querySelector('#cc-canvas');
  const ctx = cv.getContext('2d');

  txt.value = 'dc2626'; // red-600
  txt.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
  txt.dispatchEvent(new MockDOMEvent('blur', { bubbles: true }));

  mod.drawPreview();

  assert.equal(swatch.value, '#dc2626');
  assert.equal(txt.value, '#dc2626');
  assert.equal(mod.S.settings.style.strokeColor, '#dc2626');

  const strokeCalls = ctx._drawCalls.filter((c) => c.type === 'strokeText');
  assert.ok(strokeCalls.length > 0, 'Canvas must execute strokeText calls for outlined captions');
  assert.equal(strokeCalls[0].strokeStyle, '#dc2626');
});

test('SUITE 4.4: Active word glow color synchronizes with canvas shadowColor', () => {
  const { env, mod } = setupTestModule();
  mod.S.settings.style.activeGlow = true;
  mod.S.t = 0.2; // time corresponding to first word active

  const txt = env.root.querySelector('input.cc-hex-input[data-bind="style.activeGlowColor"]');
  const swatch = env.root.querySelector('input.cc-color-swatch[data-bind="style.activeGlowColor"]');
  const cv = env.root.querySelector('#cc-canvas');
  const ctx = cv.getContext('2d');

  txt.value = '#00f0ff';
  txt.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
  txt.dispatchEvent(new MockDOMEvent('blur', { bubbles: true }));

  mod.drawPreview();

  assert.equal(swatch.value, '#00f0ff');
  assert.equal(txt.value, '#00f0ff');
  assert.equal(mod.S.settings.style.activeGlowColor, '#00f0ff');

  // Verify glow shadowColor captured
  const glowCalls = ctx._drawCalls.filter((c) => c.type === 'fillText' && c.shadowColor === '#00f0ff');
  assert.ok(glowCalls.length > 0, 'Active glow must paint text with shadowColor #00f0ff');
});

/* ════════════════════════════════════════════════════════════════════════════
 * SUITE 5: RAPID INPUT TYPING STORMS & ADVERSARIAL STRESS
 * ════════════════════════════════════════════════════════════════════════════ */

test('SUITE 5.1: Character-by-character typing simulation (# -> 3 -> b -> 8 -> 2 -> f -> 6)', () => {
  const { env, mod } = setupTestModule();
  const txt = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');
  const swatch = env.root.querySelector('input.cc-color-swatch[data-bind="style.color"]');

  // Initial color is #ffffff
  assert.equal(mod.S.settings.style.color, '#ffffff');

  // Keystrokes sequence
  const keystrokes = [
    { text: '#', valid: false },
    { text: '#3', valid: false },
    { text: '#3b', valid: false },
    { text: '#3b8', valid: true, expected: '#33bb88' }, // 3-digit shorthand
    { text: '#3b82', valid: true, expected: '#33bb88' }, // 4-digit alpha hex
    { text: '#3b82f', valid: false }, // 5-digit incomplete
    { text: '#3b82f6', valid: true, expected: '#3b82f6' }, // complete 6-digit hex
  ];

  let lastCommitted = '#ffffff';
  for (const step of keystrokes) {
    txt.value = step.text;
    txt.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));

    if (step.valid) {
      assert.equal(mod.S.settings.style.color, step.expected);
      assert.equal(swatch.value, step.expected);
      lastCommitted = step.expected;
    } else {
      // Incomplete keystroke must not corrupt setting
      assert.equal(mod.S.settings.style.color, lastCommitted, `Keystroke "${step.text}" must preserve last committed color`);
    }
  }

  // Final blur normalizes input field
  txt.dispatchEvent(new MockDOMEvent('blur', { bubbles: true }));
  assert.equal(txt.value, '#3b82f6');
  assert.equal(swatch.value, '#3b82f6');
  assert.equal(mod.S.settings.style.color, '#3b82f6');
});

test('SUITE 5.2: High-frequency paste storm (500 rapid valid paste events)', () => {
  const { env, mod } = setupTestModule();
  const txt = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');
  const swatch = env.root.querySelector('input.cc-color-swatch[data-bind="style.color"]');

  const palette = [
    '#3b82f6', '3b82f6', '#fff', 'fff', '#3b82f680',
    'rgb(59, 130, 246)', 'rgba(59, 130, 246, 0.5)',
    '#10b981', 'f43f5e', '#8b5cf6', 'rgb(234, 179, 8)'
  ];

  const startTime = Date.now();
  let expectedFinalHex = '';

  for (let i = 0; i < 500; i++) {
    const raw = palette[i % palette.length];
    txt.value = raw;
    txt.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
    expectedFinalHex = R.normalizeHex(raw, '#ffffff');
  }

  const elapsed = Date.now() - startTime;
  txt.dispatchEvent(new MockDOMEvent('blur', { bubbles: true }));

  assert.ok(elapsed < 2000, `500 paste events must complete rapidly (took ${elapsed}ms)`);
  assert.equal(mod.S.settings.style.color, expectedFinalHex, 'Final state must match last paste event');
  assert.equal(swatch.value, expectedFinalHex, 'Swatch must match last paste event');
  assert.equal(txt.value, expectedFinalHex, 'Text input must match last paste event');
});

test('SUITE 5.3: Adversarial interleaving of valid pastes and corrupt strings', () => {
  const { env, mod } = setupTestModule();
  const txt = env.root.querySelector('input.cc-hex-input[data-bind="style.color"]');
  const swatch = env.root.querySelector('input.cc-color-swatch[data-bind="style.color"]');

  const sequence = [
    { input: '#3b82f6', expect: '#3b82f6' },
    { input: 'malformed_hex', expect: '#3b82f6' }, // rejected
    { input: 'rgb(16, 185, 129)', expect: '#10b981' },
    { input: '#1234567890', expect: '#10b981' }, // rejected
    { input: 'fff', expect: '#ffffff' },
    { input: '', expect: '#ffffff' }, // rejected
    { input: 'rgba(239, 68, 68, 0.9)', expect: '#ef4444' },
  ];

  for (const item of sequence) {
    txt.value = item.input;
    txt.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
    assert.equal(mod.S.settings.style.color, item.expect, `Input "${item.input}" must result in ${item.expect}`);
  }

  txt.dispatchEvent(new MockDOMEvent('blur', { bubbles: true }));
  assert.equal(txt.value, '#ef4444');
  assert.equal(swatch.value, '#ef4444');
});
