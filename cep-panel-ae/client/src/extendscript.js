/**
 * extendscript.js — Promise wrapper for Adobe CEP ExtendScript calls.
 *
 * v3: Based on TikTalk's proven pattern.
 *   1. Explicitly loads index.jsx via $.evalFile() from the client
 *   2. Calls functions DIRECTLY by name (no dispatcher)
 *   3. Returns plain strings that we parse as JSON
 */
let _csInterface = null;
let _esLoaded = false;

async function initExtendScript() {
  if (typeof CSInterface === 'undefined') {
    throw new Error('CSInterface not available');
  }
  _csInterface = new CSInterface();

  const extensionPathKey =
    (_csInterface.SYSTEM_PATH && _csInterface.SYSTEM_PATH.EXTENSION) ||
    'extension';
  const extensionRoot = _csInterface.getSystemPath(extensionPathKey) ||
                        _csInterface.getSystemPath('extension');

  console.log('[extendscript] Extension root:', extensionRoot);

  // Load the ExtendScript file explicitly via $.evalFile()
  // (TikTalk pattern — don't rely on <ScriptPath> alone)
  const jsxPath = (extensionRoot + '/extendscript/index.jsx').replace(/\\/g, '/');
  console.log('[extendscript] Loading JSX:', jsxPath);

  await new Promise((resolve, reject) => {
    _csInterface.evalScript('$.evalFile("' + jsxPath + '")', (result) => {
      if (result === 'EvalScript error.' || result === undefined) {
        console.error('[extendscript] $.evalFile failed:', result);
        reject(new Error('Failed to load ExtendScript file: ' + jsxPath));
      } else {
        console.log('[extendscript] JSX loaded');
        resolve();
      }
    });
  });

  // Verify with ping
  try {
    const ping = await _evalScriptRaw('ef_ping()');
    console.log('[extendscript] Ping result:', ping);
    if (ping !== 'pong') {
      console.warn('[extendscript] Unexpected ping result:', ping);
    }
    _esLoaded = true;
    console.log('[extendscript] ExtendScript loaded successfully');
    return true;
  } catch (e) {
    console.error('[extendscript] Ping failed:', e);
    throw new Error('ExtendScript loaded but ping failed: ' + e.message);
  }
}

/**
 * Call an ExtendScript function by name, returning a Promise.
 * The function is called DIRECTLY (no dispatcher).
 */
async function callExtendScript(fnName, ...args) {
  if (!_csInterface) {
    if (typeof CSInterface !== 'undefined') {
      _csInterface = new CSInterface();
    }
  }
  if (!_csInterface) {
    throw new Error('CSInterface not available');
  }

  // Build the script string — call the function directly
  let script;
  if (args.length === 0) {
    script = `${fnName}()`;
  } else if (args.length === 1 && typeof args[0] === 'string') {
    // String arg — wrap in quotes (escaped)
    script = `${fnName}(${JSON.stringify(args[0])})`;
  } else if (args.length === 1 && typeof args[0] === 'object') {
    // Object arg — pass as JSON string (function receives it as a string param)
    script = `${fnName}(${JSON.stringify(JSON.stringify(args[0]))})`;
  } else {
    // Multiple args — serialize each
    const serialized = args.map(a => JSON.stringify(typeof a === 'object' ? JSON.stringify(a) : a)).join(', ');
    script = `${fnName}(${serialized})`;
  }

  const result = await _evalScriptRaw(script);

  // Check for ERROR: prefix (TikTalk pattern)
  if (typeof result === 'string' && result.indexOf('ERROR:') === 0) {
    throw new Error(result.substring(6));
  }

  // Try to parse as JSON
  try {
    return JSON.parse(result);
  } catch (_) {
    // Not JSON — return as string
    return result;
  }
}

/**
 * Raw evalScript call — returns the raw string result.
 */
function _evalScriptRaw(script) {
  return new Promise((resolve, reject) => {
    _csInterface.evalScript(script, (result) => {
      if (result === 'EvalScript error.' || result === undefined) {
        reject(new Error('EvalScript error for: ' + script.substring(0, 100)));
        return;
      }
      resolve(result);
    });
  });
}

function isExtendScriptAvailable() {
  return _esLoaded && _csInterface !== null;
}

/**
 * Capture the current After Effects playhead frame to a PNG and return
 * its path/time/comp info. Returns the parsed JSON result from ef_getCurrentFrame().
 */
async function getCurrentFrame() {
  return callExtendScript('ef_getCurrentFrame');
}

/**
 * Read the ExtendScript debug log written by ef_getCurrentFrame (numbered
 * step trace). Used by the 📋 Log button to show exactly where a capture
 * failed. Returns { log, path } or { error }.
 */
async function readDebugLog() {
  return callExtendScript('ef_readDebugLog');
}

export { initExtendScript, callExtendScript, isExtendScriptAvailable, getCurrentFrame, readDebugLog };
