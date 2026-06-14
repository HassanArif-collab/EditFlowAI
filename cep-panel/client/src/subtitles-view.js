/**
 * subtitles-view.js — Subtitles & animated captions (Phase 0: cues + style +
 * live preview + SRT export; timeline placement arrives with Phases 1–3).
 *
 * Mirrors review-view.js: dynamic-imported by main.js with the BUILD_TAG
 * buster, exposed as window.__editflowOpenSubtitles, self-injects its CSS.
 * Opened from the Review editor ("Subtitles" button passes the LIVE words —
 * the panel's keep/cut flags only exist client-side until /build).
 */
import { apiGet, apiPost } from './api.js';
import { callExtendScript, isExtendScriptAvailable } from './extendscript.js';

const $ = (sel) => document.querySelector(sel);

const SV = {
  words: [],            // [{text,start,end,keep}] in SOURCE time
  sourceName: '',
  reviewId: null,
  source: 'all',        // 'all' | 'final_cut' (kept words remapped to output time)
  cues: [],
  opts: { max_words_per_cue: 7, word_mode: 'line' },
  style: { fontSize: 64, textColor: '#ffffff', bgColor: '#000000', bgOpacity: 0.6, position: 'bottom' },
  presets: [], presetId: 'pop',
  prevView: null, busy: false,
};

// ── Public ───────────────────────────────────────────────────
function openSubtitles(opts = {}) {
  _ensureStyles();
  const v = _ensureContainer();
  if (opts.words?.length) {
    SV.words = opts.words.map(w => ({ text: w.text, start: w.start, end: w.end, keep: w.keep !== false }));
    SV.sourceName = opts.sourceName || '';
    SV.reviewId = opts.reviewId || null;
    SV.cues = [];
  }
  const hero = $('#hero'), chat = $('#chat-scroll'), footer = $('#app-footer');
  SV.prevView = { hero: hero?.classList.contains('hidden') ?? true,
                  chat: chat?.classList.contains('hidden') ?? true,
                  footer: footer?.classList.contains('hidden') ?? true };
  hero?.classList.add('hidden'); chat?.classList.add('hidden'); footer?.classList.add('hidden');
  $('#review-view')?.classList.add('hidden');
  v.classList.remove('hidden');
  _render();
  if (!SV.presets.length) _loadPresets();
  if (SV.words.length && !SV.cues.length) _rebuild();
}

async function _loadPresets() {
  try {
    const r = await apiGet('/api/subtitles/presets', { timeoutMs: 8000 });
    SV.presets = r.presets || [];
    if (!SV.presets.find(p => p.id === SV.presetId)) SV.presetId = SV.presets[0]?.id || 'none';
    if (!$('#subtitles-view')?.classList.contains('hidden')) _render();
  } catch (_) { SV.presets = []; }
}
function closeSubtitles() {
  $('#subtitles-view')?.classList.add('hidden');
  const hero = $('#hero'), chat = $('#chat-scroll'), footer = $('#app-footer');
  if (SV.prevView) {
    hero?.classList.toggle('hidden', SV.prevView.hero);
    chat?.classList.toggle('hidden', SV.prevView.chat);
    footer?.classList.toggle('hidden', SV.prevView.footer);
  }
}

// ── Styles + container (review-view pattern: ?v= dodges CEF cache) ──
function _ensureStyles() {
  if (document.getElementById('sv-style-link')) return;
  const link = document.createElement('link');
  link.id = 'sv-style-link'; link.rel = 'stylesheet';
  link.href = 'styles/subtitles.css?v=' + Date.now();
  document.head.appendChild(link);
}
function _ensureContainer() {
  let v = $('#subtitles-view');
  if (!v) { v = document.createElement('div'); v.id = 'subtitles-view'; v.className = 'subtitles-view hidden'; ($('#app-main') || document.body).appendChild(v); }
  return v;
}

