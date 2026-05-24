/**
 * state.js — Frontend state machine for EditFlow single-chat UX.
 *
 * Exports: getState, setState, transition, subscribe, resetState.
 * The state machine drives the 7-stage pipeline:
 *   idle → scanned → source_picked → transcribing → script_needed
 *   → (script_understood) → matching → plan_ready → applying → done
 */
const STATES = [
  'idle', 'scanned', 'source_picked', 'transcribing',
  'script_needed', 'script_understood', 'matching',
  'plan_ready', 'applying', 'done', 'error'
];

const INITIAL_SESSION = {
  clientId: '',
  scan: null,
  sources: [],
  transcripts: {},
  scriptId: null,
  scriptText: null,
  planId: null,
  dryRun: null,
  edl: null,
  targetSequenceName: null,
  pendingScriptFile: null,
  previousState: null,
};

let state = {
  current: 'idle',
  session: { ...INITIAL_SESSION },
};

const listeners = [];

// ── Persistence ──────────────────────────────────────────────
// Save the workflow state to localStorage so the user can resume after
// closing Premiere. Saved on every transition / session patch.
// States NOT worth resuming: 'idle', 'error', and the volatile in-flight
// states ('transcribing', 'applying') — those should restart fresh.
const STORAGE_KEY = 'editflow_session_v1';
const RESUMABLE_STATES = new Set(['scanned', 'source_picked', 'script_needed', 'plan_ready', 'done']);

function _saveToStorage() {
  try {
    if (!RESUMABLE_STATES.has(state.current)) return;
    const snapshot = {
      current: state.current,
      session: {
        // Persist only what's safe + useful to resume.
        clientId: state.session.clientId,
        // sources keep the bin/clip references the user picked.
        sources: state.session.sources,
        scriptText: state.session.scriptText,
        planId: state.session.planId,
        targetSequenceName: state.session.targetSequenceName,
        // scan reference: store project hash or last_updated to know if it
        // matches on resume. Keep just lightweight metadata.
        scanFingerprint: state.session.scan
          ? `${(state.session.scan.bins || []).length}b/${(state.session.scan.items || []).length}i`
          : null,
      },
      savedAt: Date.now(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch (_) { /* localStorage quota or disabled — ignore */ }
}

/**
 * Returns the saved session, or null if there isn't one (or it's stale).
 * Stale = older than 7 days. The caller decides whether to offer resume.
 */
function loadResumableSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !data.current || !data.session) return null;
    if (!RESUMABLE_STATES.has(data.current)) return null;
    const age = Date.now() - (data.savedAt || 0);
    if (age > 7 * 24 * 60 * 60 * 1000) return null;
    return data;
  } catch (_) {
    return null;
  }
}

/**
 * Hydrate the in-memory state from a saved snapshot. Used by main.js when
 * the user clicks "Resume" on a saved session card.
 */
function hydrateFromSaved(saved) {
  if (!saved || !saved.current || !saved.session) return false;
  state.current = saved.current;
  // Merge into the initial session shape so any new fields get defaults.
  state.session = { ...INITIAL_SESSION, ...saved.session };
  _notify('hydrated', { from: 'storage' });
  return true;
}

function clearSavedSession() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* ignore */ }
}

/**
 * Transition table: { fromState: { eventName: { to, guard? } } }
 */
const TRANSITIONS = {
  idle:            { scan_clicked:    { to: 'scanned' } },
  scanned:         { source_provided: { to: 'source_picked' } },
  source_picked:   { transcription_started: { to: 'transcribing' } },
  transcribing:    {
    all_jobs_complete: { to: 'script_needed' },
    source_provided:   { to: 'transcribing' },  // add more sources while transcribing
  },
  script_needed:   {
    script_provided:  { to: 'matching' },
    script_ambiguous: { to: 'script_understood' },
  },
  script_understood: { script_confirmed: { to: 'matching' } },
  matching:        { dry_run_ready:    { to: 'plan_ready' } },
  plan_ready:      {
    approve_clicked:    { to: 'applying' },
    regenerate_clicked: { to: 'matching' },
  },
  applying:        { extendscript_done: { to: 'done' } },
  done:            { new_edit:         { to: 'idle' } },
};

function transition(event, payload) {
  const from = state.current;
  const table = TRANSITIONS[from];
  if (!table || !table[event]) {
    console.warn(`[state] No transition from "${from}" on event "${event}"`);
    return false;
  }
  const { to } = table[event];
  state.session.previousState = from;
  state.current = to;
  if (payload) {
    Object.assign(state.session, payload);
  }
  console.log(`[state] ${from} → ${to} (event: ${event})`);
  _saveToStorage();
  _notify(event, payload);
  return true;
}

function transitionError(errorMsg) {
  const prev = state.current;
  state.session.previousState = prev;
  state.current = 'error';
  state.session.errorMessage = errorMsg;
  console.warn(`[state] ${prev} → error (${errorMsg})`);
  _notify('error', { from: prev, error: errorMsg });
}

function transitionBack() {
  if (state.session.previousState) {
    state.current = state.session.previousState;
    state.session.previousState = null;
    delete state.session.errorMessage;
    _notify('back', {});
    return true;
  }
  return false;
}

function getState() {
  return state;
}

function setState(patch) {
  Object.assign(state, patch);
  _notify('patch', patch);
}

function setSession(patch) {
  Object.assign(state.session, patch);
  _saveToStorage();
  _notify('session_patch', patch);
}

function subscribe(fn) {
  listeners.push(fn);
  return () => {
    const idx = listeners.indexOf(fn);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

function resetState() {
  const clientId = state.session.clientId;
  state.current = 'idle';
  state.session = { ...INITIAL_SESSION, clientId };
  clearSavedSession();
  _notify('reset', {});
}

function _notify(event, payload) {
  for (const fn of listeners) {
    try { fn(event, payload, state); }
    catch (e) { console.error('[state] listener error:', e); }
  }
}

export {
  STATES,
  getState,
  setState,
  setSession,
  transition,
  transitionError,
  transitionBack,
  subscribe,
  resetState,
  loadResumableSession,
  hydrateFromSaved,
  clearSavedSession,
};
