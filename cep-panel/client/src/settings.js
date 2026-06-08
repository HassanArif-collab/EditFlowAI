/**
 * settings.js — Provider, model, and backend settings UI.
 *
 * Ported from the original main-branch provider UI which the user liked.
 * Now structured as an ES module that the single-chat panel can attach.
 */
import { apiGet, apiPost, apiPut, apiDelete, getBaseUrl, setBaseUrl } from './api.js';

const $ = (sel, root = document) => root.querySelector(sel);

let _providers = [];
let _editingProviderId = null;
let _whisperModel = '';

function _esc(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

/**
 * Render the rich settings overlay HTML into #settings-overlay,
 * then attach all the event listeners.
 *
 * Idempotent: safe to call once during init.
 */
function initSettings() {
  const overlay = $('#settings-overlay');
  if (!overlay) {
    console.warn('[settings] #settings-overlay element not found');
    return;
  }

  overlay.innerHTML = `
    <div class="settings-panel">
      <div class="settings-header">
        <h2>Settings</h2>
        <button id="settings-close" class="icon-btn" title="Close">&times;</button>
      </div>
      <div class="settings-body">

        <div class="settings-section">
          <h3>Active Chat Model</h3>
          <div class="settings-field">
            <label for="active-chat-select">Used for project narration, script extraction, and the editor matcher</label>
            <select id="active-chat-select" class="settings-input">
              <option value="">No model selected</option>
            </select>
          </div>
        </div>

        <div class="settings-section">
          <h3>Transcription</h3>
          <div class="settings-field">
            <label for="whisper-model-select">Whisper Model</label>
            <select id="whisper-model-select" class="settings-input">
              <!-- Sizes reflect faster-whisper CT2-converted artifacts on disk,
                   not the original OpenAI PT sizes which are smaller. -->
              <option value="tiny">tiny (75 MB, fastest, low quality)</option>
              <option value="base">base (145 MB, fast, basic)</option>
              <option value="small">small (466 MB, English-friendly)</option>
              <option value="medium">medium (1.5 GB, multilingual sweet spot)</option>
              <option value="large-v3-turbo">large-v3-turbo (1.6 GB, best quality)</option>
              <option value="large-v3">large-v3 (3.1 GB, GPU recommended)</option>
            </select>
            <div class="settings-help" id="whisper-help"></div>
            <div class="provider-form-actions" style="justify-content: flex-start;">
              <button id="whisper-apply-btn" class="btn btn-primary btn-small">Set &amp; install on next use</button>
              <button id="whisper-preload-btn" class="btn btn-secondary btn-small">Set &amp; preload now</button>
            </div>
            <div id="whisper-apply-status" class="test-result hidden"></div>
            <div id="whisper-download-progress" class="whisper-progress hidden">
              <div class="whisper-progress-label">
                <span id="whisper-progress-model">model</span>
                <span id="whisper-progress-text">0 / 0 MB</span>
              </div>
              <div class="whisper-progress-bar">
                <div class="whisper-progress-fill" id="whisper-progress-fill" style="width: 0%"></div>
              </div>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-section-header">
            <h3>LLM Providers</h3>
            <button id="add-provider-btn" class="btn btn-primary btn-small">+ Add Provider</button>
          </div>
          <div id="providers-list" class="providers-list">
            <div class="providers-loading">Loading providers...</div>
          </div>
        </div>

        <div id="provider-form" class="provider-form hidden">
          <h3 id="provider-form-title">Add Provider</h3>
          <div class="settings-field">
            <label for="pf-name">Provider Name</label>
            <input id="pf-name" type="text" class="settings-input" placeholder="e.g. My OpenAI" />
          </div>
          <div class="settings-field">
            <label for="pf-type">Provider Type</label>
            <select id="pf-type" class="settings-input">
              <option value="ollama">Ollama (Local)</option>
              <option value="openai_compatible">OpenAI Compatible</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <div class="settings-field">
            <label for="pf-base-url">Base URL</label>
            <input id="pf-base-url" type="text" class="settings-input" placeholder="http://localhost:11434" />
          </div>
          <div class="settings-field">
            <label for="pf-api-key">API Key <span class="optional">(optional for Ollama)</span></label>
            <input id="pf-api-key" type="password" class="settings-input" placeholder="sk-..." />
          </div>
          <div class="settings-field">
            <label for="pf-timeout">Timeout (seconds)</label>
            <input id="pf-timeout" type="number" class="settings-input" value="10" min="3" max="120" />
          </div>
          <div class="settings-field">
            <label for="pf-chat-model">Default Chat Model <span class="optional">(optional)</span></label>
            <input id="pf-chat-model" type="text" class="settings-input" placeholder="e.g. gpt-4o, llama3" />
          </div>
          <div class="settings-field">
            <label for="pf-vision-model">Default Vision Model <span class="optional">(optional)</span></label>
            <input id="pf-vision-model" type="text" class="settings-input" placeholder="e.g. gpt-4o, llava" />
          </div>
          <div class="provider-form-actions">
            <button id="pf-test" class="btn btn-secondary">Test Connection</button>
            <button id="pf-save" class="btn btn-primary">Save Provider</button>
            <button id="pf-cancel" class="btn btn-ghost">Cancel</button>
          </div>
          <div id="pf-test-result" class="test-result hidden"></div>
        </div>

        <div class="settings-section">
          <h3>Backend Connection</h3>
          <div class="settings-field">
            <label for="backend-url-input">Backend URL</label>
            <input id="backend-url-input" type="text" class="settings-input" />
          </div>
          <div class="settings-field">
            <button id="test-backend-btn" class="btn btn-secondary">Test Connection</button>
            <span id="backend-status" class="backend-status"></span>
          </div>
        </div>

        <div class="settings-section">
          <h3>Beta Features</h3>
          <div class="settings-field">
            <label for="agent-mode-toggle" style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" id="agent-mode-toggle" class="settings-checkbox" />
              Use agent-driven assistant (beta)
            </label>
            <div class="settings-help">The agent mode uses an LLM to understand your intent and pick the right tools automatically. Turn off to use the legacy state-machine orchestrator. Requires page reload to take effect.</div>
          </div>
        </div>

      </div>
    </div>
  `;

  // Pre-fill backend URL field
  const backendInput = $('#backend-url-input');
  if (backendInput) backendInput.value = getBaseUrl();

  // Wire close handlers
  $('#settings-close').addEventListener('click', closeSettings);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeSettings();
  });

  // Active chat-model dropdown
  $('#active-chat-select').addEventListener('change', (e) => _setActiveModel('chat', e.target.value));

  // Whisper model
  $('#whisper-model-select').addEventListener('change', _onWhisperChange);
  $('#whisper-apply-btn').addEventListener('click', () => _applyWhisperModel(false));
  $('#whisper-preload-btn').addEventListener('click', () => _applyWhisperModel(true));

  // Provider form
  $('#add-provider-btn').addEventListener('click', () => _showProviderForm());
  $('#pf-save').addEventListener('click', _saveProvider);
  $('#pf-cancel').addEventListener('click', _hideProviderForm);
  $('#pf-test').addEventListener('click', _testProviderConnection);

  // Backend connection
  $('#test-backend-btn').addEventListener('click', _testBackend);
  $('#backend-url-input').addEventListener('change', (e) => {
    setBaseUrl(e.target.value.trim().replace(/\/+$/, ''));
  });

  // Agent mode toggle
  const agentToggle = $('#agent-mode-toggle');
  if (agentToggle) {
    agentToggle.checked = localStorage.getItem('editflow_agent_mode') === 'on';
    agentToggle.addEventListener('change', (e) => {
      localStorage.setItem('editflow_agent_mode', e.target.checked ? 'on' : 'off');
    });
  }
}

