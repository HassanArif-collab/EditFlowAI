/**
 * review-view.js — Transcript-first cut editor (the "Review" panel).
 *
 * WHY THIS EXISTS
 * ---------------
 * The legacy flow asks the user to trust an opaque list of cut timestamps that
 * only reveals its mistakes after it's on the Premiere timeline. Review flips
 * that: the transcript IS the editing surface. The user reads lines, plays any
 * line instantly in an in-panel video player, lets the AI mark obvious junk red,
 * toggles anything by hand, previews the kept-only cut, and only THEN builds the
 * sequence — using the existing, already-tested apply path.
 *
 * This module is fully self-contained and ADDITIVE. It never touches the
 * orchestrator/agent state machines; opening Review just hides the chat shell
 * and shows #review-view, and closing restores it. A failure here can't corrupt
 * the legacy session.
 *
 * Backend contract (see backend/routes/review.py):
 *   POST /api/review/ingest   {transcript_text, source_file, script, fmt, tighten}
 *                             → {review_id, segments[], media_url, ...}
 *   GET  /api/review/media/{id}   range-streamed mp4 proxy (so <video> can seek)
 *   POST /api/review/suggest  {review_id, use_llm} → {segments[], summary}
 *   POST /api/review/build    {review_id, kept_ids} → {plan_id}
 * Build then reuses the legacy apply: POST /api/edit/plan/{id}/apply → processEDL.
 */
import { apiGet, apiPost, getBaseUrl } from './api.js';
import { callExtendScript, isExtendScriptAvailable } from './extendscript.js';
import { getState } from './state.js';

const $ = (sel) => document.querySelector(sel);

// ── Module state ─────────────────────────────────────────────
const S = {
  reviewId: null,
  segments: [],
  mediaUrl: null,
  sourceName: '',
  sourcePath: '',
  script: '',
  video: null,
  playMode: 'idle',   // 'segment' | 'kept' | 'idle'
  playingId: null,
  focusedId: null,
  keptQueue: [],
  keptIndex: 0,
  prevView: null,     // {hero, chat, footer} display state to restore on close
  busy: false,
};

let _keydownBound = false;

// ── Public API ───────────────────────────────────────────────

/**
 * Open the Review panel. Hides the chat shell, shows #review-view. If a session
 * is already loaded, re-renders it; otherwise shows the load screen.
 * @param {object} [opts] - { transcript, sourceFile, script } to prefill.
 */
function openReview(opts = {}) {
  _ensureStyles();
  const view = _ensureContainer();
  // Remember + hide the current shell so Close can restore exactly.
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

  if (S.reviewId && S.segments.length) {
    _renderEditor();
  } else {
    _renderSetup(opts);
  }
  _bindKeyboard();
}

/** Close Review and restore the previous chat-shell view. */
function closeReview() {
  const view = $('#review-view');
  if (view) view.classList.add('hidden');
  try { if (S.video) S.video.pause(); } catch (_) { /* ignore */ }
  const hero = $('#hero'), chat = $('#chat-scroll'), footer = $('#app-footer');
  if (S.prevView) {
    if (hero) hero.classList.toggle('hidden', S.prevView.hero);
    if (chat) chat.classList.toggle('hidden', S.prevView.chat);
    if (footer) footer.classList.toggle('hidden', S.prevView.footer);
  }
}

// ── Container / screens ──────────────────────────────────────

function _ensureContainer() {
  let view = $('#review-view');
  if (!view) {
    view = document.createElement('div');
    view.id = 'review-view';
    view.className = 'review-view hidden';
    const main = $('#app-main') || document.body;
    main.appendChild(view);
  }
  return view;
}

/**
 * Guarantee review.css is loaded, immune to CEP's stylesheet cache.
 *
 * CEF caches assets by URL with no revalidation, so a plain
 * `<link href="styles/review.css">` can keep serving a stale *miss* (cached
 * from a load before the file existed). We inject our own <link> with a
 * cache-busting query the first time Review opens — a URL CEF has never seen,
 * so it always fetches the real file. Idempotent.
 */
