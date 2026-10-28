/**
 * tests/challenger-m1-empirical-stress.test.js
 *
 * EMPIRICAL ADVERSARIAL STRESS TEST HARNESS — MILESTONE 1
 * EditFlow AI: UI Toggle Stability & Preview Resilience
 *
 * Verifies:
 * 1. Rapid simulation of styling switch toggles (gradient, shadow, glow, auto-emojis, speaker coloring).
 * 2. Rapid simulation of preview collapse/expand cycles asserting #cc-stage and #cc-body DOM presence and non-zero dimensions.
 * 3. Stress canvas gradient, shadow, glow, and background rendering with degenerate inputs (0 width, 0 height, NaN, invalid color strings) to ensure zero uncaught DOMExceptions.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createBrowserEnvironment, DOMElement, MockDOMEvent } = require('./e2e/harness');

/* ── Custom ESM Module Loader for Browser Code in Node ───────────────── */
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

/* ── Module Paths ────────────────────────────────────────────────────── */
const MODEL_PATH = path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions', 'model.js');
const RENDER_PATH = path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions', 'render.js');
const VIEW_PATH = path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions-view.js');

const M = loadModule(MODEL_PATH);
const R = loadModule(RENDER_PATH, Object.assign({}, M, {
  clamp01: (v) => Math.max(0, Math.min(1, v)),
}));

/* Helper: deterministic canvas text measurer */
const FONT_SIZE = 80;
const measure = (t) => String(t || '').length * FONT_SIZE * 0.55;
const env = (extra) => Object.assign({
  width: 1080, height: 1920, fps: { num: 30, den: 1 },
  measure, fontMetrics: { ascent: FONT_SIZE * 0.78, descent: FONT_SIZE * 0.22 }
}, extra || {});

/* Helper: create an isolated captions-view testing environment */
function setupCaptionsEnvironment() {
  const browser = createBrowserEnvironment();
  browser.document.head = new DOMElement('head');

  // Proper EventTarget support on browser.window
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

  const sandbox = {
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
  };

  const CV = loadModule(VIEW_PATH, sandbox);
  CV.openCaptions();

  const state = browser.window.__editflowCaptions.state();
  return { browser, CV, state };
}

/* ── Strict Adversarial Canvas Mock (Simulates Standard Canvas DOMExceptions) ── */
class StrictAdversarialCanvasContext {
  constructor(w = 1080, h = 1920) {
    this.canvas = { width: w, height: h };
    this.fillStyle = '#ffffff';
    this.strokeStyle = '#000000';
    this.lineWidth = 1;
    this.shadowColor = 'transparent';
    this.shadowBlur = 0;
    this.shadowOffsetX = 0;
    this.shadowOffsetY = 0;
    this.font = '80px Montserrat';
    this.textAlign = 'start';
    this.textBaseline = 'alphabetic';
    this._stack = [];
    this.drawCalls = [];
  }

  save() {
    this._stack.push({
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      shadowColor: this.shadowColor,
      shadowBlur: this.shadowBlur,
      shadowOffsetX: this.shadowOffsetX,
      shadowOffsetY: this.shadowOffsetY,
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
    });
  }

  restore() {
    const s = this._stack.pop();
    if (s) Object.assign(this, s);
  }

  setTransform() {}
  resetTransform() {}
  translate() {}
  scale() {}
  rotate() {}
  clearRect(x, y, w, h) { this.drawCalls.push({ type: 'clearRect', x, y, w, h }); }
  fillRect(x, y, w, h) { this.drawCalls.push({ type: 'fillRect', x, y, w, h }); }
  strokeRect(x, y, w, h) { this.drawCalls.push({ type: 'strokeRect', x, y, w, h }); }
  fillText(text, x, y) { this.drawCalls.push({ type: 'fillText', text, x, y }); }
  strokeText(text, x, y) { this.drawCalls.push({ type: 'strokeText', text, x, y }); }
  beginPath() {}
  moveTo() {}
  lineTo() {}
  arcTo() {}
  closePath() {}
  fill() { this.drawCalls.push({ type: 'fill' }); }
  stroke() { this.drawCalls.push({ type: 'stroke' }); }

