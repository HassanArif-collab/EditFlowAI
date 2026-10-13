/**
 * captions-view.js — EditFlow Captions Studio for Premiere Pro.
 *
 *   Transcript → Style → Motion → Export
 *
 * The live preview is drawn by the SAME renderer as the exported video
 * (captions/render.js), at the sequence's real size and frame rate, so the
 * preview is the output. Export streams frames to the backend encoder and
 * places the file with captionsManager.placeOverlay (overwrite onto a free
 * track, replacing earlier EditFlow captions — never a ripple insert).
 *
 * Every control is declared with data-bind="section.key" and handled by ONE
 * input handler, so a control cannot silently do nothing.
 */
import { apiGet, apiPost, apiUpload, getBaseUrl } from './api.js';
import { isExtendScriptAvailable, callExtendScript } from './extendscript.js';
import * as M from './captions/model.js';
import { drawFrame, STYLE_DEFAULTS } from './captions/render.js';
import { BUNDLED, ensureFont, makeMeasurer, listSystemFonts, injectFontStyles, weightName } from './captions/fonts.js';
import { PRESETS, findPreset } from './captions/presets.js';
import { renderOverlay } from './captions/export.js';
import { SAFE_ZONES, drawSafeZones } from './captions/safe-zones.js';

const SETTINGS_KEY = 'editflow.captions.settings.v3';
const SETTINGS_KEY_V2 = 'editflow.captions.settings.v2';
const WORDS_KEY = 'editflow.captions.words.';
const REF = 1080;   // style sizes are authored at 1080p and scale with the sequence

const DEFAULTS = {
  preset: 'clean',
  previewAspect: '9:16',
  style: Object.assign({}, STYLE_DEFAULTS),
  motion: Object.assign({}, M.MOTION_DEFAULTS),
  layout: { posX: 50, posY: 72, boxWidth: 86, lineHeight: 1.12, align: 'center' },
  grouping: Object.assign({}, M.GROUP_DEFAULTS),
  timing: Object.assign({}, M.TIMING_DEFAULTS),
  output: { codec: 'prores' },
  transcribe: { language: 'en', engine: 'auto' },
};

const PREVIEW_SEQ = { name: 'Preview', id: 'preview', width: 1080, height: 1920,
                      fps: { num: 30, den: 1 }, duration: 0, live: false };

const S = {
  settings: null,
  words: [],
  sourceName: '',
  seq: PREVIEW_SEQ,
  scene: null,
  sceneGen: 0,
  fontKey: '',
  fontOk: true,
  sel: -1,
  tab: 'transcript',
  t: 0,
  playing: false,
  bg: 'checker',
  safe: 'off',
  previewOpen: true,
  bgImage: null,
  busy: null,          // { kind, label, progress (0..1 | null), cancel() }
  status: null,        // { text, kind }
  history: [],
  future: [],
  lastRender: null,
  srtPath: '',
  systemFonts: [],
  showSource: false,
  pasteOpen: false,
  findOpen: false,
  editing: -1,
  drag: null,
  hoverBox: false,
  prevView: null,
  previewZoom: 1.0,
  previewHeight: null,
  useInOut: true,
};

let root = null;
let rafId = 0;
let lastTick = 0;
let saveTimer = 0;

/* ── tiny helpers ─────────────────────────────────────────────── */

const $ = (sel, r) => (r || root || document).querySelector(sel);
const $$ = (sel, r) => Array.prototype.slice.call((r || root || document).querySelectorAll(sel));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj); }
function setPath(obj, path, v) {
  const ks = path.split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]] = o[ks[i]] || {};
  o[ks[ks.length - 1]] = v;
}
function fmtTime(s) {
  if (!isFinite(s) || s < 0) return '0:00.0';
  const tenths = Math.round(s * 10);
  const m = Math.floor(tenths / 600);
  const remSec = Math.floor((tenths % 600) / 10);
  const remTenths = tenths % 10;
  return m + ':' + (remSec < 10 ? '0' : '') + remSec + '.' + remTenths;
}
function fmtNum(v) { return Math.round(Number(v) * 100) / 100; }
function deepMerge(base, over) {
  const out = Object.assign({}, base);
  for (const k of Object.keys(over || {})) {
    const b = base ? base[k] : undefined, o = over[k];
    out[k] = (b && typeof b === 'object' && !Array.isArray(b) && o && typeof o === 'object') ? deepMerge(b, o) : o;
  }
  return out;
}
function inCEP() { return isExtendScriptAvailable(); }

