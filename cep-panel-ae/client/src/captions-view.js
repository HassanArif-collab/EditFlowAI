/**
 * captions-view.js — Main UI for EditFlow AE caption generation.
 *
 * Workflow:
 *   1. User opens a comp with audio in AE
 *   2. Click "Transcribe Audio" — extracts audio path from comp, sends to backend
 *   3. Backend runs Whisper, returns word-level timestamps
 *   4. User picks animation preset + font/size/color
 *   5. Click "Generate Captions" — creates native AE text layers with animation
 *
 * All text layers are NATIVE AE text (not MOGRTs) — fully editable, no crashes.
 */
import { apiGet, apiPost, apiUpload, getBaseUrl } from './api.js';
import { callExtendScript, isExtendScriptAvailable } from './extendscript.js';

const $ = (sel) => document.querySelector(sel);

const S = {
  words: [],
  duration: 0,
  modelName: '',
  modelInstalled: false,
  preset: 'popin',
  fontSize: 80,
  fontName: 'Arial',
  fillColor: [1, 1, 1],  // white
  strokeColor: [0, 0, 0],
  strokeWidth: 0,
  posX: 50,       // percentage 0-100
  posY: 85,       // percentage 0-100
  wordsPerLine: 4,
  allCaps: true,
  compInfo: null,
  audioOffset: 0,  // offset from getAudioPath
  busy: false,
  status: null,
  error: null,
  progress: 0,
  generateResult: null,
};

function openCaptions() {
  _ensureStyles();
  _ensureContainer();
  _render();
  _refreshModelStatus();
  _refreshCompInfo();
  setInterval(() => {
    const el = $('#captions-view');
    if (!el || el.classList.contains('hidden') || document.hidden) return;
    _refreshModelStatus();
    _refreshCompInfo();
  }, 10000);
}

function closeCaptions() {
  $('#captions-view')?.classList.add('hidden');
}

function _ensureStyles() {
  if (document.getElementById('cap-style-link')) return;
  const link = document.createElement('link');
  link.id = 'cap-style-link';
  link.rel = 'stylesheet';
  link.href = 'styles/captions.css?v=' + Date.now();
  document.head.appendChild(link);
}

function _ensureContainer() {
  let v = $('#captions-view');
  if (!v) {
    v = document.createElement('div');
    v.id = 'captions-view';
    v.className = 'captions-view';
    ($('#app-main') || document.body).appendChild(v);
  }
  return v;
}