  /**
   * HTML5 Canvas Spec Compliance:
   * addColorStop MUST throw SyntaxError DOMException if color is unparseable CSS color.
   * addColorStop MUST throw IndexSizeError DOMException if offset < 0 || offset > 1 || !isFinite(offset).
   */
  createLinearGradient(x0, y0, x1, y1) {
    return {
      x0, y0, x1, y1,
      stops: [],
      addColorStop: (offset, color) => {
        const off = Number(offset);
        if (!isFinite(off) || off < 0 || off > 1) {
          throw new Error('DOMException: IndexSizeError - offset out of range [0, 1]');
        }
        if (typeof color !== 'string') {
          throw new Error('DOMException: SyntaxError - color is not a string');
        }
        const s = color.trim();
        // Check for recognized CSS color syntax
        const validHex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s);
        const validRgb = /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+(\s*,\s*[\d.]+\s*)?\)$/i.test(s);
        const validHsl = /^hsla?\(\s*[\d.]+\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?(\s*,\s*[\d.]+\s*)?\)$/i.test(s);
        const validNamed = /^[a-zA-Z]+$/.test(s);
        if (!validHex && !validRgb && !validHsl && !validNamed) {
          throw new Error(`DOMException: SyntaxError - The value provided ('${color}') could not be parsed as a color.`);
        }
        this.drawCalls.push({ type: 'addColorStop', offset: off, color: s });
      }
    };
  }

  measureText(text) {
    const str = String(text || '');
    return {
      width: str.length * 44,
      actualBoundingBoxAscent: 62.4,
      actualBoundingBoxDescent: 17.6,
    };
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 1: RAPID STYLING SWITCH TOGGLES STRESS & DOM IN-PLACE INVARIANCE
 * ════════════════════════════════════════════════════════════════════════════ */

test('CHALLENGE 1.1: 500 rapid randomized styling toggles preserve #cc-stage and #cc-body DOM presence without inner clearing', () => {
  const { browser, state } = setupCaptionsEnvironment();

  // Switch to Style tab
  const styleTabBtn = browser.document.querySelector('[data-tab="style"]');
  assert.ok(styleTabBtn, 'Style tab button must exist');
  styleTabBtn.dispatchEvent(new MockDOMEvent('click', { bubbles: true }));
  assert.equal(state.tab, 'style');

  const stage = browser.document.getElementById('cc-stage');
  const body = browser.document.getElementById('cc-body');
  assert.ok(stage, '#cc-stage must be in DOM');
  assert.ok(body, '#cc-body must be in DOM');

  // Record initial child elements of #cc-body to detect if it gets cleared/recreated
  const initialBodyChildCount = body.children.length;
  assert.ok(initialBodyChildCount > 0, '#cc-body must contain rendered controls');

  const togglePaths = [
    'style.gradient',
    'style.shadow',
    'style.activeGlow',
    'style.emojiEnabled',
    'style.speakerColoring',
  ];

  // Map sub-control selectors
  const subMap = {
    'style.gradient': '.cc-gradient-sub',
    'style.shadow': '.cc-shadow-sub',
    'style.activeGlow': '.cc-glow-sub',
    'style.emojiEnabled': '.cc-emoji-sub',
    'style.speakerColoring': '.cc-speaker-sub',
  };

  // Perform 500 rapid randomized flips
  for (let i = 0; i < 500; i++) {
    const path = togglePaths[i % togglePaths.length];
    const checkbox = browser.document.querySelector(`[data-bind="${path}"]`);
    assert.ok(checkbox, `Checkbox for ${path} must exist in DOM at iteration ${i}`);

    const nextVal = (i % 2 === 0);
    checkbox.checked = nextVal;
    checkbox.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));

    // Invariance assertions
    assert.strictEqual(stage.parentNode, browser.document.getElementById('captions-view'), '#cc-stage must remain attached');
    assert.strictEqual(body.parentNode, browser.document.getElementById('captions-view'), '#cc-body must remain attached');
    assert.strictEqual(stage.classList.contains('hidden'), false, '#cc-stage must NEVER have .hidden class applied');

    // Sub-control visibility must match setting exactly
    const sub = browser.document.querySelector(subMap[path]);
    assert.ok(sub, `Sub-control container ${subMap[path]} must exist in DOM`);
    assert.equal(
      sub.classList.contains('hidden'),
      !nextVal,
      `Sub-control ${subMap[path]} hidden state (${sub.classList.contains('hidden')}) must equal inverse of setting (${!nextVal}) at iter ${i}`
    );
  }

  // Final check: #cc-body must retain its original child count (no DOM wipes)
  assert.equal(body.children.length, initialBodyChildCount, '#cc-body child count must remain identical (in-place updates)');
});

