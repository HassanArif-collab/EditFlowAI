/**
 * captions-view.js — Premium animated caption UI for EditFlow AE.
 *
 * Workflow:
 *   1. User opens a comp with audio in After Effects.
 *   2. Picks an audio source (comp audio, upload, or pasted SRT/JSON transcript).
 *   3. Backend runs Whisper → word-level timestamps.
 *   4. User picks visual style (floating / pill / highlight), layout, animation.
 *   5. Live preview canvas shows the active caption group in real time.
 *   6. Generate creates native AE text layers with the chosen animation preset.
 *
 * All caption layers are NATIVE AE text (no MOGRTs) — fully editable.
 */
import { apiGet, apiPost, apiUpload, getBaseUrl } from './api.js';
import { callExtendScript, isExtendScriptAvailable } from './extendscript.js';

const $ = (sel) => document.querySelector(sel);

const LANGUAGES = [
  ['auto', 'Auto Detect'], ['en', 'English'], ['ur', 'Urdu'], ['hi', 'Hindi'],
  ['ar', 'Arabic'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'],
  ['zh', 'Chinese'], ['ja', 'Japanese'],
];
const VISUAL_STYLES = [['floating', 'Floating'], ['pill', 'Pill Background'], ['highlight', 'Highlight Words']];
const PRESETS = [
  ['popin', 'Pop-in (Hormozi)'], ['fadeup', 'Fade Up'], ['bounce', 'Bounce'],
  ['squash', 'Squash & Stretch'], ['typewriter', 'Typewriter'], ['fade', 'Fade'],
];

/* ── State ── */
const S = {
  words: [], duration: 0, modelName: '', modelInstalled: false,
  compInfo: null, audioOffset: 0, busy: false, error: null, status: null,
  progress: 0, generateResult: null,
  visualStyle: 'floating', fontPS: 'Arial-BoldMT', fontSize: 80,
  fillColor: [1, 1, 1], strokeColor: [0, 0, 0], strokeWidth: 0,
  dropShadow: true, shadowColor: [0, 0, 0], shadowOpacity: 50, shadowDistance: 3, shadowBlur: 5,
  pillColor: [0.04, 0.1, 0.18], pillOpacity: 80, pillStrokeColor: [1, 1, 1], pillStrokeWidth: 0, pillRadius: 0.5,
  highlightTextColor: [1, 1, 0], highlightBoxColor: [0.04, 0.1, 0.18], highlightWords: [],
  posX: 50, posY: 85, maxWordsPerSegment: 4, maxCharsPerSegment: 30, maxDurationPerSegment: 3, allCaps: false,
  preset: 'popin', animIntensity: 1.0, language: 'auto',
  _previewTime: 0, _previewPlaying: false, _canvas: null, _ctx: null, _raf: null,
  fonts: [], _fontsLoaded: false, prevView: null, _showPaste: false, _pasteText: '',
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
    link.href = 'styles/captions.css?v=aecap7';
    document.head.appendChild(link);
  }
  if (!document.getElementById('cap-extra-styles')) {
    const style = document.createElement('style');
    style.id = 'cap-extra-styles'; style.textContent = _EXTRA_CSS;
    document.head.appendChild(style);
  }
}

