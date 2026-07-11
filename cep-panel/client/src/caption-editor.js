/**
 * caption-editor.js — Editor for animated captions with live Canvas preview.
 *
 * Architecture (ProRes technique):
 *   Phase 1: EDIT (this file)
 *     - Word list with editable text + timing
 *     - Style controls (font, size, color, position, preset)
 *     - Live HTML5 Canvas preview synced to audio
 *     - State saved as JSON (non-destructive, re-editable)
 *
 *   Phase 2: APPLY (separate functions)
 *     - POST /api/captions/render → backend renders ProRes 4444 video
 *     - ExtendScript importCaptionVideo → places video on timeline
 *
 * The editor state is pure data — no Premiere interaction during editing.
 * This makes it fast, testable, and non-destructive.
 */
import { apiGet, apiPost, apiUpload, connectWS, getBaseUrl } from './api.js';
import { callExtendScript, isExtendScriptAvailable } from './extendscript.js';
import { getState } from './state.js';

const $ = (sel) => document.querySelector(sel);

// ── State ──
const S = {
  // Transcription state
  words: [],              // [{word, start, end, confidence}]
  duration: 0,
  // Model state
  modelName: '',
  modelInstalled: false,
  // Style
  style: {
    font_family: 'Arial',
    font_size: 80,
    fill_color: '#ffffff',
    stroke_color: '#000000',
    stroke_width: 4,
    position_y: 0.85,
    position_x: 0.5,
    preset: 'pop',
  },
  // Sequence settings (from Premiere)
  seqSettings: null,      // {width, height, fps, durationSeconds, name}
  // Playback
  currentTime: 0,
  playing: false,
  audio: null,            // HTMLAudioElement for preview
  // Render state
  renderProgress: 0,
  renderStatus: null,
  renderResult: null,
  // UI state
  busy: false,
  error: null,
  status: null,
  selectedWordIdx: null,
  prevView: null,
  _canvas: null,
  _ctx: null,
  _raf: null,             // requestAnimationFrame ID
  _ws: null,
};

// ── Public API ──
function openCaptionEditor(opts = {}) {
  _ensureStyles();
  _ensureContainer();
  const hero = $('#hero'), chat = $('#chat-scroll'), footer = $('#app-footer');
  S.prevView = {
    hero: hero?.classList.contains('hidden') ?? true,
    chat: chat?.classList.contains('hidden') ?? true,
    footer: footer?.classList.contains('hidden') ?? true,
  };
  hero?.classList.add('hidden');
  chat?.classList.add('hidden');
  footer?.classList.add('hidden');
  $('#review-view')?.classList.add('hidden');
  const v = _ensureContainer();
  v.classList.remove('hidden');
  _render();
  _refreshModelStatus();
  _refreshSeqSettings();
  _startPreviewLoop();
  // Connect WebSocket for render progress
  try {
    const clientId = (getState && getState().session && getState().session.clientId) || 'caption-editor';
    S._ws = connectWS(clientId);
    S._ws.on('message', (data) => {
      if (data && data.type === 'progress') {
        const payload = data.payload || data;
        if (payload.task_type === 'caption_render') {
          S.renderProgress = Math.round((payload.progress || 0) * 100);
          S.renderStatus = payload.message || `Rendering... ${S.renderProgress}%`;
          _updateRenderStatus();
        }
      }
    });
  } catch (e) { /* non-fatal */ }
}

function closeCaptionEditor() {
  $('#caption-editor-view')?.classList.add('hidden');
  if (S._raf) { cancelAnimationFrame(S._raf); S._raf = null; }
  if (S._ws) { try { S._ws.close(); } catch (_) {} S._ws = null; }
  if (S.audio) { try { S.audio.pause(); } catch (_) {} }
  S.playing = false;
  const hero = $('#hero'), chat = $('#chat-scroll'), footer = $('#app-footer');
  if (S.prevView) {
    hero?.classList.toggle('hidden', S.prevView.hero);
    chat?.classList.toggle('hidden', S.prevView.chat);
    footer?.classList.toggle('hidden', S.prevView.footer);
  }
}

