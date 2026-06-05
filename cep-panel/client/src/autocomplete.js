/**
 * autocomplete.js — @bin/@clip autocomplete popup for EditFlow input.
 *
 * Attaches to the chat textarea. When the user types @, queries
 * /api/premiere/bins and /api/premiere/items (client-side filter)
 * to suggest bins and clips.
 */
import { apiGet } from './api.js';

// Slash-command palette. Typing "/" at the start of the input shows these so the
// user never has to remember a command. "/review" runs immediately on pick.
const _COMMANDS = [
  { cmd: '/review', detail: 'Open the word-level cut editor', icon: '&#128221;' },
  { cmd: '/transcribe', detail: 'Get the transcription prompt (paste video into Gemini)', icon: '&#127908;' },
  { cmd: '/cutplan', detail: 'Build the cut-planning prompt', icon: '&#9986;' },
  { cmd: '/paste-plan', detail: 'Apply a pasted cut-plan JSON', icon: '&#128203;' },
  { cmd: '/llm-prompt', detail: 'Build the paste-into-LLM prompt (with transcript)', icon: '&#129302;' },
];

let _popupEl = null;
let _activeIndex = -1;
let _items = [];
let _onSelect = null;
let _debounceTimer = null;

const MEDIA_EXTS = new Set([
  '.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm',
  '.mp3', '.wav', '.m4a', '.flac'
]);

/**
 * Attach autocomplete to the input element.
 * @param {HTMLTextAreaElement} inputEl
 * @param {Function} selectCallback - Called with {type: 'bin'|'clip', name, ...rest}
 */
function attachAutocomplete(inputEl, selectCallback) {
  _onSelect = selectCallback;
  _createPopup(inputEl);

  inputEl.addEventListener('input', () => {
    const text = inputEl.value;
    const pos = inputEl.selectionStart;
    const beforeCursor = text.substring(0, pos);

    // "/" command palette — only when the whole input is a leading command token.
    const slashMatch = text.match(/^\s*\/([a-z-]*)$/i);
    const atMatch = beforeCursor.match(/@([^\s@]*)$/);

    if (slashMatch) {
      _showCommands(slashMatch[1].toLowerCase());
    } else if (atMatch) {
      _debounce(() => _fetchSuggestions(atMatch[1]), 150);
    } else {
      _hide();
    }
  });

  inputEl.addEventListener('keydown', (e) => {
    if (!_popupEl || _popupEl.classList.contains('hidden')) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _activeIndex = Math.min(_activeIndex + 1, _items.length - 1);
      _highlightActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _activeIndex = Math.max(_activeIndex - 1, 0);
      _highlightActive();
    } else if (e.key === 'Enter' && _activeIndex >= 0) {
      e.preventDefault();
      _pickItem(_activeIndex, inputEl);
    } else if (e.key === 'Escape') {
      _hide();
    } else if (e.key === 'Tab' && _activeIndex >= 0) {
      e.preventDefault();
      _pickItem(_activeIndex, inputEl);
    }
  });
}

function _createPopup(inputEl) {
  if (_popupEl) return;
  _popupEl = document.createElement('div');
  _popupEl.className = 'autocomplete-popup hidden';
  // Insert into footer, positioned relative to input row
  const footer = document.getElementById('app-footer');
  if (footer) {
    const inputRow = footer.querySelector('.input-row');
    if (inputRow) {
      inputRow.style.position = 'relative';
      inputRow.appendChild(_popupEl);
    }
  }
}

function _showCommands(q) {
  _items = _COMMANDS
    .filter(c => !q || c.cmd.slice(1).startsWith(q))
    .map(c => ({ type: 'command', name: c.cmd, detail: c.detail, icon: c.icon }));
  _render();
}

