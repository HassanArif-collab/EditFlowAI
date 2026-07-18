/**
 * captions-view.js — Tabbed animated caption UI for EditFlow AE.
 *
 * Workflow:
 *   1. Open a comp with audio in After Effects.
 *   2. Tab 1 (Transcribe): pick source — comp audio (with mixdown fallback),
 *      upload a file, or paste SRT/JSON transcript.
 *   3. Backend runs Whisper → word-level timestamps.
 *   4. Tab 2 (Content): edit words, toggle 💊 per word for pill backgrounds.
 *      Adjacent pills merge into one. Segment settings control grouping.
 *   5. Tab 3 (Style): font, size, colors, outline, shadow, pill background,
 *      position, UPPERCASE.
 *   6. Tab 4 (Animate): preset, word easing/duration/slide, pill easing/scale
 *      duration, plus a mini text preview.
 *   7. Tab 5 (Generate): clear existing, smoke test (3 words), generate all,
 *      result summary.
 *
 * All caption layers are NATIVE AE text (no MOGRTs) — fully editable.
 *
 * UI structure (matches the prototype):
 *   ┌────────────────────────────────────┐
 *   │ Header  (logo · whisper status · ⚙ ✕) │  fixed
 *   │ Preview (16:9 canvas + play/seek)  │  fixed
 *   │ Tab Bar  (5 tabs with SVG icons)   │  fixed
 *   │ ─────────────────────────────────  │
 *   │ Content Area (scrolls per active tab) │
 *   └────────────────────────────────────┘
 */
import { apiGet, apiPost, apiUpload, getBaseUrl } from './api.js';
import { callExtendScript, isExtendScriptAvailable } from './extendscript.js';
import { groupWords, wrapLines, wordAnim, captionTiming, EASINGS, LAYOUT } from './caption-model.js';

const $ = (sel) => document.querySelector(sel);

const LANGUAGES = [
  ['auto', 'Auto Detect'], ['en', 'English'], ['ur', 'Urdu'], ['hi', 'Hindi'],
  ['ar', 'Arabic'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'],
  ['zh', 'Chinese'], ['ja', 'Japanese'],
];
const PRESETS = [
  ['fadeup_words', 'Fade Up Words'],
  ['popin', 'Pop-in (Hormozi)'],
  ['fadeup', 'Fade Up'],
  ['bounce', 'Bounce'],
  ['squash', 'Squash & Stretch'],
  ['typewriter', 'Typewriter'],
  ['fade', 'Simple Fade'],
];
const EASING_OPTIONS = [
  ['linear', 'Linear'],
  ['ease_in', 'Ease In'],
  ['ease_out', 'Ease Out'],
  ['ease_in_out', 'Ease In-Out'],
];
const TABS = [
  { num: 1, label: 'Transcribe', icon: '<path d="M12 2v8M8 6l4-4 4 4M5 12h14M7 12v8M17 12v8"/>' },
  { num: 2, label: 'Content',    icon: '<path d="M4 6h16M4 12h16M4 18h10"/>' },
  { num: 3, label: 'Style',      icon: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="9" r="1.5"/><circle cx="16" cy="9" r="1.5"/><circle cx="8" cy="15" r="1.5"/><circle cx="16" cy="15" r="1.5"/>' },
  { num: 4, label: 'Animate',    icon: '<path d="M12 3l1.5 5L19 9.5 13.5 11 12 16 10.5 11 5 9.5 10.5 8z"/>' },
  { num: 5, label: 'Generate',   icon: '<path d="M5 13l4 4L19 7"/>' },
];

/* ── State ── */
const S = {
  // Existing fields (preserved from prior version)
  words: [], duration: 0, modelName: '', modelInstalled: false,
  compInfo: null, audioOffset: 0, busy: false, error: null, status: null,
  progress: 0, generateResult: null,
  visualStyle: 'floating', fontPS: 'Arial-BoldMT', fontSize: 80,
  fillColor: [1, 1, 1], strokeColor: [0, 0, 0], strokeWidth: 0,
  dropShadow: true, shadowColor: [0, 0, 0], shadowOpacity: 50, shadowDistance: 3, shadowBlur: 5,
  pillColor: [0.04, 0.1, 0.18], pillOpacity: 85, pillStrokeColor: [0.36, 0.55, 0.94], pillStrokeWidth: 2, pillRadius: 0.5,
  highlightTextColor: [1, 1, 0], highlightBoxColor: [0.04, 0.1, 0.18], highlightWords: [],
  posX: 50, posY: 80, maxWordsPerSegment: 4, maxCharsPerSegment: 30, maxDurationPerSegment: 3, maxLinesPerSegment: 2, allCaps: false,
  boxWidthPct: 90, alignEngine: 'auto', customVocab: '',
  preset: 'fadeup_words', animIntensity: 1.0, language: 'auto',
  overlapFrames: 2, minDisplayDur: 0.7,
  _previewTime: 0, _previewPlaying: false, _canvas: null, _ctx: null, _raf: null,
  previewHeight: 240, _resizing: false, _resizeStartY: 0, _resizeStartH: 0,
  fonts: [], _fontsLoaded: false, _showPaste: false, _pasteText: '',
  // New fields for tabbed UI + per-word pill animation
  activeTab: 0,
  wordEasing: 'ease_in_out', fadeDur: 0.5, slideDist: 50,
  pillEasing: 'ease_in_out', pillScaleDur: 0.5,
  _presets: {}, _activePreset: '',
  // Captured AE playhead frame (shown as preview background until hidden)
  compFrameUrl: null, compFrameTime: null, compFrameCompName: null,
};
let _refreshInterval = null;
let _persistTimer = null;
let _wsClientId = 'ae-captions';   // set by main.js so it matches the WebSocket id

/* Settings that persist across reloads and make up a named preset. */
const SETTINGS_KEYS = [
  'visualStyle', 'fontPS', 'fontSize', 'fillColor', 'strokeColor', 'strokeWidth',
  'dropShadow', 'shadowColor', 'shadowOpacity', 'shadowDistance', 'shadowBlur',
  'pillColor', 'pillOpacity', 'pillStrokeColor', 'pillStrokeWidth', 'pillRadius',
  'highlightTextColor', 'posX', 'posY', 'maxWordsPerSegment', 'maxCharsPerSegment',
  'maxDurationPerSegment', 'maxLinesPerSegment', 'allCaps', 'preset', 'animIntensity', 'language',
  'wordEasing', 'fadeDur', 'slideDist', 'pillEasing', 'pillScaleDur',
  'overlapFrames', 'minDisplayDur', 'boxWidthPct', 'alignEngine', 'customVocab',
  'previewHeight',
];
const BUILTIN_PRESETS = {
  'Clean Fade-Up': { preset: 'fadeup_words', wordEasing: 'ease_out', fadeDur: 0.35, slideDist: 40, allCaps: false, fillColor: [1, 1, 1], strokeWidth: 0, dropShadow: true, fontSize: 80 },
  'Hormozi Pop':   { preset: 'popin', allCaps: true, fillColor: [1, 1, 1], strokeColor: [0, 0, 0], strokeWidth: 6, dropShadow: true, fontSize: 90, highlightTextColor: [1, 0.85, 0] },
  'Bounce In':     { preset: 'bounce', allCaps: false, dropShadow: true, fontSize: 84 },
  'Typewriter':    { preset: 'typewriter', allCaps: false, dropShadow: false, fontSize: 70 },
  'Minimal Fade':  { preset: 'fade', allCaps: false, fadeDur: 0.25, dropShadow: false, strokeWidth: 0 },
};
function _snapshotSettings() {
  const o = {};
  for (const k of SETTINGS_KEYS) o[k] = S[k];
  return JSON.parse(JSON.stringify(o));
}
function _applySettings(obj) {
  if (!obj) return;
  for (const k of SETTINGS_KEYS) if (obj[k] !== undefined) S[k] = JSON.parse(JSON.stringify(obj[k]));
}
function _persistSoon() {
  clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    try { localStorage.editflow_ae_settings = JSON.stringify(_snapshotSettings()); } catch (_) {}
  }, 400);
}
function _loadPersisted() {
  try { _applySettings(JSON.parse(localStorage.editflow_ae_settings || 'null')); } catch (_) {}
  // Max Lines used to go up to 5 but never did anything; now it's real (1-2).
  S.maxLinesPerSegment = Math.min(2, Math.max(1, S.maxLinesPerSegment || 1));
  try { S._presets = JSON.parse(localStorage.editflow_ae_presets || '{}') || {}; } catch (_) { S._presets = {}; }
  try { S._activePreset = localStorage.editflow_ae_active_preset || ''; } catch (_) {}
}
function _savePresets() {
  try {
    localStorage.editflow_ae_presets = JSON.stringify(S._presets);
    localStorage.editflow_ae_active_preset = S._activePreset;
  } catch (_) {}
}

/* ── Public API ── */
function openCaptions() {
  _loadPersisted();
  _devCompOverride();
  _ensureStyles();
  _ensureContainer();
  _render();
  _setupResizeDrag();
  _refreshModelStatus();
  _refreshCompInfo();
  _loadFonts();
  if (_refreshInterval) clearInterval(_refreshInterval);
  _refreshInterval = setInterval(() => {
    const el = $('#captions-view');
    if (!el || el.classList.contains('hidden') || document.hidden) return;
    // Don't poll while busy (transcription/generation blocks the backend)
    if (S.busy) return;
    _refreshModelStatus();
    _refreshCompInfo();
  }, 30000); // 30s — less flickering, skip during busy
}

/* Browser-only test hook: '#comp=1080x1920' fakes a comp so the preview can
   be verified at any aspect ratio without After Effects. Real users never type
   this hash; when present it also pins comp info so the poll can't clobber it. */
function _devCompOverride() {
  try {
    const m = (location.hash || '').match(/comp=(\d+)x(\d+)/);
    if (m) {
      S._devComp = true;
      S.compInfo = {
        name: `DEV ${m[1]}×${m[2]}`, width: +m[1], height: +m[2],
        duration: 60, frameRate: 30, numLayers: 0, hasAudio: false,
      };
    }
  } catch (_) {}
}

/* ── Resize drag — set up once, works across re-renders ── */
let _resizeDragSetup = false;
function _setupResizeDrag() {
  if (_resizeDragSetup) return;
  _resizeDragSetup = true;
  document.addEventListener('mousemove', (e) => {
    if (!S._resizing) return;
    const delta = e.clientY - S._resizeStartY;
    S.previewHeight = Math.max(120, Math.min(800, S._resizeStartH + delta));
    const frame = document.querySelector('.cap-preview-frame');
    if (frame) frame.style.maxHeight = S.previewHeight + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!S._resizing) return;
    S._resizing = false;
    const sec = document.querySelector('.cap-preview-section');
    if (sec) sec.classList.remove('dragging-cap');
    _persistSoon();
  });
}

function closeCaptions() {
  const v = $('#captions-view');
  if (v) v.classList.add('hidden');
  if (S._raf) { cancelAnimationFrame(S._raf); S._raf = null; }
  if (_refreshInterval) { clearInterval(_refreshInterval); _refreshInterval = null; }
}

/* ── Styles ─ */
function _ensureStyles() {
  if (!document.getElementById('cap-style-link')) {
    const link = document.createElement('link');
    link.id = 'cap-style-link'; link.rel = 'stylesheet';
    link.href = 'styles/captions.css?v=aecap10';
    document.head.appendChild(link);
  }
}
function _ensureContainer() {
  let v = $('#captions-view');
  if (!v) {
    v = document.createElement('div');
    v.id = 'captions-view'; v.className = 'captions-view';
    ($('#app-main') || document.body).appendChild(v);
    // Auto-persist any control change (select/checkbox/color/slider commit).
    v.addEventListener('change', _persistSoon);
  }
  v.classList.remove('hidden');
  return v;
}