// ── Styles + container ──
function _ensureStyles() {
  if (document.getElementById('ce-style-link')) return;
  const link = document.createElement('link');
  link.id = 'ce-style-link';
  link.rel = 'stylesheet';
  link.href = 'styles/caption-editor.css?v=' + Date.now();
  document.head.appendChild(link);
}

function _ensureContainer() {
  let v = $('#caption-editor-view');
  if (!v) {
    v = document.createElement('div');
    v.id = 'caption-editor-view';
    v.className = 'caption-editor-view hidden';
    ($('#app-main') || document.body).appendChild(v);
  }
  return v;
}

// ── Render ──
function _render() {
  const v = _ensureContainer();
  v.innerHTML = `
    <div class="ce-bar">
      <div class="ce-title">Animated Captions</div>
      <span id="ce-model-pill" class="ce-pill ce-pill-warn">checking model…</span>
      <button id="ce-manage-btn" class="ce-btn ce-btn-tiny">Settings</button>
      <span class="ce-spacer"></span>
      <button class="ce-btn ce-ghost" data-act="close">Close</button>
    </div>

    <div class="ce-body">
      <div class="ce-left">
        <!-- Step 1: Transcribe -->
        <div class="ce-section">
          <div class="ce-subhead">Step 1 — Get Words</div>
          <div class="ce-actions">
            <button id="ce-transcribe-btn" class="ce-btn ce-primary">
              Transcribe Audio
            </button>
            <label class="ce-btn ce-ghost" style="cursor:pointer">
              Upload Audio
              <input type="file" id="ce-audio-upload" accept=".wav,.mp3,.m4a,audio/*" style="display:none" />
            </label>
            <button id="ce-paste-btn" class="ce-btn ce-ghost">Paste SRT/JSON</button>
          </div>
          ${S.status ? `<div class="ce-status">${_esc(S.status)}</div>` : ''}
          ${S.error ? `<div class="ce-status ce-err">${_esc(S.error)}</div>` : ''}
          ${S.words.length ? `
            <div class="ce-words-info">
              <strong>${S.words.length}</strong> words · ${S.duration.toFixed(1)}s
            </div>
          ` : ''}
        </div>

        <!-- Step 2: Word List -->
        ${S.words.length ? `
        <div class="ce-section ce-grow">
          <div class="ce-subhead">Step 2 — Edit Words</div>
          <div class="ce-word-list" id="ce-word-list">
            ${S.words.map((w, i) => `
              <div class="ce-word-row ${S.selectedWordIdx === i ? 'ce-word-selected' : ''}" data-idx="${i}">
                <span class="ce-word-time">${w.start.toFixed(2)}</span>
                <input class="ce-word-input" data-idx="${i}" value="${_esc(w.word)}" />
                <span class="ce-word-dur">${(w.end - w.start).toFixed(2)}s</span>
              </div>
            `).join('')}
          </div>
        </div>
        ` : ''}
      </div>

      <div class="ce-right">
        <!-- Preview -->
        <div class="ce-section">
          <div class="ce-subhead">Live Preview</div>
          <div class="ce-preview-container">
            <canvas id="ce-preview-canvas" width="960" height="540"></canvas>
          </div>
          <div class="ce-playback">
            <button id="ce-play-btn" class="ce-btn ce-primary" ${!S.words.length ? 'disabled' : ''}>
              ${S.playing ? '⏸ Pause' : '▶ Play'}
            </button>
            <input type="range" id="ce-seek" class="ce-seek" min="0" max="${S.duration || 0}" step="0.01" value="${S.currentTime}" />
            <span class="ce-time">${S.currentTime.toFixed(1)}s / ${S.duration.toFixed(1)}s</span>
          </div>
        </div>

        <!-- Style -->
        <div class="ce-section">
          <div class="ce-subhead">Style</div>
          <div class="ce-row">
            <label class="ce-label">Preset</label>
            <select id="ce-preset" class="ce-select">
              <option value="fade" ${S.style.preset === 'fade' ? 'selected' : ''}>Fade-in</option>
              <option value="pop" ${S.style.preset === 'pop' ? 'selected' : ''}>Pop-in (Hormozi)</option>
              <option value="bounce" ${S.style.preset === 'bounce' ? 'selected' : ''}>Bounce</option>
            </select>
          </div>
          <div class="ce-row">
            <label class="ce-label">Font</label>
            <select id="ce-font" class="ce-select">
              <option value="Arial" ${S.style.font_family === 'Arial' ? 'selected' : ''}>Arial</option>
              <option value="Arial Black" ${S.style.font_family === 'Arial Black' ? 'selected' : ''}>Arial Black</option>
              <option value="Impact" ${S.style.font_family === 'Impact' ? 'selected' : ''}>Impact</option>
              <option value="Montserrat" ${S.style.font_family === 'Montserrat' ? 'selected' : ''}>Montserrat</option>
            </select>
          </div>
          <div class="ce-row">
            <label class="ce-label">Size</label>
            <input type="range" id="ce-size" class="ce-range" min="30" max="200" value="${S.style.font_size}" />
            <span class="ce-range-val">${S.style.font_size}px</span>
          </div>
          <div class="ce-row">
            <label class="ce-label">Text Color</label>
            <input type="color" id="ce-color" class="ce-color" value="${S.style.fill_color}" />
          </div>
          <div class="ce-row">
            <label class="ce-label">Outline</label>
            <input type="color" id="ce-stroke" class="ce-color" value="${S.style.stroke_color}" />
            <input type="range" id="ce-stroke-w" class="ce-range" min="0" max="10" value="${S.style.stroke_width}" />
          </div>
          <div class="ce-row">
            <label class="ce-label">Position Y</label>
            <input type="range" id="ce-pos-y" class="ce-range" min="0.1" max="0.95" step="0.05" value="${S.style.position_y}" />
            <span class="ce-range-val">${Math.round(S.style.position_y * 100)}%</span>
          </div>
        </div>

        <!-- Apply -->
        <div class="ce-section">
          <div class="ce-subhead">Apply to Timeline</div>
          <div class="ce-actions">
            <button id="ce-clear-btn" class="ce-btn ce-ghost">Clear Existing</button>
            <button id="ce-render-btn" class="ce-btn ce-primary" ${!S.words.length || S.busy ? 'disabled' : ''}>
              ${S.busy ? 'Working…' : 'Render & Apply'}
            </button>
          </div>
          ${S.renderStatus ? `<div class="ce-status ce-status-progress">${_esc(S.renderStatus)}</div>` : ''}
          ${S.busy && S.renderProgress > 0 ? `
            <div class="ce-progress-bar">
              <div class="ce-progress-fill" style="width: ${S.renderProgress}%"></div>
              <span class="ce-progress-text">${S.renderProgress}%</span>
            </div>
          ` : ''}
          ${S.renderResult ? `
            <div class="ce-result">
              <span class="ce-pill ${S.renderResult.success ? 'ce-pill-ok' : 'ce-pill-err'}">
                ${S.renderResult.success ? '✓ Applied' : '✗ Failed'}
              </span>
              ${S.renderResult.path ? `<div class="ce-result-path">${_esc(S.renderResult.path)}</div>` : ''}
              ${S.renderResult.size_mb ? `<div class="ce-result-size">${S.renderResult.size_mb} MB</div>` : ''}
              ${S.renderResult.error ? `<div class="ce-status ce-err">${_esc(S.renderResult.error)}</div>` : ''}
            </div>
          ` : ''}
        </div>
      </div>
    </div>
  `;

  // Wire up
  v.querySelector('[data-act="close"]').onclick = closeCaptionEditor;
  v.querySelector('#ce-manage-btn').onclick = _openSettings;
  v.querySelector('#ce-transcribe-btn').onclick = _onTranscribeFromSequence;
  v.querySelector('#ce-audio-upload').onchange = _onAudioUpload;
  v.querySelector('#ce-paste-btn').onclick = _onPasteTranscript;
  v.querySelector('#ce-play-btn').onclick = _togglePlay;
  v.querySelector('#ce-seek').oninput = (e) => { S.currentTime = parseFloat(e.target.value); _updatePreview(); };
  v.querySelector('#ce-preset').onchange = (e) => { S.style.preset = e.target.value; _updatePreview(); };
  v.querySelector('#ce-font').onchange = (e) => { S.style.font_family = e.target.value; _updatePreview(); };
  v.querySelector('#ce-size').oninput = (e) => { S.style.font_size = parseInt(e.target.value); _updatePreview(); v.querySelector('.ce-range-val').textContent = e.target.value + 'px'; };
  v.querySelector('#ce-color').onchange = (e) => { S.style.fill_color = e.target.value; _updatePreview(); };
  v.querySelector('#ce-stroke').onchange = (e) => { S.style.stroke_color = e.target.value; _updatePreview(); };
  v.querySelector('#ce-stroke-w').oninput = (e) => { S.style.stroke_width = parseInt(e.target.value); _updatePreview(); };
  v.querySelector('#ce-pos-y').oninput = (e) => { S.style.position_y = parseFloat(e.target.value); _updatePreview(); v.querySelector('.ce-range-val').textContent = Math.round(parseFloat(e.target.value) * 100) + '%'; };
  v.querySelector('#ce-clear-btn').onclick = _onClear;
  v.querySelector('#ce-render-btn').onclick = _onRenderAndApply;

  // Word list editing
  v.querySelectorAll('.ce-word-input').forEach(input => {
    input.oninput = (e) => {
      const idx = parseInt(e.target.dataset.idx);
      if (S.words[idx]) {
        S.words[idx].word = e.target.value;
        _updatePreview();
      }
    };
    input.onfocus = (e) => {
      S.selectedWordIdx = parseInt(e.target.dataset.idx);
      v.querySelectorAll('.ce-word-row').forEach(r => r.classList.remove('ce-word-selected'));
      e.target.closest('.ce-word-row').classList.add('ce-word-selected');
    };
  });

  // Initialize canvas
  S._canvas = v.querySelector('#ce-preview-canvas');
  S._ctx = S._canvas.getContext('2d');
  _updatePreview();
}

