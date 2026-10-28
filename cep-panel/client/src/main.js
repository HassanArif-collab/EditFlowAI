/**
 * main.js — Bootstrap for EditFlow single-chat frontend.
 *
 * Initializes all modules, wires up DOM events, and starts the app.
 * This file owns no business logic — it delegates to the modules.
 */
const BUILD_TAG = 'v2.0-progress-visuals';  // bump when shipping a fix; visible in header

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
import { initExtendScript, isExtendScriptAvailable, callExtendScript, reloadExtensionRoot } from './extendscript.js';
import { apiGet, apiPost, connectWS, getBaseUrl, setBaseUrl } from './api.js';
import { appendMessage, clearChat, scrollToBottom } from './chat-ui.js';
import { attachAutocomplete } from './autocomplete.js';
import { setupDropZone, setupSelectionChip, stopSelectionPoll } from './dnd.js';
import { pickScriptFile } from './upload.js';
import { initDiagnostics } from './diagnostics.js';
import { initSettings, openSettings, onWhisperDownloadProgress } from './settings.js';
// Dynamic module hooks — populated on-demand when views are lazily imported.
let openReview = null;
let openCaptions = null;
let openStoryCut = null;

// Feature flag: agent mode vs. legacy orchestrator
const AGENT_MODE = localStorage.getItem('editflow_agent_mode') === 'on';

let onScanClicked, onSourceProvided, onPProItemsProvided, onMediaFileDropped,
    onScriptFileDropped, onUserMessage, onNewEdit, onWsProgress;

// View module cache and in-flight load deduplicator
const _viewCache = new Map();
const _viewLoading = new Map();

/**
 * Lazy-load view module on-demand with cache-busting and error boundary.
 * Only the active view is loaded on cold boot; non-active views remain deferred.
 *
 * @param {'captions' | 'storyCut' | 'review' | 'agent' | 'orchestrator'} viewName
 * @returns {Promise<any>}
 */
export async function loadView(viewName) {
  const key = (viewName === 'agent' || viewName === 'orchestrator') ? 'orchestrator' : viewName;
  if (_viewCache.has(key)) {
    return _viewCache.get(key);
  }
  if (_viewLoading.has(key)) {
    return _viewLoading.get(key);
  }

  const p = (async () => {
    const bust = '?v=' + encodeURIComponent(BUILD_TAG);
    let mod;
    try {
      switch (key) {
        case 'captions':
          mod = await import('./captions-view.js' + bust);
          openCaptions = mod.openCaptions;
          window.__editflowOpenCaptions = () => openView('captions');
          break;
        case 'review':
          mod = await import('./review-view.js' + bust);
          openReview = mod.openReview;
          window.__editflowOpenReview = () => openView('review');
          break;
        case 'storyCut':
          mod = await import('./story-cut-view.js' + bust);
          openStoryCut = mod.openStoryCut;
          window.__editflowOpenStoryCut = () => openView('storyCut');
          break;
        case 'orchestrator':
          mod = AGENT_MODE
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
          break;
        default:
          throw new Error(`Unknown view "${viewName}"`);
      }
      _viewCache.set(key, mod);
      return mod;
    } catch (err) {
      console.error(`[EditFlow] Failed to load view "${key}":`, err);
      _showGlobalError(`Failed to load view "${key}": ${err.message}`);
      throw err;
    } finally {
      _viewLoading.delete(key);
    }
  })();

  _viewLoading.set(key, p);
  return p;
}

/**
 * Defensive error-boundary wrapped view switcher.
 */