/* ── Render ── */
function _render() {
  const v = _ensureContainer();
  S._canvas = null; S._ctx = null;
  if (S._raf) { cancelAnimationFrame(S._raf); S._raf = null; }
  v.innerHTML = _buildHTML();
  _wireHeader(v);
  _wireTabs(v);
  _wirePreview(v);
  _wireTabTranscribe(v);
  _wireTabContent(v);
  _wireTabStyle(v);
  _wireTabAnimate(v);
  _wireTabGenerate(v);
  S._canvas = v.querySelector('#cap-preview-canvas');
  S._ctx = S._canvas ? S._canvas.getContext('2d') : null;
  _updateActiveTab();
  _updatePreview();
  _startPreviewLoop();
}

function _buildHTML() {
  return [
    _renderHeader(),
    _renderPreview(),
    _renderTabBar(),
    `<div class="cap-content">${_renderAllTabContents()}</div>`,
  ].join('');
}

function _renderHeader() {
  let statusText, statusCls;
  if (S.modelInstalled) { statusText = `Whisper: ${S.modelName} · Connected`; statusCls = 'cap-whisper-status'; }
  else if (S.modelName) { statusText = `Whisper: ${S.modelName} (missing)`; statusCls = 'cap-whisper-status is-missing'; }
  else { statusText = 'Whisper: offline'; statusCls = 'cap-whisper-status is-offline'; }
  return `<div class="cap-header">
    <div>
      <div class="cap-header-logo">EditFlow AI</div>
      <div class="cap-header-version">v1.0.0</div>
    </div>
    <div class="cap-header-spacer"></div>
    <div id="cap-whisper-status" class="${statusCls}">
      <div class="cap-whisper-dot"></div>
      <span class="cap-whisper-text">${_esc(statusText)}</span>
    </div>
    <button id="cap-btn-settings" class="cap-icon-btn" title="Settings">&#9881;</button>
  </div>`;
}

function _renderPreview() {
  const t = S._previewTime || 0, dur = S.duration || 0;
  const dis = !S.words.length ? 'disabled' : '';
  // Match the preview canvas to the comp's aspect ratio (9:16 stays 9:16),
  // so what you see here matches what lands in the comp. Long edge = 480px
  // internal resolution for crisp text; the frame is bounded by max-height.
  const cw = (S.compInfo && S.compInfo.width) || 1920;
  const ch = (S.compInfo && S.compInfo.height) || 1080;
  const ar = cw / ch;
  const rw = ar >= 1 ? 480 : Math.round(480 * ar);
  const rh = ar >= 1 ? Math.round(480 / ar) : 480;
  const frameOverlay = S.compFrameUrl ? `
    <div class="cap-frame-overlay">
      <img src="${S.compFrameUrl}" alt="AE frame at ${(S.compFrameTime || 0).toFixed(2)}s" />
      <div class="cap-frame-badge">AE: ${(S.compFrameTime || 0).toFixed(2)}s · ${_esc(S.compFrameCompName || '')}</div>
      <button id="cap-frame-hide" class="cap-icon-btn cap-frame-hide" title="Hide frame">✕</button>
    </div>` : '';
  return `<div class="cap-preview-section">
    <div class="cap-preview-frame${S.compFrameUrl ? ' cap-has-frame' : ''}" style="max-height:${S.previewHeight}px; aspect-ratio:${cw}/${ch};">
      ${frameOverlay}
      <canvas id="cap-preview-canvas" width="${rw}" height="${rh}"></canvas>
    </div>
    <div class="cap-preview-controls">
      <button id="cap-preview-play" class="cap-play-btn" ${dis}>${S._previewPlaying ? '⏸' : '▶'}</button>
      <input type="range" id="cap-preview-seek" class="cap-range" min="0" max="${dur}" step="0.01" value="${t}" ${dis} />
      <span class="cap-preview-time" id="cap-preview-time">${t.toFixed(1)}s / ${dur.toFixed(1)}s</span>
      ${!window.__adobe_cep__ ? `<select id="cap-dev-aspect" class="cap-select" style="width:auto;padding:2px 4px;font-size:10px;" title="No AE detected — pick the comp aspect to preview">
        <option value="1920x1080" ${cw === 1920 ? 'selected' : ''}>16:9</option>
        <option value="1080x1920" ${cw === 1080 && ch === 1920 ? 'selected' : ''}>9:16</option>
        <option value="1080x1080" ${cw === 1080 && ch === 1080 ? 'selected' : ''}>1:1</option>
      </select>` : ''}
    </div>
    <div class="cap-preview-resize-bar" title="Drag to resize preview"><div></div></div>
  </div>`;
}

function _renderTabBar() {
  return `<div class="cap-tab-bar">${TABS.map((tab, i) => `
    <button class="cap-tab ${i === S.activeTab ? 'active' : ''}" data-tab="${i}">
      <div class="cap-tab-num">${tab.num}</div>
      <div class="cap-tab-icon"><svg class="cap-icon-svg" viewBox="0 0 24 24">${tab.icon}</svg></div>
      <div class="cap-tab-label">${tab.label}</div>
    </button>`).join('')}</div>`;
}

function _renderAllTabContents() {
  return [
    `<div class="cap-tab-content ${S.activeTab === 0 ? 'active' : ''}" data-content="0">${_renderTabTranscribe()}</div>`,
    `<div class="cap-tab-content ${S.activeTab === 1 ? 'active' : ''}" data-content="1">${_renderTabContent()}</div>`,
    `<div class="cap-tab-content ${S.activeTab === 2 ? 'active' : ''}" data-content="2">${_renderTabStyle()}</div>`,
    `<div class="cap-tab-content ${S.activeTab === 3 ? 'active' : ''}" data-content="3">${_renderTabAnimate()}</div>`,
    `<div class="cap-tab-content ${S.activeTab === 4 ? 'active' : ''}" data-content="4">${_renderTabGenerate()}</div>`,
  ].join('');
}

/* ── Tab 1: Transcribe ── */
function _renderTabTranscribe() {
  const compBar = _renderCompBar();
  const td = S.busy || !S.compInfo || S.compInfo.error || !S.compInfo.hasAudio;
  return `<div class="cap-card">
    <div class="cap-card-title">🎤 Transcribe Audio</div>
    <div class="cap-card-subtitle">Select an audio layer in your comp, or upload a file. Multi-layer or trimmed audio triggers a mixdown render.</div>
    ${compBar}
    <div class="cap-btn-group" style="margin-bottom: 12px;">
      <button id="cap-transcribe-btn" class="cap-btn cap-btn-primary" ${td ? 'disabled' : ''}>${S.busy ? 'Working…' : '🎙️ From Comp'}</button>
      <label class="cap-btn cap-btn-secondary" style="cursor:pointer" title="Upload WAV/MP3/M4A">📁 Upload<input type="file" id="cap-audio-upload" accept=".wav,.mp3,.m4a,audio/*" style="display:none" ${S.busy ? 'disabled' : ''} /></label>
      <button id="cap-paste-btn" class="cap-btn cap-btn-secondary" ${S.busy ? 'disabled' : ''}>📋 Paste</button>
      <button id="cap-frame-btn" class="cap-btn cap-btn-secondary" ${S.busy ? 'disabled' : ''} title="Capture current AE frame (F)">🖼 Frame</button>
      <button id="cap-debug-log-btn" class="cap-btn cap-btn-secondary" ${S.busy ? 'disabled' : ''} title="Show the ExtendScript debug log (where a capture failed)">📋 Log</button>
    </div>
    <div class="cap-row">
      <label class="cap-label">Language</label>
      <select id="cap-language" class="cap-select">${LANGUAGES.map((l) => `<option value="${l[0]}" ${S.language === l[0] ? 'selected' : ''}>${_esc(l[1])}</option>`).join('')}</select>
    </div>
    <div class="cap-row">
      <label class="cap-label" title="WhisperX aligns word times to ~50ms; plain Whisper is faster but coarser (~200-300ms)">Alignment</label>
      <select id="cap-align-engine" class="cap-select">
        <option value="auto" ${S.alignEngine === 'auto' ? 'selected' : ''}>Auto (best available)</option>
        <option value="whisperx" ${S.alignEngine === 'whisperx' ? 'selected' : ''}>Accurate (WhisperX)</option>
        <option value="whisper" ${S.alignEngine === 'whisper' ? 'selected' : ''}>Fast (Whisper)</option>
      </select>
    </div>
    <div class="cap-row" style="align-items:flex-start;">
      <label class="cap-label" title="Names and recurring terms, comma-separated — biases spelling (e.g. transliterated Arabic phrases)">Vocabulary</label>
      <textarea id="cap-custom-vocab" class="cap-input" rows="2" placeholder="Alhamdulillah, SubhanAllah, EditFlow…" style="flex:1;resize:vertical;">${_esc(S.customVocab)}</textarea>
    </div>
    ${S._showPaste ? `<div class="cap-paste-area">
      <textarea id="cap-paste-text" placeholder="Paste SRT cues or a JSON array of {word,start,end} objects...">${_esc(S._pasteText)}</textarea>
      <div class="cap-btn-group" style="margin-top:6px;">
        <button id="cap-paste-parse" class="cap-btn cap-btn-primary">Use This Transcript</button>
        <button id="cap-paste-cancel" class="cap-btn cap-btn-secondary">Cancel</button>
      </div>
    </div>` : ''}
    ${S.status ? `<div class="cap-status-progress" style="margin-top:10px;">${_esc(S.status)}</div>` : ''}
    ${S.busy && S.progress > 0 ? `<div class="cap-progress-bar"><div class="cap-progress-fill" style="width:${S.progress}%"></div><span class="cap-progress-text">${S.progress}%</span></div>` : ''}
    ${S.error ? `<div class="cap-status-err" style="margin-top:10px;">${_esc(S.error)}</div>` : ''}
    ${S.words.length && S.duration ? `<div style="margin-top:10px; padding:8px 12px; background:rgba(16,185,129,.1); border:1px solid rgba(16,185,129,.2); border-radius:6px;"><span class="cap-status-ok">✓ ${S.words.length} words transcribed · ${S.duration.toFixed(1)}s</span></div>` : ''}
  </div>`;
}

function _renderCompBar() {
  if (!S.compInfo) return `<div class="cap-comp-bar"><span>No active composition. Open a comp in AE.</span></div>`;
  if (S.compInfo.error) return `<div class="cap-comp-bar"><span style="color:var(--error);">Error: ${_esc(S.compInfo.error)}</span></div>`;
  const ci = S.compInfo;
  return `<div class="cap-comp-bar">
    <strong>${_esc(ci.name)}</strong>
    <span>${ci.width}×${ci.height}</span>
    <span>${(ci.duration || 0).toFixed(1)}s</span>
    <span>${(ci.frameRate || 0).toFixed(1)} fps</span>
    <span>${ci.numLayers || 0} layers</span>
    <span class="${ci.hasAudio ? 'cap-audio-yes' : 'cap-audio-no'}">${ci.hasAudio ? '✓ Audio Detected' : '⚠ No Audio'}</span>
  </div>`;
}

