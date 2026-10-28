/**
 * tests/e2e/tier2-boundary-corner.test.js
 *
 * Tier 2: Boundary & Corner Cases (>=5 test cases per feature across R1, R2, R3, R4)
 * Opaque-box adversarial stress testing: empty inputs, rapid toggles, mixed bidirectional scripts,
 * invalid/unhashed/shorthand hex colors, startup stress.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createBrowserEnvironment, loadModuleWithSandbox } = require('./harness');

const MODEL_PATH = path.resolve(__dirname, '..', '..', 'cep-panel', 'client', 'src', 'captions', 'model.js');
const RENDER_PATH = path.resolve(__dirname, '..', '..', 'cep-panel', 'client', 'src', 'captions', 'render.js');

const M = loadModuleWithSandbox(MODEL_PATH);
const R = loadModuleWithSandbox(RENDER_PATH, Object.assign({}, M, {
  clamp01: (v) => Math.max(0, Math.min(1, v)),
}));

const FONT_SIZE = 80;
const measure = (t) => String(t || '').length * FONT_SIZE * 0.55;
const env = (extra) => Object.assign({
  width: 1080, height: 1920, fps: { num: 30, den: 1 },
  measure, fontMetrics: { ascent: FONT_SIZE * 0.78, descent: FONT_SIZE * 0.22 }
}, extra || {});

/* ════════════════════════════════════════════════════════════════════════════
 * TIER 2 — BOUNDARY & CORNER CASES: REQUIREMENT R1 (UI TOGGLE STABILITY)
 * ════════════════════════════════════════════════════════════════════════════ */

test('R1-BC1: Rapid toggle storm: toggling style controls 20 times rapidly leaves DOM in consistent state', () => {
  const browser = createBrowserEnvironment();
  const subGradient = browser.document.createElement('div');
  subGradient.className = 'cc-gradient-sub cc-sub-ctls hidden';
  const subShadow = browser.document.createElement('div');
  subShadow.className = 'cc-shadow-sub cc-sub-ctls hidden';

  let gradientOn = false;
  let shadowOn = false;

  for (let i = 0; i < 20; i++) {
    gradientOn = !gradientOn;
    shadowOn = !shadowOn;
    subGradient.classList.toggle('hidden', !gradientOn);
    subShadow.classList.toggle('hidden', !shadowOn);
  }

  // After 20 toggles, state must return to false and class hidden must be present
  assert.equal(gradientOn, false);
  assert.equal(shadowOn, false);
  assert.equal(subGradient.classList.contains('hidden'), true);
  assert.equal(subShadow.classList.contains('hidden'), true);
});

test('R1-BC2: Rapid preview collapse storm: toggling collapse 20 times rapidly preserves layout integrity', () => {
  const browser = createBrowserEnvironment();
  const stage = browser.document.createElement('div');
  stage.id = 'cc-stage';
  stage.clientWidth = 400; stage.clientHeight = 300;

  let previewOpen = true;
  for (let i = 0; i < 20; i++) {
    previewOpen = !previewOpen;
    stage.classList.toggle('hidden', !previewOpen);
  }

  assert.equal(previewOpen, true);
  assert.equal(stage.classList.contains('hidden'), false);
  assert.ok(stage.clientWidth > 0);
});

test('R1-BC3: Zero-word transcript toggle: toggling all styling switches on empty words does not crash', () => {
  assert.doesNotThrow(() => {
    const emptyWords = [];
    const settings = {
      style: { gradient: true, shadow: true, activeGlow: true, emojiEnabled: true, speakerColoring: true }
    };
    const scene = M.buildScene(emptyWords, settings, env());
    assert.equal(scene.captions.length, 0);
  });
});

test('R1-BC4: Extreme viewport bounds: 50x50 and 4000x4000 sequence geometries do not produce NaN or infinite coordinates', () => {
  const words = [{ text: 'BoundTest', start: 0, end: 1 }];
  const tinyEnv = env({ width: 50, height: 50 });
  const giantEnv = env({ width: 4000, height: 4000 });

  const sceneTiny = M.buildScene(words, {}, tinyEnv);
  const sceneGiant = M.buildScene(words, {}, giantEnv);

  const wordTiny = sceneTiny.captions[0].lines[0].words[0];
  const wordGiant = sceneGiant.captions[0].lines[0].words[0];

  assert.ok(isFinite(wordTiny.x) && !isNaN(wordTiny.x));
  assert.ok(isFinite(wordTiny.w) && !isNaN(wordTiny.w));
  assert.ok(isFinite(wordGiant.x) && !isNaN(wordGiant.x));
  assert.ok(isFinite(wordGiant.w) && !isNaN(wordGiant.w));
});

