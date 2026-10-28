/**
 * tests/challenger-m1-toggle-stability.test.js
 *
 * EMPIRICAL ADVERSARIAL CHALLENGER 2 TEST SUITE
 * Milestone 1: UI Toggle Stability & Preview Resilience
 *
 * Strictly validates:
 * 1. updateSubControls() edge cases & matrix resilience
 * 2. In-place toggle updates without re-executing renderBody()
 * 3. Preview collapse button and visual class transitions
 * 4. CSS stylesheet rule integrity
 * 5. Canvas 2D renderer defense against malformed styling parameters
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createBrowserEnvironment } = require('./e2e/harness');
const { loadEsm } = require('./_load-esm');

const CAPTIONS_VIEW_PATH = path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions-view.js');
const CSS_PATH = path.resolve(__dirname, '..', 'cep-panel', 'client', 'styles', 'captions.css');
const MODEL_PATH = path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions', 'model.js');
const RENDER_PATH = path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions', 'render.js');

const M = loadEsm(MODEL_PATH);
const R = loadEsm(RENDER_PATH, M);

function setupCaptionsModule() {
  const env = createBrowserEnvironment();
  const globalNames = {
    window: env.window,
    document: env.document,
    localStorage: env.localStorage,
    ResizeObserver: env.window.ResizeObserver,
    requestAnimationFrame: env.window.requestAnimationFrame,
    cancelAnimationFrame: env.window.cancelAnimationFrame,
  };

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
      updateSubControls,
      onSetting,
      ensureContainer,
      loadSettings,
      onBoundInput,
      layoutPreview,
      updatePreviewToggleBtn,
      onAction,
      tabStyle,
      setWords,
    };
  `;

  const fn = new Function('deps', 'with(deps) {\n' + src + '\n' + exposedReturn + '\n}');

  const deps = Object.assign({}, globalNames, {
    apiGet: async () => ({}),
    apiPost: async () => ({}),
    apiUpload: async () => ({}),
    getBaseUrl: () => '',
    isExtendScriptAvailable: () => false,
    callExtendScript: async () => ({}),
    M,
    drawFrame: R.drawFrame,
    STYLE_DEFAULTS: R.STYLE_DEFAULTS,
    BUNDLED: [],
    ensureFont: async () => {},
    makeMeasurer: () => () => 50,
    listSystemFonts: async () => [],
    injectFontStyles: () => {},
    weightName: () => '',
    PRESETS: [],
    findPreset: () => null,
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
  return { env, mod, deps };
}

/* ════════════════════════════════════════════════════════════════════════════
 * SUITE 1: updateSubControls() EDGE CASES & MATRIX COVERAGE
 * ════════════════════════════════════════════════════════════════════════════ */

test('CHALLENGE 1.1: updateSubControls handles invalid and boundary inputs without throwing', () => {
  const { mod } = setupCaptionsModule();

  // Test with undefined, null, empty string, arbitrary paths, non-strings
  assert.doesNotThrow(() => mod.updateSubControls(undefined));
  assert.doesNotThrow(() => mod.updateSubControls(null));
  assert.doesNotThrow(() => mod.updateSubControls(''));
  assert.doesNotThrow(() => mod.updateSubControls('nonexistent.path'));
  assert.doesNotThrow(() => mod.updateSubControls(12345));
  assert.doesNotThrow(() => mod.updateSubControls({}));

  // Test when S.settings is null or undefined
  const origSettings = mod.S.settings;
  mod.S.settings = null;
  assert.doesNotThrow(() => mod.updateSubControls('style.gradient'));
  assert.doesNotThrow(() => mod.updateSubControls());

  mod.S.settings = undefined;
  assert.doesNotThrow(() => mod.updateSubControls('style.gradient'));
  assert.doesNotThrow(() => mod.updateSubControls());

  // Test when sub-objects are null or missing
  mod.S.settings = {};
  assert.doesNotThrow(() => mod.updateSubControls('style.gradient'));
  assert.doesNotThrow(() => mod.updateSubControls());

  mod.S.settings = origSettings;
});

