/**
 * review-view.js — Review editor v2 (full redesign).
 *
 * Views: EDIT (word document) and TAKES (fold-the-repeats). Layouts: COMPACT
 * (narrow single column) and WORKSPACE (wide, 4 resizable panels: Controls,
 * Video, Plan, Transcript). Editing is by WORD via native text selection
 * (start anywhere → sweep flips; first word sets direction; tap = play). Urdu in
 * Nastaliq. Header tabs Edit/Takes/Chat + a Compact/Workspace toggle.
 *
 * Spec: docs/superpowers/specs/2026-06-06-review-panel-redesign-design.md.
 * Backend reused as-is: /api/review/{ingest,media,waveform,suggest,build,scribe,transcribe}
 * + the cut-apply backbone (/api/edit/plan/{id}/apply → processEDL).
 *
 * Additive & self-contained: opening hides the chat shell, closing restores it.
 */
import { apiGet, apiPost, getBaseUrl } from './api.js';
import { callExtendScript, isExtendScriptAvailable } from './extendscript.js';
import { getState } from './state.js';

const $ = (sel) => document.querySelector(sel);

const S = {
  reviewId: null,
  words: [], byId: new Map(), segments: [],
  mediaUrl: null, sourceName: '', sourcePath: '', script: '', duration: 0,
  peaks: [], modelName: '',
  video: null, canvas: null,
  view: 'edit',            // 'edit' | 'takes'
  layout: 'compact',       // 'compact' | 'workspace'
  videoVisible: true,      // docked video pane shown
  videoFloating: false,    // video popped out to a floating PiP
  floatRect: null,         // {left,top,width,height} — persists for the session
  leftWidth: null,         // workspace left-column width (px) — persists
  videoHeight: null,       // docked video pane height (px) — persists
  playMode: 'idle', planRanges: [], planIdx: 0,
  focusId: null,
  undo: [], redo: [],
  busy: false, aiAbort: null,
  prevView: null, _scribePending: false, _menuOpen: false, _modelPoll: null,
  debug: false, lastTrace: null,
};
let _keysBound = false, _lastNow = null;

// ── Public ───────────────────────────────────────────────────
function openReview(opts = {}) {
  _ensureStyles();
  const view = _ensureContainer();
  const hero = $('#hero'), chat = $('#chat-scroll'), footer = $('#app-footer');
  S.prevView = { hero: hero?.classList.contains('hidden') ?? true,
                 chat: chat?.classList.contains('hidden') ?? true,
                 footer: footer?.classList.contains('hidden') ?? true };
  hero?.classList.add('hidden'); chat?.classList.add('hidden'); footer?.classList.add('hidden');
  view.classList.remove('hidden');
  if (S.reviewId && S.words.length) _render(); else _renderSetup(opts);
  _bindKeys();
  // Lightweight poll so a model switched in Settings updates the label live.
  if (!S._modelPoll) S._modelPoll = setInterval(() => {
    const el = $('#review-view'); if (!el || el.classList.contains('hidden') || document.hidden) return;
    _refreshModelLabel();
  }, 15000);
}
function closeReview() {
  $('#review-view')?.classList.add('hidden');
  try { S.video?.pause(); } catch (_) {}
  if (S._modelPoll) { clearInterval(S._modelPoll); S._modelPoll = null; }
  S.playMode = 'idle';
  const hero = $('#hero'), chat = $('#chat-scroll'), footer = $('#app-footer');
  if (S.prevView) {
    hero?.classList.toggle('hidden', S.prevView.hero);
    chat?.classList.toggle('hidden', S.prevView.chat);
    footer?.classList.toggle('hidden', S.prevView.footer);
  }
}

// ── Styles + container ───────────────────────────────────────
function _ensureStyles() {
  if (document.getElementById('rv-style-link')) return;
  const link = document.createElement('link');
  link.id = 'rv-style-link'; link.rel = 'stylesheet';
  link.href = 'styles/review.css?v=' + Date.now();
  document.head.appendChild(link);
}
function _ensureContainer() {
  let v = $('#review-view');
  if (!v) { v = document.createElement('div'); v.id = 'review-view'; v.className = 'review-view hidden'; ($('#app-main') || document.body).appendChild(v); }
  return v;
}

