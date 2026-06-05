/**
 * review-view.js — Word-level transcript editor ("Review" panel, v2).
 *
 * WHY THIS EXISTS
 * ---------------
 * Sentence-level keep/cut is the wrong unit: one transcript cue mixes a false
 * start AND the clean line. So the editing unit is the WORD. You read a flowing
 * transcript, a karaoke highlight follows playback, you click a word to jump
 * there, you select a span and Cut/Restore it, and you preview "Play plan" (kept
 * words only) before building. The human is in control; the AI only proposes.
 *
 * Phase 1 (this file): word doc + waveform on APPROXIMATE word times (interpolated
 * server-side from the SRT). Phase 3 swaps in ElevenLabs Scribe's exact per-word
 * times — no UI change, the words just get accurate timestamps.
 *
 * Fully additive & self-contained. Opening Review hides the chat shell and shows
 * #review-view; closing restores it. A failure here never corrupts chat state.
 *
 * Backend (backend/routes/review.py):
 *   POST /api/review/ingest    → { review_id, words[], media_url, word_summary, … }
 *   GET  /api/review/media/{id}    range-streamed mp4 proxy (seekable)
 *   GET  /api/review/waveform/{id} → { peaks[], duration }
 *   POST /api/review/suggest   → { words[] with keep, word_summary }
 *   POST /api/review/build     → { plan_id }   (then existing /edit apply)
 */
import { apiGet, apiPost, getBaseUrl } from './api.js';
import { callExtendScript, isExtendScriptAvailable } from './extendscript.js';
import { getState } from './state.js';

const $ = (sel) => document.querySelector(sel);
const BUST = 'rv2';  // bump with BUILD_TAG-style changes to force CSS refetch

// ── Module state ─────────────────────────────────────────────
const S = {
  reviewId: null,
  words: [],            // [{id,text,start,end,segment_id,keep,reason}]
  byId: new Map(),
  mediaUrl: null,
  sourceName: '',
  sourcePath: '',
  script: '',
  duration: 0,
  peaks: [],
  modelName: '',        // active LLM, for the "Use AI (…)" label
  video: null,
  canvas: null,
  playMode: 'idle',     // 'original' | 'plan' | 'idle'
  planRanges: [],       // [[start,end], …] kept spans for Play-plan
  planIdx: 0,
  // selection (word ids, inclusive); -1 = none
  selLo: -1,
  selHi: -1,
  anchor: -1,
  dragging: false,
  focusId: null,
  undo: [],
  redo: [],
  busy: false,
  prevView: null,
};

let _keysBound = false;
let _rafSel = 0;

// ── Public API ───────────────────────────────────────────────

function openReview(opts = {}) {
  _ensureStyles();
  const view = _ensureContainer();
  const hero = $('#hero'), chat = $('#chat-scroll'), footer = $('#app-footer');
  S.prevView = {
    hero: hero ? hero.classList.contains('hidden') : true,
    chat: chat ? chat.classList.contains('hidden') : true,
    footer: footer ? footer.classList.contains('hidden') : true,
  };
  if (hero) hero.classList.add('hidden');
  if (chat) chat.classList.add('hidden');
  if (footer) footer.classList.add('hidden');
  view.classList.remove('hidden');

  if (S.reviewId && S.words.length) _renderEditor();
  else _renderSetup(opts);
  _bindKeys();
}

function closeReview() {
  const view = $('#review-view');
  if (view) view.classList.add('hidden');
  try { if (S.video) S.video.pause(); } catch (_) {}
  S.playMode = 'idle';
  const hero = $('#hero'), chat = $('#chat-scroll'), footer = $('#app-footer');
  if (S.prevView) {
    if (hero) hero.classList.toggle('hidden', S.prevView.hero);
    if (chat) chat.classList.toggle('hidden', S.prevView.chat);
    if (footer) footer.classList.toggle('hidden', S.prevView.footer);
  }
}

// ── Stylesheet (cache-proof) + container ─────────────────────