// ── Canvas Preview ──
function _startPreviewLoop() {
  if (S._raf) cancelAnimationFrame(S._raf);
  function loop() {
    if (S.playing) {
      S.currentTime += 1/30; // 30fps preview
      if (S.currentTime >= S.duration) {
        S.currentTime = 0;
        S.playing = false;
      }
      const seek = $('#ce-seek');
      if (seek) seek.value = S.currentTime;
      _updatePreview();
    }
    S._raf = requestAnimationFrame(loop);
  }
  S._raf = requestAnimationFrame(loop);
}

function _togglePlay() {
  if (!S.words.length) return;
  S.playing = !S.playing;
  if (S.playing && S.currentTime >= S.duration) {
    S.currentTime = 0;
  }
  _render();
}

function _updatePreview() {
  if (!S._ctx) return;
  const ctx = S._ctx;
  const w = S._canvas.width;
  const h = S._canvas.height;

  // Clear with dark background (simulates video underneath)
  ctx.fillStyle = '#1a1a22';
  ctx.fillRect(0, 0, w, h);

  if (!S.words.length) {
    ctx.fillStyle = '#666';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Transcribe audio to see preview', w/2, h/2);
    return;
  }

  // Find active word
  const t = S.currentTime;
  let activeWord = null;
  let progress = 0;
  for (const word of S.words) {
    if (word.start <= t && t < word.end) {
      activeWord = word;
      progress = (t - word.start) / (word.end - word.start);
      break;
    }
  }

  if (!activeWord) return;

  // Compute animation state
  const anim = _computeAnimState(S.style.preset, progress);
  if (anim.opacity <= 0.01) return;

  // Render text
  const fontSize = S.style.font_size * (w / 1920); // scale to preview
  const font = `bold ${fontSize}px ${S.style.font_family}, sans-serif`;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const x = w * S.style.position_x;
  const y = h * S.style.position_y;
  const text = activeWord.word.toUpperCase();

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(anim.scale, anim.scale);
  ctx.globalAlpha = anim.opacity;

  // Stroke (outline)
  if (S.style.stroke_width > 0) {
    ctx.strokeStyle = S.style.stroke_color;
    ctx.lineWidth = S.style.stroke_width * 2 * (w / 1920);
    ctx.lineJoin = 'round';
    ctx.strokeText(text, 0, 0);
  }

  // Fill
  ctx.fillStyle = S.style.fill_color;
  ctx.fillText(text, 0, 0);

  ctx.restore();

  // Update time display
  const timeEl = $('.ce-time');
  if (timeEl) timeEl.textContent = `${S.currentTime.toFixed(1)}s / ${S.duration.toFixed(1)}s`;
}