async function openSettings() {
  const overlay = $('#settings-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  await Promise.allSettled([
    _loadProvidersList(),
    _loadActiveModels(),
    _loadWhisperModel(),
  ]);
}

function closeSettings() {
  const overlay = $('#settings-overlay');
  if (!overlay) return;
  overlay.classList.add('hidden');
  _hideProviderForm();
}

// ── Active model dropdowns ─────────────────────────────────

async function _loadActiveModels() {
  const chatSelect = $('#active-chat-select');
  try {
    const data = await apiGet('/api/models/list', { timeoutMs: 5000 });

    // The backend returns:
    //   local_models, cloud_models  — flat lists of {name, size, is_vision, is_local, ...}
    //   active_chat_model           — the currently-active model name
    //   active_chat_provider        — the provider id
    //   providers                   — per-provider object incl. its models[]
    const localModels = Array.isArray(data?.local_models) ? data.local_models : [];
    const cloudModels = Array.isArray(data?.cloud_models) ? data.cloud_models : [];
    const activeChatModel = data?.active_chat_model || '';
    const activeChatProvider = data?.active_chat_provider || '';
    const providers = Array.isArray(data?.providers) ? data.providers : [];

    // Build a map of model_name → provider_id by walking the providers list.
    const modelToProvider = {};
    for (const p of providers) {
      for (const m of (p.models || [])) {
        const id = m.id || m.name;
        if (id && !modelToProvider[id]) modelToProvider[id] = p.id;
      }
    }

    // Skip models that are pure vision-only (rare) and keep everything else
    // as chat-capable. The user only sees a chat dropdown now.
    const allModels = [...localModels, ...cloudModels].filter(m => !m.is_vision_only);

    if (allModels.length === 0) {
      chatSelect.innerHTML = '<option value="">No models available — add a provider below</option>';
      return;
    }

    chatSelect.innerHTML = '<option value="">No model selected</option>' +
      allModels.map(m => {
        const id = m.name || m.id;
        const providerId = modelToProvider[id] || activeChatProvider || '';
        const value = providerId ? `${providerId}||${id}` : id;
        const tag = m.is_local ? 'local' : 'cloud';
        const label = providerId ? `${id} · ${providerId} · ${tag}` : `${id} · ${tag}`;
        return `<option value="${_esc(value)}">${_esc(label)}</option>`;
      }).join('');

    // Select the currently active one
    if (activeChatModel) {
      const wantValue = activeChatProvider
        ? `${activeChatProvider}||${activeChatModel}`
        : activeChatModel;
      // Look for an exact match first, then a name-only fallback
      const option = Array.from(chatSelect.options).find(o => o.value === wantValue) ||
                     Array.from(chatSelect.options).find(o => o.value.endsWith(`||${activeChatModel}`));
      if (option) chatSelect.value = option.value;
    }
  } catch (e) {
    console.warn('[settings] Failed to load active models:', e);
    chatSelect.innerHTML = `<option value="">Failed to load models: ${_esc(e.message)}</option>`;
  }
}

