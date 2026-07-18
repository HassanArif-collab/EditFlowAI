/**
 * main.js — Bootstrap for EditFlow AE panel.
 */
const BUILD_TAG = 'ae-captions-19';

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

import { initExtendScript } from './extendscript.js';
import { apiGet, apiUpload, connectWS, getBaseUrl } from './api.js';
import { openCaptions, closeCaptions, setCaptionsClientId, onTranscribeProgress } from './captions-view.js';
import { initSettings, openSettings, onWhisperDownloadProgress } from './settings.js';
import { handleAgentEval, devReload, reportError } from './agent-bridge.js';

const $ = (sel) => document.querySelector(sel);
const CLIENT_ID = 'ae-' + Math.random().toString(36).substring(2, 8);

let _esError = null;

document.addEventListener('DOMContentLoaded', async () => {
  console.log('[EditFlow] Initializing...');

  window.addEventListener('error', (e) => {
    const msg = (e && (e.error && e.error.message || e.message)) || 'Unknown error';
    _showGlobalError(msg);
    reportError('panel', msg);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const msg = (e && (e.reason && e.reason.message || e.reason)) || 'Unhandled promise rejection';
    _showGlobalError(msg);
    reportError('panel', msg);
  });

  try {
    await initExtendScript();
  } catch (err) {
    console.error('[EditFlow] ExtendScript init failed:', err);
    _esError = err.message;
    _showExtendScriptError(err.message);
  }

  // Route transcription WebSocket progress into the captions view.
  setCaptionsClientId(CLIENT_ID);

  // Open the captions view immediately
  openCaptions();

  // Initialize settings overlay
  initSettings();

  // Wire settings button
  const btnSettings = $('#btn-settings');
  if (btnSettings) {
    btnSettings.addEventListener('click', () => openSettings());
  }
  // The in-view header's gear dispatches this event (the loader header is hidden).
  document.addEventListener('editflow:open-settings', () => openSettings());

  // 🔁 Dev Reload — re-evals index.jsx inside AE + reloads the panel page.
  // Replaces the close-extension/restart-AE cycle for code changes.
  const btnReload = document.createElement('button');
  btnReload.id = 'btn-dev-reload';
  btnReload.title = 'Reload panel + ExtendScript (no AE restart needed)';
  btnReload.textContent = '🔁';
  btnReload.style.cssText = 'position:fixed;top:6px;right:44px;z-index:9999;background:transparent;border:1px solid #444;border-radius:4px;color:#ccc;padding:2px 7px;cursor:pointer;font-size:12px;';
  btnReload.onclick = () => devReload();
  document.body.appendChild(btnReload);

  // Connect WebSocket for real-time updates (whisper download progress, etc.)
  try {
    const ws = connectWS(CLIENT_ID);
    ws.on('message', (data) => {
      if (!data) return;
      if (data.type === 'whisper_download_progress') {
        try {
          onWhisperDownloadProgress(data.payload || data);
        } catch (e) {
          console.warn('[ws] whisper_download_progress handler threw:', e);
        }
      } else if (data.type === 'progress') {
        try {
          onTranscribeProgress(data.payload || data);
        } catch (e) {
          console.warn('[ws] progress handler threw:', e);
        }
      } else if (data.type === 'agent_eval') {
        handleAgentEval(data);
      } else if (data.type === 'dev_reload') {
        console.log('[ws] dev_reload:', (data.files || []).join(', '));
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

  console.log('[EditFlow] Initialization complete');
});

function _showExtendScriptError(msg) {
  try {
    let b = document.getElementById('editflow-es-error');
    if (!b) {
      b = document.createElement('div');
      b.id = 'editflow-es-error';
      b.style.cssText = 'position:fixed;left:0;right:0;top:44px;z-index:99999;background:#5a2d2d;color:#fff;font:12px/1.4 monospace;padding:8px 10px;display:flex;gap:8px;align-items:center;border-bottom:1px solid #333';
      document.body.appendChild(b);
    }
    b.innerHTML = '';
    const span = document.createElement('span');
    span.style.flex = '1';
    span.textContent = 'ExtendScript connection failed: ' + String(msg).slice(0, 300);
    const btn = document.createElement('button');
    btn.textContent = 'Retry';
    btn.style.cssText = 'background:#5b8def;color:#fff;border:0;border-radius:4px;padding:3px 8px;cursor:pointer';
    btn.onclick = () => location.reload();
    b.appendChild(span); b.appendChild(btn);
  } catch (_) {}
}

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
    span.textContent = 'EditFlow error: ' + String(msg).slice(0, 300);
    const x = document.createElement('button');
    x.textContent = 'Dismiss';
    x.style.cssText = 'background:#7a3d3d;color:#fff;border:0;border-radius:4px;padding:3px 8px;cursor:pointer';
    x.onclick = () => b.remove();
    b.appendChild(span); b.appendChild(x);
  } catch (_) {}
}