test('CHALLENGE 1.2: High-frequency toggle bursts (50x ON, 50x OFF) do not corrupt UI state', () => {
  const { browser, state } = setupCaptionsEnvironment();
  const styleTabBtn = browser.document.querySelector('[data-tab="style"]');
  styleTabBtn.dispatchEvent(new MockDOMEvent('click', { bubbles: true }));

  const switches = ['style.gradient', 'style.shadow', 'style.activeGlow', 'style.emojiEnabled', 'style.speakerColoring'];

  for (const sw of switches) {
    const el = browser.document.querySelector(`[data-bind="${sw}"]`);
    assert.ok(el, `Switch ${sw} must exist`);

    // Burst 50 ONs
    for (let i = 0; i < 50; i++) {
      el.checked = true;
      el.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
    }
    const prop = sw.split('.')[1];
    assert.strictEqual(state.settings.style[prop], true, `${sw} must be committed as true`);

    // Burst 50 OFFs
    for (let i = 0; i < 50; i++) {
      el.checked = false;
      el.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
    }
    assert.strictEqual(state.settings.style[prop], false, `${sw} must be committed as false`);
  }
});

test('CHALLENGE 1.3: Preset tiles preserve DOM object identity across styling switch toggles', () => {
  const { browser } = setupCaptionsEnvironment();
  const styleTabBtn = browser.document.querySelector('[data-tab="style"]');
  styleTabBtn.dispatchEvent(new MockDOMEvent('click', { bubbles: true }));

  // Collect all preset tiles
  const initialTiles = browser.document.querySelectorAll('.cc-tile');
  assert.ok(initialTiles.length > 0, 'Preset tiles must be rendered on style tab');
  const firstTileRef = initialTiles[0];

  // Toggle styling switch
  const gradInput = browser.document.querySelector('[data-bind="style.gradient"]');
  gradInput.checked = true;
  gradInput.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));

  const currentTiles = browser.document.querySelectorAll('.cc-tile');
  assert.equal(currentTiles.length, initialTiles.length, 'Tile count must remain identical');
  assert.strictEqual(currentTiles[0], firstTileRef, 'Preset tile DOM instances must not be re-created on toggle');
});

test('CHALLENGE 1.4: Styling switch inputs dispatched on inactive tabs gracefully execute without throwing', () => {
  const { browser, state } = setupCaptionsEnvironment();

  // Remain on default 'transcript' tab
  assert.equal(state.tab, 'transcript');

  // Dispath synthetic inputs for style paths when controls are not in the DOM
  const dummyEl = browser.document.createElement('input');
  dummyEl.dataset.kind = 'bool';

  const paths = ['style.gradient', 'style.shadow', 'style.activeGlow', 'style.speakerColoring', 'style.emojiEnabled'];
  for (const p of paths) {
    dummyEl.dataset.bind = p;
    dummyEl.checked = true;

    assert.doesNotThrow(() => {
      // Simulate root receiving a bound input event
      browser.document.getElementById('captions-view').dispatchEvent(
        Object.assign(new MockDOMEvent('input', { bubbles: true }), { target: dummyEl })
      );
    }, `Dispatching input for ${p} on transcript tab must not throw`);
  }
});

test('CHALLENGE 1.5: Multi-speaker coloring toggle preserves speaker color swatches without reset', () => {
  const { browser, state } = setupCaptionsEnvironment();
  const styleTabBtn = browser.document.querySelector('[data-tab="style"]');
  styleTabBtn.dispatchEvent(new MockDOMEvent('click', { bubbles: true }));

  const speakerToggle = browser.document.querySelector('[data-bind="style.speakerColoring"]');
  const speakerSub = browser.document.querySelector('.cc-speaker-sub');
  assert.ok(speakerToggle && speakerSub, 'Speaker coloring elements must exist');

  // Verify initial speaker colors
  assert.ok(Array.isArray(state.settings.style.speakerColors));
  assert.equal(state.settings.style.speakerColors[1], '#00f0ff');

  // Toggle ON
  speakerToggle.checked = true;
  speakerToggle.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
  assert.equal(speakerSub.classList.contains('hidden'), false);
  assert.equal(state.settings.style.speakerColors[1], '#00f0ff');

  // Toggle OFF
  speakerToggle.checked = false;
  speakerToggle.dispatchEvent(new MockDOMEvent('input', { bubbles: true }));
  assert.equal(speakerSub.classList.contains('hidden'), true);
  assert.equal(state.settings.style.speakerColors[1], '#00f0ff', 'Speaker colors must remain preserved when toggled off');
});

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 2: PREVIEW COLLAPSE/EXPAND CYCLES & STAGE RESILIENCE
 * ════════════════════════════════════════════════════════════════════════════ */