function _ensureStyles() {
  if (document.getElementById('rv-style-link')) return;
  const link = document.createElement('link');
  link.id = 'rv-style-link';
  link.rel = 'stylesheet';
  // Date.now() → a URL CEF cannot have cached. Relative path resolves against
  // index.html (the extension junction), same as the static <link>.
  link.href = 'styles/review.css?v=' + Date.now();
  document.head.appendChild(link);
}

function _renderSetup(opts = {}) {
  const view = _ensureContainer();
  const src = opts.sourceFile || _guessSourceFromScan() || '';
  view.innerHTML = `
    <div class="rv-bar">
      <div class="rv-title">Review &amp; Cut</div>
      <button class="rv-btn rv-ghost" data-act="close">Close</button>
    </div>
    <div class="rv-setup">
      <p class="rv-hint">Paste a transcript (ElevenLabs Scribe <b>SRT</b> or Gemini JSON) for one clip.
         I'll show it, let you play any line, mark the junk, and build a tight cut.</p>
      <label class="rv-label">Source clip <span class="rv-dim">(filename if you scanned, or full path)</span></label>
      <input id="rv-source" class="rv-input" type="text" placeholder="IMG_1694.MOV" value="${_esc(src)}" spellcheck="false" />
      <label class="rv-label">Transcript</label>
      <textarea id="rv-transcript" class="rv-textarea" placeholder="1&#10;00:00:00,000 --> 00:00:02,500&#10;...paste your SRT here..." spellcheck="false"></textarea>
      <label class="rv-label">Script <span class="rv-dim">(optional — helps flag off-script lines)</span></label>
      <textarea id="rv-script" class="rv-textarea rv-textarea-short" placeholder="Paste your script (any language)..." spellcheck="false"></textarea>
      <div class="rv-actions">
        <button class="rv-btn rv-primary" data-act="load">Load transcript</button>
        <span id="rv-setup-status" class="rv-status"></span>
      </div>
    </div>`;
  view.querySelector('[data-act="close"]').onclick = closeReview;
  view.querySelector('[data-act="load"]').onclick = _loadTranscript;
  const ta = view.querySelector('#rv-transcript');
  if (ta && opts.transcript) ta.value = opts.transcript;
  if (ta) ta.focus();
}

async function _loadTranscript() {
  const source = ($('#rv-source')?.value || '').trim();
  const transcript = ($('#rv-transcript')?.value || '').trim();
  const script = ($('#rv-script')?.value || '').trim();
  const status = $('#rv-setup-status');

  if (!transcript) { _setStatus(status, 'Paste a transcript first.', true); return; }
  _setStatus(status, 'Preparing video preview & parsing transcript… (first time can take a moment)');

  try {
    const resp = await apiPost('/api/review/ingest', {
      transcript_text: transcript,
      source_file: source || null,
      script,
      fmt: 'auto',
      tighten: true,
    }, { timeoutMs: 1800000 });

    S.reviewId = resp.review_id;
    S.segments = resp.segments || [];
    S.mediaUrl = resp.media_url ? getBaseUrl() + resp.media_url : null;
    S.sourceName = resp.source_name || source;
    S.sourcePath = resp.source_path || '';
    S.script = script;
    S.focusedId = S.segments.length ? S.segments[0].id : null;

    if (resp.media_error) {
      console.warn('[review] media:', resp.media_error);
    }
    _renderEditor(resp.media_error);
  } catch (err) {
    _setStatus(status, `Couldn't load: ${err.message || err}`, true);
  }
}

// ── Editor ───────────────────────────────────────────────────