function _render() {
  const v = _ensureContainer();
  v.innerHTML = `
    <div class="cap-header">
      <h2>Animated Captions</h2>
      <span id="cap-model-pill" class="cap-pill cap-pill-warn">checking model…</span>
    </div>

<div class="cap-comp-info" id="cap-comp-info">
      ${S.compInfo ? (S.compInfo.error ? `
        <span class="cap-dim" style="color:#f87171;">Error: ${_esc(S.compInfo.error)}</span>
      ` : `
        <strong>${_esc(S.compInfo.name)}</strong>
        · ${S.compInfo.width}×${S.compInfo.height}
        · ${S.compInfo.duration?.toFixed(1)}s
        · ${S.compInfo.frameRate?.toFixed(1)} fps
        · ${S.compInfo.hasAudio ? '✓ has audio' : '⚠ no audio'}
      `) : '<span class="cap-dim">No active composition. Open a comp in AE.</span>'}
    </div>

    <!-- Step 1: Transcribe -->
    <div class="cap-section">
      <div class="cap-subhead">Step 1 — Transcribe Audio</div>
      <p class="cap-hint">
        Add an audio file to your comp (drag it in or import), then click below.
        We'll extract the audio and run Whisper transcription for word-level timestamps.
      </p>
      <div class="cap-actions">
        <button id="cap-transcribe-btn" class="cap-btn cap-primary" ${S.busy || !S.compInfo?.hasAudio || S.compInfo?.error ? 'disabled' : ''}>
          ${S.busy ? 'Working…' : 'Transcribe Audio'}
        </button>
        <label class="cap-btn cap-ghost" style="cursor:pointer" title="Upload a WAV/MP3 file directly">
          Upload Audio
          <input type="file" id="cap-audio-upload" accept=".wav,.mp3,.m4a,audio/*" style="display:none" />
        </label>
      </div>
      ${S.status ? `<div class="cap-status cap-status-progress">${_esc(S.status)}</div>` : ''}
      ${S.busy && S.progress > 0 ? `
        <div class="cap-progress-bar">
          <div class="cap-progress-fill" style="width: ${S.progress}%"></div>
          <span class="cap-progress-text">${S.progress}%</span>
        </div>
      ` : ''}
      ${S.error ? `<div class="cap-status cap-err">${_esc(S.error)}</div>` : ''}
      ${S.words.length && S.duration !== undefined ? `
        <div class="cap-words-info">
          <strong>${S.words.length}</strong> words transcribed
          (${S.duration.toFixed(1)}s)
        </div>
      ` : ''}
    </div>

    <!-- Step 2: Style + Preview -->
    <div class="cap-section">
      <div class="cap-subhead">Step 2 — Caption Style</div>

      <!-- Live Preview -->
      <div class="cap-preview-container">
        <canvas id="cap-preview-canvas" width="480" height="270"></canvas>
      </div>
      <div class="cap-preview-controls">
        <button id="cap-preview-play" class="cap-btn cap-btn-tiny">${S._previewPlaying ? '⏸' : '▶'}</button>
        <input type="range" id="cap-preview-seek" class="cap-seek" min="0" max="${S.duration || 0}" step="0.01" value="${S._previewTime || 0}" />
      </div>

      <div class="cap-row">
        <label class="cap-label">Preset</label>
        <select id="cap-preset" class="cap-select">
          <option value="popin" ${S.preset === 'popin' ? 'selected' : ''}>Pop-in (Hormozi)</option>
          <option value="fade" ${S.preset === 'fade' ? 'selected' : ''}>Fade-in</option>
          <option value="bounce" ${S.preset === 'bounce' ? 'selected' : ''}>Bounce</option>
          <option value="typewriter" ${S.preset === 'typewriter' ? 'selected' : ''}>Typewriter</option>
        </select>
      </div>
      <div class="cap-row">
        <label class="cap-label">Font Size</label>
        <input type="range" id="cap-font-size" class="cap-range" min="20" max="200" value="${S.fontSize}" />
        <span class="cap-range-val">${S.fontSize}px</span>
      </div>
      <div class="cap-row">
        <label class="cap-label">Font</label>
        <input type="text" id="cap-font-name" class="cap-input" value="${_esc(S.fontName)}" placeholder="Arial" />
      </div>
      <div class="cap-row">
        <label class="cap-label">Text Color</label>
        <input type="color" id="cap-color" class="cap-color" value="${_rgbToHex(S.fillColor)}" />
      </div>
      <div class="cap-row">
        <label class="cap-label">Outline</label>
        <input type="color" id="cap-stroke-color" class="cap-color" value="${_rgbToHex(S.strokeColor)}" />
        <input type="range" id="cap-stroke-width" class="cap-range" min="0" max="10" value="${S.strokeWidth}" />
      </div>
      <div class="cap-row">
        <label class="cap-label">Position X</label>
        <input type="range" id="cap-pos-x" class="cap-range" min="0" max="100" value="${S.posX}" />
        <span class="cap-range-val">${S.posX}%</span>
      </div>
      <div class="cap-row">
        <label class="cap-label">Position Y</label>
        <input type="range" id="cap-pos-y" class="cap-range" min="0" max="100" value="${S.posY}" />
        <span class="cap-range-val">${S.posY}%</span>
      </div>
      <div class="cap-row">
        <label class="cap-label">Words/Line</label>
        <input type="range" id="cap-words-per-line" class="cap-range" min="1" max="8" value="${S.wordsPerLine}" />
        <span class="cap-range-val">${S.wordsPerLine}</span>
      </div>
      <div class="cap-row">
        <label class="cap-label">UPPERCASE</label>
        <input type="checkbox" id="cap-all-caps" ${S.allCaps ? 'checked' : ''} />
      </div>
    </div>

    <!-- Step 3: Generate -->
    <div class="cap-section">
      <div class="cap-subhead">Step 3 — Generate Captions</div>
      <div class="cap-actions">
        <button id="cap-clear-btn" class="cap-btn cap-ghost" ${S.busy ? 'disabled' : ''}>
          Clear Existing
        </button>
        <button id="cap-smoke-btn" class="cap-btn" ${!S.words.length || S.busy ? 'disabled' : ''}>
          Smoke Test (3 words)
        </button>
        <button id="cap-generate-btn" class="cap-btn cap-primary" ${!S.words.length || S.busy ? 'disabled' : ''}>
          Generate All (${S.words.length} words)
        </button>
      </div>
      ${S.generateResult ? _renderResult() : ''}
    </div>
  `;

  // Wire up
  const transcribeBtn = v.querySelector('#cap-transcribe-btn');
  if (transcribeBtn) transcribeBtn.onclick = _onTranscribe;
  const audioUpload = v.querySelector('#cap-audio-upload');
  if (audioUpload) audioUpload.onchange = _onAudioUpload;
  const presetSel = v.querySelector('#cap-preset');
  if (presetSel) presetSel.onchange = (e) => { S.preset = e.target.value; _updatePreview(); };
  const fontSizeInput = v.querySelector('#cap-font-size');
  if (fontSizeInput) fontSizeInput.oninput = (e) => { S.fontSize = parseInt(e.target.value); _updatePreview(); v.querySelector('#cap-font-size + .cap-range-val').textContent = e.target.value + 'px'; };
  const fontNameInput = v.querySelector('#cap-font-name');
  if (fontNameInput) fontNameInput.onchange = (e) => { S.fontName = e.target.value || 'Arial'; _updatePreview(); };
  const colorInput = v.querySelector('#cap-color');
  if (colorInput) colorInput.onchange = (e) => { S.fillColor = _hexToRgb(e.target.value); _updatePreview(); };
  const strokeColorInput = v.querySelector('#cap-stroke-color');
  if (strokeColorInput) strokeColorInput.onchange = (e) => { S.strokeColor = _hexToRgb(e.target.value); _updatePreview(); };
  const strokeWidthInput = v.querySelector('#cap-stroke-width');
  if (strokeWidthInput) strokeWidthInput.oninput = (e) => { S.strokeWidth = parseInt(e.target.value); _updatePreview(); };
  const posXInput = v.querySelector('#cap-pos-x');
  if (posXInput) posXInput.oninput = (e) => { S.posX = parseInt(e.target.value); _updatePreview(); v.querySelector('#cap-pos-x + .cap-range-val').textContent = e.target.value + '%'; };
  const posYInput = v.querySelector('#cap-pos-y');
  if (posYInput) posYInput.oninput = (e) => { S.posY = parseInt(e.target.value); _updatePreview(); v.querySelector('#cap-pos-y + .cap-range-val').textContent = e.target.value + '%'; };
  const wordsPerLineInput = v.querySelector('#cap-words-per-line');
  if (wordsPerLineInput) wordsPerLineInput.oninput = (e) => { S.wordsPerLine = parseInt(e.target.value); v.querySelector('#cap-words-per-line + .cap-range-val').textContent = e.target.value; };
  const allCapsInput = v.querySelector('#cap-all-caps');
  if (allCapsInput) allCapsInput.onchange = (e) => { S.allCaps = e.target.checked; _updatePreview(); };
  const previewPlayBtn = v.querySelector('#cap-preview-play');
  if (previewPlayBtn) previewPlayBtn.onclick = _togglePreview;
  const previewSeek = v.querySelector('#cap-preview-seek');
  if (previewSeek) previewSeek.oninput = (e) => { S._previewTime = parseFloat(e.target.value); _updatePreview(); };
  const clearBtn = v.querySelector('#cap-clear-btn');
  if (clearBtn) clearBtn.onclick = _onClear;
  const smokeBtn = v.querySelector('#cap-smoke-btn');
  if (smokeBtn) smokeBtn.onclick = () => _onGenerate(true);
  const generateBtn = v.querySelector('#cap-generate-btn');
  if (generateBtn) generateBtn.onclick = () => _onGenerate(false);

  // Initialize preview canvas
  S._canvas = v.querySelector('#cap-preview-canvas');
  S._ctx = S._canvas?.getContext('2d');
  _updatePreview();
  _startPreviewLoop();
}