/* ── Tab 2: Content ── */
function _renderTabContent() {
  if (!S.words.length) {
    return `<div class="cap-card">
      <div class="cap-card-title">📝 Caption Content</div>
      <div class="cap-card-subtitle">No words yet. Go to the Transcribe tab first.</div>
    </div>`;
  }
  return `<div class="cap-card">
    <div class="cap-card-title">📝 Caption Content</div>
    <div class="cap-card-subtitle" id="cap-content-summary">${_contentSummaryHTML()}</div>
    <div class="cap-btn-group" style="margin-bottom: 10px;">
      <button id="cap-pill-all" class="cap-btn cap-btn-secondary cap-btn-tiny">Pill All</button>
      <button id="cap-pill-clear" class="cap-btn cap-btn-secondary cap-btn-tiny">Clear Pills</button>
      <span style="margin-left:auto; color:var(--text-3); font-size:10px; align-self:center;">${S.words.length} words</span>
    </div>
    <div class="cap-word-list" id="cap-word-list">${_buildWordListHTML()}</div>
    <div class="cap-subgroup">
      <div class="cap-subgroup-title">Segment Settings</div>
      <div class="cap-row">
        <label class="cap-label">Max Words</label>
        <input type="range" class="cap-range" id="cap-max-words" min="1" max="8" value="${S.maxWordsPerSegment}" />
        <span class="cap-range-val" id="cap-max-words-val">${S.maxWordsPerSegment}</span>
      </div>
      <div class="cap-row">
        <label class="cap-label">Max Chars</label>
        <input type="number" class="cap-input cap-input-num" id="cap-max-chars" min="10" max="80" value="${S.maxCharsPerSegment}" style="width:60px" />
        <span class="cap-range-val" id="cap-max-chars-val">${S.maxCharsPerSegment}</span>
      </div>
      <div class="cap-row">
        <label class="cap-label">Max Dur (s)</label>
        <input type="number" class="cap-input cap-input-num" id="cap-max-dur" min="1" max="10" step="0.5" value="${S.maxDurationPerSegment}" style="width:60px" />
        <span class="cap-range-val" id="cap-max-dur-val">${S.maxDurationPerSegment}</span>
      </div>
      <div class="cap-row">
        <label class="cap-label">Max Lines</label>
        <input type="range" class="cap-range" id="cap-max-lines" min="1" max="2" value="${S.maxLinesPerSegment}" />
        <span class="cap-range-val" id="cap-max-lines-val">${S.maxLinesPerSegment}</span>
      </div>
      <div class="cap-row">
        <label class="cap-label" title="Captions wrap and shrink to stay inside this % of the composition width">Caption Box</label>
        <input type="range" class="cap-range" id="cap-box-width" min="60" max="100" value="${S.boxWidthPct}" />
        <span class="cap-range-val" id="cap-box-width-val">${S.boxWidthPct}%</span>
      </div>
    </div>
  </div>`;
}

function _contentSummaryHTML() {
  const groups = _groupWordsForPreview(S.words);
  const pillCount = S.words.filter((w) => w.pill).length;
  return `${groups.length} caption${groups.length === 1 ? '' : 's'} from ${S.words.length} words. Click a caption header to preview it. Toggle 💊 for pill backgrounds (adjacent pills merge). <strong style="color:var(--text);">${pillCount}</strong> pill${pillCount === 1 ? '' : 's'} active.`;
}

function _buildWordListHTML() {
  const groups = _groupWordsForPreview(S.words);
  let rows = '';
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const lineTexts = _wrapForBox(g).map((l) => _esc(l.text)).join(' <span style="color:var(--text-2);">⏎</span> ');
    rows += `<div class="cap-group-divider" data-gstart="${g.start}" title="Click to preview this caption"><span>Caption ${gi + 1} · ${lineTexts}</span><span>${g.start.toFixed(2)}–${g.end.toFixed(2)}s</span></div>`;
    for (const gw of g.words) rows += _renderWordRow(S.words[gw.idx], gw.idx);
  }
  return rows;
}

function _refreshSummary() {
  const summary = document.querySelector('#cap-content-summary');
  if (summary) summary.innerHTML = _contentSummaryHTML();
}

/* Rebuild the caption list + summary after a segment-setting change, so the
   caption headers can't go stale (they used to update only on full re-render). */
function _refreshContentList() {
  const v = $('#captions-view');
  if (!v) return;
  const list = v.querySelector('#cap-word-list');
  if (list) list.innerHTML = _buildWordListHTML();
  const summary = v.querySelector('#cap-content-summary');
  if (summary) summary.innerHTML = _contentSummaryHTML();
  _wireTabContent(v);
}

function _renderWordRow(w, i) {
  const start = w.start || 0;
  const text = w.word || w.text || '';
  const isPill = !!w.pill;
  return `<div class="cap-word-row ${isPill ? 'pill-active' : ''}" data-idx="${i}">
    <span class="cap-word-time">${start.toFixed(2)}</span>
    <input type="text" class="cap-word-input" data-idx="${i}" value="${_esc(text)}" />
    <button class="cap-word-pill-btn ${isPill ? 'active' : ''}" data-idx="${i}" title="Toggle pill background">${isPill ? '💊' : '🔲'}</button>
  </div>`;
}

/* ── Tab 3: Style ── */
function _renderPresetBar() {
  const names = Object.keys(S._presets).sort();
  const userOpts = names.map((n) => `<option value="u:${_esc(n)}" ${S._activePreset === 'u:' + n ? 'selected' : ''}>${_esc(n)}</option>`).join('');
  const builtinOpts = Object.keys(BUILTIN_PRESETS).map((n) => `<option value="b:${_esc(n)}" ${S._activePreset === 'b:' + n ? 'selected' : ''}>${_esc(n)}</option>`).join('');
  return `<div class="cap-card">
    <div class="cap-card-title">💾 Style Presets</div>
    <div class="cap-row">
      <select id="cap-preset-pick" class="cap-select">
        <option value="">— pick a preset —</option>
        ${userOpts ? `<optgroup label="My Presets">${userOpts}</optgroup>` : ''}
        <optgroup label="Built-in">${builtinOpts}</optgroup>
      </select>
    </div>
    <div class="cap-btn-group">
      <button id="cap-preset-save" class="cap-btn cap-btn-secondary cap-btn-tiny">Save as…</button>
      <button id="cap-preset-update" class="cap-btn cap-btn-secondary cap-btn-tiny">Update</button>
      <button id="cap-preset-delete" class="cap-btn cap-btn-danger cap-btn-tiny">Delete</button>
      <button id="cap-preset-export" class="cap-btn cap-btn-secondary cap-btn-tiny">Export</button>
      <label class="cap-btn cap-btn-secondary cap-btn-tiny" style="cursor:pointer">Import<input type="file" id="cap-preset-import" accept=".json" style="display:none" /></label>
    </div>
  </div>`;
}

function _renderTabStyle() {
  return _renderPresetBar() + `<div class="cap-card">
    <div class="cap-card-title">🎨 Caption Style</div>
    ${_renderFontField()}
    <div class="cap-row">
      <label class="cap-label">Font Size</label>
      <input type="range" class="cap-range" id="cap-font-size" min="20" max="200" value="${S.fontSize}" />
      <span class="cap-range-val" id="cap-font-size-val">${S.fontSize}px</span>
    </div>
    <div class="cap-row">
      <label class="cap-label">Text Color</label>
      <input type="color" class="cap-color-input" id="cap-fill-color" value="${_rgbToHex(S.fillColor)}" />
    </div>
    <div class="cap-row">
      <label class="cap-label">Outline</label>
      <input type="color" class="cap-color-input" id="cap-stroke-color" value="${_rgbToHex(S.strokeColor)}" />
      <input type="range" class="cap-range" id="cap-stroke-width" min="0" max="10" value="${S.strokeWidth}" />
      <span class="cap-range-val" id="cap-stroke-width-val">${S.strokeWidth}px</span>
    </div>
    <div class="cap-row">
      <label class="cap-label">Shadow</label>
      <input type="checkbox" class="cap-checkbox" id="cap-drop-shadow" ${S.dropShadow ? 'checked' : ''} />
    </div>
    ${S.dropShadow ? `<div class="cap-subgroup">
      <div class="cap-subgroup-title">Shadow Controls</div>
      <div class="cap-row">
        <label class="cap-label">Color</label>
        <input type="color" class="cap-color-input" id="cap-shadow-color" value="${_rgbToHex(S.shadowColor)}" />
      </div>
      <div class="cap-row">
        <label class="cap-label">Opacity</label>
        <input type="range" class="cap-range" id="cap-shadow-opacity" min="0" max="100" value="${S.shadowOpacity}" />
        <span class="cap-range-val" id="cap-shadow-opacity-val">${S.shadowOpacity}%</span>
      </div>
      <div class="cap-row">
        <label class="cap-label">Distance</label>
        <input type="range" class="cap-range" id="cap-shadow-distance" min="0" max="50" value="${S.shadowDistance}" />
        <span class="cap-range-val" id="cap-shadow-distance-val">${S.shadowDistance}</span>
      </div>
      <div class="cap-row">
        <label class="cap-label">Blur</label>
        <input type="range" class="cap-range" id="cap-shadow-blur" min="0" max="50" value="${S.shadowBlur}" />
        <span class="cap-range-val" id="cap-shadow-blur-val">${S.shadowBlur}</span>
      </div>
    </div>` : ''}
    <div class="cap-row">
      <label class="cap-label">Pos X</label>
      <input type="range" class="cap-range" id="cap-pos-x" min="0" max="100" value="${S.posX}" />
      <span class="cap-range-val" id="cap-pos-x-val">${S.posX}%</span>
    </div>
    <div class="cap-row">
      <label class="cap-label">Pos Y</label>
      <input type="range" class="cap-range" id="cap-pos-y" min="0" max="100" value="${S.posY}" />
      <span class="cap-range-val" id="cap-pos-y-val">${S.posY}%</span>
    </div>
    <div class="cap-row">
      <label class="cap-label">UPPERCASE</label>
      <input type="checkbox" class="cap-checkbox" id="cap-all-caps" ${S.allCaps ? 'checked' : ''} />
    </div>
    <div class="cap-subgroup">
      <div class="cap-subgroup-title">Pill Background</div>
      <div class="cap-row">
        <label class="cap-label">BG Color</label>
        <input type="color" class="cap-color-input" id="cap-pill-color" value="${_rgbToHex(S.pillColor)}" />
      </div>
      <div class="cap-row">
        <label class="cap-label">Opacity</label>
        <input type="range" class="cap-range" id="cap-pill-opacity" min="0" max="100" value="${S.pillOpacity}" />
        <span class="cap-range-val" id="cap-pill-opacity-val">${S.pillOpacity}%</span>
      </div>
      <div class="cap-row">
        <label class="cap-label">Border</label>
        <input type="color" class="cap-color-input" id="cap-pill-stroke-color" value="${_rgbToHex(S.pillStrokeColor)}" />
        <input type="range" class="cap-range" id="cap-pill-stroke-width" min="0" max="10" value="${S.pillStrokeWidth}" />
        <span class="cap-range-val" id="cap-pill-stroke-width-val">${S.pillStrokeWidth}px</span>
      </div>
      <div class="cap-row">
        <label class="cap-label">Radius</label>
        <input type="range" class="cap-range" id="cap-pill-radius" min="0" max="100" value="${Math.round(S.pillRadius * 100)}" />
        <span class="cap-range-val" id="cap-pill-radius-val">${Math.round(S.pillRadius * 100)}%</span>
      </div>
    </div>
  </div>`;
}

function _renderFontField() {
  if (!S._fontsLoaded || !S.fonts.length) {
    return `<div class="cap-row">
      <label class="cap-label">Font (PS name)</label>
      <input type="text" class="cap-input" id="cap-font-ps" value="${_esc(S.fontPS)}" placeholder="Arial-BoldMT" />
    </div>`;
  }
  const families = {};
  for (const f of S.fonts) {
    const fam = f.family || 'Other';
    if (!families[fam]) families[fam] = [];
    families[fam].push(f);
  }
  const optgroups = Object.keys(families).sort().map((fam) => {
    const opts = families[fam].map((f) => `<option value="${_esc(f.ps)}" ${S.fontPS === f.ps ? 'selected' : ''}>${_esc(f.style || f.ps)}</option>`).join('');
    return `<optgroup label="${_esc(fam)}">${opts}</optgroup>`;
  }).join('');
  const customOpt = S.fonts.map((f) => f.ps).indexOf(S.fontPS) === -1
    ? `<option value="${_esc(S.fontPS)}" selected>Custom: ${_esc(S.fontPS)}</option>` : '';
  return `<div class="cap-row">
    <label class="cap-label">Font</label>
    <select class="cap-select" id="cap-font-ps-select">${customOpt}${optgroups}</select>
  </div>`;
}