// ── Render ───────────────────────────────────────────────────
function _render() {
  const v = _ensureContainer();
  const st = SV.style;
  v.innerHTML = `
    <div class="sv-bar">
      <div class="sv-title">Subtitles</div>
      <span class="sv-dim">${_esc(SV.sourceName || (SV.words.length ? '' : 'open Review first, then click Subtitles'))}</span>
      <span class="sv-spacer"></span>
      <button class="sv-btn sv-ghost" data-act="close">Close</button>
    </div>
    <div class="sv-body">
      <div class="sv-left">
        <div class="sv-section">
          <div class="sv-subhead">Source</div>
          <label class="sv-row"><input type="radio" name="sv-src" value="all" ${SV.source === 'all' ? 'checked' : ''}/> All words (raw clip)</label>
          <label class="sv-row"><input type="radio" name="sv-src" value="final_cut" ${SV.source === 'final_cut' ? 'checked' : ''}/> Final cut (kept words, remapped)</label>
        </div>
        <div class="sv-section">
          <div class="sv-subhead">Cues</div>
          <label class="sv-row">Max words/cue <input id="sv-maxwords" class="sv-num" type="number" min="1" max="20" value="${SV.opts.max_words_per_cue}"/></label>
          <label class="sv-row">Mode
            <select id="sv-wordmode" class="sv-num">
              <option value="line" ${SV.opts.word_mode === 'line' ? 'selected' : ''}>Lines</option>
              <option value="word" ${SV.opts.word_mode === 'word' ? 'selected' : ''}>Word-by-word</option>
            </select></label>
          <button class="sv-btn sv-primary" data-act="rebuild">Build cues</button>
          <span id="sv-status" class="sv-status"></span>
        </div>
        <div class="sv-section sv-grow">
          <div class="sv-subhead">Cue list <span class="sv-dim">(${SV.cues.length})</span></div>
          <div id="sv-cues" class="sv-cues">${SV.cues.map((c, i) => `
            <div class="sv-cue">
              <span class="sv-cue-time">${_fmt(c.start)}–${_fmt(c.end)}</span>
              <textarea class="sv-cue-text" data-i="${i}" rows="1" spellcheck="false">${_esc(c.text)}</textarea>
            </div>`).join('')}</div>
        </div>
      </div>
      <div class="sv-right">
        <div class="sv-section">
          <div class="sv-subhead">Style <span class="sv-dim">— live preview</span></div>
          <label class="sv-row">Size <input id="sv-size" type="range" min="24" max="120" value="${st.fontSize}"/></label>
          <label class="sv-row">Text <input id="sv-color" type="color" value="${st.textColor}"/></label>
          <label class="sv-row">Box <input id="sv-bg" type="color" value="${st.bgColor}"/>
            <input id="sv-bgop" type="range" min="0" max="100" value="${Math.round(st.bgOpacity * 100)}"/></label>
          <label class="sv-row">Position
            <select id="sv-pos" class="sv-num">
              <option value="bottom" ${st.position === 'bottom' ? 'selected' : ''}>Bottom</option>
              <option value="middle" ${st.position === 'middle' ? 'selected' : ''}>Middle</option>
              <option value="top" ${st.position === 'top' ? 'selected' : ''}>Top</option>
            </select></label>
        </div>
        <div class="sv-frame"><div id="sv-caption" class="sv-caption"></div></div>
        <div class="sv-section">
          <div class="sv-subhead">Animation <span class="sv-dim">— built-in, no After Effects</span></div>
          <label class="sv-row">Preset
            <select id="sv-preset" class="sv-num">${SV.presets.map(p => `<option value="${p.id}" ${p.id === SV.presetId ? 'selected' : ''}>${_esc(p.label)}</option>`).join('') || '<option>(loading…)</option>'}</select>
          </label>
          <button class="sv-btn sv-primary" data-act="place">Add animated subtitles to timeline</button>
          <div id="sv-place-status" class="sv-status"></div>
        </div>
        <div class="sv-section">
          <button class="sv-btn" data-act="srt">Export SRT</button>
          <button class="sv-btn" data-act="copy">Copy SRT text</button>
          <div id="sv-export-status" class="sv-status"></div>
        </div>
      </div>
    </div>`;

  v.querySelector('[data-act="close"]').onclick = closeSubtitles;
  v.querySelector('[data-act="rebuild"]').onclick = _rebuild;
  v.querySelector('[data-act="srt"]').onclick = () => _exportSrt(false);
  v.querySelector('[data-act="copy"]').onclick = () => _exportSrt(true);
  const presetSel = v.querySelector('#sv-preset'); if (presetSel) presetSel.onchange = (e) => { SV.presetId = e.target.value; };
  v.querySelector('[data-act="place"]').onclick = _place;
  v.querySelectorAll('input[name="sv-src"]').forEach(r => r.onchange = () => { SV.source = r.value; _rebuild(); });
  v.querySelector('#sv-maxwords').onchange = (e) => { SV.opts.max_words_per_cue = Math.max(1, +e.target.value || 7); };
  v.querySelector('#sv-wordmode').onchange = (e) => { SV.opts.word_mode = e.target.value; };
  v.querySelectorAll('.sv-cue-text').forEach(t => t.oninput = () => { SV.cues[+t.dataset.i].text = t.value; _preview(); });
  ['sv-size', 'sv-color', 'sv-bg', 'sv-bgop', 'sv-pos'].forEach(id => {
    const el = v.querySelector('#' + id); if (el) el.oninput = _applyStyleInputs;
  });
  _preview();
}

function _applyStyleInputs() {
  SV.style.fontSize = +($('#sv-size')?.value || 64);
  SV.style.textColor = $('#sv-color')?.value || '#ffffff';
  SV.style.bgColor = $('#sv-bg')?.value || '#000000';
  SV.style.bgOpacity = (+($('#sv-bgop')?.value || 60)) / 100;
  SV.style.position = $('#sv-pos')?.value || 'bottom';
  _preview();
}