function _renderResult() {
  const r = S.generateResult;
  const cls = r.placed === r.total ? 'cap-pill-ok' : 'cap-pill-err';
  const errList = (r.errors || []).slice(0, 5).map(e => `<li>${_esc(typeof e === 'string' ? e : JSON.stringify(e))}</li>`).join('');
  return `<div class="cap-result">
    <span class="cap-pill ${cls}">${r.placed}/${r.total} placed</span>
    ${r.errors?.length ? `<details class="cap-drawer"><summary>${r.errors.length} errors</summary><ul class="cap-error-list">${errList}</ul></details>` : ''}
  </div>`;
}

async function _refreshModelStatus() {
  const pill = $('#cap-model-pill');
  if (!pill) return;
  try {
    const r = await apiGet('/api/whisper/status', { timeoutMs: 8000 });
    S.modelName = r.active_model || '';
    const installed = (r.supported_models || []).find(m => m.name === S.modelName);
    S.modelInstalled = !!(installed && installed.installed);
    if (S.modelInstalled) {
      pill.textContent = `whisper: ${S.modelName} ✓`;
      pill.className = 'cap-pill cap-pill-ok';
    } else {
      pill.textContent = `whisper: ${S.modelName} (not installed)`;
      pill.className = 'cap-pill cap-pill-err';
    }
  } catch (e) {
    pill.textContent = 'whisper: offline';
    pill.className = 'cap-pill cap-pill-err';
  }
}

