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
const EASINGS = [
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
  posX: 50, posY: 80, maxWordsPerSegment: 4, maxCharsPerSegment: 30, maxDurationPerSegment: 3, allCaps: false,
  preset: 'fadeup_words', animIntensity: 1.0, language: 'auto',
  _previewTime: 0, _previewPlaying: false, _canvas: null, _ctx: null, _raf: null,
  fonts: [], _fontsLoaded: false, _showPaste: false, _pasteText: '',
  // New fields for tabbed UI + per-word pill animation
  activeTab: 0,
  wordEasing: 'ease_in_out', fadeDur: 0.5, slideDist: 50,
  pillEasing: 'ease_in_out', pillScaleDur: 0.5,
};
let _refreshInterval = null;

/* ── Public API ── */
function openCaptions() {
  _ensureStyles();
  _ensureContainer();
  _render();
  _refreshModelStatus();
  _refreshCompInfo();
  _loadFonts();
  if (_refreshInterval) clearInterval(_refreshInterval);
  _refreshInterval = setInterval(() => {
    const el = $('#captions-view');
    if (!el || el.classList.contains('hidden') || document.hidden) return;
    _refreshModelStatus();
    _refreshCompInfo();
  }, 10000);
}

function closeCaptions() {
  const v = $('#captions-view');
  if (v) v.classList.add('hidden');
  if (S._raf) { cancelAnimationFrame(S._raf); S._raf = null; }
  if (_refreshInterval) { clearInterval(_refreshInterval); _refreshInterval = null; }
}

/* ── Styles ── */
function _ensureStyles() {
  if (!document.getElementById('cap-style-link')) {
    const link = document.createElement('link');
    link.id = 'cap-style-link'; link.rel = 'stylesheet';
    link.href = 'styles/captions.css?v=aecap8';
    document.head.appendChild(link);
  }
  if (!document.getElementById('cap-extra-styles')) {
    const style = document.createElement('style');
    style.id = 'cap-extra-styles'; style.textContent = _EXTRA_CSS;
    document.head.appendChild(style);
  }
}