/* ── Tab 4: Animate ── */
function _renderTabAnimate() {
  const presetOpts = PRESETS.map((p) => `<option value="${p[0]}" ${S.preset === p[0] ? 'selected' : ''}>${_esc(p[1])}</option>`).join('');
  const easingOpts = (cur) => EASING_OPTIONS.map((e) => `<option value="${e[0]}" ${cur === e[0] ? 'selected' : ''}>${_esc(e[1])}</option>`).join('');
  const previewText = S.allCaps ? 'CAPTION' : 'Caption';
  return `<div class="cap-card">
    <div class="cap-card-title">✨ Animation</div>
    <div class="cap-animate-layout">
      <div class="cap-animate-controls">
        <div class="cap-row">
          <label class="cap-label">Preset</label>
          <select class="cap-select" id="cap-preset">${presetOpts}</select>
        </div>
        <div class="cap-row">
          <label class="cap-label">Intensity</label>
          <input type="range" class="cap-range" id="cap-anim-intensity" min="0.5" max="2.0" step="0.05" value="${S.animIntensity}" />
          <span class="cap-range-val" id="cap-anim-intensity-val">${S.animIntensity.toFixed(2)}×</span>
        </div>
        <div class="cap-subgroup">
          <div class="cap-subgroup-title">Word Animation</div>
          <div class="cap-row">
            <label class="cap-label">Easing</label>
            <select class="cap-select" id="cap-word-easing">${easingOpts(S.wordEasing)}</select>
          </div>
          <div class="cap-row">
            <label class="cap-label">Duration</label>
            <input type="range" class="cap-range" id="cap-fade-dur" min="0.1" max="1.0" step="0.05" value="${S.fadeDur}" />
            <span class="cap-range-val" id="cap-fade-dur-val">${S.fadeDur.toFixed(2)}s</span>
          </div>
          <div class="cap-row">
            <label class="cap-label">Slide</label>
            <input type="range" class="cap-range" id="cap-slide-dist" min="0" max="100" value="${S.slideDist}" />
            <span class="cap-range-val" id="cap-slide-dist-val">${S.slideDist}px</span>
          </div>
        </div>
        <div class="cap-subgroup">
          <div class="cap-subgroup-title">Pill Animation</div>
          <div class="cap-row">
            <label class="cap-label">Easing</label>
            <select class="cap-select" id="cap-pill-easing">${easingOpts(S.pillEasing)}</select>
          </div>
          <div class="cap-row">
            <label class="cap-label">Scale Dur</label>
            <input type="range" class="cap-range" id="cap-pill-scale-dur" min="0.1" max="1.0" step="0.05" value="${S.pillScaleDur}" />
            <span class="cap-range-val" id="cap-pill-scale-dur-val">${S.pillScaleDur.toFixed(2)}s</span>
          </div>
        </div>
        <div class="cap-subgroup">
          <div class="cap-subgroup-title">Timing</div>
          <div class="cap-row">
            <label class="cap-label" title="Each caption stays on screen until the next one starts, plus this many frames of overlap — so sentences don't flash or gap.">Overlap</label>
            <input type="range" class="cap-range" id="cap-overlap-frames" min="0" max="10" value="${S.overlapFrames}" />
            <span class="cap-range-val" id="cap-overlap-frames-val">${S.overlapFrames}f</span>
          </div>
          <div class="cap-row">
            <label class="cap-label" title="A caption is never shown for less than this, even for very short words.">Min Display</label>
            <input type="range" class="cap-range" id="cap-min-dur" min="0.3" max="2.0" step="0.1" value="${S.minDisplayDur}" />
            <span class="cap-range-val" id="cap-min-dur-val">${S.minDisplayDur.toFixed(1)}s</span>
          </div>
        </div>
      </div>
      <div class="cap-animate-preview">
        <div class="cap-animate-preview-text">${_esc(previewText)}</div>
        <button id="cap-animate-preview-btn" class="cap-animate-preview-btn" title="Creates TEMPORARY preview layers — your real captions are untouched">Preview in Comp (temp) ↗</button>
        <button id="cap-remove-preview-btn" class="cap-animate-preview-btn">Remove preview</button>
        ${S.status ? `<div class="cap-status-progress" style="font-size:9px;text-align:center;margin-top:4px;">${_esc(S.status)}</div>` : ''}
      </div>
    </div>
  </div>`;
}

/* ── Tab 5: Generate ── */
function _renderTabGenerate() {
  const wordCount = S.words.length;
  const pillCount = S.words.filter(w => w.pill).length;
  return `<div class="cap-card">
    <div class="cap-card-title">🚀 Generate</div>
    <div class="cap-card-subtitle">Generate native AE text layers on your timeline. All layers are fully editable — no MOGRTs.</div>
    <div style="display:flex; flex-direction:column; gap:10px;">
      <button id="cap-generate-btn" class="cap-btn cap-btn-primary cap-btn-full" ${!wordCount || S.busy ? 'disabled' : ''}>🚀 Generate All (${wordCount} words)</button>
      ${S.busy ? `<button id="cap-cancel-btn" class="cap-btn cap-btn-secondary cap-btn-full">✕ Cancel</button>` : ''}
      <button id="cap-smoke-btn" class="cap-btn cap-btn-tertiary cap-btn-full" ${!wordCount || S.busy ? 'disabled' : ''}>🧪 Test First Caption (temp)</button>
      <button id="cap-srt-btn" class="cap-btn cap-btn-secondary cap-btn-full" ${!wordCount || S.busy ? 'disabled' : ''}>💾 Export SRT</button>
      <button id="cap-clear-btn" class="cap-btn cap-btn-danger cap-btn-full" ${S.busy ? 'disabled' : ''}>🗑️ Clear Existing</button>
    </div>
    ${S.status ? `<div class="cap-status-progress" style="margin-top:10px;">${_esc(S.status)}</div>` : ''}
    ${S.busy && S.progress > 0 ? `<div class="cap-progress-bar"><div class="cap-progress-fill" style="width:${S.progress}%"></div><span class="cap-progress-text">${S.progress}%</span></div>` : ''}
    ${S.error ? `<div class="cap-status-err" style="margin-top:10px;">${_esc(S.error)}</div>` : ''}
    ${S.generateResult ? _renderResult() : ''}
    ${S.generateResult && S.generateResult.placed > 0 ? _renderResultSummary(wordCount, pillCount) : ''}
  </div>`;
}

function _renderResult() {
  const r = S.generateResult;
  const cls = r.placed === r.total ? 'cap-status-badge-ok' : (r.placed > 0 ? 'cap-status-badge-warn' : 'cap-status-badge-err');
  const errList = (r.errors || []).slice(0, 8).map((e) => `<li>${_esc(typeof e === 'string' ? e : JSON.stringify(e))}</li>`).join('');
  return `<div class="cap-result">
    <span class="cap-status-badge ${cls}">${r.placed}/${r.total} placed</span>
    ${r.groups != null ? `<span style="color:var(--text-2);">${r.groups} groups</span>` : ''}
    ${r.preset ? `<span style="color:var(--text-2);">${_esc(r.preset)}</span>` : ''}
    ${r.errors && r.errors.length ? `<details class="cap-drawer"><summary>${r.errors.length} error${r.errors.length === 1 ? '' : 's'}</summary><ul class="cap-error-list">${errList}</ul></details>` : ''}
  </div>`;
}

function _renderResultSummary(wordCount, pillCount) {
  const pillGroups = _countPillGroups(S.words);
  const lines = [
    `• ${wordCount} word${wordCount === 1 ? '' : 's'} → ${_groupWordsForPreview(S.words).length} caption group${_groupWordsForPreview(S.words).length === 1 ? '' : 's'}`,
    `• ${pillGroups} merged pill group${pillGroups === 1 ? '' : 's'} (${pillCount} word${pillCount === 1 ? '' : 's'} marked)`,
    `• ${PRESETS.find(p => p[0] === S.preset) ? PRESETS.find(p => p[0] === S.preset)[1] : S.preset} animation`,
    `• Word fade-up: ${S.wordEasing} · ${S.fadeDur.toFixed(2)}s · ${S.slideDist}px slide`,
    `• Pill scale: ${S.pillEasing} · ${S.pillScaleDur.toFixed(2)}s`,
    `• Font: ${S.fontPS} @ ${S.fontSize}px${S.allCaps ? ' (UPPERCASE)' : ''}`,
  ];
  return `<div class="cap-result-summary"><strong>Summary:</strong><br>${lines.join('<br>')}</div>`;
}

function _countPillGroups(words) {
  let count = 0, inPill = false;
  for (const w of words) {
    if (w.pill && !inPill) { count++; inPill = true; }
    else if (!w.pill) { inPill = false; }
  }
  return count;
}

/* ── Wire Up ── */
function _wireHeader(v) {
  const settingsBtn = v.querySelector('#cap-btn-settings');
  if (settingsBtn) settingsBtn.onclick = () => {
    document.dispatchEvent(new CustomEvent('editflow:open-settings'));
    if (typeof window.openSettings === 'function') { try { window.openSettings(); } catch (_) {} }
  };
  const closeBtn = v.querySelector('#cap-btn-close');
  if (closeBtn) closeBtn.onclick = () => closeCaptions();
}

function _wireTabs(v) {
  v.querySelectorAll('.cap-tab').forEach((tab) => {
    tab.onclick = () => {
      const idx = parseInt(tab.dataset.tab, 10);
      if (isNaN(idx)) return;
      S.activeTab = idx;
      _updateActiveTab();
    };
  });
}

function _updateActiveTab() {
  document.querySelectorAll('.cap-tab').forEach((t) => {
    const idx = parseInt(t.dataset.tab, 10);
    t.classList.toggle('active', idx === S.activeTab);
  });
  document.querySelectorAll('.cap-tab-content').forEach((c) => {
    const idx = parseInt(c.dataset.content, 10);
    c.classList.toggle('active', idx === S.activeTab);
  });
}

function _wirePreview(v) {
  const playBtn = v.querySelector('#cap-preview-play');
  if (playBtn) playBtn.onclick = _togglePreview;
  const seek = v.querySelector('#cap-preview-seek');
  if (seek) seek.oninput = (e) => {
    S._previewTime = parseFloat(e.target.value);
    _updatePreview();
    _updatePreviewTimeLabel();
  };
  // Browser-rig only: fake comp aspect so 9:16 layout is verifiable without AE.
  const devAspect = v.querySelector('#cap-dev-aspect');
  if (devAspect) devAspect.onchange = (e) => {
    const [w2, h2] = e.target.value.split('x').map(Number);
    S.compInfo = { width: w2, height: h2, frameRate: 30, name: 'browser-dev', duration: S.duration || 10 };
    _render();
  };
  // Resize drag — start from any point inside the preview section
  const sec = v.querySelector('.cap-preview-section');
  const hideFrame = v.querySelector('#cap-frame-hide');
  if (hideFrame) hideFrame.onclick = () => {
    S.compFrameUrl = null; S.compFrameTime = null; S.compFrameCompName = null;
    _render();
  };
  if (sec) {
    sec.addEventListener('mousedown', (e) => {
      // Only start resize from bottom ~40px of the section
      const rect = sec.getBoundingClientRect();
      const fromBottom = rect.bottom - e.clientY;
      if (fromBottom > 40) return; // too far up, don't resize
      e.preventDefault();
      S._resizing = true;
      S._resizeStartY = e.clientY;
      S._resizeStartH = S.previewHeight;
      sec.classList.add('dragging-cap');
    });
  }
}

function _wireTabTranscribe(v) {
  const t = v.querySelector('#cap-transcribe-btn'); if (t) t.onclick = _onTranscribe;
  const u = v.querySelector('#cap-audio-upload'); if (u) u.onchange = _onAudioUpload;
  const p = v.querySelector('#cap-paste-btn');
  if (p) p.onclick = () => {
    S._showPaste = true;
    _render();
    const ta = document.querySelector('#cap-paste-text');
    if (ta) setTimeout(() => ta.focus(), 0);
  };
  const pc = v.querySelector('#cap-paste-cancel');
  if (pc) pc.onclick = () => { S._showPaste = false; S._pasteText = ''; _render(); };
  const pp = v.querySelector('#cap-paste-parse'); if (pp) pp.onclick = _onPasteParse;
  const frameBtn = v.querySelector('#cap-frame-btn');
  if (frameBtn) frameBtn.onclick = _onCaptureFrame;
  const logBtn = v.querySelector('#cap-debug-log-btn');
  if (logBtn) logBtn.onclick = _onReadDebugLog;
  const pt = v.querySelector('#cap-paste-text'); if (pt) pt.oninput = (e) => { S._pasteText = e.target.value; };
  const ls = v.querySelector('#cap-language'); if (ls) ls.onchange = (e) => { S.language = e.target.value; };
  const ae = v.querySelector('#cap-align-engine'); if (ae) ae.onchange = (e) => { S.alignEngine = e.target.value; };
  const cv2 = v.querySelector('#cap-custom-vocab'); if (cv2) cv2.oninput = (e) => { S.customVocab = e.target.value; };
}