function _computeAnimState(preset, progress) {
  const intro_dur = 0.2;
  if (progress < intro_dur) {
    const intro_progress = progress / intro_dur;
    if (preset === 'fade') {
      return { scale: 1.0, opacity: 1 - Math.pow(1 - intro_progress, 3) };
    } else if (preset === 'pop') {
      const c1 = 1.70158, c3 = c1 + 1;
      const eased = 1 + c3 * Math.pow(intro_progress - 1, 3) + c1 * Math.pow(intro_progress - 1, 2);
      return { scale: Math.min(1.1, eased * 1.1), opacity: Math.min(1.0, intro_progress * 2) };
    } else if (preset === 'bounce') {
      let scale;
      if (intro_progress < 0.4) scale = (intro_progress / 0.4) * 1.25;
      else if (intro_progress < 0.7) scale = 1.25 - ((intro_progress - 0.4) / 0.3) * 0.35;
      else scale = 0.9 + ((intro_progress - 0.7) / 0.3) * 0.1;
      return { scale, opacity: Math.min(1.0, intro_progress * 3) };
    }
  }
  return { scale: 1.0, opacity: 1.0 };
}

// ── Actions ──
function _openSettings() {
  try {
    if (typeof openSettings === 'function') openSettings();
    else if (window.__editflowOpenSettings) window.__editflowOpenSettings();
    else { const btn = document.getElementById('btn-settings'); if (btn) btn.click(); }
  } catch (e) { console.error('could not open settings:', e); }
}