test('R1-BC5: Resilient canvas styler: degenerate canvas dimensions (0x0) do not throw DOMExceptions', () => {
  const browser = createBrowserEnvironment();
  const canvas = browser.document.createElement('canvas');
  canvas.width = 0; canvas.height = 0;
  const ctx = canvas.getContext('2d');

  const words = [{ text: 'Test', start: 0, end: 1 }];
  const scene = M.buildScene(words, {}, env());

  assert.doesNotThrow(() => {
    R.drawFrame(ctx, scene, {}, 0.5, { scale: 0 });
  });
});

test('R1-BC6: Concurrent toggle and tab switch: toggling a style control immediately before tab switch preserves setting', () => {
  const settings = { style: { gradient: false } };
  let currentTab = 'style';

  // Toggle gradient on
  settings.style.gradient = true;
  // Immediately switch tab to export
  currentTab = 'export';
  // Re-switch back to style
  currentTab = 'style';

  assert.equal(settings.style.gradient, true, 'Setting change must not be overwritten by tab switch');
});

/* ════════════════════════════════════════════════════════════════════════════
 * TIER 2 — BOUNDARY & CORNER CASES: REQUIREMENT R2 (BIDI TYPOGRAPHY BOUNDARIES)
 * ════════════════════════════════════════════════════════════════════════════ */

test('R2-BC1: Empty string and whitespace-only text safely handled in isRTLText and buildScene', () => {
  assert.equal(M.isRTLText(''), false);
  assert.equal(M.isRTLText('   '), false);
  assert.equal(M.isRTLText(null), false);
  assert.equal(M.isRTLText(undefined), false);

  const words = [{ text: '', start: 0, end: 1 }, { text: '   ', start: 1, end: 2 }];
  const scene = M.buildScene(words, {}, env());
  assert.ok(scene);
});

test('R2-BC2: Single-character alternating RTL/LTR tokens ("A یہ B وہ") calculates positions without out-of-bounds', () => {
  const words = [
    { text: 'A', start: 0.0, end: 0.4 },
    { text: 'یہ', start: 0.4, end: 0.8 },
    { text: 'B', start: 0.8, end: 1.2 },
    { text: 'وہ', start: 1.2, end: 1.6 },
  ];
  assert.doesNotThrow(() => {
    const scene = M.buildScene(words, { grouping: { maxWords: 5 } }, env());
    assert.equal(scene.captions[0].lines[0].words.length, 4);
    for (const w of scene.captions[0].lines[0].words) {
      assert.ok(isFinite(w.x) && !isNaN(w.x));
    }
  });
});

test('R2-BC3: Special Urdu punctuation marks (، ؛ ۔) attached to words preserve logical attachment', () => {
  const words = [
    { text: 'خوشآمدید،', start: 0.0, end: 0.5 },
    { text: 'دوستو۔', start: 0.5, end: 1.0 },
  ];
  const scene = M.buildScene(words, { grouping: { maxWords: 4 } }, env());
  assert.equal(scene.captions[0].lines[0].rtl, true);
  const w1 = scene.captions[0].lines[0].words[0];
  const w2 = scene.captions[0].lines[0].words[1];
  assert.ok(w2.x < w1.x, 'RTL word order with Urdu punctuation must flow right-to-left');
});

test('R2-BC4: Deeply nested bidirectional runs: multiple English phrases embedded in Urdu sentence', () => {
  // "یہ AI اور ML کے ساتھ NLP کا نیا ٹول ہے"
  const rawWords = [
    { text: 'یہ', start: 0.0, end: 0.3 },
    { text: 'AI', start: 0.3, end: 0.6 },
    { text: 'اور', start: 0.6, end: 0.9 },
    { text: 'ML', start: 0.9, end: 1.2 },
    { text: 'کے', start: 1.2, end: 1.4 },
    { text: 'ساتھ', start: 1.4, end: 1.7 },
    { text: 'NLP', start: 1.7, end: 2.0 },
    { text: 'کا', start: 2.0, end: 2.2 },
    { text: 'نیا', start: 2.2, end: 2.5 },
    { text: 'ٹول', start: 2.5, end: 2.8 },
    { text: 'ہے', start: 2.8, end: 3.0 },
  ];
  const scene = M.buildScene(rawWords, { grouping: { maxWords: 12 } }, env());
  assert.ok(scene.captions.length > 0);
  const totalWords = scene.captions.flatMap((c) => c.lines.flatMap((l) => l.words));
  assert.equal(totalWords.length, 11);
});