function _renderEditor(mediaError) {
  const view = _ensureContainer();
  view.innerHTML = `
    <div class="rv-bar">
      <div class="rv-title">Review &amp; Cut <span class="rv-dim">— ${_esc(S.sourceName)}</span></div>
      <button class="rv-btn rv-ghost" data-act="reload">New transcript</button>
      <button class="rv-btn rv-ghost" data-act="close">Close</button>
    </div>
    <div class="rv-player">
      ${S.mediaUrl
        ? `<video id="rv-video" preload="auto" controls playsinline></video>`
        : `<div class="rv-novideo">No video preview${mediaError ? ' — ' + _esc(mediaError) : ''}.<br>You can still review the text and build the cut.</div>`}
    </div>
    <div class="rv-toolbar">
      <label class="rv-check"><input type="checkbox" id="rv-usellm" checked /> Use AI (Gemma) for off-script</label>
      <button class="rv-btn" data-act="suggest">Suggest cuts</button>
      <button class="rv-btn" data-act="playkept">▶ Play kept only</button>
      <span id="rv-final" class="rv-final"></span>
      <span class="rv-spacer"></span>
      <button class="rv-btn rv-primary" data-act="build">Build sequence</button>
    </div>
    <div id="rv-status" class="rv-status"></div>
    <div id="rv-list" class="rv-list"></div>`;

  view.querySelector('[data-act="close"]').onclick = closeReview;
  view.querySelector('[data-act="reload"]').onclick = () => { S.reviewId = null; S.segments = []; _renderSetup({}); };
  view.querySelector('[data-act="suggest"]').onclick = _suggest;
  view.querySelector('[data-act="playkept"]').onclick = _playKept;
  view.querySelector('[data-act="build"]').onclick = _build;

  S.video = view.querySelector('#rv-video');
  if (S.video) {
    S.video.src = S.mediaUrl;
    S.video.ontimeupdate = _onTimeUpdate;
  }
  _renderList();
  _updateFinal();
}

function _renderList() {
  const list = $('#rv-list');
  if (!list) return;
  list.innerHTML = S.segments.map(_segRowHtml).join('');
  // Event delegation (one set of handlers for the whole list).
  list.querySelectorAll('.rv-seg').forEach(row => {
    const id = Number(row.dataset.id);
    row.querySelector('.rv-play').onclick = (e) => { e.stopPropagation(); _playSegment(id); };
    row.querySelector('.rv-toggle').onclick = (e) => { e.stopPropagation(); _toggleSegment(id); };
    row.onclick = () => { S.focusedId = id; _markFocused(); };
  });
  _markFocused();
}

function _segRowHtml(seg) {
  const cut = seg.decision === 'cut';
  const grouped = seg.group_id != null && seg.group_id >= 0;
  const cls = ['rv-seg', cut ? 'rv-cut' : 'rv-keep', grouped ? 'rv-grouped' : ''].join(' ');
  const reason = cut && seg.reason ? `<span class="rv-reason">${_esc(_reasonLabel(seg.reason))}</span>` : '';
  const tin = seg.tight_in != null ? seg.tight_in : seg.start;
  return `<div class="${cls}" data-id="${seg.id}">
      <button class="rv-play" title="Play this line">▶</button>
      <span class="rv-tc">${_fmtTime(tin)}</span>
      <span class="rv-text">${_esc(seg.text || '')}</span>
      ${reason}
      <button class="rv-toggle" title="Keep / cut">${cut ? 'Cut' : 'Keep'}</button>
    </div>`;
}

// ── Playback ─────────────────────────────────────────────────

function _segById(id) { return S.segments.find(s => s.id === id); }
function _outOf(seg) { return seg.tight_out != null ? seg.tight_out : seg.end; }
function _inOf(seg) { return seg.tight_in != null ? seg.tight_in : seg.start; }

function _playSegment(id) {
  const seg = _segById(id);
  if (!seg || !S.video) return;
  S.playMode = 'segment';
  S.playingId = id;
  S.focusedId = id;
  try {
    S.video.currentTime = _inOf(seg);
    S.video.play();
  } catch (_) { /* ignore */ }
  _markPlaying();
}