function _wireTabContent(v) {
  const pillAll = v.querySelector('#cap-pill-all');
  if (pillAll) pillAll.onclick = () => {
    S.words.forEach((w) => { w.pill = true; });
    _refreshAllWordRows(); _refreshSummary(); _updatePreview();
  };
  const pillClear = v.querySelector('#cap-pill-clear');
  if (pillClear) pillClear.onclick = () => {
    S.words.forEach((w) => { w.pill = false; });
    _refreshAllWordRows(); _refreshSummary(); _updatePreview();
  };
  v.querySelectorAll('.cap-word-input').forEach((input) => {
    input.oninput = (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      if (!isNaN(idx) && S.words[idx]) {
        S.words[idx].word = e.target.value;
        S.words[idx].text = e.target.value;
        _updatePreview();
      }
    };
  });
  v.querySelectorAll('.cap-word-pill-btn').forEach((btn) => {
    btn.onclick = (e) => {
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      if (isNaN(idx) || !S.words[idx]) return;
      S.words[idx].pill = !S.words[idx].pill;
      _refreshWordRow(idx);
      _refreshSummary();
      _updatePreview();
    };
  });
  v.querySelectorAll('.cap-group-divider').forEach((d) => {
    d.onclick = () => {
      S._previewTime = parseFloat(d.dataset.gstart) + 0.05;
      _updatePreview(); _updatePreviewTimeLabel();
    };
  });
  _wireRange(v, '#cap-max-words', (val) => {
    S.maxWordsPerSegment = parseInt(val, 10);
    _refreshContentList();
    return String(S.maxWordsPerSegment);
  });
  _wireRange(v, '#cap-max-lines', (val) => {
    S.maxLinesPerSegment = parseInt(val, 10);
    _refreshContentList();
    return String(S.maxLinesPerSegment);
  });
  _wireRange(v, '#cap-box-width', (val) => {
    S.boxWidthPct = parseInt(val, 10);
    _refreshContentList();
    return S.boxWidthPct + '%';
  });
  const mc = v.querySelector('#cap-max-chars');
  if (mc) mc.oninput = (e) => {
    const val = Math.max(10, Math.min(80, parseInt(e.target.value, 10) || 10));
    S.maxCharsPerSegment = val;
    const lbl = document.getElementById('cap-max-chars-val');
    if (lbl) lbl.textContent = val;
    _refreshContentList();
    _updatePreview();
  };
  const md = v.querySelector('#cap-max-dur');
  if (md) md.oninput = (e) => {
    const val = Math.max(1, Math.min(10, parseFloat(e.target.value) || 1));
    S.maxDurationPerSegment = val;
    const lbl = document.getElementById('cap-max-dur-val');
    if (lbl) lbl.textContent = val;
    _refreshContentList();
    _updatePreview();
  };
}

function _refreshWordRow(idx) {
  const row = document.querySelector(`.cap-word-row[data-idx="${idx}"]`);
  if (!row) return;
  const w = S.words[idx];
  const isPill = !!(w && w.pill);
  row.classList.toggle('pill-active', isPill);
  const btn = row.querySelector('.cap-word-pill-btn');
  if (btn) {
    btn.classList.toggle('active', isPill);
    btn.textContent = isPill ? '💊' : '🔲';
  }
}
function _refreshAllWordRows() {
  document.querySelectorAll('.cap-word-row').forEach((row) => {
    const idx = parseInt(row.dataset.idx, 10);
    if (isNaN(idx) || !S.words[idx]) return;
    const isPill = !!S.words[idx].pill;
    row.classList.toggle('pill-active', isPill);
    const btn = row.querySelector('.cap-word-pill-btn');
    if (btn) {
      btn.classList.toggle('active', isPill);
      btn.textContent = isPill ? '💊' : '🔲';
    }
  });
}

function _wirePresetBar(v) {
  const pick = v.querySelector('#cap-preset-pick');
  if (pick) pick.onchange = (e) => {
    const val = e.target.value;
    S._activePreset = val;
    if (val.startsWith('b:')) _applySettings(BUILTIN_PRESETS[val.slice(2)]);
    else if (val.startsWith('u:')) _applySettings(S._presets[val.slice(2)]);
    _savePresets(); _persistSoon(); _render();
  };
  const save = v.querySelector('#cap-preset-save');
  if (save) save.onclick = () => {
    const name = (prompt('Preset name:') || '').trim();
    if (!name) return;
    S._presets[name] = _snapshotSettings();
    S._activePreset = 'u:' + name;
    _savePresets(); _render();
  };
  const upd = v.querySelector('#cap-preset-update');
  if (upd) upd.onclick = () => {
    if (!S._activePreset.startsWith('u:')) { alert('Pick one of your saved presets first (built-ins are read-only — use "Save as…").'); return; }
    S._presets[S._activePreset.slice(2)] = _snapshotSettings();
    _savePresets();
    S.status = 'Preset updated.'; _render();
    setTimeout(() => { S.status = null; _render(); }, 1500);
  };
  const del = v.querySelector('#cap-preset-delete');
  if (del) del.onclick = () => {
    if (!S._activePreset.startsWith('u:')) { alert('Only your saved presets can be deleted.'); return; }
    const name = S._activePreset.slice(2);
    if (!confirm(`Delete preset "${name}"?`)) return;
    delete S._presets[name]; S._activePreset = '';
    _savePresets(); _render();
  };
  const exp = v.querySelector('#cap-preset-export');
  if (exp) exp.onclick = () => {
    const blob = new Blob([JSON.stringify({ editflow_presets: S._presets, current: _snapshotSettings() }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'editflow-caption-presets.json'; a.click();
  };
  const imp = v.querySelector('#cap-preset-import');
  if (imp) imp.onchange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const incoming = data.editflow_presets || data;
        let n = 0;
        for (const k of Object.keys(incoming)) { if (incoming[k] && typeof incoming[k] === 'object') { S._presets[k] = incoming[k]; n++; } }
        _savePresets(); _render();
        alert(`Imported ${n} preset(s).`);
      } catch (err) { alert('Import failed: ' + err.message); }
    };
    reader.readAsText(file);
  };
}

function _wireTabStyle(v) {
  _wirePresetBar(v);
  const fontSelect = v.querySelector('#cap-font-ps-select');
  if (fontSelect) fontSelect.onchange = (e) => { S.fontPS = e.target.value; _updatePreview(); };
  const fontInput = v.querySelector('#cap-font-ps');
  if (fontInput) fontInput.onchange = (e) => { S.fontPS = e.target.value || 'Arial-BoldMT'; _updatePreview(); };

  _wireRange(v, '#cap-font-size', (val) => { S.fontSize = parseInt(val, 10); return S.fontSize + 'px'; });
  _wireColor(v, '#cap-fill-color', (c) => { S.fillColor = c; });
  _wireColor(v, '#cap-stroke-color', (c) => { S.strokeColor = c; });
  _wireRange(v, '#cap-stroke-width', (val) => { S.strokeWidth = parseInt(val, 10); return S.strokeWidth + 'px'; });

  const dsc = v.querySelector('#cap-drop-shadow');
  if (dsc) dsc.onchange = (e) => { S.dropShadow = e.target.checked; _render(); _updatePreview(); };
  _wireColor(v, '#cap-shadow-color', (c) => { S.shadowColor = c; });
  _wireRange(v, '#cap-shadow-opacity', (val) => { S.shadowOpacity = parseInt(val, 10); return S.shadowOpacity + '%'; });
  _wireRange(v, '#cap-shadow-distance', (val) => { S.shadowDistance = parseInt(val, 10); return String(S.shadowDistance); });
  _wireRange(v, '#cap-shadow-blur', (val) => { S.shadowBlur = parseInt(val, 10); return String(S.shadowBlur); });

  _wireRange(v, '#cap-pos-x', (val) => { S.posX = parseInt(val, 10); return S.posX + '%'; });
  _wireRange(v, '#cap-pos-y', (val) => { S.posY = parseInt(val, 10); return S.posY + '%'; });
  const ac = v.querySelector('#cap-all-caps');
  if (ac) ac.onchange = (e) => { S.allCaps = e.target.checked; _updatePreview(); };

  _wireColor(v, '#cap-pill-color', (c) => { S.pillColor = c; });
  _wireRange(v, '#cap-pill-opacity', (val) => { S.pillOpacity = parseInt(val, 10); return S.pillOpacity + '%'; });
  _wireColor(v, '#cap-pill-stroke-color', (c) => { S.pillStrokeColor = c; });
  _wireRange(v, '#cap-pill-stroke-width', (val) => { S.pillStrokeWidth = parseInt(val, 10); return S.pillStrokeWidth + 'px'; });
  _wireRange(v, '#cap-pill-radius', (val) => {
    S.pillRadius = parseInt(val, 10) / 100;
    return Math.round(S.pillRadius * 100) + '%';
  });
}

function _wireTabAnimate(v) {
  const ps = v.querySelector('#cap-preset');
  if (ps) ps.onchange = (e) => { S.preset = e.target.value; _updatePreview(); };
  _wireRange(v, '#cap-anim-intensity', (val) => { S.animIntensity = parseFloat(val); return S.animIntensity.toFixed(2) + '×'; });
  const we = v.querySelector('#cap-word-easing');
  if (we) we.onchange = (e) => { S.wordEasing = e.target.value; _updatePreview(); };
  _wireRange(v, '#cap-fade-dur', (val) => { S.fadeDur = parseFloat(val); return S.fadeDur.toFixed(2) + 's'; });
  _wireRange(v, '#cap-slide-dist', (val) => { S.slideDist = parseInt(val, 10); return S.slideDist + 'px'; });
  const pe = v.querySelector('#cap-pill-easing');
  if (pe) pe.onchange = (e) => { S.pillEasing = e.target.value; _updatePreview(); };
  _wireRange(v, '#cap-pill-scale-dur', (val) => { S.pillScaleDur = parseFloat(val); return S.pillScaleDur.toFixed(2) + 's'; });
  _wireRange(v, '#cap-overlap-frames', (val) => { S.overlapFrames = parseInt(val, 10); return S.overlapFrames + 'f'; });
  _wireRange(v, '#cap-min-dur', (val) => { S.minDisplayDur = parseFloat(val); return S.minDisplayDur.toFixed(1) + 's'; });
  const ap = v.querySelector('#cap-animate-preview-btn');
  if (ap) ap.onclick = _onAnimatePreview;
  const rp = v.querySelector('#cap-remove-preview-btn');
  if (rp) rp.onclick = _onRemovePreview;
}

function _wireTabGenerate(v) {
  const c = v.querySelector('#cap-clear-btn'); if (c) c.onclick = _onClear;
  const s = v.querySelector('#cap-smoke-btn'); if (s) s.onclick = () => _onGenerate(true);
  const g = v.querySelector('#cap-generate-btn'); if (g) g.onclick = () => _onGenerate(false);
  const srt = v.querySelector('#cap-srt-btn'); if (srt) srt.onclick = _onExportSrt;
  const cancel = v.querySelector('#cap-cancel-btn'); if (cancel) cancel.onclick = () => { S._cancelGenerate = true; };
}

/* ── Wire helpers ── */
function _wireRange(v, inputSel, handler) {
  const input = v.querySelector(inputSel);
  if (!input) return;
  const valEl = v.querySelector(inputSel + '-val');
  input.oninput = (e) => {
    const result = handler(e.target.value);
    if (valEl && result != null) valEl.textContent = result;
    _updatePreview();
  };
}
function _wireColor(v, inputSel, handler) {
  const input = v.querySelector(inputSel);
  if (!input) return;
  input.oninput = (e) => { handler(_hexToRgb(e.target.value)); _updatePreview(); };
}