test('CHALLENGE 1.2: updateSubControls toggles all 11 subcontrol wrappers accurately', () => {
  const { env, mod } = setupCaptionsModule();

  // Create containers for all 11 sub-controls
  const wrappers = {
    gradient: env.document.createElement('div'),
    glow: env.document.createElement('div'),
    speaker: env.document.createElement('div'),
    shadow: env.document.createElement('div'),
    emoji: env.document.createElement('div'),
    bg: env.document.createElement('div'),
    emphasis: env.document.createElement('div'),
    punct: env.document.createElement('div'),
    hlBox: env.document.createElement('div'),
    hlColor: env.document.createElement('div'),
    exitFade: env.document.createElement('div'),
  };

  wrappers.gradient.className = 'cc-gradient-sub cc-sub-ctls hidden';
  wrappers.glow.className = 'cc-glow-sub cc-sub-ctls hidden';
  wrappers.speaker.className = 'cc-speaker-sub cc-sub-ctls hidden';
  wrappers.shadow.className = 'cc-shadow-sub cc-sub-ctls hidden';
  wrappers.emoji.className = 'cc-emoji-sub cc-sub-ctls hidden';
  wrappers.bg.className = 'cc-bg-sub cc-sub-ctls hidden';
  wrappers.emphasis.className = 'cc-emphasis-sub cc-sub-ctls hidden';
  wrappers.punct.className = 'cc-punct-sub cc-sub-ctls hidden';
  wrappers.hlBox.className = 'cc-hl-box-sub cc-sub-ctls hidden';
  wrappers.hlColor.className = 'cc-hl-color-sub cc-sub-ctls hidden';
  wrappers.exitFade.className = 'cc-exit-fade-sub cc-sub-ctls hidden';

  for (const el of Object.values(wrappers)) env.root.appendChild(el);

  // 1. Gradient
  mod.S.settings.style.gradient = true;
  mod.updateSubControls('style.gradient');
  assert.equal(wrappers.gradient.classList.contains('hidden'), false, 'gradient=true removes hidden');
  mod.S.settings.style.gradient = false;
  mod.updateSubControls('style.gradient');
  assert.equal(wrappers.gradient.classList.contains('hidden'), true, 'gradient=false adds hidden');

  // 2. Active Glow
  mod.S.settings.style.activeGlow = true;
  mod.updateSubControls('style.activeGlow');
  assert.equal(wrappers.glow.classList.contains('hidden'), false, 'activeGlow=true removes hidden');
  mod.S.settings.style.activeGlow = false;
  mod.updateSubControls('style.activeGlow');
  assert.equal(wrappers.glow.classList.contains('hidden'), true, 'activeGlow=false adds hidden');

  // 3. Speaker Coloring
  mod.S.settings.style.speakerColoring = true;
  mod.updateSubControls('style.speakerColoring');
  assert.equal(wrappers.speaker.classList.contains('hidden'), false, 'speakerColoring=true removes hidden');
  mod.S.settings.style.speakerColoring = false;
  mod.updateSubControls('style.speakerColoring');
  assert.equal(wrappers.speaker.classList.contains('hidden'), true, 'speakerColoring=false adds hidden');

  // 4. Shadow
  mod.S.settings.style.shadow = true;
  mod.updateSubControls('style.shadow');
  assert.equal(wrappers.shadow.classList.contains('hidden'), false, 'shadow=true removes hidden');
  mod.S.settings.style.shadow = false;
  mod.updateSubControls('style.shadow');
  assert.equal(wrappers.shadow.classList.contains('hidden'), true, 'shadow=false adds hidden');

  // 5. Emoji Enabled
  mod.S.settings.style.emojiEnabled = true;
  mod.updateSubControls('style.emojiEnabled');
  assert.equal(wrappers.emoji.classList.contains('hidden'), false, 'emojiEnabled=true removes hidden');
  mod.S.settings.style.emojiEnabled = false;
  mod.updateSubControls('style.emojiEnabled');
  assert.equal(wrappers.emoji.classList.contains('hidden'), true, 'emojiEnabled=false adds hidden');

  // 6. Background
  mod.S.settings.style.background = 'box';
  mod.updateSubControls('style.background');
  assert.equal(wrappers.bg.classList.contains('hidden'), false, 'background=box removes hidden');
  mod.S.settings.style.background = 'none';
  mod.updateSubControls('style.background');
  assert.equal(wrappers.bg.classList.contains('hidden'), true, 'background=none adds hidden');

  // 7. Emphasis (reveals pill controls when != 'color')
  mod.S.settings.style.emphasis = 'pill';
  mod.updateSubControls('style.emphasis');
  assert.equal(wrappers.emphasis.classList.contains('hidden'), false, 'emphasis=pill removes hidden');
  mod.S.settings.style.emphasis = 'both';
  mod.updateSubControls('style.emphasis');
  assert.equal(wrappers.emphasis.classList.contains('hidden'), false, 'emphasis=both removes hidden');
  mod.S.settings.style.emphasis = 'color';
  mod.updateSubControls('style.emphasis');
  assert.equal(wrappers.emphasis.classList.contains('hidden'), true, 'emphasis=color adds hidden');

  // 8. Punctuation
  mod.S.settings.style.punctuation = 'custom';
  mod.updateSubControls('style.punctuation');
  assert.equal(wrappers.punct.classList.contains('hidden'), false, 'punctuation=custom removes hidden');
  mod.S.settings.style.punctuation = 'clean';
  mod.updateSubControls('style.punctuation');
  assert.equal(wrappers.punct.classList.contains('hidden'), true, 'punctuation=clean adds hidden');

  // 9. Highlight Box vs Color
  mod.S.settings.motion.highlight = 'box';
  mod.updateSubControls('motion.highlight');
  assert.equal(wrappers.hlBox.classList.contains('hidden'), false, 'highlight=box removes hidden on hlBox');
  assert.equal(wrappers.hlColor.classList.contains('hidden'), true, 'highlight=box adds hidden on hlColor');

  mod.S.settings.motion.highlight = 'color';
  mod.updateSubControls('motion.highlight');
  assert.equal(wrappers.hlBox.classList.contains('hidden'), true, 'highlight=color adds hidden on hlBox');
  assert.equal(wrappers.hlColor.classList.contains('hidden'), false, 'highlight=color removes hidden on hlColor');

  // 10. Exit Fade
  mod.S.settings.timing.exit = 'fade';
  mod.updateSubControls('timing.exit');
  assert.equal(wrappers.exitFade.classList.contains('hidden'), false, 'exit=fade removes hidden');
  mod.S.settings.timing.exit = 'cut';
  mod.updateSubControls('timing.exit');
  assert.equal(wrappers.exitFade.classList.contains('hidden'), true, 'exit=cut adds hidden');

  // 11. Batch update (!path)
  mod.S.settings.style.gradient = true;
  mod.S.settings.style.shadow = true;
  mod.S.settings.style.background = 'pills';
  mod.updateSubControls(); // batch
  assert.equal(wrappers.gradient.classList.contains('hidden'), false);
  assert.equal(wrappers.shadow.classList.contains('hidden'), false);
  assert.equal(wrappers.bg.classList.contains('hidden'), false);
});