async function _setActiveModel(role, value) {
  if (!value) return;
  try {
    const [providerId, model] = value.includes('||') ? value.split('||') : ['', value];
    await apiPost('/api/providers/set-active', {
      provider_id: providerId,
      model,
      role,
    });
  } catch (e) {
    console.warn(`[settings] Failed to set active ${role}:`, e);
  }
}

// ── Whisper model ──────────────────────────────────────────

async function _loadWhisperModel() {
  try {
    const status = await apiGet('/api/whisper/status', { timeoutMs: 3000 });
    _whisperModel = status?.active_model || '';
    const sel = $('#whisper-model-select');
    const models = Array.isArray(status?.supported_models) ? status.supported_models : [];

    // Rebuild the dropdown options with installed/not-installed labels.
    if (models.length > 0) {
      sel.innerHTML = models.map(m => {
        const sizeLabel = m.size_mb >= 1024
          ? `${(m.size_mb / 1024).toFixed(1)} GB`
          : `${m.size_mb} MB`;
        const installTag = m.installed ? '✓ installed' : `~${sizeLabel} download`;
        const activeTag = (m.name === _whisperModel) ? ' · active' : '';
        return `<option value="${_esc(m.name)}">${_esc(m.name)} (${sizeLabel}) - ${installTag}${activeTag}</option>`;
      }).join('');
    }

    if (_whisperModel) sel.value = _whisperModel;
    _updateWhisperHelp();

    // Tweak the help text to mention install state for the selected model
    const selected = models.find(m => m.name === _whisperModel);
    if (selected) {
      const help = $('#whisper-help');
      if (help) {
        const installed = selected.installed
          ? '✓ Already installed on this machine.'
          : `Not installed — first use will download ~${selected.size_mb} MB.`;
        help.textContent = `${selected.quality}. ${selected.speed} on CPU. ${installed}`;
      }
    }

    // Adjust the Apply button label based on install state.
    const applyBtn = $('#whisper-apply-btn');
    if (applyBtn) {
      applyBtn.textContent = selected && !selected.installed
        ? 'Set & install on next use'
        : 'Set as active';
    }
  } catch (e) {
    console.warn('[settings] Failed to load whisper status:', e);
  }
}