function _ensureStyles() {
  if (document.getElementById('rv-style-link')) return;
  const link = document.createElement('link');
  link.id = 'rv-style-link';
  link.rel = 'stylesheet';
  link.href = 'styles/review.css?v=' + Date.now();
  document.head.appendChild(link);
}

function _ensureContainer() {
  let view = $('#review-view');
  if (!view) {
    view = document.createElement('div');
    view.id = 'review-view';
    view.className = 'review-view hidden';
    ($('#app-main') || document.body).appendChild(view);
  }
  return view;
}

// ── Setup screen ─────────────────────────────────────────────

function _renderSetup(opts = {}) {
  const view = _ensureContainer();
  const src = opts.sourceFile || _guessSourceFromScan() || '';
  view.innerHTML = `
    <div class="rv-bar">
      <div class="rv-title">Review &amp; Cut</div>
      <button class="rv-btn rv-ghost" data-act="close">Close</button>
    </div>
    <div class="rv-setup">
      <p class="rv-hint">Pick a clip, then <b>transcribe with Scribe</b> (no pasting, exact word
         timing) — or paste a transcript. Then edit by word: play, select, cut.</p>
      <label class="rv-label">Source clip <span class="rv-dim">(filename if you scanned, or full path)</span></label>
      <input id="rv-source" class="rv-input" type="text" placeholder="IMG_1694.MOV" value="${_esc(src)}" spellcheck="false" />

      <div class="rv-scribe">
        <div class="rv-subhead">Transcribe with ElevenLabs Scribe <span class="rv-dim">— recommended</span></div>
        <div id="rv-scribe-key" class="rv-keyrow"></div>
        <div class="rv-actions">
          <button class="rv-btn rv-primary" data-act="transcribe">Transcribe with Scribe</button>
          <span id="rv-scribe-status" class="rv-status"></span>
        </div>
      </div>

      <div class="rv-or">— or paste a transcript —</div>
      <textarea id="rv-transcript" class="rv-textarea" placeholder="Paste a Scribe SRT or Gemini JSON…" spellcheck="false"></textarea>
      <label class="rv-label">Script <span class="rv-dim">(optional — helps the AI flag off-script lines)</span></label>
      <textarea id="rv-script" class="rv-textarea rv-textarea-short" placeholder="Paste your script (any language)..." spellcheck="false"></textarea>
      <div class="rv-actions">
        <button class="rv-btn" data-act="load">Load pasted transcript</button>
        <span id="rv-setup-status" class="rv-status"></span>
      </div>
    </div>`;
  view.querySelector('[data-act="close"]').onclick = closeReview;
  view.querySelector('[data-act="load"]').onclick = _loadTranscript;
  view.querySelector('[data-act="transcribe"]').onclick = _transcribeScribe;
  const ta = view.querySelector('#rv-transcript');
  if (ta && opts.transcript) ta.value = opts.transcript;
  S._scribePending = false;
  _refreshScribe();
}

async function _applyReviewResp(resp, script) {
  S.reviewId = resp.review_id;
  _setWords(resp.words || []);
  S.mediaUrl = resp.media_url ? getBaseUrl() + resp.media_url : null;
  S.sourceName = resp.source_name || '';
  S.sourcePath = resp.source_path || '';
  S.script = script || '';
  S.duration = resp.duration || 0;
  S.undo = []; S.redo = [];
  S.modelName = await _fetchModelName();
  _renderEditor(resp.media_error);
  _loadWaveform();
}

async function _loadTranscript() {
  const source = ($('#rv-source')?.value || '').trim();
  const transcript = ($('#rv-transcript')?.value || '').trim();
  const script = ($('#rv-script')?.value || '').trim();
  const status = $('#rv-setup-status');
  if (!transcript) { _setStatus(status, 'Paste a transcript first (or use Scribe above).', true); return; }
  _setStatus(status, 'Preparing preview & splitting into words… (first time can take a moment)');
  try {
    const resp = await apiPost('/api/review/ingest', {
      transcript_text: transcript, source_file: source || null, script, fmt: 'auto', tighten: true,
    }, { timeoutMs: 1800000 });
    await _applyReviewResp(resp, script);
  } catch (err) {
    _setStatus(status, `Couldn't load: ${err.message || err}`, true);
  }
}

