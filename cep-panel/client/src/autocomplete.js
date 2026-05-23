/**
 * autocomplete.js — @bin/@clip autocomplete popup for EditFlow input.
 *
 * Attaches to the chat textarea. When the user types @, queries
 * /api/v2/references/premiere-bins and /api/v2/assets/search
 * to suggest bins and clips.
 */
import { apiGet } from './api.js';

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

    // Find if cursor is inside an @mention
    const beforeCursor = text.substring(0, pos);
    const atMatch = beforeCursor.match(/@([^\s@]*)$/);

    if (atMatch) {
      const query = atMatch[1];
      _debounce(() => _fetchSuggestions(query), 150);
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

async function _fetchSuggestions(query) {
  try {
    const results = [];

    // Fetch bins
    try {
      const binsResp = await apiGet(`/api/v2/references/premiere-bins?limit=20`, { timeoutMs: 3000 });
      const bins = binsResp.bins || binsResp || [];
      for (const bin of bins) {
        if (!query || (bin.name && bin.name.toLowerCase().includes(query.toLowerCase()))) {
          results.push({
            type: 'bin',
            name: bin.name,
            detail: `${bin.item_count || bin.itemCount || '?'} clips`,
            binPath: bin.path || bin.binPath || '',
            icon: '&#128193;', // folder
          });
        }
      }
    } catch (_) { /* bins endpoint may not be available */ }

    // Fetch clips/assets
    if (query) {
      try {
        const clipsResp = await apiGet(`/api/v2/assets/search?q=${encodeURIComponent(query)}&limit=10`, { timeoutMs: 3000 });
        const clips = clipsResp.assets || clipsResp.results || clipsResp || [];
        for (const clip of clips) {
          results.push({
            type: 'clip',
            name: clip.name || clip.original_name || 'Unknown',
            detail: clip.duration ? `${_fmtDur(clip.duration)}` : '',
            mediaPath: clip.path || clip.media_path || '',
            icon: '&#127909;', // movie
          });
        }
      } catch (_) { /* clips endpoint may not be available */ }
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