function _playKept() {
  if (!S.video) return;
  S.keptQueue = S.segments.filter(s => s.decision === 'keep').map(s => s.id);
  if (!S.keptQueue.length) { _setStatus($('#rv-status'), 'Nothing kept to play.', true); return; }
  S.keptIndex = 0;
  S.playMode = 'kept';
  _playKeptCurrent();
}

function _playKeptCurrent() {
  const id = S.keptQueue[S.keptIndex];
  const seg = _segById(id);
  if (!seg) { S.playMode = 'idle'; return; }
  S.playingId = id;
  S.focusedId = id;
  try {
    S.video.currentTime = _inOf(seg);
    S.video.play();
  } catch (_) { /* ignore */ }
  _markPlaying();
}

function _onTimeUpdate() {
  if (!S.video || S.playMode === 'idle') return;
  const seg = _segById(S.playingId);
  if (!seg) return;
  // Stop a hair early so we never bleed into the next pause/word.
  if (S.video.currentTime >= _outOf(seg) - 0.02) {
    if (S.playMode === 'kept') {
      S.keptIndex += 1;
      if (S.keptIndex < S.keptQueue.length) { _playKeptCurrent(); return; }
    }
    try { S.video.pause(); } catch (_) { /* ignore */ }
    S.playMode = 'idle';
    S.playingId = null;
    _markPlaying();
  }
}

// ── Decisions ────────────────────────────────────────────────

function _toggleSegment(id) {
  const seg = _segById(id);
  if (!seg) return;
  seg.decision = seg.decision === 'keep' ? 'cut' : 'keep';
  if (seg.decision === 'keep') seg.reason = '';      // user override clears the chip
  else if (!seg.reason) seg.reason = 'manual';
  _renderList();
  _updateFinal();
}

async function _suggest() {
  if (!S.reviewId || S.busy) return;
  const useLlm = !!$('#rv-usellm')?.checked;
  const status = $('#rv-status');
  S.busy = true;
  _setStatus(status, useLlm ? 'Marking junk + asking AI about off-script lines…' : 'Marking junk (retakes, filler, non-speech, stutters)…');
  try {
    const resp = await apiPost('/api/review/suggest', { review_id: S.reviewId, use_llm: useLlm }, { timeoutMs: 300000 });
    S.segments = resp.segments || S.segments;
    _renderList();
    _updateFinal();
    const su = resp.summary || {};
    _setStatus(status, `Suggested: ${su.keep ?? '?'} keep, ${su.cut ?? '?'} cut${resp.llm_used ? ' (AI refined)' : ''}. Toggle anything, then Build.`);
  } catch (err) {
    _setStatus(status, `Suggest failed: ${err.message || err}`, true);
  } finally {
    S.busy = false;
  }
}

async function _build() {
  if (!S.reviewId || S.busy) return;
  const status = $('#rv-status');
  const keptIds = S.segments.filter(s => s.decision === 'keep').map(s => s.id);
  if (!keptIds.length) { _setStatus(status, 'Nothing kept — toggle some lines to keep first.', true); return; }
  S.busy = true;
  _setStatus(status, `Building a tight cut from ${keptIds.length} line(s)…`);
  try {
    const built = await apiPost('/api/review/build', { review_id: S.reviewId, kept_ids: keptIds }, { timeoutMs: 120000 });
    const planId = built.plan_id;
    if (!planId) throw new Error('No plan_id returned.');

    _setStatus(status, 'Placing clips in Premiere…');
    const applyResult = await apiPost(`/api/edit/plan/${planId}/apply`, {}, { timeoutMs: 120000 });
    const ops = applyResult.extendscript_ops || [];
    const seqName = applyResult.target_sequence_name || 'EditFlow Cut';

    if (isExtendScriptAvailable()) {
      await callExtendScript('processEDL', JSON.stringify({ ops }));
      _setStatus(status, `Done — "${seqName}" is in your Premiere project. A "New Sequence" preset dialog may ask you to click OK.`);
    } else {
      _setStatus(status, `Plan built (${ops.length} ops). Open the panel inside Premiere to place the clips.`);
    }
  } catch (err) {
    _setStatus(status, `Build failed: ${err.message || err}`, true);
  } finally {
    S.busy = false;
  }
}