// ── Scribe (no-pasting) path ─────────────────────────────────

async function _refreshScribe() {
  const row = $('#rv-scribe-key');
  if (!row) return;
  let has = false;
  try { const st = await apiGet('/api/review/scribe/status', { timeoutMs: 4000 }); has = !!st.has_key; } catch (_) {}
  if (has) {
    row.innerHTML = `<span class="rv-dim">✓ API key saved.</span> <button class="rv-btn rv-ghost rv-tiny" data-act="changekey">change</button>`;
    row.querySelector('[data-act="changekey"]').onclick = () => _showKeyInput(row);
  } else {
    _showKeyInput(row);
  }
}

function _showKeyInput(row) {
  row.innerHTML = `<input id="rv-scribe-keyinput" class="rv-input" type="password" placeholder="Paste your ElevenLabs API key" spellcheck="false" />
    <button class="rv-btn rv-tiny" data-act="savekey">Save key</button>`;
  row.querySelector('[data-act="savekey"]').onclick = async () => {
    const key = ($('#rv-scribe-keyinput')?.value || '').trim();
    if (!key) return;
    try { await apiPost('/api/review/scribe/key', { key }, { timeoutMs: 5000 }); _refreshScribe(); }
    catch (e) { _setStatus($('#rv-scribe-status'), 'Could not save key: ' + (e.message || e), true); }
  };
}

async function _transcribeScribe() {
  const source = ($('#rv-source')?.value || '').trim();
  const status = $('#rv-scribe-status');
  const btn = document.querySelector('[data-act="transcribe"]');
  if (!source) { _setStatus(status, 'Enter the source clip first.', true); return; }

  if (!S._scribePending) {     // step 1 — estimate + ask to confirm
    try {
      const est = await apiPost('/api/review/scribe/estimate', { source_file: source }, { timeoutMs: 15000 });
      if (!est.has_key) { _setStatus(status, 'Add your ElevenLabs API key above first.', true); return; }
      S._scribePending = true;
      if (btn) btn.textContent = `Confirm — transcribe (~$${(est.usd || 0).toFixed(2)})`;
      _setStatus(status, `Scribe will transcribe ${est.source_name} (~${est.minutes} min ≈ $${(est.usd || 0).toFixed(2)}). Click again to confirm.`);
    } catch (e) { _setStatus(status, 'Estimate failed: ' + (e.message || e), true); }
    return;
  }

  S._scribePending = false;    // step 2 — run it
  if (btn) { btn.textContent = 'Transcribing with Scribe…'; btn.disabled = true; }
  _setStatus(status, 'Transcribing with Scribe (and preparing preview)…');
  try {
    const script = ($('#rv-script')?.value || '').trim();
    const resp = await apiPost('/api/review/transcribe', { source_file: source, script, language_code: 'ur' }, { timeoutMs: 1800000 });
    await _applyReviewResp(resp, script);
  } catch (e) {
    _setStatus(status, 'Scribe failed: ' + (e.message || e), true);
    if (btn) { btn.textContent = 'Transcribe with Scribe'; btn.disabled = false; }
  }
}

function _setWords(arr) {
  S.words = arr.map(w => ({ ...w, keep: w.keep !== false }));
  S.byId = new Map(S.words.map(w => [w.id, w]));
}

// ── Editor ───────────────────────────────────────────────────

