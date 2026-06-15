/**
 * extendscript.js — Promise wrapper for Adobe CEP ExtendScript calls.
 *
 * Uses CSInterface.evalScript() under the hood. Converts the
 * callback-based API into Promises. Also handles loading the
 * ExtendScript module bundle.
 */
let _csInterface = null;
let _esLoaded = false;

/**
 * Initialize the CSInterface reference and load the ExtendScript bundle.
 */
async function initExtendScript() {
  try {
    if (typeof CSInterface === 'undefined') {
      console.warn('[extendscript] CSInterface not available — running outside CEP?');
      _esLoaded = false;
      return false;
    }
    _csInterface = new CSInterface(); // eslint-disable-line no-undef

    // Load the ExtendScript index.jsx which in turn loads all modules
    const extensionPathKey =
      (_csInterface.SYSTEM_PATH && _csInterface.SYSTEM_PATH.EXTENSION) ||
      (typeof SystemPath !== 'undefined' && SystemPath.EXTENSION) || // eslint-disable-line no-undef
      'extension';
    const extensionRoot = _csInterface.getSystemPath(extensionPathKey) ||
                          _csInterface.getSystemPath('extension');

    await callExtendScript('editflowConfigureExtensionRoot', extensionRoot);
    // Force-reload the .jsx module files from disk so ExtendScript edits apply on
    // a panel refresh (Premiere caches them per session otherwise — no full
    // restart needed during development).
    try { await callExtendScript('editflowLoadAllModules', extensionRoot + '/extendscript'); }
    catch (e) { console.warn('[extendscript] module force-reload failed:', e); }
    _esLoaded = true;
    console.log('[extendscript] ExtendScript loaded');
    return true;
  } catch (e) {
    console.warn('[extendscript] Init failed:', e);
    _esLoaded = false;
    return false;
  }
}

/**
 * Call an ExtendScript function by name, returning a Promise.
 *
 * @param {string} fnName - Function name in ExtendScript (e.g. 'scanProjectMedia')
 * @param {...any} args - Arguments to pass (will be JSON-serialized)
 * @returns {Promise<any>} Parsed JSON result from ExtendScript
 */
async function callExtendScript(fnName, ...args) {
  if (!_csInterface) {
    // Try to create it on-the-fly
    if (typeof CSInterface !== 'undefined') {
      _csInterface = new CSInterface(); // eslint-disable-line no-undef
    }
  }
  if (!_csInterface) {
    throw new Error('CSInterface not available');
  }

  // Build the script string
  const script = _buildScript(fnName, args);

  return new Promise((resolve, reject) => {
    _csInterface.evalScript(script, (result) => {
      // Log every ExtendScript call to the diagnostics sink so DOM failures
      // (e.g. importMGT returning null) are captured without the user noticing.
      const _log = (typeof window !== 'undefined' && window.__editflowLog) || null;
      if (result === 'EvalScript error.' || result === undefined) {
        if (_log) _log('error', 'jsx', fnName, { error: 'EvalScript error' });
        reject(new Error(`ExtendScript call "${fnName}" failed`));
        return;
      }
      try {
        const parsed = JSON.parse(result);
        // Surface diagnostic fields (a tool can report success:true yet carry
        // per-item errors, e.g. placeSubtitleClips placed:0 with cue errors).
        const _summ = (p) => {
          const s = {};
          if (p && typeof p === 'object') {
            ['success', 'placed', 'total', 'errors', 'error'].forEach((k) => {
              if (p[k] !== undefined) s[k] = p[k];
            });
          }
          return s;
        };
        if (parsed && parsed.success === false) {
          if (_log) _log('error', 'jsx', fnName, { ok: false, ..._summ(parsed) });
          reject(new Error(parsed.error || `ExtendScript "${fnName}" returned failure`));
        } else {
          const sm = _summ(parsed);
          const hadErrors = Array.isArray(sm.errors) && sm.errors.length > 0;
          if (_log) _log(hadErrors ? 'error' : 'info', 'jsx', fnName, { ok: true, ...sm });
          resolve(parsed);
        }
      } catch (_) {
        // Not JSON — return raw string
        if (_log) _log('info', 'jsx', fnName, { ok: true, raw: true });
        resolve(result);
      }
    });
  });
}

/**
 * Build a self-contained ExtendScript call string.
 */
function _buildScript(fnName, args) {
  const serializedArgs = args.map(a => JSON.stringify(a)).join(', ');

  // Dispatch through the central editflowDispatch router if available,
  // otherwise call the function directly (for backward compat).
  if (['scanProject', 'scanProjectMedia', 'getSequenceState', 'processEDL',
       'addMediaToTimeline', 'createSequence', 'getSelectedProjectItems',
       'probeCapabilities', 'undoLastAction', 'removeTimelineClips',
       'clearTimelineLabels', 'addMarker', 'removeTimelineRanges',
       'importFiles', 'getMarkers',
       'getSequenceVideoSettings', 'placeSubtitleClips', 'manageTracks'
      ].includes(fnName)) {
    // These are dispatched through the index.jsx router
    const command = fnName;
    const payload = args[0] || '';
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return `editflowDispatch("${command}", ${JSON.stringify(payloadStr)})`;
  }

  // Direct function call
  return `${fnName}(${serializedArgs})`;
}

/**
 * Convenience: get selected project items from Premiere.
 */
async function getSelectedProjectItems() {
  return callExtendScript('getSelectedProjectItems');
}

/**
 * Convenience: scan project media.
 */
async function scanProjectMedia() {
  return callExtendScript('scanProjectMedia');
}

/**
 * Check if ExtendScript is available (i.e., we're in CEP).
 */
function isExtendScriptAvailable() {
  return _esLoaded && _csInterface !== null;
}

export {
  initExtendScript,
  callExtendScript,
  getSelectedProjectItems,
  scanProjectMedia,
  isExtendScriptAvailable,
};
