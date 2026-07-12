/**
 * main.js — Bootstrap for EditFlow AE panel.
 */
const BUILD_TAG = 'ae-captions-15';

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
import { openCaptions, closeCaptions } from './captions-view.js';
import { initSettings, openSettings, onWhisperDownloadProgress } from './settings.js';

const $ = (sel) => document.querySelector(sel);
const CLIENT_ID = 'ae-' + Math.random().toString(36).substring(2, 8);

let _esError = null;

document.addEventListener('DOMContentLoaded', async () => {
  console.log('[EditFlow] Initializing...');

  window.addEventListener('error', (e) => _showGlobalError((e && (e.error && e.error.message || e.message)) || 'Unknown error'));
  window.addEventListener('unhandledrejection', (e) => _showGlobalError((e && (e.reason && e.reason.message || e.reason)) || 'Unhandled promise rejection'));

  try {
    await initExtendScript();
  } catch (err) {
    console.error('[EditFlow] ExtendScript init failed:', err);
    _esError = err.message;
    _showExtendScriptError(err.message);
  }

  // Open the captions view immediately
  openCaptions();

  // Initialize settings overlay
  initSettings();

  // Wire settings button
  const btnSettings = $('#btn-settings');
  if (btnSettings) {
    btnSettings.addEventListener('click', () => openSettings());
  }

  // Connect WebSocket for real-time updates (whisper download progress, etc.)
  try {
    const ws = connectWS(CLIENT_ID);
    ws.on('message', (data) => {
      if (data && data.type === 'whisper_download_progress') {
        try {
          onWhisperDownloadProgress(data.payload || data);
        } catch (e) {
          console.warn('[ws] whisper_download_progress handler threw:', e);
        }
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