async function _refreshCompInfo() {
  try {
    if (!isExtendScriptAvailable()) return;
    const resp = await callExtendScript('ef_getCompInfo');
    console.log('[captions] getCompInfo response:', resp);
    if (resp && !resp.error) {
      S.compInfo = resp;
      const el = $('#cap-comp-info');
      if (el) _render();
    } else {
      console.error('[captions] getCompInfo failed:', resp?.error);
      S.compInfo = { error: resp?.error || 'Unknown error' };
      _render();
    }
  } catch (e) {
    console.error('[captions] getCompInfo exception:', e);
    S.compInfo = { error: e.message };
    _render();
  }
}

async function _onTranscribe() {
  if (S.busy) return;
  S.busy = true;
  S.error = null;
  S.status = 'Getting audio from comp...';
  S.progress = 5;
  _render();

  try {
    if (!S.modelInstalled) {
      throw new Error(`Whisper model "${S.modelName}" not installed. Open Settings to download.`);
    }

    // 1. Get the audio file path from the active comp
    S.status = 'Extracting audio path from comp...';
    _render();
    const audioResp = await callExtendScript('ef_getAudioPath');
    if (!audioResp || audioResp.error || !audioResp.path) {
      throw new Error(audioResp?.error || 'No audio found in the active comp.');
    }
    S.audioOffset = audioResp.offset || 0;

    // 2. Read the audio file and upload to backend for transcription
    S.status = 'Uploading audio + transcribing with Whisper...';
    S.progress = 15;
    _render();

    const audioBlob = await _readFileAsBlob(audioResp.path);
    const resp = await apiUpload(
      '/api/subtitles/transcribe-mixdown',
      audioBlob,
      {
        client_id: 'ae-captions',
        sequence_name: S.compInfo?.name || 'ae_comp',
        in_seconds: 0,
        out_seconds: S.compInfo?.duration || 0,
      },
      { timeoutMs: 600000 }
    );

    S.words = resp.words || [];
    S.duration = resp.duration || 0;
    S.status = null;
    S.progress = 100;

    if (!S.words.length) {
      throw new Error('Transcription completed but no words found. The audio may be too quiet.');
    }
  } catch (e) {
    console.error('[captions] transcribe failed:', e);
    S.error = e.message || String(e);
    S.status = null;
    S.progress = 0;
  } finally {
    S.busy = false;
    _render();
  }
}