function _onWhisperChange(e) {
  _whisperModel = e.target.value;
  // Update help text + button label LOCALLY only. Previously this called
  // _loadWhisperModel() which re-fetched /api/whisper/status and used the
  // response's still-unchanged active_model to set sel.value, snapping the
  // dropdown back to whatever the server last persisted. That made it
  // impossible to actually pick a new model — every selection reverted to
  // 'medium' (or whatever was active) within milliseconds.
  _updateWhisperHelp();
  _updateWhisperApplyButton();
}

/**
 * Render Whisper download progress in the Settings panel.
 *
 * Called by main.js when the backend broadcasts `whisper_download_progress`
 * over the WebSocket. Each event carries:
 *   { status: 'started'|'downloading'|'complete'|'failed',
 *     model: string,
 *     downloaded_mb: number, total_mb: number, percent: number,
 *     error?: string }
 *
 * The progress bar element lives inside the Settings panel HTML and stays
 * hidden until the first event arrives. On 'complete' or 'failed' we hide
 * it again after a short delay so the user can see the final state.
 */
export function onWhisperDownloadProgress(payload) {
  if (!payload || typeof payload !== 'object') return;
  const bar = document.querySelector('#whisper-download-progress');
  if (!bar) return;  // settings panel not currently mounted — ignore

  const fill = document.querySelector('#whisper-progress-fill');
  const text = document.querySelector('#whisper-progress-text');
  const modelLabel = document.querySelector('#whisper-progress-model');
  const status = payload.status || 'downloading';

  if (status === 'failed') {
    bar.classList.add('whisper-progress-failed');
    if (text) text.textContent = 'Failed: ' + (payload.error || 'unknown error');
    // Auto-hide after 8 s so the user has time to read the error.
    setTimeout(() => bar.classList.add('hidden'), 8000);
    return;
  }

  bar.classList.remove('hidden');
  bar.classList.remove('whisper-progress-failed');
  if (modelLabel) modelLabel.textContent = payload.model || 'model';

  const pct = Math.min(100, Math.max(0, Number(payload.percent) || 0));
  if (fill) fill.style.width = pct.toFixed(1) + '%';

  if (status === 'complete') {
    if (text) text.textContent = `${payload.total_mb} MB — done`;
    if (fill) fill.style.width = '100%';
    // Hold the bar at 100% briefly so it doesn't vanish mid-click.
    setTimeout(() => bar.classList.add('hidden'), 2500);
  } else {
    const dl = Number(payload.downloaded_mb) || 0;
    const total = Number(payload.total_mb) || 0;
    if (text) text.textContent = `${dl.toFixed(1)} / ${total} MB (${pct.toFixed(1)}%)`;
  }
}

/** Local re-render of the "Set & install / Set & preload" button label. */
function _updateWhisperApplyButton() {
  const applyBtn = $('#whisper-apply-btn');
  if (!applyBtn) return;
  // Find the catalog entry for the current selection from the rendered
  // dropdown options (already labeled with '✓ installed' or '~XXX MB download').
  const selectedOption = $('#whisper-model-select')?.selectedOptions?.[0];
  const isInstalled = selectedOption && selectedOption.textContent.includes('✓ installed');
  applyBtn.textContent = isInstalled ? 'Set as active' : 'Set & install on next use';
}

function _updateWhisperHelp() {
  const help = $('#whisper-help');
  if (!help) return;
  const m = _whisperModel || 'medium';
  const blurbs = {
    tiny: 'Fastest (4-8x real-time on CPU). Low accuracy. Smoke tests only.',
    base: 'Fast (2-4x real-time). Basic. Mediocre for non-English.',
    small: 'Good for English. ~1-2x real-time on CPU. Limited Urdu/Hindi.',
    medium: 'Best CPU sweet spot. Good multilingual (Urdu/Hindi). ~0.5-1x real-time. Recommended.',
    'large-v3-turbo': 'Best quality with reasonable CPU speed (~0.3-0.5x real-time).',
    'large-v3': 'Highest quality. GPU strongly recommended (on CPU 5-10x slower than real-time).',
  };
  help.textContent = blurbs[m] || '';
  help.classList.remove('settings-help-warn');
}

