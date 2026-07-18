/**
 * agent-bridge.js — dev-only glue for the AE agent loop.
 *
 * 1. Executes `agent_eval` jobs pushed over the backend WebSocket
 *    (POST /api/ae-bridge/eval on the backend side) via callExtendScript
 *    and POSTs each result back. Inert unless the backend runs with
 *    EDITFLOW_AGENT_BRIDGE=1 — no jobs ever arrive otherwise.
 * 2. devReload(): re-evals index.jsx inside AE (functions are globals, so
 *    redefinition hot-swaps them without restarting AE), then reloads the
 *    panel page. Triggered by the 🔁 header button or a `dev_reload` push
 *    from the backend file watcher.
 * 3. reportError(): forwards panel/jsx errors to POST /api/diag/log so an
 *    agent can read them from GET /api/diag/log/tail.
 */
import { callExtendScript } from './extendscript.js';
import { apiPost } from './api.js';

export async function handleAgentEval(msg) {
  const { job_id, fn, args } = msg || {};
  if (!job_id || !fn) return;
  let payload;
  try {
    const result = await callExtendScript(fn, ...(args || []));
    payload = { ok: true, result };
  } catch (e) {
    payload = { ok: false, error: String((e && e.message) || e) };
    reportError('jsx', `agent_eval ${fn} failed`, { error: payload.error });
  }
  try {
    await apiPost(`/api/ae-bridge/result/${job_id}`, payload, { timeoutMs: 10000 });
  } catch (e) {
    console.warn('[agent-bridge] result POST failed:', e);
  }
}

let _reloading = false;

export async function devReload() {
  if (_reloading) return;
  _reloading = true;
  try {
    if (window.__adobe_cep__ && typeof CSInterface !== 'undefined') {
      const cs = new CSInterface();
      const key = (cs.SYSTEM_PATH && cs.SYSTEM_PATH.EXTENSION) || 'extension';
      const root = cs.getSystemPath(key) || cs.getSystemPath('extension');
      const jsxPath = (root + '/extendscript/index.jsx').replace(/\\/g, '/');
      await new Promise((resolve) => {
        // Re-evalFile redefines every ef_* global — jsx hot swap, no AE restart.
        cs.evalScript('$.evalFile("' + jsxPath + '")', () => resolve());
      });
    }
  } catch (e) {
    console.warn('[agent-bridge] jsx re-eval failed (reloading panel anyway):', e);
  }
  location.reload();
}

/* Fire-and-forget error relay into the backend log sink. */
export function reportError(source, msg, data) {
  try {
    apiPost('/api/diag/log', {
      build: 'ae-panel',
      events: [{ level: 'error', source: source || 'panel', msg: String(msg).slice(0, 500), data }],
    }, { timeoutMs: 5000 }).catch(() => {});
  } catch (_) { /* diagnostics must never break the panel */ }
}