function _renderEditor(mediaError) {
  const view = _ensureContainer();
  const modelLabel = S.modelName ? `Use AI (${_esc(S.modelName)})` : 'Use AI';
  view.innerHTML = `
    <div class="rv-bar">
      <div class="rv-title">Review &amp; Cut <span class="rv-dim">— ${_esc(S.sourceName)}</span></div>
      <button class="rv-btn rv-ghost" data-act="reload">New transcript</button>
      <button class="rv-btn rv-ghost" data-act="close">Close</button>
    </div>
    <div class="rv-player">
      ${S.mediaUrl
        ? `<video id="rv-video" preload="auto" playsinline></video>`
        : `<div class="rv-novideo">No video preview${mediaError ? ' — ' + _esc(mediaError) : ''}.<br>You can still edit the words and build the cut.</div>`}
    </div>
    <canvas id="rv-wave" class="rv-wave" height="56"></canvas>
    <div class="rv-toolbar">
      <button class="rv-btn" data-act="playorig" title="Space">▶ Original</button>
      <button class="rv-btn rv-primary-ghost" data-act="playplan" title="Enter">▶ Play plan</button>
      <span class="rv-sep"></span>
      <button class="rv-btn" data-act="cut" title="Backspace">Cut</button>
      <button class="rv-btn" data-act="restore" title="R">Restore</button>
      <button class="rv-btn rv-ghost" data-act="undo" title="Ctrl+Z">↺</button>
      <button class="rv-btn rv-ghost" data-act="redo" title="Ctrl+Y">↻</button>
      <span class="rv-sep"></span>
      <label class="rv-check"><input type="checkbox" id="rv-usellm" checked /> ${modelLabel}</label>
      <button class="rv-btn" data-act="suggest">Suggest</button>
      <span class="rv-spacer"></span>
      <span id="rv-readout" class="rv-final"></span>
      <button class="rv-btn rv-primary" data-act="build">Build</button>
    </div>
    <div id="rv-status" class="rv-status"></div>
    <div class="rv-quick">
      <span class="rv-dim">Quick cuts:</span>
      <button class="rv-chip" data-quick="filler">fillers</button>
      <button class="rv-chip" data-quick="nonspeech">[non-speech]</button>
      <button class="rv-chip" data-quick="restoreall">restore all</button>
    </div>
    <div id="rv-doc" class="rv-doc"></div>`;

  const on = (sel, fn) => { const el = view.querySelector(sel); if (el) el.onclick = fn; };
  on('[data-act="close"]', closeReview);
  on('[data-act="reload"]', () => { S.reviewId = null; S.words = []; _renderSetup({}); });
  on('[data-act="playorig"]', _playOriginal);
  on('[data-act="playplan"]', _playPlan);
  on('[data-act="cut"]', () => _applyToSelection(false));
  on('[data-act="restore"]', () => _applyToSelection(true));
  on('[data-act="undo"]', _undo);
  on('[data-act="redo"]', _redo);
  on('[data-act="suggest"]', _suggest);
  on('[data-act="build"]', _build);
  view.querySelectorAll('[data-quick]').forEach(b => {
    b.onclick = () => _quickCut(b.dataset.quick);
  });

  S.video = view.querySelector('#rv-video');
  if (S.video) {
    S.video.src = S.mediaUrl;
    S.video.ontimeupdate = _onTime;
    S.video.onseeked = _onTime;
  }
  S.canvas = view.querySelector('#rv-wave');
  _bindWaveform();
  _renderWords();
  _bindDocEvents();
  _updateReadout();
}

function _renderWords() {
  const doc = $('#rv-doc');
  if (!doc) return;
  let html = '';
  let curSeg = -1;
  for (const w of S.words) {
    if (w.segment_id !== curSeg) {
      if (curSeg !== -1) html += '</p>';
      html += '<p class="rv-para">';
      curSeg = w.segment_id;
    }
    const cls = ['rv-w', w.keep ? '' : 'rv-w-cut',
      (w.id >= S.selLo && w.id <= S.selHi && S.selLo >= 0) ? 'rv-w-sel' : ''].join(' ').trim();
    const title = (!w.keep && w.reason) ? ` title="${_esc(_reason(w.reason))}"` : '';
    html += `<span class="${cls}" data-id="${w.id}"${title}>${_esc(w.text)}</span> `;
  }
  if (curSeg !== -1) html += '</p>';
  doc.innerHTML = html || '<p class="rv-dim" style="padding:12px">No words.</p>';
}

// ── Selection + mouse ────────────────────────────────────────