test('CHALLENGE 2.1: 100 rapid collapse/expand cycles assert continuous DOM presence and dimension guarantees', () => {
  const { browser, state } = setupCaptionsEnvironment();

  const prevBtn = browser.document.querySelector('[data-act="toggle-preview"]');
  const stage = browser.document.getElementById('cc-stage');
  const body = browser.document.getElementById('cc-body');
  assert.ok(prevBtn && stage && body, 'Preview toggle button, stage, and body must exist');

  for (let cycle = 1; cycle <= 100; cycle++) {
    prevBtn.dispatchEvent(new MockDOMEvent('click', { bubbles: true }));

    // Both elements must remain in DOM at all times
    assert.ok(stage.parentNode, `Cycle ${cycle}: #cc-stage must never be detached`);
    assert.ok(body.parentNode, `Cycle ${cycle}: #cc-body must never be detached`);

    // Invalidation condition check: .hidden must NEVER be applied to #cc-stage
    assert.strictEqual(
      stage.classList.contains('hidden'),
      false,
      `Cycle ${cycle}: #cc-stage must NEVER have class .hidden (must use .cc-stage-collapsed)`
    );

    if (!state.previewOpen) {
      // Collapsed state
      assert.strictEqual(stage.classList.contains('cc-stage-collapsed'), true);
      assert.strictEqual(stage.style.height, '0px', 'Collapsed height must be set to 0px');
    } else {
      // Expanded state
      assert.strictEqual(stage.classList.contains('cc-stage-collapsed'), false);
      const hNum = parseInt(stage.style.height, 10);
      assert.ok(isFinite(hNum) && hNum >= 90, `Expanded height (${stage.style.height}) must be >= 90px`);
    }
  }
});

test('CHALLENGE 2.2: Toggle button accessibility and visual indicators stay synchronized', () => {
  const { browser, state } = setupCaptionsEnvironment();
  const prevBtn = browser.document.querySelector('[data-act="toggle-preview"]');

  // Initially expanded
  assert.strictEqual(state.previewOpen, true);
  assert.strictEqual(prevBtn.classList.contains('cc-on'), false);
  assert.strictEqual(prevBtn.title, 'Hide preview');
  assert.ok(prevBtn.innerHTML.includes('M12 5C6.5'), 'Button must show eye SVG path when expanded');

  // Collapse preview
  prevBtn.dispatchEvent(new MockDOMEvent('click', { bubbles: true }));
  assert.strictEqual(state.previewOpen, false);
  assert.strictEqual(prevBtn.classList.contains('cc-on'), true);
  assert.strictEqual(prevBtn.title, 'Show preview');
  assert.ok(prevBtn.innerHTML.includes('M12 7c2.76'), 'Button must show eyeOff SVG path when collapsed');

  // Re-expand preview
  prevBtn.dispatchEvent(new MockDOMEvent('click', { bubbles: true }));
  assert.strictEqual(state.previewOpen, true);
  assert.strictEqual(prevBtn.classList.contains('cc-on'), false);
  assert.strictEqual(prevBtn.title, 'Hide preview');
  assert.ok(prevBtn.innerHTML.includes('M12 5C6.5'), 'Button must restore eye SVG path when re-expanded');
});