async function _applyWhisperModel(preload) {
  const model = $('#whisper-model-select').value;
  const status = $('#whisper-apply-status');
  const applyBtn = $('#whisper-apply-btn');
  const preloadBtn = $('#whisper-preload-btn');

  if (!model) {
    status.className = 'test-result error';
    status.textContent = 'Pick a model first.';
    return;
  }

  status.className = 'test-result';
  status.classList.remove('hidden');
  status.textContent = preload
    ? `Preloading ${model}... (downloads if missing, may take several minutes)`
    : `Setting ${model}...`;
  applyBtn.disabled = true;
  preloadBtn.disabled = true;

  try {
    // Preload is a long blocking download for large models. Use a generous timeout.
    const result = await apiPost(
      '/api/whisper/set-model',
      { model, preload },
      { timeoutMs: preload ? 1800000 : 30000 },
    );
    _whisperModel = result.active || model;
    status.className = 'test-result success';
    status.textContent = preload
      ? `Done. Active model: ${result.active} (loaded in memory).`
      : `Active model set to ${result.active}. It will download/load on the next transcription.`;
    // Refresh the dropdown so installed-state and "active" tag update.
    await _loadWhisperModel();
  } catch (e) {
    status.className = 'test-result error';
    status.textContent = 'Failed: ' + e.message;
  } finally {
    applyBtn.disabled = false;
    preloadBtn.disabled = false;
  }
}

// ── Providers list ─────────────────────────────────────────

async function _loadProvidersList() {
  try {
    const data = await apiGet('/api/providers', { timeoutMs: 5000 });
    _providers = Array.isArray(data) ? data : (data?.providers || []);
    _renderProvidersList();
  } catch (e) {
    $('#providers-list').innerHTML = `<div class="provider-card-error">Failed to load providers: ${_esc(e.message)}</div>`;
  }
}

function _renderProvidersList() {
  const list = $('#providers-list');
  if (!_providers.length) {
    list.innerHTML = '<div class="providers-empty">No providers configured.</div>';
    return;
  }

  list.innerHTML = _providers.map(p => {
    const statusClass = p.status === 'connected' ? 'connected'
      : p.status === 'error' ? 'error'
      : p.status === 'connecting' ? 'connecting' : '';
    const typeLabel = p.type === 'ollama' ? 'Ollama'
      : p.type === 'openai_compatible' ? 'OpenAI Compatible'
      : 'Custom';

    return `
      <div class="provider-card" data-id="${_esc(p.id)}">
        <div class="provider-card-header">
          <div class="provider-card-name">
            <span class="provider-status-dot ${statusClass}"></span>
            ${_esc(p.name)}
          </div>
          <div class="provider-card-actions">
            <button class="btn btn-small btn-secondary" data-act="refresh" data-id="${_esc(p.id)}">Refresh</button>
            <button class="btn btn-small btn-secondary" data-act="edit" data-id="${_esc(p.id)}">Edit</button>
            ${!p.is_default ? `<button class="btn btn-small btn-danger" data-act="remove" data-id="${_esc(p.id)}">Remove</button>` : ''}
          </div>
        </div>
        <div class="provider-card-meta">
          <span>${_esc(typeLabel)} · ${_esc(p.base_url)}</span>
          ${p.chat_model ? `<span>Chat: ${_esc(p.chat_model)}</span>` : ''}
          ${p.error ? `<span class="provider-card-error">${_esc(p.error)}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');

  // Delegate button clicks
  list.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const act = btn.dataset.act;
      const pid = btn.dataset.id;
      if (act === 'edit') _showProviderForm(pid);
      else if (act === 'remove') _removeProvider(pid);
      else if (act === 'refresh') _discoverModels(pid);
    });
  });
}

async function _removeProvider(providerId) {
  if (!confirm('Remove this provider?')) return;
  try {
    await apiDelete(`/api/providers/${providerId}`);
    await _loadProvidersList();
    await _loadActiveModels();
  } catch (e) {
    alert('Failed to remove provider: ' + e.message);
  }
}

async function _discoverModels(providerId) {
  try {
    await apiPost(`/api/providers/${providerId}/discover`, {}, { timeoutMs: 20000 });
    await _loadProvidersList();
    await _loadActiveModels();
  } catch (e) {
    alert('Failed to refresh models: ' + e.message);
  }
}

// ── Add/edit provider form ─────────────────────────────────