function _bindDocEvents() {
  const doc = $('#rv-doc');
  if (!doc) return;
  doc.onmousedown = (e) => {
    const id = _wordIdAt(e.target);
    if (id == null) return;
    S.dragging = true; S.anchor = id; S.selLo = id; S.selHi = id; S.focusId = id;
    S.movedDuringDrag = false;
    _applySelClasses();
  };
  doc.onmousemove = (e) => {
    if (!S.dragging) return;
    const id = _wordIdAt(e.target);
    if (id == null) return;
    if (id !== S.anchor) S.movedDuringDrag = true;
    S.selLo = Math.min(S.anchor, id);
    S.selHi = Math.max(S.anchor, id);
    if (!_rafSel) _rafSel = requestAnimationFrame(() => { _rafSel = 0; _applySelClasses(); });
  };
  doc.onmouseup = (e) => {
    if (!S.dragging) return;
    S.dragging = false;
    const id = _wordIdAt(e.target);
    if (!S.movedDuringDrag && id != null) {
      // a plain click → seek + play that word; selection collapses to it
      S.selLo = S.selHi = -1;
      _applySelClasses();
      _seekWord(id, true);
    }
  };
  doc.ondblclick = (e) => {
    const id = _wordIdAt(e.target);
    if (id == null) return;
    const w = S.byId.get(id);
    if (!w) return;
    _snapshot();
    w.keep = !w.keep;
    if (w.keep) w.reason = '';
    _afterMutate();
  };
}

function _wordIdAt(target) {
  const el = target && target.closest ? target.closest('.rv-w') : null;
  if (!el) return null;
  const id = Number(el.dataset.id);
  return Number.isNaN(id) ? null : id;
}

function _applySelClasses() {
  const doc = $('#rv-doc');
  if (!doc) return;
  doc.querySelectorAll('.rv-w').forEach(el => {
    const id = Number(el.dataset.id);
    el.classList.toggle('rv-w-sel', S.selLo >= 0 && id >= S.selLo && id <= S.selHi);
  });
}

function _applyToSelection(keep) {
  let lo = S.selLo, hi = S.selHi;
  if (lo < 0) {                       // no range → act on focused word
    if (S.focusId == null) { _setStatus($('#rv-status'), 'Select some words first (drag across them).', true); return; }
    lo = hi = S.focusId;
  }
  _snapshot();
  for (const w of S.words) {
    if (w.id >= lo && w.id <= hi) {
      w.keep = keep;
      if (keep) w.reason = '';
      else if (!w.reason) w.reason = 'manual';
    }
  }
  _afterMutate();
}

// ── Cut/restore mutations ────────────────────────────────────

function _snapshot() {
  S.undo.push(S.words.map(w => (w.keep ? 1 : 0)));
  if (S.undo.length > 100) S.undo.shift();
  S.redo = [];
}

function _applySnapshot(snap) {
  snap.forEach((k, i) => { if (S.words[i]) S.words[i].keep = !!k; });
}

function _undo() {
  if (!S.undo.length) return;
  S.redo.push(S.words.map(w => (w.keep ? 1 : 0)));
  _applySnapshot(S.undo.pop());
  _afterMutate(true);
}

function _redo() {
  if (!S.redo.length) return;
  S.undo.push(S.words.map(w => (w.keep ? 1 : 0)));
  _applySnapshot(S.redo.pop());
  _afterMutate(true);
}

function _afterMutate(skipSnapshotReset) {
  _renderWords();
  _applySelClasses();
  _markNow();
  _updateReadout();
  _drawWaveform();
}

function _quickCut(kind) {
  _snapshot();
  if (kind === 'restoreall') {
    S.words.forEach(w => { w.keep = true; w.reason = ''; });
  } else {
    const fillers = new Set(['umm', 'um', 'uh', 'uhh', 'ah', 'hmm', 'haan', 'han', 'ji', 'ہاں', 'جی', 'اہ', 'ام']);
    for (const w of S.words) {
      const t = (w.text || '').replace(/[^\w؀-ۿ]/g, '').toLowerCase();
      if (kind === 'filler' && fillers.has(t)) { w.keep = false; w.reason = 'filler'; }
      if (kind === 'nonspeech' && /^[\[(\{].*[\])\}]$/.test((w.text || '').trim())) { w.keep = false; w.reason = 'non_speech'; }
    }
  }
  _afterMutate();
}

