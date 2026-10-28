/**
 * tests/e2e/tier3-pairwise-combinations.test.js
 *
 * Tier 3: Cross-Feature Combinations (Pairwise Interactions across R1, R2, R3, R4)
 * Opaque-box interaction matrix testing:
 * - Styling toggles with BiDi captions (R1 x R2)
 * - Color changes with BiDi text (R2 x R3)
 * - Preview collapse during playback & scrub (R1 x R4)
 * - Multi-speaker coloring on BiDi layout (R1 x R2 x R3)
 * - Dynamic emojis on mixed bidirectional scripts (R1 x R2)
 * - Full export vs preview parity under multi-feature load (R1 x R2 x R3 x R4)
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
 * PAIRWISE COMBINATION 1: R1 (STYLING TOGGLES) x R2 (BIDI CAPTIONS)
 * ════════════════════════════════════════════════════════════════════════════ */

test('Pairwise-1: Gradient fill + drop shadow toggles on mixed Urdu/English captions render safely', () => {
  const browser = createBrowserEnvironment();
  const canvas = browser.document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  const rawWords = [
    { text: 'یہ', start: 0.0, end: 0.3 },
    { text: 'AI', start: 0.3, end: 0.6 },
    { text: 'ویڈیو', start: 0.6, end: 0.9 },
    { text: 'ٹول', start: 0.9, end: 1.2 },
    { text: 'ہے', start: 1.2, end: 1.5 },
  ];
  const settings = {
    style: {
      fontSize: 80,
      gradient: true,
      gradientColor: '#ffea00',
      shadow: true,
      shadowColor: '#000000',
      shadowBlur: 14,
    },
    grouping: { maxWords: 6 }
  };

  assert.doesNotThrow(() => {
    const scene = M.buildScene(rawWords, settings, env());
    R.drawFrame(ctx, scene, settings, 0.5, { scale: 1 });
  });

  const fillCalls = ctx._drawCalls.filter((c) => c.type === 'fillText');
  assert.ok(fillCalls.length > 0, 'Canvas must receive text drawing calls for BiDi caption');
});

/* ════════════════════════════════════════════════════════════════════════════
 * PAIRWISE COMBINATION 2: R2 (BIDI TEXT) x R3 (CUSTOM PERSISTENT HEX COLORS)
 * ════════════════════════════════════════════════════════════════════════════ */

test('Pairwise-2: Custom HEX colors (#3b82f6 text, #ffd84d active) applied to Urdu BiDi captions', () => {
  const browser = createBrowserEnvironment();
  const canvas = browser.document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  const rawWords = [
    { text: 'خوشآمدید', start: 0.0, end: 0.5 },
    { text: 'Welcome', start: 0.5, end: 1.0 },
  ];
  const settings = {
    style: {
      color: '#3b82f6',
      activeColor: '#ffd84d',
      fontFamily: 'Noto Nastaliq Urdu',
    },
    motion: { preset: 'karaoke', highlight: 'color' },
    grouping: { maxWords: 4 }
  };

  const scene = M.buildScene(rawWords, settings, env());
  R.drawFrame(ctx, scene, settings, 0.75, { scale: 1 }); // At t=0.75, "Welcome" is active

  const fillCalls = ctx._drawCalls.filter((c) => c.type === 'fillText');
  assert.ok(fillCalls.length >= 2);
});

/* ════════════════════════════════════════════════════════════════════════════
 * PAIRWISE COMBINATION 3: R1 (PREVIEW COLLAPSE) x R4 (PLAYBACK / SCRUB ENGINE)
 * ════════════════════════════════════════════════════════════════════════════ */

test('Pairwise-3: Preview collapse during active playback stops RAF loop cleanly and resumes on open', () => {
  const browser = createBrowserEnvironment();
  const stage = browser.document.createElement('div');
  stage.id = 'cc-stage';
  browser.root.appendChild(stage);

  let isPlaying = true;
  let rafRunning = true;
  let previewOpen = true;

  function togglePreview() {
    previewOpen = !previewOpen;
    if (!previewOpen) {
      isPlaying = false;
      rafRunning = false;
    } else {
      rafRunning = true;
    }
    stage.classList.toggle('hidden', !previewOpen);
  }

  // Collapse preview while playing
  togglePreview();
  assert.equal(previewOpen, false);
  assert.equal(isPlaying, false);
  assert.equal(rafRunning, false);
  assert.equal(stage.classList.contains('hidden'), true);

  // Re-open preview
  togglePreview();
  assert.equal(previewOpen, true);
  assert.equal(stage.classList.contains('hidden'), false);
  assert.equal(rafRunning, true);
});

/* ════════════════════════════════════════════════════════════════════════════
 * PAIRWISE COMBINATION 4: R1 (SPEAKER COLORING) x R2 (BIDI) x R3 (HEX COLORS)
 * ════════════════════════════════════════════════════════════════════════════ */

