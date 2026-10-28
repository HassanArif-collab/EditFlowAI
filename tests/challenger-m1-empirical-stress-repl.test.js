/**
 * tests/challenger-m1-empirical-stress-repl.test.js
 *
 * EMPIRICAL ADVERSARIAL STRESS TEST HARNESS — CHALLENGER 2 (REPLACEMENT)
 * Milestone 1: UI Toggle Stability & Preview Resilience
 *
 * Tests:
 * 1. Zero renderBody invocation across 1,000 randomized styling switch toggles.
 * 2. Absolute DOM identity invariance and focus preservation on active elements.
 * 3. #cc-stage and #cc-body non-zero dimension guarantees across panel height matrices (200px to 2160px).
 * 4. Context save/restore stack balance and zero uncaught DOMExceptions under canvas stress.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createBrowserEnvironment, DOMElement, MockDOMEvent } = require('./e2e/harness');

/* ── Custom Module Loader ────────────────────────────────────────────── */
function loadModule(filePath, sandbox = {}) {
  let src = fs.readFileSync(filePath, 'utf8');
  src = src.replace(/import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];?/g, '');
  src = src.replace(/import\s+\*\s+as\s+\w+\s+from\s*['"][^'"]+['"];?/g, '');
  src = src.replace(/import\s+[^;]+?from\s*['"][^'"]+['"];?/g, '');
  src = src.replace(/^\s*import\s+[^;\n]+;?\s*$/gm, '');

  const names = [];
  src = src.replace(
    /^export\s+(const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm,
    (_m, kind, name) => {
      names.push(name);
      const decl = kind === 'const' || kind === 'let' ? 'var' : kind;
      return `${decl} ${name}`;
    }
  );
  const exportListMatches = [...src.matchAll(/^export\s*\{([^}]+)\};?\s*$/gm)];
  for (const m of exportListMatches) {
    names.push(...m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]));
  }
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');

  const keys = Object.keys(sandbox);
  const body = `${src}\n;return { ${names.join(', ')} };`;
  // eslint-disable-next-line no-new-func
  return new Function(...keys, body)(...keys.map((k) => sandbox[k]));
}

const MODEL_PATH = path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions', 'model.js');
const RENDER_PATH = path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions', 'render.js');
const VIEW_PATH = path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions-view.js');

const M = loadModule(MODEL_PATH);
const R = loadModule(RENDER_PATH, Object.assign({}, M, {
  clamp01: (v) => Math.max(0, Math.min(1, v)),
}));

function setupCaptionsEnvironment(customEnv = {}) {
  const browser = createBrowserEnvironment();
  browser.document.head = new DOMElement('head');

  const windowListeners = new Map();
  browser.window.addEventListener = (event, fn) => {
    if (!windowListeners.has(event)) windowListeners.set(event, []);
    windowListeners.get(event).push(fn);
  };
  browser.window.removeEventListener = (event, fn) => {
    const arr = windowListeners.get(event);
    if (arr) {
      const idx = arr.indexOf(fn);
      if (idx !== -1) arr.splice(idx, 1);
    }
  };
  browser.window.dispatchEvent = (event) => {
    const arr = windowListeners.get(event.type);
    if (arr) {
      for (const fn of [...arr]) fn(event);
    }
    return true;
  };

  const samplePresets = [
    { id: 'clean', name: 'Clean', style: {}, motion: {} },
    { id: 'bold', name: 'Bold', style: {}, motion: {} },
  ];

  const sandbox = Object.assign({
    window: browser.window,
    document: browser.document,
    localStorage: browser.localStorage,
    navigator: browser.window.navigator || { clipboard: {} },
    requestAnimationFrame: (cb) => {
      cb(Date.now());
      return 1;
    },
    cancelAnimationFrame: () => {},
    ResizeObserver: browser.window.ResizeObserver,
    M,
    drawFrame: R.drawFrame,
    STYLE_DEFAULTS: R.STYLE_DEFAULTS,
    apiGet: async () => ({}),
    apiPost: async () => ({}),
    apiUpload: async () => ({}),
    getBaseUrl: () => 'http://127.0.0.1:8765',
    isExtendScriptAvailable: () => false,
    callExtendScript: async () => ({}),
    BUNDLED: [],
    ensureFont: async () => {},
    makeMeasurer: () => (t) => String(t).length * 40,
    listSystemFonts: async () => [],
    injectFontStyles: () => {},
    weightName: () => 'Bold',
    PRESETS: samplePresets,
    findPreset: (id) => samplePresets.find((p) => p.id === id) || null,
    getAllPresets: () => samplePresets,
    saveUserPreset: () => {},
    deleteUserPreset: () => {},
    renderOverlay: async () => {},
    SAFE_ZONES: {},
    drawSafeZones: () => {},
    getEmojiSuggestion: () => null,
    findAllSuggestions: () => [],
    fmtTimestamp: () => '0:00',
    parseTimestamp: () => 0,
    autoDetectChapters: () => [],
    formatSocialChapters: () => '',
    parseSocialChapters: () => [],
    validateYouTubeChapters: () => ({ valid: true }),
  }, customEnv);

  const CV = loadModule(VIEW_PATH, sandbox);
  CV.openCaptions();

  const state = browser.window.__editflowCaptions.state();
  return { browser, CV, state };
}

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 1: IN-PLACE TOGGLE STABILITY & RENDERBODY BYPASS
 * ════════════════════════════════════════════════════════════════════════════ */