// ── Playback + karaoke ───────────────────────────────────────

function _seekWord(id, play) {
  const w = S.byId.get(id);
  if (!w || !S.video) return;
  S.playMode = 'original';
  S.focusId = id;
  try { S.video.currentTime = w.start; if (play) S.video.play(); } catch (_) {}
  _markNow(id);
}

function _playOriginal() {
  if (!S.video) return;
  if (S.video.paused) { S.playMode = 'original'; S.video.play(); }
  else { S.video.pause(); S.playMode = 'idle'; }
}

function _mergedKeptRanges(maxGap = 0.35) {
  const ranges = [];
  let cur = null;
  for (const w of S.words) {
    if (!w.keep) continue;
    if (cur && w.start - cur[1] <= maxGap) cur[1] = w.end;
    else { if (cur) ranges.push(cur); cur = [w.start, w.end]; }
  }
  if (cur) ranges.push(cur);
  return ranges;
}

function _playPlan() {
  if (!S.video) return;
  S.planRanges = _mergedKeptRanges();
  if (!S.planRanges.length) { _setStatus($('#rv-status'), 'Nothing kept to play.', true); return; }
  S.planIdx = 0;
  S.playMode = 'plan';
  try { S.video.currentTime = S.planRanges[0][0]; S.video.play(); } catch (_) {}
}

function _onTime() {
  if (!S.video) return;
  const t = S.video.currentTime;
  // plan playback: hop across cut gaps
  if (S.playMode === 'plan') {
    const r = S.planRanges[S.planIdx];
    if (r && t >= r[1] - 0.02) {
      S.planIdx += 1;
      if (S.planIdx < S.planRanges.length) {
        try { S.video.currentTime = S.planRanges[S.planIdx][0]; } catch (_) {}
      } else { try { S.video.pause(); } catch (_) {} S.playMode = 'idle'; }
    }
  }
  _markNow();
  _drawPlayhead();
}

function _currentWordId(t) {
  // binary search words by start; return the word whose [start,end] holds t,
  // else the latest word that has started.
  const a = S.words;
  if (!a.length) return null;
  let lo = 0, hi = a.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid].start <= t) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return a[ans] ? a[ans].id : null;
}

let _lastNow = null;
function _markNow(forceId) {
  const id = forceId != null ? forceId : (S.video ? _currentWordId(S.video.currentTime) : null);
  if (id === _lastNow && forceId == null) return;
  const doc = $('#rv-doc');
  if (!doc) return;
  if (_lastNow != null) {
    const prev = doc.querySelector(`.rv-w[data-id="${_lastNow}"]`);
    if (prev) prev.classList.remove('rv-w-now');
  }
  _lastNow = id;
  if (id == null) return;
  const el = doc.querySelector(`.rv-w[data-id="${id}"]`);
  if (el) {
    el.classList.add('rv-w-now');
    if (S.playMode !== 'idle') el.scrollIntoView({ block: 'nearest' });
  }
}

// ── Waveform ─────────────────────────────────────────────────

async function _loadWaveform() {
  if (!S.reviewId) return;
  try {
    const resp = await apiGet(`/api/review/waveform/${S.reviewId}`, { timeoutMs: 120000 });
    S.peaks = resp.peaks || [];
    if (resp.duration) S.duration = resp.duration;
    _drawWaveform();
  } catch (_) { /* waveform is optional */ }
}

function _bindWaveform() {
  const c = S.canvas;
  if (!c) return;
  c.onclick = (e) => {
    if (!S.video || !S.duration) return;
    const rect = c.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    try { S.video.currentTime = Math.max(0, Math.min(S.duration, frac * S.duration)); } catch (_) {}
    _onTime();
  };
  // size canvas to its CSS width
  requestAnimationFrame(() => { _sizeCanvas(); _drawWaveform(); });
  window.addEventListener('resize', () => { _sizeCanvas(); _drawWaveform(); });
}

