/**
 * native-captions-view.js — Native Animated Captions (word-by-word MOGRT
 * placement + native Premiere keyframe animation).
 *
 * v2: Fixed error visibility, added paste-transcript, added inline model
 * management, improved audio extraction error messages.
 *
 * Reliability-first architecture:
 *   1. Pre-bake style into base_text.mogrt (per-clip: only text content changes)
 *   2. Opacity-first animation ladder: Fade-in > Pop-in > Bounce
 *   3. Diagnostic probe before any generation
 *   4. Smoke test button (1 word) before bulk Generate
 *   5. Defensive logging + bail-fast on 3 systemic errors
 *
 * Backend: /api/subtitles/transcribe-mixdown (Whisper on the mixdown WAV)
 *          /api/whisper/status (model availability)
 *          /api/whisper/set-model (switch active model)
 *          /api/diag/log (relay probe results to backend log)
 * ExtendScript: extractSequenceAudio, runDiagnosticProbe, applyNativeCaptions
 */
import { apiGet, apiPost, apiUpload, connectWS, getBaseUrl } from './api.js';
import { callExtendScript, isExtendScriptAvailable } from './extendscript.js';
import { getState } from './state.js';

const $ = (sel) => document.querySelector(sel);

const S = {
  // Transcription state
  words: [],                  // [{word, start, end, confidence}] in sequence time
  fingerprint: null,
  duration: 0,
  // Model state
  modelName: '',
  modelInstalled: false,
  modelStatus: null,          // full /api/whisper/status response
  // Settings
  preset: 'pop',              // 'fade' | 'pop' | 'bounce'
  trackIndex: null,           // null = auto-create new track on top
  // Probe
  probeResult: null,
  probeRunning: false,
  // Generation
  busy: false,                // true during extract/transcribe OR generate
  generateResult: null,       // {placed, total, errors}
  generateProgress: 0,        // 0-100
  generateStatus: null,       // string | null (progress messages)
  // Error state (survives _render() — the old bug was that errors were lost)
  extractError: null,         // string | null
  extractStatus: null,        // string | null (progress messages)
  extractProgress: 0,         // 0-100
  // View bookkeeping
  prevView: null,
  _modelPoll: null,
  // Tab state for Step 1
  step1Tab: 'extract',        // 'extract' | 'paste'
};

// ── Public ───────────────────────────────────────────────────
function openNativeCaptions(opts = {}) {
  _ensureStyles();
  const v = _ensureContainer();
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
  v.classList.remove('hidden');
  _render();
  _refreshModelStatus();
  if (!S._modelPoll) {
    S._modelPoll = setInterval(() => {
      const el = $('#native-captions-view');
      if (!el || el.classList.contains('hidden') || document.hidden) return;
      _refreshModelStatus();
    }, 15000);
  }
}

function closeNativeCaptions() {
  $('#native-captions-view')?.classList.add('hidden');
  if (S._modelPoll) { clearInterval(S._modelPoll); S._modelPoll = null; }
  const hero = $('#hero'), chat = $('#chat-scroll'), footer = $('#app-footer');
  if (S.prevView) {
    hero?.classList.toggle('hidden', S.prevView.hero);
    chat?.classList.toggle('hidden', S.prevView.chat);
    footer?.classList.toggle('hidden', S.prevView.footer);
  }
}

// ── Styles + container ───────────────────────────────────────
function _ensureStyles() {
  if (document.getElementById('nc-style-link')) return;
  const link = document.createElement('link');
  link.id = 'nc-style-link';
  link.rel = 'stylesheet';
  link.href = 'styles/native-captions.css?v=' + Date.now();
  document.head.appendChild(link);
}

function _ensureContainer() {
  let v = $('#native-captions-view');
  if (!v) {
    v = document.createElement('div');
    v.id = 'native-captions-view';
    v.className = 'native-captions-view hidden';
    ($('#app-main') || document.body).appendChild(v);
  }
  return v;
}

