/**
 * extendscript.js — Promise wrapper for Adobe CEP ExtendScript calls.
 */
let _csInterface = null;
let _esLoaded = false;

async function initExtendScript() {
  try {
    if (typeof CSInterface === 'undefined') {
      console.warn('[extendscript] CSInterface not available');
      return false;
    }
    _csInterface = new CSInterface();

    const extensionPathKey =
      (_csInterface.SYSTEM_PATH && _csInterface.SYSTEM_PATH.EXTENSION) ||
      'extension';
    const extensionRoot = _csInterface.getSystemPath(extensionPathKey) ||
                          _csInterface.getSystemPath('extension');

    await callExtendScript('editflowConfigureExtensionRoot', extensionRoot);
    _esLoaded = true;
    console.log('[extendscript] ExtendScript loaded');
    return true;
  } catch (e) {
    console.warn('[extendscript] Init failed:', e);
    return false;
  }
}

async function callExtendScript(fnName, ...args) {
  if (!_csInterface) {
    if (typeof CSInterface !== 'undefined') {
      _csInterface = new CSInterface();
    }
  }
  if (!_csInterface) {
    throw new Error('CSInterface not available');
  }

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
        resolve(result);
      }
    });
  });
}

function _buildScript(fnName, args) {
  const allowlist = ['editflowConfigureExtensionRoot', 'getCompInfo', 'getAudioPath', 'createCaptions', 'clearCaptions'];
  if (allowlist.includes(fnName)) {
    const command = fnName;
    const payload = args[0] || '';
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return `editflowDispatch("${command}", ${JSON.stringify(payloadStr)})`;
  }
  const serializedArgs = args.map(a => JSON.stringify(a)).join(', ');
  return `${fnName}(${serializedArgs})`;
}

function isExtendScriptAvailable() {
  return _esLoaded && _csInterface !== null;
}

export { initExtendScript, callExtendScript, isExtendScriptAvailable };
