/**
 * main.js — Bootstrap for EditFlow single-chat frontend.
 *
 * Initializes all modules, wires up DOM events, and starts the app.
 * This file owns no business logic — it delegates to the modules.
 */
const BUILD_TAG = 'native-captions-8';  // bump when shipping a fix; visible in header

// FIRST thing on parse: clear the inline boot-check banner. If the user sees
// the banner disappear, we KNOW main.js parsed successfully and modules are
// loading. If it stays, the issue is CEP cache serving an old main.js.
(function _stampBoot() {
  const banner = document.getElementById('inline-boot-check');
  if (banner) {
    banner.dataset.cleared = '1';
    banner.style.background = '#1f3a1f';
    banner.style.color = '#a5d6a7';
    banner.textContent = `Boot: main.js parsed (build ${BUILD_TAG}). Loading modules...`;
    setTimeout(() => banner.remove(), 1500);
  }
  const tag = document.getElementById('boot-tag');
  if (tag) tag.textContent = `build:${BUILD_TAG}`;
  console.log(`[EditFlow] main.js parsed — build ${BUILD_TAG}`);
})();

import { getState, setState, setSession, transition, transitionError, subscribe, resetState, loadResumableSession, hydrateFromSaved, clearSavedSession } from './state.js';
import { initExtendScript, isExtendScriptAvailable } from './extendscript.js';
import { apiGet, apiPost, connectWS, getBaseUrl, setBaseUrl } from './api.js';
import { appendMessage, clearChat, scrollToBottom } from './chat-ui.js';
import { attachAutocomplete } from './autocomplete.js';
import { setupDropZone, setupSelectionChip, stopSelectionPoll } from './dnd.js';
import { pickScriptFile } from './upload.js';
import { initDiagnostics } from './diagnostics.js';
import { initSettings, openSettings, onWhisperDownloadProgress } from './settings.js';
// openReview is loaded DYNAMICALLY (with the BUILD_TAG cache-buster) inside
// _loadOrchestrator so edits to review-view.js land on reload without a CEP
// cache wipe. Kept in a module var + on window for the orchestrator's /review.
let openReview = null;
let openNativeCaptions = null;
// Feature flag: agent mode vs. legacy orchestrator
const AGENT_MODE = localStorage.getItem('editflow_agent_mode') === 'on';

// IMPORTANT: do NOT use top-level `await` here. CEP's bundled Chromium can
// either reject top-level await outright or race with DOMContentLoaded, which
// kills init() before any button listeners get attached. Instead, we register
// the DOMContentLoaded listener synchronously and load the orchestrator
// module inside init() — keeping the top-level code dead simple.
let onScanClicked, onSourceProvided, onPProItemsProvided, onMediaFileDropped,
    onScriptFileDropped, onUserMessage, onNewEdit, onWsProgress;

async function _loadOrchestrator() {
  // Append a cache buster tied to BUILD_TAG so every shipped fix forces a
  // fresh fetch of the orchestrator module. Without this, CEF's HTTP cache
  // returns the OLD copy of agent-client.js for hours after we deploy a
  // fix — because the cached response's max-age hasn't expired yet, and
  // Cache-Control headers on NEW responses can't override an existing
  // cache entry. The query string makes the URL different → guaranteed
  // fresh request → my latest agent-client.js actually runs.
  //
  // This only busts the dynamic-import URL. Static imports (state.js,
  // api.js, etc.) still hit the cache, but those modules haven't been
  // edited recently — the cached versions are correct. The Cache-Control
  // headers we send now will prevent the same trap from recurring once
  // those files do change.
  const bust = '?v=' + encodeURIComponent(BUILD_TAG);
  const mod = AGENT_MODE
    ? await import('./agent-client.js' + bust)
    : await import('./orchestrator.js' + bust);
  onScanClicked        = mod.onScanClicked;
  onSourceProvided     = mod.onSourceProvided;
  onPProItemsProvided  = mod.onPProItemsProvided;
  onMediaFileDropped   = mod.onMediaFileDropped;
  onScriptFileDropped  = mod.onScriptFileDropped;
  onUserMessage        = mod.onUserMessage;
  onNewEdit            = mod.onNewEdit;
  onWsProgress         = mod.onWsProgress;
  console.log(`[EditFlow] Loaded ${AGENT_MODE ? 'agent-client' : 'orchestrator'}`);

  // Load the word-level Review editor with the same cache-buster, and expose it
  // so the orchestrator's /review command (and the header button) can open it.
  try {
    const reviewMod = await import('./review-view.js' + bust);
    openReview = reviewMod.openReview;
    window.__editflowOpenReview = openReview;
  } catch (e) {
    console.error('[EditFlow] Failed to load review-view:', e);
  }

  // Load the Native Animated Captions view with the same cache-buster.
  try {
    const ncMod = await import('./native-captions-view.js' + bust);
    openNativeCaptions = ncMod.openNativeCaptions;
    window.__editflowOpenNativeCaptions = openNativeCaptions;
  } catch (e) {
    console.error('[EditFlow] Failed to load native-captions-view:', e);
  }
}

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
const btnReview = $('#btn-review');
const btnNativeCaptions = $('#btn-native-captions');
const btnDiagnostics = $('#btn-diagnostics');
const settingsOverlay = $('#settings-overlay');
const diagnosticsPopover = $('#diagnostics-popover');
const appMain = $('#app-main');