// ── Render ───────────────────────────────────────────────────
function _render() {
  const v = _ensureContainer();
  v.innerHTML = `
    <div class="nc-bar">
      <div class="nc-title">Native Animated Captions</div>
      <span id="nc-model-pill" class="nc-pill nc-pill-warn">checking model…</span>
      <button id="nc-manage-models-btn" class="nc-btn nc-btn-tiny" title="Manage Whisper models">Manage Models</button>
      <span class="nc-spacer"></span>
      <button class="nc-btn nc-ghost" data-act="close">Close</button>
    </div>

    <div class="nc-body">
      <div class="nc-left">
        <!-- Step 1: Extract & Transcribe / Paste Transcript -->
        <div class="nc-section">
          <div class="nc-subhead">Step 1 — Get Word Timestamps</div>

          <div class="nc-tabs">
            <button class="nc-tab ${S.step1Tab === 'extract' ? 'nc-tab-active' : ''}" data-tab="extract">
              Extract &amp; Transcribe
            </button>
            <button class="nc-tab ${S.step1Tab === 'paste' ? 'nc-tab-active' : ''}" data-tab="paste">
              Paste Transcript
            </button>
          </div>

          ${S.step1Tab === 'extract' ? _renderExtractTab() : _renderPasteTab()}
        </div>

        <!-- Step 2: Animation preset -->
        <div class="nc-section">
          <div class="nc-subhead">Step 2 — Animation Preset</div>
          <div class="nc-row">
            <label class="nc-label">Preset</label>
            <select id="nc-preset" class="nc-select">
              <option value="fade" ${S.preset === 'fade' ? 'selected' : ''}>Fade-in (most reliable)</option>
              <option value="pop" ${S.preset === 'pop' ? 'selected' : ''}>Pop-in (Hormozi style)</option>
              <option value="bounce" ${S.preset === 'bounce' ? 'selected' : ''}>Bounce (experimental)</option>
            </select>
          </div>
          <p id="nc-preset-hint" class="nc-hint nc-hint-dim"></p>
        </div>

        <!-- Step 3: Diagnostic probe -->
        <div class="nc-section">
          <div class="nc-subhead">Step 3 — Diagnostic Probe <span class="nc-dim">(recommended before Generate)</span></div>
          <p class="nc-hint">
            Place the playhead at an <strong>empty area</strong> of your sequence,
            then run the probe. It inserts one test MOGRT, verifies Source Text
            patching + Motion/Opacity keyframes work on your Premiere version,
            and cleans up. Takes ~5 seconds.
          </p>
          <div class="nc-actions">
            <button id="nc-probe-btn" class="nc-btn" ${S.probeRunning ? 'disabled' : ''}>
              ${S.probeRunning ? 'Running probe…' : 'Run Probe'}
            </button>
            <span id="nc-probe-status" class="nc-status">${S.probeResult ? (S.probeResult.failed === 0 ? '✓ All steps passed' : '⚠ ' + S.probeResult.failed + ' step(s) failed') : ''}</span>
          </div>
          ${S.probeResult ? _renderProbeSummary() : ''}
        </div>
      </div>

      <div class="nc-right">
        <!-- Step 4: Generate -->
        <div class="nc-section nc-grow">
          <div class="nc-subhead">Step 4 — Generate Captions</div>
          <p class="nc-hint">
            Always run a <strong>smoke test</strong> (1 word) first. If it passes,
            bulk Generate will work.
          </p>
          <div class="nc-actions nc-actions-stacked">
            <button id="nc-smoke-btn" class="nc-btn" ${!S.words.length || S.busy ? 'disabled' : ''}>
              Smoke Test (1 word)
            </button>
            <button id="nc-generate-btn" class="nc-btn nc-primary" ${!S.words.length || S.busy ? 'disabled' : ''}>
              Generate All (${S.words.length} words)
            </button>
          </div>
          ${S.generateStatus ? `<div class="nc-status nc-status-progress">${_esc(S.generateStatus)}</div>` : ''}
          ${S.busy && S.generateProgress > 0 ? `
            <div class="nc-progress-bar">
              <div class="nc-progress-fill" style="width: ${S.generateProgress}%"></div>
              <span class="nc-progress-text">${S.generateProgress}%</span>
            </div>
          ` : ''}
          ${S.generateResult ? _renderGenerateResult() : ''}

          <!-- Probe details drawer -->
          ${S.probeResult ? _renderProbeDrawer() : ''}
        </div>
      </div>
    </div>
  `;

  // Wire up
  v.querySelector('[data-act="close"]').onclick = closeNativeCaptions;
  v.querySelector('#nc-manage-models-btn').onclick = _openSettings;
  v.querySelector('#nc-probe-btn').onclick = _onProbe;
  v.querySelector('#nc-smoke-btn').onclick = () => _onGenerate(true);
  v.querySelector('#nc-generate-btn').onclick = () => _onGenerate(false);

  // Tab switching
  v.querySelectorAll('.nc-tab').forEach(tab => {
    tab.onclick = () => {
      S.step1Tab = tab.dataset.tab;
      S.extractError = null;
      S.extractStatus = null;
      _render();
    };
  });

  // Step 1 tab-specific wiring
  if (S.step1Tab === 'extract') {
    const extractBtn = v.querySelector('#nc-extract-btn');
    if (extractBtn) extractBtn.onclick = _onExtract;
    const wavUpload = v.querySelector('#nc-wav-upload');
    if (wavUpload) wavUpload.onchange = _onWavUpload;
  } else {
    const loadBtn = v.querySelector('#nc-load-transcript-btn');
    if (loadBtn) loadBtn.onclick = _onLoadTranscript;
    const fileInput = v.querySelector('#nc-srt-file');
    if (fileInput) fileInput.onchange = _onSrtFileSelected;
  }

  const presetSel = v.querySelector('#nc-preset');
  if (presetSel) {
    presetSel.onchange = (e) => {
      S.preset = e.target.value;
      _updatePresetHint();
    };
  }
  _updatePresetHint();
}