test('CHALLENGE 2.3: layoutPreview guarantees non-zero height under zero or degenerate root dimensions', () => {
  const { browser } = setupCaptionsEnvironment();
  const root = browser.document.getElementById('captions-view');
  const stage = browser.document.getElementById('cc-stage');

  // Simulate zero root client dimensions (e.g. initial detached paint or collapsed window)
  root.clientHeight = 0;
  root.clientWidth = 0;
  browser.window.innerHeight = 0;
  browser.window.innerWidth = 0;

  // Trigger window resize event which calls layoutPreview()
  browser.window.dispatchEvent(new MockDOMEvent('resize'));

  // Ensure stage height safely fell back without becoming 0px or NaN
  const hNum = parseInt(stage.style.height, 10);
  assert.ok(!isNaN(hNum), `Stage height (${stage.style.height}) must not be NaN`);
  assert.ok(hNum >= 120, `Stage height (${hNum}) must fall back to >= 120px when root height is 0`);
});

test('CHALLENGE 2.4: layoutPreview sanitizes corrupt S.previewHeight values', () => {
  const { browser, state } = setupCaptionsEnvironment();
  const stage = browser.document.getElementById('cc-stage');

  const corruptHeights = [NaN, -500, 0, 10, 'invalid_height', null, undefined, Infinity];

  for (const val of corruptHeights) {
    state.previewHeight = val;
    browser.window.dispatchEvent(new MockDOMEvent('resize'));

    const hNum = parseInt(stage.style.height, 10);
    assert.ok(isFinite(hNum), `Stage height for ${val} must be finite`);
    assert.ok(hNum >= 90, `Stage height for ${val} must be >= 90px (got ${hNum})`);
  }
});

test('CHALLENGE 2.5: transitionend event safely handles rapid triggers without infinite feedback', () => {
  const { browser, state } = setupCaptionsEnvironment();
  const stage = browser.document.getElementById('cc-stage');

  let layoutCalls = 0;
  // Trigger multiple transitionend events (as browser fires per transitioned property)
  const transitions = ['height', 'min-height', 'padding-top', 'opacity'];
  for (const prop of transitions) {
    assert.doesNotThrow(() => {
      stage.dispatchEvent(Object.assign(new MockDOMEvent('transitionend'), { propertyName: prop, target: stage }));
      layoutCalls++;
    });
  }
  assert.equal(layoutCalls, 4, 'All transitionend events must be handled cleanly');
  assert.ok(parseInt(stage.style.height, 10) >= 90);
});

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 3: ADVERSARIAL CANVAS 2D RENDERING ENGINE STRESS HARNESS
 * ════════════════════════════════════════════════════════════════════════════ */

test('CHALLENGE 3.1: Canvas gradient fill under degenerate vertical bounds (0 height, negative bounds, NaN)', () => {
  const ctx = new StrictAdversarialCanvasContext();
  const settings = {
    style: {
      fontSize: 80,
      gradient: true,
      gradientColor: '#ffea00',
    }
  };

  const words = [{ text: 'DegenerateBounds', start: 0.1, end: 1.0 }];
  const scene = M.buildScene(words, settings, env());

  // Adversarial geometry scenarios
  const boundsScenarios = [
    { name: 'Zero height bounds (asc=0, desc=0)', asc: 0, desc: 0 },
    { name: 'Negative bounds (asc=-60, desc=-20)', asc: -60, desc: -20 },
    { name: 'NaN bounds', asc: NaN, desc: NaN },
    { name: 'Infinite bounds', asc: Infinity, desc: -Infinity },
  ];

  for (const sc of boundsScenarios) {
    scene.captions[0].ascent = sc.asc;
    scene.captions[0].descent = sc.desc;

    assert.doesNotThrow(() => {
      const drawn = R.drawFrame(ctx, scene, settings, 0.5, { scale: 1 });
      assert.ok(drawn >= 0);
    }, `drawFrame must not throw under ${sc.name}`);
  }
});

