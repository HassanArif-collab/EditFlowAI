/**
 * dnd.js — Drag-and-drop ingestion for EditFlow CEP panel.
 *
 * Two paths:
 *   A) OS file explorer → HTML5 drag-drop → register/scan/extract
 *   B) Premiere project panel → ExtendScript getSelectedProjectItems()
 *
 * Plus a fallback selection-chip button.
 */
import { callExtendScript, getSelectedProjectItems, isExtendScriptAvailable } from './extendscript.js';
import { apiPost } from './api.js';
import { appendMessage } from './chat-ui.js';

const MEDIA_EXTS = new Set([
  '.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm',
  '.mp3', '.wav', '.m4a', '.flac'
]);

const SCRIPT_EXTS = new Set(['.pdf', '.docx', '.txt', '.md']);

let _dropCounter = 0; // tracks nested dragenter/leave
let _onMediaDrop = null;
let _onScriptDrop = null;
let _onPProDrop = null;
let _selectionPollTimer = null;

/**
 * Setup the drop zone on the main element.
 *
 * @param {HTMLElement} rootEl - The <main> element
 * @param {HTMLElement} overlayEl - The drop overlay element
 * @param {object} handlers - { onMediaDrop, onScriptDrop, onPProDrop }
 */
function setupDropZone(rootEl, overlayEl, handlers) {
  _onMediaDrop = handlers.onMediaDrop || (() => {});
  _onScriptDrop = handlers.onScriptDrop || (() => {});
  _onPProDrop = handlers.onPProDrop || (() => {});

  rootEl.addEventListener('dragenter', (e) => {
    e.preventDefault();
    e.stopPropagation();
    _dropCounter++;
    overlayEl.classList.remove('hidden');
    rootEl.classList.add('drop-target-active');
  });

  rootEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  rootEl.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    _dropCounter--;
    if (_dropCounter <= 0) {
      _dropCounter = 0;
      overlayEl.classList.add('hidden');
      rootEl.classList.remove('drop-target-active');
    }
  });

  rootEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    _dropCounter = 0;
    overlayEl.classList.add('hidden');
    rootEl.classList.remove('drop-target-active');

    await _handleDrop(e);
  });
}

async function _handleDrop(e) {
  const files = e.dataTransfer.files;
  const types = e.dataTransfer.types;

  // Path A: OS file explorer dropped files
  if (files && files.length > 0) {
    await _handleOSFiles(files);
    return;
  }

  // Path B: Premiere project panel drop (no files, but has types)
  if (types && types.length > 0 && isExtendScriptAvailable()) {
    await _handlePProDrop();
    return;
  }

  // Fallback: couldn't read
  appendMessage('error', {
    text: "Couldn't read the dropped item. Try the selection chip above the input instead.",
  });
}

async function _handleOSFiles(files) {
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const ext = _getExtension(file.name);

    // Check if it's a directory entry
    const entry = file.webkitGetAsEntry ? file.webkitGetAsEntry() : null;
    if (entry && entry.isDirectory) {
      // Directory scan
      await _handleDirectory(file);
      continue;
    }

    if (SCRIPT_EXTS.has(ext)) {
      // Script file
      await _onScriptDrop(file);
    } else if (MEDIA_EXTS.has(ext)) {
      // Media file — register as asset
      await _onMediaDrop(file);
    } else {
      appendMessage('error', {
        text: `Unsupported file type: ${ext || 'unknown'}`,
      });
    }
  }
}

async function _handleDirectory(file) {
  // This backend operates on bins already inside the Premiere project, not
  // on raw OS folders. Tell the user to import the folder into Premiere first.
  const dirName = file.name || 'this folder';
  appendMessage('agent-text', {
    text: `Drag "${dirName}" into a bin inside Premiere first, then drop that bin onto this panel.`,
  });
}

async function _handlePProDrop() {
  try {
    const result = await getSelectedProjectItems();
    if (!result || !result.success || !result.items || result.items.length === 0) {
      appendMessage('error', { text: 'No items selected in Premiere project.' });
      return;
    }
    _onPProDrop(result.items);
  } catch (err) {
    appendMessage('error', { text: `Could not read Premiere selection: ${err.message}` });
  }
}

/**
 * Setup the selection chip that polls for selected Premiere items.
 *
 * @param {HTMLElement} chipEl - The #selection-chip element
 * @param {Function} onUseSelected - Called with selected items
 * @param {Function} getStateFn - Returns current state
 */
function setupSelectionChip(chipEl, onUseSelected, getStateFn) {
  if (!chipEl) return;

  // Start polling
  _selectionPollTimer = setInterval(async () => {
    const state = getStateFn();
    // Only poll in idle or scanned state
    // Plan says: hide when state moves past script_needed
    const hiddenStates = ['matching', 'plan_ready', 'applying', 'done', 'error'];
    if (hiddenStates.includes(state.current)) {
      chipEl.classList.add('hidden');
      return;
    }

    if (!isExtendScriptAvailable()) {
      chipEl.classList.add('hidden');
      return;
    }

    try {
      const result = await getSelectedProjectItems();
      if (result && result.success && result.items && result.items.length > 0) {
        chipEl.classList.remove('hidden');
        chipEl.textContent = `\u{1F4E5} Use ${result.items.length} selected item${result.items.length > 1 ? 's' : ''}`;
      } else {
        chipEl.classList.add('hidden');
      }
    } catch (_) {
      chipEl.classList.add('hidden');
    }
  }, 2000);

  // Click handler
  chipEl.addEventListener('click', async () => {
    try {
      const result = await getSelectedProjectItems();
      if (result && result.success && result.items && result.items.length > 0) {
        onUseSelected(result.items);
      }
    } catch (err) {
      appendMessage('error', { text: `Could not read selection: ${err.message}` });
    }
  });
}

/**
 * Stop the selection chip polling.
 */
function stopSelectionPoll() {
  if (_selectionPollTimer) {
    clearInterval(_selectionPollTimer);
    _selectionPollTimer = null;
  }
}

function _getExtension(filename) {
  if (!filename) return '';
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return '';
  return filename.substring(dot).toLowerCase();
}

export { setupDropZone, setupSelectionChip, stopSelectionPoll };