function _renderExtractTab() {
  return `
    <p class="nc-hint">
      Set In/Out points (press <kbd>I</kbd> and <kbd>O</kbd> in Premiere) on the
      section you want captioned. Then click below: we'll export a WAV mixdown
      of that range and run Whisper on it to get word-level timestamps.
    </p>
    <div class="nc-actions">
      <button id="nc-extract-btn" class="nc-btn nc-primary" ${S.busy ? 'disabled' : ''}>
        ${S.busy ? 'Working…' : 'Extract &amp; Transcribe'}
      </button>
      <label class="nc-btn nc-ghost" style="cursor:pointer" title="If audio extraction fails, export a WAV manually from Premiere (File > Export > Media > Wave) and upload it here">
        Upload WAV
        <input type="file" id="nc-wav-upload" accept=".wav,audio/wav" style="display:none" />
      </label>
    </div>
    ${S.extractStatus ? `<div class="nc-status nc-status-progress">${_esc(S.extractStatus)}</div>` : ''}
    ${S.busy && S.extractProgress > 0 ? `
      <div class="nc-progress-bar">
        <div class="nc-progress-fill" style="width: ${S.extractProgress}%"></div>
        <span class="nc-progress-text">${S.extractProgress}%</span>
      </div>
    ` : ''}
    ${S.extractError ? `<div class="nc-status nc-err">${_esc(S.extractError)}</div>` : ''}
    ${S.words.length ? `
      <div class="nc-words-info">
        <strong>${S.words.length}</strong> words transcribed
        (${S.duration.toFixed(1)}s)
        ${S.fingerprint ? `· fingerprint <code>${S.fingerprint}</code>` : ''}
      </div>
    ` : ''}
    <details class="nc-drawer" style="margin-top: 8px">
      <summary style="font-size: 11px; color: #6b6b7a; cursor: pointer">Audio extraction not working? Click for help</summary>
      <div style="font-size: 11px; color: #9a9aa8; margin-top: 6px; line-height: 1.6">
        If "Extract &amp; Transcribe" fails with "export returned no file", it means
        the bundled .epr preset doesn't work on your Premiere version.<br><br>
        <strong>Workaround:</strong> Export audio manually from Premiere:
        <ol style="margin: 4px 0; padding-left: 20px">
          <li>File &gt; Export &gt; Media</li>
          <li>Format: <strong>Wave</strong></li>
          <li>Set range to your In/Out points</li>
          <li>Export to a .wav file</li>
          <li>Click "Upload WAV" above to transcribe it</li>
        </ol>
      </div>
    </details>
  `;
}