/* ════════════════════════════════════════════════════════════════════════════
 * SUITE 2: IN-PLACE TOGGLE UPDATES & ZERO RENDERBODY RE-EXECUTION
 * ════════════════════════════════════════════════════════════════════════════ */

test('CHALLENGE 2.1: STRUCTURAL table strictly excludes style toggles and maxLines', () => {
  const { mod } = setupCaptionsModule();

  // Only previewAspect should be in STRUCTURAL
  assert.equal(mod.STRUCTURAL['grouping.maxLines'], undefined, 'grouping.maxLines must NOT be structural');
  assert.equal(mod.STRUCTURAL['style.gradient'], undefined, 'style.gradient must NOT be structural');
  assert.equal(mod.STRUCTURAL['style.shadow'], undefined, 'style.shadow must NOT be structural');
  assert.equal(mod.STRUCTURAL['style.activeGlow'], undefined, 'style.activeGlow must NOT be structural');
  assert.equal(mod.STRUCTURAL['style.speakerColoring'], undefined, 'style.speakerColoring must NOT be structural');
  assert.equal(mod.STRUCTURAL['style.emojiEnabled'], undefined, 'style.emojiEnabled must NOT be structural');
  assert.equal(mod.STRUCTURAL.previewAspect, 1, 'previewAspect remains structural');
});