// ── Setup screen (paste / Scribe) ────────────────────────────
function _renderSetup(opts = {}) {
  const v = _ensureContainer();
  const src = opts.sourceFile || _guessSourceFromScan() || '';
  v.innerHTML = `
    <div class="rv-bar"><div class="rv-title">Review &amp; Cut</div><button class="rv-btn rv-ghost" data-act="close">Close</button></div>
    <div class="rv-setup">
      <p class="rv-hint">Pick a clip, then <b>transcribe with Scribe</b> (exact word timing) — or paste a transcript. Then edit by word: play, select, cut.</p>
      <label class="rv-label">Source clip <span class="rv-dim">(filename if scanned, or full path)</span></label>
      <input id="rv-source" class="rv-input" type="text" placeholder="IMG_1694.MOV" value="${_esc(src)}" spellcheck="false" />
      <div class="rv-scribe">
        <div class="rv-subhead">Transcribe with ElevenLabs Scribe <span class="rv-dim">— recommended</span></div>
        <div id="rv-scribe-key" class="rv-keyrow"></div>
        <div class="rv-actions"><button class="rv-btn rv-primary" data-act="transcribe">Transcribe with Scribe</button><span id="rv-scribe-status" class="rv-status"></span></div>
      </div>
      <div class="rv-or">— or paste a transcript —</div>
      <textarea id="rv-transcript" class="rv-textarea" placeholder="Paste a Scribe SRT or Gemini JSON…" spellcheck="false"></textarea>
      <label class="rv-label">Script <span class="rv-dim">(optional — helps AI flag off-script)</span></label>
      <textarea id="rv-script" class="rv-textarea rv-textarea-short" placeholder="Paste your script (any language)..." spellcheck="false"></textarea>
      <div class="rv-actions"><button class="rv-btn" data-act="load">Load pasted transcript</button><span id="rv-setup-status" class="rv-status"></span></div>
    </div>`;
  v.querySelector('[data-act="close"]').onclick = closeReview;
  v.querySelector('[data-act="load"]').onclick = _loadTranscript;
  v.querySelector('[data-act="transcribe"]').onclick = _transcribeScribe;
  const ta = v.querySelector('#rv-transcript'); if (ta && opts.transcript) ta.value = opts.transcript;
  S._scribePending = false; _refreshScribe();
}
async function _applyReviewResp(resp, script) {
  S.reviewId = resp.review_id;
  _setData(resp);
  S.mediaUrl = resp.media_url ? getBaseUrl() + resp.media_url : null;
  S.sourceName = resp.source_name || ''; S.sourcePath = resp.source_path || '';
  S.script = script || ''; S.duration = resp.duration || 0;
  S.undo = []; S.redo = []; S.view = 'edit';
  S.modelName = await _fetchModelName();
  _render(); _loadWaveform();
}
async function _loadTranscript() {
  const source = ($('#rv-source')?.value || '').trim();
  const transcript = ($('#rv-transcript')?.value || '').trim();
  const script = ($('#rv-script')?.value || '').trim();
  const status = $('#rv-setup-status');
  if (!transcript) { _setStatus(status, 'Paste a transcript first (or use Scribe above).', true); return; }
  _setStatus(status, 'Preparing preview & splitting into words…');
  try {
    const resp = await apiPost('/api/review/ingest', { transcript_text: transcript, source_file: source || null, script, fmt: 'auto', tighten: true }, { timeoutMs: 1800000 });
    await _applyReviewResp(resp, script);
  } catch (err) { _setStatus(status, `Couldn't load: ${err.message || err}`, true); }
}
function _setData(resp) {
  S.words = (resp.words || []).map(w => ({ ...w, keep: w.keep !== false }));
  S.byId = new Map(S.words.map(w => [w.id, w]));
  if (resp.segments) S.segments = resp.segments;
}
async function _refreshScribe() {
  const row = $('#rv-scribe-key'); if (!row) return;
  let has = false;
  try { has = !!(await apiGet('/api/review/scribe/status', { timeoutMs: 4000 })).has_key; } catch (_) {}
  if (has) { row.innerHTML = `<span class="rv-dim">✓ API key saved.</span> <button class="rv-btn rv-ghost rv-tiny" data-act="changekey">change</button>`; row.querySelector('[data-act="changekey"]').onclick = () => _showKeyInput(row); }
  else _showKeyInput(row);
}
function _showKeyInput(row) {
  row.innerHTML = `<input id="rv-scribe-keyinput" class="rv-input" type="password" placeholder="Paste your ElevenLabs API key" spellcheck="false" /><button class="rv-btn rv-tiny" data-act="savekey">Save key</button>`;
  row.querySelector('[data-act="savekey"]').onclick = async () => {
    const key = ($('#rv-scribe-keyinput')?.value || '').trim(); if (!key) return;
    try { await apiPost('/api/review/scribe/key', { key }, { timeoutMs: 5000 }); _refreshScribe(); }
    catch (e) { _setStatus($('#rv-scribe-status'), 'Could not save key: ' + (e.message || e), true); }
  };
}
async function _transcribeScribe() {
  const source = ($('#rv-source')?.value || '').trim(); const status = $('#rv-scribe-status');
  const btn = document.querySelector('[data-act="transcribe"]');
  if (!source) { _setStatus(status, 'Enter the source clip first.', true); return; }
  if (!S._scribePending) {
    try {
      const est = await apiPost('/api/review/scribe/estimate', { source_file: source }, { timeoutMs: 15000 });
      if (!est.has_key) { _setStatus(status, 'Add your ElevenLabs API key above first.', true); return; }
      S._scribePending = true; if (btn) btn.textContent = `Confirm — transcribe (~$${(est.usd || 0).toFixed(2)})`;
      _setStatus(status, `Scribe will transcribe ${est.source_name} (~${est.minutes} min ≈ $${(est.usd || 0).toFixed(2)}). Click again to confirm.`);
    } catch (e) { _setStatus(status, 'Estimate failed: ' + (e.message || e), true); }
    return;
  }
  S._scribePending = false; if (btn) { btn.textContent = 'Transcribing with Scribe…'; btn.disabled = true; }
  _setStatus(status, 'Transcribing with Scribe (and preparing preview)…');
  try {
    const script = ($('#rv-script')?.value || '').trim();
    const resp = await apiPost('/api/review/transcribe', { source_file: source, script, language_code: 'ur' }, { timeoutMs: 1800000 });
    await _applyReviewResp(resp, script);
  } catch (e) { _setStatus(status, 'Scribe failed: ' + (e.message || e), true); if (btn) { btn.textContent = 'Transcribe with Scribe'; btn.disabled = false; } }
}

// ── Master render (tabs + layout) ────────────────────────────
function _render(mediaError) {
  const v = _ensureContainer();
  const tab = (id, label) => `<span class="rv-tab ${S.view === id ? 'on' : ''}" data-tab="${id}">${label}</span>`;
  const modelLabel = S.modelName ? `Use AI (${_esc(S.modelName)})` : 'Use AI';
  v.className = 'review-view rv-' + S.layout;
  v.innerHTML = `
    <div class="rv-bar">
      <div class="rv-title">EditFlow</div>
      <div class="rv-tabs">${tab('edit', 'Edit')}${tab('takes', 'Takes')}<span class="rv-tab" data-tab="chat">Chat</span></div>
      <span class="rv-spacer"></span>
      <div class="rv-viewtoggle">
        <span class="${S.layout === 'compact' ? 'on' : ''}" data-layout="compact" title="Compact">⊟</span>
        <span class="${S.layout === 'workspace' ? 'on' : ''}" data-layout="workspace" title="Workspace (wide)">⛶</span>
      </div>
      <button class="rv-btn rv-ghost rv-tiny ${S.debug ? 'rv-on' : ''}" data-act="debugtoggle" title="Pipeline debug trace">🐞</button>
      <button class="rv-btn rv-ghost rv-tiny" data-act="reload">New</button>
      <button class="rv-btn rv-ghost rv-tiny" data-act="close">Close</button>
    </div>
    ${_controlsHtml(modelLabel)}
    <div id="rv-status" class="rv-status"></div>
    <div id="rv-body" class="rv-body">${S.view === 'takes' ? _takesHtml() : _editHtml(mediaError)}</div>
    ${S.debug ? _debugDrawerHtml() : ''}`;

  // header wiring
  v.querySelectorAll('[data-tab]').forEach(t => t.onclick = () => _switchTab(t.dataset.tab));
  v.querySelectorAll('[data-layout]').forEach(t => t.onclick = () => { S.layout = t.dataset.layout; _render(); });
  v.querySelector('[data-act="close"]').onclick = closeReview;
  v.querySelector('[data-act="reload"]').onclick = () => { S.reviewId = null; S.words = []; _renderSetup({}); };
  v.querySelector('[data-act="debugtoggle"]').onclick = () => { S.debug = !S.debug; _render(); };
  const dbgClose = v.querySelector('[data-act="debugclose"]'); if (dbgClose) dbgClose.onclick = () => { S.debug = false; _render(); };
  _wireControls();
  if (S.view === 'edit') _wireEdit(); else _wireTakes();
}
function _switchTab(id) {
  if (id === 'chat') { closeReview(); return; }
  S.view = id; _render();
}