function _renderPasteTab() {
  return `
    <p class="nc-hint">
      Have a transcript already? Paste it here as <strong>SRT</strong>,
      <strong>JSON</strong> (with word timestamps), or plain text. We'll
      convert it to word-level timestamps for caption placement.
    </p>
    <textarea id="nc-transcript-input" class="nc-textarea" rows="8"
      placeholder="Paste SRT here...&#10;&#10;1&#10;00:00:00,000 --> 00:00:02,000&#10;Hello world&#10;&#10;2&#10;00:00:02,000 --> 00:00:04,500&#10;This is a test&#10;&#10;Or paste JSON:&#10;[{\"word\":\"hello\",\"start\":0,\"end\":0.5},...]"></textarea>
    <div class="nc-actions">
      <button id="nc-load-transcript-btn" class="nc-btn nc-primary">Load Transcript</button>
      <label class="nc-btn nc-ghost" style="cursor:pointer">
        Or upload .srt file
        <input type="file" id="nc-srt-file" accept=".srt,.txt,.json" style="display:none" />
      </label>
      <span id="nc-paste-status" class="nc-status"></span>
    </div>
    ${S.words.length ? `
      <div class="nc-words-info">
        <strong>${S.words.length}</strong> words loaded
        (${S.duration.toFixed(1)}s)
      </div>
    ` : ''}
  `;
}

function _renderProbeSummary() {
  const r = S.probeResult;
  const cls = r.failed === 0 ? 'nc-pill-ok' : 'nc-pill-err';
  return `<div class="nc-probe-summary">
    <span class="nc-pill ${cls}">${r.passed}/${r.steps.length} steps passed</span>
    <span class="nc-dim">PPro ${r.premiere_version || '?'}</span>
  </div>`;
}

function _renderProbeDrawer() {
  const r = S.probeResult;
  const steps = r.steps.map(s => {
    const icon = s.ok ? '✓' : '✗';
    const cls = s.ok ? 'nc-step-ok' : 'nc-step-err';
    const err = s.error ? `<div class="nc-step-error">${_esc(s.error)}</div>` : '';
    const det = s.details ? `<details class="nc-step-details"><summary>details</summary><pre>${_esc(JSON.stringify(s.details, null, 2))}</pre></details>` : '';
    return `<div class="nc-step ${cls}">
      <span class="nc-step-icon">${icon}</span>
      <div class="nc-step-body">
        <div class="nc-step-name">${_esc(s.step)}</div>
        ${err}${det}
      </div>
    </div>`;
  }).join('');
  return `<details class="nc-drawer">
    <summary>Probe details (${r.passed}/${r.steps.length} passed)</summary>
    <div class="nc-steps">${steps}</div>
  </details>`;
}

function _renderGenerateResult() {
  const r = S.generateResult;
  if (!r) return '';
  const errList = (r.errors || []).slice(0, 10).map(e => `<li>${_esc(typeof e === 'string' ? e : JSON.stringify(e))}</li>`).join('');
  const cls = r.placed === r.total ? 'nc-pill-ok' : 'nc-pill-err';
  return `<div class="nc-gen-result">
    <span class="nc-pill ${cls}">${r.placed}/${r.total} placed</span>
    ${r.errors?.length ? `<details class="nc-drawer"><summary>${r.errors.length} errors</summary><ul class="nc-error-list">${errList}</ul></details>` : ''}
  </div>`;
}

function _updatePresetHint() {
  const el = $('#nc-preset-hint');
  if (!el) return;
  const hints = {
    fade: 'Opacity 0→100 over 0.3s. Most reliable — works on all Premiere versions.',
    pop: 'Scale 0→110→100 + Opacity 0→100 over 0.25s. Hormozi-style pop-in. Works on 95% of setups.',
    bounce: 'Scale 0→125→90→100 + Opacity 0→100 over 0.4s. Experimental — known Premiere bug may affect keyframes.',
  };
  el.textContent = hints[S.preset] || '';
}

// ── Actions ──────────────────────────────────────────────────
function _openSettings() {
  try {
    if (typeof openSettings === 'function') {
      openSettings();
    } else if (window.__editflowOpenSettings) {
      window.__editflowOpenSettings();
    } else {
      const btn = document.getElementById('btn-settings');
      if (btn) btn.click();
    }
  } catch (e) {
    console.error('[native-captions] could not open settings:', e);
  }
}

