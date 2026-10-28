/**
 * tests/e2e/tier4-realworld-scenarios.test.js
 *
 * Tier 4: Real-World Application Scenarios
 * High-fidelity end-to-end user workflows simulating actual production use-cases:
 * 1. Multi-speaker Urdu/English tech podcast captioning with timeline chapter markers.
 * 2. Viral TikTok/Reels subtitle generation with pasteable custom hex gradient & dynamic emojis.
 * 3. Full transparent video overlay export pipeline with frameKey repeat caching.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createBrowserEnvironment, loadModuleWithSandbox } = require('./harness');

const MODEL_PATH = path.resolve(__dirname, '..', '..', 'cep-panel', 'client', 'src', 'captions', 'model.js');
const RENDER_PATH = path.resolve(__dirname, '..', '..', 'cep-panel', 'client', 'src', 'captions', 'render.js');
const CHAPTERS_PATH = path.resolve(__dirname, '..', '..', 'cep-panel', 'client', 'src', 'captions', 'chapters.js');

const M = loadModuleWithSandbox(MODEL_PATH);
const R = loadModuleWithSandbox(RENDER_PATH, Object.assign({}, M, {
  clamp01: (v) => Math.max(0, Math.min(1, v)),
}));
const C = loadModuleWithSandbox(CHAPTERS_PATH);

const FONT_SIZE = 80;
const measure = (t) => String(t || '').length * FONT_SIZE * 0.55;
const env = (extra) => Object.assign({
  width: 1080, height: 1920, fps: { num: 30, den: 1 },
  measure, fontMetrics: { ascent: FONT_SIZE * 0.78, descent: FONT_SIZE * 0.22 }
}, extra || {});

/* ════════════════════════════════════════════════════════════════════════════
 * REAL-WORLD SCENARIO 1: MULTI-SPEAKER URDU/ENGLISH PODCAST CAPTIONING
 * ════════════════════════════════════════════════════════════════════════════ */

test('Scenario 1: Multi-speaker Urdu/English tech podcast captioning & chapter detection', () => {
  // Ingest raw dialogue transcript with 2 speakers discussing AI tools in Urdu and English
  const podcastTranscript = [
    // Speaker 0 (Host - Urdu intro)
    { text: 'آج', start: 0.0, end: 0.3, speaker: 0 },
    { text: 'ہمارے', start: 0.3, end: 0.6, speaker: 0 },
    { text: 'ساتھ', start: 0.6, end: 0.9, speaker: 0 },
    { text: 'موجود', start: 0.9, end: 1.2, speaker: 0 },
    { text: 'ہیں', start: 1.2, end: 1.5, speaker: 0 },
    // Speaker 0 (Host introduces tech topic with embedded English)
    { text: 'یہ', start: 1.8, end: 2.1, speaker: 0 },
    { text: 'نیا', start: 2.1, end: 2.4, speaker: 0 },
    { text: 'AI', start: 2.4, end: 2.7, speaker: 0 },
    { text: 'workflow', start: 2.7, end: 3.1, speaker: 0 },
    { text: 'ہے', start: 3.1, end: 3.4, speaker: 0 },
    // Speaker 1 (Guest - English response)
    { text: 'Thank', start: 4.0, end: 4.3, speaker: 1 },
    { text: 'you', start: 4.3, end: 4.6, speaker: 1 },
    { text: 'so', start: 4.6, end: 4.8, speaker: 1 },
    { text: 'much', start: 4.8, end: 5.1, speaker: 1 },
    { text: 'for', start: 5.1, end: 5.3, speaker: 1 },
    { text: 'having', start: 5.3, end: 5.6, speaker: 1 },
    { text: 'me', start: 5.6, end: 5.9, speaker: 1 },
  ];

  // Configure user styling settings
  const settings = {
    style: {
      fontSize: 84,
      fontFamily: 'Noto Nastaliq Urdu',
      speakerColoring: true,
      speakerColors: ['#00f0ff', '#ffd84d'], // Host cyan, Guest yellow
      shadow: true,
      shadowColor: '#000000',
    },
    grouping: { maxWords: 5, splitGap: 0.4 },
    layout: { posX: 50, posY: 75 },
  };

  // Step 1: Build scene
  const scene = M.buildScene(podcastTranscript, settings, env());
  assert.ok(scene.captions.length >= 3, 'Dialogue must segment into at least 3 captions');

  // Step 2: Validate speaker preservation across captions
  const hostCap = scene.captions[0];
  assert.equal(hostCap.lines[0].words[0].speaker, 0);

  const guestCap = scene.captions[scene.captions.length - 1];
  assert.equal(guestCap.lines[0].words[0].speaker, 1);

  // Step 3: Auto-detect chapters from dialogue pauses
  const chapters = C.autoDetectChapters(podcastTranscript);
  assert.ok(Array.isArray(chapters));
  assert.ok(chapters.length >= 1, 'Must detect intro chapter from speech start');

  // Step 4: Validate YouTube export formatting
  const ytText = C.formatSocialChapters(chapters, 'youtube');
  assert.match(ytText, /0:00/);
});

