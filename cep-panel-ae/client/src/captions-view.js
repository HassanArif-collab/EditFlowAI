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
  preset: 'pop',
  fontSize: 80,
  fontName: 'Arial',
  fillColor: [1, 1, 1],  // white
  compInfo: null,
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
      ${S.compInfo && S.compInfo.duration !== undefined ? `
        <strong>${_esc(S.compInfo.name)}</strong>
        · ${S.compInfo.width}×${S.compInfo.height}
        · ${S.compInfo.duration.toFixed(1)}s
        · ${S.compInfo.frameRate.toFixed(1)} fps
        · ${S.compInfo.hasAudio ? '✓ has audio' : '⚠ no audio'}
      ` : S.compInfo && S.compInfo.error ? `
        <span class="cap-dim cap-err">ExtendScript error: ${_esc(S.compInfo.error)}</span>
      ` : '<span class="cap-dim">No active composition. Open a comp in AE.</span>'}
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

    <!-- Step 2: Style -->
    <div class="cap-section">
      <div class="cap-subhead">Step 2 — Caption Style</div>
      <div class="cap-row">
        <label class="cap-label">Preset</label>
        <select id="cap-preset" class="cap-select">
          <option value="fade" ${S.preset === 'fade' ? 'selected' : ''}>Fade-in</option>
          <option value="pop" ${S.preset === 'pop' ? 'selected' : ''}>Pop-in (Hormozi)</option>
          <option value="bounce" ${S.preset === 'bounce' ? 'selected' : ''}>Bounce</option>
        </select>
      </div>
      <div class="cap-row">
        <label class="cap-label">Font Size</label>
        <input type="number" id="cap-font-size" class="cap-input" value="${S.fontSize}" min="10" max="300" />
      </div>
      <div class="cap-row">
        <label class="cap-label">Font</label>
        <input type="text" id="cap-font-name" class="cap-input" value="${_esc(S.fontName)}" placeholder="Arial" />
      </div>
      <div class="cap-row">
        <label class="cap-label">Color</label>
        <input type="color" id="cap-color" class="cap-color" value="${_rgbToHex(S.fillColor)}" />
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
  if (presetSel) presetSel.onchange = (e) => { S.preset = e.target.value; };
  const fontSizeInput = v.querySelector('#cap-font-size');
  if (fontSizeInput) fontSizeInput.onchange = (e) => { S.fontSize = parseInt(e.target.value) || 80; };
  const fontNameInput = v.querySelector('#cap-font-name');
  if (fontNameInput) fontNameInput.onchange = (e) => { S.fontName = e.target.value || 'Arial'; };
  const colorInput = v.querySelector('#cap-color');
  if (colorInput) colorInput.onchange = (e) => { S.fillColor = _hexToRgb(e.target.value); };
  const clearBtn = v.querySelector('#cap-clear-btn');
  if (clearBtn) clearBtn.onclick = _onClear;
  const smokeBtn = v.querySelector('#cap-smoke-btn');
  if (smokeBtn) smokeBtn.onclick = () => _onGenerate(true);
  const generateBtn = v.querySelector('#cap-generate-btn');
  if (generateBtn) generateBtn.onclick = () => _onGenerate(false);
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
    const resp = await callExtendScript('getCompInfo');
    console.log('[captions] getCompInfo response:', resp);
    if (resp && resp.success) {
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
    const audioResp = await callExtendScript('getAudioPath');
    if (!audioResp || !audioResp.success) {
      throw new Error(audioResp?.error || 'No audio found in the active comp.');
    }

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
  S.status = smokeTest ? 'Creating 3 test captions...' : 'Creating captions...';
  S.progress = 10;
  _render();

  try {
    const wordsToPlace = smokeTest ? S.words.slice(0, 3) : S.words;
    const batchSize = 20;
    let batchStart = 0;
    let totalPlaced = 0;
    let allErrors = [];

    while (true) {
      const batchEnd = Math.min(batchStart + batchSize, wordsToPlace.length);
      S.status = `Creating captions ${batchStart + 1}-${batchEnd} of ${wordsToPlace.length}...`;
      S.progress = Math.round((batchStart / wordsToPlace.length) * 80) + 10;
      _render();

      const resp = await callExtendScript('createCaptions', {
        words: wordsToPlace,
        preset: S.preset,
        fontSize: S.fontSize,
        fontName: S.fontName,
        fillColor: S.fillColor,
        batchStart: batchStart,
        batchSize: batchSize,
      });

      totalPlaced += resp.placed || 0;
      if (resp.errors && resp.errors.length) {
        allErrors = allErrors.concat(resp.errors);
      }

      batchStart = resp.next_batch_start;
      if (!resp.has_more || !batchStart) break;

      await new Promise(r => setTimeout(r, 100));
    }

    S.generateResult = {
      placed: totalPlaced,
      total: wordsToPlace.length,
      errors: allErrors,
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
    await callExtendScript('clearCaptions');
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

function _esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export { openCaptions, closeCaptions };