test('CHALLENGE 2.2: Toggling style switches does NOT re-execute renderBody() or destroy body DOM', () => {
  const { env, mod } = setupCaptionsModule();

  mod.renderShell();
  mod.S.tab = 'style';
  mod.renderBody();

  const bodyEl = env.document.getElementById('cc-body');
  assert.ok(bodyEl, '#cc-body must exist');

  // Plant a sentinel element inside #cc-body to detect if inner DOM is destroyed
  const sentinel = env.document.createElement('div');
  sentinel.id = 'test-sentinel-marker';
  sentinel.textContent = 'PreserveMe';
  bodyEl.appendChild(sentinel);

  let renderBodyCalls = 0;
  const originalRenderBody = mod.renderBody;
  mod.renderBody = () => {
    renderBodyCalls++;
    return originalRenderBody();
  };

  // Test all styling switches: sentinel must survive every one of them!
  const togglesToTest = [
    'style.gradient',
    'style.shadow',
    'style.activeGlow',
    'style.speakerColoring',
    'style.emojiEnabled',
    'style.background',
    'style.emphasis',
    'style.punctuation',
    'grouping.maxLines',
    'motion.highlight',
    'timing.exit',
  ];

  for (const pathKey of togglesToTest) {
    mod.onSetting(pathKey);
    assert.ok(
      env.document.getElementById('test-sentinel-marker'),
      `Sentinel in #cc-body must survive onSetting('${pathKey}') (proves renderBody was not called)`
    );
  }

  // Confirm that genuine structural settings DO call renderBody (sentinel gets wiped)
  mod.onSetting('style.fontFamily');
  assert.equal(
    env.document.getElementById('test-sentinel-marker'),
    null,
    'fontFamily changes must call renderBody to rebuild weight options, wiping old DOM'
  );

  // Plant a new sentinel to test previewAspect
  const sentinel2 = env.document.createElement('div');
  sentinel2.id = 'test-sentinel-marker-2';
  env.document.getElementById('cc-body').appendChild(sentinel2);

  mod.onSetting('previewAspect');
  assert.equal(
    env.document.getElementById('test-sentinel-marker-2'),
    null,
    'previewAspect must call renderBody, wiping old DOM'
  );
});

/* ════════════════════════════════════════════════════════════════════════════
 * SUITE 3: PREVIEW PANEL COLLAPSE BUTTON & VISUAL CLASS TRANSITIONS
 * ════════════════════════════════════════════════════════════════════════════ */

test('CHALLENGE 3.1: Preview collapse button cleanly toggles visual classes without adding .hidden', () => {
  const { env, mod } = setupCaptionsModule();

  mod.renderShell();
  const stage = env.document.getElementById('cc-stage');
  const resizer = env.document.getElementById('cc-stage-resizer');
  const toggleBtn = env.document.querySelector('[data-act="toggle-preview"]');

  assert.ok(stage, '#cc-stage must exist');
  assert.ok(toggleBtn, 'toggle-preview button must exist');

  // Initial state: previewOpen is true
  assert.equal(mod.S.previewOpen, true);
  assert.equal(stage.classList.contains('cc-stage-collapsed'), false, 'initial: not collapsed');
  assert.equal(stage.classList.contains('hidden'), false, 'initial: no hidden class');
  assert.equal(toggleBtn.classList.contains('cc-on'), false, 'initial: button cc-on is false');
  assert.equal(toggleBtn.title || toggleBtn.getAttribute('title'), 'Hide preview');

  // Action 1: Collapse preview
  mod.onAction('toggle-preview');
  assert.equal(mod.S.previewOpen, false);
  assert.equal(stage.classList.contains('cc-stage-collapsed'), true, 'collapsed: has cc-stage-collapsed');
  assert.equal(stage.classList.contains('hidden'), false, 'collapsed: MUST NOT HAVE .hidden (uses transition)');
  assert.equal(stage.style.height, '0px', 'collapsed: height is 0px');
  assert.equal(resizer.classList.contains('hidden'), true, 'collapsed: resizer is hidden');
  assert.equal(toggleBtn.classList.contains('cc-on'), true, 'collapsed: button has cc-on');
  assert.equal(toggleBtn.title, 'Show preview');

  // Action 2: Expand preview
  mod.onAction('toggle-preview');
  assert.equal(mod.S.previewOpen, true);
  assert.equal(stage.classList.contains('cc-stage-collapsed'), false, 'expanded: cc-stage-collapsed removed');
  assert.equal(stage.classList.contains('hidden'), false, 'expanded: no hidden class');
  const restoredH = parseInt(stage.style.height, 10);
  assert.ok(restoredH >= 90, `expanded: height must be >= 90px (got ${restoredH}px)`);
  assert.equal(resizer.classList.contains('hidden'), false, 'expanded: resizer not hidden');
  assert.equal(toggleBtn.classList.contains('cc-on'), false, 'expanded: button loses cc-on');
  assert.equal(toggleBtn.title, 'Hide preview');
});

