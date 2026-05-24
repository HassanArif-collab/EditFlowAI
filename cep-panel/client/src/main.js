/**
 * main.js — Bootstrap for EditFlow single-chat frontend.
 *
 * Initializes all modules, wires up DOM events, and starts the app.
 * This file owns no business logic — it delegates to the modules.
 */
import { getState, setState, setSession, transition, transitionError, subscribe, resetState, loadResumableSession, hydrateFromSaved, clearSavedSession } from './state.js';
import { initExtendScript, isExtendScriptAvailable } from './extendscript.js';
import { apiGet, apiPost, connectWS, getBaseUrl, setBaseUrl } from './api.js';
import { appendMessage, clearChat, scrollToBottom } from './chat-ui.js';
import { attachAutocomplete } from './autocomplete.js';
import { setupDropZone, setupSelectionChip, stopSelectionPoll } from './dnd.js';
import { pickScriptFile } from './upload.js';
import { initDiagnostics } from './diagnostics.js';
import { initSettings, openSettings } from './settings.js';
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

  // 2b. Offer to resume a previous session if one was saved.
  _maybeOfferResume();

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

// ── Resume previous session ──────────────────────────────────
function _maybeOfferResume() {
  const saved = loadResumableSession();
  if (!saved) return;

  const heroEl = $('#hero');
  if (!heroEl) return;

  const ageMin = Math.max(1, Math.round((Date.now() - (saved.savedAt || 0)) / 60000));
  const ageLabel = ageMin < 60 ? `${ageMin} min` : ageMin < 1440 ? `${Math.round(ageMin / 60)} h` : `${Math.round(ageMin / 1440)} d`;

  const sourcesText = (saved.session.sources || [])
    .map(s => `@${s.type}:${s.name}`)
    .slice(0, 2)
    .join(', ');

  const resumeCard = document.createElement('div');
  resumeCard.className = 'resume-card';
  resumeCard.innerHTML = `
    <div class="resume-card-title">Continue your previous session?</div>
    <div class="resume-card-meta">
      Stage: <strong>${saved.current}</strong>${sourcesText ? ` &middot; ${sourcesText}` : ''}
      &middot; ${ageLabel} ago
    </div>
    <div class="resume-card-actions">
      <button class="btn btn-primary btn-small" id="resume-btn">Resume</button>
      <button class="btn btn-ghost btn-small" id="resume-discard-btn">Start fresh</button>
    </div>
  `;
  heroEl.appendChild(resumeCard);

  $('#resume-btn').addEventListener('click', async () => {
    resumeCard.remove();
    if (hydrateFromSaved(saved)) {
      // Switch the UI from hero to chat view, replay the salient bits.
      const hero = $('#hero');
      const chatScroll = $('#chat-scroll');
      const footer = $('#app-footer');
      if (hero) hero.classList.add('hidden');
      if (chatScroll) chatScroll.classList.remove('hidden');
      if (footer) footer.classList.remove('hidden');

      const sources = (saved.session.sources || []).map(s => `@${s.type}:${s.name}`).join(', ');
      appendMessage('agent-text', {
        text: `Resumed from "${saved.current}" stage. Last sources: ${sources || '(none)'}. ` +
              `${saved.session.scriptText ? 'Script kept.' : 'Provide a script to continue.'} ` +
              `If anything looks off, click "Start a new edit" later.`,
      });
    }
  });

  $('#resume-discard-btn').addEventListener('click', () => {
    clearSavedSession();
    resumeCard.remove();
  });
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
// The rich provider UI lives in settings.js (initSettings renders it once,
// openSettings shows it and refreshes data each time).
function _initSettingsOverlay() {
  if (!btnSettings || !settingsOverlay) return;
  initSettings();
  btnSettings.addEventListener('click', () => openSettings());
}

// ── WebSocket ────────────────────────────────────────────────
function _initWebSocket() {
  try {
    const ws = connectWS(CLIENT_ID);

    ws.on('message', (data) => {
      // Forward backend progress events to the orchestrator so the in-flight
      // progress message ticks as work happens (esp. transcription).
      if (data && data.type === 'progress') {
        try {
          import('./orchestrator.js').then(o => {
            if (o.onWsProgress) o.onWsProgress(data.payload || data);
          });
        } catch (_) { /* ignore */ }
      }
      if (data && data.type === 'chat_response') {
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
