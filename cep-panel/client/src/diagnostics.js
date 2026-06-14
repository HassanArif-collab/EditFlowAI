/**
 * diagnostics.js — Header diagnostics popover for EditFlow.
 *
 * Fetches GET /api/status (+ /api/preflight) and renders a read-only popover.
 */
import { apiGet, apiPost } from './api.js';

const $ = (sel) => document.querySelector(sel);

let _visible = false;

// ── Log sink: capture errors + relay to the backend file (data/logs) ──────
let _buf = [];
let _session = '?';
let _build = '?';
let _timer = null;

function _str(x) { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch (_) { return String(x); } }

/** Enqueue a diagnostics event; error-level flushes immediately. Never throws. */
function logEvent(level, source, msg, data) {
  try {
    _buf.push({ ts: Date.now(), level, source, msg: String(msg).slice(0, 500), data });
    if (_buf.length > 500) _buf.shift();
    if (level === 'error') _flush();
  } catch (_) { /* diagnostics must never break the app */ }
}

async function _flush() {
  if (!_buf.length) return;
  const events = _buf.splice(0, _buf.length);
  try { await apiPost('/api/diag/log', { build: _build, session: _session, events }, { timeoutMs: 5000 }); }
  catch (_) { /* drop on failure rather than grow unbounded */ }
}

/** Install global capture (console.error/warn, window errors). Call once at boot. */
function installGlobalCapture(sessionId, buildTag) {
  _session = sessionId || '?';
  _build = buildTag || '?';
  window.__editflowLog = logEvent;   // extendscript.js calls this without importing us
  try {
    const oErr = console.error.bind(console);
    const oWarn = console.warn.bind(console);
    console.error = (...a) => { logEvent('error', 'console', a.map(_str).join(' ')); oErr(...a); };
    console.warn = (...a) => { logEvent('warn', 'console', a.map(_str).join(' ')); oWarn(...a); };
    window.addEventListener('error', (e) => logEvent('error', 'window', e.message, { src: e.filename, line: e.lineno }));
    window.addEventListener('unhandledrejection', (e) => logEvent('error', 'promise', _str(e.reason)));
  } catch (_) {}
  if (!_timer) _timer = setInterval(_flush, 3000);
}

/** Flush pending events, then write a shareable bundle file + open the folder. */
async function saveBundle() {
  let premiere = '?';
  try { premiere = new CSInterface().getHostEnvironment().appVersion; } catch (_) {} // eslint-disable-line no-undef
  await _flush();
  return apiPost('/api/diag/bundle', { build: _build, session: _session, premiere }, { timeoutMs: 8000 });
}

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

    popEl.innerHTML = _renderDiagnostics(data) + _bundleHtml();
  } catch (err) {
    popEl.innerHTML = `<div class="popover-title">Diagnostics</div>` +
      `<div style="color:var(--error)">Backend not reachable</div>` +
      `<div style="color:var(--text-dim);font-size:11px;margin-top:4px">${err.message}</div>` +
      _bundleHtml();
  }
  _wireBundle(popEl);
}

function _bundleHtml() {
  return `<div style="margin-top:10px;border-top:1px solid rgba(255,255,255,.08);padding-top:8px">` +
    `<button id="diag-bundle-btn" class="icon-btn" style="width:100%;padding:6px;cursor:pointer">📋 Save diagnostics bundle</button>` +
    `<div id="diag-bundle-res" style="color:var(--text-dim);font-size:11px;margin-top:6px;word-break:break-all"></div></div>`;
}

function _wireBundle(popEl) {
  const btn = popEl.querySelector('#diag-bundle-btn');
  const res = popEl.querySelector('#diag-bundle-res');
  if (!btn) return;
  btn.onclick = async () => {
    if (res) res.textContent = 'Saving…';
    try {
      const r = await saveBundle();
      if (res) res.textContent = r && r.path
        ? `Saved: ${r.path}${r.folder_opened ? ' (folder opened)' : ''}`
        : `Failed: ${(r && r.error) || 'unknown'}`;
    } catch (e) { if (res) res.textContent = 'Failed: ' + (e.message || e); }
  };
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

export { initDiagnostics, installGlobalCapture, logEvent, saveBundle };