test('CHALLENGE 3.2: Rapid 100-cycle preview collapse storm maintains strict invariant parity', () => {
  const { env, mod } = setupCaptionsModule();
  mod.renderShell();
  const stage = env.document.getElementById('cc-stage');
  const toggleBtn = env.document.querySelector('[data-act="toggle-preview"]');

  for (let i = 0; i < 100; i++) {
    mod.onAction('toggle-preview');
    const isCollapsed = !mod.S.previewOpen;
    assert.equal(stage.classList.contains('cc-stage-collapsed'), isCollapsed);
    assert.equal(stage.classList.contains('hidden'), false);
    assert.equal(toggleBtn.classList.contains('cc-on'), isCollapsed);
  }

  // After 100 toggles, state is back to previewOpen = true
  assert.equal(mod.S.previewOpen, true);
  assert.equal(stage.classList.contains('cc-stage-collapsed'), false);
  assert.equal(toggleBtn.classList.contains('cc-on'), false);
});

test('CHALLENGE 3.3: Preview height edge cases and bounds clamping', () => {
  const { env, mod } = setupCaptionsModule();
  mod.renderShell();
  const stage = env.document.getElementById('cc-stage');

  // Case 1: user height is negative or zero
  mod.S.previewHeight = -200;
  mod.layoutPreview();
  assert.ok(parseInt(stage.style.height, 10) >= 90, 'negative user height falls back to valid default >= 90');

  // Case 2: user height is too small (<80)
  mod.S.previewHeight = 40;
  mod.layoutPreview();
  assert.ok(parseInt(stage.style.height, 10) >= 90, 'tiny user height (<80) falls back to valid default >= 90');

  // Case 3: user height is NaN or string
  mod.S.previewHeight = 'invalid_size';
  mod.layoutPreview();
  assert.ok(parseInt(stage.style.height, 10) >= 90, 'invalid string height falls back safely');

  // Case 4: user height is huge (should be clamped to rootH * 0.78)
  mod.S.previewHeight = 99999;
  mod.layoutPreview();
  const clampedH = parseInt(stage.style.height, 10);
  assert.ok(clampedH <= 600 * 0.78 + 5, 'giant height clamped to root ceiling');
});

/* ════════════════════════════════════════════════════════════════════════════
 * SUITE 4: CSS STYLESHEET INTEGRITY & CONFORMANCE
 * ════════════════════════════════════════════════════════════════════════════ */

test('CHALLENGE 4.1: captions.css defines required smooth transitions and collapse rules', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');

  // Check .cc-stage has transition properties
  assert.match(css, /\.cc-stage\s*\{[^}]*transition:[^}]*\}/, '.cc-stage must specify transition');
  assert.match(css, /\.cc-stage\s*\{[^}]*box-sizing:\s*border-box/, '.cc-stage must have box-sizing');

  // Check .cc-stage.cc-stage-collapsed has strict zero dimensions and opacity
  assert.match(css, /\.cc-stage\.cc-stage-collapsed\s*\{[^}]*height:\s*0\s*!important/, 'collapsed must force height: 0 !important');
  assert.match(css, /\.cc-stage\.cc-stage-collapsed\s*\{[^}]*min-height:\s*0\s*!important/, 'collapsed must force min-height: 0 !important');
  assert.match(css, /\.cc-stage\.cc-stage-collapsed\s*\{[^}]*opacity:\s*0/, 'collapsed must specify opacity: 0');
  assert.match(css, /\.cc-stage\.cc-stage-collapsed\s*\{[^}]*overflow:\s*hidden\s*!important/, 'collapsed must specify overflow: hidden !important');

  // Check .cc-sub-ctls has dark theme styling and flex column
  assert.match(css, /\.cc-sub-ctls\s*\{[^}]*display:\s*flex/, '.cc-sub-ctls must specify display: flex');
  assert.match(css, /\.cc-sub-ctls\s*\{[^}]*flex-direction:\s*column/, '.cc-sub-ctls must specify flex-direction: column');
  assert.match(css, /\.cc-sub-ctls\s*\{[^}]*border-left:/, '.cc-sub-ctls must specify border-left accent');
});

/* ════════════════════════════════════════════════════════════════════════════
 * SUITE 5: CANVAS 2D RENDERER DEFENSIVE CHECKS & COLOR SANITIZATION
 * ════════════════════════════════════════════════════════════════════════════ */