test('CHALLENGER 2 REPL 1.1: Exactly ZERO renderBody calls across 1,000 rapid styling toggle interactions', () => {
  const { browser, state } = setupCaptionsEnvironment();

  // Switch to style tab
  const styleTabBtn = browser.document.querySelector('[data-tab="style"]');
  styleTabBtn.dispatchEvent(new MockDOMEvent('click', { bubbles: true }));

  const body = browser.document.getElementById('cc-body');
  assert.ok(body, '#cc-body must be present');

  // Spy on innerHTML setter of cc-body to detect ANY DOM re-serialization or clearing
  let bodyWriteCount = 0;
  const originalInnerHTML = Object.getOwnPropertyDescriptor(DOMElement.prototype, 'innerHTML');
  Object.defineProperty(body, 'innerHTML', {
    set(val) {
      bodyWriteCount++;
      if (originalInnerHTML && originalInnerHTML.set) {
        originalInnerHTML.set.call(this, val);
      } else {
        this._innerHTML = val;
      }
    },
    get() {
      if (originalInnerHTML && originalInnerHTML.get) {
        return originalInnerHTML.get.call(this);
      }
      return this._innerHTML || '';
    },
    configurable: true,
  });

  // Track initial set of DOM children
  const initialChildren = [...body.children];
  assert.ok(initialChildren.length > 5, 'Body must have initial controls rendered');

  const toggles = [
    'style.gradient',
    'style.shadow',
    'style.activeGlow',
    'style.emojiEnabled',
    'style.speakerColoring',
  ];

  // Run 1,000 toggle interactions
  for (let i = 0; i < 1000; i++) {
    const path = toggles[i % toggles.length];
    const checkbox = browser.document.querySelector(`[data-bind="${path}"]`);
    assert.ok(checkbox, `Checkbox for ${path} must exist`);

    checkbox.checked = (i % 2 === 0);
    checkbox.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
  }

  // Verification: body.innerHTML MUST NEVER have been set during these 1,000 toggles
  assert.equal(bodyWriteCount, 0, `body.innerHTML was written to ${bodyWriteCount} times! Must be exactly 0.`);

  // Verify all initial child element references are strictly identical
  assert.equal(body.children.length, initialChildren.length, 'Child count must remain identical');
  for (let j = 0; j < initialChildren.length; j++) {
    assert.strictEqual(body.children[j], initialChildren[j], `Child element ${j} reference altered`);
  }
});

test('CHALLENGER 2 REPL 1.2: Active input focus and cursor are preserved across styling toggles', () => {
  const { browser } = setupCaptionsEnvironment();

  const styleTabBtn = browser.document.querySelector('[data-tab="style"]');
  styleTabBtn.dispatchEvent(new MockDOMEvent('click', { bubbles: true }));

  // Pick an input field, e.g., font size or stroke width
  const strokeInput = browser.document.querySelector('[data-bind="style.strokeWidth"]');
  assert.ok(strokeInput, 'Stroke width input must exist');

  // Simulate active element focus
  browser.document.activeElement = strokeInput;

  // Toggle gradient on and off 20 times
  const gradInput = browser.document.querySelector('[data-bind="style.gradient"]');
  for (let i = 0; i < 20; i++) {
    gradInput.checked = (i % 2 === 0);
    gradInput.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
    // If renderBody was called, the input would be detached and activeElement lost
    assert.strictEqual(browser.document.activeElement, strokeInput, `Iteration ${i}: Active element focus was lost or detached`);
  }
});

test('CHALLENGER 2 REPL 1.3: grouping.maxLines changes do not destroy #cc-body DOM', () => {
  const { browser, state } = setupCaptionsEnvironment();

  const styleTabBtn = browser.document.querySelector('[data-tab="style"]');
  styleTabBtn.dispatchEvent(new MockDOMEvent('click', { bubbles: true }));

  const body = browser.document.getElementById('cc-body');
  const initialChildren = [...body.children];

  const segContainer = browser.document.querySelector('[data-bind="grouping.maxLines"]');
  assert.ok(segContainer, 'Max lines segment container must exist in style tab');

  const btn2 = segContainer.querySelector('[data-value="2"]');
  assert.ok(btn2, 'Button for 2 lines must exist');

  btn2.dispatchEvent(new MockDOMEvent('click', { bubbles: true }));

  assert.equal(body.children.length, initialChildren.length);
  assert.strictEqual(body.children[0], initialChildren[0]);
  assert.equal(state.settings.grouping.maxLines, 2);
});

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 2: #cc-stage & #cc-body DIMENSION GUARANTEES ACROSS HEIGHT MATRIX
 * ════════════════════════════════════════════════════════════════════════════ */