// ── Controls bar (shared) ────────────────────────────────────
function _controlsHtml(modelLabel) {
  return `<div class="rv-toolbar" id="rv-controls">
    <button class="rv-pp" data-act="playpause" title="Play / pause (Space)">▶</button>
    <span class="rv-time" id="rv-time">0:00</span>
    <button class="rv-btn" data-act="preview" title="Preview the cut (Enter)">▶ Preview cut</button>
    <span class="rv-sep"></span>
    <label class="rv-check"><input type="checkbox" id="rv-usellm" checked /> <span id="rv-modellabel">${modelLabel}</span></label>
    <button class="rv-btn" data-act="suggest">Suggest</button>
    <span class="rv-cleanwrap"><button class="rv-btn" data-act="cleanup">✦ Clean up ▾</button><div id="rv-cleanmenu" class="rv-menu hidden">
      <div data-clean="filler">Remove fillers (haan ji, umm)</div>
      <div data-clean="nonspeech">Remove [non-speech]</div>
      <div data-clean="retake">Remove repeated takes</div>
      <div data-clean="restore" class="rv-danger">Restore all words</div>
    </div></span>
    <button class="rv-btn rv-ghost rv-tiny" data-act="undo" title="Undo (Ctrl+Z)">↶</button>
    <button class="rv-btn rv-ghost rv-tiny" data-act="redo" title="Redo (Ctrl+Y)">↷</button>
    <span class="rv-spacer"></span>
    <span id="rv-readout" class="rv-final"></span>
    <button class="rv-btn rv-primary" data-act="build">Build</button>
  </div>`;
}
function _wireControls() {
  const on = (s, fn) => { const el = $(s); if (el) el.onclick = fn; };
  on('[data-act="playpause"]', _playPause);
  on('[data-act="preview"]', _playPlan);
  on('[data-act="suggest"]', _suggest);
  on('[data-act="undo"]', _undo);
  on('[data-act="redo"]', _redo);
  on('[data-act="build"]', _build);
  on('[data-act="cleanup"]', _toggleCleanMenu);
  document.querySelectorAll('#rv-cleanmenu [data-clean]').forEach(d => d.onclick = () => { _quickCut(d.dataset.clean); _toggleCleanMenu(false); });
  _updateReadout();
  _refreshModelLabel();   // live model name on every toolbar mount
}
// Re-fetch the active model and update the label in place (no full re-render).
function _refreshModelLabel() {
  _fetchModelName().then(m => {
    if (m) S.modelName = m;
    const ml = $('#rv-modellabel'); if (ml) ml.textContent = S.modelName ? `Use AI (${S.modelName})` : 'Use AI';
  }).catch(() => {});
}
function _toggleCleanMenu(force) {
  const m = $('#rv-cleanmenu'); if (!m) return;
  const show = (force === undefined) ? m.classList.contains('hidden') : force;
  m.classList.toggle('hidden', !show);
}

// ── EDIT view ────────────────────────────────────────────────
function _editHtml(mediaError) {
  // ONE <video id="rv-video"> element: it lives in the docked pane normally, or
  // in the floating PiP when popped out. The waveform stays docked either way so
  // the playhead is always reachable (spec §3).
  // The video + its centred play/pause button. Used docked or floating.
  const videoBlock = `<div class="rv-vidwrap" id="rv-vidwrap"><video id="rv-video" preload="auto" playsinline></video><button class="rv-vidplay" data-act="vidplay" title="Play / pause (Space)">▶</button></div>`;
  const dockedBody = !S.mediaUrl
    ? `<div class="rv-novideo">No preview${mediaError ? ' — ' + _esc(mediaError) : ''}.</div>`
    : (S.videoFloating ? `<div class="rv-novideo rv-poppednote">Video popped out.</div>` : videoBlock);
  const vh = S.videoHeight ? ` style="height:${S.videoHeight}px;flex:none"` : '';
  const videoPanel = `<div class="rv-pane rv-videopane" id="rv-videopane"${vh}>
      <div class="rv-ptab"><span class="rv-pname">Video</span><span class="rv-pmeta">${_esc(S.sourceName)}</span>
        <span class="rv-pacts">${S.mediaUrl ? `<span data-act="popvideo" title="Pop out to floating window">⤢</span>` : ''}<span data-act="hidevideo" title="Hide video">✕</span></span></div>
      ${dockedBody}
      <canvas id="rv-wave" class="rv-wave" height="40"></canvas>
    </div>`;
  const floatPane = (S.videoFloating && S.mediaUrl) ? `<div class="rv-float" id="rv-float">
      <div class="rv-floathead" id="rv-floathead"><span class="rv-pname">Video</span><span class="rv-pmeta">${_esc(S.sourceName)}</span>
        <span class="rv-pacts"><span data-act="dockvideo" title="Dock back">⤡</span><span data-act="hidevideo" title="Hide video">✕</span></span></div>
      ${videoBlock}
      <div class="rv-floatgrip" data-act="floatresize" title="Resize"></div>
    </div>` : '';
  const transcriptPanel = `<div class="rv-pane rv-transcriptpane"><div class="rv-ptab"><span class="rv-pname">Transcript</span><span class="rv-pmeta">${S.words.length} words</span></div>
      <div id="rv-doc" class="rv-doc"></div></div>`;
  const showVideoChip = !S.videoVisible ? `<button class="rv-chip" data-act="showvideo">▸ Show video</button>` : '';
  if (S.layout === 'workspace') {
    const lw = S.leftWidth ? ` style="width:${S.leftWidth}px"` : '';
    return `<div class="rv-work">
      <div class="rv-left" id="rv-left"${lw}>
        ${S.videoVisible ? videoPanel : ''}
        ${S.videoVisible ? '<div class="rv-hsplit" data-split="row"></div>' : ''}
        ${_planHtml()}
      </div>
      <div class="rv-vsplit" data-split="col"></div>
      <div class="rv-right">${transcriptPanel}</div>
    </div>${showVideoChip}${floatPane}`;
  }
  // compact — video, a drag handle to resize it, then the transcript
  return `${S.videoVisible ? videoPanel + '<div class="rv-hsplit" data-split="row"></div>' : showVideoChip}${transcriptPanel}${floatPane}`;
}
function _wireEdit() {
  S.video = $('#rv-video');
  if (S.video) { S.video.src = S.mediaUrl; S.video.ontimeupdate = _onTime; S.video.onseeked = _onTime; S.video.onplay = _syncPlayUI; S.video.onpause = _syncPlayUI; S.video.onclick = _playPause; }
  document.querySelectorAll('[data-act="vidplay"]').forEach(b => b.onclick = (e) => { e.stopPropagation(); _playPause(); });
  _syncPlayUI();
  S.canvas = $('#rv-wave'); _bindWaveform();
  document.querySelectorAll('[data-act="hidevideo"]').forEach(el => el.onclick = () => { S.videoVisible = false; S.videoFloating = false; _render(); });
  const sv = document.querySelector('[data-act="showvideo"]'); if (sv) sv.onclick = () => { S.videoVisible = true; _render(); };
  const pop = document.querySelector('[data-act="popvideo"]'); if (pop) pop.onclick = () => { S.videoFloating = true; _render(); };
  const dock = document.querySelector('[data-act="dockvideo"]'); if (dock) dock.onclick = () => { S.videoFloating = false; _render(); };
  _bindFloat();
  _renderWords(); _bindDocEvents();
  _bindSplitters();
  _bindPlanBox();
  _updateReadout();
}
// Floating PiP: drag by the header, resize by the corner grip. Geometry persists
// for the session in S.floatRect.
function _bindFloat() {
  const fl = $('#rv-float'); if (!fl) return;
  const r = S.floatRect;
  if (r) { fl.style.left = r.left + 'px'; fl.style.top = r.top + 'px'; fl.style.width = r.width + 'px'; fl.style.height = r.height + 'px'; }
  const save = () => { S.floatRect = { left: parseInt(fl.style.left) || 0, top: parseInt(fl.style.top) || 0, width: fl.offsetWidth, height: fl.offsetHeight }; };
  const head = $('#rv-floathead');
  if (head) head.onmousedown = (e) => {
    if (e.target.closest('[data-act]')) return;   // let the dock/hide buttons work
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = fl.offsetLeft, oy = fl.offsetTop;
    const move = (ev) => { fl.style.left = Math.max(0, ox + ev.clientX - sx) + 'px'; fl.style.top = Math.max(0, oy + ev.clientY - sy) + 'px'; };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); save(); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  };
  const grip = fl.querySelector('[data-act="floatresize"]');
  if (grip) grip.onmousedown = (e) => {
    e.preventDefault(); e.stopPropagation();
    const sx = e.clientX, sy = e.clientY, sw = fl.offsetWidth, sh = fl.offsetHeight;
    const move = (ev) => { fl.style.width = Math.max(160, sw + ev.clientX - sx) + 'px'; fl.style.height = Math.max(120, sh + ev.clientY - sy) + 'px'; };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); save(); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  };
}

