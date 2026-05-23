/**
 * main.js — Bootstrap for EditFlow single-chat frontend.
 *
 * Initializes all modules, wires up DOM events, and starts the app.
 * This file owns no business logic — it delegates to the modules.
 */
import { getState, setState, setSession, transition, transitionError, subscribe, resetState } from './state.js';
import { initExtendScript, isExtendScriptAvailable } from './extendscript.js';
import { apiGet, apiPost, connectWS, getBaseUrl, setBaseUrl } from './api.js';
import { appendMessage, clearChat, scrollToBottom } from './chat-ui.js';
import { attachAutocomplete } from './autocomplete.js';
import { setupDropZone, setupSelectionChip, stopSelectionPoll } from './dnd.js';
import { pickScriptFile } from './upload.js';
import { initDiagnostics } from './diagnostics.js';
import {
  onScanClicked,
  onSourceProvided,
  onPProItemsProvided,
  onMediaFileDropped,
  onScriptFileDropped,
  onUserMessage,
  onNewEdit,
} from './orchestrator.js';

const $ = (sel) => document.querySelector(sel);

// ── Generate client ID ───────────────────────────────────────
const CLIENT_ID = 'cep-' + Math.random().toString(36).substring(2, 8);
setSession({ clientId: CLIENT_ID });

// ── DOM references ────────────────────────────────────────────
const hero = $('#hero');
const chatScroll = $('#chat-scroll');
const footer = $('#app-footer');
const dropOverlay = $('#drop-overlay');
const selectionChip = $('#selection-chip');
const chatInput = $('#chat-input');
const btnScan = $('#btn-scan');
const btnSend = $('#btn-send');
const btnAttach = $('#btn-attach');
const btnSettings = $('#btn-settings');
const btnDiagnostics = $('#btn-diagnostics');
const settingsOverlay = $('#settings-overlay');
const diagnosticsPopover = $('#diagnostics-popover');
const appMain = $('#app-main');

// ── Initialize on DOMContentLoaded ────────────────────────────
document.addEventListener('DOMContentLoaded', init);

async function init() {
  console.log('[EditFlow] Initializing single-chat frontend...');

  // 1. Initialize ExtendScript bridge
  const esAvailable = await initExtendScript();
  console.log(`[EditFlow] ExtendScript: ${esAvailable ? 'available' : 'not available'}`);

  // 2. Wire up Scan button
  if (btnScan) {
    btnScan.addEventListener('click', () => {
      btnScan.disabled = true;
      onScanClicked().finally(() => {
        btnScan.disabled = false;
      });
    });
  }

  // 3. Wire up input dock
  _initInputDock();

  // 4. Wire up autocomplete
  if (chatInput) {
    attachAutocomplete(chatInput, (item) => {
      // Autocomplete item selected — will be handled on Send
    });
  }

  // 5. Wire up drag-and-drop
  if (appMain && dropOverlay) {
    setupDropZone(appMain, dropOverlay, {
      onMediaDrop: onMediaFileDropped,
      onScriptDrop: onScriptFileDropped,
      onPProDrop: onPProItemsProvided,
    });
  }

  // 6. Wire up selection chip
  if (selectionChip) {
    setupSelectionChip(selectionChip, onPProItemsProvided, getState);
  }

  // 7. Wire up attach button
  if (btnAttach) {
    btnAttach.addEventListener('click', async () => {
      const file = await pickScriptFile();
      if (file) {
        await onScriptFileDropped(file);
      }
    });
  }

  // 8. Initialize diagnostics popover
  initDiagnostics(btnDiagnostics, diagnosticsPopover);

  // 9. Initialize settings overlay
  _initSettingsOverlay();

  // 10. Connect WebSocket for real-time updates
  _initWebSocket();

  // 11. Auto-resize textarea
  if (chatInput) {
    chatInput.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
    });
  }

  console.log('[EditFlow] Initialization complete');
}

// ── Input dock wiring ────────────────────────────────────────
function _initInputDock() {
  if (!chatInput || !btnSend) return;

  // Send on button click
  btnSend.addEventListener('click', () => {
    _sendInput();
  });

  // Send on Enter (without Shift)
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      _sendInput();
    }
  });
}

function _sendInput() {
  const text = chatInput.value.trim();
  if (!text) return;

  chatInput.value = '';
  chatInput.style.height = 'auto';
  onUserMessage(text);
}