const _EXTRA_CSS = `
details.cap-section{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:0;margin-bottom:12px;overflow:hidden;transition:border-color .2s ease}
details.cap-section[open]{border-color:rgba(255,255,255,.14)}
details.cap-section>summary{cursor:pointer;font-weight:600;font-size:13px;padding:10px 12px;list-style:none;display:flex;align-items:center;gap:8px;user-select:none;transition:background .15s ease}
details.cap-section>summary::-webkit-details-marker{display:none}
details.cap-section>summary:hover{background:rgba(255,255,255,.04)}
details.cap-section>summary::before{content:'▸';display:inline-block;width:12px;color:#9a9aa8;transition:transform .2s ease}
details.cap-section[open]>summary::before{transform:rotate(90deg)}
.cap-section-body{padding:4px 12px 12px}
.cap-header-row{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.cap-header-row h2{font-size:15px;font-weight:700;flex:1}
.cap-icon-btn{background:transparent;border:1px solid rgba(255,255,255,.12);color:#c9c9d4;padding:4px 8px;border-radius:5px;cursor:pointer;font-size:13px;transition:all .15s ease}
.cap-icon-btn:hover{background:rgba(255,255,255,.08);color:#e8e8ee}
.cap-comp-bar{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:6px;padding:6px 10px;margin-bottom:10px;font-size:11px;color:#9a9aa8;display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.cap-comp-bar strong{color:#e8e8ee;font-weight:600}
.cap-comp-bar .cap-audio-yes{color:#4ade80}
.cap-comp-bar .cap-audio-no{color:#f87171}
.cap-words-wrap{max-height:220px;overflow-y:auto;border:1px solid rgba(255,255,255,.08);border-radius:6px;background:rgba(0,0,0,.18)}
.cap-words-wrap::-webkit-scrollbar{width:8px}
.cap-words-wrap::-webkit-scrollbar-track{background:transparent}
.cap-words-wrap::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:4px}
.cap-word-row{display:grid;grid-template-columns:52px 1fr 50px 30px;gap:6px;align-items:center;padding:4px 8px;border-bottom:1px solid rgba(255,255,255,.04)}
.cap-word-row:last-child{border-bottom:none}
.cap-word-row.is-hl{background:rgba(250,204,21,.10)}
.cap-word-row .cap-ts,.cap-word-row .cap-dur{color:#6b6b7a;font:10px monospace}
.cap-word-row .cap-dur{text-align:right}
.cap-word-row input.cap-word-text{background:#15151a;color:#e8e8ee;border:1px solid rgba(255,255,255,.08);border-radius:4px;padding:3px 6px;font:11px inherit;width:100%}
.cap-word-row input.cap-word-text:focus{outline:none;border-color:#5b8def}
.cap-hl-btn{background:transparent;border:1px solid rgba(255,255,255,.12);border-radius:4px;cursor:pointer;padding:2px;font-size:12px;line-height:1;transition:all .15s ease}
.cap-hl-btn:hover{background:rgba(255,255,255,.08)}
.cap-hl-btn.is-on{background:rgba(250,204,21,.25);border-color:rgba(250,204,21,.5)}
.cap-words-toolbar{display:flex;gap:6px;margin:8px 0;flex-wrap:wrap;align-items:center}
.cap-words-count{margin-left:auto;color:#9a9aa8;font-size:11px}
.cap-field{display:flex;align-items:center;gap:8px;margin:6px 0}
.cap-field-label{min-width:92px;color:#9a9aa8;font-size:11px}
.cap-field-value{color:#9a9aa8;font-size:11px;min-width:38px;text-align:right;font-family:monospace}
.cap-field select,.cap-field input[type="text"],.cap-field input[type="number"]{background:#15151a;color:#e8e8ee;border:1px solid rgba(255,255,255,.12);border-radius:5px;padding:4px 8px;flex:1;font:12px inherit}
.cap-field select:focus,.cap-field input:focus{outline:none;border-color:#5b8def}
.cap-field input[type="range"]{flex:1}
.cap-field input[type="color"]{width:36px;height:26px;border:1px solid rgba(255,255,255,.12);border-radius:4px;cursor:pointer;background:transparent;padding:0}
.cap-field input[type="checkbox"]{width:16px;height:16px;cursor:pointer}
.cap-subgroup{margin-top:8px;padding:8px 10px;background:rgba(0,0,0,.18);border-radius:5px;border-left:2px solid rgba(91,141,239,.4)}
.cap-subgroup-title{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#6b6b7a;margin-bottom:4px}
.cap-style-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin:6px 0}
.cap-style-option{background:#15151a;border:1px solid rgba(255,255,255,.10);border-radius:5px;padding:8px 6px;cursor:pointer;text-align:center;font-size:11px;color:#c9c9d4;transition:all .15s ease}
.cap-style-option:hover{background:#1d1d24}
.cap-style-option.is-active{background:rgba(91,141,239,.15);border-color:#5b8def;color:#e8e8ee}
.cap-actions{display:flex;gap:8px;flex-wrap:wrap}
.cap-btn{background:#1a1a22;color:#e8e8ee;border:1px solid rgba(255,255,255,.14);border-radius:6px;padding:6px 14px;cursor:pointer;font:inherit;transition:all .15s ease}
.cap-btn:hover:not(:disabled){background:#23232e;transform:translateY(-1px)}
.cap-btn:active:not(:disabled){transform:translateY(0)}
.cap-btn:disabled{opacity:.5;cursor:not-allowed}
.cap-primary{background:#2563eb;border-color:#2563eb}
.cap-primary:hover:not(:disabled){background:#1d4ed8}
.cap-ghost{background:transparent}
.cap-danger{background:transparent;border-color:#5a2d2d;color:#e57373}
.cap-danger:hover:not(:disabled){background:#3a1d1d}
.cap-btn-tiny{padding:3px 10px;font-size:11px}
.cap-status{display:block;margin-top:8px;word-break:break-word;font-size:12px}
.cap-status-progress{color:#facc15}
.cap-status.cap-err{color:#f87171}
.cap-status.cap-ok{color:#4ade80}
.cap-progress-bar{position:relative;background:#1a1a22;border:1px solid rgba(255,255,255,.1);border-radius:4px;height:20px;margin:8px 0;overflow:hidden}
.cap-progress-fill{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,#2563eb,#3b82f6);transition:width .3s ease}
.cap-progress-text{position:absolute;left:0;right:0;top:0;bottom:0;display:flex;align-items:center;justify-content:center;color:#fff;font:600 11px monospace;text-shadow:0 1px 2px rgba(0,0,0,.5)}
.cap-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.05);color:#c9c9d4}
.cap-pill-ok{background:rgba(34,197,94,.15);border-color:rgba(34,197,94,.4);color:#4ade80}
.cap-pill-err{background:rgba(239,68,68,.15);border-color:rgba(239,68,68,.4);color:#f87171}
.cap-pill-warn{background:rgba(234,179,8,.15);border-color:rgba(234,179,8,.4);color:#facc15}
.cap-preview-container{background:#000;border:1px solid rgba(255,255,255,.1);border-radius:6px;overflow:hidden;margin-bottom:6px;aspect-ratio:16/9}
.cap-preview-container canvas{width:100%;height:100%;display:block}
.cap-preview-controls{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.cap-preview-controls input[type="range"]{flex:1}
.cap-preview-time{font:11px monospace;color:#9a9aa8;min-width:86px;text-align:right}
.cap-result{margin-top:10px;padding:8px 10px;background:rgba(255,255,255,.04);border-radius:5px;font-size:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.cap-drawer{width:100%;margin-top:4px}
.cap-drawer summary{cursor:pointer;color:#9a9aa8;font-size:11px}
.cap-error-list{margin:4px 0 0;padding-left:18px;color:#f87171;font-size:11px}
.cap-paste-area{margin-top:8px}
.cap-paste-area textarea{width:100%;min-height:100px;background:#15151a;color:#e8e8ee;border:1px solid rgba(255,255,255,.12);border-radius:5px;padding:6px 8px;font:11px monospace;resize:vertical}
.cap-paste-area textarea:focus{outline:none;border-color:#5b8def}
.cap-hint{color:#9a9aa8;font-size:11px;line-height:1.5;margin:4px 0 8px}
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
  const detailsState = _saveDetailsState();
  S._canvas = null; S._ctx = null;
  if (S._raf) { cancelAnimationFrame(S._raf); S._raf = null; }
  v.innerHTML = _buildHTML();
  _restoreDetailsState(detailsState);
  _wireHeader(v); _wirePreview(v); _wireAudio(v); _wireWords(v);
  _wireVisualStyle(v); _wireLayout(v); _wireAnimation(v); _wireGenerate(v);
  S._canvas = v.querySelector('#cap-preview-canvas');
  S._ctx = S._canvas ? S._canvas.getContext('2d') : null;
  _updatePreview();
  _startPreviewLoop();
}

function _saveDetailsState() {
  const map = {};
  document.querySelectorAll('details.cap-section[data-section]').forEach((d) => { map[d.dataset.section] = d.open; });
  return map;
}
function _restoreDetailsState(map) {
  document.querySelectorAll('details.cap-section[data-section]').forEach((d) => {
    if (map[d.dataset.section] !== undefined) d.open = !!map[d.dataset.section];
  });
}

function _buildHTML() {
  return [
    _renderHeader(), _renderCompBar(), _renderPreview(),
    _renderAudioSection(),
    S.words.length ? _renderWordsSection() : '',
    _renderVisualStyleSection(), _renderLayoutSection(),
    _renderAnimationSection(), _renderGenerateSection(),
  ].join('');
}

function _renderHeader() {
  let pillText, pillCls;
  if (S.modelInstalled) { pillText = `whisper: ${S.modelName} ✓`; pillCls = 'cap-pill cap-pill-ok'; }
  else if (S.modelName) { pillText = `whisper: ${S.modelName} (missing)`; pillCls = 'cap-pill cap-pill-err'; }
  else { pillText = 'whisper: offline'; pillCls = 'cap-pill cap-pill-err'; }
  return `<div class="cap-header-row">
    <h2>Animated Captions</h2>
    <span id="cap-model-pill" class="${pillCls}">${_esc(pillText)}</span>
    <button id="cap-btn-settings" class="cap-icon-btn" title="Settings">&#9881;</button>
    <button id="cap-btn-close" class="cap-icon-btn" title="Close panel">✕</button>
  </div>`;
}

function _renderCompBar() {
  if (!S.compInfo) return `<div class="cap-comp-bar"><span>No active composition. Open a comp in AE.</span></div>`;
  if (S.compInfo.error) return `<div class="cap-comp-bar"><span style="color:#f87171;">Error: ${_esc(S.compInfo.error)}</span></div>`;
  const ci = S.compInfo;
  return `<div class="cap-comp-bar">
    <strong>${_esc(ci.name)}</strong><span>${ci.width}×${ci.height}</span>
    <span>${(ci.duration || 0).toFixed(1)}s</span><span>${(ci.frameRate || 0).toFixed(1)} fps</span>
    <span>${ci.numLayers || 0} layers</span>
    <span class="${ci.hasAudio ? 'cap-audio-yes' : 'cap-audio-no'}">${ci.hasAudio ? '✓ has audio' : '⚠ no audio'}</span>
  </div>`;
}

function _renderPreview() {
  const t = S._previewTime || 0, dur = S.duration || 0;
  const dis = !S.words.length ? 'disabled' : '';
  return `<div class="cap-preview-container"><canvas id="cap-preview-canvas" width="480" height="270"></canvas></div>
  <div class="cap-preview-controls">
    <button id="cap-preview-play" class="cap-btn cap-btn-tiny" ${dis}>${S._previewPlaying ? '⏸' : '▶'}</button>
    <input type="range" id="cap-preview-seek" min="0" max="${dur}" step="0.01" value="${t}" ${dis} />
    <span class="cap-preview-time">${t.toFixed(2)} / ${dur.toFixed(2)}s</span>
  </div>`;
}

function _renderAudioSection() {
  const td = S.busy || !S.compInfo || S.compInfo.error || !S.compInfo.hasAudio;
  return `<details class="cap-section" data-section="audio" open><summary>Audio Source</summary>
    <div class="cap-section-body">
      <p class="cap-hint">Pick where the captions come from. "Transcribe from Comp" uses the selected audio layer; "Upload Audio" works for any WAV/MP3; "Paste Transcript" accepts SRT or JSON.</p>
      <div class="cap-actions">
        <button id="cap-transcribe-btn" class="cap-btn cap-primary" ${td ? 'disabled' : ''}>${S.busy ? 'Working…' : 'Transcribe from Comp'}</button>
        <label class="cap-btn cap-ghost" style="cursor:pointer" title="Upload WAV/MP3/M4A">Upload Audio<input type="file" id="cap-audio-upload" accept=".wav,.mp3,.m4a,audio/*" style="display:none" /></label>
        <button id="cap-paste-btn" class="cap-btn cap-ghost" ${S.busy ? 'disabled' : ''}>Paste Transcript</button>
      </div>
      <div class="cap-field" style="margin-top:8px;">
        <label class="cap-field-label">Language</label>
        <select id="cap-language">${LANGUAGES.map((l) => `<option value="${l[0]}" ${S.language === l[0] ? 'selected' : ''}>${_esc(l[1])}</option>`).join('')}</select>
      </div>
      ${S._showPaste ? `<div class="cap-paste-area">
        <textarea id="cap-paste-text" placeholder="Paste SRT cues or a JSON array of {word,start,end} objects...">${_esc(S._pasteText)}</textarea>
        <div class="cap-actions" style="margin-top:6px;">
          <button id="cap-paste-parse" class="cap-btn cap-primary">Use This Transcript</button>
          <button id="cap-paste-cancel" class="cap-btn cap-ghost">Cancel</button>
        </div></div>` : ''}
      ${S.status ? `<div class="cap-status cap-status-progress">${_esc(S.status)}</div>` : ''}
      ${S.busy && S.progress > 0 ? `<div class="cap-progress-bar"><div class="cap-progress-fill" style="width: ${S.progress}%"></div><span class="cap-progress-text">${S.progress}%</span></div>` : ''}
      ${S.error ? `<div class="cap-status cap-err">${_esc(S.error)}</div>` : ''}
      ${S.words.length && S.duration ? `<div class="cap-status cap-ok">✓ ${S.words.length} words transcribed · ${S.duration.toFixed(1)}s</div>` : ''}
    </div></details>`;
}

function _renderWordsSection() {
  const rows = S.words.map((w, i) => _renderWordRow(w, i)).join('');
  return `<details class="cap-section" data-section="words" open><summary>Caption Content <span class="cap-pill" style="margin-left:6px;">${S.words.length} words</span></summary>
    <div class="cap-section-body">
      <div class="cap-words-toolbar">
        <button id="cap-hl-all" class="cap-btn cap-btn-tiny">Highlight All</button>
        <button id="cap-hl-clear" class="cap-btn cap-btn-tiny">Clear Highlights</button>
        <span class="cap-words-count">${S.highlightWords.length} highlighted</span>
      </div>
      <div class="cap-words-wrap" id="cap-words-list">${rows}</div>
      <p class="cap-hint" style="margin-top:6px;">Edit any word's text inline. Click ✨ to mark a word for the Highlight style — it'll get a colored box when "Highlight Words" is selected.</p>
    </div></details>`;
}

function _renderWordRow(w, i) {
  const start = w.start || 0, end = w.end || 0;
  const isHl = S.highlightWords.indexOf(i) !== -1;
  const text = w.word || w.text || '';
  return `<div class="cap-word-row ${isHl ? 'is-hl' : ''}" data-idx="${i}">
    <span class="cap-ts">${start.toFixed(2)}</span>
    <input type="text" class="cap-word-text" data-idx="${i}" value="${_esc(text)}" />
    <span class="cap-dur">${(end - start).toFixed(2)}s</span>
    <button class="cap-hl-btn ${isHl ? 'is-on' : ''}" data-idx="${i}" title="Toggle highlight">${isHl ? '✨' : '⬜'}</button>
  </div>`;
}

function _renderVisualStyleSection() {
  const opts = VISUAL_STYLES.map((s) => `<div class="cap-style-option ${S.visualStyle === s[0] ? 'is-active' : ''}" data-style="${s[0]}">${_esc(s[1])}</div>`).join('');
  return `<details class="cap-section" data-section="style" open><summary>Visual Style</summary>
    <div class="cap-section-body">
      <div class="cap-style-grid" id="cap-style-grid">${opts}</div>
      ${_renderFontField()}
      ${_field('range', 'cap-font-size', 'Font Size', S.fontSize, `min="20" max="200"`, `${S.fontSize}px`)}
      ${_fieldColor('cap-fill-color', 'Text Color', S.fillColor)}
      <div class="cap-field"><label class="cap-field-label">Outline Color</label><input type="color" id="cap-stroke-color" value="${_rgbToHex(S.strokeColor)}" /><input type="range" id="cap-stroke-width" min="0" max="10" value="${S.strokeWidth}" /><span class="cap-field-value" id="cap-stroke-width-val">${S.strokeWidth}</span></div>
      <div class="cap-field"><label class="cap-field-label">Drop Shadow</label><input type="checkbox" id="cap-drop-shadow" ${S.dropShadow ? 'checked' : ''} /></div>
      ${S.dropShadow ? `<div class="cap-subgroup"><div class="cap-subgroup-title">Shadow Controls</div>
        ${_fieldColor('cap-shadow-color', 'Color', S.shadowColor)}
        ${_field('range', 'cap-shadow-opacity', 'Opacity', S.shadowOpacity, `min="0" max="100"`, `${S.shadowOpacity}%`)}
        ${_field('range', 'cap-shadow-distance', 'Distance', S.shadowDistance, `min="0" max="50"`, String(S.shadowDistance))}
        ${_field('range', 'cap-shadow-blur', 'Blur', S.shadowBlur, `min="0" max="50"`, String(S.shadowBlur))}
      </div>` : ''}
      ${S.visualStyle === 'pill' ? `<div class="cap-subgroup"><div class="cap-subgroup-title">Pill Background</div>
        ${_fieldColor('cap-pill-color', 'BG Color', S.pillColor)}
        ${_field('range', 'cap-pill-opacity', 'BG Opacity', S.pillOpacity, `min="0" max="100"`, `${S.pillOpacity}%`)}
        ${_fieldColor('cap-pill-stroke-color', 'Border Color', S.pillStrokeColor)}
        ${_field('range', 'cap-pill-stroke-width', 'Border Width', S.pillStrokeWidth, `min="0" max="20"`, String(S.pillStrokeWidth))}
        ${_field('range', 'cap-pill-radius', 'Corner Radius', S.pillRadius, `min="0" max="1" step="0.05"`, S.pillRadius.toFixed(2))}
      </div>` : ''}
      ${S.visualStyle === 'highlight' ? `<div class="cap-subgroup"><div class="cap-subgroup-title">Highlight Style</div>
        ${_fieldColor('cap-hl-text-color', 'Highlight Text', S.highlightTextColor)}
        ${_fieldColor('cap-hl-box-color', 'Highlight Box', S.highlightBoxColor)}
        <p class="cap-hint">Mark words with ✨ in the Caption Content section above.</p>
      </div>` : ''}
    </div></details>`;
}

function _renderFontField() {
  if (!S._fontsLoaded || !S.fonts.length) {
    return `<div class="cap-field"><label class="cap-field-label">Font (PS name)</label><input type="text" id="cap-font-ps" value="${_esc(S.fontPS)}" placeholder="Arial-BoldMT" /></div>`;
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
  return `<div class="cap-field"><label class="cap-field-label">Font</label><select id="cap-font-ps-select">${customOpt}${optgroups}</select></div>`;
}

function _field(type, id, label, value, extraAttrs, valDisplay) {
  return `<div class="cap-field"><label class="cap-field-label">${_esc(label)}</label><input type="${type}" id="${id}" value="${value}" ${extraAttrs || ''} />${valDisplay ? `<span class="cap-field-value" id="${id}-val">${valDisplay}</span>` : ''}</div>`;
}
function _fieldColor(id, label, rgb) {
  return `<div class="cap-field"><label class="cap-field-label">${_esc(label)}</label><input type="color" id="${id}" value="${_rgbToHex(rgb)}" /></div>`;
}
function _fieldCheckbox(id, label, checked) {
  return `<div class="cap-field"><label class="cap-field-label">${_esc(label)}</label><input type="checkbox" id="${id}" ${checked ? 'checked' : ''} /></div>`;
}

function _renderLayoutSection() {
  return `<details class="cap-section" data-section="layout"><summary>Layout &amp; Timing</summary>
    <div class="cap-section-body">
      ${_field('range', 'cap-pos-x', 'Position X', S.posX, `min="0" max="100"`, `${S.posX}%`)}
      ${_field('range', 'cap-pos-y', 'Position Y', S.posY, `min="0" max="100"`, `${S.posY}%`)}
      ${_field('range', 'cap-max-words', 'Max Words/Seg', S.maxWordsPerSegment, `min="1" max="8"`, String(S.maxWordsPerSegment))}
      ${_field('number', 'cap-max-chars', 'Max Chars/Seg', S.maxCharsPerSegment, `min="10" max="80"`)}
      ${_field('number', 'cap-max-dur', 'Max Dur/Seg (s)', S.maxDurationPerSegment, `min="1" max="10" step="0.5"`)}
      ${_fieldCheckbox('cap-all-caps', 'UPPERCASE', S.allCaps)}
    </div></details>`;
}

function _renderAnimationSection() {
  const opts = PRESETS.map((p) => `<option value="${p[0]}" ${S.preset === p[0] ? 'selected' : ''}>${_esc(p[1])}</option>`).join('');
  return `<details class="cap-section" data-section="anim"><summary>Animation</summary>
    <div class="cap-section-body">
      <div class="cap-field"><label class="cap-field-label">Preset</label><select id="cap-preset">${opts}</select></div>
      ${_field('range', 'cap-anim-intensity', 'Intensity', S.animIntensity, `min="0.5" max="2.0" step="0.05"`, `${S.animIntensity.toFixed(2)}×`)}
      <p class="cap-hint">Intensity controls spring/bounce strength. Higher = snappier pop.</p>
    </div></details>`;
}

function _renderGenerateSection() {
  return `<details class="cap-section" data-section="gen" open><summary>Generate</summary>
    <div class="cap-section-body">
      <div class="cap-actions">
        <button id="cap-clear-btn" class="cap-btn cap-danger" ${S.busy ? 'disabled' : ''}>Clear Existing</button>
        <button id="cap-smoke-btn" class="cap-btn" ${!S.words.length || S.busy ? 'disabled' : ''}>Smoke Test (3 words)</button>
        <button id="cap-generate-btn" class="cap-btn cap-primary" ${!S.words.length || S.busy ? 'disabled' : ''}>Generate All (${S.words.length} words)</button>
      </div>
      ${S.generateResult ? _renderResult() : ''}
    </div></details>`;
}

function _renderResult() {
  const r = S.generateResult;
  const cls = r.placed === r.total ? 'cap-pill-ok' : (r.placed > 0 ? 'cap-pill-warn' : 'cap-pill-err');
  const errList = (r.errors || []).slice(0, 8).map((e) => `<li>${_esc(typeof e === 'string' ? e : JSON.stringify(e))}</li>`).join('');
  return `<div class="cap-result">
    <span class="cap-pill ${cls}">${r.placed}/${r.total} placed</span>
    ${r.groups ? `<span style="color:#9a9aa8;">${r.groups} groups</span>` : ''}
    ${r.preset ? `<span style="color:#9a9aa8;">${_esc(r.preset)}</span>` : ''}
    ${r.visualStyle ? `<span style="color:#9a9aa8;">${_esc(r.visualStyle)}</span>` : ''}
    ${r.errors && r.errors.length ? `<details class="cap-drawer"><summary>${r.errors.length} error${r.errors.length === 1 ? '' : 's'}</summary><ul class="cap-error-list">${errList}</ul></details>` : ''}
  </div>`;
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

function _wirePreview(v) {
  const playBtn = v.querySelector('#cap-preview-play');
  if (playBtn) playBtn.onclick = _togglePreview;
  const seek = v.querySelector('#cap-preview-seek');
  if (seek) seek.oninput = (e) => { S._previewTime = parseFloat(e.target.value); _updatePreview(); _updatePreviewTimeLabel(); };
}

function _wireAudio(v) {
  const t = v.querySelector('#cap-transcribe-btn'); if (t) t.onclick = _onTranscribe;
  const u = v.querySelector('#cap-audio-upload'); if (u) u.onchange = _onAudioUpload;
  const p = v.querySelector('#cap-paste-btn');
  if (p) p.onclick = () => { S._showPaste = true; _render(); const ta = document.querySelector('#cap-paste-text'); if (ta) setTimeout(() => ta.focus(), 0); };
  const pc = v.querySelector('#cap-paste-cancel');
  if (pc) pc.onclick = () => { S._showPaste = false; S._pasteText = ''; _render(); };
  const pp = v.querySelector('#cap-paste-parse'); if (pp) pp.onclick = _onPasteParse;
  const pt = v.querySelector('#cap-paste-text'); if (pt) pt.oninput = (e) => { S._pasteText = e.target.value; };
  const ls = v.querySelector('#cap-language'); if (ls) ls.onchange = (e) => { S.language = e.target.value; };
}

function _wireWords(v) {
  const hlAll = v.querySelector('#cap-hl-all');
  if (hlAll) hlAll.onclick = () => { S.highlightWords = S.words.map((_, i) => i); _refreshAllRows(); _updatePreview(); };
  const hlClear = v.querySelector('#cap-hl-clear');
  if (hlClear) hlClear.onclick = () => { S.highlightWords = []; _refreshAllRows(); _updatePreview(); };
  v.querySelectorAll('.cap-word-text').forEach((input) => {
    input.oninput = (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      if (!isNaN(idx) && S.words[idx]) {
        S.words[idx].word = e.target.value;
        S.words[idx].text = e.target.value;
        _updatePreview();
      }
    };
  });
  v.querySelectorAll('.cap-hl-btn').forEach((btn) => {
    btn.onclick = (e) => {
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      if (isNaN(idx)) return;
      const pos = S.highlightWords.indexOf(idx);
      if (pos === -1) S.highlightWords.push(idx); else S.highlightWords.splice(pos, 1);
      _refreshWordRow(idx);
      _updatePreview();
    };
  });
}

function _refreshWordRow(idx) {
  const row = document.querySelector(`.cap-word-row[data-idx="${idx}"]`);
  if (!row) return;
  const isHl = S.highlightWords.indexOf(idx) !== -1;
  row.classList.toggle('is-hl', isHl);
  const btn = row.querySelector('.cap-hl-btn');
  if (btn) { btn.classList.toggle('is-on', isHl); btn.textContent = isHl ? '✨' : '⬜'; }
  _refreshHighlightCount();
}
function _refreshAllRows() {
  document.querySelectorAll('.cap-word-row').forEach((row) => {
    const idx = parseInt(row.dataset.idx, 10);
    const isHl = S.highlightWords.indexOf(idx) !== -1;
    row.classList.toggle('is-hl', isHl);
    const btn = row.querySelector('.cap-hl-btn');
    if (btn) { btn.classList.toggle('is-on', isHl); btn.textContent = isHl ? '✨' : '⬜'; }
  });
  _refreshHighlightCount();
}
function _refreshHighlightCount() {
  const c = document.querySelector('.cap-words-count');
  if (c) c.textContent = `${S.highlightWords.length} highlighted`;
}

function _wireVisualStyle(v) {
  v.querySelectorAll('.cap-style-option').forEach((opt) => {
    opt.onclick = (e) => { S.visualStyle = e.currentTarget.dataset.style; _render(); _updatePreview(); };
  });
  const fontSelect = v.querySelector('#cap-font-ps-select');
  if (fontSelect) fontSelect.onchange = (e) => { S.fontPS = e.target.value; _updatePreview(); };
  const fontInput = v.querySelector('#cap-font-ps');
  if (fontInput) fontInput.onchange = (e) => { S.fontPS = e.target.value || 'Arial-BoldMT'; _updatePreview(); };

  _wireRange(v, '#cap-font-size', (val) => { S.fontSize = parseInt(val, 10); return S.fontSize + 'px'; });
  _wireColor(v, '#cap-fill-color', (c) => { S.fillColor = c; });
  _wireColor(v, '#cap-stroke-color', (c) => { S.strokeColor = c; });
  _wireRange(v, '#cap-stroke-width', (val) => { S.strokeWidth = parseInt(val, 10); return String(S.strokeWidth); });

  const dsc = v.querySelector('#cap-drop-shadow');
  if (dsc) dsc.onchange = (e) => { S.dropShadow = e.target.checked; _render(); _updatePreview(); };
  _wireColor(v, '#cap-shadow-color', (c) => { S.shadowColor = c; });
  _wireRange(v, '#cap-shadow-opacity', (val) => { S.shadowOpacity = parseInt(val, 10); return S.shadowOpacity + '%'; });
  _wireRange(v, '#cap-shadow-distance', (val) => { S.shadowDistance = parseInt(val, 10); return String(S.shadowDistance); });
  _wireRange(v, '#cap-shadow-blur', (val) => { S.shadowBlur = parseInt(val, 10); return String(S.shadowBlur); });

  _wireColor(v, '#cap-pill-color', (c) => { S.pillColor = c; });
  _wireRange(v, '#cap-pill-opacity', (val) => { S.pillOpacity = parseInt(val, 10); return S.pillOpacity + '%'; });
  _wireColor(v, '#cap-pill-stroke-color', (c) => { S.pillStrokeColor = c; });
  _wireRange(v, '#cap-pill-stroke-width', (val) => { S.pillStrokeWidth = parseInt(val, 10); return String(S.pillStrokeWidth); });
  _wireRange(v, '#cap-pill-radius', (val) => { S.pillRadius = parseFloat(val); return S.pillRadius.toFixed(2); });

  _wireColor(v, '#cap-hl-text-color', (c) => { S.highlightTextColor = c; });
  _wireColor(v, '#cap-hl-box-color', (c) => { S.highlightBoxColor = c; });
}

function _wireLayout(v) {
  _wireRange(v, '#cap-pos-x', (val) => { S.posX = parseInt(val, 10); return S.posX + '%'; });
  _wireRange(v, '#cap-pos-y', (val) => { S.posY = parseInt(val, 10); return S.posY + '%'; });
  _wireRange(v, '#cap-max-words', (val) => { S.maxWordsPerSegment = parseInt(val, 10); return String(S.maxWordsPerSegment); });
  const mc = v.querySelector('#cap-max-chars');
  if (mc) mc.onchange = (e) => { S.maxCharsPerSegment = Math.max(10, Math.min(80, parseInt(e.target.value, 10) || 30)); _updatePreview(); };
  const md = v.querySelector('#cap-max-dur');
  if (md) md.onchange = (e) => { S.maxDurationPerSegment = Math.max(1, Math.min(10, parseFloat(e.target.value) || 3)); _updatePreview(); };
  const ac = v.querySelector('#cap-all-caps');
  if (ac) ac.onchange = (e) => { S.allCaps = e.target.checked; _updatePreview(); };
}

function _wireAnimation(v) {
  const ps = v.querySelector('#cap-preset');
  if (ps) ps.onchange = (e) => { S.preset = e.target.value; _updatePreview(); };
  _wireRange(v, '#cap-anim-intensity', (val) => { S.animIntensity = parseFloat(val); return S.animIntensity.toFixed(2) + '×'; });
}

function _wireGenerate(v) {
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
  const pill = $('#cap-model-pill');
  if (!pill) return;
  try {
    const r = await apiGet('/api/whisper/status', { timeoutMs: 8000 });
    S.modelName = r.active_model || '';
    const installed = (r.supported_models || []).find((m) => m.name === S.modelName);
    S.modelInstalled = !!(installed && installed.installed);
    if (S.modelInstalled) { pill.textContent = `whisper: ${S.modelName} ✓`; pill.className = 'cap-pill cap-pill-ok'; }
    else if (S.modelName) { pill.textContent = `whisper: ${S.modelName} (missing)`; pill.className = 'cap-pill cap-pill-err'; }
    else { pill.textContent = 'whisper: offline'; pill.className = 'cap-pill cap-pill-err'; }
  } catch (e) {
    pill.textContent = 'whisper: offline'; pill.className = 'cap-pill cap-pill-err';
  }
}

async function _refreshCompInfo() {
  try {
    if (!isExtendScriptAvailable()) return;
    const resp = await callExtendScript('ef_getCompInfo');
    if (resp && !resp.error) {
      const changed = !S.compInfo || JSON.stringify(S.compInfo) !== JSON.stringify(resp);
      S.compInfo = resp;
      if (changed) _render();
    } else {
      const err = (resp && resp.error) || 'Unknown error';
      if (!S.compInfo || S.compInfo.error !== err) { S.compInfo = { error: err }; _render(); }
    }
  } catch (e) {
    if (!S.compInfo || S.compInfo.error !== e.message) { S.compInfo = { error: e.message }; _render(); }
  }
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
  S.busy = true; S.error = null; S.status = 'Getting audio from comp...'; S.progress = 5; _render();
  try {
    if (!S.modelInstalled) throw new Error(`Whisper model "${S.modelName}" not installed. Open Settings to download.`);
    S.status = 'Extracting audio path from comp...'; _render();
    const audioResp = await callExtendScript('ef_getAudioPath');
    if (!audioResp || audioResp.error || !audioResp.path) {
      throw new Error((audioResp && audioResp.error) || 'No audio found in the active comp.');
    }
    S.audioOffset = audioResp.offset || 0;
    S.status = 'Uploading audio + transcribing with Whisper...'; S.progress = 15; _render();
    const audioBlob = await _readFileAsBlob(audioResp.path);
    const resp = await apiUpload('/api/subtitles/transcribe-mixdown', audioBlob, {
      client_id: 'ae-captions',
      sequence_name: (S.compInfo && S.compInfo.name) || 'ae_comp',
      in_seconds: 0,
      out_seconds: (S.compInfo && S.compInfo.duration) || 0,
      language: S.language || 'auto',
    }, { timeoutMs: 600000 });
    S.words = resp.words || []; S.duration = resp.duration || 0;
    S.status = null; S.progress = 100; S._previewTime = 0; S.highlightWords = [];
    if (!S.words.length) throw new Error('Transcription completed but no words found. The audio may be too quiet.');
  } catch (e) {
    S.error = e.message || String(e); S.status = null; S.progress = 0;
  } finally { S.busy = false; _render(); }
}

async function _onAudioUpload(event) {
  const file = event.target.files[0];
  if (!file || S.busy) return;
  S.busy = true; S.error = null; S.status = 'Uploading audio + transcribing...'; S.progress = 15; _render();
  try {
    if (!S.modelInstalled) throw new Error(`Whisper model "${S.modelName}" not installed.`);
    const resp = await apiUpload('/api/subtitles/transcribe-mixdown', file, {
      client_id: 'ae-captions',
      sequence_name: file.name,
      in_seconds: 0,
      out_seconds: 0,
      language: S.language || 'auto',
    }, { timeoutMs: 600000 });
    S.words = resp.words || []; S.duration = resp.duration || 0;
    S.status = null; S.progress = 100; S._previewTime = 0; S.highlightWords = []; S.audioOffset = 0;
    if (!S.words.length) throw new Error('No words found in transcription.');
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
    S.words = words;
    S.duration = words[words.length - 1].end || 0;
    S.error = null; S._showPaste = false; S._pasteText = '';
    S._previewTime = 0; S.highlightWords = []; S.audioOffset = 0;
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
  S.status = smokeTest ? 'Creating test captions...' : 'Creating captions...'; S.progress = 10; _render();
  try {
    const wordsToPlace = smokeTest ? S.words.slice(0, 3) : S.words;
    S.status = `Creating ${wordsToPlace.length} word captions...`; S.progress = 30; _render();
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

function _buildConfig(words) {
  return {
    words: words.map((w) => ({ word: w.word || w.text || '', text: w.word || w.text || '', start: w.start, end: w.end })),
    visualStyle: S.visualStyle, fontPS: S.fontPS, fontSize: S.fontSize,
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
  function loop() {
    if (S._previewPlaying && S.words.length) {
      S._previewTime = (S._previewTime || 0) + 1 / 30;
      if (S._previewTime >= S.duration) {
        S._previewTime = S.duration; S._previewPlaying = false;
        const btn = $('#cap-preview-play'); if (btn) btn.textContent = '▶';
      }
      _updatePreview();
      _updatePreviewTimeLabel();
    }
    S._raf = requestAnimationFrame(loop);
  }
  S._raf = requestAnimationFrame(loop);
}

function _updatePreviewTimeLabel() {
  const el = document.querySelector('.cap-preview-time');
  if (el) el.textContent = `${(S._previewTime || 0).toFixed(2)} / ${(S.duration || 0).toFixed(2)}s`;
  const seek = $('#cap-preview-seek');
  if (seek && document.activeElement !== seek) seek.value = S._previewTime || 0;
}

function _updatePreview() {
  if (!S._ctx) return;
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
  let activeGroup = null;
  for (const g of groups) { if (t >= g.start && t < g.end) { activeGroup = g; break; } }
  if (!activeGroup) {
    ctx.fillStyle = '#3a3a45'; ctx.font = '10px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(`(no caption at ${t.toFixed(2)}s)`, w / 2, h / 2);
    return;
  }
  const groupDur = Math.max(0.1, activeGroup.end - activeGroup.start);
  const progress = (t - activeGroup.start) / groupDur;
  const anim = _computePreviewAnim(S.preset, Math.min(1, Math.max(0, progress)), S.animIntensity);

  const compW = (S.compInfo && S.compInfo.width) || 1920;
  const fontScale = w / compW;
  const fontSize = S.fontSize * fontScale * 1.2;
  const fontWeight = /bold|black|heavy|semibold/i.test(S.fontPS || '') ? 'bold' : 'normal';
  const fontFamily = _fontFamilyFromPS(S.fontPS);
  ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const cx = w * (S.posX / 100), cy = h * (S.posY / 100);

  if (S.visualStyle === 'pill') _drawPillPreview(ctx, activeGroup, cx, cy, fontSize, anim, w);
  else if (S.visualStyle === 'highlight') _drawHighlightPreview(ctx, activeGroup, cx, cy, fontSize, anim, w);
  else _drawFloatingPreview(ctx, activeGroup, cx, cy, fontSize, anim, w);
}

function _drawFloatingPreview(ctx, g, cx, cy, fontSize, anim, canvasW) {
  const text = S.allCaps ? g.text.toUpperCase() : g.text;
  ctx.save();
  ctx.translate(cx, cy); ctx.scale(anim.scale, anim.scale); ctx.globalAlpha = anim.opacity;
  if (S.dropShadow) {
    ctx.shadowColor = _rgbaToCss(S.shadowColor, S.shadowOpacity / 100);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = S.shadowDistance * (canvasW / 480) * 0.5;
    ctx.shadowBlur = S.shadowBlur * (canvasW / 480) * 0.5;
  }
  if (S.strokeWidth > 0) {
    ctx.strokeStyle = _rgbToCss(S.strokeColor);
    ctx.lineWidth = S.strokeWidth * 2 * (canvasW / 480);
    ctx.lineJoin = 'round'; ctx.strokeText(text, 0, 0);
  }
  ctx.fillStyle = _rgbToCss(S.fillColor); ctx.fillText(text, 0, 0);
  ctx.restore();
}

function _drawPillPreview(ctx, g, cx, cy, fontSize, anim, canvasW) {
  const text = S.allCaps ? g.text.toUpperCase() : g.text;
  ctx.save();
  ctx.translate(cx, cy); ctx.scale(anim.scale, anim.scale); ctx.globalAlpha = anim.opacity;
  const metrics = ctx.measureText(text);
  const textW = metrics.width, textH = fontSize * 0.9;
  const padX = fontSize * 0.3, padY = fontSize * 0.15;
  const boxW = textW + padX * 2, boxH = textH + padY * 2;
  const radius = (boxH / 2) * S.pillRadius;
  // Pill background
  ctx.save();
  ctx.globalAlpha = (anim.opacity || 1) * (S.pillOpacity / 100);
  ctx.fillStyle = _rgbToCss(S.pillColor);
  _roundRect(ctx, -boxW / 2, -boxH / 2, boxW, boxH, radius); ctx.fill();
  if (S.pillStrokeWidth > 0) {
    ctx.globalAlpha = anim.opacity || 1;
    ctx.strokeStyle = _rgbToCss(S.pillStrokeColor);
    ctx.lineWidth = S.pillStrokeWidth * (canvasW / 480);
    _roundRect(ctx, -boxW / 2, -boxH / 2, boxW, boxH, radius); ctx.stroke();
  }
  ctx.restore();
  // Text
  ctx.globalAlpha = anim.opacity;
  if (S.dropShadow) {
    ctx.shadowColor = _rgbaToCss(S.shadowColor, S.shadowOpacity / 100);
    ctx.shadowOffsetY = S.shadowDistance * (canvasW / 480) * 0.5;
    ctx.shadowBlur = S.shadowBlur * (canvasW / 480) * 0.5;
  }
  if (S.strokeWidth > 0) {
    ctx.strokeStyle = _rgbToCss(S.strokeColor);
    ctx.lineWidth = S.strokeWidth * 2 * (canvasW / 480);
    ctx.lineJoin = 'round'; ctx.strokeText(text, 0, 0);
  }
  ctx.fillStyle = _rgbToCss(S.fillColor); ctx.fillText(text, 0, 0);
  ctx.restore();
}

function _drawHighlightPreview(ctx, g, cx, cy, fontSize, anim, canvasW) {
  const t = S._previewTime || 0;
  const words = g.words.map((wd) => {
    const isHl = S.highlightWords.indexOf(wd.idx) !== -1;
    const txt = S.allCaps ? (wd.text || '').toUpperCase() : (wd.text || '');
    return { text: txt, isHl, start: wd.start, end: wd.end };
  });
  const spaceW = ctx.measureText(' ').width * 0.6;
  const widths = words.map((wd) => ctx.measureText(wd.text).width);
  const totalW = widths.reduce((a, b) => a + b, 0) + spaceW * Math.max(0, words.length - 1);
  const textH = fontSize * 0.9;
  ctx.save();
  ctx.translate(cx, cy); ctx.scale(anim.scale, anim.scale); ctx.globalAlpha = anim.opacity;
  let x = -totalW / 2;
  for (let i = 0; i < words.length; i++) {
    const wd = words[i], ww = widths[i];
    const isActive = t >= wd.start && t < wd.end;
    const showHl = wd.isHl || isActive;
    if (showHl) {
      const padX = fontSize * 0.12;
      const boxW = ww + padX * 2, boxH = textH + fontSize * 0.1;
      ctx.save();
      ctx.fillStyle = _rgbToCss(S.highlightBoxColor);
      _roundRect(ctx, x - padX, -boxH / 2, boxW, boxH, fontSize * 0.15); ctx.fill();
      ctx.restore();
    }
    if (S.dropShadow) {
      ctx.shadowColor = _rgbaToCss(S.shadowColor, S.shadowOpacity / 100);
      ctx.shadowOffsetY = S.shadowDistance * (canvasW / 480) * 0.5;
      ctx.shadowBlur = S.shadowBlur * (canvasW / 480) * 0.5;
    }
    if (S.strokeWidth > 0) {
      ctx.strokeStyle = _rgbToCss(S.strokeColor);
      ctx.lineWidth = S.strokeWidth * 2 * (canvasW / 480);
      ctx.lineJoin = 'round'; ctx.strokeText(wd.text, x + ww / 2, 0);
    }
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
    ctx.fillStyle = showHl ? _rgbToCss(S.highlightTextColor) : _rgbToCss(S.fillColor);
    ctx.fillText(wd.text, x + ww / 2, 0);
    x += ww + spaceW;
  }
  ctx.restore();
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
    const normalized = { text: wordText, start: w.start, end: w.end, idx: i };
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

function _computePreviewAnim(preset, progress, intensity) {
  const i = intensity || 1.0;
  const introDur = 0.18;
  if (progress < introDur) {
    const p = progress / introDur;
    if (preset === 'fade' || preset === 'fadeup') return { scale: 1.0, opacity: 1 - Math.pow(1 - p, 3) };
    if (preset === 'popin') {
      const c1 = 1.70158, c3 = c1 + 1;
      const eased = 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
      return { scale: Math.min(1.15, eased * (1 + 0.15 * i)), opacity: Math.min(1.0, p * 2) };
    }
    if (preset === 'bounce') {
      let s;
      if (p < 0.4) s = (p / 0.4) * (1 + 0.25 * i);
      else if (p < 0.7) s = (1 + 0.25 * i) - ((p - 0.4) / 0.3) * (0.35 * i);
      else s = (0.9 - 0.05 * i) + ((p - 0.7) / 0.3) * 0.1;
      return { scale: s, opacity: Math.min(1.0, p * 3) };
    }
    if (preset === 'squash') {
      const maxDev = 13 * i, spd = 18 * i, decay = 1.0;
      const s = 100 - Math.abs(maxDev * Math.exp(-decay * p * 0.3) * Math.sin(spd * p * 0.3));
      return { scale: s / 100, opacity: Math.min(1.0, p * 3) };
    }
    if (preset === 'typewriter') return { scale: 1.0, opacity: 1.0 };
  }
  return { scale: 1.0, opacity: 1.0 };
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