/* ── Backend Calls ── */
async function _refreshModelStatus() {
  const el = $('#cap-whisper-status');
  if (!el) return;
  try {
    const r = await apiGet('/api/whisper/status', { timeoutMs: 8000 });
    S.modelName = r.active_model || '';
    const installed = (r.supported_models || []).find((m) => m.name === S.modelName);
    S.modelInstalled = !!(installed && installed.installed);
    if (S.modelInstalled) {
      el.className = 'cap-whisper-status';
      el.querySelector('.cap-whisper-text').textContent = `Whisper: ${S.modelName} · Connected`;
    } else if (S.modelName) {
      el.className = 'cap-whisper-status is-missing';
      el.querySelector('.cap-whisper-text').textContent = `Whisper: ${S.modelName} (missing)`;
    } else {
      el.className = 'cap-whisper-status is-offline';
      el.querySelector('.cap-whisper-text').textContent = 'Whisper: offline';
    }
  } catch (e) {
    el.className = 'cap-whisper-status is-offline';
    const t = el.querySelector('.cap-whisper-text');
    if (t) t.textContent = 'Whisper: offline';
  }
}

async function _refreshCompInfo() {
  if (S._devComp) return;   // dev comp override pinned via #comp= hash
  let newInfo;
  try {
    if (!isExtendScriptAvailable()) return;
    const resp = await callExtendScript('ef_getCompInfo');
    if (resp && !resp.error) newInfo = resp;
    else newInfo = { error: (resp && resp.error) || 'Unknown error' };
  } catch (e) {
    newInfo = { error: e.message || String(e) };
  }
  const changed = !S.compInfo || JSON.stringify(S.compInfo) !== JSON.stringify(newInfo);
  S.compInfo = newInfo;
  if (changed) _render();
}

async function _loadFonts() {
  if (S._fontsLoaded) return;
  try {
    if (!isExtendScriptAvailable()) return;
    const result = await callExtendScript('ef_getFonts');
    if (Array.isArray(result) && result.length) {
      S.fonts = result; S._fontsLoaded = true; _render();
    }
  } catch (e) { console.warn('[captions] font load failed:', e); }
}

async function _onTranscribe() {
  if (S.busy) return;
  // Re-running (words already present) forces a fresh transcription so a
  // language change or a bad first result isn't served from cache.
  const isRerun = S.words.length > 0;
  S.busy = true; S.error = null; S.status = 'Checking audio layers…'; S.progress = 5; _render();
  try {
    if (!S.modelInstalled) throw new Error(`Whisper model "${S.modelName}" not installed. Open Settings to download.`);
    if (!isExtendScriptAvailable()) throw new Error('ExtendScript host not available.');

    // Step 1: inspect comp audio
    S.status = 'Inspecting comp audio…'; _render();
    const invResp = await callExtendScript('ef_getAudioInventory');
    if (!invResp || invResp.error) {
      throw new Error((invResp && invResp.error) || 'Cannot inspect audio in the active comp.');
    }
    // ef_getAudioInventory returns { layers: [...], count } — read the COUNT,
    // not the array (the old `invResp.layers || 0` made both branches dead).
    const invLayers = (invResp.layers && invResp.layers.length) ? invResp.layers : [];
    const layerCount = invResp.count || invLayers.length || 0;
    const firstFile = invLayers.length ? invLayers[0].file : null;
    // Untrimmed single layer: its comp in-point sits where its source starts
    // (|inPoint − startTime| ≈ 0). Head-trimmed layers have inPoint > startTime.
    const singleUntrimmed = layerCount === 1 && firstFile &&
      (invLayers[0].inPoint == null || invLayers[0].startTime == null ||
       Math.abs((invLayers[0].inPoint || 0) - (invLayers[0].startTime || 0)) < 0.05);
    let audioBlob, audioName = 'comp_audio.wav';

    if (singleUntrimmed) {
      // Fast path: single, untrimmed audio layer → use ef_getAudioPath
      S.status = 'Extracting audio path from comp…'; S.progress = 12; _render();
      const audioResp = await callExtendScript('ef_getAudioPath');
      if (!audioResp || audioResp.error || !audioResp.path) {
        throw new Error((audioResp && audioResp.error) || 'No audio found in the active comp.');
      }
      S.audioOffset = audioResp.offset || 0;
      audioBlob = await _readFileAsBlob(audioResp.path);
      const parts = (audioResp.path || '').split(/[\\/]/);
      audioName = parts[parts.length - 1] || 'comp_audio.wav';
    } else if (layerCount >= 1) {
      // Slow path: multi-layer or trimmed → render mixdown. Pass the output
      // path as a PLAIN STRING (ef_exportCompAudioMixdown(outPath)); the old
      // JSON.stringify({outPath}) double-encoded it into an invalid file path.
      S.status = 'Rendering audio mixdown… AE will be unresponsive for a few seconds.'; S.progress = 10; _render();
      const outPath = _defaultMixdownPath();
      const mixResp = await callExtendScript('ef_exportCompAudioMixdown', outPath);
      if (!mixResp || mixResp.error || !mixResp.path) {
        throw new Error((mixResp && mixResp.error) || 'Audio mixdown render failed.');
      }
      S.audioOffset = mixResp.offset || 0;
      audioBlob = await _readFileAsBlob(mixResp.path);
      const parts = (mixResp.path || '').split(/[\\/]/);
      audioName = parts[parts.length - 1] || 'comp_mixdown.wav';
    } else {
      throw new Error('No audio layers found in the active comp.');
    }

    // Step 2: upload + transcribe
    S.status = 'Uploading audio + transcribing with Whisper…'; S.progress = 25; _render();
    const resp = await apiUpload('/api/subtitles/transcribe-mixdown', audioBlob, {
      client_id: _wsClientId,
      sequence_name: (S.compInfo && S.compInfo.name) || 'ae_comp',
      in_seconds: 0,
      out_seconds: (S.compInfo && S.compInfo.duration) || 0,
      language: S.language || 'auto',
      engine: S.alignEngine || 'auto',
      vocab: S.customVocab || '',
      filename: audioName,
      force: String(isRerun),
    }, { timeoutMs: 600000 });

    S.words = (resp.words || []).map((w) => ({
      word: w.word || w.text || '',
      text: w.word || w.text || '',
      start: w.start, end: w.end,
      pill: false,
    }));
    S.duration = resp.duration || 0;
    S.status = null; S.progress = 100; S._previewTime = 0;
    S.highlightWords = []; S.generateResult = null;
    if (!S.words.length) throw new Error('Transcription completed but no words found. The audio may be too quiet.');
    // Auto-advance to Content tab
    S.activeTab = 1;
  } catch (e) {
    S.error = e.message || String(e); S.status = null; S.progress = 0;
  } finally { S.busy = false; _render(); }
}

async function _onCaptureFrame() {
  if (S.busy) return;
  S.busy = true;
  S.error = null;
  S.status = 'Capturing frame from After Effects…';
  _render();
  try {
    const { getCurrentFrame } = await import('./extendscript.js');
    const resp = await getCurrentFrame();
    if (resp && resp.error) throw new Error(resp.error);
    if (!resp || !resp.path) throw new Error('No frame returned');
    // Build a proper file:// URL. A bare 'file://' + path fails on Windows:
    // drive letters need a leading slash (file:///C:/...) AND spaces/special
    // chars must be %-encoded, otherwise the <img> silently fails to load and
    // the user sees the dark panel background bleeding through (looked like a
    // "black overlay"). encodeURI keeps ':/' and '/' intact, encodes only spaces.
    S.compFrameUrl = _filePathToUrl(resp.path);
    S.compFrameTime = resp.time;
    S.compFrameCompName = resp.compName;
    S.status = `Captured frame at ${Number(resp.time).toFixed(2)}s (${resp.compName})`;
  } catch (e) {
    S.error = 'Frame capture failed: ' + (e.message || e);
    S.compFrameUrl = null;
    S.compFrameTime = null;
    S.compFrameCompName = null;
  } finally {
    S.busy = false;
    _render();
  }
}

async function _onReadDebugLog() {
  S.error = null;
  S.status = 'Reading debug log…';
  _render();
  try {
    const { readDebugLog } = await import('./extendscript.js');
    const resp = await readDebugLog();
    if (resp && resp.error) {
      S.error = resp.error;
      S.status = null;
      _render();
      return;
    }
    // Show the numbered step trace in the same status area as errors, and
    // also log to the console + copy to clipboard for easy sharing.
    const logText = (resp && resp.log) || '(empty log)';
    const logPath = (resp && resp.path) || '';
    S.status = null;
    S.error = '📋 Frame debug log (' + logPath + '):\n\n' + logText +
              '\n\n(copied to clipboard; last line = where it stopped)';
    try { await navigator.clipboard.writeText(logText + '\n\n[' + logPath + ']'); } catch (_) {}
  } catch (e) {
    S.error = 'Could not read debug log: ' + (e.message || e);
    S.status = null;
  } finally {
    _render();
  }
}

async function _onAudioUpload(event) {
  const file = event.target.files && event.target.files[0];
  if (!file || S.busy) return;
  S.busy = true; S.error = null; S.status = 'Uploading audio + transcribing…'; S.progress = 15; _render();
  try {
    if (!S.modelInstalled) throw new Error(`Whisper model "${S.modelName}" not installed.`);
    const resp = await apiUpload('/api/subtitles/transcribe-mixdown', file, {
      client_id: _wsClientId,
      sequence_name: file.name,
      in_seconds: 0,
      out_seconds: 0,
      language: S.language || 'auto',
      engine: S.alignEngine || 'auto',
      vocab: S.customVocab || '',
      filename: file.name,
    }, { timeoutMs: 600000 });
    S.words = (resp.words || []).map((w) => ({
      word: w.word || w.text || '',
      text: w.word || w.text || '',
      start: w.start, end: w.end,
      pill: false,
    }));
    S.duration = resp.duration || 0;
    S.status = null; S.progress = 100; S._previewTime = 0;
    S.highlightWords = []; S.audioOffset = 0; S.generateResult = null;
    if (!S.words.length) throw new Error('No words found in transcription.');
    S.activeTab = 1;
  } catch (e) {
    S.error = e.message || String(e); S.status = null; S.progress = 0;
  } finally { S.busy = false; _render(); }
}

function _onPasteParse() {
  const text = S._pasteText || '';
  if (!text.trim()) { S.error = 'Paste some SRT or JSON first.'; _render(); return; }
  try {
    const words = _parseTranscript(text);
    if (!words.length) throw new Error('Could not parse any words from the input.');
    S.words = words.map((w) => ({ ...w, pill: false }));
    S.duration = words[words.length - 1].end || 0;
    S.error = null; S._showPaste = false; S._pasteText = '';
    S._previewTime = 0; S.highlightWords = []; S.audioOffset = 0; S.generateResult = null;
    S.activeTab = 1;
    _render();
  } catch (e) {
    S.error = e.message || String(e); _render();
  }
}

function _parseTranscript(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const words = [];
      for (const item of arr) {
        if (typeof item === 'string') continue;
        const w = item.word || item.text || '';
        const start = parseFloat(item.start), end = parseFloat(item.end);
        if (w && !isNaN(start) && !isNaN(end)) words.push({ word: w, text: w, start, end });
      }
      if (words.length) return words;
    } catch (_) { /* fall through */ }
  }
  if (/\d{2}:\d{2}:\d{2}[,\.]\d{3}\s*-->/.test(trimmed) || /\d{2}:\d{2}:\d{2}\s*-->/.test(trimmed)) {
    return _parseSrt(trimmed);
  }
  const compDur = (S.compInfo && S.compInfo.duration) || 10;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const per = compDur / tokens.length;
  return tokens.map((tok, i) => ({ word: tok, text: tok, start: i * per, end: (i + 1) * per }));
}