async function _refreshModelStatus() {
  const pill = $('#ce-model-pill');
  if (!pill) return;
  try {
    const r = await apiGet('/api/whisper/status', { timeoutMs: 8000 });
    S.modelName = r.active_model || '';
    const installed = (r.supported_models || []).find(m => m.name === S.modelName);
    S.modelInstalled = !!(installed && installed.installed);
    if (S.modelInstalled) {
      pill.textContent = `whisper: ${S.modelName} ✓`;
      pill.className = 'ce-pill ce-pill-ok';
    } else {
      pill.textContent = `whisper: ${S.modelName} (not installed)`;
      pill.className = 'ce-pill ce-pill-err';
    }
  } catch (e) {
    pill.textContent = 'whisper: offline';
    pill.className = 'ce-pill ce-pill-err';
  }
}

async function _refreshSeqSettings() {
  try {
    if (!isExtendScriptAvailable()) return;
    const resp = await callExtendScript('getCaptionSequenceSettings');
    if (resp && resp.success) {
      S.seqSettings = resp;
    }
  } catch (e) { /* non-fatal */ }
}

async function _onTranscribeFromSequence() {
  if (S.busy) return;
  S.busy = true;
  S.error = null;
  S.status = 'Getting audio from sequence...';
  _render();

  try {
    if (!isExtendScriptAvailable()) {
      throw new Error('ExtendScript not available — are you running inside Premiere?');
    }
    if (!S.modelInstalled) {
      throw new Error(`Whisper model "${S.modelName}" not installed. Open Settings to download.`);
    }

    // Get the audio from the active sequence
    S.status = 'Extracting audio path from sequence...';
    _render();
    const seqState = await callExtendScript('getSequenceState');
    if (!seqState || !seqState.success) {
      throw new Error('Could not get sequence state. Open a sequence with audio.');
    }

    // Find audio file path from sequence
    let audioPath = null;
    if (seqState.sequence && seqState.sequence.clips) {
      for (const clip of seqState.sequence.clips) {
        if (clip.mediaPath && clip.mediaPath.match(/\.(wav|mp3|m4a|aac|aif|aiff|mov|mp4|m4v)$/i)) {
          audioPath = clip.mediaPath;
          break;
        }
      }
    }
    if (!audioPath) {
      throw new Error('No audio file found in the active sequence. Add an audio clip to the sequence first.');
    }

    // Upload for transcription
    S.status = 'Uploading audio + transcribing with Whisper...';
    _render();
    const wavBlob = await _readFileAsBlob(audioPath);
    const clientId = (getState && getState().session && getState().session.clientId) || 'caption-editor';
    const resp = await apiUpload(
      '/api/captions/transcribe',
      wavBlob,
      { client_id: clientId, sequence_name: S.seqSettings?.name || 'sequence' },
      { timeoutMs: 600000 }
    );

    S.words = resp.words || [];
    S.duration = resp.duration || 0;
    S.status = null;
    S.currentTime = 0;

    if (!S.words.length) {
      throw new Error('Transcription completed but no words found.');
    }
  } catch (e) {
    console.error('[captions] transcribe failed:', e);
    S.error = e.message || String(e);
    S.status = null;
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
  S.status = 'Uploading + transcribing...';
  _render();

  try {
    if (!S.modelInstalled) {
      throw new Error(`Whisper model "${S.modelName}" not installed.`);
    }
    const clientId = (getState && getState().session && getState().session.clientId) || 'caption-editor';
    const resp = await apiUpload(
      '/api/captions/transcribe',
      file,
      { client_id: clientId, sequence_name: file.name },
      { timeoutMs: 600000 }
    );
    S.words = resp.words || [];
    S.duration = resp.duration || 0;
    S.status = null;
    S.currentTime = 0;
  } catch (e) {
    S.error = e.message || String(e);
    S.status = null;
  } finally {
    S.busy = false;
    _render();
  }
}

function _onPasteTranscript() {
  const text = prompt('Paste SRT, JSON, or plain text:');
  if (!text) return;
  try {
    let words = null;
    if (text.trim().startsWith('[') || text.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        words = _parseJsonTranscript(parsed);
      } catch (e) { /* fall through */ }
    }
    if (!words) words = _parseSrt(text);
    if (!words || words.length === 0) words = _parsePlainText(text);
    if (!words || words.length === 0) throw new Error('Could not parse transcript');
    S.words = words;
    S.duration = words[words.length - 1].end;
    S.currentTime = 0;
    S.error = null;
    _render();
  } catch (e) {
    S.error = e.message || String(e);
    _render();
  }
}