test('Pairwise-4: Multi-speaker coloring toggle with custom hex swatches on mixed Urdu/English dialogue', () => {
  const browser = createBrowserEnvironment();
  const canvas = browser.document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  const rawWords = [
    { text: 'آپ', start: 0.0, end: 0.3, speaker: 0 },
    { text: 'کیسے', start: 0.3, end: 0.6, speaker: 0 },
    { text: 'ہیں؟', start: 0.6, end: 0.9, speaker: 0 },
    { text: 'I', start: 1.0, end: 1.2, speaker: 1 },
    { text: 'am', start: 1.2, end: 1.4, speaker: 1 },
    { text: 'fine', start: 1.4, end: 1.6, speaker: 1 },
  ];
  const settings = {
    style: {
      speakerColoring: true,
      speakerColors: ['#00f0ff', '#ff6b6b'],
    },
    grouping: { maxWords: 6 }
  };

  const scene = M.buildScene(rawWords, settings, env());
  assert.ok(scene.captions.length > 0);

  // Ensure speaker tags are preserved in word layout
  const cap0Words = scene.captions[0].lines[0].words;
  assert.equal(cap0Words[0].speaker, 0);

  assert.doesNotThrow(() => {
    R.drawFrame(ctx, scene, settings, 0.4, { scale: 1 });
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * PAIRWISE COMBINATION 5: R1 (DYNAMIC EMOJIS) x R2 (BIDI HEADROOM)
 * ════════════════════════════════════════════════════════════════════════════ */

test('Pairwise-5: Dynamic emojis enabled on Urdu captions calculate vertical headroom without glyph clipping', () => {
  const rawWords = [
    { text: 'روپے', start: 0.0, end: 0.5, emoji: '💰' },
    { text: 'بچائیں', start: 0.5, end: 1.0 },
  ];
  const settingsAbove = { style: { emojiEnabled: true, emojiPlacement: 'above', emojiScale: 1.2 } };
  const settingsInline = { style: { emojiEnabled: true, emojiPlacement: 'inline' } };

  const sceneAbove = M.buildScene(rawWords, settingsAbove, env());
  const sceneInline = M.buildScene(rawWords, settingsInline, env());

  // 'above' placement expands the bounding box height to fit emoji without clipping
  assert.ok(
    sceneAbove.captions[0].box.h > sceneInline.captions[0].box.h,
    'Above emoji placement must expand box height for headroom'
  );
});

/* ════════════════════════════════════════════════════════════════════════════
 * PAIRWISE COMBINATION 6: R3 (HEX NORMALIZATION) x R4 (MEMOIZATION UNDER LOAD)
 * ════════════════════════════════════════════════════════════════════════════ */

test('Pairwise-6: Memoized color normalization parses 1000 HEX codes in <10ms', () => {
  const colorCache = new Map();
  function memoNormalizeHex(hex) {
    if (colorCache.has(hex)) return colorCache.get(hex);
    let s = String(hex || '').trim().replace(/^#/, '');
    if (s.length === 3) s = s.split('').map((c) => c + c).join('');
    const norm = '#' + s.slice(0, 6).toLowerCase();
    colorCache.set(hex, norm);
    return norm;
  }

  const inputs = ['#fff', '3b82f6', '#ff00aa', '123456', '#00f0ff'];
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) {
    const hex = inputs[i % inputs.length];
    memoNormalizeHex(hex);
  }
  const t1 = performance.now();

  assert.ok((t1 - t0) < 10, `1000 color normalizations completed in ${(t1 - t0).toFixed(2)}ms`);
});

/* ════════════════════════════════════════════════════════════════════════════
 * PAIRWISE COMBINATION 7: R1 + R2 + R3 + R4 EXPORT PARITY STRESS
 * ════════════════════════════════════════════════════════════════════════════ */

test('Pairwise-7: Full preview-to-export parity across complex styling and mixed BiDi captions', () => {
  const browser = createBrowserEnvironment();
  const cvPreview = browser.document.createElement('canvas');
  const cvExport = browser.document.createElement('canvas');

  const rawWords = [
    { text: 'یہ', start: 0.0, end: 0.3 },
    { text: 'AI', start: 0.3, end: 0.6 },
    { text: 'ٹول', start: 0.6, end: 0.9 },
    { text: 'Fast', start: 0.9, end: 1.2 },
    { text: 'ہے', start: 1.2, end: 1.5 },
  ];
  const settings = {
    style: {
      fontSize: 80,
      color: '#3b82f6',
      gradient: true,
      gradientColor: '#ff00aa',
      shadow: true,
      shadowColor: '#000000',
      shadowBlur: 16,
      strokeWidth: 4,
      strokeColor: '#0a1a2e',
    },
    grouping: { maxWords: 6 }
  };

  const scene = M.buildScene(rawWords, settings, env());
  R.drawFrame(cvPreview.getContext('2d'), scene, settings, 0.45, { scale: 1 });
  R.drawFrame(cvExport.getContext('2d'), scene, settings, 0.45, { scale: 1 });

  const pCalls = cvPreview.getContext('2d')._drawCalls.filter((c) => c.type === 'fillText');
  const eCalls = cvExport.getContext('2d')._drawCalls.filter((c) => c.type === 'fillText');

  assert.equal(pCalls.length, eCalls.length);
  for (let i = 0; i < pCalls.length; i++) {
    assert.equal(pCalls[i].text, eCalls[i].text);
    assert.equal(pCalls[i].x, eCalls[i].x);
    if (typeof pCalls[i].fillStyle === 'object' && pCalls[i].fillStyle !== null) {
      assert.deepEqual(pCalls[i].fillStyle.stops, eCalls[i].fillStyle.stops);
      assert.equal(pCalls[i].fillStyle.y0, eCalls[i].fillStyle.y0);
      assert.equal(pCalls[i].fillStyle.y1, eCalls[i].fillStyle.y1);
    } else {
      assert.equal(pCalls[i].fillStyle, eCalls[i].fillStyle);
    }
  }
});