test('CHALLENGE 3.2: Canvas gradient fill under 50 adversarial and malformed color strings', () => {
  const ctx = new StrictAdversarialCanvasContext();
  const words = [{ text: 'ColorAttack', start: 0.1, end: 1.0 }];

  const adversarialColors = [
    // Malformed hex strings
    '', '   ', '#', '##', '###', '#1', '#12', '#12345', '#1234567', '#123456789',
    '#xyz', 'xyz', '#ggg', '123456', '#ffea00 extra', '#ffea00;',
    // Malformed rgb/rgba
    'rgb()', 'rgb(255)', 'rgba(255, 0)', 'rgba(255, 0, 0, NaN)', 'rgb(NaN, NaN, NaN)',
    'rgba(-1, -1, -1, -1)', 'rgb(255, 255, 255, 255, 255)', 'rgba(invalid)',
    // Malformed hsl/hsla
    'hsl()', 'hsl(100)', 'hsla(100, 50%)', 'hsla(invalid)',
    // Script & injection attacks
    '<script>alert(1)</script>', 'javascript:void(0)', 'rgba(0,0,0,0); DELETE FROM captions;',
    'url(https://example.com)', 'expression(alert(1))',
    // Primitive non-strings / objects
    null, undefined, 0, 12345, true, false, {}, [], NaN, Infinity
  ];

  for (const color of adversarialColors) {
    const settings = {
      style: {
        fontSize: 80,
        gradient: true,
        color: color,
        gradientColor: color,
      }
    };
    const scene = M.buildScene(words, settings, env());

    assert.doesNotThrow(() => {
      // If addColorStop receives an un-sanitized color, StrictAdversarialCanvasContext will throw DOMException
      R.drawFrame(ctx, scene, settings, 0.5, { scale: 1 });
    }, `drawFrame must never throw DOMException when gradientColor is: ${JSON.stringify(color)}`);
  }
});

test('CHALLENGE 3.3: Canvas shadow rendering with degenerate parameters and corrupt colors', () => {
  const ctx = new StrictAdversarialCanvasContext();
  const words = [{ text: 'ShadowStress', start: 0.1, end: 1.0 }];

  const degenerateShadows = [
    { shadowBlur: NaN, shadowDistance: NaN, shadowOpacity: NaN, shadowColor: 'bad_color' },
    { shadowBlur: -100, shadowDistance: -50, shadowOpacity: -2, shadowColor: null },
    { shadowBlur: Infinity, shadowDistance: Infinity, shadowOpacity: 5, shadowColor: undefined },
    { shadowBlur: 'invalid', shadowDistance: 'invalid', shadowOpacity: 'invalid', shadowColor: '<script>' },
    { shadowBlur: 14, shadowDistance: 4, shadowOpacity: 0.6, shadowColor: '#000000' },
  ];

  for (const sh of degenerateShadows) {
    const settings = {
      style: Object.assign({ fontSize: 80, shadow: true }, sh)
    };
    const scene = M.buildScene(words, settings, env());

    assert.doesNotThrow(() => {
      R.drawFrame(ctx, scene, settings, 0.5, { scale: 1 });
    }, `drawFrame must not throw with shadow params: ${JSON.stringify(sh)}`);
  }
});

test('CHALLENGE 3.4: Active word glow rendering with degenerate colors and NaN blur', () => {
  const ctx = new StrictAdversarialCanvasContext();
  const words = [{ text: 'GlowStress', start: 0.1, end: 1.0 }];

  const degenerateGlows = [
    { activeGlowColor: 'invalid_color', activeGlowBlur: NaN },
    { activeGlowColor: null, activeGlowBlur: -10 },
    { activeGlowColor: '<img src=x>', activeGlowBlur: Infinity },
    { activeGlowColor: 12345, activeGlowBlur: 'not_a_num' },
  ];

  for (const gl of degenerateGlows) {
    const settings = {
      style: Object.assign({ fontSize: 80, activeGlow: true }, gl),
      motion: { preset: 'fade_up' }
    };
    const scene = M.buildScene(words, settings, env());

    assert.doesNotThrow(() => {
      R.drawFrame(ctx, scene, settings, 0.5, { scale: 1 });
    }, `drawFrame must handle degenerate glow without uncaught exception: ${JSON.stringify(gl)}`);
  }
});