// ── Plan box (workspace) ─────────────────────────────────────
function _planHtml() {
  return `<div class="rv-pane rv-planpane"><div class="rv-ptab"><span class="rv-pname">Plan</span><span class="rv-pmeta" id="rv-plan-meta"></span></div>
    <div class="rv-planbody">
      <div class="rv-seg"><span class="on" data-plantab="ai">AI plan</span><span data-plantab="paste">Paste a plan</span></div>
      <div id="rv-plan-ai" class="rv-planlist"></div>
      <div id="rv-plan-paste" class="hidden">
        <textarea id="rv-plan-text" class="rv-textarea rv-textarea-short" placeholder='Paste a model&apos;s cut plan JSON: {"cuts":[{"source_in":..,"source_out":..}]}'></textarea>
        <button class="rv-btn rv-primary rv-tiny" data-act="applypaste">Apply pasted plan</button>
      </div>
    </div></div>`;
}
function _bindPlanBox() {
  document.querySelectorAll('[data-plantab]').forEach(t => t.onclick = () => {
    const which = t.dataset.plantab;
    document.querySelectorAll('[data-plantab]').forEach(x => x.classList.toggle('on', x === t));
    $('#rv-plan-ai')?.classList.toggle('hidden', which !== 'ai');
    $('#rv-plan-paste')?.classList.toggle('hidden', which !== 'paste');
  });
  const ap = document.querySelector('[data-act="applypaste"]'); if (ap) ap.onclick = _applyPastedPlan;
  _renderPlanList();
}
function _renderPlanList() {
  const el = $('#rv-plan-ai'); if (!el) return;
  const ranges = _mergedKeptRanges();
  $('#rv-plan-meta') && ($('#rv-plan-meta').textContent = `${ranges.length} spans · ${_fmtDur(ranges.reduce((s, r) => s + (r[1] - r[0]), 0))}`);
  el.innerHTML = ranges.map(r => {
    const txt = S.words.filter(w => w.keep && w.start >= r[0] - 0.01 && w.end <= r[1] + 0.01).map(w => w.text).join(' ').slice(0, 60);
    return `<div class="rv-planrow" data-seek="${r[0]}"><span class="rv-tc">${_fmtDur(r[0])}</span><span class="rv-txt" dir="${_baseDir(txt)}">${_esc(txt)}</span></div>`;
  }).join('') || '<div class="rv-dim" style="padding:8px">No cuts yet — select words to cut.</div>';
  el.querySelectorAll('[data-seek]').forEach(d => d.onclick = () => { if (S.video) { try { S.video.currentTime = parseFloat(d.dataset.seek); } catch (_) {} _play(); } });
}
// ── Debug drawer (pipeline trace) ────────────────────────────
function _debugDrawerHtml() {
  const t = S.lastTrace;
  const head = `<div class="rv-dbg-head">🐞 Pipeline trace<span class="rv-spacer"></span><button class="rv-btn rv-tiny" data-act="debugclose">hide</button></div>`;
  if (!t || !t.stages || !t.stages.length) {
    return `<div class="rv-debug">${head}<div class="rv-dbg-body"><i>Run <b>Suggest</b> with debug on to populate the trace.</i></div></div>`;
  }
  let body = '';
  for (const st of t.stages) {
    if (st.stage === 'junk') body += _dbgJunk(st);
    else if (st.stage === 'cluster') body += _dbgCluster(st);
    else if (st.stage === 'script') body += _dbgScript(st);
    else if (st.stage === 'llm') body += _dbgLlm(st);
    else if (st.stage === 'final') body += _dbgFinal(st);
  }
  return `<div class="rv-debug">${head}<div class="rv-dbg-body">${body}</div></div>`;
}
function _dbgJunk(st) {
  const rows = (st.cut || []).map(c => `<div>#${c.id} <b>${_esc(c.reason)}</b> <span dir="auto">${_esc(c.text)}</span></div>`).join('') || '<i>nothing cut as junk</i>';
  return `<details><summary>Junk — ${(st.cut || []).length} cut · ${st.kept_after_junk} kept</summary>${rows}</details>`;
}
function _dbgCluster(st) {
  const clusters = (st.clusters || []).map(c =>
    `<div class="rv-dbg-cl">group ${c.group_id} · winner #${c.winner_id}: ${c.members.map(m => `<span class="${m.decision === 'cut' ? 'rv-w-cut' : ''}">#${m.id}</span>`).join(', ')}</div>`
  ).join('') || '<i>no retake groups formed</i>';
  const pairs = (st.pairs || []).map(p => {
    const cls = p.skipped ? 'rv-dbg-skip' : (p.clustered ? 'rv-dbg-hit' : 'rv-dbg-miss');
    const result = p.skipped ? `SKIPPED (${p.skipped})` : (p.clustered ? 'grouped' : 'not grouped');
    return `<tr class="${cls}"><td>#${p.a_id}</td><td class="rv-dbg-tx" dir="auto">${_esc(p.a_text)}</td><td>#${p.b_id}</td><td class="rv-dbg-tx" dir="auto">${_esc(p.b_text)}</td><td>${p.score == null ? '—' : p.score}</td><td>${result}</td></tr>`;
  }).join('');
  const tbl = pairs ? `<table class="rv-dbg-tbl"><tr><th>a</th><th>text</th><th>b</th><th>text</th><th>score</th><th>result</th></tr>${pairs}</table>` : '<i>no notable pairs</i>';
  return `<details open><summary>Clustering — ${(st.clusters || []).length} groups · ${(st.pairs || []).length} notable pairs</summary>${clusters}${tbl}</details>`;
}
function _dbgScript(st) {
  if (!st.enabled) return `<details><summary>Script match — no script provided</summary></details>`;
  if (st.same_language === false) return `<details><summary>Script match — SKIPPED (different writing system)</summary><i>Transcript and script use different scripts, so no off-script cutting was done.</i></details>`;
  const rows = (st.matches || []).map(m => `<div class="${m.cut ? 'rv-dbg-miss' : ''}">#${m.id} score ${m.score} ${m.cut ? '→ CUT (off-script)' : '→ kept'} <span dir="auto">${_esc(m.best_line || '')}</span></div>`).join('');
  const cutCount = (st.matches || []).filter(m => m.cut).length;
  return `<details><summary>Script match — ${cutCount} cut as off-script</summary>${rows}</details>`;
}
function _dbgLlm(st) {
  const warn = st.truncated ? `<div class="rv-dbg-warn">⚠ Reply looks TRUNCATED — parsed ${st.parsed_count} of ${st.segment_count} segments at max_tokens=${st.max_tokens}. Raise the budget or chunk the request.</div>` : '';
  const err = st.error ? `<div class="rv-dbg-warn">LLM error: ${_esc(st.error)}</div>` : '';
  const flips = (st.flips || []).map(f => `#${f.id} (${_esc(f.reason)})`).join(', ') || 'none';
  return `<details><summary>LLM — used:${st.used} · parsed ${st.parsed_count}/${st.segment_count} · ${st.response_chars} chars${st.truncated ? ' · TRUNCATED' : ''}</summary>${warn}${err}<div>Flipped keep→cut: ${flips}</div><details><summary>Prompt (${(st.prompt || '').length} chars)</summary><pre class="rv-dbg-pre">${_esc(st.prompt)}</pre></details><details><summary>Raw response (${st.response_chars} chars)</summary><pre class="rv-dbg-pre">${_esc(st.raw_response)}</pre></details></details>`;
}
function _dbgFinal(st) {
  const rows = (st.segments || []).map(s => `<tr><td>#${s.id}</td><td>${_esc(s.decision)}</td><td>${_esc(s.decided_by)}</td><td class="rv-dbg-tx" dir="auto">${_esc((s.text || '').slice(0, 60))}</td></tr>`).join('');
  return `<details><summary>Final decisions — ${(st.segments || []).length} segments</summary><table class="rv-dbg-tbl"><tr><th>id</th><th>decision</th><th>by</th><th>text</th></tr>${rows}</table></details>`;
}