const ICONS = {
  play: '<path d="M8 5v14l11-7z"/>',
  pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>',
  undo: '<path d="M12.5 8C9.9 8 7.5 9 5.7 10.6L2 7v9h9l-3.6-3.6A7 7 0 0 1 19.3 15l2.4-.8A9.5 9.5 0 0 0 12.5 8z"/>',
  redo: '<path d="M18.4 10.6A9.4 9.4 0 0 0 11.5 8a9.5 9.5 0 0 0-9.2 6.2l2.4.8A7 7 0 0 1 16.6 12.4L13 16h9V7z"/>',
  eye: '<path d="M12 5C6.5 5 2.7 9.3 1.5 12c1.2 2.7 5 7 10.5 7s9.3-4.3 10.5-7C21.3 9.3 17.5 5 12 5zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"/>',
  bg: '<path d="M3 3h8v8H3zM13 13h8v8h-8z"/><path d="M13 3h8v8h-8zM3 13h8v8H3z" opacity=".35"/>',
  camera: '<path d="M9 3L7.17 5H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2h-3.17L15 3H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>',
  close: '<path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z"/>',
  mic: '<path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-2.1A7 7 0 0 0 19 12z"/>',
  refresh: '<path d="M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.8-4.2L13 11h7V4z"/>',
  search: '<path d="M15.5 14h-.8l-.3-.3A6.5 6.5 0 1 0 14 15.5l.3.3v.8l5 5 1.5-1.5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z"/>',
};
const icon = (n) => `<svg class="cc-ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;

/* ── settings + words persistence ─────────────────────────────── */

function loadSettings() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (!saved) {
      saved = JSON.parse(localStorage.getItem(SETTINGS_KEY_V2) || 'null');
    }
  } catch (_) { saved = null; }
  return deepMerge(DEFAULTS, saved || {});
}
function saveSettingsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S.settings)); } catch (_) { /* quota */ }
  }, 250);
}
function wordsKey() { return WORDS_KEY + (S.seq && S.seq.id ? S.seq.id : 'default'); }
function saveWords() {
  try {
    if (S.words.length) localStorage.setItem(wordsKey(), JSON.stringify(S.words));
    else localStorage.removeItem(wordsKey());
  } catch (_) { /* quota — words still live in memory */ }
}
function loadWords() {
  try { S.words = JSON.parse(localStorage.getItem(wordsKey()) || '[]') || []; } catch (_) { S.words = []; }
  S.sel = -1; S.history = []; S.future = []; S.editing = -1;
}

/* ── effective settings (style scaled to the sequence) ────────── */

function scaleK() { return Math.min(S.seq.width, S.seq.height) / REF; }
function effSettings() {
  const k = scaleK();
  const st = Object.assign({}, S.settings.style);
  st.fontSize = (st.fontSize || 80) * k;
  st.strokeWidth = (st.strokeWidth || 0) * k;
  st.shadowBlur = (st.shadowBlur || 0) * k;
  st.shadowDistance = (st.shadowDistance || 0) * k;
  return { style: st, motion: S.settings.motion, layout: S.settings.layout,
           grouping: S.settings.grouping, timing: S.settings.timing };
}

/* ── scene ────────────────────────────────────────────────────── */

async function rebuildScene() {
  const gen = ++S.sceneGen;
  const eff = effSettings();
  const key = eff.style.fontFamily + '|' + eff.style.fontWeight;
  if (key !== S.fontKey) {
    S.fontOk = await ensureFont(eff.style.fontFamily, eff.style.fontWeight);
    if (gen !== S.sceneGen) return;
    S.fontKey = S.fontOk ? key : '';      // re-check a missing font next time
    const warn = $('#cc-font-warn');
    if (warn) warn.classList.toggle('hidden', S.fontOk);
  }
  const ms = makeMeasurer(eff.style);
  S.scene = M.buildScene(S.words, eff, {
    width: S.seq.width, height: S.seq.height, fps: S.seq.fps,
    measure: ms.measure, fontMetrics: ms.fontMetrics,
  });
  if (S.t > S.scene.duration) S.t = 0;
  requestDraw();
  updateTransport();
  if (S.tab === 'transcript') renderTranscriptList();
  updateFooter();
}
let sceneTimer = 0;
function scheduleScene() {
  clearTimeout(sceneTimer);
  sceneTimer = setTimeout(() => { rebuildScene(); }, 16);
}

/* ── open / close ─────────────────────────────────────────────── */

function openCaptions() {
  injectFontStyles();
  ensureStyles();
  const view = ensureContainer();
  const hero = document.getElementById('hero');
  const chat = document.getElementById('chat-scroll');
  const footer = document.getElementById('app-footer');
  S.prevView = {
    hero: hero ? hero.classList.contains('hidden') : true,
    chat: chat ? chat.classList.contains('hidden') : true,
    footer: footer ? footer.classList.contains('hidden') : true,
  };
  [hero, chat, footer].forEach((el) => el && el.classList.add('hidden'));
  view.classList.remove('hidden');
  if (!S.settings) {
    S.settings = loadSettings();
    renderShell();
    bindEvents();
    loadWords();
    listSystemFonts(apiGet).then((f) => { S.systemFonts = f; if (S.tab === 'style') renderBody(); });
    window.addEventListener('editflow:ws', onWsMessage);
    renderBody();
    refreshSequence(true);
  } else {
    renderBody();
    refreshSequence(false);
  }
}

function closeCaptions() {
  const view = document.getElementById('captions-view');
  if (view) view.classList.add('hidden');
  setPlaying(false);
  try { localStorage.setItem('editflow_home_view', 'chat'); } catch (_) {}
  const map = { hero: 'hero', chat: 'chat-scroll', footer: 'app-footer' };
  if (S.prevView) {
    for (const k of Object.keys(map)) {
      const el = document.getElementById(map[k]);
      if (el) el.classList.toggle('hidden', S.prevView[k]);
    }
  }
}

function ensureStyles() {
  if (document.getElementById('cc-style-link')) return;
  const link = document.createElement('link');
  link.id = 'cc-style-link';
  link.rel = 'stylesheet';
  link.href = 'styles/captions.css?v=' + Date.now();
  document.head.appendChild(link);
}

function ensureContainer() {
  let v = document.getElementById('captions-view');
  if (!v) {
    v = document.createElement('div');
    v.id = 'captions-view';
    v.className = 'cc-view hidden';
    (document.getElementById('app-main') || document.body).appendChild(v);
  }
  root = v;
  return v;
}

/* ── sequence ─────────────────────────────────────────────────── */

async function callCM(fn, args) {
  return callExtendScript('callModule', Object.assign({ module: 'captionsManager', fn }, args || {}));
}

async function refreshSequence(first) {
  const prevId = S.seq.id;
  if (inCEP()) {
    try {
      const info = await callCM('sequenceInfo');
      S.seq = {
        name: info.name, id: info.id || info.name, width: Math.round(info.width) || 1080,
        height: Math.round(info.height) || 1920,
        fps: info.timebase ? M.fpsFromTicks(info.timebase) : M.fpsFromNumber(info.fps),
        duration: info.duration || 0, playhead: info.playhead || 0, live: true,
        inPoint: info.inPoint != null ? info.inPoint : 0,
        outPoint: info.outPoint != null ? info.outPoint : (info.duration || 0),
        hasInOut: !!info.hasInOut,
      };
    } catch (e) {
      S.seq = Object.assign({}, PREVIEW_SEQ, { error: String((e && e.message) || e) });
    }
  } else {
    const parts = String(S.settings.previewAspect || '9:16').split(':').map(Number);
    const w = parts[0] >= parts[1] ? 1920 : 1080;
    S.seq = Object.assign({}, PREVIEW_SEQ, { width: w, height: Math.round((w * parts[1]) / parts[0]) });
  }
  if (first || S.seq.id !== prevId) {
    loadWords();
    renderBody();
  }
  renderSeqChip();
  layoutPreview();
  rebuildScene();
}

function renderSeqChip() {
  const el = $('#cc-seq');
  if (!el) return;
  const f = S.seq.fps;
  const fps = Math.round((f.num / f.den) * 1000) / 1000;
  const inOutBadge = S.seq.hasInOut
    ? ` · <span style="color:var(--cc-accent-2,#69a9ff)">In/Out: ${fmtTime(S.seq.inPoint)}–${fmtTime(S.seq.outPoint)}</span>`
    : '';
  el.innerHTML = S.seq.live
    ? `<b>${esc(S.seq.name)}</b> · ${S.seq.width}×${S.seq.height} · ${fps} fps${inOutBadge}`
    : (S.seq.error ? '<span class="cc-warn-text">No sequence open</span>'
      : '<span class="cc-dim">Preview mode</span>');
  el.title = S.seq.error || (S.seq.live ? (S.seq.hasInOut ? `Sequence has In/Out set: ${fmtTime(S.seq.inPoint)} to ${fmtTime(S.seq.outPoint)}` : '')
    : 'Not connected to Premiere — rendering works, placing on the timeline does not.');
}

/* ── shell ────────────────────────────────────────────────────── */

const TABS = [['transcript', 'Transcript'], ['style', 'Style'], ['motion', 'Motion'], ['export', 'Export']];

function renderShell() {
  root.innerHTML = `
    <div class="cc-top">
      <div class="cc-title">Captions 3.0</div>
      <div class="cc-seq" id="cc-seq"></div>
      <button class="cc-icon-btn" data-act="refresh-seq" title="Re-read the active sequence">${icon('refresh')}</button>
      <button class="cc-icon-btn" data-act="close" title="Close captions">${icon('close')}</button>
    </div>
    <div class="cc-stage" id="cc-stage">
      <div class="cc-canvas-wrap" id="cc-canvas-wrap"><canvas id="cc-canvas"></canvas></div>
    </div>
    <div class="cc-stage-resizer" id="cc-stage-resizer" title="Drag up or down to resize preview"></div>
    <div class="cc-transport">
      <button class="cc-icon-btn cc-play" data-act="play" title="Play / pause (Space)">${icon('play')}</button>
      <span class="cc-time" id="cc-time">0:00.0</span>
      <input type="range" class="cc-scrub" id="cc-scrub" min="0" max="1" step="0.001" value="0" aria-label="Preview time">
      <span class="cc-time cc-dur" id="cc-dur">0:00.0</span>
      <button class="cc-icon-btn" data-act="capture-frame" title="Grab current sequence frame as background">${icon('camera')}</button>
      <button class="cc-icon-btn" data-act="bg" title="Cycle preview background (Frame / Dark / Checker)">${icon('bg')}</button>
      <div class="cc-zoom-wrap">
        <button class="cc-icon-btn cc-small" data-act="zoom-out" title="Zoom out">−</button>
        <span class="cc-zoom-val" id="cc-zoom-val" data-act="zoom-reset" title="Click to reset zoom (Fit)">Fit</span>
        <button class="cc-icon-btn cc-small" data-act="zoom-in" title="Zoom in">+</button>
      </div>
      <select class="cc-mini-select" id="cc-safe" title="Show where TikTok / Reels / Shorts buttons cover the video">
        <option value="off">Safe zone</option>
        ${Object.keys(SAFE_ZONES).map((k) => `<option value="${k}">${SAFE_ZONES[k].label}</option>`).join('')}
      </select>
      <button class="cc-icon-btn" data-act="toggle-preview" title="Hide / show the preview">${icon('eye')}</button>
    </div>
    <div class="cc-tabs" role="tablist">${TABS.map(([id, label]) =>
      `<button class="cc-tab" role="tab" data-tab="${id}">${label}</button>`).join('')}</div>
    <div class="cc-body" id="cc-body"></div>
    <div class="cc-status hidden" id="cc-status"></div>
    <div class="cc-footer" id="cc-footer"></div>
    <input type="file" id="cc-file" accept="audio/*,video/*" class="hidden">`;
  if (window.ResizeObserver) {
    let lastW = 0;
    new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (w === lastW) return;
      lastW = w;
      requestAnimationFrame(layoutPreview);
    }).observe($('#cc-stage'));
  }
  window.addEventListener('resize', () => requestAnimationFrame(layoutPreview));
  bindResizer();
}

/* ── preview & zoom ───────────────────────────────────────────── */

function layoutPreview() {
  const stage = $('#cc-stage');
  const cv = $('#cc-canvas');
  if (!stage || !cv) return;
  stage.classList.toggle('hidden', !S.previewOpen);
  const resizer = $('#cc-stage-resizer');
  if (resizer) resizer.classList.toggle('hidden', !S.previewOpen);
  if (!S.previewOpen) return;

  const userH = S.previewHeight || (S.settings && S.settings.previewHeight);
  const baseH = userH ? Math.max(90, Math.min((root.clientHeight || 600) * 0.78, userH))
                      : Math.max(120, Math.min(560, (root.clientHeight || 600) * 0.34));
  stage.style.height = Math.round(baseH) + 'px';

  const avW = Math.max(120, stage.clientWidth - 16);
  const avH = Math.max(80, baseH - 16);
  const ar = S.seq.width / S.seq.height;
  let w = avW, h = w / ar;
  if (h > avH) { h = avH; w = h * ar; }

  const zoom = S.previewZoom || 1.0;
  const dpr = window.devicePixelRatio || 1;
  const dispW = Math.round(w * zoom);
  const dispH = Math.round(h * zoom);

  cv.style.width = dispW + 'px';
  cv.style.height = dispH + 'px';
  cv.width = Math.round(dispW * dpr);
  cv.height = Math.round(dispH * dpr);

  const zEl = $('#cc-zoom-val');
  if (zEl) zEl.textContent = zoom === 1.0 ? 'Fit' : `${Math.round(zoom * 100)}%`;

  requestDraw();
}

function bindResizer() {
  const resizer = $('#cc-stage-resizer');
  if (!resizer) return;
  let startY = 0, startH = 0;
  const onMove = (e) => {
    const dy = e.clientY - startY;
    const newH = Math.max(90, Math.min((root.clientHeight || 600) * 0.78, startH + dy));
    S.previewHeight = newH;
    if (S.settings) S.settings.previewHeight = newH;
    layoutPreview();
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    resizer.classList.remove('cc-resizing');
    saveSettingsSoon();
  };
  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    startY = e.clientY;
    startH = ($('#cc-stage') || {}).clientHeight || (root.clientHeight * 0.34);
    resizer.classList.add('cc-resizing');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

const ZOOM_LEVELS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0];
function changeZoom(delta) {
  const cur = S.previewZoom || 1.0;
  if (delta === 0) {
    S.previewZoom = 1.0;
  } else if (delta > 0) {
    const next = ZOOM_LEVELS.find((z) => z > cur + 0.01);
    S.previewZoom = next || 3.0;
  } else {
    const prev = [...ZOOM_LEVELS].reverse().find((z) => z < cur - 0.01);
    S.previewZoom = prev || 0.5;
  }
  layoutPreview();
}

async function captureSequenceFrame() {
  if (!inCEP()) {
    setStatus('Frame capture requires an active Premiere Pro sequence.', 'info');
    return;
  }
  setStatus('Grabbing sequence frame…', 'info');
  try {
    const curTime = S.t || S.seq.playhead || 0;
    const res = await callCM('captureSequenceFrame', { time: curTime });
    if (!res || !res.success) {
      throw new Error((res && res.error) || 'Failed to capture frame from Premiere.');
    }
    let url = '';
    if (res.method === 'exportFramePNG' && res.path) {
      const r = await apiPost('/api/captions/sequence-frame', {
        frame_path: res.path, width: S.seq.width, height: S.seq.height
      });
      url = r.url;
    } else if (res.method === 'sourceClip' && res.clipPath) {
      const r = await apiPost('/api/captions/sequence-frame', {
        clip_path: res.clipPath,
        source_time: res.sourceTime,
        width: S.seq.width,
        height: S.seq.height
      });
      url = r.url;
    }
    if (url) {
      const im = new Image();
      im.onload = () => {
        S.bgImage = im;
        S.bg = 'frame';
        requestDraw();
        setStatus(`Frame captured at ${fmtTime(curTime)}.`, 'ok');
      };
      im.src = getBaseUrl() + url;
    } else {
      throw new Error('No frame image returned');
    }
  } catch (err) {
    setStatus('Could not grab sequence frame: ' + formatUserError(err), 'error');
  }
}

let drawQueued = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; drawPreview(); });
}

let checker = null;
function drawPreview() {
  const cv = $('#cc-canvas');
  if (!cv || !S.previewOpen || !cv.width) return;
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (S.bg === 'frame' && S.bgImage && S.bgImage.complete && S.bgImage.naturalWidth) {
    const im = S.bgImage, s = Math.max(W / im.naturalWidth, H / im.naturalHeight);
    ctx.drawImage(im, (W - im.naturalWidth * s) / 2, (H - im.naturalHeight * s) / 2, im.naturalWidth * s, im.naturalHeight * s);
  } else if (S.bg === 'dark') {
    ctx.fillStyle = '#101010';
    ctx.fillRect(0, 0, W, H);
  } else {
    if (!checker) {
      const c = document.createElement('canvas');
      c.width = c.height = 32;
      const x = c.getContext('2d');
      x.fillStyle = '#2b2b2b'; x.fillRect(0, 0, 32, 32);
      x.fillStyle = '#363636'; x.fillRect(0, 0, 16, 16); x.fillRect(16, 16, 16, 16);
      checker = ctx.createPattern(c, 'repeat');
    }
    ctx.fillStyle = checker;
    ctx.fillRect(0, 0, W, H);
  }
  if (S.scene) drawFrame(ctx, S.scene, effSettings(), S.t, { scale: W / S.seq.width, clear: false });
  if (S.safe !== 'off' && S.seq.height > S.seq.width) drawSafeZones(ctx, W, H, S.safe);
  if (S.drag || S.hoverBox) {
    const lay = S.settings.layout, k = W / S.seq.width;
    const bw = S.seq.width * lay.boxWidth / 100 * k;
    const fs = S.settings.style.fontSize * scaleK() * k;
    const bh = fs * (lay.lineHeight || 1.12) * Math.max(1, S.settings.grouping.maxLines || 1);
    const cx = S.seq.width * lay.posX / 100 * k, cy = S.seq.height * lay.posY / 100 * k;
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(80,160,255,.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - bw / 2 + 0.5, cy - bh / 2 + 0.5, bw, bh);
    ctx.restore();
  }
  if (!S.words.length) {
    const dpr = window.devicePixelRatio || 1;
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.font = `${Math.round(12 * dpr)}px "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('Your captions preview here', W / 2, H / 2);
    ctx.textAlign = 'left';
  }
}