// ── Small UI helpers ─────────────────────────────────────────

function _updateFinal() {
  const el = $('#rv-final');
  if (!el) return;
  const kept = S.segments.filter(s => s.decision === 'keep');
  const dur = kept.reduce((sum, s) => sum + (_outOf(s) - _inOf(s)), 0);
  el.textContent = `Final: ${kept.length} cut${kept.length === 1 ? '' : 's'} · ${_fmtDur(dur)}`;
}

function _markPlaying() {
  document.querySelectorAll('.rv-seg.rv-playing').forEach(r => r.classList.remove('rv-playing'));
  if (S.playingId == null) return;
  const row = document.querySelector(`.rv-seg[data-id="${S.playingId}"]`);
  if (row) {
    row.classList.add('rv-playing');
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function _markFocused() {
  document.querySelectorAll('.rv-seg.rv-focused').forEach(r => r.classList.remove('rv-focused'));
  if (S.focusedId == null) return;
  const row = document.querySelector(`.rv-seg[data-id="${S.focusedId}"]`);
  if (row) row.classList.add('rv-focused');
}

function _bindKeyboard() {
  if (_keydownBound) return;
  _keydownBound = true;
  document.addEventListener('keydown', (e) => {
    const view = $('#review-view');
    if (!view || view.classList.contains('hidden')) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;   // don't hijack typing
    if (!S.segments.length) return;

    if (e.key === ' ') {
      e.preventDefault();
      if (!S.video) return;
      if (S.video.paused) { if (S.focusedId != null) _playSegment(S.focusedId); }
      else { S.video.pause(); S.playMode = 'idle'; }
    } else if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowUp') {
      e.preventDefault(); _moveFocus(-1);
    } else if (e.key === 'l' || e.key === 'L' || e.key === 'ArrowDown') {
      e.preventDefault(); _moveFocus(1);
    } else if (e.key === 'k' || e.key === 'K') {
      e.preventDefault(); if (S.focusedId != null) _toggleSegment(S.focusedId);
    } else if (e.key === 'Enter') {
      e.preventDefault(); _playKept();
    }
  });
}

function _moveFocus(delta) {
  if (!S.segments.length) return;
  let idx = S.segments.findIndex(s => s.id === S.focusedId);
  if (idx < 0) idx = 0;
  idx = Math.max(0, Math.min(S.segments.length - 1, idx + delta));
  S.focusedId = S.segments[idx].id;
  _markFocused();
  const row = document.querySelector(`.rv-seg[data-id="${S.focusedId}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

function _guessSourceFromScan() {
  // Best-effort prefill from the last project scan (never throws).
  try {
    const scan = getState()?.session?.scan || null;
    const items = scan && (scan.items || scan.clips);
    if (Array.isArray(items)) {
      const audio = items.find(it => {
        const mp = it.mediaPath || it.media_path || '';
        return mp && /\.(mov|mp4|m4v|wav|mp3|m4a|aac)$/i.test(mp);
      });
      if (audio) return audio.mediaPath || audio.media_path;
    }
  } catch (_) { /* ignore */ }
  return '';
}

function _reasonLabel(reason) {
  if (!reason) return '';
  if (reason.startsWith('retake_of')) return 'retake';
  return ({
    non_speech: 'non-speech', filler: 'filler', too_short: 'too short',
    not_in_script: 'off-script', empty: 'empty', manual: 'cut', llm_off_script: 'off-script',
  })[reason] || reason;
}

function _setStatus(el, msg, isError) {
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('rv-error', !!isError);
}

function _fmtTime(s) {
  s = Number(s) || 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function _fmtDur(s) {
  s = Number(s) || 0;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function _esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export { openReview, closeReview };
