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

/**
 * Transition table: { fromState: { eventName: { to, guard? } } }
 */
const TRANSITIONS = {
  idle:            { scan_clicked:    { to: 'scanned' } },
  scanned:         { source_provided: { to: 'source_picked' } },
  source_picked:   { transcription_started: { to: 'transcribing' } },
  transcribing:    { all_jobs_complete:     { to: 'script_needed' } },
  script_needed:   { script_provided:  { to: 'matching' } },
  script_needed:   { script_ambiguous: { to: 'script_understood' } },
  script_understood: { script_confirmed: { to: 'matching' } },
  matching:        { dry_run_ready:    { to: 'plan_ready' } },
  plan_ready:      { approve_clicked:  { to: 'applying' } },
  plan_ready:      { regenerate_clicked: { to: 'matching' } },
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
};
