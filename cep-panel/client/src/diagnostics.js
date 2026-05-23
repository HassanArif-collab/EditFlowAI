/**
 * diagnostics.js — Header diagnostics popover for EditFlow.
 *
 * Fetches GET /api/status (+ /api/preflight) and renders a read-only popover.
 */
import { apiGet } from './api.js';

const $ = (sel) => document.querySelector(sel);

let _visible = false;

/**
 * Initialize the diagnostics popover.
 *
 * @param {HTMLElement} btnEl - The #btn-diagnostics button
 * @param {HTMLElement} popEl - The #diagnostics-popover element
 */
function initDiagnostics(btnEl, popEl) {
  if (!btnEl || !popEl) return;

  btnEl.addEventListener('click', async () => {
    if (_visible) {
      _hide(popEl);
      return;
    }
    await _show(popEl);
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _visible) {
      _hide(popEl);
    }
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (_visible && !popEl.contains(e.target) && e.target !== btnEl) {
      _hide(popEl);
    }
  });
}

async function _show(popEl) {
  _visible = true;
  popEl.classList.remove('hidden');

  // Render loading state
  popEl.innerHTML = '<div class="popover-title">Diagnostics</div><div style="color:var(--text-dim)">Loading...</div>';

  try {
    // /api/status is the canonical status endpoint on this backend.
    // /api/preflight returns environment checks; merge both for a fuller picture.
    let data = await apiGet('/api/status', { timeoutMs: 5000 });
    try {
      const preflight = await apiGet('/api/preflight', { timeoutMs: 3000 });
      data = { ...data, preflight };
    } catch (_) { /* preflight is bonus; status alone is enough */ }

    popEl.innerHTML = _renderDiagnostics(data);
  } catch (err) {
    popEl.innerHTML = `<div class="popover-title">Diagnostics</div>` +
      `<div style="color:var(--error)">Backend not reachable</div>` +
      `<div style="color:var(--text-dim);font-size:11px;margin-top:4px">${err.message}</div>`;
  }
}

function _hide(popEl) {
  _visible = false;
  popEl.classList.add('hidden');
}

function _renderDiagnostics(data) {
  const providers = data.providers || {};
  const providerRows = Object.entries(providers).map(([id, info]) => {
    const connected = info.connected ? 'OK' : 'Down';
    const color = info.connected ? 'var(--success)' : 'var(--error)';
    return `<div class="popover-row">
      <span class="popover-key">${id}</span>
      <span class="popover-val" style="color:${color}">${connected}</span>
    </div>`;
  }).join('');

  return `<div class="popover-title">Diagnostics</div>` +
    `<div class="popover-row"><span class="popover-key">Server</span><span class="popover-val" style="color:var(--success)">${data.version ? 'v' + data.version : 'Running'}</span></div>` +
    (data.any_provider_connected !== undefined ?
      `<div class="popover-row"><span class="popover-key">Provider</span><span class="popover-val" style="color:${data.any_provider_connected ? 'var(--success)' : 'var(--error)'}">${data.any_provider_connected ? 'Connected' : 'None'}</span></div>` : '') +
    (data.active_chat ? `<div class="popover-row"><span class="popover-key">Chat model</span><span class="popover-val">${data.active_chat || '-'}</span></div>` : '') +
    (data.whisper_loaded !== undefined ?
      `<div class="popover-row"><span class="popover-key">Whisper</span><span class="popover-val" style="color:${data.whisper_loaded ? 'var(--success)' : 'var(--text-dim)'}">${data.whisper_loaded ? 'Loaded' : 'Not loaded'}</span></div>` : '') +
    (Object.keys(providers).length > 0 ?
      `<div style="margin-top:8px;font-size:11px;font-weight:600;color:var(--text-dim)">PROVIDERS</div>${providerRows}` : '');
}

export { initDiagnostics };