async function _onAudioUpload(event) {
  const file = event.target.files[0];
  if (!file || S.busy) return;
  S.busy = true;
  S.error = null;
  S.status = 'Uploading audio + transcribing...';
  S.progress = 15;
  _render();

  try {
    if (!S.modelInstalled) {
      throw new Error(`Whisper model "${S.modelName}" not installed.`);
    }

    const resp = await apiUpload(
      '/api/subtitles/transcribe-mixdown',
      file,
      {
        client_id: 'ae-captions',
        sequence_name: file.name,
        in_seconds: 0,
        out_seconds: 0,
      },
      { timeoutMs: 600000 }
    );

    S.words = resp.words || [];
    S.duration = resp.duration || 0;
    S.status = null;
    S.progress = 100;

    if (!S.words.length) {
      throw new Error('No words found in transcription.');
    }
  } catch (e) {
    S.error = e.message || String(e);
    S.status = null;
    S.progress = 0;
  } finally {
    S.busy = false;
    _render();
  }
}

async function _onGenerate(smokeTest) {
  if (S.busy || !S.words.length) return;
  S.busy = true;
  S.generateResult = null;
  S.status = smokeTest ? 'Creating test captions...' : 'Creating captions...';
  S.progress = 10;
  _render();

  try {
    const wordsToPlace = smokeTest ? S.words.slice(0, 3) : S.words;

    S.status = `Creating ${wordsToPlace.length} word captions...`;
    S.progress = 30;
    _render();

    // Single call — JSX handles grouping (3-4 words per caption)
    // and creates all layers in one undo group
    const cfg = {
      words: wordsToPlace,
      preset: S.preset,
      fontSize: S.fontSize,
      fontName: S.fontName,
      fillColor: S.fillColor,
      strokeColor: S.strokeColor || [0, 0, 0],
      strokeWidth: S.strokeWidth || 0,
      posX: S.posX || 50,
      posY: S.posY || 85,
      wordsPerLine: S.wordsPerLine || 4,
      allCaps: S.allCaps !== false,  // default true (Hormozi style)
      offset: S.audioOffset || 0,  // shift words to comp time
      replace: true,
    };

    const resp = await callExtendScript('ef_createCaptions', JSON.stringify(cfg));

    S.generateResult = {
      placed: resp.placed || 0,
      total: wordsToPlace.length,
      groups: resp.groups || 0,
      errors: resp.errors || [],
    };
    S.status = null;
    S.progress = 100;
  } catch (e) {
    console.error('[captions] generate failed:', e);
    S.generateResult = {
      placed: 0,
      total: smokeTest ? 3 : S.words.length,
      errors: [String(e.message || e)],
    };
    S.status = null;
    S.progress = 0;
  } finally {
    S.busy = false;
    _render();
  }
}

async function _onClear() {
  try {
    await callExtendScript('ef_clearCaptions');
    S.generateResult = null;
    _render();
  } catch (e) {
    S.error = e.message || String(e);
    _render();
  }
}

// ── Helpers ──
function _readFileAsBlob(path) {
  const req = (typeof require === 'function') ? require
            : (window.cep_node && window.cep_node.require) ? window.cep_node.require
            : null;
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
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function _hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.substring(0, 2), 16) / 255,
    parseInt(h.substring(2, 4), 16) / 255,
    parseInt(h.substring(4, 6), 16) / 255,
  ];
}

// ── Live Preview (Canvas-based) ──

function _togglePreview() {
  if (!S.words.length) return;
  S._previewPlaying = !S._previewPlaying;
  if (S._previewPlaying && (S._previewTime || 0) >= S.duration) {
    S._previewTime = 0;
  }
  _render();
}

function _startPreviewLoop() {
  if (S._previewRaf) cancelAnimationFrame(S._previewRaf);
  function loop() {
    if (S._previewPlaying && S.words.length) {
      S._previewTime = (S._previewTime || 0) + 1/30;
      if (S._previewTime >= S.duration) {
        S._previewTime = 0;
        S._previewPlaying = false;
      }
      const seek = $('#cap-preview-seek');
      if (seek) seek.value = S._previewTime;
      _updatePreview();
    }
    S._previewRaf = requestAnimationFrame(loop);
  }
  S._previewRaf = requestAnimationFrame(loop);
}