async function _fetchSuggestions(query) {
  try {
    const results = [];
    const q = (query || '').toLowerCase();

    // Fetch bins from the actual Premiere context (set by scan)
    let bins = [];
    let items = [];
    try {
      const binsResp = await apiGet(`/api/premiere/bins`, { timeoutMs: 3000 });
      bins = binsResp.bins || [];
    } catch (_) { /* premiere context may be empty until scan */ }

    for (const bin of bins) {
      const name = bin.name || '';
      if (!q || name.toLowerCase().includes(q)) {
        results.push({
          type: 'bin',
          name,
          detail: `${bin.itemCount || bin.item_count || '?'} clips`,
          binPath: bin.path || bin.binPath || '',
          icon: '&#128193;', // folder
        });
      }
    }

    // Fetch items (clips) from the same context — filter client-side
    if (q) {
      try {
        const itemsResp = await apiGet(`/api/premiere/items?limit=200`, { timeoutMs: 3000 });
        items = itemsResp.items || [];
      } catch (_) { /* premiere context may be empty until scan */ }

      for (const item of items) {
        const name = item.name || '';
        if (name.toLowerCase().includes(q)) {
          results.push({
            type: 'clip',
            name,
            detail: item.duration ? `${_fmtDur(item.duration)}` : '',
            mediaPath: item.mediaPath || item.media_path || '',
            icon: '&#127909;', // movie
          });
        }
      }
    }

    _items = results.slice(0, 8);
    _render();
  } catch (e) {
    console.warn('[autocomplete] Error fetching suggestions:', e);
  }
}

function _render() {
  if (!_popupEl) return;
  if (_items.length === 0) {
    _hide();
    return;
  }

  _activeIndex = -1;
  _popupEl.innerHTML = _items.map((item, i) =>
    `<div class="ac-item" data-index="${i}">` +
      `<span class="ac-icon">${item.icon}</span>` +
      `<span class="ac-name">${_esc(item.name)}</span>` +
      `<span class="ac-detail">${_esc(item.detail)}</span>` +
    `</div>`
  ).join('');

  _popupEl.classList.remove('hidden');

  // Click handlers
  _popupEl.querySelectorAll('.ac-item').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.index, 10);
      _pickItem(idx, document.getElementById('chat-input'));
    });
  });
}

function _highlightActive() {
  if (!_popupEl) return;
  const items = _popupEl.querySelectorAll('.ac-item');
  items.forEach((el, i) => {
    el.classList.toggle('active', i === _activeIndex);
  });
}

function _pickItem(index, inputEl) {
  const item = _items[index];
  if (!item) return;

  // Slash command: "/review" opens the editor immediately; others fill the input
  // so the user can add args / hit Enter.
  if (item.type === 'command') {
    _hide();
    if (item.name === '/review' && typeof window !== 'undefined' &&
        typeof window.__editflowOpenReview === 'function') {
      inputEl.value = '';
      window.__editflowOpenReview();
      return;
    }
    inputEl.value = item.name + ' ';
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
    inputEl.focus();
    return;
  }

  // Replace the @token in the input
  const text = inputEl.value;
  const pos = inputEl.selectionStart;
  const beforeCursor = text.substring(0, pos);
  const afterCursor = text.substring(pos);

  // Find the @mention start
  const atStart = beforeCursor.lastIndexOf('@');
  if (atStart >= 0) {
    const prefix = item.type === 'bin' ? '@bin:' : '@clip:';
    inputEl.value = text.substring(0, atStart) + prefix + item.name + ' ' + afterCursor;
    const newPos = atStart + prefix.length + item.name.length + 1;
    inputEl.setSelectionRange(newPos, newPos);
  }

  _hide();

  if (_onSelect) {
    _onSelect(item);
  }
}

function _hide() {
  if (_popupEl) {
    _popupEl.classList.add('hidden');
  }
  _activeIndex = -1;
  _items = [];
}

function _debounce(fn, ms) {
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(fn, ms);
}

function _esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _fmtDur(s) {
  if (!s) return '';
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export { attachAutocomplete };
