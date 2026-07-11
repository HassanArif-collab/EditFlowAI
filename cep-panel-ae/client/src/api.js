/**
 * api.js — Centralized REST + WebSocket helpers for EditFlow backend.
 *
 * All backend calls go through these functions. Backend URL comes from
 * localStorage.editflow_backend_url or defaults to http://localhost:8765.
 */

function getBaseUrl() {
  return localStorage.editflow_backend_url || 'http://localhost:8765';
}

function setBaseUrl(url) {
  localStorage.editflow_backend_url = url;
}

/**
 * GET request with timeout.
 */
async function apiGet(path, { timeoutMs = 5000 } = {}) {
  const url = getBaseUrl() + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GET ${path} → ${res.status}: ${body}`);
    }
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      throw new Error(`GET ${path} timed out after ${timeoutMs}ms`);
    }
    throw e;
  }
}

/**
 * POST request with timeout.
 */
async function apiPost(path, body, { timeoutMs = 30000 } = {}) {
  const url = getBaseUrl() + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`POST ${path} → ${res.status}: ${text}`);
    }
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      throw new Error(`POST ${path} timed out after ${timeoutMs}ms`);
    }
    throw e;
  }
}

/**
 * PUT request with timeout.
 */
async function apiPut(path, body, { timeoutMs = 30000 } = {}) {
  const url = getBaseUrl() + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`PUT ${path} → ${res.status}: ${text}`);
    }
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`PUT ${path} timed out after ${timeoutMs}ms`);
    throw e;
  }
}

/**
 * DELETE request with timeout.
 */
async function apiDelete(path, { timeoutMs = 10000 } = {}) {
  const url = getBaseUrl() + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'DELETE',
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`DELETE ${path} → ${res.status}: ${text}`);
    }
    return res.status === 204 ? {} : await res.json();
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`DELETE ${path} timed out after ${timeoutMs}ms`);
    throw e;
  }
}

/**
 * Upload a file via multipart POST.
 */
async function apiUpload(path, file, fields = {}, { timeoutMs = 60000 } = {}) {
  const url = getBaseUrl() + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const form = new FormData();
    form.append('file', file);
    for (const [k, v] of Object.entries(fields)) {
      form.append(k, v);
    }
    const res = await fetch(url, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`UPLOAD ${path} → ${res.status}: ${text}`);
    }
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      throw new Error(`UPLOAD ${path} timed out after ${timeoutMs}ms`);
    }
    throw e;
  }
}

/**
 * WebSocket connection with auto-reconnect and EventEmitter interface.
 *
 * @param {string} clientId - Unique client identifier
 * @returns {{ on, off, close, send }} EventEmitter-like object
 */
function connectWS(clientId) {
  const baseUrl = getBaseUrl().replace(/^http/, 'ws');
  const url = `${baseUrl}/api/chat/ws/${clientId}`;
  let ws = null;
  let reconnectTimer = null;
  let listeners = {};
  let shouldReconnect = true;

  function connect() {
    try {
      ws = new WebSocket(url);
    } catch (e) {
      console.warn('[ws] Failed to create WebSocket:', e);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      console.log('[ws] Connected');
      _emit('open', {});
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        _emit('message', data);
        // Also emit specific event types
        if (data.type) {
          _emit(data.type, data);
        }
      } catch (_) {
        _emit('raw', event.data);
      }
    };

    ws.onclose = () => {
      console.log('[ws] Closed');
      _emit('close', {});
      if (shouldReconnect) scheduleReconnect();
    };

    ws.onerror = (e) => {
      console.warn('[ws] Error:', e);
      _emit('error', e);
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (shouldReconnect) connect();
    }, 3000);
  }

  function on(event, fn) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(fn);
  }

  function off(event, fn) {
    if (!listeners[event]) return;
    listeners[event] = listeners[event].filter(f => f !== fn);
  }

  function _emit(event, data) {
    if (!listeners[event]) return;
    for (const fn of listeners[event]) {
      try { fn(data); } catch (e) { console.error('[ws] listener error:', e); }
    }
  }

  function close() {
    shouldReconnect = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) ws.close();
    listeners = {};
  }

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  connect();
  return { on, off, close, send };
}

export { apiGet, apiPost, apiPut, apiDelete, apiUpload, connectWS, getBaseUrl, setBaseUrl };