export async function openView(viewName) {
  try {
    if (viewName === 'chat') {
      try { localStorage.setItem('editflow_home_view', 'chat'); } catch (_) {}
      const ccView = $('#captions-view'); if (ccView) ccView.classList.add('hidden');
      const scView = $('#story-cut-view'); if (scView) scView.classList.add('hidden');
      const rvView = $('#review-view'); if (rvView) rvView.classList.add('hidden');
      const hero = $('#hero'); if (hero) hero.classList.remove('hidden');
      await loadView('orchestrator');
      return;
    }

    try { localStorage.setItem('editflow_home_view', viewName); } catch (_) {}
    const mod = await loadView(viewName);
    if (viewName === 'captions' && (mod.openCaptions || openCaptions)) {
      (mod.openCaptions || openCaptions)();
    } else if (viewName === 'review' && (mod.openReview || openReview)) {
      (mod.openReview || openReview)();
    } else if (viewName === 'storyCut' && (mod.openStoryCut || openStoryCut)) {
      (mod.openStoryCut || openStoryCut)();
    }
  } catch (err) {
    console.error(`[EditFlow] Error opening view "${viewName}":`, err);
    _showGlobalError(`Error opening view "${viewName}": ${err.message}`);
    const hero = $('#hero'); if (hero) hero.classList.remove('hidden');
  }
}

// Window interoperability hooks
window.__editflowOpenReview = () => openView('review');
window.__editflowOpenCaptions = () => openView('captions');
window.__editflowOpenStoryCut = () => openView('storyCut');

/**
 * Ensure stylesheets are cached by CEF and remove Date.now() cache-busting.
 */