async function _refreshModelStatus() {
  const pill = $('#nc-model-pill');
  if (!pill) return;
  try {
    const r = await apiGet('/api/whisper/status', { timeoutMs: 8000 });
    S.modelStatus = r;
    S.modelName = r.active_model || '';
    const installed = (r.supported_models || []).find(m => m.name === S.modelName);
    S.modelInstalled = !!(installed && installed.installed);
    if (S.modelInstalled) {
      pill.textContent = `whisper: ${S.modelName} ✓`;
      pill.className = 'nc-pill nc-pill-ok';
    } else {
      pill.textContent = `whisper: ${S.modelName} (not installed)`;
      pill.className = 'nc-pill nc-pill-err';
    }
  } catch (e) {
    pill.textContent = 'whisper: status check failed';
    pill.className = 'nc-pill nc-pill-err';
  }
}

async function _onExtract() {
  if (S.busy) return;
  S.busy = true;
  S.extractError = null;
  S.extractStatus = 'Starting...';
  S.extractProgress = 0;
  _render();

  // Listen for transcription progress events via WebSocket
  const wsClientId = (getState && getState().session && getState().session.clientId) || 'native-captions';
  let _progressUnsub = null;
  try {
    const { connectWS } = await import('./api.js');
    const ws = connectWS(wsClientId);
    _progressUnsub = ws.on('progress', (data) => {
      const payload = data.payload || data;
      if (payload.task_type === 'transcribe') {
        S.extractProgress = Math.round((payload.progress || 0) * 100);
        S.extractStatus = payload.message || `Transcribing... ${S.extractProgress}%`;
        _render();
      }
    });
  } catch (e) {
    console.warn('[native-captions] WS progress listener failed (non-fatal):', e);
  }

  try {
    if (!isExtendScriptAvailable()) {
      throw new Error('ExtendScript not available — are you running inside Premiere?');
    }

    if (!S.modelInstalled) {
      throw new Error(`Whisper model "${S.modelName}" is not installed. Click "Manage Models" to download it first.`);
    }

    const csInterface = _getCSInterface();
    let extensionRoot = '';
    if (csInterface) {
      const key = (csInterface.SYSTEM_PATH && csInterface.SYSTEM_PATH.EXTENSION) || 'extension';
      extensionRoot = csInterface.getSystemPath(key) || '';
    }
    const eprPath = extensionRoot
      ? extensionRoot.replace(/[\\/]+$/, '') + '/templates/audio/audio_mixdown_wav.epr'
      : 'audio_mixdown_wav.epr';

    const outPath = _tempWavPath();

    S.extractStatus = 'Exporting audio mixdown from Premiere...';
    S.extractProgress = 5;
    _render();

    const extractResp = await callExtendScript('extractSequenceAudio', {
      outPath: outPath,
      eprPath: eprPath,
    });

    if (!extractResp || !extractResp.success) {
      throw new Error(extractResp?.error || 'Audio extraction failed. Make sure you set In/Out points (press I and O in Premiere) and the .epr preset exists.');
    }

    S.extractStatus = 'Uploading WAV + transcribing with Whisper...';
    S.extractProgress = 15;
    _render();

    const wavBlob = await _readFileAsBlob(extractResp.path);
    const clientId = (getState && getState().session && getState().session.clientId) || 'native-captions';
    const resp = await apiUpload(
      '/api/subtitles/transcribe-mixdown',
      wavBlob,
      {
        client_id: clientId,
        sequence_name: 'active_sequence',
        in_seconds: extractResp.in_seconds,
        out_seconds: extractResp.out_seconds,
      },
      { timeoutMs: 600000 }
    );

    S.words = resp.words || [];
    S.fingerprint = resp.fingerprint;
    S.duration = resp.duration || 0;
    S.modelName = resp.model || S.modelName;
    S.extractStatus = null;
    S.extractProgress = 100;

    if (!S.words.length) {
      throw new Error('Transcription completed but no words were found. The audio might be too quiet or not contain speech.');
    }
  } catch (e) {
    console.error('[native-captions] extract failed:', e);
    S.extractError = e.message || String(e);
    S.extractStatus = null;
    S.extractProgress = 0;
    _diagLog('error', 'extract_failed', { error: String(e.message || e) });
  } finally {
    if (_progressUnsub) { try { _progressUnsub(); } catch (_) {} }
    S.busy = false;
    _render();
  }
}

