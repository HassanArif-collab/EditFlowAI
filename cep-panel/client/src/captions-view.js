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
import { drawFrame, STYLE_DEFAULTS, normalizeHex as _importedNormalizeHex } from './captions/render.js';
import { BUNDLED, ensureFont, makeMeasurer, listSystemFonts, injectFontStyles, weightName } from './captions/fonts.js';
import { PRESETS, findPreset, getAllPresets, saveUserPreset, deleteUserPreset } from './captions/presets.js';
import { renderOverlay } from './captions/export.js';
import { SAFE_ZONES, drawSafeZones } from './captions/safe-zones.js';
import { getEmojiSuggestion, findAllSuggestions } from './captions/emojis.js';
import {
  fmtTimestamp,
  parseTimestamp,
  autoDetectChapters,
  formatSocialChapters,
  parseSocialChapters,
  validateYouTubeChapters,
} from './captions/chapters.js';

const SETTINGS_KEY = 'editflow.captions.settings.v3';
const SETTINGS_KEY_V2 = 'editflow.captions.settings.v2';
const WORDS_KEY = 'editflow.captions.words.';
const AUDIO_KEY = 'editflow.captions.audio.';
const CHAPTERS_KEY = 'editflow.captions.chapters.';
const REF = 1080;   // style sizes are authored at 1080p and scale with the sequence

const DEFAULTS = {
  preset: 'clean',
  previewAspect: '9:16',
  style: Object.assign({}, STYLE_DEFAULTS),
  motion: Object.assign({}, M.MOTION_DEFAULTS),
  layout: { posX: 50, posY: 72, boxWidth: 86, lineHeight: 1.12, align: 'center', rotation: 0 },
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
  transcribeScope: 'inout',
  audio: null,
  audioUrl: '',
  audioMuted: false,
  audioRangeIn: 0,
  chapters: [],
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
  for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]] = o[ks[i]] || (/^\d+$/.test(ks[i + 1]) ? [] : {});
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

function normalizeHex(val, fallback = '#ffffff') {
  try {
    if (typeof _importedNormalizeHex === 'function') {
      const res = _importedNormalizeHex(val, fallback);
      if (res != null) return res;
    }
  } catch (_) {}
  if (val == null) return fallback;
  const s = String(val).trim().toLowerCase();
  if (!s) return fallback;
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^[0-9a-f]{6}$/.test(s)) return '#' + s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  if (/^[0-9a-f]{3}$/.test(s)) return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`;
  if (/^#[0-9a-f]{4}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  if (/^[0-9a-f]{4}$/.test(s)) return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`;
  if (/^#[0-9a-f]{8}$/.test(s)) return s.slice(0, 7);
  if (/^[0-9a-f]{8}$/.test(s)) return '#' + s.slice(0, 6);
  const rgbMatch = s.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
  if (rgbMatch) {
    const r = Math.min(255, parseInt(rgbMatch[1], 10)).toString(16).padStart(2, '0');
    const g = Math.min(255, parseInt(rgbMatch[2], 10)).toString(16).padStart(2, '0');
    const b = Math.min(255, parseInt(rgbMatch[3], 10)).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  }
  return fallback;
}