function installStyleCacheGuard() {
  const guards = [
    { id: 'cc-style-link', file: 'captions.css' },
    { id: 'rv-style-link', file: 'review.css' },
    { id: 'sc-style-link', file: 'story-cut.css' },
  ];
  for (const g of guards) {
    let link = document.getElementById(g.id);
    if (!link) {
      link = document.createElement('link');
      link.id = g.id;
      link.rel = 'stylesheet';
      link.href = `styles/${g.file}?v=${encodeURIComponent(BUILD_TAG)}`;
      document.head.appendChild(link);
    }
    // Intercept and strip dynamic Date.now() timestamp cache-busters so CEF caches styles
    let curHref = link.href;
    try {
      Object.defineProperty(link, 'href', {
        get() { return curHref; },
        set(val) {
          if (typeof val === 'string' && val.includes('?v=')) {
            const base = val.split('?')[0];
            curHref = `${base}?v=${encodeURIComponent(BUILD_TAG)}`;
          } else {
            curHref = val;
          }
          link.setAttribute('href', curHref);
        },
        configurable: true,
      });
    } catch (_) {}
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
const btnCaptions = $('#btn-captions');
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

  // Install stylesheet cache guard to eliminate timestamp cache-busting
  installStyleCacheGuard();

  // 0. Only load the active home view on cold boot (non-active views are deferred)
  const homeView = localStorage.getItem('editflow_home_view') || 'captions';
  try {
    if (homeView === 'captions') {
      await loadView('captions');
    } else if (homeView === 'review') {
      await loadView('review');
    } else if (homeView === 'storyCut') {
      await loadView('storyCut');
    } else {
      await loadView('orchestrator');
    }
  } catch (err) {
    console.error(`[EditFlow] Failed to load initial view (${homeView}):`, err);
  }

  // 1. Initialize ExtendScript bridge. Pass false on cold boot for fast-path evaluation
  // (eliminates disk re-read on cold boot).
  let esAvailable = false;
  try {
    esAvailable = await initExtendScript(false);
  } catch (_) {
    esAvailable = false;
  }
  console.log(`[EditFlow] ExtendScript: ${esAvailable ? 'available' : 'not available'}`);

  // 1b. Report host capabilities (fire-and-forget — never blocks boot).
  // Runs probeCapabilities inside Premiere and POSTs the result to
  // /api/preflight/capabilities so the backend knows e.g. whether
  // sequence.createCaptionTrack exists on this build. Needs a project
  // with an active sequence open for the full picture.
  _reportCapabilities();

  // 2. Wire up Scan button
  if (btnScan) {
    btnScan.addEventListener('click', async () => {
      btnScan.disabled = true;
      try {
        await loadView('orchestrator');
        if (onScanClicked) await onScanClicked();
      } finally {
        btnScan.disabled = false;
      }
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
      onMediaDrop: async (f) => { await loadView('orchestrator'); if (onMediaFileDropped) return onMediaFileDropped(f); },
      onScriptDrop: async (f) => { await loadView('orchestrator'); if (onScriptFileDropped) return onScriptFileDropped(f); },
      onPProDrop: async (items) => { await loadView('orchestrator'); if (onPProItemsProvided) return onPProItemsProvided(items); },
    });
  }

  // 6. Wire up selection chip
  if (selectionChip) {
    setupSelectionChip(selectionChip, async (items) => {
      await loadView('orchestrator');
      if (onPProItemsProvided) return onPProItemsProvided(items);
    }, getState);
  }

  // 7. Wire up attach button
  if (btnAttach) {
    btnAttach.addEventListener('click', async () => {
      const file = await pickScriptFile();
      if (file) {
        await loadView('orchestrator');
        if (onScriptFileDropped) await onScriptFileDropped(file);
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
    btnReview.addEventListener('click', () => openView('review'));
  }

  // 9c. Captions tab (Tier-1 native captions — AE-style tabbed flow).
  if (btnCaptions) {
    const btnStoryCut = document.getElementById('btn-story-cut');
    if (btnStoryCut) {
      btnStoryCut.addEventListener('click', () => openView('storyCut'));
    }
    btnCaptions.addEventListener('click', () => openView('captions'));
  }

  // 9d. Boot into the active home view
  try {
    if (homeView === 'captions' && typeof openCaptions === 'function') {
      openCaptions();
    } else if (homeView === 'review' && typeof openReview === 'function') {
      openReview();
    } else if (homeView === 'storyCut' && typeof openStoryCut === 'function') {
      openStoryCut();
    }
  } catch (e) {
    console.warn('[EditFlow] home view open failed, showing chat:', e);
    try {
      const hero = $('#hero');
      if (hero) hero.classList.remove('hidden');
    } catch (_) {}
  }

  // 9b. Dev Reload button — re-loads the ExtendScript bundle + the panel
  // page without restarting Premiere. Mirrors the AE panel's 🔁 button.
  // Mostly clicked automatically: the backend file watcher pushes
  // `dev_reload` over WS (EDITFLOW_DEV_WATCH=1) ~2s after any cep-panel/
  // edit, and _initWebSocket reloads for us.
  if (btnSettings && btnSettings.parentNode) {
    const btnReload = document.createElement('button');
    btnReload.id = 'btn-dev-reload';
    btnReload.className = 'icon-btn';
    btnReload.title = 'Reload panel + ExtendScript (no Premiere restart needed)';
    btnReload.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.8-4.2L13 11h7V4z"/></svg>';
    btnReload.addEventListener('click', () => devReload());
    btnReload.style.display = 'none';
    btnSettings.parentNode.insertBefore(btnReload, btnSettings);
    // Show only when the dev watcher is plausibly active (localhost backend).
    // Harmless if shown without it — it just reloads the panel.
    try {
      if (/^(http:\/\/localhost|http:\/\/127\.0\.0\.1)/.test(getBaseUrl())) {
        btnReload.style.display = '';
      }
    } catch (_) { btnReload.style.display = ''; }
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

async function _sendInput() {
  const text = chatInput.value.trim();
  if (!text) return;

  chatInput.value = '';
  chatInput.style.height = 'auto';
  await loadView('orchestrator');
  if (onUserMessage) onUserMessage(text);
}

// ── Settings overlay ─────────────────────────────────────────
// The rich provider UI lives in settings.js (initSettings renders it once,
// openSettings shows it and refreshes data each time).
function _initSettingsOverlay() {
  if (!btnSettings || !settingsOverlay) return;
  initSettings();
  btnSettings.addEventListener('click', () => openSettings());
}

// ── Capability report ────────────────────────────────────────
/**
 * Run the ExtendScript capability probe and report it to the backend.
 * Fire-and-forget: failures are logged, never surfaced — the panel works
 * fine without it; the backend just won't know host capabilities.
 */
async function _reportCapabilities() {
  // Always report SOMETHING so the backend (and the next dev reading
  // GET /api/preflight/capabilities) can tell "probe failed" apart from
  // "probe never ran". Failures stay silent in the panel UI on purpose.
  const report = async (caps) => {
    try {
      caps.panel_version = BUILD_TAG;
      await apiPost('/api/preflight/capabilities', caps, { timeoutMs: 8000 });
      console.log('[EditFlow] Capabilities reported:', JSON.stringify(caps));
    } catch (e) {
      console.warn('[EditFlow] Capability report POST failed (non-fatal):', (e && e.message) || e);
    }
  };
  try {
    if (!isExtendScriptAvailable()) {
      await report({ probe_error: 'ExtendScript not available at boot' });
      return;
    }
    const res = await callExtendScript('probeCapabilities');
    const caps = (res && res.capabilities) || res;
    if (!caps || typeof caps !== 'object') {
      await report({ probe_error: 'probe returned non-object: ' + String(res).slice(0, 200) });
      return;
    }
    caps.router_fresh = true;
    try {
      caps.evalfile_result = String(window.__editflowEvalResult || '(none)').slice(0, 120);
      caps.jsx_path = String(window.__editflowJsxPath || '(none)').slice(0, 160);
    } catch (_) {}
    await report(caps);
  } catch (e) {
    const errMsg = String((e && e.message) || e);
    // Self-heal once per session: a stale in-engine router (e.g. "Unknown
    // command" or "... is undefined" right after an index.jsx change)
    // re-evaluates index.jsx from disk, then reloads into the fresh state.
    // The sessionStorage flag guarantees this can never loop.
    let healed = false;
    try { healed = sessionStorage.getItem('editflow_jsx_healed') === '1'; } catch (_) {}
    if (!healed && /unknown command|is undefined/i.test(errMsg)) {
      try { sessionStorage.setItem('editflow_jsx_healed', '1'); } catch (_) {}
      console.log('[EditFlow] Stale ExtendScript router — healing, then reloading.');
      try { await reloadExtensionRoot(); } catch (_) {}
      location.reload();
      return;
    }
    await report({ probe_error: errMsg.slice(0, 300) });
  }
}

// ── WebSocket ────────────────────────────────────────────────
let _reloading = false;
/**
 * Reload the ExtendScript bundle inside Premiere, then reload the panel.
 * ExtendScript functions are globals, so re-running initExtendScript
 * (editflowConfigureExtensionRoot re-evals every module) hot-swaps them
 * without restarting Premiere. location.reload() then pulls fresh panel
 * code (no-store headers + BUILD_TAG cache-buster).
 */
async function devReload() {
  if (_reloading) return;
  _reloading = true;
  try {
    // Full refresh: re-evaluates index.jsx (router) + every module from
    // disk, so .jsx edits land with no Premiere restart. Falls back to a
    // forced configure if the direct re-eval is unavailable.
    try {
      await reloadExtensionRoot();
    } catch (_) {
      await initExtendScript(true);
    }
  } catch (e) {
    console.warn('[dev] ExtendScript re-load failed (reloading panel anyway):', e);
  }
  location.reload();
}

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
        // Views outside the orchestrator (Captions) listen for the same events.
        try { window.dispatchEvent(new CustomEvent('editflow:ws', { detail: data })); } catch (_) { /* ignore */ }
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
      // Live reload — backend dev watcher (EDITFLOW_DEV_WATCH=1) pushes this
      // ~2s after any cep-panel/ file change. Re-load ExtendScript (function
      // redefinition hot-swaps without restarting Premiere), then reload.
      if (data && data.type === 'dev_reload') {
        console.log('[ws] dev_reload:', ((data.files || []).join(', ') || 'panel files'));
        devReload();
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