async function _onWavUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (S.busy) return;
  S.busy = true;
  S.extractError = null;
  S.extractStatus = 'Uploading WAV + transcribing with Whisper...';
  S.extractProgress = 15;
  _render();

  // Listen for transcription progress events via WebSocket
  const wsClientId = (getState && getState().session && getState().session.clientId) || 'native-captions';
  let _progressUnsub = null;
  try {
    const { connectWS } = await import('./api.js');
    const ws = connectWS(wsClientId);
    _progressUnsub = ws.on('progress', (data) => {
      const payload = data.payload || data;
      if (payload.task_type === 'transcribe') {
        S.extractProgress = Math.round(15 + (payload.progress || 0) * 85);
        S.extractStatus = payload.message || `Transcribing... ${S.extractProgress}%`;
        _render();
      }
    });
  } catch (e) { /* non-fatal */ }

  try {
    if (!S.modelInstalled) {
      throw new Error(`Whisper model "${S.modelName}" is not installed. Click "Manage Models" to download it first.`);
    }

    const clientId = (getState && getState().session && getState().session.clientId) || 'native-captions';
    const resp = await apiUpload(
      '/api/subtitles/transcribe-mixdown',
      file,
      {
        client_id: clientId,
        sequence_name: file.name,
        in_seconds: 0,
        out_seconds: 0,
      },
      { timeoutMs: 600000 }
    );

    S.words = resp.words || [];
    S.fingerprint = resp.fingerprint;
    S.duration = resp.duration || 0;
    S.modelName = resp.model || S.modelName;
    S.extractStatus = null;
    S.extractProgress = 100;

    if (!S.words.length) {
      throw new Error('Transcription completed but no words were found. The audio might be too quiet or not contain speech.');
    }
  } catch (e) {
    console.error('[native-captions] WAV upload failed:', e);
    S.extractError = e.message || String(e);
    S.extractStatus = null;
    S.extractProgress = 0;
    _diagLog('error', 'wav_upload_failed', { error: String(e.message || e) });
  } finally {
    if (_progressUnsub) { try { _progressUnsub(); } catch (_) {} }
    S.busy = false;
    _render();
  }
}

async function _onLoadTranscript() {
  const ta = $('#nc-transcript-input');
  if (!ta || !ta.value.trim()) {
    const statusEl = $('#nc-paste-status');
    if (statusEl) {
      statusEl.textContent = 'Please paste a transcript first.';
      statusEl.classList.add('nc-err');
    }
    return;
  }

  const text = ta.value.trim();
  const statusEl = $('#nc-paste-status');
  if (statusEl) { statusEl.textContent = 'Parsing...'; statusEl.classList.remove('nc-err'); }

  try {
    let words = null;

    // Try JSON first (array of {word, start, end} or {text, start, end})
    if (text.startsWith('[') || text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        words = _parseJsonTranscript(parsed);
      } catch (e) {
        // Not valid JSON — fall through to SRT
      }
    }

    // Try SRT
    if (!words) {
      words = _parseSrt(text);
    }

    // Try plain text (distribute evenly across 10 seconds)
    if (!words || words.length === 0) {
      words = _parsePlainText(text);
    }

    if (!words || words.length === 0) {
      throw new Error('Could not parse transcript. Expected SRT, JSON array, or plain text.');
    }

    S.words = words;
    S.duration = words.length > 0 ? words[words.length - 1].end : 0;
    S.fingerprint = null;
    S.extractError = null;
    S.extractStatus = null;

    if (statusEl) {
      statusEl.textContent = `✓ Loaded ${words.length} words (${S.duration.toFixed(1)}s)`;
      statusEl.classList.remove('nc-err');
    }
    _diagLog('info', 'paste_transcript_loaded', { wordCount: words.length, duration: S.duration });
  } catch (e) {
    console.error('[native-captions] parse failed:', e);
    if (statusEl) {
      statusEl.textContent = 'Error: ' + (e.message || e);
      statusEl.classList.add('nc-err');
    }
  }
  _render();
}

function _onSrtFileSelected(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const ta = $('#nc-transcript-input');
    if (ta) {
      ta.value = e.target.result;
      _onLoadTranscript();
    }
  };
  reader.readAsText(file);
}