async function _onRenderAndApply() {
  if (S.busy || !S.words.length) return;
  S.busy = true;
  S.renderResult = null;
  S.renderProgress = 0;
  S.renderStatus = 'Rendering ProRes video...';
  _render();

  try {
    // 1. Get sequence settings (or use defaults)
    let renderConfig = {
      width: 1920,
      height: 1080,
      fps: 30,
      duration: S.duration + 0.5,
    };
    if (S.seqSettings) {
      renderConfig.width = S.seqSettings.width || 1920;
      renderConfig.height = S.seqSettings.height || 1080;
      renderConfig.fps = S.seqSettings.fps || 30;
    }

    // 2. Render the video via backend
    S.renderStatus = 'Rendering ProRes 4444 video with alpha...';
    _render();
    const clientId = (getState && getState().session && getState().session.clientId) || 'caption-editor';
    const renderResp = await apiPost(
      '/api/captions/render',
      {
        words: S.words,
        style: S.style,
        render: renderConfig,
        client_id: clientId,
      },
      { timeoutMs: 300000 }  // 5 min timeout
    );

    // 3. Import into Premiere
    S.renderStatus = 'Importing into Premiere Pro...';
    S.renderProgress = 90;
    _render();

    if (!isExtendScriptAvailable()) {
      throw new Error('ExtendScript not available — video rendered but cannot import. File: ' + renderResp.path);
    }

    const importResp = await callExtendScript('importCaptionVideo', {
      videoPath: renderResp.path,
    });

    if (!importResp || !importResp.success) {
      throw new Error(importResp?.error || 'Import failed');
    }

    S.renderResult = {
      success: true,
      path: renderResp.path,
      size_mb: renderResp.size_mb,
      cached: renderResp.cached,
      track_index: importResp.track_index,
      clip_name: importResp.clip_name,
    };
    S.renderStatus = null;
    S.renderProgress = 100;
  } catch (e) {
    console.error('[captions] render+apply failed:', e);
    S.renderResult = {
      success: false,
      error: e.message || String(e),
    };
    S.renderStatus = null;
    S.renderProgress = 0;
  } finally {
    S.busy = false;
    _render();
  }
}