function tick(now) {
  rafId = 0;
  if (!S.playing) return;
  const rawDt = lastTick ? (now - lastTick) / 1000 : 0;
  const dt = Math.min(0.1, Math.max(0, rawDt));
  lastTick = now;
  const dur = S.scene ? S.scene.duration : 0;
  S.t += dt;
  if (dur > 0 && S.t > dur) S.t = 0;          // loop: handy while styling
  drawPreview();
  updateTransport();
  highlightPlayingWord();
  rafId = requestAnimationFrame(tick);
}
function setPlaying(on) {
  const next = !!on && !!(S.scene && S.scene.duration);
  if (S.playing === next) return;
  S.playing = next;
  const b = $('[data-act="play"]');
  if (b) b.innerHTML = icon(S.playing ? 'pause' : 'play');
  if (S.playing) {
    lastTick = 0;
    if (!rafId) rafId = requestAnimationFrame(tick);
  } else {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    lastTick = 0;
  }
}
function seek(t) {
  S.t = clamp(t, 0, S.scene ? S.scene.duration : 0);
  requestDraw();
  updateTransport();
  highlightPlayingWord();
}
function updateTransport() {
  const dur = S.scene ? S.scene.duration : 0;
  const tEl = $('#cc-time'), dEl = $('#cc-dur'), sc = $('#cc-scrub');
  if (tEl) tEl.textContent = fmtTime(S.t);
  if (dEl) dEl.textContent = fmtTime(dur);
  if (sc && document.activeElement !== sc) { sc.max = String(dur || 1); sc.value = String(S.t); }
}
let lastPlayingWord = -1;
function highlightPlayingWord() {
  if (S.tab !== 'transcript') return;
  let idx = -1;
  for (let i = 0; i < S.words.length; i++) { if (S.words[i].start <= S.t) idx = i; else break; }
  if (idx === lastPlayingWord) return;
  const prev = $(`.cc-w[data-i="${lastPlayingWord}"]`);
  if (prev) prev.classList.remove('cc-now');
  const cur = $(`.cc-w[data-i="${idx}"]`);
  if (cur) {
    cur.classList.add('cc-now');
    if (S.playing && cur.scrollIntoView) {
      cur.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
  lastPlayingWord = idx;
}

/* ── status + footer ──────────────────────────────────────────── */

function formatUserError(err) {
  if (!err) return 'An unknown error occurred.';
  let msg = '';
  if (typeof err === 'string') {
    msg = err;
  } else if (err.message) {
    msg = err.message;
  } else if (err.detail) {
    msg = typeof err.detail === 'string' ? err.detail : (err.detail.message || JSON.stringify(err.detail));
  } else if (err.error) {
    msg = typeof err.error === 'string' ? err.error : JSON.stringify(err.error);
  } else {
    try { msg = JSON.stringify(err); } catch (_) { msg = String(err); }
  }

  // Strip JSON detail wrapper if message has it (e.g. '{"detail":"..."}')
  const detailMatch = msg.match(/\{"detail"\s*:\s*"([^"]+)"\}/);
  if (detailMatch) {
    msg = detailMatch[1];
  }

  // Strip HTTP method and status prefix if present (e.g. 'POST /api/... → 404: ...')
  msg = msg.replace(/^(?:GET|POST|PUT|DELETE)\s+\S+\s+→\s+\d+:\s*/i, '');

  // Strip raw FFmpeg hex pointers and bracketed stream tags
  msg = msg.replace(/\[[a-zA-Z0-9_#:\/\.\s\-]+@\s*(?:0x)?[0-9a-fA-F]+\]/g, '');
  msg = msg.replace(/@\s*(?:0x)?[0-9a-fA-F]{6,}/g, '');

  // Connection refused / backend offline
  if (/Failed to fetch|NetworkError|ECONNREFUSED|Connection refused/i.test(msg)) {
    return 'Cannot connect to EditFlow backend. Please make sure the backend is running.';
  }

  // GPU memory full
  if (/CUDA out of memory|GPU memory is full/i.test(msg)) {
    return 'GPU memory is full. Please switch to CPU in Whisper settings or close other GPU apps.';
  }

  // Clean redundant whitespace and linebreaks
  msg = msg.replace(/\s+/g, ' ').trim();

  if (!msg) return 'Operation failed.';
  return msg.length > 260 ? msg.slice(0, 257) + '…' : msg;
}

let statusTimer = 0;
function setStatus(text, kind) {
  S.status = text ? { text, kind: kind || 'info' } : null;
  const el = $('#cc-status');
  if (!el) return;
  clearTimeout(statusTimer);
  if (!S.status) { el.className = 'cc-status hidden'; el.innerHTML = ''; return; }
  el.className = 'cc-status cc-' + S.status.kind;
  el.innerHTML = `<span>${esc(text)}</span><button class="cc-icon-btn" data-act="dismiss" title="Dismiss">${icon('close')}</button>`;
  if (S.status.kind !== 'error') statusTimer = setTimeout(() => setStatus(null), 9000);
}

function updateFooter() {
  const el = $('#cc-footer');
  if (!el) return;
  el.classList.toggle('cc-busy', !!S.busy);
  if (S.busy) {
    const p = S.busy.progress;
    el.innerHTML = `<div class="cc-progress"><div class="cc-progress-bar${p == null ? ' cc-indet' : ''}" style="width:${p == null ? 100 : Math.round(p * 100)}%"></div>
      <span>${esc(S.busy.label)}</span></div>
      ${S.busy.cancel ? '<button class="cc-btn" data-act="cancel">Cancel</button>' : ''}`;
    return;
  }
  const n = S.scene ? S.scene.captions.length : 0;
  el.innerHTML = `<button class="cc-btn cc-primary cc-wide" data-act="export" ${n ? '' : 'disabled'}
      title="${n ? `${n} caption${n === 1 ? '' : 's'} · ${fmtTime(S.scene.duration)}` : 'Transcribe or paste words first'}">
      ${inCEP() ? 'Add captions to timeline' : 'Render caption video'}</button>`;
}

function setBusy(b) { S.busy = b; updateFooter(); }

/* ── tabs ─────────────────────────────────────────────────────── */

function renderBody() {
  if (!root || !$('#cc-body')) return;
  $$('.cc-tab').forEach((b) => b.classList.toggle('cc-active', b.dataset.tab === S.tab));
  const body = $('#cc-body');
  const scroll = body.scrollTop;
  if (S.tab === 'transcript') body.innerHTML = tabTranscript();
  else if (S.tab === 'style') body.innerHTML = tabStyle();
  else if (S.tab === 'motion') body.innerHTML = tabMotion();
  else body.innerHTML = tabExport();
  body.scrollTop = scroll;
  if (S.tab === 'transcript') renderTranscriptList();
  if (S.tab === 'style') drawPresetTiles();
  if (S.tab === 'motion') drawMotionTiles();
  updateFooter();
}

/* ── controls (declarative: data-bind + one handler) ──────────── */

function ctlNum(path, label, min, max, step, unit, scale) {
  const raw = getPath(S.settings, path);
  const v = fmtNum((raw == null ? 0 : raw) * (scale || 1));
  const a = `data-bind="${path}" data-kind="num" data-min="${min}" data-max="${max}"${scale ? ` data-scale="${scale}"` : ''}`;
  return `<div class="cc-ctl cc-ctl-num"><label class="cc-lbl">${label}</label>
    <input class="cc-range" type="range" min="${min}" max="${max}" step="${step}" value="${v}" ${a}>
    <span class="cc-numbox"><input type="number" min="${min}" max="${max}" step="${step}" value="${v}" ${a}>${unit ? `<i>${unit}</i>` : ''}</span></div>`;
}
function ctlToggle(path, label, hint) {
  const on = !!getPath(S.settings, path);
  return `<label class="cc-toggle"><input type="checkbox" data-bind="${path}" data-kind="bool"${on ? ' checked' : ''}>
    <span class="cc-switch"></span><span class="cc-toggle-text">${label}${hint ? `<small>${hint}</small>` : ''}</span></label>`;
}
function ctlSelect(path, label, options) {
  const v = String(getPath(S.settings, path));
  return `<div class="cc-ctl"><label class="cc-lbl">${label}</label><select class="cc-select" data-bind="${path}" data-kind="text">
    ${options.map(([val, text]) => `<option value="${esc(val)}"${String(val) === v ? ' selected' : ''}>${esc(text)}</option>`).join('')}
  </select></div>`;
}
function ctlSeg(path, label, options) {
  const v = String(getPath(S.settings, path));
  return `<div class="cc-ctl"><label class="cc-lbl">${label}</label><div class="cc-seg" data-bind="${path}" data-kind="seg">
    ${options.map(([val, text, title]) => `<button type="button" data-value="${esc(val)}" class="${String(val) === v ? 'cc-on' : ''}"${title ? ` title="${esc(title)}"` : ''}>${text}</button>`).join('')}
  </div></div>`;
}
function ctlColor(path, label) {
  const v = getPath(S.settings, path) || '#ffffff';
  return `<label class="cc-color"><input type="color" value="${esc(v)}" data-bind="${path}" data-kind="text"><span>${label}</span></label>`;
}
function section(title, inner, extra) {
  return `<section class="cc-sec"><h4>${title}${extra || ''}</h4>${inner}</section>`;
}

/* ── Transcript tab ───────────────────────────────────────────── */

const LANGS = [['en', 'English'], ['auto', 'Auto-detect'], ['ur', 'Urdu'], ['hi', 'Hindi'], ['ar', 'Arabic'],
  ['es', 'Spanish'], ['fr', 'French'], ['de', 'German']];

function sourceCard() {
  const live = inCEP();
  const hasInOut = !!(S.seq && S.seq.hasInOut);
  const inPt = S.seq && S.seq.inPoint != null ? S.seq.inPoint : 0;
  const outPt = S.seq && S.seq.outPoint != null ? S.seq.outPoint : (S.seq && S.seq.duration ? S.seq.duration : 0);
  const inOutSpan = fmtTime(Math.max(0, outPt - inPt));
  const inOutText = `${fmtTime(inPt)} – ${fmtTime(outPt)}`;
  const useInOut = S.useInOut !== false && hasInOut;

  const btnLabel = (hasInOut && useInOut)
    ? `${icon('mic')} Transcribe In/Out range (${inOutText})`
    : `${icon('mic')} Transcribe this sequence`;

  return `<div class="cc-source">
    <button class="cc-btn cc-primary cc-wide" data-act="transcribe-seq" ${live && !S.busy ? '' : 'disabled'}>${btnLabel}</button>
    <p class="cc-hint">${live ? 'Uses the timeline audio as cut, so captions line up with your edit. Muted tracks are skipped — mute music first.'
      : 'Open the panel inside Premiere to transcribe the sequence. You can still upload a file or paste a transcript.'}</p>
    ${hasInOut ? `<div style="margin:4px 0 6px">
      <label class="cc-check" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--cc-bright,#eee);cursor:pointer">
        <input type="checkbox" id="cc-use-in-out" ${useInOut ? 'checked' : ''} style="cursor:pointer">
        <span><b>Sequence In/Out active:</b> <span style="color:var(--cc-accent-2,#69a9ff)">${inOutText}</span> (${inOutSpan})</span>
      </label>
    </div>` : ''}
    <div class="cc-row2">
      ${ctlSelect('transcribe.language', 'Language', LANGS)}
      ${ctlSelect('transcribe.engine', 'Word timing', [['auto', 'Best available'], ['whisperx', 'WhisperX (precise)'], ['whisper', 'Whisper (fast)']])}
    </div>
    <div class="cc-row2" style="margin-top:4px">
      <label class="cc-check" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text-dim,#aaa);cursor:pointer">
        <input type="checkbox" id="cc-force-transcribe" style="cursor:pointer">
        <span>Force fresh transcription (ignore cache)</span>
      </label>
    </div>
    <div class="cc-row2">
      <button class="cc-btn" data-act="upload" ${S.busy ? 'disabled' : ''}>Upload audio / video…</button>
      <button class="cc-btn" data-act="paste-toggle">${S.pasteOpen ? 'Hide paste box' : 'Paste transcript…'}</button>
    </div>
    ${S.pasteOpen ? `<textarea class="cc-text" id="cc-paste" placeholder="Paste SRT, JSON [{word,start,end}], or plain text"></textarea>
      <button class="cc-btn cc-wide" data-act="paste-use">Use this transcript</button>` : ''}
  </div>`;
}

function tabTranscript() {
  if (!S.words.length) return section('Get the words', sourceCard());
  const vis = S.scene ? S.scene.captions.length : 0;
  const hideF = S.settings.grouping.hideFillers !== false;
  const hidden = S.words.filter((w) => !M.isVisible(w, hideF)).length;
  const sourceLabel = S.sourceName ? ` · <span title="${esc(S.sourceName)}">${esc(S.sourceName)}</span>` : '';
  return `
    <div class="cc-txbar">
      <button class="cc-icon-btn" data-act="undo" title="Undo (Ctrl+Z)" ${S.history.length ? '' : 'disabled'}>${icon('undo')}</button>
      <button class="cc-icon-btn" data-act="redo" title="Redo (Ctrl+Shift+Z)" ${S.future.length ? '' : 'disabled'}>${icon('redo')}</button>
      <button class="cc-icon-btn${S.findOpen ? ' cc-on' : ''}" data-act="find-toggle" title="Find & replace">${icon('search')}</button>
      <span class="cc-dim cc-grow" id="cc-txcount">${S.words.length} words · ${vis} captions${hidden ? ` · ${hidden} hidden` : ''}${sourceLabel}</span>
      <button class="cc-btn cc-small" data-act="source-toggle">${S.showSource ? 'Done' : 'Re-transcribe…'}</button>
      <button class="cc-btn cc-small" data-act="clear-tx" title="Clear current transcript and start fresh">Clear</button>
    </div>
    ${S.showSource ? `<div class="cc-sec">${sourceCard()}</div>` : ''}
    ${S.findOpen ? `<div class="cc-find">
      <input class="cc-input" id="cc-find" placeholder="Find word" spellcheck="false">
      <input class="cc-input" id="cc-replace" placeholder="Replace with" spellcheck="false">
      <button class="cc-btn cc-small" data-act="replace-all">Replace all</button></div>` : ''}
    <div class="cc-selbar hidden" id="cc-selbar"></div>
    <div class="cc-tx" id="cc-tx" tabindex="0"></div>
    <p class="cc-hint">Click a word to jump to it · double-click to fix it · <kbd>H</kbd> hide · <kbd>E</kbd> emphasise · <kbd>B</kbd> new caption here · <kbd>←</kbd><kbd>→</kbd> move</p>`;
}

function renderTranscriptList() {
  const box = $('#cc-tx');
  if (!box) return;
  const hideF = S.settings.grouping.hideFillers !== false;
  const capOf = {};
  if (S.scene) S.scene.captions.forEach((c, ci) => c.lines.forEach((l) => l.words.forEach((w) => { capOf[w.id] = ci; })));
  let html = '', cur = -2, open = false;
  S.words.forEach((w, i) => {
    const ci = capOf[w.id != null ? w.id : i];
    if (ci !== undefined && ci !== cur) {
      if (open) html += '</div></div>';
      const c = S.scene.captions[ci];
      html += `<div class="cc-cap"><button class="cc-cap-time" data-seek="${c.tIn}" title="Jump here">${fmtTime(c.tIn)}</button><div class="cc-cap-words">`;
      open = true; cur = ci;
    } else if (!open) {
      html += '<div class="cc-cap"><span class="cc-cap-time"></span><div class="cc-cap-words">';
      open = true;
    }
    const visible = M.isVisible(w, hideF);
    const cls = ['cc-w'];
    if (!visible) cls.push(w.hidden === true ? 'cc-hidden' : 'cc-auto-hidden');
    if (w.emphasis) cls.push('cc-emph');
    if (i === S.sel) cls.push('cc-sel');
    if (w.breakBefore) cls.push('cc-brk');
    if (i === S.editing) {
      html += `<input class="cc-w-edit" id="cc-w-edit" value="${esc(w.text)}" data-i="${i}" spellcheck="false" size="${Math.max(3, w.text.length + 2)}">`;
    } else {
      html += `<span class="${cls.join(' ')}" data-i="${i}" title="${fmtTime(w.start)}${!visible && w.hidden !== true ? ' · filler, hidden automatically' : ''}">${esc(w.text)}</span>`;
    }
    if (open && i + 1 < S.words.length) html += ' ';
  });
  if (open) html += '</div></div>';
  box.innerHTML = html || '<p class="cc-hint">No words.</p>';
  const count = $('#cc-txcount');
  if (count && S.scene) {
    const hidden = S.words.filter((w) => !M.isVisible(w, hideF)).length;
    count.textContent = `${S.words.length} words · ${S.scene.captions.length} captions${hidden ? ` · ${hidden} hidden` : ''}`;
  }
  renderSelBar();
  const ed = $('#cc-w-edit');
  if (ed) { ed.focus(); ed.select(); }
  lastPlayingWord = -1;
  highlightPlayingWord();
}

function renderSelBar() {
  const bar = $('#cc-selbar');
  if (!bar) return;
  const w = S.words[S.sel];
  if (!w) { bar.innerHTML = ''; bar.classList.add('hidden'); return; }
  const vis = M.isVisible(w, S.settings.grouping.hideFillers !== false);
  bar.classList.remove('hidden');
  bar.innerHTML = `<span class="cc-selword">“${esc(w.text)}” <span class="cc-dim">${fmtTime(w.start)}</span></span>
    <button class="cc-btn cc-small" data-act="w-hide" title="Hide / show this word (H)">${vis ? 'Hide' : 'Show'}</button>
    <button class="cc-btn cc-small${w.emphasis ? ' cc-on' : ''}" data-act="w-emph" title="Emphasise (E)">Emphasis</button>
    <button class="cc-btn cc-small${w.breakBefore ? ' cc-on' : ''}" data-act="w-break" title="Start a new caption at this word (B)">New caption</button>
    <button class="cc-btn cc-small" data-act="w-edit" title="Fix the spelling (Enter)">Edit</button>
    <span class="cc-nudge"><button class="cc-btn cc-small" data-act="w-earlier" title="Start one frame earlier">−1f</button><button class="cc-btn cc-small" data-act="w-later" title="Start one frame later">+1f</button></span>`;
}

/* ── word edits (with undo) ───────────────────────────────────── */

function snapshot() {
  S.history.push(JSON.stringify(S.words));
  if (S.history.length > 80) S.history.shift();
  S.future = [];
}
function wordsChanged() {
  saveWords();
  rebuildScene();
  const list = $('#cc-words-list');
  const scroll = list ? list.scrollTop : 0;
  if (S.tab === 'transcript') renderTranscriptList();
  if (list) list.scrollTop = scroll;
  const u = $('[data-act="undo"]'), r = $('[data-act="redo"]');
  if (u) u.disabled = !S.history.length;
  if (r) r.disabled = !S.future.length;
}
function undo() {
  if (!S.history.length) return;
  S.future.push(JSON.stringify(S.words));
  S.words = JSON.parse(S.history.pop());
  wordsChanged();
}
function redo() {
  if (!S.future.length) return;
  S.history.push(JSON.stringify(S.words));
  S.words = JSON.parse(S.future.pop());
  wordsChanged();
}
function wordAction(act) {
  const w = S.words[S.sel];
  if (!w) return;
  snapshot();
  if (act === 'hide') w.hidden = M.isVisible(w, S.settings.grouping.hideFillers !== false) ? true : false;
  else if (act === 'emph') w.emphasis = !w.emphasis;
  else if (act === 'break') w.breakBefore = !w.breakBefore;
  else if (act === 'earlier' || act === 'later') {
    const f = (S.seq.fps.den / S.seq.fps.num) * (act === 'earlier' ? -1 : 1);
    const prev = S.words[S.sel - 1];
    const next = S.words[S.sel + 1];
    const dur = Math.max(0.04, w.end - w.start);
    let newStart = w.start + f;
    if (prev) newStart = Math.max(prev.start + 0.02, newStart);
    else newStart = Math.max(0, newStart);
    w.start = newStart;
    w.end = next ? Math.min(next.end - 0.02, newStart + dur) : newStart + dur;
    if (prev && prev.end > w.start) prev.end = w.start;
    seek(w.start + 0.001);
  }
  wordsChanged();
}
function commitEdit(text) {
  const i = S.editing;
  S.editing = -1;
  const w = S.words[i];
  if (!w) { renderTranscriptList(); return; }
  const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length || parts.join(' ') === w.text) { renderTranscriptList(); return; }
  snapshot();
  if (parts.length === 1) {
    w.text = parts[0];
  } else {
    // "gonna" → "going to": share the word's time by letter count
    const total = parts.reduce((a, p) => a + p.length, 0);
    let t = w.start;
    const span = w.end - w.start;
    const repl = parts.map((p, k) => {
      const d = span * (p.length / total);
      const nw = Object.assign({}, w, { text: p, start: t, end: t + d, id: k === 0 ? w.id : `${w.id}.${k}`,
                                        breakBefore: k === 0 ? w.breakBefore : undefined });
      t += d;
      return nw;
    });
    S.words.splice(i, 1, ...repl);
  }
  wordsChanged();
  const cur = $(`.cc-w[data-i="${i}"]`);
  if (cur && cur.focus) cur.focus();
}
function replaceAll() {
  const f = ($('#cc-find') || {}).value || '';
  const r = (($('#cc-replace') || {}).value || '').trim();
  if (!f.trim()) { setStatus('Type the word to find first.'); return; }
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  const want = norm(f);
  let n = 0;
  snapshot();
  for (const w of S.words) {
    if (norm(w.text) === want) {
      const lead = (w.text.match(/^[^\p{L}\p{N}']+/u) || [''])[0];
      const trail = (w.text.match(/[^\p{L}\p{N}']+$/u) || [''])[0];
      let repl = r;
      const core = w.text.slice(lead.length, w.text.length - (trail ? trail.length : 0));
      if (core === core.toUpperCase() && core.length > 1) repl = r.toUpperCase();
      else if (/^[A-Z]/.test(core)) repl = r.charAt(0).toUpperCase() + r.slice(1);
      if (r) w.text = lead + repl + trail;
      n++;
    }
  }
  if (!n || !r) { S.history.pop(); setStatus(n ? 'Type the replacement first.' : `No “${f}” in the transcript.`); return; }
  setStatus(`Replaced ${n} × “${f}”.`, 'ok');
  wordsChanged();
}

/* ── transcription ────────────────────────────────────────────── */

function setWords(words, note) {
  if (S.words.length) snapshot();
  S.words = M.sanitizeWords(words).map((w, i) => {
    const o = { id: i, text: w.text, start: w.start, end: w.end };
    if (w.hidden !== undefined) o.hidden = w.hidden;
    if (w.emphasis) o.emphasis = true;
    if (w.breakBefore) o.breakBefore = true;
    return o;
  });
  S.sel = -1;
  S.editing = -1;
  S.showSource = false;
  S.pasteOpen = false;
  saveWords();
  S.t = 0;
  renderBody();
  rebuildScene();
  if (note) setStatus(note, 'ok');
}

function clearTranscript() {
  if (S.words.length) snapshot();
  S.words = [];
  S.sourceName = '';
  S.sel = -1;
  S.editing = -1;
  S.showSource = false;
  S.pasteOpen = false;
  saveWords();
  S.t = 0;
  setPlaying(false);
  renderBody();
  rebuildScene();
  setStatus('Transcript cleared.', 'ok');
}

function onWsMessage(ev) {
  const d = ev && ev.detail;
  const p = d && (d.payload || d);
  if (!S.busy || S.busy.kind !== 'transcribe' || !p || p.task_type !== 'transcribe') return;
  S.busy.progress = typeof p.progress === 'number' ? clamp(p.progress, 0, 1) : null;
  S.busy.label = p.message ? `Transcribing — ${p.message}` : 'Transcribing…';
  updateFooter();
}

function transcribeError(e) {
  const msg = formatUserError(e);
  if (/409|no_model/i.test(msg)) {
    setStatus('No Whisper model installed yet — open Settings (gear icon) to download one, then try again.', 'error');
  } else {
    setStatus('Transcription failed: ' + msg, 'error');
  }
}

async function transcribeSequence() {
  if (!inCEP() || S.busy) return;
  setBusy({ kind: 'transcribe', label: 'Reading the sequence audio…', progress: null });
  try {
    const inOutBox = $('#cc-use-in-out');
    const useInOut = inOutBox ? inOutBox.checked : (S.seq && S.seq.hasInOut);
    S.useInOut = useInOut;
    const clips = await callCM('sequenceAudioClips', { useInOut: useInOut });
    if (!clips.clips || !clips.clips.length) {
      throw new Error('No audio clips on unmuted tracks' + (clips.nested ? ` (${clips.nested} nested-sequence clip(s) are skipped)` : '') + '.');
    }
    const rangeLabel = clips.rangeIn > 0 ? ` [In/Out: ${fmtTime(clips.rangeIn)} – ${fmtTime(clips.rangeOut)}]` : '';
    setBusy({ kind: 'transcribe', label: `Transcribing ${clips.clips.length} clip${clips.clips.length === 1 ? '' : 's'}${rangeLabel}… (can take minutes on CPU)`, progress: null });
    const tr = S.settings.transcribe;
    const force = !!($('#cc-force-transcribe') || {}).checked;
    const res = await apiPost('/api/captions/transcribe-sequence', {
      clips: clips.clips, sequence_name: clips.name, duration: clips.duration,
      range_in: clips.rangeIn || 0, range_out: clips.rangeOut || clips.duration,
      language: tr.language, engine: tr.engine, force,
    }, { timeoutMs: 60 * 60 * 1000 });
    const words = (res.words || []).map((w) => ({ text: w.word || w.text, start: w.start, end: w.end }));
    const skipped = (res.skipped || []).length;
    S.sourceName = clips.name || 'Sequence';
    setWords(words, `${words.length} words from “${clips.name}”${rangeLabel} (${res.engine || 'whisper'})${skipped ? ` — ${skipped} offline clip(s) skipped` : ''}.`);
    if (!S.bgImage) {
      try { captureSequenceFrame(); } catch (_) {}
    }
  } catch (e) {
    transcribeError(e);
  } finally {
    setBusy(null);
  }
}

async function transcribeFile(file) {
  if (S.busy) return;
  setBusy({ kind: 'transcribe', label: `Uploading ${file.name}…`, progress: null });
  try {
    const tr = S.settings.transcribe;
    const force = !!($('#cc-force-transcribe') || {}).checked;
    const res = await apiUpload('/api/captions/transcribe-mixdown', file,
      { language: tr.language, engine: tr.engine, force: force ? 'true' : 'false' }, { timeoutMs: 60 * 60 * 1000 });
    const words = (res.words || []).map((w) => ({ text: w.word || w.text, start: w.start, end: w.end }));
    if (res.bg_url) {
      const im = new Image();
      im.onload = () => { S.bg = 'frame'; requestDraw(); };
      im.src = getBaseUrl() + res.bg_url;
      S.bgImage = im;
    }
    S.sourceName = file.name;
    setWords(words, `${words.length} words from ${file.name} (${res.engine || 'whisper'}). Times count from the start of the sequence.`);
  } catch (e) {
    transcribeError(e);
  } finally {
    setBusy(null);
  }
}

function srtSecs(s) {
  const m = String(s).match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + parseFloat('0.' + m[4]) : null;
}
function parsePasted(raw) {
  raw = String(raw || '').trim();
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    const arr = Array.isArray(j) ? j : (j.words || (j.segments || []).reduce((a, s) => a.concat(s.words || []), []));
    if (Array.isArray(arr) && arr.length) {
      return arr.map((w) => ({ text: String(w.word || w.text || ''), start: +w.start || 0, end: +w.end || 0,
        hidden: w.hidden, emphasis: w.emphasis || w.pill }));
    }
  } catch (_) { /* not JSON */ }
  if (/-->/.test(raw)) {
    const out = [];
    for (const block of raw.split(/\r?\n\s*\r?\n/)) {
      const lines = block.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const ti = lines.findIndex((l) => l.indexOf('-->') !== -1);
      if (ti < 0) continue;
      const ab = lines[ti].split('-->');
      const s0 = srtSecs(ab[0]), s1 = srtSecs(ab[1]);
      if (s0 == null || s1 == null || s1 <= s0) continue;
      const toks = lines.slice(ti + 1).join(' ').split(/\s+/).filter(Boolean);
      const total = toks.reduce((x, t) => x + t.length + 1, 0);
      let t = s0;
      for (const tok of toks) {
        const d = (s1 - s0) * ((tok.length + 1) / total);
        out.push({ text: tok, start: t, end: t + d });
        t += d;
      }
    }
    return out;
  }
  // plain text: ~2.6 words per second, a natural speaking pace
  return raw.split(/\s+/).filter(Boolean).map((t, i) => ({ text: t, start: i / 2.6, end: (i + 0.9) / 2.6 }));
}

/* ── Style tab ────────────────────────────────────────────────── */

function fontOptions() {
  const fam = S.settings.style.fontFamily;
  const bundled = BUNDLED.map((f) => `<option value="${esc(f.family)}"${f.family === fam ? ' selected' : ''}>${esc(f.family)} — ${esc(f.note)}</option>`).join('');
  const sys = S.systemFonts.filter((f) => !BUNDLED.some((b) => b.family.toLowerCase() === f.family.toLowerCase()));
  const sysHtml = sys.map((f) => `<option value="${esc(f.family)}"${f.family === fam ? ' selected' : ''}>${esc(f.family)}</option>`).join('');
  const known = BUNDLED.some((b) => b.family === fam) || sys.some((f) => f.family === fam);
  return `<optgroup label="Caption fonts (always available)">${bundled}</optgroup>
    ${sysHtml ? `<optgroup label="Installed on this PC (${sys.length})">${sysHtml}</optgroup>` : ''}
    ${known ? '' : `<option value="${esc(fam)}" selected>${esc(fam)}</option>`}`;
}
function weightsFor(family) {
  const b = BUNDLED.find((f) => f.family === family);
  if (b) return b.weights;
  const s = S.systemFonts.find((f) => f.family === family);
  return s && s.weights.length ? s.weights : [400, 700];
}

function tabStyle() {
  const st = S.settings.style;
  const ws = weightsFor(st.fontFamily);
  const tiles = PRESETS.map((p) => `<button class="cc-tile${S.settings.preset === p.id ? ' cc-on' : ''}" data-preset="${p.id}" title="Apply the ${esc(p.name)} look">
      <canvas class="cc-tile-cv" data-tile="${p.id}"></canvas><span>${esc(p.name)}</span></button>`).join('');
  return `
    ${section('Look', `<div class="cc-tiles">${tiles}</div>`, S.settings.preset === 'custom' ? ' <small class="cc-dim">· customised</small>' : '')}
    ${section('Font', `
      <div class="cc-ctl"><label class="cc-lbl">Family</label><select class="cc-select" data-bind="style.fontFamily" data-kind="text">${fontOptions()}</select></div>
      <p class="cc-warn${S.fontOk ? ' hidden' : ''}" id="cc-font-warn">This font isn't available to the panel — pick another, or install it in Windows and reopen the panel.</p>
      ${ctlSeg('style.fontWeight', 'Weight', ws.map((w) => [w, weightName(w)]))}
      ${ctlNum('style.fontSize', 'Size', 24, 220, 1, 'px')}
      ${ctlSeg('style.textCase', 'Case', [['as_is', 'As spoken'], ['upper', 'UPPER'], ['lower', 'lower']])}
      ${ctlSeg('style.punctuation', 'Punctuation', [
        ['no_dots', 'No dots', 'Keep commas & pauses, drop ending dots (.)'],
        ['keep', 'Keep all', 'Keep all punctuation as spoken'],
        ['soft', 'Clean', 'Hide commas and full stops, keep ? and !'],
        ['none', 'None', 'Strip all punctuation'],
        ['custom', 'Custom', 'Choose specifically which punctuation to keep'],
      ])}
      ${st.punctuation === 'custom' ? `
        <div class="cc-sub-ctls" style="margin: 6px 0 6px 8px; padding-left: 10px; border-left: 2px solid rgba(255,255,255,0.12);">
          ${ctlToggle('style.punctCommas', 'Keep commas & inner pauses', 'Preserves , ; : (and Urdu ، ؛)')}
          ${ctlToggle('style.punctDots', 'Keep sentence-ending dots', 'Preserves . … (and Urdu ۔)')}
          ${ctlToggle('style.punctExpressive', 'Keep ? and !', 'Preserves question marks and exclamations')}
        </div>` : ''}`)}
    ${section('Colour', `<div class="cc-swatches">
      ${ctlColor('style.color', 'Text')}
      ${M.highlightMode(S.settings.motion) === 'color' ? ctlColor('style.activeColor', 'Active word') : ''}
      ${ctlColor('style.emphasisColor', 'Emphasis')}</div>
      ${ctlSeg('style.emphasis', 'Emphasised words get', [['color', 'Colour'], ['pill', 'Pill'], ['both', 'Both']])}
      ${st.emphasis !== 'color' ? `<div class="cc-swatches">${ctlColor('style.pillColor', 'Pill')}</div>${ctlNum('style.pillOpacity', 'Pill opacity', 0, 100, 1, '%', 100)}` : ''}`)}
    ${section('Outline', `${ctlNum('style.strokeWidth', 'Thickness', 0, 20, 0.5, 'px')}
      <div class="cc-swatches">${ctlColor('style.strokeColor', 'Outline colour')}</div>`)}
    ${section('Shadow', `${ctlToggle('style.shadow', 'Drop shadow')}
      ${st.shadow ? `<div class="cc-swatches">${ctlColor('style.shadowColor', 'Shadow colour')}</div>
        ${ctlNum('style.shadowOpacity', 'Opacity', 0, 100, 1, '%', 100)}
        ${ctlNum('style.shadowBlur', 'Softness', 0, 60, 1, 'px')}
        ${ctlNum('style.shadowDistance', 'Distance', 0, 40, 1, 'px')}` : ''}`)}
    ${section('Background', `${ctlSeg('style.background', 'Behind the text', [['none', 'None'], ['box', 'Box', 'A rounded box per line'], ['block', 'Block', 'One box for the whole caption'], ['pills', 'Pills', 'A pill behind every word']])}
      ${st.background !== 'none' ? `<div class="cc-swatches">${ctlColor('style.bgColor', 'Box colour')}</div>
        ${ctlNum('style.bgOpacity', 'Opacity', 0, 100, 1, '%', 100)}
        ${ctlNum('style.bgRadius', 'Roundness', 0, 100, 1, '%', 100)}
        ${ctlNum('style.bgPad', 'Padding', 0, 60, 1, '%', 100)}` : ''}`)}
    ${section('Position', `
      ${ctlNum('layout.posY', 'Height on screen', 5, 95, 0.5, '%')}
      ${ctlNum('layout.posX', 'Left / right', 5, 95, 0.5, '%')}
      ${ctlNum('layout.boxWidth', 'Caption width', 30, 100, 1, '%')}
      ${ctlSeg('grouping.maxLines', 'Lines', [[1, '1 line'], [2, '2 lines'], [3, '3 lines']])}
      ${S.settings.grouping.maxLines > 1 ? ctlNum('layout.lineHeight', 'Line spacing', 0.8, 1.8, 0.01, '×') : ''}
      ${ctlSeg('layout.align', 'Align', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']])}
      <p class="cc-hint">Tip: drag the caption in the preview to move it, or drag its sides to change the width.</p>`)}`;
}

const SAMPLE = [['Make', 0.0, 0.3], ['every', 0.3, 0.6], ['word', 0.6, 0.9], ['count', 0.9, 1.4]];
const tileScenes = new WeakMap();   // canvas → { scene, settings } (built once per draw request)
function drawTileScene(cv, style, motion, t) {
  const W = 540, H = 300;
  const st = Object.assign({}, STYLE_DEFAULTS, style, { fontSize: 66 });
  st.strokeWidth = (style.strokeWidth || 0) * 0.8;
  st.shadowBlur = (style.shadowBlur || 0) * 0.8;
  st.shadowDistance = (style.shadowDistance || 0) * 0.8;
  const words = SAMPLE.map(([text, start, end], i) => ({ id: i, text, start, end, emphasis: i === 2 }));
  const settings = { style: st, motion, layout: { posX: 50, posY: 50, boxWidth: 94, lineHeight: 1.1 },
                     grouping: { maxWords: 4, maxLines: 2 }, timing: { tailHold: 0.6 } };
  const ms = makeMeasurer(st);
  const scene = M.buildScene(words, settings, { width: W, height: H, fps: { num: 30, den: 1 }, measure: ms.measure, fontMetrics: ms.fontMetrics });
  const dpr = window.devicePixelRatio || 1;
  const cw = cv.clientWidth || 120;
  cv.width = Math.round(cw * dpr);
  cv.height = Math.round(cw * dpr * H / W);
  tileScenes.set(cv, { scene, settings, W });
  paintTile(cv, t);
}
function paintTile(cv, t) {
  const d = tileScenes.get(cv);
  if (!d) return;
  const ctx = cv.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#3b4048';
  ctx.fillRect(0, 0, cv.width, cv.height);
  drawFrame(ctx, d.scene, d.settings, t, { scale: cv.width / d.W, clear: false });
}
function drawPresetTiles() {
  $$('[data-tile]').forEach((cv) => {
    const p = findPreset(cv.dataset.tile);
    // every word on screen, the last one being spoken
    if (p) ensureFont(p.style.fontFamily, p.style.fontWeight).then(() => drawTileScene(cv, p.style, p.motion, 1.15));
  });
}

// Motion tiles play their animation on a loop while the Motion tab is open.
let tileRaf = 0;
function animateMotionTiles() {
  if (tileRaf) return;
  const t0 = performance.now();
  const loop = (now) => {
    tileRaf = 0;
    if (S.tab !== 'motion' || !root || root.classList.contains('hidden')) return;
    const t = ((now - t0) / 1000) % 2.4;         // 1.9 s of captions + a short rest
    $$('[data-mtile]').forEach((cv) => paintTile(cv, Math.min(t, 1.9)));
    tileRaf = requestAnimationFrame(loop);
  };
  tileRaf = requestAnimationFrame(loop);
}

/* ── Motion tab ───────────────────────────────────────────────── */

const MOTIONS = [
  ['fade_up', 'Fade up', 'Each word rises in as it is spoken'],
  ['pop', 'Pop', 'Each word pops in with a soft spring'],
  ['bounce', 'Bounce', 'Each word drops in and bounces'],
  ['typewriter', 'Type', 'Letters type on as the word is spoken'],
  ['karaoke', 'Karaoke', 'The caption shows whole; the spoken word lights up'],
  ['slide_up', 'Slide up', 'The whole caption slides up together'],
  ['fade', 'Fade', 'The whole caption fades in together'],
  ['none', 'None', 'No animation'],
];

function tabMotion() {
  const m = S.settings.motion;
  const tiles = MOTIONS.map(([id, name, hint]) => `<button class="cc-tile${m.preset === id ? ' cc-on' : ''}" data-motion="${id}" title="${esc(hint)}">
      <canvas class="cc-tile-cv" data-mtile="${id}"></canvas><span>${name}</span></button>`).join('');
  const hasSpeed = m.preset !== 'none' && m.preset !== 'karaoke' && m.preset !== 'typewriter';
  return `
    ${section('Animation', `<div class="cc-tiles">${tiles}</div>
      ${hasSpeed ? ctlNum('motion.duration', 'Speed', 0.08, 1, 0.01, 's') : ''}
      ${['fade_up', 'slide_up'].indexOf(m.preset) !== -1 ? ctlNum('motion.distance', 'Travel', 0, 1.5, 0.01, 'em') : ''}
      ${['pop', 'bounce'].indexOf(m.preset) !== -1 ? ctlNum('motion.intensity', 'Strength', 0.2, 2, 0.05, '×') : ''}
      ${['fade_up', 'slide_up', 'fade'].indexOf(m.preset) !== -1 ? ctlSelect('motion.easing', 'Easing', [['expo_out', 'Snappy (expo out)'], ['back_out', 'Overshoot (back out)'], ['ease_out', 'Smooth (ease out)'], ['ease_in_out', 'Ease in-out'], ['linear', 'Linear']]) : ''}`)}
    ${section('Active word', `${ctlSeg('motion.highlight', 'Highlight the word being spoken', [['none', 'Off'], ['color', 'Colour'], ['box', 'Box'], ['scale', 'Grow']])}
      ${m.highlight === 'box' ? `<div class="cc-swatches">${ctlColor('style.hlBoxColor', 'Box colour')}</div>` : ''}
      ${M.highlightMode(m) === 'color' ? `<div class="cc-swatches">${ctlColor('style.activeColor', 'Active colour')}</div>` : ''}
      ${M.WORD_LEVEL[m.preset] ? '' : ctlToggle('motion.spokenDim', 'Dim words not spoken yet', 'Karaoke-style fill')}`)}
    ${section('Caption breaks', `
      ${ctlNum('grouping.maxWords', 'Words per caption', 1, 10, 1, '')}
      ${ctlNum('grouping.splitGap', 'New caption after a pause of', 0.15, 2, 0.05, 's')}
      ${ctlNum('grouping.maxDuration', 'Longest caption', 1, 8, 0.1, 's')}
      ${ctlToggle('grouping.hideFillers', 'Hide filler words', '“uh”, “um”, “erm” — un-hide any one in Transcript')}`)}
    ${section('Timing', `
      ${ctlNum('timing.offset', 'Shift all captions', -1, 1, 0.01, 's')}
      ${ctlNum('timing.minDuration', 'Minimum time on screen', 0.2, 2, 0.05, 's')}
      ${ctlNum('timing.maxHold', 'Hold after speech stops', 0, 3, 0.05, 's')}
      ${ctlSeg('timing.exit', 'Hand-off between captions', [['fade', 'Crossfade'], ['cut', 'Cut']])}
      ${S.settings.timing.exit === 'fade' ? ctlNum('timing.exitDuration', 'Crossfade length', 0.04, 0.4, 0.01, 's') : ''}`)}`;
}
function drawMotionTiles() {
  const st = Object.assign({}, S.settings.style);
  ensureFont(st.fontFamily, st.fontWeight).then(() => {
    $$('[data-mtile]').forEach((cv) => {
      const motion = Object.assign({}, S.settings.motion, { preset: cv.dataset.mtile });
      drawTileScene(cv, st, motion, 0.68);
    });
    animateMotionTiles();
  });
}

/* ── Export tab ───────────────────────────────────────────────── */

function tabExport() {
  const r = S.lastRender;
  const f = S.seq.fps;
  const ready = S.scene && S.scene.captions.length;
  return `
    ${section('Sequence', S.seq.live
      ? `<p><b>${esc(S.seq.name)}</b><br><span class="cc-dim">${S.seq.width}×${S.seq.height} · ${Math.round((f.num / f.den) * 1000) / 1000} fps (exactly ${f.num}/${f.den}) · ${fmtTime(S.seq.duration)}</span></p>`
      : `<p class="cc-dim">Preview mode — not connected to Premiere. Rendering still works; you place the file yourself.</p>
         ${ctlSeg('previewAspect', 'Frame', [['9:16', '9:16'], ['1:1', '1:1'], ['4:5', '4:5'], ['16:9', '16:9']])}`)}
    ${section('Animated captions', `${ctlSeg('output.codec', 'Video format', [['prores', 'ProRes 4444', 'Best compatibility, smaller files'], ['animation', 'Animation', 'Renders about 3× faster; bigger files']])}
      <p class="cc-hint">Rendered at the sequence's exact frame rate with transparency, then put on the first free video track above V1. Running it again replaces the old captions — nothing else on your timeline moves.</p>
      <button class="cc-btn cc-primary cc-wide" data-act="export" ${ready && !S.busy ? '' : 'disabled'}>${inCEP() ? 'Add captions to timeline' : 'Render caption video'}</button>
      ${r ? `<div class="cc-result"><b>${r.placed ? `On ${esc(r.placed.trackName)}` : 'Rendered'}</b> · ${r.frames} frames · ${fmtTime(r.seconds)} · took ${Math.max(1, Math.round(r.renderSeconds))} s
        ${r.placed && r.placed.removed ? `<br>Replaced ${r.placed.removed} earlier caption clip${r.placed.removed === 1 ? '' : 's'}.` : ''}
        <br><span class="cc-dim cc-path">${esc(r.path)}</span></div>` : ''}`)}
    ${section('Subtitle file', `<p class="cc-hint">Plain SRT for YouTube uploads or Premiere's own caption track (no animation or styling).</p>
      <div class="cc-row2"><button class="cc-btn" data-act="srt" ${ready ? '' : 'disabled'}>Export SRT</button>
      <button class="cc-btn" data-act="srt-track" ${ready && inCEP() ? '' : 'disabled'}>Add as caption track</button></div>
      ${S.srtPath ? `<p class="cc-dim cc-path">${esc(S.srtPath)}</p>` : ''}`)}`;
}

/* ── export ───────────────────────────────────────────────────── */

async function exportCaptions() {
  if (S.busy || !S.scene || !S.scene.captions.length) return;
  setPlaying(false);
  if (inCEP()) await refreshSequence(false);
  const ctrl = new AbortController();
  const scene = S.scene;
  const eff = effSettings();
  setBusy({ kind: 'render', label: 'Preparing…', progress: 0, cancel: () => ctrl.abort() });
  try {
    await ensureFont(eff.style.fontFamily, eff.style.fontWeight);
    const res = await renderOverlay(scene, eff, {
      baseUrl: getBaseUrl(), name: S.seq.name, codec: S.settings.output.codec, signal: ctrl.signal,
      onProgress: (done, total, eta) => {
        if (!S.busy) return;
        S.busy.progress = done / total;
        S.busy.label = `Rendering ${Math.round((done / total) * 100)}%` + (eta > 1 ? ` · about ${Math.ceil(eta)} s left` : '');
        updateFooter();
      },
    });
    S.lastRender = res;
    if (inCEP()) {
      setBusy({ kind: 'render', label: 'Placing on the timeline…', progress: null });
      const placed = await callCM('placeOverlay', { path: res.path, start: 0, duration: res.seconds });
      if (!placed || !placed.success) {
        throw new Error((placed && placed.error) || 'Failed to place caption overlay on timeline.');
      }
      res.placed = placed;
      setStatus(`Captions are on ${placed.trackName} (${fmtTime(res.seconds)}).` +
        (placed.removed ? ` Replaced ${placed.removed} earlier caption clip${placed.removed === 1 ? '' : 's'}.` : ''), 'ok');
    } else {
      setStatus(`Rendered ${res.frames} frames → ${res.path}`, 'ok');
    }
  } catch (e) {
    if (e && e.name === 'AbortError') setStatus('Render cancelled.');
    else setStatus('Could not add captions: ' + formatUserError(e), 'error');
  } finally {
    setBusy(null);
    if (S.tab === 'export') renderBody();
  }
}

async function exportSrt(placeTrack) {
  if (!S.scene) return;
  const cues = S.scene.captions.map((c) => ({ start: c.tIn, end: c.tOut,
    text: c.lines.map((l) => l.words.map((w) => w.text).join(' ')).join('\n') }));
  try {
    const res = await apiPost('/api/captions/srt', { cues, name: S.seq.name || 'captions' }, { timeoutMs: 30000 });
    S.srtPath = res.srt_path || '';
    if (placeTrack && res.srt_path) {
      const r = await callExtendScript('importCaptionsFromSRT', { srt_path: res.srt_path });
      setStatus(r && r.method === 'createCaptionTrack'
        ? 'Caption track added — style it in Premiere’s Properties panel.'
        : 'SRT imported to the project bin — drag it onto the timeline.', 'ok');
    } else {
      setStatus('SRT saved: ' + S.srtPath, 'ok');
    }
  } catch (e) {
    setStatus('SRT export failed: ' + formatUserError(e), 'error');
  }
  if (S.tab === 'export') renderBody();
}

/* ── presets ──────────────────────────────────────────────────── */

function applyPreset(id) {
  const p = findPreset(id);
  if (!p) return;
  S.settings.style = Object.assign({}, S.settings.style, p.style);
  S.settings.motion = Object.assign({}, M.MOTION_DEFAULTS, p.motion);
  S.settings.preset = id;
  saveSettingsSoon();
  renderBody();
  rebuildScene();
}

/* ── events ───────────────────────────────────────────────────── */

const RELAYOUT = /^(style\.(fontFamily|fontWeight|fontSize|textCase|punctuation|punctCommas|punctDots|punctExpressive)|layout\.|grouping\.|timing\.)/;
// Settings that show or hide other controls: re-render the tab when they change.
const STRUCTURAL = { 'style.background': 1, 'style.shadow': 1, 'style.emphasis': 1, 'style.fontFamily': 1,
  'style.punctuation': 1, 'motion.preset': 1, 'motion.highlight': 1, 'timing.exit': 1, 'grouping.maxLines': 1, previewAspect: 1 };

// Picking a colour for something that's switched off switches it on —
// otherwise the swatch looks broken (nothing changes).
const ENABLE_ON_COLOR = {
  'style.strokeColor': () => { if (!(S.settings.style.strokeWidth > 0)) return ['style.strokeWidth', 4]; return null; },
};

function onSetting(path) {
  if (ENABLE_ON_COLOR[path]) {
    const fix = ENABLE_ON_COLOR[path]();
    if (fix) {
      setPath(S.settings, fix[0], fix[1]);
      $$(`[data-bind="${fix[0]}"]`).forEach((o) => { o.value = fmtNum(fix[1]); });
    }
  }
  if (/^(style|motion)\./.test(path) && path !== 'style.fontSize') S.settings.preset = 'custom';
  if (path === 'style.fontFamily') {
    const ws = weightsFor(S.settings.style.fontFamily);
    if (ws.indexOf(Number(S.settings.style.fontWeight)) === -1) {
      S.settings.style.fontWeight = ws.reduce((a, b) => (Math.abs(b - 800) < Math.abs(a - 800) ? b : a), ws[0]);
    }
  }
  if (path === 'previewAspect') refreshSequence(false);
  if (RELAYOUT.test(path)) scheduleScene(); else requestDraw();
  if (STRUCTURAL[path]) renderBody();
  else if (path.indexOf('motion.') === 0 && S.tab === 'motion') drawMotionTiles();
  saveSettingsSoon();
}

function readControl(el) {
  const kind = el.dataset.kind;
  if (kind === 'bool') return el.checked;
  if (kind === 'num') {
    let v = parseFloat(el.value);
    if (isNaN(v)) return undefined;
    v = clamp(v, parseFloat(el.dataset.min), parseFloat(el.dataset.max));
    return el.dataset.scale ? v / parseFloat(el.dataset.scale) : v;
  }
  return el.value;
}

function onBoundInput(el) {
  const v = readControl(el);
  if (v === undefined) return;
  const path = el.dataset.bind;
  if (getPath(S.settings, path) === v) return;
  setPath(S.settings, path, v);
  $$(`[data-bind="${path}"]`).forEach((o) => {           // keep slider + number box in step
    if (o === el || o.dataset.kind !== 'num') return;
    o.value = fmtNum(el.dataset.scale ? v * parseFloat(el.dataset.scale) : v);
  });
  onSetting(path);
}

function bindEvents() {
  root.addEventListener('input', (e) => {
    const el = e.target;
    if (el.id === 'cc-scrub') { setPlaying(false); seek(parseFloat(el.value) || 0); return; }
    if (el.dataset && el.dataset.bind) onBoundInput(el);
  });
  root.addEventListener('change', (e) => {
    const el = e.target;
    if (el.id === 'cc-safe') { S.safe = el.value; requestDraw(); return; }
    if (el.id === 'cc-file') { const f = el.files && el.files[0]; el.value = ''; if (f) transcribeFile(f); return; }
    if (el.id === 'cc-use-in-out') { S.useInOut = el.checked; renderBody(); return; }
    if (el.dataset && el.dataset.bind) onBoundInput(el);   // older CEF fires only change for some inputs
  });
  const stEl = $('#cc-stage');
  if (stEl) {
    stEl.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) {
        e.preventDefault();
        changeZoom(e.deltaY < 0 ? 1 : -1);
      }
    }, { passive: false });
  }
  root.addEventListener('click', (e) => {
    const t = e.target;
    const tab = t.closest('[data-tab]');
    if (tab) { S.tab = tab.dataset.tab; S.editing = -1; renderBody(); return; }
    const seg = t.closest('.cc-seg button');
    if (seg) {
      const box = seg.parentElement;
      const path = box.dataset.bind;
      const v = /^-?\d+(\.\d+)?$/.test(seg.dataset.value) ? Number(seg.dataset.value) : seg.dataset.value;
      setPath(S.settings, path, v);
      $$('button', box).forEach((b) => b.classList.toggle('cc-on', b === seg));
      onSetting(path);
      return;
    }
    const preset = t.closest('[data-preset]');
    if (preset) { applyPreset(preset.dataset.preset); return; }
    const mot = t.closest('[data-motion]');
    if (mot) { S.settings.motion.preset = mot.dataset.motion; onSetting('motion.preset'); return; }
    const seekBtn = t.closest('[data-seek]');
    if (seekBtn) { setPlaying(false); seek(parseFloat(seekBtn.dataset.seek) + 0.001); return; }
    const w = t.closest('.cc-w');
    if (w) {
      S.sel = Number(w.dataset.i);
      $$('.cc-w.cc-sel').forEach((x) => x.classList.remove('cc-sel'));
      w.classList.add('cc-sel');
      renderSelBar();
      setPlaying(false);
      seek(S.words[S.sel].start + 0.001);
      const tx = $('#cc-tx');
      if (tx) tx.focus({ preventScroll: true });
      return;
    }
    const act = t.closest('[data-act]');
    if (act && !act.disabled) onAction(act.dataset.act);
  });
  root.addEventListener('dblclick', (e) => {
    const w = e.target.closest('.cc-w');
    if (w) { S.sel = Number(w.dataset.i); S.editing = S.sel; renderTranscriptList(); }
  });
  root.addEventListener('keydown', (e) => {
    const el = e.target;
    if (el.id === 'cc-w-edit') {
      if (e.key === 'Enter') { e.preventDefault(); commitEdit(el.value); }
      else if (e.key === 'Escape') { S.editing = -1; renderTranscriptList(); }
      return;
    }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
    if (k === ' ') { e.preventDefault(); setPlaying(!S.playing); return; }
    if (S.tab !== 'transcript' || S.sel < 0) return;
    if (k === 'h') wordAction('hide');
    else if (k === 'e') wordAction('emph');
    else if (k === 'b') wordAction('break');
    else if (k === 'enter') { S.editing = S.sel; renderTranscriptList(); }
    else if (k === 'arrowright' || k === 'arrowleft') {
      const nextIdx = clamp(S.sel + (k === 'arrowright' ? 1 : -1), 0, S.words.length - 1);
      if (nextIdx !== S.sel) {
        const prev = $(`.cc-w[data-i="${S.sel}"]`);
        if (prev) prev.classList.remove('cc-sel');
        S.sel = nextIdx;
        const cur = $(`.cc-w[data-i="${nextIdx}"]`);
        if (cur) {
          cur.classList.add('cc-sel');
          if (cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
        }
        renderSelBar();
        seek(S.words[S.sel].start + 0.001);
      }
    } else return;
    e.preventDefault();
  });
  root.addEventListener('focusout', (e) => {
    if (e.target.id === 'cc-w-edit' && S.editing >= 0) commitEdit(e.target.value);
  });
  // drag the caption in the preview to move it; drag its sides to resize
  const cvWrap = $('#cc-canvas-wrap');
  cvWrap.addEventListener('pointerdown', onCanvasDown);
  cvWrap.addEventListener('pointermove', (e) => { if (!S.drag) onCanvasHover(e); });
  cvWrap.addEventListener('pointerleave', () => { if (S.hoverBox) { S.hoverBox = false; requestDraw(); } });
}

function canvasPoint(e) {
  const r = $('#cc-canvas').getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 };
}
function boxHit(p) {
  const cv = $('#cc-canvas');
  const r = cv ? cv.getBoundingClientRect() : { width: 100, height: 100 };
  const pxPerPctX = (r.width || 100) / 100;
  const pxPerPctY = (r.height || 100) / 100;
  const hitTolX = Math.max(3.5, 12 / Math.max(0.1, pxPerPctX));
  const hitTolY = Math.max(3.5, 12 / Math.max(0.1, pxPerPctY));

  const lay = S.settings.layout;
  const half = lay.boxWidth / 2;
  const fsPct = (S.settings.style.fontSize * scaleK()) / S.seq.height * 100;
  const hh = (fsPct * (lay.lineHeight || 1.12) * Math.max(1, S.settings.grouping.maxLines || 1)) / 2 + 2;
  if (Math.abs(p.y - lay.posY) > hh + hitTolY) return null;
  if (Math.abs(p.x - (lay.posX - half)) < hitTolX) return 'left';
  if (Math.abs(p.x - (lay.posX + half)) < hitTolX) return 'right';
  if (Math.abs(p.x - lay.posX) < half) return 'move';
  return null;
}
function onCanvasHover(e) {
  const hit = boxHit(canvasPoint(e));
  const cv = $('#cc-canvas');
  if (cv) cv.style.cursor = hit === 'move' ? 'move' : hit ? 'ew-resize' : '';
  if (!!hit !== S.hoverBox) { S.hoverBox = !!hit; requestDraw(); }
}
function onCanvasDown(e) {
  const p = canvasPoint(e);
  const hit = boxHit(p);
  if (!hit) return;
  e.preventDefault();
  const cvWrap = $('#cc-canvas-wrap');
  if (cvWrap && cvWrap.setPointerCapture) {
    try { cvWrap.setPointerCapture(e.pointerId); } catch (_) {}
  }
  const lay = S.settings.layout;
  S.drag = { mode: hit, x: p.x, y: p.y, posX: lay.posX, posY: lay.posY, box: lay.boxWidth, pointerId: e.pointerId };
  const move = (ev) => {
    if (!S.drag) return;
    const q = canvasPoint(ev);
    if (S.drag.mode === 'move') {
      lay.posX = clamp(Math.round((S.drag.posX + q.x - S.drag.x) * 2) / 2, 5, 95);
      lay.posY = clamp(Math.round((S.drag.posY + q.y - S.drag.y) * 2) / 2, 5, 95);
    } else if (S.drag.mode === 'left') {
      const rightEdge = S.drag.posX + S.drag.box / 2;
      const newLeft = clamp(S.drag.posX - S.drag.box / 2 + (q.x - S.drag.x), 5, rightEdge - 20);
      lay.boxWidth = clamp(Math.round(rightEdge - newLeft), 20, 100);
      lay.posX = clamp(Math.round((newLeft + rightEdge) / 2 * 2) / 2, 5, 95);
    } else if (S.drag.mode === 'right') {
      const leftEdge = S.drag.posX - S.drag.box / 2;
      const newRight = clamp(S.drag.posX + S.drag.box / 2 + (q.x - S.drag.x), leftEdge + 20, 95);
      lay.boxWidth = clamp(Math.round(newRight - leftEdge), 20, 100);
      lay.posX = clamp(Math.round((leftEdge + newRight) / 2 * 2) / 2, 5, 95);
    }
    $$('[data-bind="layout.posX"]').forEach((el) => { el.value = lay.posX; });
    $$('[data-bind="layout.posY"]').forEach((el) => { el.value = lay.posY; });
    $$('[data-bind="layout.boxWidth"]').forEach((el) => { el.value = lay.boxWidth; });
    scheduleScene();
  };
  const up = () => {
    if (cvWrap && cvWrap.releasePointerCapture && S.drag && S.drag.pointerId != null) {
      try { cvWrap.releasePointerCapture(S.drag.pointerId); } catch (_) {}
    }
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    S.drag = null;
    saveSettingsSoon();
    if (S.tab === 'style') renderBody();
    requestDraw();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

function onAction(act) {
  switch (act) {
    case 'close': closeCaptions(); break;
    case 'refresh-seq':
      refreshSequence(false);
      setStatus(inCEP() ? 'Sequence re-read.' : 'Preview mode — not connected to Premiere.');
      break;
    case 'play': setPlaying(!S.playing); break;
    case 'bg':
      if (S.bg === 'checker') {
        S.bg = 'dark';
      } else if (S.bg === 'dark') {
        S.bg = 'frame';
        if (!S.bgImage) captureSequenceFrame();
      } else {
        S.bg = 'checker';
      }
      requestDraw();
      break;
    case 'capture-frame': captureSequenceFrame(); break;
    case 'zoom-in': changeZoom(1); break;
    case 'zoom-out': changeZoom(-1); break;
    case 'zoom-reset': changeZoom(0); break;
    case 'toggle-preview': S.previewOpen = !S.previewOpen; layoutPreview(); break;
    case 'dismiss': setStatus(null); break;
    case 'cancel': if (S.busy && S.busy.cancel) S.busy.cancel(); break;
    case 'export': exportCaptions(); break;
    case 'srt': exportSrt(false); break;
    case 'srt-track': exportSrt(true); break;
    case 'transcribe-seq': transcribeSequence(); break;
    case 'upload': $('#cc-file').click(); break;
    case 'paste-toggle': S.pasteOpen = !S.pasteOpen; renderBody(); break;
    case 'paste-use': {
      const words = parsePasted(($('#cc-paste') || {}).value);
      if (!words.length) { setStatus('Nothing to use — paste SRT, JSON or plain text.', 'error'); break; }
      setWords(words, `${words.length} words from the pasted transcript.`);
      break;
    }
    case 'source-toggle': S.showSource = !S.showSource; renderBody(); break;
    case 'clear-tx': clearTranscript(); break;
    case 'find-toggle': S.findOpen = !S.findOpen; renderBody(); if (S.findOpen) { const f = $('#cc-find'); if (f) f.focus(); } break;
    case 'replace-all': replaceAll(); break;
    case 'undo': undo(); break;
    case 'redo': redo(); break;
    case 'w-hide': wordAction('hide'); break;
    case 'w-emph': wordAction('emph'); break;
    case 'w-break': wordAction('break'); break;
    case 'w-earlier': wordAction('earlier'); break;
    case 'w-later': wordAction('later'); break;
    case 'w-edit': S.editing = S.sel; renderTranscriptList(); break;
    default: break;
  }
}

// Read-only window for the browser test-suite (tests/ui) and the CEP
// debugger: state snapshot + the pure model. Nothing here mutates.
try {
  window.__editflowCaptions = {
    state: () => S,
    model: M,
    effSettings: () => effSettings(),
    drawAt: (canvas, t) => { const sc = S.scene; if (!sc) return 0; return drawFrame(canvas.getContext('2d'), sc, effSettings(), t, { scale: canvas.width / sc.width }); },
  };
} catch (_) { /* no window (Node harness) */ }

export { openCaptions, closeCaptions, formatUserError };