function _sizeCanvas() {
  const c = S.canvas;
  if (!c) return;
  const w = c.clientWidth || 360;
  if (c.width !== w) c.width = w;
}

function _cssVar(name, fallback) {
  try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; }
  catch (_) { return fallback; }
}

function _drawWaveform() {
  const c = S.canvas;
  if (!c) return;
  _sizeCanvas();
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  if (!S.peaks.length || !S.duration) return;

  const keep = _cssVar('--accent', '#0078d4');
  const cut = _cssVar('--error', '#f44747');
  const mid = H / 2;
  const cutRanges = _cutRanges();
  for (let x = 0; x < W; x++) {
    const t = (x / W) * S.duration;
    const pi = Math.floor((x / W) * S.peaks.length);
    const amp = (S.peaks[pi] || 0) * (mid - 2);
    ctx.strokeStyle = _inRanges(t, cutRanges) ? cut : keep;
    ctx.globalAlpha = _inRanges(t, cutRanges) ? 0.35 : 0.9;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, mid - amp);
    ctx.lineTo(x + 0.5, mid + amp);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  _drawPlayhead();
}

function _cutRanges() {
  const ranges = [];
  let cur = null;
  for (const w of S.words) {
    if (w.keep) { if (cur) { ranges.push(cur); cur = null; } continue; }
    if (cur && w.start - cur[1] <= 0.05) cur[1] = w.end;
    else { if (cur) ranges.push(cur); cur = [w.start, w.end]; }
  }
  if (cur) ranges.push(cur);
  return ranges;
}

function _inRanges(t, ranges) {
  for (const [a, b] of ranges) { if (t >= a && t <= b) return true; if (a > t) break; }
  return false;
}

function _drawPlayhead() {
  const c = S.canvas;
  if (!c || !S.video || !S.duration) return;
  // redraw is cheap; only the playhead line is added on top each tick via a 2nd pass
  const ctx = c.getContext('2d');
  const x = (S.video.currentTime / S.duration) * c.width;
  // (full redraw happens on cut changes; here we just overlay a line by
  //  re-stroking — acceptable because the bars beneath are static per frame)
  ctx.save();
  ctx.strokeStyle = _cssVar('--text-bright', '#e0e0e0');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 0.5, 0);
  ctx.lineTo(x + 0.5, c.height);
  ctx.stroke();
  ctx.restore();
}

// ── Suggest (AI) + Build ─────────────────────────────────────

async function _suggest() {
  if (!S.reviewId || S.busy) return;
  const useLlm = !!$('#rv-usellm')?.checked;
  const status = $('#rv-status');
  S.busy = true;
  _snapshot();
  _setStatus(status, useLlm ? 'Marking junk + asking the model about off-script lines…' : 'Marking junk (retakes, filler, non-speech)…');
  try {
    const resp = await apiPost('/api/review/suggest', { review_id: S.reviewId, use_llm: useLlm }, { timeoutMs: 300000 });
    if (resp.words) _setWords(resp.words);
    _afterMutate();
    const su = resp.word_summary || {};
    _setStatus(status, `Suggested: keep ${su.kept_words ?? '?'} words in ${su.cuts ?? '?'} span(s)${resp.llm_used ? ' (AI refined)' : ''}. Refine by selecting words, then Build.`);
  } catch (err) {
    _setStatus(status, `Suggest failed: ${err.message || err}`, true);
  } finally { S.busy = false; }
}