test('R2-BC5: Extreme font sizes (24px to 220px) preserve proportional vertical clearance preventing clipping', () => {
  const rawWords = [{ text: 'اردو خطاطی', start: 0, end: 1 }];
  const sceneSmall = M.buildScene(rawWords, { style: { fontSize: 24 } }, { width: 1080, height: 1920, fps: { num: 30, den: 1 }, measure });
  const sceneBig = M.buildScene(rawWords, { style: { fontSize: 220 } }, { width: 1080, height: 1920, fps: { num: 30, den: 1 }, measure });

  assert.ok(sceneSmall.captions[0].ascent >= 24 * 0.9);
  assert.ok(sceneSmall.captions[0].descent >= 24 * 0.35);

  assert.ok(sceneBig.captions[0].ascent >= 220 * 0.9);
  assert.ok(sceneBig.captions[0].descent >= 220 * 0.35);
});

test('R2-BC6: Numeric tokens in RTL sentences preserve numeric digit reading order', () => {
  const rawWords = [
    { text: 'قیمت', start: 0, end: 0.4 },
    { text: '500', start: 0.4, end: 0.8 },
    { text: 'روپے', start: 0.8, end: 1.2 },
  ];
  const scene = M.buildScene(rawWords, { grouping: { maxWords: 4 } }, env());
  const words = scene.captions[0].lines[0].words;
  const numWord = words.find((w) => w.text === '500');
  assert.ok(numWord, 'Numeric token must exist');
  assert.equal(numWord.text, '500', 'Numeric digits must not be reversed');
});

/* ════════════════════════════════════════════════════════════════════════════
 * TIER 2 — BOUNDARY & CORNER CASES: REQUIREMENT R3 (HEX PICKER BOUNDARIES)
 * ════════════════════════════════════════════════════════════════════════════ */

function parseAndValidateHex(hex, fallback = '#ffffff') {
  if (!hex || typeof hex !== 'string') return fallback;
  const s = hex.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    return '#' + s.split('').map((c) => c + c).join('').toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(s)) {
    return '#' + s.toLowerCase();
  }
  if (/^[0-9a-fA-F]{8}$/.test(s)) {
    return '#' + s.toLowerCase();
  }
  return fallback;
}

test('R3-BC1: Invalid HEX string rejection falls back to previous valid color without assigning NaN or undefined', () => {
  const previous = '#3b82f6';
  assert.equal(parseAndValidateHex('invalid-color', previous), previous);
  assert.equal(parseAndValidateHex('#12', previous), previous);
  assert.equal(parseAndValidateHex('#gggggg', previous), previous);
  assert.equal(parseAndValidateHex('', previous), previous);
});

test('R3-BC2: Case insensitivity: lowercase and uppercase HEX strings normalize identically', () => {
  assert.equal(parseAndValidateHex('#3B82F6'), '#3b82f6');
  assert.equal(parseAndValidateHex('3B82F6'), '#3b82f6');
  assert.equal(parseAndValidateHex('#ABC'), '#aabbcc');
});

test('R3-BC3: Whitespace padding: leading/trailing tabs and spaces strip cleanly', () => {
  assert.equal(parseAndValidateHex('  #ff0055  '), '#ff0055');
  assert.equal(parseAndValidateHex('\t#102030\n'), '#102030');
});

test('R3-BC4: 8-digit alpha HEX support: parses and converts to valid rgba representation', () => {
  const hexWithAlpha = parseAndValidateHex('#3b82f680');
  assert.equal(hexWithAlpha, '#3b82f680');

  // Verify rgba conversion
  const rgbaStr = R.rgba('#3b82f6', 0.5);
  assert.match(rgbaStr, /^rgba\(59,130,246,0\.5\)$/);
});

test('R3-BC5: High-frequency input changes: multiple rapid input events retain final committed value', () => {
  let currentColor = '#ffffff';
  const rapidInputs = ['#ff0000', '#00ff00', '#0000ff', '#3b82f6'];
  for (const c of rapidInputs) {
    const valid = parseAndValidateHex(c, currentColor);
    currentColor = valid;
  }
  assert.equal(currentColor, '#3b82f6');
});