function _updatePreview() {
  if (!S._ctx) return;
  const ctx = S._ctx;
  const w = S._canvas.width;
  const h = S._canvas.height;
  ctx.fillStyle = '#1a1a22';
  ctx.fillRect(0, 0, w, h);
  if (!S.words.length) {
    ctx.fillStyle = '#666';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Transcribe to see preview', w/2, h/2);
    return;
  }
  const t = S._previewTime || 0;
  const groups = _groupWordsForPreview(S.words, S.wordsPerLine || 4);
  let activeGroup = null;
  for (const g of groups) {
    if (t >= g.start && t < g.end) { activeGroup = g; break; }
  }
  if (!activeGroup) return;
  const progress = (t - activeGroup.start) / Math.max(0.1, activeGroup.end - activeGroup.start);
  const anim = _computePreviewAnim(S.preset, Math.min(1, progress));
  const fontSize = S.fontSize * (w / 1920 * 1.5);
  const font = `bold ${fontSize}px ${S.fontName}, sans-serif`;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const x = w * (S.posX / 100);
  const y = h * (S.posY / 100);
  const text = S.allCaps ? activeGroup.text.toUpperCase() : activeGroup.text;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(anim.scale, anim.scale);
  ctx.globalAlpha = anim.opacity;
  if (S.strokeWidth > 0) {
    ctx.strokeStyle = _rgbToCss(S.strokeColor);
    ctx.lineWidth = S.strokeWidth * 2 * (w / 480);
    ctx.lineJoin = 'round';
    ctx.strokeText(text, 0, 0);
  }
  ctx.fillStyle = _rgbToCss(S.fillColor);
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function _groupWordsForPreview(words, maxWords) {
  const groups = [];
  let cur = [];
  for (const w of words) {
    const wordText = w.word || w.text || '';
    if (!wordText) continue;
    if (cur.length === 0) { cur.push({text: wordText, start: w.start, end: w.end}); continue; }
    const prev = cur[cur.length - 1];
    const gap = w.start - prev.end;
    if (gap > 0.6 || cur.length >= maxWords) {
      groups.push({ text: cur.map(x => x.text).join(' '), start: cur[0].start, end: cur[cur.length-1].end });
      cur = [{text: wordText, start: w.start, end: w.end}];
    } else {
      cur.push({text: wordText, start: w.start, end: w.end});
    }
  }
  if (cur.length) groups.push({ text: cur.map(x => x.text).join(' '), start: cur[0].start, end: cur[cur.length-1].end });
  return groups;
}

function _computePreviewAnim(preset, progress) {
  const introDur = 0.2;
  if (progress < introDur) {
    const introProgress = progress / introDur;
    if (preset === 'fade') {
      return { scale: 1.0, opacity: 1 - Math.pow(1 - introProgress, 3) };
    } else if (preset === 'popin' || preset === 'pop') {
      const c1 = 1.70158, c3 = c1 + 1;
      const eased = 1 + c3 * Math.pow(introProgress - 1, 3) + c1 * Math.pow(introProgress - 1, 2);
      return { scale: Math.min(1.1, eased * 1.1), opacity: Math.min(1.0, introProgress * 2) };
    } else if (preset === 'bounce') {
      let scale;
      if (introProgress < 0.4) scale = (introProgress / 0.4) * 1.25;
      else if (introProgress < 0.7) scale = 1.25 - ((introProgress - 0.4) / 0.3) * 0.35;
      else scale = 0.9 + ((introProgress - 0.7) / 0.3) * 0.1;
      return { scale, opacity: Math.min(1.0, introProgress * 3) };
    }
  }
  return { scale: 1.0, opacity: 1.0 };
}

function _rgbToCss(rgb) {
  const r = Math.round((rgb[0] || 0) * 255);
  const g = Math.round((rgb[1] || 0) * 255);
  const b = Math.round((rgb[2] || 0) * 255);
  return `rgb(${r}, ${g}, ${b})`;
}

function _esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export { openCaptions, closeCaptions };