// ── Transcript parsers ───────────────────────────────────────

function _srtTimeToSeconds(timeStr) {
  // Format: HH:MM:SS,mmm or HH:MM:SS.mmm
  const cleaned = timeStr.replace(',', '.');
  const parts = cleaned.split(':');
  if (parts.length === 3) {
    return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
  } else if (parts.length === 2) {
    return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(cleaned) || 0;
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

    const timeMatch = lines[timeLineIdx].match(/(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})/);
    if (!timeMatch) continue;

    const start = _srtTimeToSeconds(timeMatch[1]);
    const end = _srtTimeToSeconds(timeMatch[2]);
    const cueText = lines.slice(timeLineIdx + 1).join(' ').trim();
    if (cueText) cues.push({ start, end, text: cueText });
  }

  return _cuesToWords(cues);
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
        confidence: w.confidence || w.probability || 1.0,
      })).filter(w => w.word && isFinite(w.start) && isFinite(w.end));
    }
  } else if (data && data.segments) {
    for (const seg of data.segments) {
      if (seg.words && seg.words.length) {
        for (const w of seg.words) {
          words.push({
            word: w.word || w.text || '',
            start: parseFloat(w.start || 0),
            end: parseFloat(w.end || 0),
            confidence: w.probability || w.confidence || 1.0,
          });
        }
      } else if (seg.text) {
        const cues = [{ start: seg.start, end: seg.end, text: seg.text }];
        words = words.concat(_cuesToWords(cues));
      }
    }
  }

  return words.length ? words : null;
}

function _parsePlainText(text) {
  const wordStrs = text.split(/\s+/).filter(w => w.length > 0);
  if (!wordStrs.length) return [];
  const wordDur = 0.4;
  return wordStrs.map((word, i) => ({
    word: word,
    start: i * wordDur,
    end: (i + 1) * wordDur,
    confidence: 1.0,
  }));
}

function _cuesToWords(cues) {
  const words = [];
  for (const cue of cues) {
    const cueWords = cue.text.split(/\s+/).filter(w => w.length > 0);
    if (!cueWords.length) continue;
    const dur = cue.end - cue.start;
    const totalChars = cueWords.reduce((sum, w) => sum + w.length, 0);
    let charOffset = 0;
    for (const word of cueWords) {
      const wordStart = cue.start + (charOffset / totalChars) * dur;
      charOffset += word.length;
      const wordEnd = cue.start + (charOffset / totalChars) * dur;
      words.push({
        word: word,
        start: wordStart,
        end: wordEnd,
        confidence: 1.0,
      });
    }
  }
  return words;
}

async function _onProbe() {
  if (S.probeRunning) return;
  S.probeRunning = true;
  _render();
  try {
    if (!isExtendScriptAvailable()) {
      throw new Error('ExtendScript not available — are you running inside Premiere?');
    }
    const mogrtPath = _resolveBaseMogrtPath();
    const resp = await callExtendScript('runDiagnosticProbe', {
      baseMogrtPath: mogrtPath,
    });
    S.probeResult = resp;
    _diagLog('info', 'probe_result', resp);
  } catch (e) {
    console.error('[native-captions] probe failed:', e);
    S.probeResult = {
      steps: [{ step: 'probe_exception', ok: false, error: String(e.message || e), details: null }],
      passed: 0,
      failed: 1,
      summary: 'probe failed',
      premiere_version: '',
    };
    _diagLog('error', 'probe_exception', { error: String(e.message || e) });
  } finally {
    S.probeRunning = false;
    _render();
  }
}