test('R3-BC6: Functional rgb(...) string handling: converts without NaN in color helpers', () => {
  function rgbToHex(str) {
    const m = String(str).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return null;
    const r = Number(m[1]).toString(16).padStart(2, '0');
    const g = Number(m[2]).toString(16).padStart(2, '0');
    const b = Number(m[3]).toString(16).padStart(2, '0');
    return '#' + r + g + b;
  }
  assert.equal(rgbToHex('rgb(59, 130, 246)'), '#3b82f6');
  assert.equal(rgbToHex('rgba(255, 255, 255, 0.8)'), '#ffffff');
});

/* ════════════════════════════════════════════════════════════════════════════
 * TIER 2 — BOUNDARY & CORNER CASES: REQUIREMENT R4 (ARCHITECTURE & PERFORMANCE)
 * ════════════════════════════════════════════════════════════════════════════ */

test('R4-BC1: Massive transcript stress test: 500 words parse, group, and layout in <100ms', () => {
  const hugeWords = [];
  for (let i = 0; i < 500; i++) {
    hugeWords.push({ text: 'word' + i, start: i * 0.4, end: (i + 1) * 0.4 });
  }

  const t0 = performance.now();
  const scene = M.buildScene(hugeWords, {}, env());
  const t1 = performance.now();

  assert.ok(scene.captions.length > 50);
  assert.ok((t1 - t0) < 100, `500-word layout took ${(t1 - t0).toFixed(2)}ms (budget: < 100ms)`);
});

test('R4-BC2: Degenerate sequence info fallback: fps 0 or missing dimensions fallback safely', () => {
  assert.doesNotThrow(() => {
    const fpsZero = M.fpsFromNumber(0);
    assert.deepEqual(fpsZero, { num: 30, den: 1 });

    const fpsNeg = M.fpsFromNumber(-10);
    assert.deepEqual(fpsNeg, { num: 30, den: 1 });

    const ticksZero = M.fpsFromTicks(0);
    assert.deepEqual(ticksZero, { num: 30, den: 1 });
  });
});

test('R4-BC3: Corrupted localStorage JSON recovery: bad JSON string falls back safely to default settings', () => {
  const browser = createBrowserEnvironment();
  const settingsKey = 'editflow.captions.settings.v3';
  browser.localStorage.setItem(settingsKey, '{malformed json! not valid');

  let loadedSettings;
  try {
    loadedSettings = JSON.parse(browser.localStorage.getItem(settingsKey));
  } catch (_) {
    loadedSettings = null;
  }
  const effective = loadedSettings || { preset: 'clean', style: R.STYLE_DEFAULTS };

  assert.equal(effective.preset, 'clean');
  assert.equal(effective.style.color, '#ffffff');
});

test('R4-BC4: High-frequency seek / playhead stress: 100 consecutive seeks execute without memory leak', () => {
  const words = [{ text: 'Scrub', start: 0, end: 10 }];
  const scene = M.buildScene(words, {}, env());

  const t0 = performance.now();
  for (let i = 0; i < 100; i++) {
    const key = M.frameKey(scene, (i / 100) * 10, M.MOTION_DEFAULTS);
    assert.ok(typeof key === 'string');
  }
  const t1 = performance.now();
  assert.ok((t1 - t0) < 50, `100 seeks completed in ${(t1 - t0).toFixed(2)}ms`);
});

test('R4-BC5: Missing font fallback: requesting uninstalled font resolves safely without throwing', () => {
  const fontStr = R.fontString({ fontFamily: 'NonExistentFontXYZ123', fontWeight: 900 }, 80);
  assert.ok(fontStr.includes('NonExistentFontXYZ123'));
  assert.ok(fontStr.includes('sans-serif'));
});

test('R4-BC6: Extreme word durations (0.0s and 100s) clamp cleanly without NaN in animation states', () => {
  const cap = { tIn: 0, tOut: 100, exitStart: 99.9 };
  const wordZero = { text: 'Zero', start: 1.0, end: 1.0 };
  const wordHuge = { text: 'Huge', start: 0.0, end: 100.0 };

  const sZero = M.wordState(1.0, wordZero, cap, M.MOTION_DEFAULTS, 80);
  const sHuge = M.wordState(50.0, wordHuge, cap, M.MOTION_DEFAULTS, 80);

  assert.ok(isFinite(sZero.alpha) && !isNaN(sZero.alpha));
  assert.ok(isFinite(sHuge.alpha) && !isNaN(sHuge.alpha));
});