async function _build() {
  if (!S.reviewId || S.busy) return;
  const status = $('#rv-status');
  const keptWordIds = S.words.filter(w => w.keep).map(w => w.id);
  if (!keptWordIds.length) { _setStatus(status, 'Nothing kept — keep some words first.', true); return; }
  S.busy = true;
  _setStatus(status, `Building a tight cut from ${_mergedKeptRanges().length} span(s)…`);
  try {
    const built = await apiPost('/api/review/build', { review_id: S.reviewId, kept_word_ids: keptWordIds }, { timeoutMs: 120000 });
    const planId = built.plan_id;
    if (!planId) throw new Error('No plan_id returned.');
    _setStatus(status, 'Placing clips in Premiere…');
    const applyResult = await apiPost(`/api/edit/plan/${planId}/apply`, {}, { timeoutMs: 120000 });
    const ops = applyResult.extendscript_ops || [];
    const seqName = applyResult.target_sequence_name || 'EditFlow Cut';
    if (isExtendScriptAvailable()) {
      await callExtendScript('processEDL', JSON.stringify({ ops }));
      _setStatus(status, `Done — "${seqName}" is in your project. A "New Sequence" preset dialog may ask you to click OK.`);
    } else {
      _setStatus(status, `Plan built (${ops.length} ops). Open the panel inside Premiere to place the clips.`);
    }
  } catch (err) {
    _setStatus(status, `Build failed: ${err.message || err}`, true);
  } finally { S.busy = false; }
}

function _updateReadout() {
  const el = $('#rv-readout');
  if (!el) return;
  const ranges = _mergedKeptRanges();
  const dur = ranges.reduce((s, r) => s + (r[1] - r[0]), 0);
  const kept = S.words.filter(w => w.keep).length;
  el.textContent = `${kept}/${S.words.length} words · ${ranges.length} cut${ranges.length === 1 ? '' : 's'} · ${_fmtDur(dur)}`;
}

// ── Keyboard ─────────────────────────────────────────────────

function _bindKeys() {
  if (_keysBound) return;
  _keysBound = true;
  document.addEventListener('keydown', (e) => {
    const view = $('#review-view');
    if (!view || view.classList.contains('hidden')) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const k = e.key;
    if (k === ' ') { e.preventDefault(); _playOriginal(); }
    else if (k === 'Enter') { e.preventDefault(); _playPlan(); }
    else if (k === 'Backspace' || k === 'Delete') { e.preventDefault(); _applyToSelection(false); }
    else if (k === 'r' || k === 'R') { e.preventDefault(); _applyToSelection(true); }
    else if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'Z') && !e.shiftKey) { e.preventDefault(); _undo(); }
    else if ((e.ctrlKey || e.metaKey) && (k === 'y' || k === 'Y' || ((k === 'z' || k === 'Z') && e.shiftKey))) { e.preventDefault(); _redo(); }
    else if (k === 'Escape') { S.selLo = S.selHi = -1; _applySelClasses(); }
  });
}

// ── Helpers ──────────────────────────────────────────────────

async function _fetchModelName() {
  try {
    const st = await apiGet('/api/status', { timeoutMs: 4000 });
    const m = st && st.active_chat;
    if (typeof m === 'string') return m;
    if (m && (m.model || m.name)) return m.model || m.name;
  } catch (_) {}
  return '';
}

function _guessSourceFromScan() {
  try {
    const scan = getState()?.session?.scan || null;
    const items = scan && (scan.items || scan.clips);
    if (Array.isArray(items)) {
      const a = items.find(it => /\.(mov|mp4|m4v|wav|mp3|m4a|aac)$/i.test(it.mediaPath || it.media_path || ''));
      if (a) return a.mediaPath || a.media_path;
    }
  } catch (_) {}
  return '';
}

function _reason(r) {
  if (!r) return '';
  if (r.startsWith('retake')) return 'retake';
  return ({ non_speech: 'non-speech', filler: 'filler', too_short: 'too short',
    not_in_script: 'off-script', manual: 'cut', llm_off_script: 'off-script' })[r] || r;
}

function _setStatus(el, msg, isErr) { if (el) { el.textContent = msg; el.classList.toggle('rv-error', !!isErr); } }
function _fmtDur(s) { s = Number(s) || 0; const m = Math.floor(s / 60); const x = Math.round(s % 60); return `${m}:${x.toString().padStart(2, '0')}`; }
function _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

export { openReview, closeReview };