function _parseSrt(text) {
  const blocks = text.replace(/\r/g, '').split(/\n\n+/);
  const words = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    if (lines.length < 2) continue;
    let tsIdx = -1;
    for (let i = 0; i < lines.length; i++) { if (lines[i].indexOf('-->') !== -1) { tsIdx = i; break; } }
    if (tsIdx === -1) continue;
    const m = lines[tsIdx].match(/(\d+):(\d+):(\d+)[,\.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,\.](\d+)/);
    if (!m) continue;
    const start = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
    const end = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
    const cueText = lines.slice(tsIdx + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!cueText) continue;
    const tokens = cueText.split(/\s+/).filter(Boolean);
    const per = (end - start) / Math.max(1, tokens.length);
    tokens.forEach((tok, i) => { words.push({ word: tok, text: tok, start: start + i * per, end: start + (i + 1) * per }); });
  }
  return words;
}

async function _onGenerate(smokeTest) {
  if (S.busy || !S.words.length) return;
  S.busy = true; S._cancelGenerate = false; S.generateResult = null; S.error = null;
  S.progress = 2; S.status = smokeTest ? 'Creating test caption…' : 'Creating captions…'; _render();
  // Compute groups + line wrap + in/out timing ONCE over the whole transcript
  // (so a group's "hold until next" is correct even across batch boundaries),
  // then batch. The jsx consumes these verbatim — no re-grouping in AE.
  const allGroups = _buildGroupsPayload();
  const groups = smokeTest ? allGroups.slice(0, 1) : allGroups;
  const result = { placed: 0, total: groups.length, groups: groups.length, errors: [], preset: S.preset };
  try {
    const BATCH = 10;   // caption groups per ExtendScript call
    for (let i = 0; i < groups.length; i += BATCH) {
      if (S._cancelGenerate) { result.errors.push('Cancelled by user.'); break; }
      const cfg = _buildConfig();
      cfg.groups = groups.slice(i, i + BATCH);
      cfg.replace = (i === 0 && !smokeTest);   // clear existing only on the first real batch
      cfg.previewOnly = !!smokeTest;           // test = non-destructive preview layers
      const resp = await callExtendScript('ef_createCaptions', JSON.stringify(cfg));
      if (!resp || resp.error) { result.errors.push((resp && resp.error) || 'ExtendScript error'); break; }
      for (const er of (resp.errors || [])) result.errors.push(er);
      result.placed = Math.min(i + BATCH, groups.length);
      S.progress = Math.round((result.placed / groups.length) * 100);
      S.status = `Created ${result.placed}/${groups.length} caption${groups.length === 1 ? '' : 's'}…`;
      _updateProgressDom();
    }
    S.status = null; S.progress = 0;
  } catch (e) {
    result.errors.push(String(e.message || e));
    S.status = null; S.progress = 0;
  } finally {
    S.generateResult = result;
    S.busy = false; S._cancelGenerate = false; _render();
  }
}

/* Build the group payload the jsx consumes: each group carries its words,
   line assignments (char-budget wrap), and in/out points. Timing is computed
   over the FULL group list so batch slicing preserves each group's
   hold-until-next behaviour. */
function _buildGroupsPayload() {
  const groups = _groupWordsForPreview(S.words);
  const frameRate = (S.compInfo && S.compInfo.frameRate) || 30;
  const timing = captionTiming(groups, {
    frameDur: 1 / frameRate,
    overlapFrames: S.overlapFrames,
    minDur: S.minDisplayDur,
    tailHold: 0.5,
  });
  return groups.map((g, i) => ({
    words: g.words.map((w) => ({ text: w.text, start: w.start, end: w.end, pill: !!w.pill })),
    start: g.start, end: g.end,
    text: g.text,
    lines: _wrapForBox(g).map((l) => ({ startIdx: l.startIdx, endIdx: l.endIdx })),
    tIn: timing[i].in, tOut: timing[i].out,
  }));
}

/* Update just the progress bar + status text without a full re-render. */
function _updateProgressDom() {
  const fill = document.querySelector('.cap-progress-fill');
  const txt = document.querySelector('.cap-progress-text');
  const st = document.querySelector('.cap-status-progress');
  if (fill) fill.style.width = (S.progress || 0) + '%';
  if (txt) txt.textContent = (S.progress || 0) + '%';
  if (st && S.status) st.textContent = S.status;
}

/* WebSocket transcription progress (routed from main.js). */
function onTranscribeProgress(payload) {
  if (!payload || payload.task_type !== 'transcribe' || !S.busy) return;
  const pct = Math.round(Math.max(0, Math.min(1, payload.progress || 0)) * 100);
  S.progress = Math.max(S.progress || 0, pct);   // never regress our coarse milestones
  if (payload.message) S.status = payload.message;
  _updateProgressDom();
}

function setCaptionsClientId(id) { if (id) _wsClientId = id; }

async function _onExportSrt() {
  if (!S.words.length) return;
  try {
    const groups = _groupWordsForPreview(S.words);
    const cues = groups.map((g) => ({ start: g.start, end: g.end, text: g.text }));
    const name = (S.compInfo && S.compInfo.name) || 'captions';
    const resp = await apiPost('/api/subtitles/srt', { cues, name }, { timeoutMs: 15000 });
    S.status = resp.srt_path ? `SRT saved: ${resp.srt_path}` : 'SRT generated.';
    try { await navigator.clipboard.writeText(resp.srt || ''); S.status += ' (copied to clipboard)'; } catch (_) {}
    _render();
    setTimeout(() => { S.status = null; _render(); }, 6000);
  } catch (e) {
    S.error = e.message || String(e); _render();
  }
}

async function _onClear() {
  try {
    S.busy = true; _render();
    const resp = await callExtendScript('ef_clearCaptions');
    S.generateResult = null;
    S.status = `Cleared ${resp.removed || 0} layer(s).`;
    setTimeout(() => { S.status = null; _render(); }, 2500);
  } catch (e) {
    S.error = e.message || String(e);
  } finally { S.busy = false; _render(); }
}

async function _onAnimatePreview() {
  // Non-destructive: creates TEMPORARY preview layers (EF_CAPTION_PREVIEW) for
  // the group at the playhead. Real captions are never removed.
  try {
    if (!S.words.length) return;
    const t = S._previewTime || 0;
    const all = _buildGroupsPayload();
    const active = all.find((g) => t >= g.tIn && t < g.tOut) || all.find((g) => t >= g.start && t < g.end) || all[0];
    if (!active) return;
    const cfg = _buildConfig();
    cfg.groups = [active];
    cfg.previewOnly = true;
    await callExtendScript('ef_createCaptions', JSON.stringify(cfg));
    S.status = 'Temporary preview added (your captions are untouched). Use "Remove preview" to clear it.';
    _render();
    setTimeout(() => { S.status = null; _render(); }, 4000);
  } catch (e) {
    S.error = e.message || String(e);
    _render();
  }
}

async function _onRemovePreview() {
  try {
    const resp = await callExtendScript('ef_removePreview');
    S.status = `Removed ${resp.removed || 0} preview layer(s).`;
    _render();
    setTimeout(() => { S.status = null; _render(); }, 2000);
  } catch (e) {
    S.error = e.message || String(e); _render();
  }
}

/* Style + animation settings for a generation call. The caption groups
   (words, lines, timing) are attached separately as cfg.groups. */
function _buildConfig() {
  return {
    visualStyle: S.visualStyle,
    fontPS: S.fontPS, fontSize: S.fontSize,
    fillColor: S.fillColor, strokeColor: S.strokeColor, strokeWidth: S.strokeWidth,
    dropShadow: S.dropShadow, shadowColor: S.shadowColor, shadowOpacity: S.shadowOpacity,
    shadowDistance: S.shadowDistance, shadowBlur: S.shadowBlur,
    pillColor: S.pillColor, pillOpacity: S.pillOpacity, pillStrokeColor: S.pillStrokeColor,
    pillStrokeWidth: S.pillStrokeWidth, pillRadius: S.pillRadius,
    highlightTextColor: S.highlightTextColor, highlightBoxColor: S.highlightBoxColor,
    highlightWords: S.highlightWords.slice(),
    posX: S.posX, posY: S.posY, maxWordsPerSegment: S.maxWordsPerSegment,
    maxCharsPerSegment: S.maxCharsPerSegment, maxDurationPerSegment: S.maxDurationPerSegment,
    maxLinesPerSegment: S.maxLinesPerSegment,
    allCaps: S.allCaps, preset: S.preset, animIntensity: S.animIntensity,
    wordEasing: S.wordEasing, fadeDur: S.fadeDur, slideDist: S.slideDist,
    pillEasing: S.pillEasing, pillScaleDur: S.pillScaleDur,
    offset: S.audioOffset || 0, replace: true,
    boxWidthPct: S.boxWidthPct,
  };
}

/* ── Preview ── */
function _togglePreview() {
  if (!S.words.length) return;
  S._previewPlaying = !S._previewPlaying;
  if (S._previewPlaying && (S._previewTime || 0) >= S.duration) S._previewTime = 0;
  const btn = $('#cap-preview-play');
  if (btn) btn.textContent = S._previewPlaying ? '⏸' : '▶';
}

function _startPreviewLoop() {
  if (S._raf) cancelAnimationFrame(S._raf);
  let lastFrameTime = 0;
  function loop(ts) {
    if (S._previewPlaying && S.words.length) {
      if (lastFrameTime > 0) {
        S._previewTime = (S._previewTime || 0) + (ts - lastFrameTime) / 1000;
      }
      lastFrameTime = ts;
      if (S._previewTime >= S.duration) {
        S._previewTime = S.duration; S._previewPlaying = false;
        lastFrameTime = 0;
        const btn = $('#cap-preview-play'); if (btn) btn.textContent = '▶';
      }
      _updatePreviewTimeLabel();
    } else {
      lastFrameTime = 0;
    }
    _updatePreview();
    S._raf = requestAnimationFrame(loop);
  }
  S._raf = requestAnimationFrame(loop);
}

function _updatePreviewTimeLabel() {
  const el = document.querySelector('#cap-preview-time');
  if (el) el.textContent = `${(S._previewTime || 0).toFixed(1)}s / ${(S.duration || 0).toFixed(1)}s`;
  const seek = $('#cap-preview-seek');
  if (seek && document.activeElement !== seek) seek.value = S._previewTime || 0;
}

function _updatePreview() {
  if (!S._ctx || !S._canvas) return;
  const ctx = S._ctx, w = S._canvas.width, h = S._canvas.height;
  ctx.clearRect(0, 0, w, h);
  // When a captured AE frame is shown, keep the canvas transparent so the
  // frame shows clearly behind the live caption text (no dark overlay).
  if (!S.compFrameUrl) {
    // Background — dark semi-transparent video-player-style overlay
    ctx.fillStyle = 'rgba(18, 24, 40, 0.88)';
    ctx.fillRect(0, 0, w, h);
    // Subtle grid
    ctx.strokeStyle = 'rgba(255,255,255,.025)'; ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo((w * i) / 4, 0); ctx.lineTo((w * i) / 4, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, (h * i) / 4); ctx.lineTo(w, (h * i) / 4); ctx.stroke();
    }
  }
  if (!S.words.length) {
    ctx.fillStyle = '#5a5a6a'; ctx.font = '11px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Transcribe audio to see preview', w / 2, h / 2);
    return;
  }
  const t = S._previewTime || 0;
  // ponytail: regroups + relayouts every rAF frame (as the old code did);
  // memoize on a words/settings revision if long transcripts ever chug.
  const groups = _groupWordsForPreview(S.words);
  const frameRate = (S.compInfo && S.compInfo.frameRate) || 30;
  // Same timing rule the generated AE layers get: hold until next + overlap.
  const timing = captionTiming(groups, {
    frameDur: 1 / frameRate,
    overlapFrames: S.overlapFrames,
    minDur: S.minDisplayDur,
    tailHold: 0.5,
  });
  let any = false;
  for (let gi = 0; gi < groups.length; gi++) {
    if (t >= timing[gi].in && t < timing[gi].out) {
      _drawCaption(ctx, w, h, groups[gi], t);
      any = true;
    }
  }
  if (!any) {
    ctx.fillStyle = '#3a3a45'; ctx.font = '10px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(`(no caption at ${t.toFixed(2)}s)`, w / 2, h / 2);
  }
}