test('CHALLENGE 5.1: sanitizeColor handles all valid color representations and rejects malformed inputs', () => {
  // Valid standard hex
  assert.equal(R.sanitizeColor('#ffffff'), '#ffffff');
  assert.equal(R.sanitizeColor('#3b82f6'), '#3b82f6');
  // Unhashed hex
  assert.equal(R.sanitizeColor('3b82f6'), '#3b82f6');
  assert.equal(R.sanitizeColor('fff'), '#fff');
  // 4-digit / 8-digit hex
  assert.equal(R.sanitizeColor('#ffff'), '#ffff');
  assert.equal(R.sanitizeColor('ffff'), '#ffff');
  assert.equal(R.sanitizeColor('#3b82f680'), '#3b82f680');
  // RGB and RGBA
  assert.equal(R.sanitizeColor('rgb(255, 0, 128)'), 'rgb(255, 0, 128)');
  assert.equal(R.sanitizeColor('rgba(10, 20, 30, 0.5)'), 'rgba(10, 20, 30, 0.5)');
  // HSL and HSLA
  assert.equal(R.sanitizeColor('hsl(120, 100%, 50%)'), 'hsl(120, 100%, 50%)');
  // Named CSS colors
  assert.equal(R.sanitizeColor('transparent'), 'transparent');
  assert.equal(R.sanitizeColor('white'), 'white');
  assert.equal(R.sanitizeColor('red'), 'red');

  // Malformed / malicious / invalid values -> safely returns fallback
  assert.equal(R.sanitizeColor('', '#000000'), '#000000');
  assert.equal(R.sanitizeColor('   ', '#000000'), '#000000');
  assert.equal(R.sanitizeColor('invalid_color!@#', '#000000'), '#000000');
  assert.equal(R.sanitizeColor('<script>alert(1)</script>', '#000000'), '#000000');
  assert.equal(R.sanitizeColor('url(bad)', '#000000'), '#000000');
  assert.equal(R.sanitizeColor(null, '#000000'), '#000000');
  assert.equal(R.sanitizeColor(undefined, '#000000'), '#000000');
  assert.equal(R.sanitizeColor(12345, '#000000'), '#000000');
  assert.equal(R.sanitizeColor({}, '#000000'), '#000000');
});

test('CHALLENGE 5.2: rgba() helper bounds check prevents NaN or out-of-bounds alpha', () => {
  assert.equal(R.rgba('#ffffff', 0.5), 'rgba(255,255,255,0.5)');
  assert.equal(R.rgba('#ffffff', undefined), 'rgba(255,255,255,1)');
  assert.equal(R.rgba('#ffffff', NaN), 'rgba(255,255,255,1)');
  assert.equal(R.rgba('#ffffff', 'invalid'), 'rgba(255,255,255,1)');
  assert.equal(R.rgba('#ffffff', -5), 'rgba(255,255,255,0)');
  assert.equal(R.rgba('#ffffff', 10), 'rgba(255,255,255,1)');
  assert.equal(R.rgba('#ffffff', null), 'rgba(255,255,255,0)');
});

test('CHALLENGE 5.3: drawFrame does not throw on zero-height gradient, malformed colors, or missing metrics', () => {
  const browser = createBrowserEnvironment();
  const cv = browser.document.createElement('canvas');
  const ctx = cv.getContext('2d');

  const scene = {
    captions: [{
      tIn: 0,
      tOut: 2,
      lines: [{
        w: 200,
        words: [{
          text: 'ResilienceTest',
          x: 100,
          w: 200,
          t0: 0,
          t1: 1,
          speaker: 0,
          emphasis: true,
        }],
      }],
      box: { x: 50, y: 100, w: 300, h: 80, asc: 0, desc: 0 }, // ZERO asc/desc
    }],
    width: 1080,
    height: 1920,
  };

  const st = Object.assign({}, R.STYLE_DEFAULTS, {
    gradient: true,
    gradientColor: 'bad_gradient_value!@#$',
    shadow: true,
    shadowColor: 'bad_shadow!@#$',
    shadowBlur: 'not_a_num',
    strokeWidth: 'invalid_stroke',
    activeGlow: true,
    activeGlowColor: 'malformed_glow',
    activeGlowBlur: -10,
    speakerColoring: true,
    speakerColors: ['invalid_spk1', 'invalid_spk2'],
  });

  assert.doesNotThrow(() => {
    R.drawFrame(ctx, scene, { style: st, motion: { preset: 'none' }, timing: {} }, 0.5, { scale: 1 });
  }, 'Renderer must not throw DOMException on malformed gradient/shadow parameters');
});