function _showProviderForm(providerId) {
  _editingProviderId = providerId || null;
  const form = $('#provider-form');
  form.classList.remove('hidden');
  $('#provider-form-title').textContent = providerId ? 'Edit Provider' : 'Add Provider';
  $('#pf-test-result').classList.add('hidden');

  if (providerId) {
    const p = _providers.find(x => x.id === providerId);
    if (p) {
      $('#pf-name').value = p.name || '';
      $('#pf-type').value = p.type || 'ollama';
      $('#pf-base-url').value = p.base_url || '';
      $('#pf-api-key').value = '';
      $('#pf-timeout').value = p.timeout ?? 10;
      $('#pf-chat-model').value = p.chat_model || '';
      $('#pf-vision-model').value = p.vision_model || '';
    }
  } else {
    $('#pf-name').value = '';
    $('#pf-type').value = 'ollama';
    $('#pf-base-url').value = 'http://localhost:11434';
    $('#pf-api-key').value = '';
    $('#pf-timeout').value = 10;
    $('#pf-chat-model').value = '';
    $('#pf-vision-model').value = '';
  }
}

function _hideProviderForm() {
  $('#provider-form')?.classList.add('hidden');
  _editingProviderId = null;
}

function _formConfig() {
  return {
    name: $('#pf-name').value.trim() || 'Custom Provider',
    type: $('#pf-type').value,
    base_url: $('#pf-base-url').value.trim(),
    timeout: parseInt($('#pf-timeout').value, 10) || 10,
    chat_model: $('#pf-chat-model').value.trim(),
    vision_model: $('#pf-vision-model').value.trim(),
    api_key: $('#pf-api-key').value.trim() || undefined,
  };
}

async function _saveProvider() {
  const cfg = _formConfig();
  if (!cfg.base_url) { alert('Base URL is required'); return; }
  if (cfg.api_key === undefined && !_editingProviderId) {
    // For Ollama (no auth) leaving api_key empty is fine. POST with empty string.
    cfg.api_key = '';
  }

  try {
    let saved;
    if (_editingProviderId) {
      saved = await apiPut(`/api/providers/${_editingProviderId}`, cfg);
    } else {
      saved = await apiPost('/api/providers', cfg);
    }
    _hideProviderForm();
    await _loadProvidersList();
    await _loadActiveModels();
    if (saved?.id) _discoverModels(saved.id).catch(() => {});
  } catch (e) {
    alert('Failed to save provider: ' + e.message);
  }
}

async function _testProviderConnection() {
  const result = $('#pf-test-result');
  result.className = 'test-result';
  result.classList.remove('hidden');
  result.textContent = 'Testing connection...';

  const cfg = _formConfig();
  if (!cfg.base_url) {
    result.textContent = 'Base URL is required';
    result.classList.add('error');
    return;
  }
  if (cfg.api_key === undefined) cfg.api_key = '';

  try {
    let pid = _editingProviderId;
    if (!pid) {
      const saved = await apiPost('/api/providers', cfg);
      pid = saved?.id;
      _editingProviderId = pid;
    } else {
      await apiPut(`/api/providers/${pid}`, cfg);
    }
    const test = await apiPost(`/api/providers/${pid}/test`, {}, { timeoutMs: 20000 });
    if (test?.success) {
      result.classList.add('success');
      result.textContent = `Success! ${test.response ? `Sample response: "${test.response.substring(0, 120)}"` : ''}`;
    } else {
      result.classList.add('error');
      result.textContent = `Failed: ${test?.error || 'Unknown error'}`;
    }
  } catch (e) {
    result.classList.add('error');
    result.textContent = 'Error: ' + e.message;
  }
}

// ── Backend connection ─────────────────────────────────────

async function _testBackend() {
  const url = $('#backend-url-input').value.trim().replace(/\/+$/, '');
  setBaseUrl(url);
  const status = $('#backend-status');
  status.textContent = 'Testing...';
  status.className = 'backend-status';
  try {
    const res = await fetch(url + '/api/ping');
    if (res.ok) {
      status.textContent = 'Connected';
      status.className = 'backend-status success';
    } else {
      status.textContent = `HTTP ${res.status}`;
      status.className = 'backend-status error';
    }
  } catch (e) {
    status.textContent = 'Unreachable';
    status.className = 'backend-status error';
  }
}

export { initSettings, openSettings, closeSettings };