/* Draw one caption group at time t. Every pixel value scales by ONE factor
   (canvasWidth / compWidth) so the preview is proportionally exact for any
   comp aspect — the old ×1.5 font fudge and mixed scale bases are gone. */
function _drawCaption(ctx, w, h, g, t) {
  const compW = (S.compInfo && S.compInfo.width) || 1920;
  const px = w / compW;
  const fontPx = S.fontSize * px;
  ctx.font = _canvasFont(fontPx);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

  const lines = _wrapForBox(g);
  const lineHeight = S.fontSize * LAYOUT.lineHeightEm * px;
  const space = S.fontSize * LAYOUT.wordGapEm * px;
  const cx = w * (S.posX / 100);
  const blockCy = h * (S.posY / 100);

  // Measure + position every word, line by line.
  const layout = [];
  let maxLineW = 0;
  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li];
    const texts = [], widths = [];
    let lineW = 0;
    for (let i = ln.startIdx; i <= ln.endIdx; i++) {
      const txt = S.allCaps ? (g.words[i].text || '').toUpperCase() : (g.words[i].text || '');
      const ww = ctx.measureText(txt).width;
      texts.push(txt); widths.push(ww); lineW += ww;
    }
    lineW += space * Math.max(0, texts.length - 1);
    if (lineW > maxLineW) maxLineW = lineW;
    const y = blockCy + (li - (lines.length - 1) / 2) * lineHeight;
    let x = cx - lineW / 2;
    const pos = [];
    for (let k = 0; k < widths.length; k++) {
      pos.push({ x: x + widths[k] / 2, left: x, right: x + widths[k] });
      x += widths[k] + space;
    }
    layout.push({ ln, texts, widths, pos, y });
  }

  // Last-resort shrink parity with the jsx fit guard: wrapping already keeps
  // lines inside the box, so this only fires for a single word wider than it.
  const fitMax = w * (S.boxWidthPct / 100);
  const fit = maxLineW > fitMax ? fitMax / maxLineW : 1;
  ctx.save();
  if (fit < 1) {
    ctx.translate(cx, blockCy);
    ctx.scale(fit, fit);
    ctx.translate(-cx, -blockCy);
  }

  // Pills first (behind text) — each run appears at ITS first word's time
  // and stays until the caption ends (mirrors the AE layers).
  for (const L of layout) {
    const runs = _pillRuns(g.words, L.ln.startIdx, L.ln.endIdx);
    for (const run of runs) {
      const ps = _pillScale(g.words[run.a].start, t);
      if (ps <= 0.001) continue;
      const rs = Math.max(0.001, ps);
      const padX = S.fontSize * LAYOUT.pillPadXEm * px;
      const padY = S.fontSize * LAYOUT.pillPadYEm * px;
      const left = L.pos[run.a - L.ln.startIdx].left;
      const right = L.pos[run.b - L.ln.startIdx].right;
      const pw = (right - left + padX * 2) * rs;
      const ph = (fontPx + padY * 2) * rs;
      const pcx = (left + right) / 2;
      const r = (fontPx + padY * 2) / 2 * S.pillRadius * rs;
      const a = ps * (S.pillOpacity / 100);
      ctx.fillStyle = _rgbaToCss(S.pillColor, a);
      _roundRect(ctx, pcx - pw / 2, L.y - ph / 2, Math.max(1, pw), Math.max(1, ph), Math.max(0, r));
      ctx.fill();
      if (S.pillStrokeWidth > 0 && ps > 0.05) {
        ctx.strokeStyle = _rgbaToCss(S.pillStrokeColor, ps);
        ctx.lineWidth = S.pillStrokeWidth * px * rs;
        ctx.stroke();
      }
    }
  }

  // Words — animation comes from the shared model, so each preset previews
  // its real motion (pop overshoot, bounce, squash, typewriter, fades).
  const params = {
    fadeDur: S.fadeDur, slideDist: S.slideDist,
    easing: S.wordEasing, intensity: S.animIntensity,
  };
  const capAnim = wordAnim(S.preset, { ...params, start: g.start }, t);
  for (const L of layout) {
    for (let k = 0; k < L.texts.length; k++) {
      const wd = g.words[L.ln.startIdx + k];
      const an = capAnim.captionLevel ? capAnim : wordAnim(S.preset, { ...params, start: wd.start }, t);
      if (an.opacity <= 0.01) continue;
      const wx = L.pos[k].x;
      const wy = L.y + an.dy * px;
      ctx.save();
      if (an.scaleX !== 1 || an.scaleY !== 1) {
        ctx.translate(wx, wy);
        ctx.scale(Math.max(0.001, an.scaleX), Math.max(0.001, an.scaleY));
        ctx.translate(-wx, -wy);
      }
      if (S.dropShadow && an.opacity > 0.1) {
        ctx.shadowColor = _rgbaToCss(S.shadowColor, (S.shadowOpacity / 100) * an.opacity);
        ctx.shadowBlur = S.shadowBlur * px;
        ctx.shadowOffsetX = S.shadowDistance * px * 0.7;
        ctx.shadowOffsetY = S.shadowDistance * px * 0.7;
      }
      if (S.strokeWidth > 0) {
        ctx.strokeStyle = _rgbaToCss(S.strokeColor, an.opacity);
        ctx.lineWidth = S.strokeWidth * 2 * px;
        ctx.lineJoin = 'round';
        ctx.strokeText(L.texts[k], wx, wy);
      }
      ctx.fillStyle = _rgbaToCss(S.fillColor, an.opacity);
      ctx.fillText(L.texts[k], wx, wy);
      ctx.restore();
    }
  }
  ctx.restore();
}

/* Canvas font from the AE font list (family + style → weight/italic); the
   PS-name heuristic is only the no-AE fallback. This is what makes font
   picks actually change the preview. */
function _canvasFont(fontPx) {
  let family = null, style = '';
  if (S._fontsLoaded && S.fonts.length) {
    const f = S.fonts.find((x) => x.ps === S.fontPS);
    if (f && f.family) { family = f.family; style = f.style || ''; }
  }
  if (!family) { family = _fontFamilyFromPS(S.fontPS); style = S.fontPS || ''; }
  let weight = 400;
  if (/black|heavy/i.test(style)) weight = 900;
  else if (/extrabold|ultra/i.test(style)) weight = 800;
  else if (/semibold|demi/i.test(style)) weight = 600;
  else if (/bold/i.test(style)) weight = 700;
  else if (/medium/i.test(style)) weight = 500;
  else if (/light|thin/i.test(style)) weight = 300;
  const italic = /italic|oblique/i.test(style) ? 'italic ' : '';
  return `${italic}${weight} ${fontPx}px "${family}", sans-serif`;
}

/* Measure text width in COMP pixels with the real preview font. One shared
   measurer means the payload sent to AE and the canvas preview always make
   the same line decisions. */
let _measCanvas = null;
function _measureCompPx(text) {
  if (!_measCanvas) _measCanvas = document.createElement('canvas');
  const c = _measCanvas.getContext('2d');
  c.font = _canvasFont(S.fontSize);
  return c.measureText(S.allCaps ? String(text).toUpperCase() : String(text)).width;
}

/* Wrap a group's words into lines that fit the caption box (boxWidthPct of
   comp width) using measured widths. This is what keeps the font size
   CONSTANT: long captions wrap instead of shrinking. */
function _wrapForBox(g) {
  const compW = (S.compInfo && S.compInfo.width) || 1920;
  return wrapLines(g, {
    maxLinesPerSegment: S.maxLinesPerSegment,
    maxCharsPerSegment: S.maxCharsPerSegment,
    maxWidthPx: compW * (S.boxWidthPct / 100),
    measure: _measureCompPx,
    spacePx: S.fontSize * LAYOUT.wordGapEm,
  });
}

function _pillScale(pillStart, t) {
  const dt = t - pillStart;
  if (dt < 0) return 0;
  if (dt < S.pillScaleDur) return (EASINGS[S.pillEasing] || EASINGS.linear)(dt / S.pillScaleDur);
  return 1;
}

/* Merged runs of adjacent pill words within word index range [a, b]. */
function _pillRuns(words, a, b) {
  const runs = [];
  let i = a;
  while (i <= b) {
    if (words[i].pill) {
      let e = i;
      while (e + 1 <= b && words[e + 1].pill) e++;
      runs.push({ a: i, b: e });
      i = e + 1;
    } else i++;
  }
  return runs;
}

function _roundRect(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function _groupWordsForPreview(words) {
  // Single source of truth shared with tests + (Phase 3) the jsx config.
  return groupWords(words, {
    maxWordsPerSegment: S.maxWordsPerSegment,
    maxCharsPerSegment: S.maxCharsPerSegment,
    maxDurationPerSegment: S.maxDurationPerSegment,
    maxLinesPerSegment: S.maxLinesPerSegment,
    maxGap: 0.4,
  });
}

/* ── Helpers ── */
function _readFileAsBlob(path) {
  const req = (typeof require === 'function') ? require
            : (window.cep_node && window.cep_node.require) ? window.cep_node.require : null;
  if (!req) throw new Error('Node require not available in CEP.');
  const fs = req('fs');
  const buffer = fs.readFileSync(path);
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return new Blob([bytes], { type: 'audio/wav' });
}

function _defaultMixdownPath() {
  try {
    const req = (typeof require === 'function') ? require
              : (window.cep_node && window.cep_node.require) ? window.cep_node.require : null;
    if (req) {
      const os = req('os');
      const path = req('path');
      return path.join(os.tmpdir(), 'editflow_mixdown_' + Date.now() + '.wav');
    }
  } catch (_) { /* fall through */ }
  return '/tmp/editflow_mixdown_' + Date.now() + '.wav';
}

/* Convert an OS file path into a loadable file:// URL.
   CEP/Chromium rejects un-encoded local URLs (spaces, missing 3rd slash on
   Windows drives), which makes the captured frame <img> fail to render and
   the dark panel shows through — the "black overlay" symptom. */
function _filePathToUrl(p) {
  let s = String(p || '').replace(/\\/g, '/');
  // Encode each path segment so spaces/special chars don't break the URL,
  // but preserve the scheme + drive colon ('file:///C:').
  s = s.split('/').map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg))).join('/');
  // Windows drive path like "C:/..." → needs three slashes: file:///C:/...
  return s.startsWith('/') ? ('file://' + s) : ('file:///' + s);
}

function _rgbToHex(rgb) {
  const r = Math.round((rgb[0] || 0) * 255);
  const g = Math.round((rgb[1] || 0) * 255);
  const b = Math.round((rgb[2] || 0) * 255);
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function _hexToRgb(hex) {
  const h = (hex || '#000000').replace('#', '');
  return [
    parseInt(h.substring(0, 2), 16) / 255,
    parseInt(h.substring(2, 4), 16) / 255,
    parseInt(h.substring(4, 6), 16) / 255,
  ];
}

function _rgbToCss(rgb) {
  return `rgb(${Math.round((rgb[0] || 0) * 255)}, ${Math.round((rgb[1] || 0) * 255)}, ${Math.round((rgb[2] || 0) * 255)})`;
}

function _rgbaToCss(rgb, alpha) {
  return `rgba(${Math.round((rgb[0] || 0) * 255)}, ${Math.round((rgb[1] || 0) * 255)}, ${Math.round((rgb[2] || 0) * 255)}, ${alpha != null ? alpha : 1})`;
}

function _fontFamilyFromPS(psName) {
  if (!psName) return 'Arial';
  return psName.replace(/[-,](Bold|Italic|Regular|Medium|Light|Black|Heavy|Semibold|Condensed|Oblique)+$/i, '').replace(/[-_]/g, ' ');
}

function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export { openCaptions, closeCaptions, setCaptionsClientId, onTranscribeProgress };
