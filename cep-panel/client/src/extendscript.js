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
 * @param {boolean} [forceReload=false] - pass true to force re-evaluation of every
 *   ExtendScript module from disk even when the engine thinks it is current
 *   (panel 🔁 button / dev_reload path — picks up .jsx edits).
 */
async function initExtendScript(forceReload = false) {
  const force = forceReload;
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

    await callExtendScript('editflowConfigureExtensionRoot', extensionRoot, !!forceReload);
    _esLoaded = true;
    console.log('[extendscript] ExtendScript loaded' + (forceReload ? ' (forced)' : ''));
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
      if (result === 'EvalScript error.' || result === undefined) {
        reject(new Error(`ExtendScript call "${fnName}" failed`));
        return;
      }
      try {
        const parsed = JSON.parse(result);
        if (parsed && parsed.success === false) {
          reject(new Error(parsed.error || `ExtendScript "${fnName}" returned failure`));
        } else {
          resolve(parsed);
        }
      } catch (_) {
        // Not JSON — return raw string
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
       'importFiles', 'getMarkers', 'importCaptionsFromSRT', 'callModule'
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

/**
 * Convenience: import an SRT file as a caption track on the active sequence.
 */
async function importCaptionsFromSRT(srtPath) {
  return callExtendScript('importCaptionsFromSRT', { srt_path: srtPath });
}

/**
 * Fully re-evaluate extendscript/index.jsx inside Premiere, then reload
 * every module from disk. Unlike initExtendScript (which only re-evals the
 * 12 module files), this also refreshes the editflowDispatch router itself
 * — required after index.jsx changes, with NO Premiere restart.
 * @returns {Promise<boolean>} true if the re-eval ran.
 */
async function reloadExtensionRoot() {
  if (typeof CSInterface === 'undefined') {
    return false;
  }
  const cs = _csInterface || new CSInterface(); // eslint-disable-line no-undef
  _csInterface = cs;
  const extensionPathKey =
    (cs.SYSTEM_PATH && cs.SYSTEM_PATH.EXTENSION) ||
    (typeof SystemPath !== 'undefined' && SystemPath.EXTENSION) || // eslint-disable-line no-undef
    'extension';
  // getSystemPath may return a file:// URL (Premiere does) or a plain
  // path — $.evalFile needs a plain filesystem path, so normalize first.
  let root = String(cs.getSystemPath(extensionPathKey) || cs.getSystemPath('extension') || '');
  root = root.replace(/^file:\/\/\//i, '');
  try { if (root.indexOf('%') !== -1) root = decodeURIComponent(root); } catch (_) {}
  if (!root) return false;
  const jsxPath = (root + '/extendscript/index.jsx').replace(/\\/g, '/');
  try { window.__editflowJsxPath = jsxPath; } catch (_) {}
  let evalResult = '(no callback)';
  await new Promise((resolve) => {
    try {
      cs.evalScript('$.evalFile("' + jsxPath + '")', (res) => { evalResult = String(res); resolve(); });
    } catch (_) {
      resolve();
    }
  });
  try { window.__editflowEvalResult = evalResult; } catch (_) {}
  // Modules may now be fresher than the engine state — force re-configure.
  try {
    await initExtendScript(true);
  } catch (_) { /* eval result already applied; configure is belt-and-suspenders */ }
  return true;
}

export {
  initExtendScript,
  reloadExtensionRoot,
  callExtendScript,
  getSelectedProjectItems,
  scanProjectMedia,
  importCaptionsFromSRT,
  isExtendScriptAvailable,
};