const ICONS = {
  play: '<path d="M8 5v14l11-7z"/>',
  pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>',
  undo: '<path d="M12.5 8C9.9 8 7.5 9 5.7 10.6L2 7v9h9l-3.6-3.6A7 7 0 0 1 19.3 15l2.4-.8A9.5 9.5 0 0 0 12.5 8z"/>',
  redo: '<path d="M18.4 10.6A9.4 9.4 0 0 0 11.5 8a9.5 9.5 0 0 0-9.2 6.2l2.4.8A7 7 0 0 1 16.6 12.4L13 16h9V7z"/>',
  eye: '<path d="M12 5C6.5 5 2.7 9.3 1.5 12c1.2 2.7 5 7 10.5 7s9.3-4.3 10.5-7C21.3 9.3 17.5 5 12 5zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"/>',
  eyeOff: '<path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.44-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.47-1.8c.22 0 .44.03.65.08l-2.08 2.08c-.05-.21-.08-.43-.08-.65 0-1.66 1.34-3 3-3z"/>',
  bg: '<path d="M3 3h8v8H3zM13 13h8v8h-8z"/><path d="M13 3h8v8h-8zM3 13h8v8H3z" opacity=".35"/>',
  camera: '<path d="M9 3L7.17 5H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2h-3.17L15 3H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>',
  volume: '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>',
  mute: '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27l4.73 4.73H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>',
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
  const merged = deepMerge(DEFAULTS, saved || {});
  if (merged.style) {
    const s = merged.style;
    const colorProps = [
      'color', 'activeColor', 'emphasisColor', 'pillColor',
      'strokeColor', 'shadowColor', 'bgColor', 'hlBoxColor',
      'gradientColor', 'activeGlowColor'
    ];
    for (const p of colorProps) {
      if (s[p] != null) s[p] = normalizeHex(s[p], STYLE_DEFAULTS[p] || '#ffffff');
    }
    if (Array.isArray(s.speakerColors)) {
      s.speakerColors = s.speakerColors.map((c, i) =>
        normalizeHex(c, (STYLE_DEFAULTS.speakerColors && STYLE_DEFAULTS.speakerColors[i]) || '#ffffff')
      );
    }
  }
  return merged;
}
function saveSettingsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S.settings)); } catch (_) { /* quota */ }
  }, 250);
}
function wordsKey() { return WORDS_KEY + (S.seq && S.seq.id ? S.seq.id : 'default'); }
function audioKey() { return AUDIO_KEY + (S.seq && S.seq.id ? S.seq.id : 'default'); }
function saveWords() {
  try {
    if (S.words.length) localStorage.setItem(wordsKey(), JSON.stringify(S.words));
    else localStorage.removeItem(wordsKey());
  } catch (_) { /* quota — words still live in memory */ }
}
function saveAudio() {
  try {
    if (S.audioUrl) {
      localStorage.setItem(audioKey(), JSON.stringify({ url: S.audioUrl, rangeIn: S.audioRangeIn || 0 }));
    } else {
      localStorage.removeItem(audioKey());
    }
  } catch (_) { /* quota */ }
}
function loadAudio() {
  try {
    const raw = localStorage.getItem(audioKey());
    if (raw) {
      const data = JSON.parse(raw);
      if (data && data.url) {
        initAudio(data.url, data.rangeIn || 0);
        return;
      }
    }
  } catch (_) {}
  if (S.audio) {
    try { S.audio.pause(); S.audio.src = ''; } catch (_) {}
  }
  S.audioUrl = '';
  S.audioRangeIn = 0;
  updateAudioBtn();
}
function chaptersKey() { return CHAPTERS_KEY + (S.seq && S.seq.id ? S.seq.id : 'default'); }
function saveChapters() {
  try {
    if (S.chapters && S.chapters.length) localStorage.setItem(chaptersKey(), JSON.stringify(S.chapters));
    else localStorage.removeItem(chaptersKey());
  } catch (_) {}
}
function loadChapters() {
  try {
    const raw = localStorage.getItem(chaptersKey());
    S.chapters = raw ? JSON.parse(raw) : [];
  } catch (_) {
    S.chapters = [];
  }
}
function loadWords() {
  try { S.words = JSON.parse(localStorage.getItem(wordsKey()) || '[]') || []; } catch (_) { S.words = []; }
  S.sel = -1; S.history = []; S.future = []; S.editing = -1;
  loadAudio();
  loadChapters();
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
  if (S.audio) {
    try { S.audio.pause(); } catch (_) {}
  }
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
      if (first || !S.scopeUserOverridden) {
        S.transcribeScope = S.seq.hasInOut ? 'inout' : 'full';
      }
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
      <button class="cc-icon-btn hidden" id="cc-audio-btn" data-act="toggle-audio" title="Mute / unmute audio">${icon('volume')}</button>
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
      <button class="cc-icon-btn${S.previewOpen ? '' : ' cc-on'}" data-act="toggle-preview" title="${S.previewOpen ? 'Hide preview' : 'Show preview'}">${icon(S.previewOpen ? 'eye' : 'eyeOff')}</button>
    </div>
    <div class="cc-tabs" role="tablist">${TABS.map(([id, label]) =>
      `<button class="cc-tab" role="tab" data-tab="${id}">${label}</button>`).join('')}</div>
    <div class="cc-body" id="cc-body"></div>
    <div class="cc-status hidden" id="cc-status"></div>
    <div class="cc-footer" id="cc-footer"></div>
    <audio id="cc-audio" preload="auto" style="display:none"></audio>
    <input type="file" id="cc-file" accept="audio/*,video/*" class="hidden">`;
  if (window.ResizeObserver) {
    let lastW = 0;
    new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (w === lastW) return;
      lastW = w;
      if (S.previewOpen) requestAnimationFrame(layoutPreview);
    }).observe($('#cc-stage'));
  }
  const stageEl = $('#cc-stage');
  if (stageEl) {
    stageEl.addEventListener('transitionend', (e) => {
      if (e.target === stageEl && S.previewOpen) {
        requestAnimationFrame(layoutPreview);
      }
    });
  }
  window.addEventListener('resize', () => requestAnimationFrame(layoutPreview));
  bindResizer();
  if (S.audioUrl) initAudio(S.audioUrl, S.audioRangeIn);
  updateAudioBtn();
}

/* ── preview & zoom ───────────────────────────────────────────── */

function updatePreviewToggleBtn() {
  const btn = $('[data-act="toggle-preview"]');
  if (!btn) return;
  btn.classList.toggle('cc-on', !S.previewOpen);
  btn.title = S.previewOpen ? 'Hide preview' : 'Show preview';
  btn.innerHTML = icon(S.previewOpen ? 'eye' : 'eyeOff');
}

function layoutPreview() {
  const stage = $('#cc-stage');
  const cv = $('#cc-canvas');
  if (!stage || !cv) return;

  stage.classList.remove('hidden');
  stage.classList.toggle('cc-stage-collapsed', !S.previewOpen);
  const resizer = $('#cc-stage-resizer');
  if (resizer) resizer.classList.toggle('hidden', !S.previewOpen);

  updatePreviewToggleBtn();

  if (!S.previewOpen) {
    stage.style.height = '0px';
    return;
  }

  const rootH = (root && root.clientHeight > 0) ? root.clientHeight : (window.innerHeight || 600);
  const userH = S.previewHeight || (S.settings && S.settings.previewHeight);
  const numUserH = Number(userH);
  const validUserH = (isFinite(numUserH) && numUserH >= 80) ? numUserH : null;
  const baseH = validUserH ? Math.max(90, Math.min(rootH * 0.78, validUserH))
                           : Math.max(120, Math.min(560, rootH * 0.34));
  stage.style.height = Math.round(baseH) + 'px';

  const avW = Math.max(120, (stage.clientWidth || (root && root.clientWidth) || 300) - 16);
  const avH = Math.max(80, baseH - 16);
  const seqW = (S.seq && S.seq.width > 0) ? S.seq.width : 1080;
  const seqH = (S.seq && S.seq.height > 0) ? S.seq.height : 1920;
  const ar = seqW / seqH;
  let w = avW, h = w / ar;
  if (h > avH) { h = avH; w = h * ar; }

  const zoom = S.previewZoom || 1.0;
  const dpr = window.devicePixelRatio || 1;
  const dispW = Math.max(1, Math.round(w * zoom));
  const dispH = Math.max(1, Math.round(h * zoom));

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
  const stage = $('#cc-stage');
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
    if (stage) stage.style.transition = '';
    saveSettingsSoon();
  };
  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    startY = e.clientY;
    startH = ($('#cc-stage') || {}).clientHeight || (root.clientHeight * 0.34);
    resizer.classList.add('cc-resizing');
    if (stage) stage.style.transition = 'none';
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

async function captureSequenceFrame(usePlayhead) {
  if (!inCEP()) {
    setStatus('Frame capture requires an active Premiere Pro sequence.', 'info');
    return;
  }
  setStatus('Grabbing sequence frame…', 'info');
  try {
    let targetTime = null;
    if (usePlayhead) {
      try {
        const info = await callCM('sequenceInfo');
        if (info && info.playhead != null) {
          S.seq.playhead = info.playhead;
          targetTime = info.playhead;
        }
      } catch (_) {}
    }
    if (targetTime == null) {
      targetTime = (S.t != null && S.t > 0) ? S.t : (S.seq && S.seq.playhead ? S.seq.playhead : 0);
    }
    const res = await callCM('captureSequenceFrame', { time: targetTime, usePlayhead: !!usePlayhead });
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
      const fullUrl = (url.startsWith('http') ? url : (getBaseUrl() + url)).replace('://localhost:', '://127.0.0.1:');
      const im = new Image();
      im.onload = () => {
        S.bgImage = im;
        S.bg = 'frame';
        requestDraw();
        setStatus(`Frame captured at ${fmtTime(targetTime)}.`, 'ok');
      };
      im.onerror = () => {
        setStatus('Could not load captured frame image.', 'error');
      };
      im.src = fullUrl;
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
  try {
    if (S.scene) drawFrame(ctx, S.scene, effSettings(), S.t, { scale: W / ((S.seq && S.seq.width) || 1080), clear: false });
  } catch (err) {
    console.error('[Captions] drawPreview drawFrame error:', err);
  }
  if (S.safe !== 'off' && (S.safe === 'title' || S.seq.height > S.seq.width)) drawSafeZones(ctx, W, H, S.safe);
  if (S.drag || S.hoverBox) {
    const lay = S.settings.layout, k = W / S.seq.width;
    const bw = S.seq.width * lay.boxWidth / 100 * k;
    const fs = S.settings.style.fontSize * scaleK() * k;
    const bh = fs * (lay.lineHeight || 1.12) * Math.max(1, S.settings.grouping.maxLines || 1);
    const cx = S.seq.width * lay.posX / 100 * k, cy = S.seq.height * lay.posY / 100 * k;
    ctx.save();
    if (S.drag && Math.abs(lay.posX - 50) < 0.25) {
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(255, 75, 120, 0.85)';
      ctx.lineWidth = 1;
      ctx.moveTo(W / 2 + 0.5, 0);
      ctx.lineTo(W / 2 + 0.5, H);
      ctx.stroke();
    }
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(80,160,255,.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - bw / 2 + 0.5, cy - bh / 2 + 0.5, bw, bh);
    ctx.fillStyle = '#50a0ff';
    const hw = 4, hh = Math.min(22, bh * 0.7);
    ctx.fillRect(cx - bw / 2 - hw / 2, cy - hh / 2, hw, hh);
    ctx.fillRect(cx + bw / 2 - hw / 2, cy - hh / 2, hw, hh);
    const thw = Math.min(26, bw * 0.4), thh = 4;
    ctx.fillRect(cx - thw / 2, cy - bh / 2 - thh / 2, thw, thh);
    ctx.fillRect(cx - thw / 2, cy + bh / 2 - thh / 2, thw, thh);
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

/* ── audio player & playback sync ────────────────────────────── */

function initAudio(url, rangeIn) {
  if (S.audio) {
    try { S.audio.pause(); } catch (_) {}
  }
  if (!url) {
    S.audioUrl = '';
    S.audioRangeIn = 0;
    if (S.audio) {
      try { S.audio.src = ''; } catch (_) {}
    }
    saveAudio();
    updateAudioBtn();
    return;
  }
  S.audioUrl = url;
  if (rangeIn != null) S.audioRangeIn = Number(rangeIn) || 0;
  saveAudio();
  try {
    let audioEl = $('#cc-audio');
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.id = 'cc-audio';
      audioEl.preload = 'auto';
      audioEl.style.display = 'none';
      document.body.appendChild(audioEl);
    }
    const fullUrl = (url.startsWith('http') ? url : (getBaseUrl() + url)).replace('://localhost:', '://127.0.0.1:');
    if (audioEl.src !== fullUrl) {
      audioEl.src = fullUrl;
    }
    audioEl.muted = !!S.audioMuted;
    audioEl.volume = S.audioVolume != null ? S.audioVolume : 1.0;

    audioEl.onplay = () => {
      if (!S.playing && S.scene && S.scene.duration) {
        S.playing = true;
        const b = $('[data-act="play"]');
        if (b) b.innerHTML = icon('pause');
        if (!rafId) rafId = requestAnimationFrame(tick);
      }
    };
    audioEl.onpause = () => {
      if (S.playing) {
        setPlaying(false);
      }
    };
    audioEl.onended = () => {
      setPlaying(false);
      const startT = (S.words && S.words.length && S.words[0].start != null) ? S.words[0].start : 0;
      seek(startT);
    };
    audioEl.onerror = (e) => {
      console.warn('Preview audio failed to load:', fullUrl, e);
      setPlaying(false);
      updateAudioBtn();
    };
    audioEl.oncanplay = () => {
      updateAudioBtn();
    };
    S.audio = audioEl;
    updateAudioBtn();
  } catch (err) {
    console.warn('Could not initialize audio player:', err);
  }
}

function updateAudioBtn() {
  const b = $('#cc-audio-btn');
  if (!b) return;
  if (!S.audioUrl) {
    b.classList.add('hidden');
    return;
  }
  b.classList.remove('hidden');
  b.innerHTML = icon(S.audioMuted ? 'mute' : 'volume');
  b.title = S.audioMuted ? 'Unmute preview audio' : 'Mute preview audio';
  b.classList.toggle('cc-on', !S.audioMuted);
}

function tick(now) {
  rafId = 0;
  if (!S.playing) return;
  const dur = S.scene ? S.scene.duration : 0;
  const rin = S.audioRangeIn || 0;
  if (S.audio && !S.audio.paused && !S.audio.ended && isFinite(S.audio.currentTime)) {
    S.t = S.audio.currentTime + rin;
    lastTick = now;
  } else {
    const rawDt = lastTick ? (now - lastTick) / 1000 : 0;
    const dt = Math.min(0.1, Math.max(0, rawDt));
    lastTick = now;
    S.t += dt;
  }
  const startT = (S.words && S.words.length && S.words[0].start != null) ? S.words[0].start : 0;
  if (dur > 0 && (S.t >= dur || (S.audio && S.audio.ended))) {
    setPlaying(false);
    seek(startT);
    return;
  }
  drawPreview();
  updateTransport();
  highlightPlayingWord();
  if (S.playing) {
    rafId = requestAnimationFrame(tick);
  }
}
function setPlaying(on) {
  const next = !!on && !!(S.scene && S.scene.duration);

  // When stopping: ALWAYS pause audio and stop RAF, even if S.playing was already false
  if (!next) {
    S.playing = false;
    if (S.audio) {
      try { S.audio.pause(); } catch (_) {}
    }
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    lastTick = 0;
    const b = $('[data-act="play"]');
    if (b) b.innerHTML = icon('play');
    return;
  }

  // When starting: only proceed if not already playing
  if (S.playing === next) return;
  S.playing = true;
  const b = $('[data-act="play"]');
  if (b) b.innerHTML = icon('pause');

  lastTick = 0;
  if (S.audio && S.audioUrl) {
    try {
      const audioT = Math.max(0, S.t - (S.audioRangeIn || 0));
      if (isFinite(S.audio.duration) && audioT < S.audio.duration) {
        S.audio.currentTime = audioT;
      } else if (audioT === 0 || !isFinite(S.audio.duration)) {
        S.audio.currentTime = 0;
      }
      const p = S.audio.play();
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          console.warn('Audio play was prevented or failed:', err);
          setPlaying(false);
        });
      }
    } catch (err) {
      console.warn('Audio playback exception:', err);
      setPlaying(false);
      return;
    }
  }
  if (!rafId) rafId = requestAnimationFrame(tick);
}
function seek(t) {
  S.t = clamp(t, 0, S.scene ? S.scene.duration : 0);
  if (S.audio) {
    try {
      const audioT = Math.max(0, S.t - (S.audioRangeIn || 0));
      if (!isFinite(S.audio.duration) || audioT <= S.audio.duration) {
        S.audio.currentTime = audioT;
      }
    } catch (_) {}
  }
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
function ctlSeg(path, label, options, matchFn) {
  const raw = getPath(S.settings, path);
  const sv = String(raw != null ? raw : '');
  return `<div class="cc-ctl"><label class="cc-lbl">${label}</label><div class="cc-seg" data-bind="${path}" data-kind="seg">
    ${options.map(([val, text, title]) => {
      const on = matchFn ? matchFn(val, raw) : String(val) === sv;
      return `<button type="button" data-value="${esc(val)}" class="${on ? 'cc-on' : ''}"${title ? ` title="${esc(title)}"` : ''}>${text}</button>`;
    }).join('')}
  </div></div>`;
}
function ctlColor(path, label) {
  const raw = getPath(S.settings, path);
  const hex = normalizeHex(raw, '#ffffff');
  return `<div class="cc-color cc-color-group">
    <div class="cc-color-ctrl">
      <input type="color" class="cc-color-swatch" value="${esc(hex)}" data-bind="${path}" data-kind="color" aria-label="${esc(label)} color swatch">
      <input type="text" class="cc-hex-input cc-color-hex" value="${esc(hex)}" data-bind="${path}" data-kind="hex" maxlength="24" spellcheck="false" autocomplete="off" aria-label="${esc(label)} hex code" placeholder="#FFFFFF">
    </div>
    <span class="cc-color-lbl">${label}</span>
  </div>`;
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
  const seqDur = S.seq && S.seq.duration ? S.seq.duration : 0;
  const outPt = S.seq && S.seq.outPoint != null ? S.seq.outPoint : seqDur;
  const inOutSpan = fmtTime(Math.max(0, outPt - inPt));
  const inOutText = `${fmtTime(inPt)} – ${fmtTime(outPt)}`;
  const fullSpan = fmtTime(seqDur);
  const fullText = `0:00.0 – ${fullSpan}`;

  const isInOut = S.transcribeScope === 'inout';
  const currentSpanText = isInOut ? inOutText : fullText;
  const currentSpanDuration = isInOut ? inOutSpan : fullSpan;
  const btnLabel = isInOut
    ? `${icon('mic')} Transcribe In/Out range (${inOutText})`
    : `${icon('mic')} Transcribe entire sequence (${fullText})`;

  return `<div class="cc-source">
    <div style="margin: 0 0 10px; background: var(--cc-raised, #242424); border: 1px solid var(--cc-line, #383838); border-radius: 6px; padding: 8px 10px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 6px;">
        <span style="font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--cc-bright, #eee);">Transcription Scope</span>
        <button class="cc-btn cc-small" data-act="refresh-seq" title="Re-read timeline markers from Premiere" style="padding: 2px 7px; font-size: 11px; height: 22px;">
          ${icon('refresh')} Re-read Timeline
        </button>
      </div>
      <div class="cc-seg" style="margin-bottom: 6px;">
        <button type="button" class="${isInOut ? 'cc-on' : ''}" data-act="set-scope" data-scope="inout" title="Transcribe strictly between In and Out points (${inOutText})">
          In/Out Range (${inOutSpan})
        </button>
        <button type="button" class="${!isInOut ? 'cc-on' : ''}" data-act="set-scope" data-scope="full" title="Transcribe entire sequence (${fullSpan})">
          Full Sequence (${fullSpan})
        </button>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; font-size: 11px; color: var(--cc-dim, #aaa);">
        <span>Region: <b style="color:var(--cc-accent-2, #69a9ff)">${currentSpanText}</b> (${currentSpanDuration})</span>
        ${hasInOut ? '<span style="color:#7ee787; font-size: 10.5px;">● In/Out marked</span>' : '<span style="font-size: 10.5px; opacity: 0.8;">(no markers set)</span>'}
      </div>
    </div>
    <button class="cc-btn cc-primary cc-wide" data-act="transcribe-seq" ${live && !S.busy ? '' : 'disabled'}>${btnLabel}</button>
    <p class="cc-hint">${live ? 'Uses timeline audio as cut, so captions line up with your edit. Muted tracks are skipped — mute music first.'
      : 'Open the panel inside Premiere to transcribe the sequence. You can still upload a file or paste a transcript.'}</p>
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
  const fillers = M.findFillerRanges(S.words);
  const silences = M.findSilenceRanges(S.words, 0.6, 0.2);
  const totalSilenceSaved = silences.reduce((acc, s) => acc + s.saved, 0);
  const emojiSuggestions = (S.settings.style.emojiEnabled && S.words.length) ? findAllSuggestions(S.words) : [];
  const cutBar = (fillers.length > 0 || silences.length > 0 || emojiSuggestions.length > 0) ? `
    <div class="cc-cutbar">
      <span class="cc-cutbar-label">Timeline Tools:</span>
      ${fillers.length > 0 ? `<button class="cc-btn cc-small" data-act="clean-fillers" title="Ripple delete ${fillers.length} filler words from sequence timeline">Cut Fillers (${fillers.length})</button>` : ''}
      ${silences.length > 0 ? `<button class="cc-btn cc-small" data-act="trim-silence" title="Tighten ${silences.length} long pauses and ripple delete silence from timeline">Tighten Pauses (${fmtTime(totalSilenceSaved)})</button>` : ''}
      ${emojiSuggestions.length > 0 ? `<button class="cc-btn cc-small" data-act="apply-all-emojis" title="Apply ${emojiSuggestions.length} keyword emojis">Apply Emojis (${emojiSuggestions.length})</button>` : ''}
    </div>` : '';

  return `
    <div class="cc-txbar">
      <button class="cc-icon-btn" data-act="undo" title="Undo (Ctrl+Z)" ${S.history.length ? '' : 'disabled'}>${icon('undo')}</button>
      <button class="cc-icon-btn" data-act="redo" title="Redo (Ctrl+Shift+Z)" ${S.future.length ? '' : 'disabled'}>${icon('redo')}</button>
      <button class="cc-icon-btn${S.findOpen ? ' cc-on' : ''}" data-act="find-toggle" title="Find & replace">${icon('search')}</button>
      <span class="cc-dim cc-grow" id="cc-txcount">${S.words.length} words · ${vis} captions${hidden ? ` · ${hidden} hidden` : ''}${sourceLabel}</span>
      <button class="cc-btn cc-small" data-act="source-toggle">${S.showSource ? 'Done' : 'Re-transcribe…'}</button>
      <button class="cc-btn cc-small" data-act="clear-tx" title="Clear current transcript and start fresh">Clear</button>
    </div>
    ${cutBar}
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
    if (w.speaker != null) cls.push('cc-spk-' + ((Number(w.speaker) || 0) + 1));
    if (i === S.sel) cls.push('cc-sel');
    if (w.breakBefore) cls.push('cc-brk');
    if (i === S.editing) {
      html += `<input class="cc-w-edit" id="cc-w-edit" value="${esc(w.text)}" data-i="${i}" spellcheck="false" size="${Math.max(3, w.text.length + 2)}">`;
    } else {
      let emojiBadge = '';
      if (w.emoji) {
        emojiBadge = `<span class="cc-emoji-pill cc-emoji-active" data-act="w-remove-emoji" data-i="${i}" title="Remove ${w.emoji}">${w.emoji}<small>✕</small></span>`;
      }
      html += `<span class="${cls.join(' ')}" data-i="${i}" title="${fmtTime(w.start)}${!visible && w.hidden !== true ? ' · filler, hidden automatically' : ''}">${esc(w.text)}${emojiBadge}</span>`;
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
  const curSpk = (w.speaker != null && isFinite(w.speaker)) ? Number(w.speaker) : 0;
  const sugg = (!w.emoji && S.settings.style.emojiEnabled) ? getEmojiSuggestion(w.text) : null;
  bar.classList.remove('hidden');
  bar.innerHTML = `<span class="cc-selword">“${esc(w.text)}” <span class="cc-dim">${fmtTime(w.start)}</span></span>
    <button class="cc-btn cc-small" data-act="w-hide" title="Hide / show this word (H)">${vis ? 'Hide' : 'Show'}</button>
    <button class="cc-btn cc-small${w.emphasis ? ' cc-on' : ''}" data-act="w-emph" title="Emphasise (E)">Emphasis</button>
    <button class="cc-btn cc-small${w.speaker ? ' cc-on' : ''}" data-act="w-speaker" title="Toggle speaker assignment (Speaker 1 / Speaker 2)">Speaker ${curSpk + 1}</button>
    ${sugg ? `<button class="cc-btn cc-small" data-act="w-apply-emoji" data-i="${S.sel}" data-emoji="${sugg}" title="Add suggested ${sugg}">+ ${sugg}</button>` : ''}
    <button class="cc-btn cc-small${w.emoji ? ' cc-on' : ''}" data-act="w-custom-emoji" title="Set emoji for this word">${w.emoji ? `${w.emoji} Emoji` : 'Emoji…'}</button>
    <button class="cc-btn cc-small${w.breakBefore ? ' cc-on' : ''}" data-act="w-break" title="Start a new caption at this word (B)">New caption</button>
    <button class="cc-btn cc-small" data-act="w-edit" title="Fix the spelling (Enter)">Edit</button>
    <button class="cc-btn cc-small cc-danger" data-act="w-cut" title="Delete word and ripple cut from Premiere timeline (Del / Backspace)">Ripple Cut</button>
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
  else if (act === 'speaker') w.speaker = ((Number(w.speaker) || 0) + 1) % 2;
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

/* ── timeline ripple editing (Descript-style text cuts) ────────── */

async function executeTimelineRippleCut(ranges, desc) {
  if (!ranges || !ranges.length) return;
  if (!inCEP()) {
    snapshot();
    S.words = M.applyRippleDeletesToWords(S.words, ranges);
    S.sel = -1;
    wordsChanged();
    setStatus(`${desc} (preview mode: excised from transcript; connect to Premiere for timeline cut)`, 'info');
    return;
  }
  setBusy({ kind: 'cut', label: `${desc}…`, progress: null });
  try {
    const res = await callExtendScript('removeTimelineRanges', { ranges: ranges });
    if (!res || !res.success) {
      throw new Error((res && res.error) || 'Timeline cut failed');
    }
    snapshot();
    S.words = M.applyRippleDeletesToWords(S.words, ranges);
    S.sel = -1;
    wordsChanged();
    const timeSaved = res.totalTimeSaved ? ` (${fmtTime(res.totalTimeSaved)} saved)` : '';
    setStatus(`${desc} on timeline${timeSaved}`, 'ok');
  } catch (err) {
    setStatus(`Timeline cut failed: ${formatUserError(err)}`, 'error');
  } finally {
    setBusy(null);
  }
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
  S.t = (S.words && S.words.length && S.words[0].start != null) ? S.words[0].start : 0;
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
  initAudio('');
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
    await refreshSequence(false);
    const scope = S.transcribeScope || 'inout';
    const useInOut = (scope === 'inout');
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
    const modelLabel = res.model ? `${res.model} · ${res.engine || 'faster_whisper'}` : (res.engine || 'whisper');
    S.sourceName = clips.name || 'Sequence';
    setWords(words, `${words.length} words from “${clips.name}”${rangeLabel} (${modelLabel})${skipped ? ` — ${skipped} offline clip(s) skipped` : ''}.`);
    if (res.audio_url) {
      initAudio(res.audio_url, res.range_in || 0);
    }
    if (!S.bgImage) {
      try { captureSequenceFrame(true); } catch (_) {}
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
    const modelLabel = res.model ? `${res.model} · ${res.engine || 'faster_whisper'}` : (res.engine || 'whisper');
    S.sourceName = file.name;
    setWords(words, `${words.length} words from ${file.name} (${modelLabel}). Times count from the start of the sequence.`);
    if (res.audio_url) {
      initAudio(res.audio_url, 0);
    }
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
  const allPresets = getAllPresets();
  const tiles = allPresets.map((p) => {
    const tileBody = `<button class="cc-tile${S.settings.preset === p.id ? ' cc-on' : ''}" data-preset="${p.id}" title="Apply the ${esc(p.name)} look">
      <canvas class="cc-tile-cv" data-tile="${p.id}"></canvas><span>${esc(p.name)}</span></button>`;
    if (p.isUser) {
      return `<div class="cc-tile-wrap">
        ${tileBody}
        <button class="cc-tile-del" data-act="del-preset" data-id="${p.id}" title="Delete preset">✕</button>
      </div>`;
    }
    return tileBody;
  }).join('');

  const lookExtra = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
      <span style="font-size:11px; font-weight:600; color:var(--cc-dim, #aaa);">PRESETS${S.settings.preset === 'custom' ? ' · customised' : ''}</span>
      <button class="cc-btn cc-small" data-act="save-user-preset" title="Save your current look as a reusable preset" style="padding:2px 8px; font-size:11px; height:24px;">+ Save Look</button>
    </div>`;

  return `
    ${section('Look', `${lookExtra}<div class="cc-tiles">${tiles}</div>`)}
    ${section('Font', `
      <div class="cc-ctl"><label class="cc-lbl">Family</label><select class="cc-select" data-bind="style.fontFamily" data-kind="text">${fontOptions()}</select></div>
      <p class="cc-warn${S.fontOk ? ' hidden' : ''}" id="cc-font-warn">This font isn't available to the panel — pick another, or install it in Windows and reopen the panel.</p>
      ${ctlSeg('style.fontWeight', 'Weight', ws.map((w) => [w, weightName(w)]))}
      ${ctlNum('style.fontSize', 'Size', 24, 220, 1, 'px')}
      ${ctlSeg('style.textCase', 'Case', [['as_is', 'As spoken'], ['upper', 'UPPER'], ['title', 'Title Case'], ['lower', 'lower']])}
      ${ctlSeg('style.punctuation', 'Punctuation', [
        ['no_dots', 'No dots', 'Keep commas & pauses, drop ending dots (.)'],
        ['keep', 'Keep all', 'Keep all punctuation as spoken'],
        ['soft', 'Clean', 'Hide commas and full stops, keep ? and !'],
        ['none', 'None', 'Strip all punctuation'],
        ['custom', 'Custom', 'Choose specifically which punctuation to keep'],
      ])}
      <div class="cc-punct-sub cc-sub-ctls${st.punctuation === 'custom' ? '' : ' hidden'}">
        ${ctlToggle('style.punctCommas', 'Keep commas & inner pauses', 'Preserves , ; : (and Urdu ، ؛)')}
        ${ctlToggle('style.punctDots', 'Keep sentence-ending dots', 'Preserves . … (and Urdu ۔)')}
        ${ctlToggle('style.punctExpressive', 'Keep ? and !', 'Preserves question marks and exclamations')}
      </div>`)}
    ${section('Colour', `<div class="cc-swatches">
      ${ctlColor('style.color', 'Text')}
      ${M.highlightMode(S.settings.motion) === 'color' ? ctlColor('style.activeColor', 'Active word') : ''}
      ${ctlColor('style.emphasisColor', 'Emphasis')}</div>
      ${ctlToggle('style.gradient', 'Gradient fill', '2-colour vertical gradient')}
      <div class="cc-gradient-sub cc-sub-ctls${st.gradient ? '' : ' hidden'}">
        <div class="cc-swatches">${ctlColor('style.gradientColor', 'Bottom colour')}</div>
      </div>
      ${ctlToggle('style.activeGlow', 'Active word glow', 'Subtle luminance bloom around the spoken word')}
      <div class="cc-glow-sub cc-sub-ctls${st.activeGlow ? '' : ' hidden'}">
        <div class="cc-swatches">${ctlColor('style.activeGlowColor', 'Glow colour')}</div>
        ${ctlNum('style.activeGlowBlur', 'Glow softness', 4, 40, 1, 'px')}
      </div>
      ${ctlToggle('style.speakerColoring', 'Multi-speaker coloring', 'Differentiate speakers with distinct colors')}
      <div class="cc-speaker-sub cc-sub-ctls${st.speakerColoring ? '' : ' hidden'}">
        <div class="cc-swatches">
          ${ctlColor('style.speakerColors.0', 'Speaker 1')}
          ${ctlColor('style.speakerColors.1', 'Speaker 2')}
        </div>
      </div>
      ${ctlSeg('style.emphasis', 'Emphasised words get', [['color', 'Colour'], ['pill', 'Pill'], ['both', 'Both']])}
      <div class="cc-emphasis-sub cc-sub-ctls${st.emphasis !== 'color' ? '' : ' hidden'}">
        <div class="cc-swatches">${ctlColor('style.pillColor', 'Pill')}</div>${ctlNum('style.pillOpacity', 'Pill opacity', 0, 100, 1, '%', 100)}
      </div>`)}
    ${section('Outline', `${ctlNum('style.strokeWidth', 'Thickness', 0, 20, 0.5, 'px')}
      <div class="cc-swatches">${ctlColor('style.strokeColor', 'Outline colour')}</div>`)}
    ${section('Shadow', `${ctlToggle('style.shadow', 'Drop shadow')}
      <div class="cc-shadow-sub cc-sub-ctls${st.shadow ? '' : ' hidden'}">
        <div class="cc-swatches">${ctlColor('style.shadowColor', 'Shadow colour')}</div>
        ${ctlNum('style.shadowOpacity', 'Opacity', 0, 100, 1, '%', 100)}
        ${ctlNum('style.shadowBlur', 'Softness', 0, 60, 1, 'px')}
        ${ctlNum('style.shadowDistance', 'Distance', 0, 40, 1, 'px')}
      </div>`)}
    ${section('Background', `${ctlSeg('style.background', 'Behind the text', [['none', 'None'], ['box', 'Box', 'A rounded box per line'], ['block', 'Block', 'One box for the whole caption'], ['pills', 'Pills', 'A pill behind every word']])}
      <div class="cc-bg-sub cc-sub-ctls${st.background !== 'none' ? '' : ' hidden'}">
        <div class="cc-swatches">${ctlColor('style.bgColor', 'Box colour')}</div>
        ${ctlNum('style.bgOpacity', 'Opacity', 0, 100, 1, '%', 100)}
        ${ctlNum('style.bgRadius', 'Roundness', 0, 100, 1, '%', 100)}
        <div style="display:flex;gap:6px">
          <div style="flex:1">${ctlNum('style.bgPad', 'Horizontal padding', 0, 60, 1, '%', 100)}</div>
          <div style="flex:1">${ctlNum('style.bgPadY', 'Vertical padding', 0, 60, 1, '%', 100)}</div>
        </div>
      </div>`)}
    ${section('Emojis', `
      ${ctlToggle('style.emojiEnabled', 'Dynamic Emojis', 'Display contextual emojis on spoken keywords')}
      <div class="cc-emoji-sub cc-sub-ctls${st.emojiEnabled ? '' : ' hidden'}">
        <div style="margin-top:6px">
          ${ctlSeg('style.emojiPlacement', 'Placement', [['above', 'Above word'], ['inline', 'Inline with text']])}
          ${ctlNum('style.emojiScale', 'Emoji size', 0.6, 2.0, 0.1, '×')}
        </div>
      </div>`)}
    ${section('Position', `
      ${ctlNum('layout.posY', 'Height on screen', 5, 95, 0.5, '%')}
      <div style="display:flex;align-items:center;gap:6px">
        <div style="flex:1">${ctlNum('layout.posX', 'Left / right', 5, 95, 0.5, '%')}</div>
        <button class="cc-btn cc-small" data-act="center-x" title="Reset horizontal position to exact center (50%)" style="flex:none;height:24px;margin-top:2px">Center 50%</button>
      </div>
      ${ctlNum('layout.rotation', 'Tilt angle', -15, 15, 0.5, '°')}
      ${ctlNum('layout.boxWidth', 'Caption width', 20, 100, 1, '%')}
      ${ctlNum('layout.lineHeight', 'Vertical box height / line spacing', 0.8, 2.5, 0.02, '×')}
      ${ctlSeg('grouping.maxWords', 'Words on screen', [
        [1, '1 word', '1 word at a time — maximum retention pop'],
        [3, '2-3 words', '2 to 3 words — Hormozi viral cadence'],
        [5, '4-5 words', '4 to 5 words — standard balanced caption'],
        [8, 'Full line', 'Full line — traditional subtitle pacing'],
      ], (optVal, curVal) => {
        const cv = Number(curVal) || 4;
        if (optVal === 1 && cv === 1) return true;
        if (optVal === 3 && (cv >= 2 && cv <= 3)) return true;
        if (optVal === 5 && (cv >= 4 && cv <= 6)) return true;
        if (optVal === 8 && cv >= 7) return true;
        return false;
      })}
      ${ctlSeg('grouping.maxLines', 'Lines', [[1, '1 line'], [2, '2 lines'], [3, '3 lines']])}
      ${ctlSeg('layout.align', 'Align', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']])}
      <p class="cc-hint">Tip: drag caption to move. Drag left/right handles for width, top/bottom handles for height.</p>`)}`;
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
    if (cv._painted && cv.width > 0) return;
    const p = findPreset(cv.dataset.tile);
    // every word on screen, the last one being spoken
    if (p) {
      ensureFont(p.style.fontFamily, p.style.fontWeight).then(() => {
        drawTileScene(cv, p.style, p.motion, 1.15);
        cv._painted = true;
      });
    }
  });
}

// Motion tiles: static preview by default, animate on hover for zero background CPU load.
let activeHoverTile = null;
let hoverTileRaf = 0;

function setupTileHover(cv) {
  const btn = cv.closest('button');
  if (!btn || btn._hasHoverAnim) return;
  btn._hasHoverAnim = true;

  btn.addEventListener('mouseenter', () => {
    activeHoverTile = cv;
    if (hoverTileRaf) cancelAnimationFrame(hoverTileRaf);
    const t0 = performance.now();
    const loop = (now) => {
      if (activeHoverTile !== cv || S.tab !== 'motion' || document.hidden) {
        hoverTileRaf = 0;
        return;
      }
      const t = ((now - t0) / 1000) % 2.2;
      paintTile(cv, Math.min(t, 1.9));
      hoverTileRaf = requestAnimationFrame(loop);
    };
    hoverTileRaf = requestAnimationFrame(loop);
  });

  btn.addEventListener('mouseleave', () => {
    if (activeHoverTile === cv) {
      activeHoverTile = null;
      if (hoverTileRaf) {
        cancelAnimationFrame(hoverTileRaf);
        hoverTileRaf = 0;
      }
      paintTile(cv, 0.68);
    }
  });
}

function animateMotionTiles() {
  $$('[data-mtile]').forEach((cv) => {
    setupTileHover(cv);
    paintTile(cv, 0.68);
  });
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
      <div class="cc-hl-box-sub cc-sub-ctls${m.highlight === 'box' ? '' : ' hidden'}">
        <div class="cc-swatches">${ctlColor('style.hlBoxColor', 'Box colour')}</div>
      </div>
      <div class="cc-hl-color-sub cc-sub-ctls${M.highlightMode(m) === 'color' ? '' : ' hidden'}">
        <div class="cc-swatches">${ctlColor('style.activeColor', 'Active colour')}</div>
      </div>
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
      <div class="cc-exit-fade-sub cc-sub-ctls${S.settings.timing.exit === 'fade' ? '' : ' hidden'}">
        ${ctlNum('timing.exitDuration', 'Crossfade length', 0.04, 0.4, 0.01, 's')}
      </div>`)}`;
}
function drawMotionTiles() {
  const st = Object.assign({}, S.settings.style);
  ensureFont(st.fontFamily, st.fontWeight).then(() => {
    $$('[data-mtile]').forEach((cv) => {
      const motion = Object.assign({}, S.settings.motion, { preset: cv.dataset.mtile });
      drawTileScene(cv, st, motion, 0.68);
      setupTileHover(cv);
    });
  });
}

/* ── timeline markers & social chapters ───────────────────────── */

async function sendTimelineMarkers() {
  if (!S.chapters || !S.chapters.length) {
    setStatus('No chapters to send to Premiere timeline.', 'info');
    return;
  }
  setBusy({ kind: 'markers', label: 'Placing markers on timeline…', progress: null });
  try {
    const payload = {
      chapters: S.chapters.map((c) => ({
        time: c.time,
        title: c.title,
        comment: 'EditFlow Chapter: ' + c.title,
      })),
      clearExisting: true,
      color: 4,
    };
    const res = await callExtendScript('setChapterMarkers', payload);
    if (res && res.success) {
      setStatus(`Placed ${res.created || S.chapters.length} chapter markers on Premiere sequence timeline!`, 'ok');
    } else {
      throw new Error((res && res.error) || 'Failed to place markers on timeline.');
    }
  } catch (e) {
    setStatus('Marker placement failed: ' + formatUserError(e), 'error');
  } finally {
    setBusy(null);
  }
}

async function importTimelineMarkers() {
  setBusy({ kind: 'markers', label: 'Reading timeline markers…', progress: null });
  try {
    const res = await callExtendScript('getSequenceMarkers');
    if (res && res.markers && res.markers.length) {
      S.chapters = res.markers.map((m) => ({
        time: Math.round(Number(m.time || 0) * 10) / 10,
        title: m.name || m.comment || 'Chapter',
      }));
      if (!S.chapters.some((c) => Math.abs(c.time) < 0.5)) {
        S.chapters.unshift({ time: 0, title: 'Introduction' });
      }
      S.chapters.sort((a, b) => a.time - b.time);
      saveChapters();
      renderBody();
      setStatus(`Imported ${S.chapters.length} markers from sequence timeline.`, 'ok');
    } else {
      setStatus('No markers found on active sequence timeline.', 'info');
    }
  } catch (e) {
    setStatus('Could not read sequence markers: ' + formatUserError(e), 'error');
  } finally {
    setBusy(null);
  }
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
      ${S.srtPath ? `<p class="cc-dim cc-path">${esc(S.srtPath)}</p>` : ''}`)}
    ${section('Timeline Markers & Chapters', `
      <p class="cc-hint">Generate YouTube chapter timestamps and native Premiere sequence markers from speech.</p>
      <div class="cc-row" style="margin-bottom:8px;gap:6px;flex-wrap:wrap">
        <button class="cc-btn cc-small" data-act="detect-chapters" ${S.words && S.words.length ? '' : 'disabled'} title="Auto-detect chapter topics from transcript">Auto-Detect</button>
        <button class="cc-btn cc-small" data-act="add-chapter" title="Add a new chapter manually">+ Chapter</button>
        <button class="cc-btn cc-small" data-act="import-markers" ${inCEP() ? '' : 'disabled'} title="Import markers from Premiere Pro sequence timeline">Import Markers</button>
        ${S.chapters && S.chapters.length ? `<button class="cc-btn cc-small cc-danger" data-act="clear-chapters" title="Clear all chapters">Clear</button>` : ''}
      </div>

      ${(() => {
        if (!S.chapters || !S.chapters.length) {
          return `<div class="cc-empty-chapters"><p class="cc-dim">No chapters defined. Click <b>Auto-Detect</b> or <b>+ Chapter</b> to create timeline markers.</p></div>`;
        }
        const val = validateYouTubeChapters(S.chapters);
        const valBadge = val.valid
          ? `<span class="cc-badge cc-badge-ok" title="Meets YouTube requirements: starts at 00:00, >= 3 chapters, >= 10s gap">YouTube Compliant</span>`
          : `<span class="cc-badge cc-badge-warn" title="${esc(val.errors.join(' '))}">Adjustment Needed</span>`;

        return `
          <div style="display:flex;align-items:center;justify-content:space-between;margin:8px 0 6px">
            <span class="cc-dim" style="font-size:11px">${S.chapters.length} Chapter${S.chapters.length === 1 ? '' : 's'}</span>
            ${valBadge}
          </div>
          <div class="cc-chapter-list">
            ${S.chapters.map((ch, idx) => `
              <div class="cc-chapter-row" data-idx="${idx}">
                <button class="cc-chapter-time-btn" data-act="seek-chapter" data-t="${ch.time}" title="Seek playhead to ${fmtTimestamp(ch.time)}">${fmtTimestamp(ch.time)}</button>
                <input type="text" class="cc-chapter-input" data-chapter-field="title" data-idx="${idx}" value="${esc(ch.title)}" placeholder="Chapter title…">
                <button class="cc-chapter-del" data-act="del-chapter" data-idx="${idx}" title="Remove chapter">✕</button>
              </div>
            `).join('')}
          </div>
          <div class="cc-row2" style="margin-top:10px">
            <button class="cc-btn cc-primary" data-act="copy-chapters" title="Copy chapters in YouTube / Spotify description format">Copy Chapters</button>
            <button class="cc-btn" data-act="send-markers" ${inCEP() ? '' : 'disabled'} title="Create native chapter markers on Premiere sequence timeline">Send to Sequence</button>
          </div>
        `;
      })()}
    `)}`;
}

/* ── export ───────────────────────────────────────────────────── */

async function exportCaptions() {
  if (S.busy || !S.scene || !S.scene.captions.length) return;
  setPlaying(false);
  if (inCEP()) await refreshSequence(false);
  const ctrl = new AbortController();
  const scene = S.scene;
  const eff = effSettings();
  // Determine tStart and duration based on In/Out scope or sequence timeline
  let tStart = 0;
  if (S.scope === 'inout' && S.seq && S.seq.hasInOut) {
    tStart = Math.max(0, Number(S.seq.inPoint) || 0);
  } else if (S.audioRangeIn > 0) {
    tStart = S.audioRangeIn;
  }
  let duration = scene.duration - tStart;
  if (S.scope === 'inout' && S.seq && S.seq.hasInOut && S.seq.outPoint > tStart) {
    duration = Math.max(0.1, S.seq.outPoint - tStart);
  } else {
    duration = Math.max(0.1, duration);
  }

  setBusy({ kind: 'render', label: 'Preparing…', progress: 0, cancel: () => ctrl.abort() });
  try {
    await ensureFont(eff.style.fontFamily, eff.style.fontWeight);
    const res = await renderOverlay(scene, eff, {
      baseUrl: getBaseUrl(), name: S.seq.name, codec: S.settings.output.codec, signal: ctrl.signal,
      tStart: tStart, duration: duration,
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
      const placed = await callCM('placeOverlay', { path: res.path, start: tStart, duration: res.seconds });
      if (!placed || !placed.success) {
        throw new Error((placed && placed.error) || 'Failed to place caption overlay on timeline.');
      }
      res.placed = placed;
      setStatus(`Captions are on ${placed.trackName} at ${fmtTime(tStart)} (${fmtTime(res.seconds)}).` +
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
  const colorProps = [
    'color', 'activeColor', 'emphasisColor', 'pillColor',
    'strokeColor', 'shadowColor', 'bgColor', 'hlBoxColor',
    'gradientColor', 'activeGlowColor'
  ];
  for (const k of colorProps) {
    if (S.settings.style[k] != null) S.settings.style[k] = normalizeHex(S.settings.style[k], STYLE_DEFAULTS[k] || '#ffffff');
  }
  if (Array.isArray(S.settings.style.speakerColors)) {
    S.settings.style.speakerColors = S.settings.style.speakerColors.map((c, i) =>
      normalizeHex(c, (STYLE_DEFAULTS.speakerColors && STYLE_DEFAULTS.speakerColors[i]) || '#ffffff')
    );
  }
  S.settings.motion = Object.assign({}, M.MOTION_DEFAULTS, p.motion);
  if (p.grouping) S.settings.grouping = Object.assign({}, S.settings.grouping, p.grouping);
  if (p.layout) S.settings.layout = Object.assign({}, S.settings.layout, p.layout);
  S.settings.preset = id;
  saveSettingsSoon();
  renderBody();
  rebuildScene();
}

/* ── events ───────────────────────────────────────────────────── */

const RELAYOUT = /^(style\.(fontFamily|fontWeight|fontSize|textCase|punctuation|punctCommas|punctDots|punctExpressive|emojiEnabled|emojiPlacement|emojiScale)|layout\.|grouping\.|timing\.)/;
// Settings that show or hide major tabs or require full structural rebuild.
// Note: Inline sub-controls (gradient, shadow, emoji, glow, etc.) are toggled in place
// without destroying the active DOM or re-rendering all preset tiles.
const STRUCTURAL = {
  previewAspect: 1
};

// Picking a colour for something that's switched off switches it on —
// otherwise the swatch looks broken (nothing changes).
const ENABLE_ON_COLOR = {
  'style.strokeColor': () => { if (!(S.settings.style.strokeWidth > 0)) return ['style.strokeWidth', 4]; return null; },
};

function updateSubControls(path) {
  if (!S.settings) return;
  const all = !path;
  const st = S.settings.style || {};
  const m = S.settings.motion || {};
  const tm = S.settings.timing || {};

  if (all || path === 'style.gradient') {
    const box = $('.cc-gradient-sub');
    if (box) box.classList.toggle('hidden', !st.gradient);
  }
  if (all || path === 'style.activeGlow') {
    const box = $('.cc-glow-sub');
    if (box) box.classList.toggle('hidden', !st.activeGlow);
  }
  if (all || path === 'style.speakerColoring') {
    const box = $('.cc-speaker-sub');
    if (box) box.classList.toggle('hidden', !st.speakerColoring);
  }
  if (all || path === 'style.shadow') {
    const box = $('.cc-shadow-sub');
    if (box) box.classList.toggle('hidden', !st.shadow);
  }
  if (all || path === 'style.emojiEnabled') {
    const box = $('.cc-emoji-sub');
    if (box) box.classList.toggle('hidden', !st.emojiEnabled);
  }
  if (all || path === 'style.background') {
    const box = $('.cc-bg-sub');
    if (box) box.classList.toggle('hidden', st.background === 'none');
  }
  if (all || path === 'style.emphasis') {
    const box = $('.cc-emphasis-sub');
    if (box) box.classList.toggle('hidden', st.emphasis === 'color');
  }
  if (all || path === 'style.punctuation') {
    const box = $('.cc-punct-sub');
    if (box) box.classList.toggle('hidden', st.punctuation !== 'custom');
  }
  if (all || path === 'motion.highlight') {
    const boxBox = $('.cc-hl-box-sub');
    if (boxBox) boxBox.classList.toggle('hidden', m.highlight !== 'box');
    const boxColor = $('.cc-hl-color-sub');
    if (boxColor) boxColor.classList.toggle('hidden', M.highlightMode(m) !== 'color');
  }
  if (all || path === 'timing.exit') {
    const box = $('.cc-exit-fade-sub');
    if (box) box.classList.toggle('hidden', tm.exit !== 'fade');
  }
}

function onSetting(path) {
  if (ENABLE_ON_COLOR[path]) {
    const fix = ENABLE_ON_COLOR[path]();
    if (fix) {
      setPath(S.settings, fix[0], fix[1]);
      $$(`[data-bind="${fix[0]}"]`).forEach((o) => { o.value = fmtNum(fix[1]); });
    }
  }
  if (/^(style|motion)\./.test(path) && path !== 'style.fontSize') {
    S.settings.preset = 'custom';
    $$('.cc-tile').forEach((btn) => btn.classList.remove('cc-on'));
  }
  if (path === 'layout.align' && S.settings.layout.align === 'center') {
    S.settings.layout.posX = 50;
    $$('[data-bind="layout.posX"]').forEach((o) => { o.value = 50; });
  }
  if (path === 'style.fontFamily') {
    const ws = weightsFor(S.settings.style.fontFamily);
    if (ws.indexOf(Number(S.settings.style.fontWeight)) === -1) {
      S.settings.style.fontWeight = ws.reduce((a, b) => (Math.abs(b - 800) < Math.abs(a - 800) ? b : a), ws[0]);
    }
    renderBody();
  }
  if (path === 'previewAspect') refreshSequence(false);

  // Update inline sub-control visibility in place (no DOM replacement)
  updateSubControls(path);

  if (RELAYOUT.test(path)) scheduleScene(); else requestDraw();

  if (STRUCTURAL[path]) {
    renderBody();
  } else if (path.indexOf('motion.') === 0 && S.tab === 'motion') {
    drawMotionTiles();
  }
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

function syncColorControls(path, norm, excludeEl) {
  $$(`input[type="color"][data-bind="${path}"]`).forEach((swatch) => {
    if (swatch !== excludeEl) swatch.value = norm;
  });
  $$(`.cc-hex-input[data-bind="${path}"], input[data-kind="hex"][data-bind="${path}"], input[data-kind="color-hex"][data-bind="${path}"]`).forEach((txt) => {
    if (txt !== excludeEl) txt.value = norm;
  });
}

function onBoundInput(el) {
  const kind = el.dataset.kind;
  const path = el.dataset.bind;
  if (!path) return;

  if (kind === 'hex' || kind === 'color-hex') {
    const raw = el.value.trim();
    const norm = normalizeHex(raw, null);
    if (!norm) return;
    syncColorControls(path, norm, el);
    if (getPath(S.settings, path) === norm) return;
    setPath(S.settings, path, norm);
    onSetting(path);
    return;
  }

  if (kind === 'color') {
    const norm = normalizeHex(el.value, '#ffffff');
    syncColorControls(path, norm, el);
    if (getPath(S.settings, path) === norm) return;
    setPath(S.settings, path, norm);
    onSetting(path);
    return;
  }

  const v = readControl(el);
  if (v === undefined) return;
  if (getPath(S.settings, path) === v) return;
  setPath(S.settings, path, v);
  $$(`[data-bind="${path}"]`).forEach((o) => {           // keep slider + number box in step
    if (o === el || o.dataset.kind !== 'num') return;
    o.value = fmtNum(el.dataset.scale ? v * parseFloat(el.dataset.scale) : v);
  });
  onSetting(path);
}

function commitHexInput(el) {
  if (!el || !el.dataset) return;
  const kind = el.dataset.kind;
  if (kind !== 'hex' && kind !== 'color-hex' && !el.classList?.contains('cc-hex-input')) return;
  const path = el.dataset.bind;
  if (!path) return;
  const norm = normalizeHex(el.value, null);
  if (norm) {
    el.value = norm;
    syncColorControls(path, norm, el);
    const changed = getPath(S.settings, path) !== norm;
    setPath(S.settings, path, norm);
    if (changed) {
      onSetting(path);
    } else {
      saveSettingsSoon();
    }
  } else {
    const current = normalizeHex(getPath(S.settings, path), '#ffffff');
    el.value = current;
    syncColorControls(path, current, el);
  }
}

function commitPendingHexInputs() {
  $$('#cc-body .cc-hex-input, #cc-body input[data-kind="hex"], #cc-body input[data-kind="color-hex"]').forEach(commitHexInput);
}

function bindEvents() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      setPlaying(false);
      if (S.audio) {
        try { S.audio.pause(); } catch (_) {}
      }
      if (hoverTileRaf) {
        cancelAnimationFrame(hoverTileRaf);
        hoverTileRaf = 0;
      }
    }
  });
  window.addEventListener('blur', () => {
    // When the panel loses focus (user clicked timeline, source monitor, etc.)
    setPlaying(false);
    commitPendingHexInputs();
  });
  window.addEventListener('pagehide', () => {
    setPlaying(false);
    commitPendingHexInputs();
  });
  root.addEventListener('blur', (e) => {
    const el = e.target;
    if (el && el.dataset && (el.dataset.kind === 'hex' || el.dataset.kind === 'color-hex' || (el.classList && el.classList.contains('cc-hex-input')))) {
      commitHexInput(el);
    }
  }, true);
  root.addEventListener('paste', (e) => {
    const el = e.target;
    if (el && el.dataset && (el.dataset.kind === 'hex' || el.dataset.kind === 'color-hex' || (el.classList && el.classList.contains('cc-hex-input')))) {
      const text = (e.clipboardData || window.clipboardData)?.getData('text');
      if (text) {
        const norm = normalizeHex(text, null);
        if (norm) {
          e.preventDefault();
          el.value = norm;
          const path = el.dataset.bind;
          if (path) {
            syncColorControls(path, norm, el);
            setPath(S.settings, path, norm);
            onSetting(path);
          }
        }
      }
    }
  });
  root.addEventListener('input', (e) => {
    const el = e.target;
    if (el.id === 'cc-scrub') { setPlaying(false); seek(parseFloat(el.value) || 0); return; }
    if (el.dataset && el.dataset.chapterField === 'title') {
      const idx = Number(el.dataset.idx);
      if (S.chapters && S.chapters[idx]) {
        S.chapters[idx].title = el.value;
        saveChapters();
      }
      return;
    }
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
    commitPendingHexInputs();
    const t = e.target;
    const tab = t.closest('[data-tab]');
    if (tab) {
      commitPendingHexInputs();
      S.tab = tab.dataset.tab;
      S.editing = -1;
      if (S.tab === 'transcript' && inCEP()) {
        refreshSequence(false).then(() => renderBody()).catch(() => renderBody());
        return;
      }
      renderBody();
      return;
    }
    const seg = t.closest('.cc-seg button');
    if (seg) {
      const box = seg.parentElement;
      const path = box.dataset.bind;
      if (path) {
        const v = /^-?\d+(\.\d+)?$/.test(seg.dataset.value) ? Number(seg.dataset.value) : seg.dataset.value;
        setPath(S.settings, path, v);
        $$('button', box).forEach((b) => b.classList.toggle('cc-on', b === seg));
        onSetting(path);
        return;
      }
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
    if (act && !act.disabled) onAction(act.dataset.act, act);
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
    if (el && el.dataset && (el.dataset.kind === 'hex' || el.dataset.kind === 'color-hex' || (el.classList && el.classList.contains('cc-hex-input')))) {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitHexInput(el);
        el.blur();
        return;
      } else if (e.key === 'Escape') {
        e.preventDefault();
        const current = normalizeHex(getPath(S.settings, el.dataset.bind), '#ffffff');
        el.value = current;
        syncColorControls(el.dataset.bind, current, el);
        el.blur();
        return;
      }
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
    else if (k === 's') wordAction('speaker');
    else if (k === 'delete' || k === 'backspace') {
      const w = S.words[S.sel];
      if (w) executeTimelineRippleCut([{ start: w.start, end: w.end, label: w.text }], `Cut "${w.text}"`);
    }
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
    const el = e.target;
    if (el && el.dataset && (el.dataset.kind === 'hex' || el.dataset.kind === 'color-hex' || (el.classList && el.classList.contains('cc-hex-input')))) {
      commitHexInput(el);
    }
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
  const halfY = hh;

  if (Math.abs(p.x - lay.posX) <= half + hitTolX) {
    if (Math.abs(p.y - (lay.posY - halfY)) < hitTolY) return 'top';
    if (Math.abs(p.y - (lay.posY + halfY)) < hitTolY) return 'bottom';
  }
  if (Math.abs(p.y - lay.posY) <= halfY + hitTolY) {
    if (Math.abs(p.x - (lay.posX - half)) < hitTolX) return 'left';
    if (Math.abs(p.x - (lay.posX + half)) < hitTolX) return 'right';
  }
  if (Math.abs(p.x - lay.posX) < half && Math.abs(p.y - lay.posY) < halfY) return 'move';
  return null;
}
function onCanvasHover(e) {
  const hit = boxHit(canvasPoint(e));
  const cv = $('#cc-canvas');
  if (cv) {
    if (hit === 'move') cv.style.cursor = 'move';
    else if (hit === 'left' || hit === 'right') cv.style.cursor = 'ew-resize';
    else if (hit === 'top' || hit === 'bottom') cv.style.cursor = 'ns-resize';
    else cv.style.cursor = '';
  }
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
  S.drag = { mode: hit, x: p.x, y: p.y, posX: lay.posX, posY: lay.posY, box: lay.boxWidth, lineHeight: lay.lineHeight || 1.12, pointerId: e.pointerId };
  const move = (ev) => {
    if (!S.drag) return;
    const q = canvasPoint(ev);
    if (S.drag.mode === 'move') {
      let nx = S.drag.posX + (q.x - S.drag.x);
      let ny = S.drag.posY + (q.y - S.drag.y);
      if (Math.abs(nx - 50) < 2.5) nx = 50;
      if (Math.abs(ny - 72) < 2.0) ny = 72;
      else if (Math.abs(ny - 50) < 2.0) ny = 50;
      else if (Math.abs(ny - 20) < 2.0) ny = 20;
      lay.posX = clamp(Math.round(nx * 2) / 2, 5, 95);
      lay.posY = clamp(Math.round(ny * 2) / 2, 5, 95);
    } else if (S.drag.mode === 'left' || S.drag.mode === 'right') {
      const distFromCenter = Math.abs(q.x - S.drag.posX);
      lay.boxWidth = clamp(Math.round(distFromCenter * 2), 20, 100);
      lay.posX = S.drag.posX;
      lay.posY = S.drag.posY;
    } else if (S.drag.mode === 'top' || S.drag.mode === 'bottom') {
      const distYFromCenter = Math.abs(q.y - S.drag.posY);
      const fsPct = (S.settings.style.fontSize * scaleK()) / S.seq.height * 100;
      const maxLines = Math.max(1, S.settings.grouping.maxLines || 1);
      const targetLH = (distYFromCenter * 2) / Math.max(0.1, fsPct * maxLines);
      lay.lineHeight = clamp(Math.round(targetLH * 100) / 100, 0.8, 2.5);
      if (S.settings.style.background !== 'none') {
        const extraPad = Math.max(0, (distYFromCenter - (fsPct * maxLines * 1.12) / 2) / Math.max(0.1, fsPct));
        S.settings.style.bgPadY = clamp(Math.round(extraPad * 100) / 100, 0, 1.0);
        $$('[data-bind="style.bgPadY"]').forEach((el) => { el.value = Math.round(S.settings.style.bgPadY * 100); });
      }
      lay.posX = S.drag.posX;
      lay.posY = S.drag.posY;
    }
    $$('[data-bind="layout.posX"]').forEach((el) => { el.value = lay.posX; });
    $$('[data-bind="layout.posY"]').forEach((el) => { el.value = lay.posY; });
    $$('[data-bind="layout.boxWidth"]').forEach((el) => { el.value = lay.boxWidth; });
    $$('[data-bind="layout.lineHeight"]').forEach((el) => { el.value = lay.lineHeight; });
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

function onAction(act, el) {
  switch (act) {
    case 'close': closeCaptions(); break;
    case 'set-scope': {
      const scope = (el && el.dataset.scope) || 'inout';
      S.transcribeScope = scope;
      S.useInOut = (scope === 'inout');
      renderBody();
      break;
    }
    case 'refresh-seq':
      refreshSequence(false).then(() => {
        renderBody();
        setStatus(inCEP() ? 'Timeline markers refreshed.' : 'Preview mode — not connected to Premiere.', 'ok');
      }).catch((e) => {
        setStatus('Could not read sequence: ' + formatUserError(e), 'error');
      });
      break;
    case 'center-x':
      S.settings.layout.posX = 50;
      $$('[data-bind="layout.posX"]').forEach((el) => { el.value = 50; });
      onSetting('layout.posX');
      setStatus('Caption centered horizontally (50%).', 'ok');
      break;
    case 'play': setPlaying(!S.playing); break;
    case 'toggle-audio':
      S.audioMuted = !S.audioMuted;
      if (S.audio) S.audio.muted = S.audioMuted;
      updateAudioBtn();
      break;
    case 'bg':
      if (S.bg === 'checker') {
        S.bg = 'dark';
      } else if (S.bg === 'dark') {
        S.bg = 'frame';
        if (!S.bgImage) captureSequenceFrame(true);
      } else {
        S.bg = 'checker';
      }
      requestDraw();
      break;
    case 'capture-frame': captureSequenceFrame(true); break;
    case 'zoom-in': changeZoom(1); break;
    case 'zoom-out': changeZoom(-1); break;
    case 'toggle-preview':
      S.previewOpen = !S.previewOpen;
      if (!S.previewOpen) setPlaying(false);
      layoutPreview();
      break;
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
    case 'w-speaker': wordAction('speaker'); break;
    case 'w-break': wordAction('break'); break;
    case 'w-earlier': wordAction('earlier'); break;
    case 'w-later': wordAction('later'); break;
    case 'w-edit': S.editing = S.sel; renderTranscriptList(); break;
    case 'w-apply-emoji': {
      const idx = Number(el.dataset.i);
      const emoji = el.dataset.emoji;
      if (S.words[idx] && emoji) {
        snapshot();
        S.words[idx].emoji = emoji;
        wordsChanged();
        setStatus(`Attached ${emoji} to "${S.words[idx].text}"`, 'ok');
      }
      break;
    }
    case 'w-remove-emoji': {
      const idx = Number(el.dataset.i);
      if (S.words[idx]) {
        snapshot();
        delete S.words[idx].emoji;
        wordsChanged();
        setStatus('Removed emoji.', 'info');
      }
      break;
    }
    case 'apply-all-emojis': {
      const suggestions = findAllSuggestions(S.words);
      if (!suggestions.length) { setStatus('No emoji suggestions found.', 'info'); break; }
      snapshot();
      suggestions.forEach((s) => {
        if (S.words[s.index]) S.words[s.index].emoji = s.emoji;
      });
      wordsChanged();
      setStatus(`Applied ${suggestions.length} emojis to keywords!`, 'ok');
      break;
    }
    case 'w-custom-emoji': {
      const w = S.words[S.sel];
      if (!w) break;
      const val = prompt('Enter an emoji for this word (e.g. 🔥, 💰, 🚀, or leave empty to clear):', w.emoji || '');
      if (val !== null) {
        snapshot();
        if (val.trim()) w.emoji = val.trim();
        else delete w.emoji;
        wordsChanged();
      }
      break;
    }
    case 'save-user-preset': {
      const name = (prompt('Enter a name for this custom preset:', 'My Look') || '').trim();
      if (!name) break;
      const created = saveUserPreset({
        name,
        style: S.settings.style,
        motion: S.settings.motion,
        grouping: S.settings.grouping,
        layout: S.settings.layout,
      });
      if (created) {
        S.settings.preset = created.id;
        renderBody();
        setStatus(`Saved preset "${name}"!`, 'ok');
      }
      break;
    }
    case 'del-preset': {
      const id = el && el.dataset.id;
      if (id && confirm('Delete this custom preset?')) {
        deleteUserPreset(id);
        if (S.settings.preset === id) S.settings.preset = 'clean';
        renderBody();
        setStatus('Preset deleted.', 'info');
      }
      break;
    }
    case 'w-cut': {
      const w = S.words[S.sel];
      if (w) executeTimelineRippleCut([{ start: w.start, end: w.end, label: w.text }], `Cut "${w.text}"`);
      break;
    }
    case 'clean-fillers': {
      const fillers = M.findFillerRanges(S.words);
      if (!fillers.length) { setStatus('No filler words detected.', 'info'); break; }
      const ranges = fillers.map((f) => ({ start: f.start, end: f.end, label: f.text }));
      executeTimelineRippleCut(ranges, `Removed ${ranges.length} filler words`);
      break;
    }
    case 'trim-silence': {
      const silences = M.findSilenceRanges(S.words, 0.6, 0.2);
      if (!silences.length) { setStatus('No long pauses detected to tighten.', 'info'); break; }
      const ranges = silences.map((s) => ({ start: s.start, end: s.end, label: s.label }));
      const saved = silences.reduce((acc, s) => acc + s.saved, 0);
      executeTimelineRippleCut(ranges, `Tightened ${ranges.length} pauses (${fmtTime(saved)} saved)`);
      break;
    }
    case 'detect-chapters': {
      if (!S.words || !S.words.length) {
        setStatus('No transcript words available to detect chapters.', 'info');
        break;
      }
      S.chapters = autoDetectChapters(S.words);
      saveChapters();
      renderBody();
      setStatus(`Auto-detected ${S.chapters.length} chapters from transcript.`, 'ok');
      break;
    }
    case 'add-chapter': {
      const t = Math.round((S.t || 0) * 10) / 10;
      if (!S.chapters) S.chapters = [];
      const title = 'Chapter ' + (S.chapters.length + 1);
      S.chapters.push({ time: t, title });
      S.chapters.sort((a, b) => a.time - b.time);
      saveChapters();
      renderBody();
      setStatus(`Added chapter at ${fmtTimestamp(t)}.`, 'ok');
      break;
    }
    case 'del-chapter': {
      const idx = el && Number(el.dataset.idx);
      if (S.chapters && idx != null && S.chapters[idx]) {
        S.chapters.splice(idx, 1);
        saveChapters();
        renderBody();
      }
      break;
    }
    case 'clear-chapters': {
      S.chapters = [];
      saveChapters();
      renderBody();
      setStatus('Cleared all chapters.', 'info');
      break;
    }
    case 'seek-chapter': {
      const t = el && parseFloat(el.dataset.t);
      if (t != null && !isNaN(t)) {
        setPlaying(false);
        seek(t + 0.001);
      }
      break;
    }
    case 'copy-chapters': {
      if (!S.chapters || !S.chapters.length) {
        setStatus('No chapters to copy.', 'info');
        break;
      }
      const text = formatSocialChapters(S.chapters, 'youtube');
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text);
        } else {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        setStatus(`Copied ${S.chapters.length} YouTube chapters to clipboard!`, 'ok');
      } catch (e) {
        setStatus('Could not copy to clipboard: ' + formatUserError(e), 'error');
      }
      break;
    }
    case 'send-markers': sendTimelineMarkers(); break;
    case 'import-markers': importTimelineMarkers(); break;
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