async function _onGenerate(smokeTest) {
  if (S.busy || !S.words.length) return;
  S.busy = true;
  S.generateResult = null;
  S.generateProgress = 0;
  S.generateStatus = smokeTest ? 'Creating test clip...' : 'Creating caption clip...';
  _render();
  try {
    if (!isExtendScriptAvailable()) {
      throw new Error('ExtendScript not available — are you running inside Premiere?');
    }
    const mogrtPath = _resolveBaseMogrtPath();
    const wordsToPlace = smokeTest ? S.words.slice(0, 3) : S.words;

    S.generateStatus = `Placing ${wordsToPlace.length} caption clips (batches of 10)...`;
    S.generateProgress = 10;
    _render();

    // Per-word approach with batching: 10 clips per batch, 500ms delay between
    // batches. This matches how submachine.ai and other pro caption plugins
    // work — separate clips per word, but paced to avoid memory spikes.
    let batchStart = 0;
    let totalPlaced = 0;
    let allErrors = [];
    const batchSize = 10;

    while (true) {
      const batchEnd = Math.min(batchStart + batchSize, wordsToPlace.length);
      S.generateStatus = `Placing clips ${batchStart + 1}-${batchEnd} of ${wordsToPlace.length}...`;
      S.generateProgress = Math.round((batchStart / wordsToPlace.length) * 90) + 5;
      _render();

      const resp = await callExtendScript('applyNativeCaptions', {
        words: wordsToPlace,
        preset: S.preset,
        baseMogrtPath: mogrtPath,
        trackIndex: S.trackIndex,
        textParam: 'Source Text',
        approach: 'per_word',
        batchStart: batchStart,
        batchSize: batchSize,
      });

      totalPlaced += resp.placed || 0;
      if (resp.errors && resp.errors.length) {
        allErrors = allErrors.concat(resp.errors);
      }

      batchStart = resp.next_batch_start;
      if (!resp.has_more || !batchStart) break;

      // 500ms delay between batches to let Premiere's GC run
      await new Promise(r => setTimeout(r, 500));
    }

    S.generateResult = {
      placed: totalPlaced,
      total: wordsToPlace.length,
      errors: allErrors,
      approach: 'per_word',
    };
    S.generateProgress = 100;
    S.generateStatus = null;
    _diagLog('info', smokeTest ? 'smoke_test_result' : 'generate_result', S.generateResult);
  } catch (e) {
    console.error('[native-captions] generate failed:', e);
    S.generateResult = {
      placed: 0,
      total: smokeTest ? 1 : S.words.length,
      errors: [String(e.message || e)],
    };
    S.generateStatus = null;
    _diagLog('error', 'generate_exception', { error: String(e.message || e) });
  } finally {
    S.busy = false;
    _render();
  }
}

// ── Helpers ──────────────────────────────────────────────────
function _getCSInterface() {
  if (typeof CSInterface !== 'undefined') return new CSInterface();
  return null;
}

function _resolveBaseMogrtPath() {
  const csInterface = _getCSInterface();
  if (!csInterface) {
    throw new Error('CSInterface not available — must run inside Premiere CEP.');
  }
  const key = (csInterface.SYSTEM_PATH && csInterface.SYSTEM_PATH.EXTENSION) || 'extension';
  const root = csInterface.getSystemPath(key) || '';
  if (!root) throw new Error('Could not resolve extension root.');
  return root.replace(/[\\/]+$/, '') + '/templates/subtitles/base_text.mogrt';
}

function _tempWavPath() {
  const req = (typeof require === 'function') ? require
            : (window.cep_node && window.cep_node.require) ? window.cep_node.require
            : null;
  if (!req) throw new Error('Node require not available in CEP — cannot determine temp dir.');
  const os = req('os');
  const path = req('path');
  const tmpDir = os.tmpdir();
  const name = 'editflow_mixdown_' + Date.now() + '_' + Math.floor(Math.random() * 10000) + '.wav';
  return path.join(tmpDir, name);
}

async function _readFileAsBlob(path) {
  const req = (typeof require === 'function') ? require
            : (window.cep_node && window.cep_node.require) ? window.cep_node.require
            : null;
  if (!req) throw new Error('Node require not available in CEP — cannot read WAV file.');
  const fs = req('fs');
  const buffer = fs.readFileSync(path);
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return new Blob([bytes], { type: 'audio/wav' });
}

async function _diagLog(level, msg, data) {
  try {
    const tagEl = document.getElementById('boot-tag');
    const build = tagEl ? tagEl.textContent.replace(/^build:/, '') : 'native-captions';
    await apiPost('/api/diag/log', {
      events: [{ level, source: 'native-captions', msg, data }],
      build: build,
    }, { timeoutMs: 5000 });
  } catch (_) { /* never let logging break the flow */ }
}

function _esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export { openNativeCaptions, closeNativeCaptions };