async function _applyPastedPlan() {
  const txt = ($('#rv-plan-text')?.value || '').trim(); const status = $('#rv-status');
  if (!txt) { _setStatus(status, 'Paste a plan JSON first.', true); return; }
  _setStatus(status, 'Applying pasted plan…');
  try {
    const ing = await apiPost('/api/external-plan/ingest', { pasted_text: txt, transcripts_ready: { [S.sourcePath]: 'ready' }, script: S.script, user_hint: 'review_paste' }, { timeoutMs: 60000 });
    if (!ing.plan_id) throw new Error('No plan_id');
    await _applyPlanId(ing.plan_id, status);
  } catch (e) { _setStatus(status, 'Paste-plan failed: ' + (e.message || e), true); }
}

// ── TAKES view ───────────────────────────────────────────────
function _beats() {
  // group segments by group_id (>=0 multi-take; -1 singleton beat)
  const groups = new Map();
  for (const s of S.segments) {
    const g = (s.group_id != null && s.group_id >= 0) ? `g${s.group_id}` : `s${s.id}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  return [...groups.values()].sort((a, b) => a[0].start - b[0].start);
}
function _segWords(segId) { return S.words.filter(w => w.segment_id === segId); }
function _quality(seg) {
  // Intrinsic quality of THIS take so takes in a multi-take beat are comparable.
  // (Do NOT tag every group member 'repeat' just for sharing a group_id — that
  // hid the clean take, the one you need to pick.)
  const t = (seg.text || '').trim();
  if (t.endsWith('--')) return 'false start';
  if (t.length < 6) return 'stumble';
  if ((seg.reason || '').startsWith('retake')) return 'repeat';
  return 'clean';
}
function _winnerSegId(beat) {
  // last take whose words are currently kept, else last
  for (let i = beat.length - 1; i >= 0; i--) if (_segWords(beat[i].id).some(w => w.keep)) return beat[i].id;
  return beat[beat.length - 1].id;
}
function _takesHtml() {
  const beats = _beats();
  const picked = beats.filter(b => _segWords(_winnerSegId(b)).some(w => w.keep)).length;
  let html = `<div class="rv-takes">`;
  for (const beat of beats) {
    const win = _winnerSegId(beat);
    const label = _esc((beat.find(s => s.script_line)?.script_line) || beat[0].text || 'beat').slice(0, 60);
    html += `<div class="rv-beat"><div class="rv-bhead"><span class="rv-blabel">${label}</span><span class="rv-bcnt">${beat.length} take${beat.length > 1 ? 's' : ''}</span></div>`;
    for (const seg of beat) {
      const isWin = seg.id === win;
      const q = _quality(seg);
      html += `<div class="rv-take ${isWin ? 'win' : ''}" data-seg="${seg.id}">
        <span class="rv-radio"></span>
        <button class="rv-pl" data-playseg="${seg.id}">▶</button>
        <span class="rv-tc">${_fmtDur(seg.start)}</span>
        <span class="rv-snip" dir="${_baseDir(seg.text)}">${_esc((seg.text || '').slice(0, 70))}</span>
        <span class="rv-qtag q-${q.replace(' ', '')}">${q}</span></div>`;
    }
    html += `<div class="rv-finetrim" data-fine="${win}">↳ fine-trim in Edit →</div></div>`;
  }
  html += `</div>`;
  return `<div class="rv-takesummary">${beats.length} beats · ${picked} picked</div>` + html;
}
function _wireTakes() {
  document.querySelectorAll('[data-seg]').forEach(row => row.onclick = (e) => {
    if (e.target.closest('[data-playseg]')) return;
    _pickTake(Number(row.dataset.seg));
  });
  document.querySelectorAll('[data-playseg]').forEach(b => b.onclick = (e) => { e.stopPropagation(); const seg = S.segments.find(s => s.id === Number(b.dataset.playseg)); if (seg && S.video) { try { S.video.currentTime = seg.start; } catch (_) {} _play(); } });
  document.querySelectorAll('[data-fine]').forEach(d => d.onclick = () => { const segId = Number(d.dataset.fine); S.view = 'edit'; _render(); const w = S.words.find(x => x.segment_id === segId); if (w) { _markNow(w.id); document.querySelector(`.rv-w[data-id="${w.id}"]`)?.scrollIntoView({ block: 'center' }); } });
}
function _pickTake(segId) {
  const seg = S.segments.find(s => s.id === segId); if (!seg) return;
  const g = (seg.group_id != null && seg.group_id >= 0) ? seg.group_id : null;
  _snapshot();
  // keep this take's words; cut the other takes' words in the same beat
  for (const s of S.segments) {
    const sameBeat = g != null ? s.group_id === g : s.id === segId;
    if (!sameBeat) continue;
    const keep = s.id === segId;
    for (const w of _segWords(s.id)) { w.keep = keep; if (keep) w.reason = ''; else if (!w.reason) w.reason = 'retake'; }
  }
  _afterMutate(); _render();
}

// ── Transcript words + native selection ──────────────────────
function _renderWords() {
  const doc = $('#rv-doc'); if (!doc) return;
  // LANGUAGE-AGNOSTIC bidi: each line (segment) gets its OWN base direction from
  // the majority of its strong characters — not a global RTL, and not first-strong
  // (which flipped Urdu lines that began with an English word). Every word is an
  // isolated run with dir="auto", so an English word in the middle of an Arabic/
  // Hebrew/Urdu line — or a Roman word among CJK — sits in the right place and the
  // surrounding text doesn't reorder. Works for any language pair.
  const paras = []; let cur = -1, group = null;
  for (const w of S.words) {
    if (w.segment_id !== cur) { group = []; paras.push(group); cur = w.segment_id; }
    group.push(w);
  }
  let html = '';
  for (const group of paras) {
    const dir = _baseDir(group.map(w => w.text).join(' '));
    html += `<p class="rv-para" dir="${dir}">`;
    for (const w of group) {
      const isLatin = /[A-Za-z]/.test(w.text || '');   // render Latin in the UI font
      const cls = ['rv-w', w.keep ? '' : 'rv-w-cut', isLatin ? 'rv-en' : ''].join(' ').replace(/\s+/g, ' ').trim();
      const title = (!w.keep && w.reason) ? ` title="${_esc(_reason(w.reason))}"` : '';
      html += `<span class="${cls}" data-id="${w.id}" dir="auto"${title}>${_esc(w.text)}</span> `;
    }
    html += '</p>';
  }
  doc.innerHTML = html || '<p class="rv-dim" style="padding:12px">No words.</p>';
  _markNow(_lastNow);
}
// Majority-of-strong-characters base direction. RTL scripts: Hebrew, Arabic,
// Syriac, Thaana, Arabic Supplement/Extended, Arabic Presentation Forms.
function _baseDir(text) {
  const t = String(text || '');
  const rtl = (t.match(/[֐-׿؀-ۿ܀-ݏހ-޿ࢠ-ࣿיִ-﷿ﹰ-﻿]/g) || []).length;
  const ltr = (t.match(/[A-Za-zÀ-ɏЀ-ӿͰ-Ͽ]/g) || []).length; // Latin/Cyrillic/Greek
  return rtl > ltr ? 'rtl' : 'ltr';
}
function _bindDocEvents() {
  const doc = $('#rv-doc'); if (!doc) return;
  doc.onmouseup = (e) => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const range = sel.getRangeAt(0);
      const covered = [...doc.querySelectorAll('.rv-w')].filter(s => range.intersectsNode(s)).map(s => Number(s.dataset.id));
      if (covered.length) {
        _snapshot();
        const first = S.byId.get(covered[0]);
        const targetKeep = !(first && first.keep);
        for (const id of covered) { const w = S.byId.get(id); if (w) { w.keep = targetKeep; w.reason = targetKeep ? '' : (w.reason || 'manual'); } }
        _afterMutate();
      }
      sel.removeAllRanges();
    } else {
      const el = e.target?.closest?.('.rv-w'); if (el) { const id = Number(el.dataset.id); S.focusId = id; _seekWord(id, true); }
    }
  };
}

// ── Playback + karaoke ───────────────────────────────────────
// play() returns a promise that rejects ("interrupted by a call to pause()")
// when we seek/pause/reload before it resolves — benign, so swallow it here and
// stop it reaching the global error banner.
function _play() { const v = S.video; if (!v) return; try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
function _seekWord(id, play) { const w = S.byId.get(id); if (!w || !S.video) return; S.playMode = 'original'; S.focusId = id; try { S.video.currentTime = w.start; } catch (_) {} if (play) _play(); _markNow(id); }
function _playPause() { if (!S.video) return; if (S.video.paused) { S.playMode = 'original'; _play(); } else { try { S.video.pause(); } catch (_) {} S.playMode = 'idle'; } _syncPlayUI(); }
function _syncPlayUI() {
  const playing = S.video && !S.video.paused;
  const pp = document.querySelector('[data-act="playpause"]'); if (pp) pp.textContent = playing ? '❚❚' : '▶';
  document.querySelectorAll('[data-act="vidplay"]').forEach(b => b.textContent = playing ? '❚❚' : '▶');
  const wrap = $('#rv-vidwrap'); if (wrap) wrap.classList.toggle('playing', !!playing);
}
// Merge kept words into ranges the SAME way the backend `words_to_cuts` does, so
// the preview/readout match the actual build: index-consecutive (a cut word
// closes the range) AND within RV_MAX_GAP seconds — a longer pause between two
// kept words is dead air the build drops, so it starts a new range here too.
const RV_MAX_GAP = 0.35; // keep in sync with words_to_cuts(max_gap) in review_service.py
function _mergedKeptRanges() { const r = []; let c = null; for (const w of S.words) { if (w.keep) { if (c && (w.start - c[1]) <= RV_MAX_GAP) c[1] = w.end; else { if (c) r.push(c); c = [w.start, w.end]; } } else if (c) { r.push(c); c = null; } } if (c) r.push(c); return r; }
function _playPlan() { if (!S.video) return; S.planRanges = _mergedKeptRanges(); if (!S.planRanges.length) { _setStatus($('#rv-status'), 'Nothing kept to preview.', true); return; } S.planIdx = 0; S.playMode = 'plan'; try { S.video.currentTime = S.planRanges[0][0]; } catch (_) {} _play(); }
function _onTime() {
  if (!S.video) return; const t = S.video.currentTime;
  const tEl = $('#rv-time'); if (tEl) tEl.textContent = _fmtDur(t);
  _syncPlayUI();
  if (S.playMode === 'plan') { const r = S.planRanges[S.planIdx]; if (r && t >= r[1] - 0.02) { S.planIdx++; if (S.planIdx < S.planRanges.length) { try { S.video.currentTime = S.planRanges[S.planIdx][0]; } catch (_) {} } else { try { S.video.pause(); } catch (_) {} S.playMode = 'idle'; } } }
  _markNow(); _drawPlayhead();
}
function _currentWordId(t) { const a = S.words; if (!a.length) return null; let lo = 0, hi = a.length - 1, ans = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m].start <= t) { ans = m; lo = m + 1; } else hi = m - 1; } return a[ans]?.id ?? null; }
function _markNow(forceId) {
  const id = forceId != null ? forceId : (S.video ? _currentWordId(S.video.currentTime) : null);
  const doc = $('#rv-doc'); if (!doc) { _lastNow = id; return; }
  if (_lastNow != null) doc.querySelector(`.rv-w[data-id="${_lastNow}"]`)?.classList.remove('rv-w-now');
  _lastNow = id; if (id == null) return;
  const el = doc.querySelector(`.rv-w[data-id="${id}"]`); if (el) { el.classList.add('rv-w-now'); if (S.playMode !== 'idle') el.scrollIntoView({ block: 'nearest' }); }
}

// ── Waveform ─────────────────────────────────────────────────
async function _loadWaveform() { if (!S.reviewId) return; try { const r = await apiGet(`/api/review/waveform/${S.reviewId}`, { timeoutMs: 120000 }); S.peaks = r.peaks || []; if (r.duration) S.duration = r.duration; _drawWaveform(); } catch (_) {} }
function _bindWaveform() { const c = S.canvas; if (!c) return; c.onclick = (e) => { if (!S.video || !S.duration) return; const rect = c.getBoundingClientRect(); try { S.video.currentTime = Math.max(0, Math.min(S.duration, ((e.clientX - rect.left) / rect.width) * S.duration)); } catch (_) {} _onTime(); }; requestAnimationFrame(() => { _sizeCanvas(); _drawWaveform(); }); }
function _sizeCanvas() { const c = S.canvas; if (!c) return; const w = c.clientWidth || 360; if (c.width !== w) c.width = w; }
function _cssVar(n, f) { try { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f; } catch (_) { return f; } }
function _drawWaveform() {
  const c = S.canvas; if (!c) return; _sizeCanvas(); const ctx = c.getContext('2d'); const W = c.width, H = c.height; ctx.clearRect(0, 0, W, H);
  if (!S.peaks.length || !S.duration) return;
  const keep = _cssVar('--accent', '#0a84ff'), cut = _cssVar('--error', '#f25b5b'), mid = H / 2, cuts = _cutRanges();
  for (let x = 0; x < W; x++) { const t = (x / W) * S.duration; const amp = (S.peaks[Math.floor((x / W) * S.peaks.length)] || 0) * (mid - 2); const isCut = _inRanges(t, cuts); ctx.strokeStyle = isCut ? cut : keep; ctx.globalAlpha = isCut ? 0.35 : 0.9; ctx.beginPath(); ctx.moveTo(x + 0.5, mid - amp); ctx.lineTo(x + 0.5, mid + amp); ctx.stroke(); }
  ctx.globalAlpha = 1; _drawPlayhead();
}
function _cutRanges() { const r = []; let c = null; for (const w of S.words) { if (w.keep) { if (c) { r.push(c); c = null; } continue; } if (c && w.start - c[1] <= 0.05) c[1] = w.end; else { if (c) r.push(c); c = [w.start, w.end]; } } if (c) r.push(c); return r; }
function _inRanges(t, rs) { for (const [a, b] of rs) { if (t >= a && t <= b) return true; if (a > t) break; } return false; }
function _drawPlayhead() { const c = S.canvas; if (!c || !S.video || !S.duration) return; const ctx = c.getContext('2d'); const x = (S.video.currentTime / S.duration) * c.width; ctx.save(); ctx.strokeStyle = _cssVar('--text-bright', '#e0e0e0'); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, c.height); ctx.stroke(); ctx.restore(); }

// ── Splitters (workspace resize) ─────────────────────────────
function _bindSplitters() {
  const col = document.querySelector('[data-split="col"]');
  if (col) col.onmousedown = (e) => _startDrag(e, 'col');
  const row = document.querySelector('[data-split="row"]');
  if (row) row.onmousedown = (e) => _startDrag(e, 'row');
}
function _startDrag(e, kind) {
  e.preventDefault();
  const left = $('#rv-left'); const vp = $('#rv-videopane');
  const move = (ev) => {
    if (kind === 'col' && left) { const w = Math.max(220, Math.min(720, ev.clientX - left.getBoundingClientRect().left)); left.style.width = w + 'px'; S.leftWidth = w; }
    if (kind === 'row' && vp) { const h = Math.max(120, Math.min(520, ev.clientY - vp.getBoundingClientRect().top)); vp.style.height = h + 'px'; vp.style.flex = 'none'; S.videoHeight = h; _sizeCanvas(); _drawWaveform(); }
  };
  const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
}

// ── Clean up / mutate / undo ─────────────────────────────────
function _snapshot() { S.undo.push(S.words.map(w => (w.keep ? 1 : 0))); if (S.undo.length > 100) S.undo.shift(); S.redo = []; }
function _applySnap(s) { s.forEach((k, i) => { if (S.words[i]) S.words[i].keep = !!k; }); }
function _undo() { if (!S.undo.length) return; S.redo.push(S.words.map(w => (w.keep ? 1 : 0))); _applySnap(S.undo.pop()); _afterMutate(); }
function _redo() { if (!S.redo.length) return; S.undo.push(S.words.map(w => (w.keep ? 1 : 0))); _applySnap(S.redo.pop()); _afterMutate(); }
function _afterMutate() { _renderWords(); _updateReadout(); _drawWaveform(); _renderPlanList(); }
function _quickCut(kind) {
  _snapshot();
  if (kind === 'restore') { S.words.forEach(w => { w.keep = true; w.reason = ''; }); }
  else {
    const fillers = new Set(['umm', 'um', 'uh', 'uhh', 'ah', 'hmm', 'haan', 'han', 'ji', 'hanji', 'ہاں', 'جی', 'ہانجی', 'اہ', 'ام']);
    for (const w of S.words) {
      const raw = (w.text || '').trim();
      const norm = raw.replace(/[^\w؀-ۿ]/g, '').toLowerCase();
      if (kind === 'filler' && fillers.has(norm)) { w.keep = false; w.reason = 'filler'; }
      else if (kind === 'nonspeech' && /^[\[(\{].*[\])\}]$/.test(raw)) { w.keep = false; w.reason = 'non_speech'; }
      else if (kind === 'retake' && raw.endsWith('--')) { w.keep = false; w.reason = 'false_start'; }
    }
  }
  _afterMutate();
}

// ── Suggest (with Cancel) + Build ────────────────────────────
async function _suggest() {
  if (!S.reviewId || S.busy) return;
  const useLlm = !!$('#rv-usellm')?.checked; const status = $('#rv-status');
  S.busy = true;
  try { S.modelName = await _fetchModelName(); const ml = $('#rv-modellabel'); if (ml) ml.textContent = S.modelName ? `Use AI (${S.modelName})` : 'Use AI'; } catch (_) {}
  _snapshot();
  // swap the Suggest button for a progress + Cancel chip
  const sb = document.querySelector('[data-act="suggest"]');
  if (sb) { sb.dataset.label = sb.textContent; sb.outerHTML = `<span class="rv-airun"><span class="rv-spin"></span>Suggesting…<button class="rv-btn rv-tiny rv-cancel" data-act="cancelai">Cancel</button></span>`; }
  document.querySelector('[data-act="cancelai"]')?.addEventListener('click', () => { try { S.aiAbort?.abort(); } catch (_) {} });
  _setStatus(status, useLlm ? `Marking junk + asking ${S.modelName || 'the model'} about off-script lines…` : 'Marking junk (retakes, filler, non-speech)…');
  try {
    S.aiAbort = new AbortController();
    const resp = await _fetchJSON('/api/review/suggest', { review_id: S.reviewId, use_llm: useLlm, debug: S.debug }, S.aiAbort.signal, 300000);
    if (resp.words) _setData(resp);
    S.lastTrace = resp.trace || null;
    _afterMutate();
    if (S.debug) _render();   // surface/refresh the trace drawer
    const su = resp.word_summary || {};
    _setStatus(status, `Suggested: keep ${su.kept_words ?? '?'} words in ${su.cuts ?? '?'} span(s)${resp.llm_used ? ' (AI refined)' : ''}.`);
  } catch (err) {
    _setStatus(status, (err.name === 'AbortError') ? 'AI suggestion cancelled.' : `Suggest failed: ${err.message || err}`, true);
  } finally { S.busy = false; S.aiAbort = null; _restoreSuggestBtn(); }
}
function _restoreSuggestBtn() {
  const run = document.querySelector('.rv-airun');
  if (run) run.outerHTML = `<button class="rv-btn" data-act="suggest">Suggest</button>`;
  const sb = document.querySelector('[data-act="suggest"]'); if (sb) sb.onclick = _suggest;
}
async function _build() {
  if (!S.reviewId || S.busy) return; const status = $('#rv-status');
  const keptWordIds = S.words.filter(w => w.keep).map(w => w.id);
  if (!keptWordIds.length) { _setStatus(status, 'Nothing kept — keep some words first.', true); return; }
  S.busy = true; _setStatus(status, `Building a tight cut from ${_mergedKeptRanges().length} span(s)…`);
  try { const built = await apiPost('/api/review/build', { review_id: S.reviewId, kept_word_ids: keptWordIds }, { timeoutMs: 120000 }); if (!built.plan_id) throw new Error('No plan_id'); await _applyPlanId(built.plan_id, status); }
  catch (e) { _setStatus(status, `Build failed: ${e.message || e}`, true); }
  finally { S.busy = false; }
}
async function _applyPlanId(planId, status) {
  _setStatus(status, 'Placing clips in Premiere…');
  const applyResult = await apiPost(`/api/edit/plan/${planId}/apply`, {}, { timeoutMs: 120000 });
  const ops = applyResult.extendscript_ops || []; const seqName = applyResult.target_sequence_name || 'EditFlow Cut';
  if (isExtendScriptAvailable()) { await callExtendScript('processEDL', JSON.stringify({ ops })); _setStatus(status, `Done — "${seqName}" is in your project.`); }
  else _setStatus(status, `Plan built (${ops.length} ops). Open the panel inside Premiere to place clips.`);
}

// ── Readout / keyboard / helpers ─────────────────────────────
function _updateReadout() {
  const el = $('#rv-readout'); const ranges = _mergedKeptRanges();
  const dur = ranges.reduce((s, r) => s + (r[1] - r[0]), 0); const kept = S.words.filter(w => w.keep).length;
  if (el) el.textContent = `${kept}/${S.words.length} · ${ranges.length} cut${ranges.length === 1 ? '' : 's'} · ${_fmtDur(dur)}`;
  const preview = document.querySelector('[data-act="preview"]');
  if (preview) { const has = S.words.some(w => !w.keep); preview.disabled = !has; preview.style.opacity = has ? '' : '0.4'; preview.title = has ? 'Preview the cut (Enter)' : 'Make some cuts first'; }
}
function _bindKeys() {
  if (_keysBound) return; _keysBound = true;
  document.addEventListener('keydown', (e) => {
    const v = $('#review-view'); if (!v || v.classList.contains('hidden')) return;
    const tag = document.activeElement?.tagName || ''; if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const k = e.key;
    if (k === ' ') { e.preventDefault(); _playPause(); }
    else if (k === 'Enter') { e.preventDefault(); _playPlan(); }
    else if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'Z') && !e.shiftKey) { e.preventDefault(); _undo(); }
    else if ((e.ctrlKey || e.metaKey) && (k === 'y' || k === 'Y' || ((k === 'z' || k === 'Z') && e.shiftKey))) { e.preventDefault(); _redo(); }
    else if (k === 'Escape') { window.getSelection()?.removeAllRanges(); }
  });
  // Returning to the panel (tab/app refocus) should freshen the model label.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    const v = $('#review-view'); if (v && !v.classList.contains('hidden')) _refreshModelLabel();
  });
}
async function _fetchJSON(path, body, signal, timeoutMs) {
  const ctrl = signal ? null : new AbortController();
  const t = setTimeout(() => (signal ? null : ctrl.abort()), timeoutMs || 60000);
  try {
    const res = await fetch(getBaseUrl() + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: signal || ctrl.signal });
    clearTimeout(t); if (!res.ok) throw new Error(`${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`); return await res.json();
  } catch (e) { clearTimeout(t); throw e; }
}
async function _fetchModelName() { try { const st = await apiGet('/api/status', { timeoutMs: 4000 }); const m = st?.active_chat; if (typeof m === 'string') return m; if (m && (m.model || m.name)) return m.model || m.name; } catch (_) {} return ''; }
function _guessSourceFromScan() { try { const scan = getState()?.session?.scan || null; const items = scan && (scan.items || scan.clips); if (Array.isArray(items)) { const a = items.find(it => /\.(mov|mp4|m4v|wav|mp3|m4a|aac)$/i.test(it.mediaPath || it.media_path || '')); if (a) return a.mediaPath || a.media_path; } } catch (_) {} return ''; }
function _reason(r) { if (!r) return ''; if (r.startsWith('retake')) return 'retake'; return ({ non_speech: 'non-speech', filler: 'filler', too_short: 'too short', not_in_script: 'off-script', false_start: 'false start', manual: 'cut', llm_off_script: 'off-script' })[r] || r; }
function _setStatus(el, msg, isErr) { if (el) { el.textContent = msg; el.classList.toggle('rv-error', !!isErr); } }
function _fmtDur(s) { s = Number(s) || 0; const m = Math.floor(s / 60); const x = Math.round(s % 60); return `${m}:${x.toString().padStart(2, '0')}`; }
function _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

export { openReview, closeReview };