function _preview() {
  const cap = $('#sv-caption'); if (!cap) return;
  const st = SV.style;
  const sample = SV.cues[0]?.text || 'Subtitle preview';
  cap.textContent = sample;
  // Preview frame is 1/4-ish of 1080p — scale font to match.
  const frameH = cap.parentElement?.clientHeight || 180;
  cap.style.fontSize = (st.fontSize * (frameH / 1080)) + 'px';
  cap.style.color = st.textColor;
  cap.style.background = _rgba(st.bgColor, st.bgOpacity);
  cap.style.alignSelf = st.position === 'top' ? 'flex-start' : st.position === 'middle' ? 'center' : 'flex-end';
}

// ── Actions ──────────────────────────────────────────────────
async function _rebuild() {
  const status = $('#sv-status');
  if (!SV.words.length) { _set(status, 'No words — open Review, transcribe, then click Subtitles.', true); return; }
  _set(status, 'Building cues…');
  try {
    const final = SV.source === 'final_cut';
    const words = final ? SV.words : SV.words.map(w => ({ ...w, keep: true }));
    const resp = await apiPost('/api/subtitles/cues',
      { words, source: final ? 'final_cut' : 'standalone', opts: SV.opts },
      { timeoutMs: 30000 });
    SV.cues = resp.cues || [];
    _render();
    _set($('#sv-status'), `${resp.summary?.cues ?? SV.cues.length} cues from ${resp.summary?.words ?? 0} words.`);
  } catch (e) { _set(status, 'Build failed: ' + (e.message || e), true); }
}

async function _exportSrt(copyOnly) {
  const status = $('#sv-export-status');
  if (!SV.cues.length) { _set(status, 'Build cues first.', true); return; }
  try {
    const resp = await apiPost('/api/subtitles/srt',
      { cues: SV.cues, name: SV.sourceName || 'subtitles' }, { timeoutMs: 15000 });
    if (copyOnly) {
      await navigator.clipboard.writeText(resp.srt || '');
      _set(status, 'SRT copied to clipboard.');
    } else {
      _set(status, resp.srt_path ? `Saved: ${resp.srt_path}` : 'Saved (path unavailable — use Copy).');
    }
  } catch (e) { _set(status, 'Export failed: ' + (e.message || e), true); }
}

async function _place() {
  const status = $('#sv-place-status');
  if (!isExtendScriptAvailable()) { _set(status, 'Open this inside Premiere to place captions on the timeline.', true); return; }
  const preset = SV.presets.find(p => p.id === SV.presetId) || { animation: 'none', wordMode: 'line' };
  // Cues must match the preset's word mode (word-by-word = one cue per word).
  if ((preset.wordMode || 'line') !== SV.opts.word_mode) {
    SV.opts.word_mode = preset.wordMode || 'line';
    await _rebuild();
  }
  if (!SV.cues.length) { _set(status, 'Build cues first.', true); return; }
  let root = '';
  try { const cs = new CSInterface(); root = cs.getSystemPath((cs.SYSTEM_PATH && cs.SYSTEM_PATH.EXTENSION) || 'extension'); } catch (_) {}
  let baseMogrtPath = root ? root + '/templates/subtitles/base_text.mogrt' : '';
  // Windows: importMGT needs an OS-native (backslash) path; getSystemPath returns forward slashes.
  if (/^[A-Za-z]:/.test(baseMogrtPath)) baseMogrtPath = baseMogrtPath.replace(/\//g, '\\');
  // Add a fresh empty video track on top so captions never overwrite the edit,
  // then target it explicitly (0-based index = old track count).
  let trackIndex;
  try {
    const vs = await callExtendScript('getSequenceVideoSettings');
    const n = (vs && vs.videoTracks) ? vs.videoTracks : 0;
    if (n > 0) { await callExtendScript('manageTracks', { action: 'add', videoCount: n + 1 }); trackIndex = n; }
  } catch (_) {}
  _set(status, `Placing ${SV.cues.length} caption clips…`);
  try {
    const payload = { baseMogrtPath, cues: SV.cues, style: SV.style, animation: preset.animation };
    if (trackIndex !== undefined) payload.trackIndex = trackIndex;
    const res = await callExtendScript('placeSubtitleClips', payload);
    if (res && res.success) {
      const errs = (res.errors || []);
      _set(status, `Placed ${res.placed}/${res.total} clips.` + (errs.length ? ` Issues: ${errs.join(' | ')}` : ''), errs.length > 0);
    } else {
      _set(status, 'Placement failed: ' + ((res && res.error) || 'unknown'), true);
    }
  } catch (e) { _set(status, 'Placement failed: ' + (e.message || e), true); }
}

// ── Tiny utils ───────────────────────────────────────────────
function _set(el, msg, isErr) { if (el) { el.textContent = msg || ''; el.classList.toggle('sv-err', !!isErr); } }
function _fmt(s) { const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; }
function _esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function _rgba(hex, a) {
  const h = (hex || '#000000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export { openSubtitles, closeSubtitles };