const _EXTRA_CSS = `
#captions-view, .captions-view {
  --bg: #121826;
  --card: #1A202C;
  --primary: #5E5CE6;
  --secondary: #3B82F6;
  --success: #10B981;
  --error: #EF4444;
  --text: #FFFFFF;
  --text-2: #9CA3AF;
  --text-3: #6B7280;
  --border: #2D3748;
  --radius-btn: 8px;
  --radius-card: 12px;

  display: flex; flex-direction: column;
  width: 100%; height: 100%; min-height: 0;
  background: var(--bg); color: var(--text);
  font-family: -apple-system, "Segoe UI", Inter, Roboto, sans-serif;
  font-size: 13px; overflow: hidden;
}

/* ── Header (fixed) ── */
.cap-header {
  display: flex; align-items: center; gap: 8px; padding: 10px 14px;
  background: var(--card); border-bottom: 1px solid var(--border); flex-shrink: 0;
}
.cap-header-logo { font-weight: 700; font-size: 15px; }
.cap-header-version { font: 10px monospace; color: var(--text-3); }
.cap-header-spacer { flex: 1; }
.cap-whisper-status {
  display: flex; align-items: center; gap: 5px; padding: 3px 10px;
  border-radius: 20px; font-size: 10px;
  background: rgba(16,185,129,.1); border: 1px solid rgba(16,185,129,.3);
}
.cap-whisper-status.is-offline { background: rgba(239,68,68,.1); border-color: rgba(239,68,68,.3); }
.cap-whisper-status.is-missing { background: rgba(234,179,8,.1); border-color: rgba(234,179,8,.3); }
.cap-whisper-dot {
  width: 6px; height: 6px; border-radius: 50%; background: var(--success);
  box-shadow: 0 0 6px var(--success);
}
.cap-whisper-status.is-offline .cap-whisper-dot { background: var(--error); box-shadow: 0 0 6px var(--error); }
.cap-whisper-status.is-missing .cap-whisper-dot { background: #facc15; box-shadow: 0 0 6px #facc15; }
.cap-whisper-text { color: var(--success); font-weight: 600; }
.cap-whisper-status.is-offline .cap-whisper-text { color: var(--error); }
.cap-whisper-status.is-missing .cap-whisper-text { color: #facc15; }
.cap-icon-btn {
  width: 28px; height: 28px; border-radius: 50%; background: var(--card);
  border: 1px solid var(--border); color: var(--text-2); cursor: pointer;
  display: flex; align-items: center; justify-content: center; font-size: 14px;
  transition: all .15s;
}
.cap-icon-btn:hover { background: var(--border); color: var(--text); }

/* ── Preview (fixed) ── */
.cap-preview-section { padding: 10px 14px; background: var(--bg); flex-shrink: 0; }
.cap-preview-frame {
  background: #000; border: 1px solid var(--border); border-radius: 8px;
  overflow: hidden; aspect-ratio: 16/9; position: relative;
}
.cap-preview-frame canvas { width: 100%; height: 100%; display: block; }
.cap-preview-controls { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.cap-preview-controls input[type="range"] { flex: 1; accent-color: var(--primary); }
.cap-preview-time { color: var(--text-2); font: 10px monospace; min-width: 70px; text-align: right; }
.cap-play-btn {
  width: 28px; height: 28px; border-radius: 50%; background: var(--primary);
  border: none; color: white; cursor: pointer; display: flex; align-items: center;
  justify-content: center; font-size: 12px; flex-shrink: 0;
}
.cap-play-btn:disabled { opacity: .4; cursor: not-allowed; }

/* ── Tab Bar (fixed) ── */
.cap-tab-bar {
  display: flex; background: var(--card); border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border); flex-shrink: 0;
}
.cap-tab {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px;
  padding: 8px 4px; cursor: pointer; transition: all .15s; position: relative;
  background: transparent; border: none; color: inherit; font: inherit;
}
.cap-tab-icon { width: 22px; height: 22px; opacity: .5; transition: all .15s; }
.cap-tab-label { font-size: 9px; color: var(--text-3); transition: all .15s; }
.cap-tab:hover .cap-tab-icon { opacity: .7; }
.cap-tab:hover .cap-tab-label { color: var(--text-2); }
.cap-tab.active .cap-tab-icon { opacity: 1; filter: brightness(0) invert(1) sepia(1) saturate(5) hue-rotate(240deg); }
.cap-tab.active .cap-tab-label { color: var(--primary); font-weight: 600; }
.cap-tab.active::after {
  content: ''; position: absolute; bottom: 0; left: 20%; right: 20%; height: 2px;
  background: var(--primary); border-radius: 2px 2px 0 0;
}
.cap-tab-num {
  position: absolute; top: 4px; right: 8px; width: 14px; height: 14px;
  border-radius: 50%; background: var(--border); color: var(--text-3);
  font-size: 8px; display: flex; align-items: center; justify-content: center; font-weight: 600;
}
.cap-tab.active .cap-tab-num { background: var(--primary); color: white; }
.cap-icon-svg { width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }

/* ── Content Area (scrolls) ── */
.cap-content { flex: 1; overflow-y: auto; padding: 14px; min-height: 0; }
.cap-content::-webkit-scrollbar { width: 6px; }
.cap-content::-webkit-scrollbar-track { background: transparent; }
.cap-content::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

/* ── Cards ── */
.cap-card {
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius-card); padding: 14px; margin-bottom: 12px;
}
.cap-card-title { font-size: 14px; font-weight: 600; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
.cap-card-subtitle { font-size: 11px; color: var(--text-2); margin-bottom: 12px; line-height: 1.4; }

/* ── Buttons ── */
.cap-btn {
  padding: 10px 16px; border-radius: var(--radius-btn); cursor: pointer;
  font: inherit; font-size: 12px; font-weight: 500; border: none;
  transition: all .15s; display: inline-flex; align-items: center; gap: 6px;
  justify-content: center;
}
.cap-btn:hover:not(:disabled) { opacity: .9; transform: translateY(-1px); }
.cap-btn:disabled { opacity: .4; cursor: not-allowed; }
.cap-btn-primary { background: var(--primary); color: white; }
.cap-btn-secondary { background: var(--border); color: white; }
.cap-btn-tertiary { background: transparent; border: 1px solid var(--secondary); color: var(--secondary); }
.cap-btn-danger { background: transparent; border: 1px solid var(--error); color: var(--error); }
.cap-btn-full { width: 100%; }
.cap-btn-group { display: flex; gap: 8px; flex-wrap: wrap; }
.cap-btn-group .cap-btn { flex: 1; min-width: 0; }
.cap-btn-tiny { padding: 4px 10px; font-size: 10px; }

/* ── Form Controls ── */
.cap-row { display: flex; align-items: center; gap: 10px; margin: 10px 0; }
.cap-label { min-width: 80px; color: var(--text-2); font-size: 11px; }
.cap-select, .cap-input {
  background: var(--bg); color: var(--text); border: 1px solid var(--border);
  border-radius: 6px; padding: 6px 10px; flex: 1; font: inherit; font-size: 11px;
  min-width: 0;
}
.cap-select:focus, .cap-input:focus { outline: none; border-color: var(--primary); }
.cap-range { flex: 1; accent-color: var(--primary); min-width: 0; }
.cap-range-val { color: var(--text-2); font: 10px monospace; min-width: 34px; text-align: right; }
.cap-color-input { width: 32px; height: 26px; border: 1px solid var(--border); border-radius: 4px; cursor: pointer; background: transparent; padding: 0; flex-shrink: 0; }
.cap-checkbox { accent-color: var(--primary); width: 16px; height: 16px; cursor: pointer; }

/* ── Word List ── */
.cap-word-list { max-height: 240px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); }
.cap-word-list::-webkit-scrollbar { width: 4px; }
.cap-word-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
.cap-word-row { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-bottom: 1px solid rgba(255,255,255,.04); }
.cap-word-row:last-child { border-bottom: none; }
.cap-word-row.pill-active { background: rgba(94,92,230,.05); }
.cap-word-time { color: var(--text-3); font: 9px monospace; min-width: 32px; flex-shrink: 0; }
.cap-word-input { flex: 1; background: transparent; border: 0; color: var(--text); font: inherit; font-size: 11px; padding: 2px; min-width: 0; }
.cap-word-input:focus { outline: none; background: rgba(94,92,230,.1); border-radius: 3px; }
.cap-word-pill-btn { background: transparent; border: 1px solid transparent; cursor: pointer; font-size: 11px; padding: 2px 6px; border-radius: 3px; opacity: .4; transition: all .15s; flex-shrink: 0; }
.cap-word-pill-btn.active { opacity: 1; background: rgba(94,92,230,.2); border-color: rgba(94,92,230,.4); }

/* ── Status ── */
.cap-status-ok { color: var(--success); font-size: 11px; }
.cap-status-err { color: var(--error); font-size: 11px; word-break: break-word; }
.cap-status-progress { color: var(--text-2); font-size: 11px; word-break: break-word; }
.cap-status-badge {
  display: inline-block; padding: 3px 10px; border-radius: 20px;
  font-size: 10px; font-weight: 600;
}
.cap-status-badge-ok { background: rgba(16,185,129,.15); color: var(--success); border: 1px solid rgba(16,185,129,.3); }
.cap-status-badge-err { background: rgba(239,68,68,.15); color: var(--error); border: 1px solid rgba(239,68,68,.3); }
.cap-status-badge-warn { background: rgba(234,179,8,.15); color: #facc15; border: 1px solid rgba(234,179,8,.3); }
.cap-progress-bar { position: relative; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; height: 18px; margin: 8px 0; overflow: hidden; }
.cap-progress-fill { position: absolute; left: 0; top: 0; bottom: 0; background: linear-gradient(90deg, var(--primary), var(--secondary)); transition: width .3s ease; }
.cap-progress-text { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #fff; font: 600 10px monospace; text-shadow: 0 1px 2px rgba(0,0,0,.6); }

/* ── Animate Tab layout ── */
.cap-animate-layout { display: flex; gap: 12px; }
.cap-animate-controls { flex: 1.2; min-width: 0; }
.cap-animate-preview {
  flex: 1; background: var(--bg); border: 1px solid var(--border);
  border-radius: 8px; padding: 10px; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 8px; min-height: 100px;
}
.cap-animate-preview-text { font-size: 18px; font-weight: 700; color: var(--primary); }
.cap-animate-preview-btn { font-size: 9px; color: var(--secondary); cursor: pointer; text-decoration: underline; background: transparent; border: 0; padding: 0; }

/* ── Subgroup ── */
.cap-subgroup { margin-top: 10px; padding: 10px; background: rgba(0,0,0,.2); border-radius: 8px; border: 1px solid rgba(255,255,255,.04); }
.cap-subgroup-title { font-size: 9px; color: var(--text-3); margin-bottom: 6px; text-transform: uppercase; letter-spacing: .05em; font-weight: 600; }

/* ── Result ── */
.cap-result { margin-top: 10px; padding: 10px; background: rgba(255,255,255,.03); border-radius: 8px; font-size: 11px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cap-result-summary { margin-top: 12px; padding: 10px; background: var(--bg); border-radius: 6px; font-size: 10px; color: var(--text-3); line-height: 1.5; }
.cap-result-summary strong { color: var(--text-2); }

/* ── Comp info bar (Transcribe tab) ── */
.cap-comp-bar {
  background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
  padding: 10px; margin-bottom: 12px; font-size: 11px; color: var(--text-2);
  display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
}
.cap-comp-bar strong { color: var(--text); font-weight: 600; }
.cap-comp-bar .cap-audio-yes { color: var(--success); }
.cap-comp-bar .cap-audio-no { color: var(--error); }

/* ── Paste area ── */
.cap-paste-area { margin-top: 8px; }
.cap-paste-area textarea {
  width: 100%; min-height: 100px; background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px;
  font: 11px monospace; resize: vertical;
}
.cap-paste-area textarea:focus { outline: none; border-color: var(--primary); }

/* ── Tab content visibility ── */
.cap-tab-content { display: none; }
.cap-tab-content.active { display: block; }

/* ── Misc ── */
.cap-hint { color: var(--text-2); font-size: 11px; line-height: 1.5; margin: 4px 0 8px; }
.cap-error-list { margin: 4px 0 0; padding-left: 18px; color: var(--error); font-size: 11px; }
.cap-drawer { width: 100%; margin-top: 4px; }
.cap-drawer summary { cursor: pointer; color: var(--text-2); font-size: 11px; }
`;