test('CHALLENGE 3.5: Multi-speaker coloring handles empty arrays, invalid types, and out-of-bound indices', () => {
  const ctx = new StrictAdversarialCanvasContext();
  const words = [
    { text: 'Speaker0', start: 0.0, end: 0.5, speaker: 0 },
    { text: 'SpeakerNeg', start: 0.5, end: 1.0, speaker: -5 },
    { text: 'SpeakerHuge', start: 1.0, end: 1.5, speaker: 999999 },
    { text: 'SpeakerNaN', start: 1.5, end: 2.0, speaker: NaN },
    { text: 'SpeakerNull', start: 2.0, end: 2.5, speaker: null },
  ];

  const palettes = [
    [],                                      // Empty array
    null,                                    // Null
    undefined,                               // Undefined
    '#ffffff',                               // Wrong type (string)
    ['invalid_color', null, undefined, 42],  // Corrupt entries
    ['#ffffff', '#00f0ff'],                  // Normal
  ];

  for (const pal of palettes) {
    const settings = {
      style: {
        fontSize: 80,
        speakerColoring: true,
        speakerColors: pal,
      }
    };
    const scene = M.buildScene(words, settings, env());

    assert.doesNotThrow(() => {
      R.drawFrame(ctx, scene, settings, 0.25, { scale: 1 });
      R.drawFrame(ctx, scene, settings, 0.75, { scale: 1 });
      R.drawFrame(ctx, scene, settings, 1.25, { scale: 1 });
      R.drawFrame(ctx, scene, settings, 1.75, { scale: 1 });
      R.drawFrame(ctx, scene, settings, 2.25, { scale: 1 });
    }, `Speaker coloring must not throw with palette: ${JSON.stringify(pal)}`);
  }
});

test('CHALLENGE 3.6: Background and pill rendering (fillRound) under degenerate coordinates and alpha', () => {
  const ctx = new StrictAdversarialCanvasContext();
  const words = [{ text: 'PillStress', start: 0.1, end: 1.0, emphasis: true }];

  const degenerateBackgrounds = [
    { background: 'box', bgColor: 'corrupt', bgOpacity: NaN, bgRadius: NaN },
    { background: 'block', bgColor: null, bgOpacity: -1, bgRadius: -0.5 },
    { background: 'pills', bgColor: undefined, bgOpacity: 2.0, bgRadius: 10 },
    { background: 'pills', pillColor: 'invalid', pillOpacity: NaN },
  ];

  for (const bg of degenerateBackgrounds) {
    const settings = {
      style: Object.assign({ fontSize: 80 }, bg)
    };
    const scene = M.buildScene(words, settings, env());

    assert.doesNotThrow(() => {
      R.drawFrame(ctx, scene, settings, 0.5, { scale: 1 });
    }, `fillRound must gracefully handle degenerate inputs: ${JSON.stringify(bg)}`);
  }
});

test('CHALLENGE 3.7: Full Scene animation frame stress under composite adversarial configuration', () => {
  const ctx = new StrictAdversarialCanvasContext(1080, 1920);

  // Generate 50 realistic mixed words
  const words = [];
  for (let i = 0; i < 50; i++) {
    words.push({
      id: i,
      text: i % 5 === 0 ? 'Urduیہ' : (i % 7 === 0 ? 'rocket🚀' : `word${i}`),
      start: i * 0.4,
      end: (i + 1) * 0.4,
      speaker: i % 3,
      emphasis: (i % 4 === 0),
    });
  }

  // Composite hostile configuration: ALL features enabled with adversarial inputs simultaneously
  const hostileSettings = {
    style: {
      fontSize: 80,
      gradient: true,
      gradientColor: 'bad_grad_color!#$%',
      shadow: true,
      shadowColor: 'bad_shadow',
      shadowBlur: NaN,
      shadowOpacity: NaN,
      shadowDistance: NaN,
      activeGlow: true,
      activeGlowColor: 'bad_glow',
      activeGlowBlur: NaN,
      speakerColoring: true,
      speakerColors: ['bad_c1', null, undefined, '#12345'],
      emojiEnabled: true,
      background: 'box',
      bgColor: 'bad_bg',
      bgOpacity: NaN,
      emphasis: 'both',
      emphasisColor: 'bad_emph',
      pillColor: 'bad_pill',
    },
    motion: {
      preset: 'fade_up',
      highlight: 'color',
    },
    layout: {
      rotation: NaN, // Even NaN rotation
      posX: 50,
      posY: 72,
      boxWidth: 86,
    }
  };

  const scene = M.buildScene(words, hostileSettings, env());
  assert.ok(scene.captions.length > 0, 'Scene must build successfully');

  // Render 100 consecutive frames across the scene duration
  for (let frame = 0; frame < 100; frame++) {
    const t = (frame / 100) * 20.0;
    assert.doesNotThrow(() => {
      R.drawFrame(ctx, scene, hostileSettings, t, { scale: 0.5 });
    }, `Frame ${frame} at t=${t}s must render without uncaught exception`);
  }
});