async function _onClear() {
  try {
    if (!isExtendScriptAvailable()) return;
    await callExtendScript('clearCaptionClips');
    S.renderResult = null;
    _render();
  } catch (e) {
    S.error = e.message || String(e);
    _render();
  }
}

function _updateRenderStatus() {
  const el = $('.ce-status-progress');
  if (el && S.renderStatus) el.textContent = S.renderStatus;
  const bar = $('.ce-progress-fill');
  if (bar) bar.style.width = S.renderProgress + '%';
  const text = $('.ce-progress-text');
  if (text) text.textContent = S.renderProgress + '%';
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

function _parseSrt(text) {
  const cues = [];
  const blocks = text.trim().split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim());
    if (lines.length < 2) continue;
    let timeLineIdx = 0;
    if (/^\d+$/.test(lines[0].trim())) timeLineIdx = 1;
    if (timeLineIdx >= lines.length) continue;
    const m = lines[timeLineIdx].match(/(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})/);
    if (!m) continue;
    const start = _srtTime(m[1]);
    const end = _srtTime(m[2]);
    const cueText = lines.slice(timeLineIdx + 1).join(' ').trim();
    if (cueText) cues.push({ start, end, text: cueText });
  }
  return _cuesToWords(cues);
}

function _srtTime(t) {
  const c = t.replace(',', '.');
  const p = c.split(':');
  if (p.length === 3) return parseInt(p[0]) * 3600 + parseInt(p[1]) * 60 + parseFloat(p[2]);
  if (p.length === 2) return parseInt(p[0]) * 60 + parseFloat(p[1]);
  return parseFloat(c) || 0;
}

function _parseJsonTranscript(data) {
  let words = [];
  if (Array.isArray(data)) {
    if (data.length === 0) return null;
    const first = data[0];
    if (first.word !== undefined || first.text !== undefined) {
      words = data.map(w => ({
        word: w.word || w.text || '',
        start: parseFloat(w.start || 0),
        end: parseFloat(w.end || 0),
      })).filter(w => w.word && isFinite(w.start) && isFinite(w.end));
    }
  } else if (data && data.segments) {
    for (const seg of data.segments) {
      if (seg.words && seg.words.length) {
        for (const w of seg.words) {
          words.push({ word: w.word || w.text || '', start: parseFloat(w.start || 0), end: parseFloat(w.end || 0) });
        }
      } else if (seg.text) {
        words = words.concat(_cuesToWords([{ start: seg.start, end: seg.end, text: seg.text }]));
      }
    }
  }
  return words.length ? words : null;
}

function _parsePlainText(text) {
  const ws = text.split(/\s+/).filter(w => w.length > 0);
  if (!ws.length) return [];
  const dur = 0.4;
  return ws.map((word, i) => ({ word, start: i * dur, end: (i + 1) * dur }));
}

function _cuesToWords(cues) {
  const words = [];
  for (const cue of cues) {
    const ws = cue.text.split(/\s+/).filter(w => w.length > 0);
    if (!ws.length) continue;
    const dur = cue.end - cue.start;
    const totalChars = ws.reduce((s, w) => s + w.length, 0);
    let off = 0;
    for (const word of ws) {
      const start = cue.start + (off / totalChars) * dur;
      off += word.length;
      const end = cue.start + (off / totalChars) * dur;
      words.push({ word, start, end });
    }
  }
  return words;
}

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export { openCaptionEditor, closeCaptionEditor };