function _ensureContainer() {
  let v = $('#captions-view');
  if (!v) {
    v = document.createElement('div');
    v.id = 'captions-view'; v.className = 'captions-view';
    ($('#app-main') || document.body).appendChild(v);
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
    <button id="cap-btn-close" class="cap-icon-btn" title="Close panel">✕</button>
  </div>`;
}

function _renderPreview() {
  const t = S._previewTime || 0, dur = S.duration || 0;
  const dis = !S.words.length ? 'disabled' : '';
  return `<div class="cap-preview-section">
    <div class="cap-preview-frame"><canvas id="cap-preview-canvas" width="480" height="270"></canvas></div>
    <div class="cap-preview-controls">
      <button id="cap-preview-play" class="cap-play-btn" ${dis}>${S._previewPlaying ? '⏸' : '▶'}</button>
      <input type="range" id="cap-preview-seek" class="cap-range" min="0" max="${dur}" step="0.01" value="${t}" ${dis} />
      <span class="cap-preview-time" id="cap-preview-time">${t.toFixed(1)}s / ${dur.toFixed(1)}s</span>
    </div>
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
    </div>
    <div class="cap-row">
      <label class="cap-label">Language</label>
      <select id="cap-language" class="cap-select">${LANGUAGES.map((l) => `<option value="${l[0]}" ${S.language === l[0] ? 'selected' : ''}>${_esc(l[1])}</option>`).join('')}</select>
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
  const pillCount = S.words.filter(w => w.pill).length;
  const rows = S.words.map((w, i) => _renderWordRow(w, i)).join('');
  return `<div class="cap-card">
    <div class="cap-card-title">📝 Caption Content</div>
    <div class="cap-card-subtitle">Edit words and toggle 💊 for pill backgrounds. Adjacent pills merge into one. <strong style="color:var(--text);">${pillCount}</strong> pill${pillCount === 1 ? '' : 's'} active.</div>
    <div class="cap-btn-group" style="margin-bottom: 10px;">
      <button id="cap-pill-all" class="cap-btn cap-btn-secondary cap-btn-tiny">Pill All</button>
      <button id="cap-pill-clear" class="cap-btn cap-btn-secondary cap-btn-tiny">Clear Pills</button>
      <span style="margin-left:auto; color:var(--text-3); font-size:10px; align-self:center;">${S.words.length} words</span>
    </div>
    <div class="cap-word-list" id="cap-word-list">${rows}</div>
    <div class="cap-subgroup">
      <div class="cap-subgroup-title">Segment Settings</div>
      <div class="cap-row">
        <label class="cap-label">Max Words</label>
        <input type="range" class="cap-range" id="cap-max-words" min="1" max="8" value="${S.maxWordsPerSegment}" />
        <span class="cap-range-val" id="cap-max-words-val">${S.maxWordsPerSegment}</span>
      </div>
      <div class="cap-row">
        <label class="cap-label">Max Chars</label>
        <input type="number" class="cap-input" id="cap-max-chars" min="10" max="80" value="${S.maxCharsPerSegment}" style="flex:0;width:60px" />
      </div>
      <div class="cap-row">
        <label class="cap-label">Max Dur (s)</label>
        <input type="number" class="cap-input" id="cap-max-dur" min="1" max="10" step="0.5" value="${S.maxDurationPerSegment}" style="flex:0;width:60px" />
      </div>
    </div>
  </div>`;
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
function _renderTabStyle() {
  return `<div class="cap-card">
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
  const easingOpts = (cur) => EASINGS.map((e) => `<option value="${e[0]}" ${cur === e[0] ? 'selected' : ''}>${_esc(e[1])}</option>`).join('');
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
      </div>
      <div class="cap-animate-preview">
        <div class="cap-animate-preview-text">${_esc(previewText)}</div>
        <button id="cap-animate-preview-btn" class="cap-animate-preview-btn">Preview in Comp ↗</button>
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
      <button id="cap-clear-btn" class="cap-btn cap-btn-danger cap-btn-full" ${S.busy ? 'disabled' : ''}>🗑️ Clear Existing</button>
      <button id="cap-smoke-btn" class="cap-btn cap-btn-tertiary cap-btn-full" ${!wordCount || S.busy ? 'disabled' : ''}>🧪 Smoke Test (3 words)</button>
      <button id="cap-generate-btn" class="cap-btn cap-btn-primary cap-btn-full" ${!wordCount || S.busy ? 'disabled' : ''}>🚀 Generate All (${wordCount} words)</button>
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
  const pt = v.querySelector('#cap-paste-text'); if (pt) pt.oninput = (e) => { S._pasteText = e.target.value; };
  const ls = v.querySelector('#cap-language'); if (ls) ls.onchange = (e) => { S.language = e.target.value; };
}

function _wireTabContent(v) {
  const pillAll = v.querySelector('#cap-pill-all');
  if (pillAll) pillAll.onclick = () => {
    S.words.forEach((w) => { w.pill = true; });
    _refreshAllWordRows(); _updatePreview();
  };
  const pillClear = v.querySelector('#cap-pill-clear');
  if (pillClear) pillClear.onclick = () => {
    S.words.forEach((w) => { w.pill = false; });
    _refreshAllWordRows(); _updatePreview();
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
      _updatePreview();
    };
  });
  _wireRange(v, '#cap-max-words', (val) => {
    S.maxWordsPerSegment = parseInt(val, 10);
    return String(S.maxWordsPerSegment);
  });
  const mc = v.querySelector('#cap-max-chars');
  if (mc) mc.onchange = (e) => {
    S.maxCharsPerSegment = Math.max(10, Math.min(80, parseInt(e.target.value, 10) || 30));
    _updatePreview();
  };
  const md = v.querySelector('#cap-max-dur');
  if (md) md.onchange = (e) => {
    S.maxDurationPerSegment = Math.max(1, Math.min(10, parseFloat(e.target.value) || 3));
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

function _wireTabStyle(v) {
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
  const ap = v.querySelector('#cap-animate-preview-btn');
  if (ap) ap.onclick = _onAnimatePreview;
}

function _wireTabGenerate(v) {
  const c = v.querySelector('#cap-clear-btn'); if (c) c.onclick = _onClear;
  const s = v.querySelector('#cap-smoke-btn'); if (s) s.onclick = () => _onGenerate(true);
  const g = v.querySelector('#cap-generate-btn'); if (g) g.onclick = () => _onGenerate(false);
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
    const layerCount = invResp.layers || 0;
    const trimmed = !!invResp.trimmed;
    let audioBlob, audioName = 'comp_audio.wav';

    if (layerCount === 1 && !trimmed) {
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
      // Slow path: multi-layer or trimmed → render mixdown
      S.status = 'Rendering audio mixdown… AE will be unresponsive for a few seconds.'; S.progress = 10; _render();
      const outPath = invResp.suggestedOutPath || _defaultMixdownPath();
      const mixResp = await callExtendScript('ef_exportCompAudioMixdown', JSON.stringify({ outPath }));
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
      client_id: 'ae-captions',
      sequence_name: (S.compInfo && S.compInfo.name) || 'ae_comp',
      in_seconds: 0,
      out_seconds: (S.compInfo && S.compInfo.duration) || 0,
      language: S.language || 'auto',
      filename: audioName,
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

async function _onAudioUpload(event) {
  const file = event.target.files && event.target.files[0];
  if (!file || S.busy) return;
  S.busy = true; S.error = null; S.status = 'Uploading audio + transcribing…'; S.progress = 15; _render();
  try {
    if (!S.modelInstalled) throw new Error(`Whisper model "${S.modelName}" not installed.`);
    const resp = await apiUpload('/api/subtitles/transcribe-mixdown', file, {
      client_id: 'ae-captions',
      sequence_name: file.name,
      in_seconds: 0,
      out_seconds: 0,
      language: S.language || 'auto',
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
  S.busy = true; S.generateResult = null; S.error = null;
  S.status = smokeTest ? 'Creating test captions…' : 'Creating captions…'; S.progress = 10; _render();
  try {
    const wordsToPlace = smokeTest ? S.words.slice(0, 3) : S.words;
    S.status = `Creating ${wordsToPlace.length} word captions…`; S.progress = 30; _render();
    const cfg = _buildConfig(wordsToPlace);
    const resp = await callExtendScript('ef_createCaptions', JSON.stringify(cfg));
    S.generateResult = {
      placed: resp.placed || 0, total: wordsToPlace.length,
      groups: resp.groups || 0, errors: resp.errors || [],
      preset: resp.preset || S.preset, visualStyle: resp.visualStyle || S.visualStyle,
    };
    S.status = null; S.progress = 100;
  } catch (e) {
    S.generateResult = {
      placed: 0, total: smokeTest ? Math.min(3, S.words.length) : S.words.length,
      errors: [String(e.message || e)],
    };
    S.status = null; S.progress = 0;
  } finally { S.busy = false; _render(); }
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
  // Kick a quick preview-in-comp by creating a single test caption group at the playhead.
  try {
    if (!S.words.length) return;
    const t = S._previewTime || 0;
    const groups = _groupWordsForPreview(S.words);
    let active = groups.find((g) => t >= g.start && t < g.end) || groups[0];
    if (!active) return;
    const cfg = _buildConfig(active.words.map((w) => ({
      word: w.text, text: w.text, start: w.start, end: w.end, pill: !!w.pill,
    })));
    cfg.previewOnly = true;
    await callExtendScript('ef_createCaptions', JSON.stringify(cfg));
  } catch (e) {
    S.error = e.message || String(e);
    _render();
  }
}

function _buildConfig(words) {
  const hasPills = words.some((w) => w.pill);
  return {
    words: words.map((w) => ({
      word: w.word || w.text || '',
      text: w.word || w.text || '',
      start: w.start, end: w.end,
      pill: !!w.pill,
    })),
    visualStyle: hasPills ? 'pill' : S.visualStyle,
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
    allCaps: S.allCaps, preset: S.preset, animIntensity: S.animIntensity,
    wordEasing: S.wordEasing, fadeDur: S.fadeDur, slideDist: S.slideDist,
    pillEasing: S.pillEasing, pillScaleDur: S.pillScaleDur,
    offset: S.audioOffset || 0, replace: true,
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
  // Background
  ctx.fillStyle = '#0a0a10'; ctx.fillRect(0, 0, w, h);
  // Subtle grid
  ctx.strokeStyle = 'rgba(255,255,255,.025)'; ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath(); ctx.moveTo((w * i) / 4, 0); ctx.lineTo((w * i) / 4, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, (h * i) / 4); ctx.lineTo(w, (h * i) / 4); ctx.stroke();
  }
  if (!S.words.length) {
    ctx.fillStyle = '#5a5a6a'; ctx.font = '11px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Transcribe audio to see preview', w / 2, h / 2);
    return;
  }
  const t = S._previewTime || 0;
  const groups = _groupWordsForPreview(S.words);
  // Find active group: most recent group whose any word is visible
  let ag = null, bestStart = -1;
  for (const g of groups) {
    let vis = false;
    for (const wd of g.words) {
      if (t >= wd.start && t < wd.end + S.fadeDur) { vis = true; break; }
    }
    if (vis && g.start > bestStart) { bestStart = g.start; ag = g; }
  }
  if (!ag) {
    ctx.fillStyle = '#3a3a45'; ctx.font = '10px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(`(no caption at ${t.toFixed(2)}s)`, w / 2, h / 2);
    return;
  }

  // Font setup
  const compW = (S.compInfo && S.compInfo.width) || 1920;
  const fontSize = S.fontSize * (w / compW * 1.5);
  const fontWeight = /bold|black|heavy|semibold/i.test(S.fontPS || '') ? 'bold' : 'normal';
  const fontFamily = _fontFamilyFromPS(S.fontPS);
  ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const cx = w * (S.posX / 100), cy = h * (S.posY / 100);

  // Layout words horizontally
  const wordTexts = ag.words.map((wd) => S.allCaps ? (wd.text || '').toUpperCase() : (wd.text || ''));
  const wordWidths = wordTexts.map((txt) => ctx.measureText(txt).width);
  const spaceW = ctx.measureText(' ').width;
  const totalW = wordWidths.reduce((s, x) => s + x, 0) + spaceW * Math.max(0, wordTexts.length - 1);
  let curX = cx - totalW / 2;
  const wordPositions = [];
  for (let i = 0; i < ag.words.length; i++) {
    wordPositions.push({ x: curX + wordWidths[i] / 2, w: wordWidths[i] });
    curX += wordWidths[i] + spaceW;
  }

  const pgs = _getPillGroups(ag.words);

  // Pills (scale-up on appear)
  for (const pg of pgs) {
    const ps = _getPillScale(pg.startTime, t);
    const rs = Math.max(0.001, ps);
    let cw = 0;
    for (let i = pg.startIdx; i <= pg.endIdx; i++) {
      cw += wordWidths[i];
      if (i < pg.endIdx) cw += spaceW;
    }
    const pcx = (wordPositions[pg.startIdx].x - wordWidths[pg.startIdx] / 2
               + wordPositions[pg.endIdx].x + wordWidths[pg.endIdx] / 2) / 2;
    const padX = fontSize * 0.25, padY = fontSize * 0.12;
    const pw = (cw + padX * 2) * rs, ph = (fontSize + padY * 2) * rs;
    const r = (fontSize + padY * 2) / 2 * S.pillRadius * rs;
    const a = ps * (S.pillOpacity / 100);
    if (a < 0.01) continue;
    ctx.fillStyle = _rgbaToCss(S.pillColor, a);
    _roundRect(ctx, pcx - pw / 2, cy - ph / 2, Math.max(1, pw), Math.max(1, ph), Math.max(0, r));
    ctx.fill();
    if (S.pillStrokeWidth > 0 && ps > 0.05) {
      ctx.strokeStyle = _rgbaToCss(S.pillStrokeColor, ps);
      ctx.lineWidth = S.pillStrokeWidth * (w / 480) * rs;
      ctx.stroke();
    }
  }

  // Words (fade-up on appear)
  for (let i = 0; i < ag.words.length; i++) {
    const wd = ag.words[i];
    if (t < wd.start) continue;
    const an = _getFadeUp(wd.start, t);
    if (an.opacity <= 0.01) continue;
    const wx = wordPositions[i].x;
    const wy = cy + an.offsetY * (h / 270);
    if (S.dropShadow && an.opacity > 0.1) {
      ctx.shadowColor = _rgbaToCss(S.shadowColor, (S.shadowOpacity / 100) * an.opacity);
      ctx.shadowBlur = S.shadowBlur * (w / 480);
      ctx.shadowOffsetX = S.shadowDistance * (w / 480) * 0.7;
      ctx.shadowOffsetY = S.shadowDistance * (w / 480) * 0.7;
    } else {
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
    }
    if (S.strokeWidth > 0) {
      ctx.strokeStyle = _rgbaToCss(S.strokeColor, an.opacity);
      ctx.lineWidth = S.strokeWidth * 2 * (w / 480);
      ctx.lineJoin = 'round';
      ctx.strokeText(wordTexts[i], wx, wy);
    }
    ctx.fillStyle = _rgbaToCss(S.fillColor, an.opacity);
    ctx.fillText(wordTexts[i], wx, wy);
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
  }
}

function _applyEasing(t, type) {
  t = Math.max(0, Math.min(1, t));
  if (type === 'ease_in') return t * t;
  if (type === 'ease_out') return 1 - (1 - t) * (1 - t);
  if (type === 'ease_in_out') return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  return t; // linear
}
function _getFadeUp(wordStart, t) {
  const dt = t - wordStart;
  if (dt < 0) return { opacity: 0, offsetY: S.slideDist };
  if (dt < S.fadeDur) {
    const p = _applyEasing(dt / S.fadeDur, S.wordEasing);
    return { opacity: p, offsetY: S.slideDist * (1 - p) };
  }
  return { opacity: 1, offsetY: 0 };
}
function _getPillScale(pillStart, t) {
  const dt = t - pillStart;
  if (dt < 0) return 0;
  if (dt < S.pillScaleDur) return _applyEasing(dt / S.pillScaleDur, S.pillEasing);
  return 1;
}
function _getPillGroups(groupWords) {
  const pg = [];
  let i = 0;
  while (i < groupWords.length) {
    if (groupWords[i].pill) {
      let e = i;
      while (e + 1 < groupWords.length && groupWords[e + 1].pill) e++;
      pg.push({
        startIdx: i, endIdx: e,
        startTime: groupWords[i].start,
        endTime: groupWords[e].end,
      });
      i = e + 1;
    } else i++;
  }
  return pg;
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
  // Mirrors ef_groupWords in index.jsx for live preview
  const maxWords = Math.max(1, S.maxWordsPerSegment || 4);
  const maxChars = S.maxCharsPerSegment || 30;
  const maxDur = S.maxDurationPerSegment || 3;
  const maxGap = 0.6;
  const groups = []; let cur = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const wordText = w.word || w.text || '';
    if (!wordText) continue;
    const normalized = {
      text: wordText, start: w.start, end: w.end,
      idx: i, pill: !!w.pill,
    };
    if (cur.length === 0) { cur.push(normalized); continue; }
    const prev = cur[cur.length - 1];
    const gap = normalized.start - prev.end;
    const dur = normalized.end - cur[0].start;
    let totalChars = 0;
    for (const c of cur) totalChars += c.text.length + 1;
    totalChars += wordText.length;
    const endsSentence = /[.?!]["')\]]?\s*$/.test(prev.text);
    if (gap > maxGap || cur.length >= maxWords || dur > maxDur || totalChars > maxChars || endsSentence) {
      groups.push(_segToGroup(cur)); cur = [normalized];
    } else { cur.push(normalized); }
  }
  if (cur.length) groups.push(_segToGroup(cur));
  return groups;
}

function _segToGroup(seg) {
  let txt = '';
  for (let k = 0; k < seg.length; k++) txt += (k ? ' ' : '') + seg[k].text;
  return { words: seg, start: seg[0].start, end: seg[seg.length - 1].end, text: txt };
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

export { openCaptions, closeCaptions };
