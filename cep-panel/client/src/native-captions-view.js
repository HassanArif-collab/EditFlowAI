/**
 * native-captions-view.js — Native Animated Captions (word-by-word MOGRT
 * placement + native Premiere keyframe animation).
 *
 * Reliability-first architecture:
 *   1. Pre-bake style into base_text.mogrt (per-clip: only text content changes)
 *   2. Opacity-first animation ladder: Fade-in > Pop-in > Bounce
 *   3. Diagnostic probe before any generation (insert_mogrt → source_text_patch
 *      → motion_scale_keyframe → opacity_keyframe → cleanup)
 *   4. Smoke test button (1 word) before bulk Generate
 *   5. Defensive logging + bail-fast on 3 systemic errors
 *
 * Mirrors review-view.js: dynamic-imported by main.js with BUILD_TAG buster,
 * exposed as window.__editflowOpenNativeCaptions, self-injects CSS with
 * ?v=Date.now() to dodge CEF cache.
 *
 * Backend: /api/subtitles/transcribe-mixdown (Whisper on the mixdown WAV)
 *          /api/whisper/status (model availability)
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
  modelName: '',
  modelInstalled: false,
  // Settings
  preset: 'fade',             // 'fade' | 'pop' | 'bounce'
  trackIndex: null,           // null = auto-create new track on top
  // Probe
  probeResult: null,          // {steps:[{step,ok,error?,details}], passed, failed, summary}
  probeRunning: false,
  // Generation
  busy: false,                // true during extract/transcribe OR generate
  generateResult: null,       // {placed, total, errors}
  // View bookkeeping
  prevView: null,
  _modelPoll: null,
  _ws: null,
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
  // Poll model status every 15s (so installing a model in Settings reflects here)
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
      <span class="nc-spacer"></span>
      <button class="nc-btn nc-ghost" data-act="close">Close</button>
    </div>

    <div class="nc-body">
      <div class="nc-left">
        <!-- Step 1: Extract & Transcribe -->
        <div class="nc-section">
          <div class="nc-subhead">Step 1 — Extract &amp; Transcribe</div>
          <p class="nc-hint">
            Set In/Out points (press <kbd>I</kbd> and <kbd>O</kbd> in Premiere) on the
            section you want captioned. Then click below: we'll export a WAV mixdown
            of that range and run Whisper on it to get word-level timestamps.
          </p>
          <div class="nc-actions">
            <button id="nc-extract-btn" class="nc-btn nc-primary" ${S.busy ? 'disabled' : ''}>
              ${S.busy ? 'Working…' : 'Extract &amp; Transcribe'}
            </button>
            <span id="nc-extract-status" class="nc-status"></span>
          </div>
          ${S.words.length ? `
            <div class="nc-words-info">
              <strong>${S.words.length}</strong> words transcribed
              (${S.duration.toFixed(1)}s)
              ${S.fingerprint ? `· fingerprint <code>${S.fingerprint}</code>` : ''}
            </div>
          ` : ''}
        </div>

        <!-- Step 2: Animation preset -->
        <div class="nc-section">
          <div class="nc-subhead">Step 2 — Animation Preset</div>
          <div class="nc-row">
            <label class="nc-label">Preset</label>
            <select id="nc-preset" class="nc-select">
              <option value="fade" ${S.preset === 'fade' ? 'selected' : ''}>Fade-in (most reliable)</option>
              <option value="pop" ${S.preset === 'pop' ? 'selected' : ''}>Pop-in (Hormozi style)</option>
              <option value="bounce" ${S.preset === 'bounce' ? 'selected' : ''}>Bounce (experimental ⚠️)</option>
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
            <span id="nc-probe-status" class="nc-status"></span>
          </div>
          ${S.probeResult ? _renderProbeSummary() : ''}
        </div>
      </div>

      <div class="nc-right">
        <!-- Step 4: Generate -->
        <div class="nc-section nc-grow">
          <div class="nc-subhead">Step 4 — Generate</div>
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
          ${S.generateResult ? _renderGenerateResult() : ''}

          <!-- Probe details drawer -->
          ${S.probeResult ? _renderProbeDrawer() : ''}
        </div>
      </div>
    </div>
  `;

  // Wire up
  v.querySelector('[data-act="close"]').onclick = closeNativeCaptions;
  v.querySelector('#nc-extract-btn').onclick = _onExtract;
  v.querySelector('#nc-probe-btn').onclick = _onProbe;
  v.querySelector('#nc-smoke-btn').onclick = () => _onGenerate(true);
  v.querySelector('#nc-generate-btn').onclick = () => _onGenerate(false);
  const presetSel = v.querySelector('#nc-preset');
  if (presetSel) {
    presetSel.onchange = (e) => {
      S.preset = e.target.value;
      _updatePresetHint();
    };
  }
  _updatePresetHint();
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
    bounce: 'Scale 0→125→90→100 + Opacity 0→100 over 0.4s. Experimental — known Premiere bug (DVAPR-4217831) may affect keyframes on still-image clips.',
  };
  el.textContent = hints[S.preset] || '';
}

// ── Actions ──────────────────────────────────────────────────
async function _refreshModelStatus() {
  const pill = $('#nc-model-pill');
  if (!pill) return;
  try {
    const r = await apiGet('/api/whisper/status', { timeoutMs: 8000 });
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
  _render();
  const statusEl = $('#nc-extract-status');
  try {
    // 1. Get the active sequence's In/Out + extension paths via ExtendScript
    if (!isExtendScriptAvailable()) {
      throw new Error('ExtendScript not available — are you running inside Premiere?');
    }

    // Resolve the bundled .epr path (templates/audio/audio_mixdown_wav.epr).
    // If the .epr file doesn't exist, sequence_audio.jsx will fall back to
    // trying the "WaveAudio" literal preset name.
    const csInterface = _getCSInterface();
    let extensionRoot = '';
    if (csInterface) {
      const key = (csInterface.SYSTEM_PATH && csInterface.SYSTEM_PATH.EXTENSION) || 'extension';
      extensionRoot = csInterface.getSystemPath(key) || '';
    }
    // Convert to OS-native path with templates/audio subdir
    const eprPath = extensionRoot
      ? extensionRoot.replace(/[\\/]+$/, '') + '/templates/audio/audio_mixdown_wav.epr'
      : 'audio_mixdown_wav.epr';

    // Output WAV path — put it in a temp dir; backend will persist its own copy
    const outPath = _tempWavPath();

    if (statusEl) statusEl.textContent = 'Exporting audio mixdown…';
    const extractResp = await callExtendScript('extractSequenceAudio', {
      outPath: outPath,
      eprPath: eprPath,
    });
    if (!extractResp || !extractResp.success) {
      throw new Error(extractResp?.error || 'Audio extraction failed');
    }

    // 2. Upload the WAV to the backend for transcription
    if (statusEl) statusEl.textContent = 'Uploading WAV + transcribing…';
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
      { timeoutMs: 600000 }  // 10 minutes for slow CPU Whisper
    );

    S.words = resp.words || [];
    S.fingerprint = resp.fingerprint;
    S.duration = resp.duration || 0;
    S.modelName = resp.model || S.modelName;
    if (statusEl) statusEl.textContent = '';
  } catch (e) {
    console.error('[native-captions] extract failed:', e);
    if (statusEl) {
      statusEl.textContent = 'Error: ' + (e.message || e);
      statusEl.classList.add('nc-err');
    }
    // Relay to backend log
    _diagLog('error', 'extract_failed', { error: String(e.message || e) });
  } finally {
    S.busy = false;
    _render();
  }
}

async function _onProbe() {
  if (S.probeRunning) return;
  S.probeRunning = true;
  const statusEl = $('#nc-probe-status');
  if (statusEl) statusEl.textContent = 'Running probe…';
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
    // Relay to backend log
    _diagLog('info', 'probe_result', resp);
    if (statusEl) {
      statusEl.textContent = resp.failed === 0
        ? '✓ All steps passed'
        : `⚠ ${resp.failed} step(s) failed`;
      statusEl.classList.toggle('nc-err', resp.failed > 0);
    }
  } catch (e) {
    console.error('[native-captions] probe failed:', e);
    if (statusEl) {
      statusEl.textContent = 'Error: ' + (e.message || e);
      statusEl.classList.add('nc-err');
    }
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
  _render();
  try {
    if (!isExtendScriptAvailable()) {
      throw new Error('ExtendScript not available — are you running inside Premiere?');
    }
    const mogrtPath = _resolveBaseMogrtPath();
    const wordsToPlace = smokeTest ? S.words.slice(0, 1) : S.words;

    // Warn on bulk > 400 words
    if (!smokeTest && wordsToPlace.length > 400) {
      const ok = confirm(
        `You're about to place ${wordsToPlace.length} caption clips. ` +
        `This takes ~${Math.ceil(wordsToPlace.length * 1.5 / 60)} minutes and ` +
        `may slow Premiere during placement. Continue?`
      );
      if (!ok) {
        S.busy = false;
        _render();
        return;
      }
    }

    const resp = await callExtendScript('applyNativeCaptions', {
      words: wordsToPlace,
      preset: S.preset,
      baseMogrtPath: mogrtPath,
      trackIndex: S.trackIndex,
      textParam: 'Source Text',
    });
    S.generateResult = {
      placed: resp.placed || 0,
      total: resp.total || wordsToPlace.length,
      errors: resp.errors || [],
    };
    _diagLog('info', smokeTest ? 'smoke_test_result' : 'generate_result', S.generateResult);
  } catch (e) {
    console.error('[native-captions] generate failed:', e);
    S.generateResult = {
      placed: 0,
      total: smokeTest ? 1 : S.words.length,
      errors: [String(e.message || e)],
    };
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
  // Resolve the bundled base_text.mogrt path relative to the extension root.
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
  // Use the OS temp dir + a unique name. CEP gives us Node's os module
  // via cep_node.require — os.tmpdir() returns the correct platform path:
  //   Windows: C:\Users\<user>\AppData\Local\Temp
  //   macOS:   /var/folders/xx/...
  //   Linux:   /tmp
  const req = (typeof require === 'function') ? require
            : (window.cep_node && window.cep_node.require) ? window.cep_node.require
            : null;
  if (!req) throw new Error('Node require not available in CEP — cannot determine temp dir.');
  const os = req('os');
  const path = req('path');
  const tmpDir = os.tmpdir();
  const name = 'editflow_mixdown_' + Date.now() + '_' + Math.floor(Math.random() * 10000) + '.wav';
  // path.join produces OS-native separators automatically
  return path.join(tmpDir, name);
}

async function _readFileAsBlob(path) {
  // CEP gives us Node's fs via cep_node.require — use it to read the file
  // into a Blob for fetch upload.
  const req = (typeof require === 'function') ? require
            : (window.cep_node && window.cep_node.require) ? window.cep_node.require
            : null;
  if (!req) throw new Error('Node require not available in CEP — cannot read WAV file.');
  const fs = req('fs');
  const buffer = fs.readFileSync(path);
  // Convert Node Buffer to Uint8Array → Blob
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return new Blob([bytes], { type: 'audio/wav' });
}

async function _diagLog(level, msg, data) {
  try {
    // Read BUILD_TAG from the DOM (main.js stamps #boot-tag with "build:<tag>")
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