// ── Settings overlay ─────────────────────────────────────────
function _initSettingsOverlay() {
  if (!btnSettings || !settingsOverlay) return;

  btnSettings.addEventListener('click', () => {
    _showSettings();
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !settingsOverlay.classList.contains('hidden')) {
      settingsOverlay.classList.add('hidden');
    }
  });
}

function _showSettings() {
  settingsOverlay.classList.remove('hidden');

  const currentUrl = getBaseUrl();

  settingsOverlay.innerHTML = `
    <div class="overlay-panel">
      <div class="overlay-title">
        Settings
        <button class="overlay-close" id="settings-close">&times;</button>
      </div>

      <div class="setting-group">
        <div class="setting-label">Backend URL</div>
        <input type="text" class="setting-input" id="setting-url" value="${currentUrl}" placeholder="http://localhost:8765">
        <div class="setting-status" id="setting-status">Checking...</div>
      </div>

      <div class="setting-group">
        <div class="setting-label">Active Chat Model</div>
        <select class="setting-select" id="setting-model">
          <option value="">Loading...</option>
        </select>
      </div>
    </div>
  `;

  // Close button
  const closeBtn = $('#settings-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      settingsOverlay.classList.add('hidden');
    });
  }

  // Backdrop click to close
  settingsOverlay.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) {
      settingsOverlay.classList.add('hidden');
    }
  });

  // URL input
  const urlInput = $('#setting-url');
  const statusDiv = $('#setting-status');
  if (urlInput) {
    // Test current URL
    _testBackendUrl(currentUrl, statusDiv);

    urlInput.addEventListener('change', () => {
      const newUrl = urlInput.value.trim();
      setBaseUrl(newUrl);
      _testBackendUrl(newUrl, statusDiv);
    });
  }

  // Model select
  const modelSelect = $('#setting-model');
  if (modelSelect) {
    _loadModels(modelSelect);
    modelSelect.addEventListener('change', () => {
      const [providerId, model] = modelSelect.value.split('::');
      if (providerId && model) {
        apiPost('/api/providers/set-active', {
          provider_id: providerId,
          model: model,
          role: 'chat',
        }).catch(err => {
          console.warn('[settings] Failed to set active model:', err);
        });
      }
    });
  }
}

async function _testBackendUrl(url, statusEl) {
  try {
    await fetch(url + '/api/ping', { method: 'GET', signal: AbortSignal.timeout(3000) });
    if (statusEl) {
      statusEl.textContent = 'Connected';
      statusEl.className = 'setting-status ok';
    }
  } catch (_) {
    if (statusEl) {
      statusEl.textContent = 'Not reachable';
      statusEl.className = 'setting-status fail';
    }
  }
}

async function _loadModels(selectEl) {
  try {
    const status = await apiGet('/api/status', { timeoutMs: 5000 });
    const providers = status.providers || {};
    const options = [];

    for (const [pid, info] of Object.entries(providers)) {
      if (info.connected && info.models) {
        for (const model of info.models) {
          const modelId = typeof model === 'string' ? model : model.id || model.name;
          options.push(`<option value="${pid}::${modelId}">${pid}: ${modelId}</option>`);
        }
      }
    }

    if (options.length === 0) {
      options.push('<option value="">No models available</option>');
    }

    selectEl.innerHTML = options.join('');
  } catch (_) {
    selectEl.innerHTML = '<option value="">Could not load models</option>';
  }
}

// ── WebSocket ────────────────────────────────────────────────
function _initWebSocket() {
  try {
    const ws = connectWS(CLIENT_ID);

    ws.on('message', (data) => {
      // Handle progress updates for transcription jobs
      if (data.type === 'job_progress' || data.type === 'progress') {
        // The orchestrator handles polling; WS updates are supplementary
        console.log('[ws] Job progress:', data);
      }
      if (data.type === 'chat_response') {
        // Unsolicited chat response (rare in the single-chat flow)
        console.log('[ws] Chat response:', data);
      }
    });

    ws.on('open', () => {
      console.log('[ws] Connected to backend');
    });

    ws.on('error', () => {
      // Silently handle — reconnection is automatic
    });
  } catch (e) {
    console.warn('[ws] WebSocket init failed:', e);
  }
}
