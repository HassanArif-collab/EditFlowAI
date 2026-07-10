/**
 * api.js — REST + WebSocket helpers (same as Premiere version).
 */
function getBaseUrl() {
  return localStorage.editflow_backend_url || 'http://localhost:8765';
}

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
    if (e.name === 'AbortError') throw new Error(`GET ${path} timed out after ${timeoutMs}ms`);
    throw e;
  }
}

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
    if (e.name === 'AbortError') throw new Error(`POST ${path} timed out after ${timeoutMs}ms`);
    throw e;
  }
}

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
    if (e.name === 'AbortError') throw new Error(`UPLOAD ${path} timed out after ${timeoutMs}ms`);
    throw e;
  }
}

export { apiGet, apiPost, apiUpload, getBaseUrl };