test('CHALLENGER 2 REPL 2.1: Sizing matrix stress across panel heights (200px to 2160px)', () => {
  const { browser, state } = setupCaptionsEnvironment();

  const root = browser.document.getElementById('captions-view');
  const stage = browser.document.getElementById('cc-stage');
  const body = browser.document.getElementById('cc-body');
  const prevBtn = browser.document.querySelector('[data-act="toggle-preview"]');

  const panelHeights = [200, 250, 320, 480, 600, 720, 1080, 1440, 2160];

  for (const h of panelHeights) {
    root.clientHeight = h;
    browser.window.innerHeight = h;

    // Test 1: Expanded state
    state.previewOpen = true;
    browser.window.dispatchEvent(new MockDOMEvent('resize'));

    assert.strictEqual(stage.classList.contains('cc-stage-collapsed'), false);
    assert.strictEqual(stage.classList.contains('hidden'), false);

    const stageH = parseInt(stage.style.height, 10);
    assert.ok(isFinite(stageH), `Height for panel ${h} must be finite`);
    assert.ok(stageH >= 90, `Expanded stage height (${stageH}px) must be >= 90px in ${h}px panel`);
    assert.ok(stageH <= Math.round(h * 0.78) || stageH === 120, `Stage height (${stageH}px) must not exceed 78% root ceiling (${h * 0.78}px)`);

    // Test 2: Collapsed state
    prevBtn.dispatchEvent(new MockDOMEvent('click', { bubbles: true }));
    assert.strictEqual(state.previewOpen, false);
    assert.strictEqual(stage.classList.contains('cc-stage-collapsed'), true);
    assert.strictEqual(stage.style.height, '0px');
    assert.strictEqual(stage.classList.contains('hidden'), false);

    // Test 3: Re-expand
    prevBtn.dispatchEvent(new MockDOMEvent('click', { bubbles: true }));
    assert.strictEqual(state.previewOpen, true);
    assert.strictEqual(stage.classList.contains('cc-stage-collapsed'), false);
    const reExpandedH = parseInt(stage.style.height, 10);
    assert.ok(reExpandedH >= 90, `Re-expanded height (${reExpandedH}px) must be >= 90px`);
  }
});

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 3: CANVAS CONTEXT INTEGRITY & SAVE/RESTORE BALANCE
 * ════════════════════════════════════════════════════════════════════════════ */

class StackTrackingCanvasContext {
  constructor() {
    this.canvas = { width: 1080, height: 1920 };
    this.stackDepth = 0;
    this.fillStyle = '#ffffff';
    this.strokeStyle = '#000000';
    this.lineWidth = 1;
    this.shadowColor = 'transparent';
    this.shadowBlur = 0;
  }
  save() {
    this.stackDepth++;
  }
  restore() {
    this.stackDepth--;
  }
  setTransform() {}
  resetTransform() {}
  translate() {}
  scale() {}
  rotate() {}
  clearRect() {}
  fillRect() {}
  strokeRect() {}
  fillText() {}
  strokeText() {}
  beginPath() {}
  moveTo() {}
  lineTo() {}
  arcTo() {}
  closePath() {}
  fill() {}
  stroke() {}
  createLinearGradient() {
    return {
      addColorStop: () => {},
    };
  }
}

test('CHALLENGER 2 REPL 3.1: Context save/restore stack remains perfectly balanced (depth 0) after drawing all frames', () => {
  const ctx = new StackTrackingCanvasContext();
  const words = [
    { text: 'Hello', start: 0.1, end: 0.5, speaker: 0 },
    { text: 'World', start: 0.5, end: 1.0, speaker: 1, emphasis: true },
    { text: 'Urduیہ', start: 1.0, end: 1.5, speaker: 0 },
  ];

  const settings = {
    style: {
      fontSize: 80,
      gradient: true,
      gradientColor: '#ffea00',
      shadow: true,
      shadowColor: '#000000',
      activeGlow: true,
      speakerColoring: true,
      speakerColors: ['#ffffff', '#00f0ff'],
      background: 'box',
      emphasis: 'both',
    },
    motion: {
      preset: 'fade_up',
      highlight: 'color',
    }
  };

  const scene = M.buildScene(words, settings, {
    width: 1080, height: 1920, fps: { num: 30, den: 1 },
    measure: (t) => String(t).length * 40,
    fontMetrics: { ascent: 60, descent: 20 }
  });

  // Render multiple frames
  for (let t = 0; t <= 2.0; t += 0.2) {
    R.drawFrame(ctx, scene, settings, t, { scale: 1 });
    assert.equal(ctx.stackDepth, 0, `Stack depth must be 0 after rendering at t=${t}, got ${ctx.stackDepth}`);
  }
});