// ── Initialize on DOMContentLoaded ────────────────────────────
document.addEventListener('DOMContentLoaded', init);

/**
 * Global error surface — a dismissible bottom banner shown on any uncaught error
 * or unhandled promise rejection, so the panel can never silently go dead. This
 * is the last line of the "never a dead end" principle; specific flows still show
 * their own inline errors.
 */
function _showGlobalError(msg) {
  try {
    let b = document.getElementById('editflow-error-bar');
    if (!b) {
      b = document.createElement('div');
      b.id = 'editflow-error-bar';
      b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#5a2d2d;color:#fff;font:12px/1.4 monospace;padding:6px 10px;display:flex;gap:8px;align-items:center';
      document.body.appendChild(b);
    }
    b.innerHTML = '';
    const span = document.createElement('span');
    span.style.flex = '1';
    span.textContent = 'EditFlow hit an error (the panel is still alive): ' + String(msg).slice(0, 300);
    const x = document.createElement('button');
    x.textContent = 'Dismiss';
    x.style.cssText = 'background:#7a3d3d;color:#fff;border:0;border-radius:4px;padding:3px 8px;cursor:pointer';
    x.onclick = () => b.remove();
    b.appendChild(span); b.appendChild(x);
  } catch (_) { /* never let the error handler throw */ }
}

async function init() {
  console.log('[EditFlow] Initializing single-chat frontend...');

  // Global error surface — catch what the per-flow handlers miss.
  window.addEventListener('error', (e) => _showGlobalError((e && (e.error && e.error.message || e.message)) || 'Unknown error'));
  window.addEventListener('unhandledrejection', (e) => _showGlobalError((e && (e.reason && e.reason.message || e.reason)) || 'Unhandled promise rejection'));

  try {
    // 0. Load the chosen orchestrator module (was top-level — moved here so a
    //    dynamic-import failure doesn't kill the DOMContentLoaded listener.)
    await _loadOrchestrator();
  } catch (err) {
    console.error('[EditFlow] Failed to load orchestrator:', err);
    const heroEl = $('#hero');
    if (heroEl) {
      heroEl.innerHTML = `<p style="color:#e57373;padding:24px;text-align:center">
        Failed to load EditFlow: ${err.message}.<br>
        Open the CEP debug console and check the error.
      </p>`;
    }
    return;
  }

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

  // 9b. Wire the Review (transcript-first cut editor) button. Additive — the
  //     legacy orchestrator/agent flows are untouched whether or not it's used.
  if (btnReview) {
    btnReview.addEventListener('click', () => {
      try { if (openReview) openReview(); else console.warn('[EditFlow] Review not loaded yet'); }
      catch (e) { console.error('[EditFlow] openReview failed:', e); }
    });
  }

  // 9c. Wire the Native Animated Captions button.
  if (btnNativeCaptions) {
    btnNativeCaptions.addEventListener('click', () => {
      try { if (openNativeCaptions) openNativeCaptions(); else console.warn('[EditFlow] Native Captions not loaded yet'); }
      catch (e) { console.error('[EditFlow] openNativeCaptions failed:', e); }
    });
  }

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
      // Forward backend progress events to the active orchestrator so the in-flight
      // progress message ticks as work happens (esp. transcription).
      if (data && (data.type === 'progress' || data.type === 'agent_tool')) {
        try {
          if (typeof onWsProgress === 'function') {
            onWsProgress(data.payload || data);
          }
        } catch (_) { /* ignore */ }
      }
      // Whisper download progress — routed to the Settings panel's progress bar.
      // settings.js handles the case where the panel isn't currently mounted
      // (no-op early return), so this is safe to dispatch unconditionally.
      if (data && data.type === 'whisper_download_progress') {
        try {
          onWhisperDownloadProgress(data.payload || data);
        } catch (e) {
          console.warn('[ws] whisper_download_progress handler threw:', e);
        }
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