/* ════════════════════════════════════════════════════════════════════════════
 * REAL-WORLD SCENARIO 2: DYNAMIC GRADIENT VIRAL REELS SUBTITLE GENERATION
 * ════════════════════════════════════════════════════════════════════════════ */

test('Scenario 2: Viral TikTok/Reels caption styling with 1-word pop & custom hex gradient', () => {
  const viralScript = [
    { text: 'Never', start: 0.0, end: 0.25 },
    { text: 'stop', start: 0.25, end: 0.5 },
    { text: 'building', start: 0.5, end: 0.8, emoji: '🚀' },
    { text: 'your', start: 0.8, end: 1.05 },
    { text: 'dream', start: 1.05, end: 1.4, emoji: '✨' },
  ];

  const viralSettings = {
    preset: 'custom',
    style: {
      fontSize: 96,
      textCase: 'upper',
      color: '#ffffff',
      gradient: true,
      gradientColor: '#ff007f', // Custom pasteable neon pink
      activeGlow: true,
      activeGlowColor: '#00ffff',
      activeGlowBlur: 20,
      emojiEnabled: true,
      emojiPlacement: 'inline',
    },
    motion: {
      preset: 'pop',
      duration: 0.2,
      intensity: 1.2,
      highlight: 'color',
    },
    grouping: { maxWords: 1 }, // 1-word pop cadence
  };

  const scene = M.buildScene(viralScript, viralSettings, env());
  assert.equal(scene.captions.length, 5, '1-word pop cadence must yield exactly 5 captions');

  // Verify uppercase transformation and emoji inlining
  const rocketWord = scene.captions[2].lines[0].words[0];
  assert.equal(rocketWord.text, 'BUILDING 🚀');

  // Verify animation state at word onset (t=0.55s)
  const wordCap = scene.captions[2];
  const animState = M.wordState(0.55, rocketWord, wordCap, viralSettings.motion, 96);
  assert.ok(animState.alpha > 0);
  assert.ok(animState.scale >= 0.6);

  // Render to canvas
  const browser = createBrowserEnvironment();
  const canvas = browser.document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  R.drawFrame(ctx, scene, viralSettings, 0.55, { scale: 1 });

  const fillCalls = ctx._drawCalls.filter((c) => c.type === 'fillText');
  assert.ok(fillCalls.length > 0);
});

/* ════════════════════════════════════════════════════════════════════════════
 * REAL-WORLD SCENARIO 3: FULL TRANSPARENT VIDEO OVERLAY EXPORT PIPELINE
 * ════════════════════════════════════════════════════════════════════════════ */

test('Scenario 3: Video overlay export simulation with frameKey caching and timing precision', () => {
  const words = [
    { text: 'Mastering', start: 0.0, end: 0.4 },
    { text: 'video', start: 0.4, end: 0.7 },
    { text: 'editing', start: 0.7, end: 1.1 },
    { text: 'automation', start: 1.1, end: 1.6 },
  ];

  const exportSettings = {
    style: {
      fontSize: 80,
      color: '#ffffff',
      shadow: true,
      shadowColor: '#000000',
    },
    timing: { exit: 'fade', exitDuration: 0.08, minDuration: 0.6 },
    output: { codec: 'prores' },
  };

  const fps = { num: 30, den: 1 };
  const scene = M.buildScene(words, exportSettings, env({ fps }));

  const totalDuration = scene.duration;
  assert.ok(totalDuration > 1.6);
  const totalFrames = M.frameCount(totalDuration, fps);
  assert.ok(totalFrames >= 48);

  const browser = createBrowserEnvironment();
  const cv = browser.document.createElement('canvas');
  const ctx = cv.getContext('2d');

  let renderedFrames = 0;
  let cachedFrames = 0;
  let lastKey = null;

  for (let k = 0; k < totalFrames; k++) {
    const t = M.frameTime(k, fps);
    const key = M.frameKey(scene, t, exportSettings.motion);

    if (key && key === lastKey) {
      // Repeat static frame: skip canvas draw
      cachedFrames++;
    } else {
      // Dynamic frame: perform canvas drawFrame
      ctx._drawCalls = [];
      R.drawFrame(ctx, scene, exportSettings, t, { scale: 1 });
      renderedFrames++;
      lastKey = key;
    }
  }

  // In video overlays, static holds must result in cached repeat frames
  assert.ok(cachedFrames > 0, `Expected cached static frames, got ${cachedFrames} cached vs ${renderedFrames} rendered`);
  assert.equal(renderedFrames + cachedFrames, totalFrames);
});
