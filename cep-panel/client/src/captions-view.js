/**
 * captions-view.js — Tier-1 native caption UI for Premiere Pro.
 *
 * AE-style tabbed flow, Premiere Tier-1 mechanics:
 *   1. Transcribe: upload audio/video → POST /api/captions/transcribe-mixdown
 *      → word-level timestamps (WhisperX forced alignment when available).
 *   2. Content: word chips, click to exclude (excluded words are skipped in
 *      final_cut mode via remap_kept_words_to_output).
 *   3. Style: preset picker (GET /api/captions/presets) + grouping controls.
 *   4. Generate: build cues → cue list → Export SRT + import as a native
 *      caption track (project.importFiles + sequence.createCaptionTrack).
 *
 * Additive & self-contained like review-view.js: opening hides the chat
 * shell, closing restores it. No canvas animation preview — the caption
 * track itself renders in Premiere's Text panel (Tier-1 is native).
 */
import { apiGet, apiPost, apiUpload, getBaseUrl } from './api.js';
import { isExtendScriptAvailable, importCaptionsFromSRT, callExtendScript } from './extendscript.js';

const $ = (sel) => document.querySelector(sel);

const S = {
  words: [], cues: [], presets: [],
  preset: 'none', allCaps: false, sourceMode: 'standalone',
  tapMode: 'keep', // 'keep' | 'pill' — what clicking a word toggles
  showBox: true, // caption-box overlay on the preview canvas
  opts: { max_words_per_cue: 4, max_chars_per_line: 30, max_lines: 2, max_cue_duration: 3.0, max_gap: 0.8 },
  fontSize: 80, posY: 80, posX: 50, boxW: 90,
  fontFamily: 'Arial', fontBold: true, fontCustom: '',
  textColor: '#ffffff', strokeColor: '#000000', strokeWidth: 0,  shadowOn: true, shadowColor: '#000000', shadowOpacity: 50, shadowDistance: 3, shadowBlur: 5,
  pillColor: '#0a1a2e', pillOpacity: 85, pillOutline: true,
  pillStrokeColor: '#5c8cf0', pillStrokeWidth: 2, pillRadius: 50,
  animPreset: 'fadeup_words', animIntensity: 1.0, wordEasing: 'expo_out',
  fadeDur: 0.28, slideDist: 60,
  seqW: 1080, seqH: 1920, seqFps: 30,
  srtPath: '', busy: false, status: '', fileName: 'captions',
  previewFrames: [], previewMp4: '',
  bgMode: 'dark', bgUrl: '',
  prevView: null,
};

// Preview background image cache (video frame from transcription).
const PVBG = { img: null, src: '' };

// Live preview viewport (AE canvas parity): auto-playing loop over the
// built cues. Defined once at module scope — every preview function
// below depends on it.
const PV = { t: 0, playing: true, raf: 0, last: 0, W: 360, H: 640 };
const ANIM_PRESETS = [
  ['fadeup_words', 'Fade Up Words'], ['popin', 'Pop-in (Hormozi)'],
  ['fadeup', 'Fade Up'], ['bounce', 'Bounce'],
  ['squash', 'Squash & Stretch'], ['typewriter', 'Typewriter'],
  ['fade', 'Simple Fade'],
];
const EASING_OPTS = [
  ['expo_out', 'Expo Out (snappy)'], ['back_out', 'Back Out (overshoot)'],
  ['ease_out', 'Ease Out'], ['ease_in_out', 'Ease In-Out'],
  ['ease_in', 'Ease In'], ['linear', 'Linear'],
];
const EASE_FN = {
  linear: (p) => p,
  ease_in: (p) => p * p * p,
  ease_out: (p) => 1 - Math.pow(1 - p, 3),
  ease_in_out: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  expo_out: (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
  back_out: (p) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); },
};
// Animate preset → canvas motion (backend ANIM_MOTION parity).
function _pvAnim() {
  switch (S.animPreset) {
    case 'popin': case 'squash': return { motion: 'back', captionLevel: false };
    case 'fadeup': return { motion: 'rise', captionLevel: true };
    case 'bounce': return { motion: 'bounce', captionLevel: false };
    case 'typewriter': return { motion: 'cut', captionLevel: false };
    case 'fade': return { motion: 'fade', captionLevel: true };
    default: return { motion: 'rise', captionLevel: false };
  }
}

const LANGUAGES = [
  ['auto', 'Auto Detect'], ['en', 'English'], ['ur', 'Urdu'], ['hi', 'Hindi'],
  ['ar', 'Arabic'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'],
];

// ── Public ───────────────────────────────────────────────────
function openCaptions() {
  _ensureStyles();
  const view = _ensureContainer();
  const hero = $('#hero'), chat = $('#chat-scroll'), footer = $('#app-footer');
  S.prevView = { hero: hero?.classList.contains('hidden') ?? true,
                 chat: chat?.classList.contains('hidden') ?? true,
                 footer: footer?.classList.contains('hidden') ?? true };
  hero?.classList.add('hidden'); chat?.classList.add('hidden'); footer?.classList.add('hidden');
  view.classList.remove('hidden');
  _render();
  // Sequence-aware preview (AE parity: canvas follows the open sequence).
  // Fire-and-forget: canvas + overlay dims update when it lands.
  _fetchSequenceSize();
}
async function _fetchSequenceSize() {
  try {
    const st = await callExtendScript('getSequenceState');
    const W = Math.round(st.width || 0), H = Math.round(st.height || 0);
    if (W > 100 && H > 100 && (W !== S.seqW || H !== S.seqH)) {
      S.seqW = W; S.seqH = H;
      if (st.fps > 0) S.seqFps = Math.round(st.fps);
      if (W >= H) { PV.W = 640; PV.H = Math.max(180, Math.round(640 * H / W)); }
      else { PV.H = 640; PV.W = Math.max(180, Math.round(640 * W / H)); }
      const open = !document.getElementById('captions-view')?.classList.contains('hidden');
      if (open) _render();
    }
  } catch (_) { /* sequence closed — keep defaults */ }
}
function closeCaptions() {
  $('#captions-view')?.classList.add('hidden');
  _pvStop();
  try { localStorage.setItem('editflow_home_view', 'chat'); } catch (_) {}
  const hero = $('#hero'), chat = $('#chat-scroll'), footer = $('#app-footer');
  if (S.prevView) {
    hero?.classList.toggle('hidden', S.prevView.hero);
    chat?.classList.toggle('hidden', S.prevView.chat);
    footer?.classList.toggle('hidden', S.prevView.footer);
  }
}

// ── Styles + container ───────────────────────────────────────
function _ensureStyles() {
  if (document.getElementById('cc-style-link')) return;
  const link = document.createElement('link');
  link.id = 'cc-style-link'; link.rel = 'stylesheet';
  link.href = 'styles/captions.css?v=' + Date.now();
  document.head.appendChild(link);
}
function _ensureContainer() {
  let v = $('#captions-view');
  if (!v) { v = document.createElement('div'); v.id = 'captions-view'; v.className = 'cc-view hidden'; ($('#app-main') || document.body).appendChild(v); }
  return v;
}

// ── Render ───────────────────────────────────────────────────
const TABS = ['Transcribe', 'Content', 'Style', 'Animate', 'Generate'];
let _tab = 0;

function _render() {
  const v = _ensureContainer();
  try {
    _renderInner(v);
  } catch (e) {
    // Never a blank panel: show the error in place so boot always lands
    // somewhere visible (chat fallback happens in main.js).
    console.error('[EditFlow] captions render failed:', e);
    v.innerHTML = `<div class="cc-bar"><div class="cc-title">Captions</div><button class="cc-btn cc-ghost" data-act="close">Close</button></div>`
      + `<div class="cc-body"><p class="cc-hint">Captions view failed to render: ${_esc((e && e.message) || e)}. Close and use chat, or reload the panel.</p></div>`;
    const c = v.querySelector('[data-act="close"]');
    if (c) c.onclick = closeCaptions;
  }
  _pvStart();
}
function _renderInner(v) {
  v.innerHTML = `
    <div class="cc-bar"><div class="cc-title">Captions <span class="cc-live" id="cc-live" title="Preview loop alive">●</span></div><button class="cc-btn cc-ghost" data-act="close">Close</button></div>
    <div class="cc-preview">
      <canvas id="cc-canvas" width="${PV.W}" height="${PV.H}"></canvas>
      <div class="cc-resizebar" id="cc-resizebar" title="Drag to resize preview"><div></div></div>
      <div class="cc-transport">
        <button class="cc-btn cc-ghost" id="cc-play" title="Play/pause preview">⏸</button>
        <input class="cc-seekrange" id="cc-seekrange" type="range" min="0" max="100" step="0.01" value="0" />
        <button class="cc-btn cc-ghost" id="cc-bg" title="Preview background: dark → checker → video frame">🏁</button>
        <button class="cc-btn cc-ghost" id="cc-box" title="Toggle caption box">☐</button>
        <span class="cc-time" id="cc-time">0.0s / 0.0s</span>
      </div>
    </div>
    <div class="cc-tabs">${TABS.map((t, i) => `<button class="cc-tab${i === _tab ? ' cc-active' : ''}" data-tab="${i}">${t}</button>`).join('')}</div>
    <div class="cc-body" id="cc-body"></div>
    <div class="cc-status" id="cc-status">${_esc(S.status)}</div>`;
  v.querySelector('[data-act="close"]').onclick = closeCaptions;
  const playBtn = v.querySelector('#cc-play');
  if (playBtn) playBtn.onclick = () => {
    if (!PV.playing && PV.t >= _pvDuration() && _pvDuration() > 0) PV.t = 0;
    PV.playing = !PV.playing;
    playBtn.textContent = PV.playing ? '⏸' : '▶';
  };
  const seekBar = v.querySelector('#cc-seekrange');
  if (seekBar) seekBar.oninput = (e) => {
    // Don't fight the thumb while dragging (AE parity): the tick loop
    // skips writing the value while this has focus.
    const dur = _pvDuration();
    PV.t = (parseFloat(e.target.value) / 100) * dur;
  };
  const boxBtn = v.querySelector('#cc-box');  if (boxBtn) {
    boxBtn.textContent = S.showBox ? '☑' : '☐';
    boxBtn.onclick = () => { S.showBox = !S.showBox; boxBtn.textContent = S.showBox ? '☑' : '☐'; };
  }
  const pCanvas = v.querySelector('#cc-canvas');
  if (pCanvas) pCanvas.onmousedown = (e) => {
    // Caption-box direct manipulation (AE parity): drag edges to resize
    // the box (ew-resize), drag inside to move (posX/posY).
    const W = PV.W, H = PV.H;
    const rect = pCanvas.getBoundingClientRect();
    const sx = PV.W / Math.max(1, rect.width), sy = PV.H / Math.max(1, rect.height);
    const mx = (e.clientX - rect.left) * sx, my = (e.clientY - rect.top) * sy;
    const margin = Math.max(0, W * (1 - S.boxW / 100) / 2);
    const size = Math.max(8, Math.round(S.fontSize * (W / 1080)));
    const y0 = H * (S.posY / 100);
    const top = y0 - size * 0.3, bot = y0 + size * 1.4;
    let mode = null;
    if (my >= top - 12 && my <= bot + 12) {
      if (Math.abs(mx - margin) < 14) mode = 'left';
      else if (Math.abs(mx - (W - margin)) < 14) mode = 'right';
      else if (mx > margin && mx < W - margin) mode = 'move';
    }
    pCanvas.style.cursor = mode === 'move' ? 'move' : (mode ? 'ew-resize' : '');
    if (!mode) return;
    e.preventDefault();
    const startX = mx, startY = my;
    const startPosX = S.posX, startPosY = S.posY, startBox = S.boxW;
    const move = (ev) => {
      const dx = ((ev.clientX - rect.left) * sx - startX) / W * 100;
      const dy = ((ev.clientY - rect.top) * sy - startY) / H * 100;
      if (mode === 'move') {
        S.posX = Math.max(0, Math.min(100, Math.round(startPosX + dx)));
        S.posY = Math.max(0, Math.min(100, Math.round(startPosY + dy)));
      } else {
        const dw = (mode === 'left' ? -dx : dx) * 2;
        S.boxW = Math.max(30, Math.min(100, Math.round(startBox + dw)));
      }
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      pCanvas.style.cursor = '';
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };
  const rzBar = v.querySelector('#cc-resizebar');
  if (rzBar) rzBar.onmousedown = (e) => {
    e.preventDefault();
    const canvas = v.querySelector('#cc-canvas');
    const startY = e.clientY;
    const startH = (canvas && canvas.clientHeight) || 220;
    const move = (ev) => {
      const h = Math.max(140, Math.min(520, startH + (ev.clientY - startY)));
      const c = v.querySelector('#cc-canvas');
      if (c) c.style.height = h + 'px';
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      try {
        const c = v.querySelector('#cc-canvas');
        if (c) localStorage.setItem('editflow_cc_preview_h', String(c.clientHeight || 220));
      } catch (_) {}
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };
  try {
    const cv = v.querySelector('#cc-canvas');
    const savedH = localStorage.getItem('editflow_cc_preview_h');
    if (cv && savedH) cv.style.height = Math.max(140, Math.min(520, parseInt(savedH, 10) || 220)) + 'px';
  } catch (_) {}
  v.querySelectorAll('[data-tab]').forEach(b => { b.onclick = () => { _tab = +b.dataset.tab; _render(); }; });
  const body = v.querySelector('#cc-body');
  if (_tab === 0) _renderTranscribe(body);
  else if (_tab === 1) _renderContent(body);
  else if (_tab === 2) _renderStyle(body);
  else if (_tab === 3) _renderAnimate(body);
  else _renderGenerate(body);
  _pvStart();
}
function _setStatus(s) { S.status = s; const el = $('#cc-status'); if (el) el.textContent = s; }

// ── Live preview engine (AE canvas parity, client-side) ────────
// Same layout + motion math as backend/services/subtitles/animated_overlay,
// scaled to a 360×640 canvas (1/3 of the 1080 reference). Reads S live, so
// every Style change shows instantly with no render roundtrip.
function _pvStop() {
  if (PV.raf) { try { cancelAnimationFrame(PV.raf); } catch (_) {} PV.raf = 0; }
}
function _pvStart() {
  if (PV.raf) return;
  PV.last = 0;
  let logged = false;
  const tick = (now) => {
    PV.raf = 0;
    try {
      const canvas = document.getElementById('cc-canvas');
      if (!canvas || canvas.offsetParent === null) return; // view hidden/closed
      if (PV.last && PV.playing) PV.t += (now - PV.last) / 1000;
      PV.last = now;
      const dur = _pvDuration();
      if (dur > 0 && PV.t >= dur) {
        // Stop at the end like AE (restart via play).
        PV.t = dur; PV.playing = false;
        const pb = document.getElementById('cc-play');
        if (pb) pb.textContent = '▶';
      }
      _pvDraw(canvas, PV.t);
      const live = document.getElementById('cc-live');
      if (live) live.style.opacity = (Math.floor(now / 500) % 2) ? '1' : '0.25';
      const range = document.getElementById('cc-seekrange');
      if (range && document.activeElement !== range) {
        range.value = dur > 0 ? String((PV.t / dur) * 100) : '0';
      }
      const label = document.getElementById('cc-time');
      if (label) label.textContent = PV.t.toFixed(1) + 's / ' + dur.toFixed(1) + 's';
    } catch (e) {
      // One bad frame must never kill the page (this class of silent death
      // showed as a black panel). Log once, keep looping.
      if (!logged) { logged = true; console.error('[EditFlow] preview frame failed:', e); }
    }
    PV.raf = requestAnimationFrame(tick);
  };
  PV.raf = requestAnimationFrame(tick);
}
function _pvDuration() {
  const cues = S.cues.length ? S.cues : _pvAutoCues();
  let end = 0;
  for (const c of cues) for (const w of (c.words || [])) end = Math.max(end, w.end || 0);
  return end;
}
function _pvAutoCues() {
  // Quick client-side grouping (backend cue_builder parity, simplified):
  // split on silence > 0.8s, cap 7 words, break after sentence punctuation.
  const words = S.words.filter(w => (w.text || '').trim());
  const out = [];
  let cur = [];
  const push = () => {
    if (!cur.length) return;
    out.push({ text: cur.map(w => w.text).join(' '),
               start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
    cur = [];
  };
  for (const w of words) {
    if (cur.length) {
      const gap = w.start - cur[cur.length - 1].end;
      if (gap > 0.8 || cur.length >= 7) push();
    }
    cur.push(w);
    if (/[.?!؟۔…]["')\]]?\s*$/.test(w.text || '')) push();
  }
  push();
  return out;
}
function _pvFont(size) {
  const fam = (S.fontCustom || S.fontFamily || 'Arial').replace(/"/g, '');
  return `${S.fontBold === false ? 400 : 700} ${size}px "${fam}", Arial, sans-serif`;
}
function _hexA(hex, op) {
  const h = String(hex || '#ffffff').replace('#', '');
  const f = h.length === 3 ? h.split('').map(c => c + c).join('') : (h + 'ffffff').slice(0, 6);
  const n = parseInt(f, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${op})`;
}
function _pvDraw(canvas, t) {
  const ctx = canvas.getContext('2d');
  const W = PV.W, H = PV.H, k = W / 1080;
  const size = Math.max(8, Math.round(S.fontSize * k));
  const y0 = Math.round(H * (S.posY / 100));
  const margin = Math.max(0, W * (1 - S.boxW / 100) / 2);
  const maxW = Math.max(1, W - 2 * margin);
  ctx.clearRect(0, 0, W, H);
  if (S.bgMode === 'video' && S.bgUrl) {
    if (!PVBG.img || PVBG.src !== S.bgUrl) {
      PVBG.img = new Image();
      PVBG.src = S.bgUrl;
      PVBG.img.src = S.bgUrl;
    }
    const im = PVBG.img;
    if (im.complete && im.naturalWidth > 0) {
      // Cover-crop the frame into the canvas.
      const s = Math.max(W / im.naturalWidth, H / im.naturalHeight);
      const dw = im.naturalWidth * s, dh = im.naturalHeight * s;
      ctx.drawImage(im, (W - dw) / 2, (H - dh) / 2, dw, dh);
    } else {
      ctx.fillStyle = '#101010';
      ctx.fillRect(0, 0, W, H);
    }
  } else if (S.bgMode === 'checker') {
    ctx.fillStyle = '#181818';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#232323';
    const cell = 24;
    for (let yy = 0; yy < H; yy += cell) {
      for (let xx = ((yy / cell) % 2) * cell; xx < W; xx += cell * 2) {
        ctx.fillRect(xx, yy, cell, cell);
      }
    }
  } else {
    ctx.fillStyle = '#101010';
    ctx.fillRect(0, 0, W, H);
  }
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left'; // reset every frame: the empty-state hint below
  // uses center, and a sticky center shifts every word right by half
  // its width (grows with font size — seen live).
  const font = _pvFont(size);
  const spW = ctx.measureText(' ').width;
  const anim = _pvAnim();
  const ease = EASE_FN[S.wordEasing] || EASE_FN.expo_out;
  const risePx = S.slideDist * k, fadeT = 0.2, riseT = S.fadeDur;
  const inten = Math.max(0.1, Math.min(3, S.animIntensity || 1));
  const wordAlpha = (w0) => Math.min(1, Math.max(0, (t - w0) / fadeT));
  const drawRun = (words, hold) => {
    // Greedy chunk-split + layout (backend mirror, single line each).
    // Chunks get OWN time windows (backend hold parity): showing every
    // chunk for the whole cue stacked them on top of each other.
    const texts = words.map(w => (S.allCaps ? String(w.text || '').toUpperCase() : String(w.text || '')));
    ctx.font = font;
    const widths = texts.map(x => ctx.measureText(x).width);
    let total = widths.reduce((a, b) => a + b, 0) + spW * Math.max(0, texts.length - 1);
    const chunks = [];
    let cur = [], curW = 0;
    texts.forEach((tx, i) => {
      const add = cur.length ? spW + widths[i] : widths[i];
      if (cur.length && curW + add > maxW) { chunks.push(cur); cur = []; curW = 0; }
      cur.push(i); curW += cur.length === 1 ? widths[i] : spW + widths[i];
    });
    if (cur.length) chunks.push(cur);
    const cStarts = chunks.map(idxs => Math.min(...idxs.map(i => words[i].start)));
    const cEnds = chunks.map(idxs => Math.max(...idxs.map(i => words[i].end)));
    chunks.forEach((idxs, cki) => {
      const cHold = (cki + 1 < chunks.length && cStarts[cki + 1] > cEnds[cki])
        ? cStarts[cki + 1] : (cki + 1 >= chunks.length ? hold : cEnds[cki]);
      if (t < cStarts[cki] - 0.05 || t > cHold + 0.05) return;
      const cw = idxs.reduce((a, i) => a + widths[i], 0) + spW * (idxs.length - 1);
      let cx = W * (S.posX / 100);
      let x = Math.min(Math.max(cx - cw / 2, margin), Math.max(margin, W - margin - cw));
      // Word left edges, then pill runs (consecutive pill words, one box).
      const left = {};
      idxs.forEach((i) => { left[i] = x; x += widths[i] + spW; });
      let run = [];
      const runs = [];
      idxs.forEach((i) => {
        if (words[i].pill) run.push(i);
        else { if (run.length) runs.push(run); run = []; }
      });
      if (run.length) runs.push(run);
      runs.forEach((r) => {
        // Glyph-tight box, backend parity: center on real ascenders/
        // descenders relative to the cap top (same reference backend uses).
        ctx.font = font;
        const capA = (ctx.measureText('H').actualBoundingBoxAscent || size * 0.72);
        let rAsc = 0, rDesc = 0;
        r.forEach((i) => {
          ctx.font = font;
          const m = ctx.measureText(texts[i]);
          rAsc = Math.max(rAsc, m.actualBoundingBoxAscent || 0);
          rDesc = Math.max(rDesc, m.actualBoundingBoxDescent || 0);
        });
        const pad = size * 0.10;
        const bx0 = left[r[0]] - size * 0.28;
        const bx1 = left[r[r.length - 1]] + widths[r[r.length - 1]] + size * 0.28;
        const by = y0 + (capA - rAsc) - pad, bh = (rAsc + rDesc) + pad * 2;
        const aMax = Math.max(...r.map(i => wordAlpha(words[i].start)));
        if (aMax > 0.01 && t <= hold) {
          // Pill scale-in (AE pillScale): grows 0→1 over 0.5s from the run
          // start, then holds with the caption.
          const pillT0 = Math.min(...r.map(i => words[i].start));
          const ps = ease(Math.min(1, Math.max(0, (t - pillT0) / 0.5)));
          const pcx = (bx0 + bx1) / 2, pcy = by + bh / 2;
          ctx.save();
          ctx.translate(pcx, pcy);
          ctx.scale(Math.max(0.01, ps), Math.max(0.01, ps));
          ctx.translate(-pcx, -pcy);
          ctx.globalAlpha = Math.min(1, aMax) * (S.pillOpacity / 100);
          ctx.fillStyle = S.pillColor;
          ctx.beginPath();
          const prad = Math.max(0, (bh / 2) * (S.pillRadius / 50));
          if (ctx.roundRect) ctx.roundRect(bx0, by, bx1 - bx0, bh, prad);
          else ctx.rect(bx0, by, bx1 - bx0, bh);
          ctx.fill();
          if (S.pillOutline && S.pillStrokeWidth > 0) {
            ctx.globalAlpha = Math.min(1, aMax);
            ctx.strokeStyle = S.pillStrokeColor;
            ctx.lineWidth = Math.max(1, size * 0.03 * (S.pillStrokeWidth / 2));
            ctx.stroke();
          }
          ctx.restore();
        }
      });
      idxs.forEach((i) => {
        const w0 = words[i].start, tx = texts[i];
        if (!tx || t < w0 || t > hold) return;
        // Anchor: caption-level presets animate the whole chunk from its
        // first word (backend caption_level parity).
        const anchor = anim.captionLevel ? Math.min(...idxs.map(j => words[j].start)) : w0;
        const dt = t - anchor;
        let dy = 0, a = dt >= 0 ? wordAlpha(anchor) : 0;
        const p = Math.min(1, Math.max(0, dt / riseT));
        if (anim.motion === 'rise' || anim.motion === 'back' || anim.motion === 'fadeup') {
          dy = risePx * (1 - ease(p)); a = Math.min(1, a * 3);
        } else if (anim.motion === 'fade') {
          dy = 0;
        } else if (anim.motion === 'bounce') {
          dy = dt < 1.2 ? -(60 * k) * inten * Math.abs(Math.sin(14 * dt)) * Math.pow(2.71828, -3.5 * dt) : 0;
        }
        ctx.save();
        ctx.globalAlpha = Math.min(1, Math.max(0, a));
        ctx.font = font;
        ctx.fillStyle = S.textColor;
        if (S.strokeWidth > 0) {
          ctx.strokeStyle = S.strokeColor;
          ctx.lineWidth = Math.max(1, S.strokeWidth * 2 * (W / 1080));
          ctx.lineJoin = 'round';
          ctx.strokeText(tx, left[i], y0 + dy);
        }
        if (S.shadowOn) {
          ctx.shadowColor = _hexA(S.shadowColor, S.shadowOpacity / 100);
          ctx.shadowBlur = Math.max(0, S.shadowBlur * (W / 1080));
          ctx.shadowOffsetY = Math.max(0, S.shadowDistance * (W / 1080)) * 0.7;
        } else {
          ctx.shadowBlur = 0;
          ctx.shadowOffsetY = 0;
        }
        ctx.fillText(tx, left[i], y0 + dy);
        ctx.restore();
      });
    });
  };
  // Holds mirror the backend (next cue start, else +0.5 tail).
  // Live style preview (AE parity): with words but no built cues yet,
  // auto-group on the fly so Style changes show without building first.
  const cues = S.cues.length ? S.cues : _pvAutoCues();
  const starts = cues.map(c => Math.min(...c.words.map(w => w.start)));
  const ends = cues.map(c => Math.max(...c.words.map(w => w.end)));
  cues.forEach((c, i) => {
    const hold = (i + 1 < cues.length && starts[i + 1] > ends[i]) ? starts[i + 1] : ends[i] + (i + 1 >= cues.length ? 0.5 : 0);
    if (t >= Math.min(...c.words.map(w => w.start)) - 0.05 && t <= hold + 0.05) drawRun(c.words, hold);
  });
  if (S.showBox) {
    const bx = margin, bw = W - 2 * margin;
    const sizeB = Math.max(8, Math.round(S.fontSize * (W / 1080)));
    const byB = Math.round(H * (S.posY / 100)) - sizeB * 0.3;
    const bhB = sizeB * 1.7;
    ctx.save();
    ctx.strokeStyle = 'rgba(127,179,255,0.8)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(bx, byB, bw, bhB);
    ctx.setLineDash([]);
    ctx.restore();
  }
  if (!S.cues.length && !S.words.length) {
    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#888';
    ctx.textAlign = 'center';
    ctx.fillText('Transcribe or paste words to preview', W / 2, H / 2);
    ctx.textAlign = 'left';
    return;
  }
}

// ── Tab 1: Transcribe ────────────────────────────────────────
function _renderTranscribe(body) {
  body.innerHTML = `
    <p class="cc-hint">Upload audio or video — Whisper transcribes it with word-level timestamps. Large files take a while; the first run downloads the model from Settings.</p>
    <label class="cc-label">Media file</label>
    <input id="cc-file" class="cc-input" type="file" accept="audio/*,video/*" />
    <div class="cc-row">
      <div><label class="cc-label">Language</label><select id="cc-lang" class="cc-input">${LANGUAGES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
      <div><label class="cc-label">Engine</label><select id="cc-engine" class="cc-input"><option value="auto">Auto (WhisperX → Whisper)</option><option value="whisperx">WhisperX only</option><option value="whisper">Whisper only</option></select></div>
    </div>
    <div class="cc-actions"><button class="cc-btn cc-primary" data-act="go" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Transcribing…' : 'Transcribe'}</button></div>
    <div class="cc-or">— or paste a transcript (no re-transcribe) —</div>
    <textarea id="cc-paste" class="cc-input cc-textarea" placeholder="Paste SRT cues, JSON [{word,start,end}], or plain text…" spellcheck="false"></textarea>
    <div class="cc-actions"><button class="cc-btn" data-act="paste">Use this transcript</button></div>`;
  body.querySelector('[data-act="go"]').onclick = _transcribe;
  body.querySelector('[data-act="paste"]').onclick = _parsePasted;
}
function _srtToSecs(s) {
  const m = s.match(/(\d+):(\d+):([\d.,]+)/);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(String(m[3]).replace(',', '.'));
}
function _parsePasted() {
  // AE parity: SRT cues (words spread evenly per cue), JSON words, or
  // plain text (even split over 60s). Zero backend calls.
  const raw = ($('#cc-paste')?.value || '').trim();
  if (!raw) { _setStatus('Paste something first.'); return; }
  let words = [];
  try {
    const j = JSON.parse(raw);
    const arr = Array.isArray(j) ? j : j.words || j.segments || [];
    if (Array.isArray(arr) && arr.length && (arr[0].start !== undefined || arr[0].word || arr[0].text)) {
      words = arr.map(w => ({ text: String(w.word || w.text || ''), start: +w.start || 0, end: +w.end || 0, keep: true }));
    }
  } catch (_) {}
  if (!words.length && /-->\s*\d/.test(raw)) {
    // SRT-ish: split blocks, distribute each cue's text evenly across it.
    const blocks = raw.split(/\n\s*\n/);
    for (const b of blocks) {
      const lines = b.split('\n').map(s => s.trim()).filter(Boolean);
      const ti = lines.findIndex(l => /-->/.test(l));
      if (ti < 0) continue;
      const [a, c] = lines[ti].split('-->').map(s => s.trim());
      const s0 = _srtToSecs(a), s1 = _srtToSecs(c);
      if (s0 === null || s1 === null || s1 <= s0) continue;
      const toks = lines.slice(ti + 1).join(' ').split(/\s+/).filter(Boolean);
      if (!toks.length) continue;
      const per = (s1 - s0) / toks.length;
      toks.forEach((t, i) => words.push({ text: t, start: Math.round((s0 + i * per) * 100) / 100, end: Math.round((s0 + (i + 1) * per) * 100) / 100, keep: true }));
    }
  }
  if (!words.length) {
    // Plain text: even split over 60s.
    const toks = raw.split(/\s+/).filter(Boolean);
    const per = 60 / Math.max(1, toks.length);
    words = toks.map((t, i) => ({ text: t, start: Math.round(i * per * 100) / 100, end: Math.round((i + 1) * per * 100) / 100, keep: true }));
  }
  words = words.filter(w => w.text.trim());
  if (!words.length) { _setStatus('Could not parse that — try SRT, JSON, or plain words.'); return; }
  S.words = words;
  _setStatus(`${words.length} words from pasted transcript.`);
  _tab = 1; _render();
}
async function _transcribe() {
  const file = $('#cc-file')?.files?.[0];
  if (!file) { _setStatus('Pick a media file first.'); return; }
  S.busy = true; _render(); _setStatus('Uploading + transcribing…');
  try {
    const resp = await apiUpload('/api/captions/transcribe-mixdown', file, {
      language: $('#cc-lang')?.value || 'auto',
      engine: $('#cc-engine')?.value || 'auto',
    }, { timeoutMs: 600000 });
    S.words = (resp.words || []).map(w => ({ text: w.word || w.text || '', start: w.start, end: w.end, keep: true }));
    S.words = S.words.filter(w => w.text.trim());
    if (resp.bg_url) S.bgUrl = getBaseUrl() + resp.bg_url;
    _setStatus(`${S.words.length} words (${resp.engine || 'whisper'}).`);
    _tab = 1; _render();
  } catch (e) {
    const msg = String((e && e.message) || e);
    _setStatus(msg.includes('409') || /no_model/i.test(msg)
      ? 'No Whisper model installed — open Settings, download a model, retry.'
      : 'Transcription failed: ' + msg.slice(0, 200));
  } finally {
    S.busy = false;
    if (_tab === 0) _render();
  }
}

// ── Tab 2: Content ───────────────────────────────────────────
function _renderContent(body) {
  if (!S.words.length) {
    body.innerHTML = `<p class="cc-hint">No words yet — transcribe or paste a transcript first (tab 1).</p>`;
    return;
  }
  const kept = S.words.filter(w => w.keep !== false).length;
  const pilled = S.words.filter(w => w.pill).length;
  body.innerHTML = `
    <p class="cc-hint">${kept}/${S.words.length} words kept${pilled ? `, ${pilled} with pill` : ''}. Edit text + start times inline; pill marks background words.</p>
    <div class="cc-actions">
      <button class="cc-btn cc-ghost" data-act="pillall">Pill all</button>
      <button class="cc-btn cc-ghost" data-act="pillnone">Clear pills</button>
    </div>
    <div class="cc-wrows">${S.words.map((w, i) => `
      <div class="cc-wrow" data-i="${i}">
        <button class="cc-btn cc-ghost cc-keep${w.keep !== false ? ' cc-on' : ''}" data-k="keep" title="Keep/exclude">✓</button>
        <input class="cc-input cc-wtime" data-k="time" type="number" value="${Number(w.start || 0).toFixed(2)}" step="0.05" min="0" title="Word start (seconds)" />
        <input class="cc-input cc-wtext" data-k="text" type="text" value="${_esc(w.text)}" spellcheck="false" />
        <button class="cc-btn cc-ghost${w.pill ? ' cc-on' : ''}" data-k="pill" title="Pill background">💊</button>
      </div>`).join('')}</div>
    <label class="cc-label">Segment settings (grouping)</label>
    ${_rangeRow('cc-maxwords', 'Max words / cue', 1, 8, 1, S.opts.max_words_per_cue, '')}
    ${_rangeRow('cc-maxchars', 'Max chars / line', 10, 80, 1, S.opts.max_chars_per_line, '')}
    ${_rangeRow('cc-maxdur', 'Max cue duration', 1, 10, 0.5, S.opts.max_cue_duration, 's')}
    ${_rangeRow('cc-maxlines', 'Max lines', 1, 2, 1, S.opts.max_lines, '')}
    ${_rangeRow('cc-maxgap', 'Split gap', 0.1, 2, 0.1, S.opts.max_gap, 's')}`;
  body.querySelector('[data-act="pillall"]').onclick = () => { S.words.forEach(w => { w.pill = true; }); _render(); };
  body.querySelector('[data-act="pillnone"]').onclick = () => { S.words.forEach(w => { w.pill = false; }); _render(); };
  _bindRange('cc-maxwords', v => { if (!isNaN(v)) S.opts.max_words_per_cue = Math.max(1, Math.min(12, Math.round(v))); });
  _bindRange('cc-maxchars', v => { if (!isNaN(v)) S.opts.max_chars_per_line = Math.max(10, Math.min(120, Math.round(v))); });
  _bindRange('cc-maxdur', v => { if (!isNaN(v)) S.opts.max_cue_duration = Math.max(0.5, Math.min(15, v)); });
  _bindRange('cc-maxlines', v => { if (!isNaN(v)) S.opts.max_lines = Math.max(1, Math.min(3, Math.round(v))); });
  _bindRange('cc-maxgap', v => { if (!isNaN(v)) S.opts.max_gap = Math.max(0.05, Math.min(3, v)); });
  body.querySelectorAll('.cc-wrow').forEach(row => {
    const w = S.words[+row.dataset.i];
    if (!w) return;
    row.querySelector('[data-k="keep"]').onclick = (e) => {
      w.keep = !(w.keep !== false);
      e.target.classList.toggle('cc-on', w.keep !== false);
    };
    row.querySelector('[data-k="pill"]').onclick = (e) => {
      w.pill = !w.pill;
      e.target.classList.toggle('cc-on', !!w.pill);
    };
    const timeEl = row.querySelector('[data-k="time"]');
    timeEl.onchange = () => {
      const v = parseFloat(timeEl.value);
      if (isNaN(v) || v < 0) { timeEl.value = Number(w.start || 0).toFixed(2); return; }
      const dur = Math.max(0.02, (w.end || 0) - (w.start || 0));
      w.start = Math.round(v * 100) / 100;
      w.end = Math.round((w.start + dur) * 100) / 100;
    };
    const textEl = row.querySelector('[data-k="text"]');
    textEl.onchange = () => { w.text = textEl.value; };
  });
}

// ── Tab 4: Animate (AE parity: preset + easing + timing) ────
function _renderAnimate(body) {
  const sel = (id, opts, val) => `<select id="${id}" class="cc-input">${opts.map(([v, l]) => `<option value="${v}"${v === val ? ' selected' : ''}>${l}</option>`).join('')}</select>`;  body.innerHTML = `
    <p class="cc-hint">Motion plays live in the preview above — same model as the final video.</p>
    <label class="cc-label">Animation preset</label>
    ${sel('cc-animpreset', ANIM_PRESETS, S.animPreset)}
    ${_rangeRow('cc-intensity', 'Intensity (bounce)', 0.1, 3, 0.05, S.animIntensity, '×')}
    ${_rangeRow('cc-fadedur', 'Word duration', 0.1, 1, 0.05, S.fadeDur, 's')}
    ${_rangeRow('cc-slidedist', 'Slide distance', 0, 400, 1, S.slideDist, 'px')}
    <label class="cc-label">Word easing</label>
    ${sel('cc-easing', EASING_OPTS, S.wordEasing)}`;
  body.querySelector('#cc-animpreset').onchange = (e) => { S.animPreset = e.target.value; };
  _bindRange('cc-intensity', v => { if (!isNaN(v)) S.animIntensity = Math.max(0.1, Math.min(3, v)); });
  _bindRange('cc-fadedur', v => { if (!isNaN(v)) S.fadeDur = Math.max(0.1, Math.min(1, v)); });
  _bindRange('cc-slidedist', v => { if (!isNaN(v)) S.slideDist = Math.max(0, Math.min(400, Math.round(v))); });
  body.querySelector('#cc-easing').onchange = (e) => { S.wordEasing = e.target.value; };
}
const FONT_FAMILIES = ['Arial', 'Arial Black', 'Helvetica', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Times New Roman', 'Impact', 'Calibri'];

// Widget: scrub value (AE/Premiere value-scrub UX) — hover shows the
// ↔ cursor, drag right/left to change. Mutates S only (no re-render),
// so the preview updates live and slider focus is never an issue.
function _rangeRow(id, label, min, max, step, val, unit) {
  return `<label class="cc-label">${label} <span class="cc-val cc-scrub" id="${id}" data-min="${min}" data-max="${max}" data-step="${step}" data-unit="${unit || ''}" data-val="${val}" title="Drag ↔ to change">${val}${unit || ''}</span></label>`;
}
function _bindRange(id, set) {
  const el = document.getElementById(id);
  if (!el) return;
  el.onmousedown = (e) => {
    e.preventDefault();
    const min = parseFloat(el.dataset.min), max = parseFloat(el.dataset.max);
    const step = parseFloat(el.dataset.step) || 1;
    const unit = el.dataset.unit || '';
    const startV = parseFloat(el.dataset.val);
    const startX = e.clientX;
    let moved = false;
    const show = (v) => {
      el.dataset.val = v;
      el.textContent = (Math.round(v * 100) / 100) + unit;
    };
    const move = (ev) => {
      if (Math.abs(ev.clientX - startX) > 4) moved = true;
      if (!moved) return;
      const mult = ev.shiftKey ? 10 : 1;
      const nv = Math.min(max, Math.max(min, startV + Math.round((ev.clientX - startX) / 6) * step * mult));
      show(nv);
      set(nv);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      if (!moved) {
        // Click (no drag): type the exact value inline.
        const inp = document.createElement('input');
        inp.className = 'cc-input cc-miniedit';
        inp.value = el.dataset.val;
        el.replaceWith(inp);
        inp.focus();
        inp.select();
        const commit = (ok) => {
          const v = parseFloat(inp.value);
          const span = document.createElement('span');
          span.className = 'cc-val cc-scrub';
          span.id = id;
          span.dataset.min = min; span.dataset.max = max;
          span.dataset.step = step; span.dataset.unit = unit;
          span.title = 'Drag ↔ to change, click to type';
          if (ok && !isNaN(v)) {
            const nv = Math.min(max, Math.max(min, v));
            span.dataset.val = nv;
            span.textContent = (Math.round(nv * 100) / 100) + unit;
            set(nv);
          } else {
            span.dataset.val = el.dataset.val;
            span.textContent = el.dataset.val + unit;
          }
          inp.replaceWith(span);
          _bindRange(id, set);
        };
        inp.onkeydown = (ev) => {
          if (ev.key === 'Enter') commit(true);
          else if (ev.key === 'Escape') commit(false);
        };
        inp.onblur = () => commit(true);
      }
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };
}
function _colorRow(id, label, val) {
  return `<label class="cc-label">${label}</label>`
    + `<input class="cc-color" id="${id}" type="color" value="${val}" />`;
}
function _bindColor(id, set) {
  const el = document.getElementById(id);
  if (el) el.oninput = () => set(el.value);
}
async function _ensurePresets() {
  if (S.presets.length) return;
  try {
    const resp = await apiGet('/api/captions/presets', { timeoutMs: 10000 });
    S.presets = resp.presets || [];
  } catch (_) { S.presets = []; }
}
function _renderStyle(body) {
  body.innerHTML = `
    <label class="cc-label">Font family</label>
    <select id="cc-fontfam" class="cc-input">${FONT_FAMILIES.map(f => `<option${f === S.fontFamily ? ' selected' : ''}>${f}</option>`).join('')}<option value="__custom"${FONT_FAMILIES.indexOf(S.fontFamily) === -1 ? ' selected' : ''}>Custom…</option></select>
    <input id="cc-fontcustom" class="cc-input" type="text" value="${_esc(S.fontCustom)}" placeholder="Custom PostScript name" style="margin-top:4px;${FONT_FAMILIES.indexOf(S.fontFamily) === -1 ? '' : 'display:none'}" spellcheck="false" />
    <div class="cc-checkrow"><label class="cc-check"><input type="checkbox" id="cc-fontbold"${S.fontBold ? ' checked' : ''} /> Bold</label>
    <label class="cc-check"><input type="checkbox" id="cc-caps"${S.allCaps ? ' checked' : ''} /> UPPERCASE</label></div>
    <div class="cc-row">
      <div>${_rangeRow('cc-fontsize', 'Font size', 20, 200, 1, S.fontSize, 'px')}</div>
      <div><label class="cc-label">Text</label><input class="cc-color cc-sw" id="cc-textcolor" type="color" value="${S.textColor}" /></div>
      <div><label class="cc-label">Outline</label><input class="cc-color cc-sw" id="cc-strokecolor" type="color" value="${S.strokeColor}" /></div>
    </div>
    ${_rangeRow('cc-strokew', 'Outline width (0 = off)', 0, 10, 1, S.strokeWidth, 'px')}
    <div class="cc-checkrow"><label class="cc-check"><input type="checkbox" id="cc-shadowon"${S.shadowOn ? ' checked' : ''} /> Shadow</label>
    <label class="cc-label"><input class="cc-color cc-sw" id="cc-shadowcolor" type="color" value="${S.shadowColor}" /></label></div>
    <div class="cc-row">
      <div>${_rangeRow('cc-shadowop', 'Sh. opacity', 0, 100, 1, S.shadowOpacity, '%')}</div>
      <div>${_rangeRow('cc-shadowdist', 'Sh. distance', 0, 50, 1, S.shadowDistance, 'px')}</div>
      <div>${_rangeRow('cc-shadowblur', 'Sh. blur', 0, 50, 1, S.shadowBlur, 'px')}</div>
    </div>
    <div class="cc-row">
      <div>${_rangeRow('cc-posx', 'Position X', 0, 100, 1, S.posX, '%')}</div>
      <div>${_rangeRow('cc-posy', 'Position Y', 0, 100, 1, S.posY, '%')}</div>
      <div>${_rangeRow('cc-boxw', 'Box width', 60, 100, 1, S.boxW, '%')}</div>
    </div>
    <label class="cc-label">Pill background</label>
    <div class="cc-row">
      <div><label class="cc-label">Color</label><input class="cc-color cc-sw" id="cc-pillcolor" type="color" value="${S.pillColor}" /></div>
      <div>${_rangeRow('cc-pillop', 'Opacity', 0, 100, 1, S.pillOpacity, '%')}</div>
      <div><label class="cc-label">Rim</label><input class="cc-color cc-sw" id="cc-pillstrokecolor" type="color" value="${S.pillStrokeColor}" /></div>
    </div>
    <div class="cc-row">
      <div>${_rangeRow('cc-pillstrokew', 'Rim width (0 = off)', 0, 10, 1, S.pillStrokeWidth, 'px')}</div>
      <div>${_rangeRow('cc-pillradius', 'Roundness', 0, 100, 1, Math.round(S.pillRadius * 100), '%')}</div>
    </div>
    <label class="cc-check"><input type="checkbox" id="cc-pilloutline"${S.pillOutline ? ' checked' : ''} /> Pill rim</label>
    <p class="cc-hint">Drag values ↔, click to type. Preview above updates as you drag.</p>`;
  const fam = body.querySelector('#cc-fontfam');
  if (fam) fam.onchange = () => {
    if (fam.value === '__custom') { body.querySelector('#cc-fontcustom').style.display = ''; }
    else { S.fontFamily = fam.value; S.fontCustom = ''; body.querySelector('#cc-fontcustom').style.display = 'none'; }
  };
  const fc = body.querySelector('#cc-fontcustom');
  if (fc) fc.onchange = () => { S.fontCustom = fc.value.trim(); };
  const fb = body.querySelector('#cc-fontbold');
  if (fb) fb.onchange = () => { S.fontBold = fb.checked; };
  const caps = body.querySelector('#cc-caps');
  if (caps) caps.onchange = () => { S.allCaps = caps.checked; };
  _bindRange('cc-fontsize', v => { if (!isNaN(v)) S.fontSize = Math.max(20, Math.min(200, Math.round(v))); });
  _bindColor('cc-textcolor', v => { S.textColor = v; });
  _bindColor('cc-strokecolor', v => { S.strokeColor = v; });
  _bindRange('cc-strokew', v => { if (!isNaN(v)) S.strokeWidth = Math.max(0, Math.min(10, Math.round(v))); });
  const sh = body.querySelector('#cc-shadowon');
  if (sh) sh.onchange = () => { S.shadowOn = sh.checked; };
  _bindColor('cc-shadowcolor', v => { S.shadowColor = v; });
  _bindRange('cc-shadowop', v => { if (!isNaN(v)) S.shadowOpacity = Math.max(0, Math.min(100, Math.round(v))); });
  _bindRange('cc-shadowdist', v => { if (!isNaN(v)) S.shadowDistance = Math.max(0, Math.min(50, Math.round(v))); });
  _bindRange('cc-shadowblur', v => { if (!isNaN(v)) S.shadowBlur = Math.max(0, Math.min(50, Math.round(v))); });
  _bindRange('cc-posx', v => { if (!isNaN(v)) S.posX = Math.max(0, Math.min(100, Math.round(v))); });
  _bindRange('cc-posy', v => { if (!isNaN(v)) S.posY = Math.max(0, Math.min(100, Math.round(v))); });
  _bindRange('cc-boxw', v => { if (!isNaN(v)) S.boxW = Math.max(60, Math.min(100, Math.round(v))); });
  _bindColor('cc-pillcolor', v => { S.pillColor = v; });
  _bindRange('cc-pillop', v => { if (!isNaN(v)) S.pillOpacity = Math.max(0, Math.min(100, Math.round(v))); });
  _bindColor('cc-pillstrokecolor', v => { S.pillStrokeColor = v; });
  _bindRange('cc-pillstrokew', v => { if (!isNaN(v)) S.pillStrokeWidth = Math.max(0, Math.min(10, Math.round(v))); });
  _bindRange('cc-pillradius', v => { if (!isNaN(v)) S.pillRadius = Math.max(0, Math.min(100, Math.round(v))) / 100; });
  const pl = body.querySelector('#cc-pilloutline');
  if (pl) pl.onchange = () => { S.pillOutline = pl.checked; };
}

// ── Tab 4: Generate ──────────────────────────────────────────
function _renderGenerate(body) {
  if (!S.words.length) {
    body.innerHTML = `<p class="cc-hint">No words yet — transcribe first (tab 1).</p>`;
    return;
  }
  body.innerHTML = `
    <div class="cc-row">
      <div><label class="cc-label">Timing source</label><select id="cc-src" class="cc-input">
        <option value="standalone"${S.sourceMode === 'standalone' ? ' selected' : ''}>Standalone (source times)</option>
        <option value="final_cut"${S.sourceMode === 'final_cut' ? ' selected' : ''}>Post-cut (excluded words removed)</option>
      </select></div>
      <div><label class="cc-label">File name</label><input id="cc-name" class="cc-input" value="${_esc(S.fileName)}" spellcheck="false" /></div>
    </div>
    <div class="cc-actions">
      <button class="cc-btn" data-act="build" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Working…' : 'Build cues'}</button>
      <button class="cc-btn" data-act="preview" ${S.busy || !S.cues.length ? 'disabled' : ''}>${S.busy ? 'Working…' : 'Preview first 6s'}</button>
      <button class="cc-btn cc-primary" data-act="import" ${S.busy || !S.cues.length ? 'disabled' : ''}>Export SRT + Import to timeline</button>
    </div>
    <div class="cc-actions">
      <button class="cc-btn" data-act="overlay" ${S.busy || !S.cues.length ? 'disabled' : ''}>${S.busy ? 'Working…' : 'Build animated overlay (fade-up words)'}</button>
    </div>
    <p class="cc-hint">Overlay renders each word rising + fading in (his AE look) as a transparent clip on V2. Render takes minutes for long reels.</p>
    <div class="cc-strip" id="cc-strip">${S.previewMp4
      ? `<video class="cc-video" src="${S.previewMp4}" controls autoplay muted loop playsinline></video>`
      : (S.previewFrames || []).map(f => `<figure><img src="${f.png}" alt="t=${f.t}s" /><figcaption>${f.t}s</figcaption></figure>`).join('')}</div>
    <div class="cc-cues">${S.cues.map(c => `<div class="cc-cue"><span class="cc-time">${_fmtT(c.start)} → ${_fmtT(c.end)}</span><span class="cc-text">${_esc(c.text)}</span></div>`).join('')}</div>`;
  body.querySelector('#cc-src').onchange = (e) => { S.sourceMode = e.target.value; S.cues = []; _render(); };
  body.querySelector('#cc-name').onchange = (e) => { S.fileName = e.target.value.trim() || 'captions'; };
  body.querySelector('[data-act="build"]').onclick = _buildCues;
  body.querySelector('[data-act="preview"]').onclick = _preview;
  body.querySelector('[data-act="import"]').onclick = _exportImport;
  body.querySelector('[data-act="overlay"]').onclick = _buildOverlay;
}
async function _buildCues() {
  S.busy = true; _render(); _setStatus('Grouping words into cues…');
  try {
    let words = S.words.map(w => ({ text: w.text, start: w.start, end: w.end, keep: w.keep !== false, pill: !!w.pill }));
    if (S.allCaps) words = words.map(w => ({ ...w, text: w.text.toUpperCase() }));
    const resp = await apiPost('/api/captions/cues', { words, source: S.sourceMode, opts: S.opts }, { timeoutMs: 30000 });
    S.cues = resp.cues || [];
    _setStatus(`${S.cues.length} cues from ${resp.summary?.words ?? words.length} words.`);
  } catch (e) {
    _setStatus('Cue build failed: ' + String((e && e.message) || e).slice(0, 200));
  } finally {
    S.busy = false; _render();
  }
}
async function _exportImport() {
  if (!S.cues.length) return;
  if (!isExtendScriptAvailable()) { _setStatus('ExtendScript unavailable — open the panel inside Premiere Pro.'); return; }
  S.busy = true; _render(); _setStatus('Exporting SRT + importing…');
  try {
    const srt = await apiPost('/api/captions/srt', { cues: S.cues, name: S.fileName }, { timeoutMs: 30000 });
    if (!srt.srt_path) throw new Error('backend did not return an srt_path');
    S.srtPath = srt.srt_path;
    const res = await importCaptionsFromSRT(srt.srt_path);
    _setStatus(res && res.method === 'createCaptionTrack'
      ? `On the timeline (“${res.itemName || 'SRT'}”, ${S.cues.length} cues). Edit in Premiere's Text panel.`
      : `In the project bin (“${(res && res.itemName) || 'SRT'}”) — ${(res && res.warning) || 'drag it to the timeline manually.'}`);
  } catch (e) {
    _setStatus('Export/import failed: ' + String((e && e.message) || e).slice(0, 200));
  } finally {
    S.busy = false; _render();
  }
}

function _stylePayload() {
  return {
    all_caps: S.allCaps, preset: S.preset, font_size: S.fontSize,
    font_family: S.fontCustom || S.fontFamily, font_bold: S.fontBold,
    text_color: S.textColor, stroke_color: S.strokeColor,
    stroke_width: S.strokeWidth, shadow_enabled: S.shadowOn,
    shadow_color: S.shadowColor, shadow_opacity: S.shadowOpacity / 100,
    shadow_distance: S.shadowDistance, shadow_blur: S.shadowBlur,
    pos_y_ratio: S.posY / 100, pos_x_ratio: S.posX / 100,
    box_width_ratio: S.boxW / 100, pill_color: S.pillColor,
    pill_opacity: S.pillOpacity / 100, pill_outline: S.pillOutline,
    pill_stroke_color: S.pillStrokeColor, pill_stroke_width: S.pillStrokeWidth,
    pill_radius: S.pillRadius,
    animate_preset: S.animPreset, easing: S.wordEasing,
    intensity: S.animIntensity, slide_px: S.slideDist,
    rise_ms: Math.round(S.fadeDur * 1000),
    width: S.seqW, height: S.seqH,
  };
}
async function _preview() {
  if (!S.cues.length) return;
  S.busy = true; _render(); _setStatus('Rendering 6s preview…');
  try {
    const resp = await apiPost('/api/captions/preview',
      { cues: S.cues, name: S.fileName, ..._stylePayload() }, { timeoutMs: 300000 });
    S.previewFrames = resp.frames || [];
    S.previewMp4 = resp.preview_mp4 ? getBaseUrl() + resp.preview_mp4 : '';
    _setStatus(S.previewMp4
      ? `Preview: first ${resp.seconds}s rendered — watch it above, then build full.`
      : (S.previewFrames.length ? 'Preview frames below.' : 'Preview rendered no frames — check cue times.'));
  } catch (e) {
    _setStatus('Preview failed: ' + String((e && e.message) || e).slice(0, 200));
  } finally {
    S.busy = false; _render();
  }
}
async function _buildOverlay() {
  if (!S.cues.length) return;
  if (!isExtendScriptAvailable()) { _setStatus('ExtendScript unavailable — open the panel inside Premiere Pro.'); return; }
  S.busy = true; _render(); _setStatus('Rendering overlay (minutes for long reels)…');
  try {
    const ov = await apiPost('/api/captions/overlay', {
      cues: S.cues, name: S.fileName, ..._stylePayload(),
    }, { timeoutMs: 600000 });
    if (!ov.mov_path) throw new Error('backend did not return a mov_path');
    _setStatus(`Rendered (${ov.words} words) — placing on V2…`);
    const res = await callExtendScript('processEDL', { ops: [
      { action: 'import_file', mediaPath: ov.mov_path },
      { action: 'add', mediaPath: ov.mov_path, trackIndex: 1, startTime: 0 },
    ] });
    const failed = res && res.results
      ? res.results.filter(r => !r.success).map(r => `${r.action}: ${r.error || '?'}`).join('; ')
      : '';
    _setStatus(failed ? `Overlay ready but timeline insert had issues: ${failed}` : 'Animated overlay on V2 — scrub the timeline.');
  } catch (e) {
    // Show the TAIL of the error: the head is filter-graph noise, the
    // reason ("Error opening output file …", "No such filter …") is last.
    const msg = String((e && e.message) || e);
    _setStatus('Overlay failed: ' + (msg.length > 220 ? '…' + msg.slice(-219) : msg));
  } finally {
    S.busy = false; _render();
  }
}

// ── Helpers ──────────────────────────────────────────────────
function _fmtT(s) {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60), sec = (s % 60).toFixed(1).padStart(4, '0');
  return `${String(m).padStart(2, '0')}:${sec}`;
}
function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export { openCaptions, closeCaptions };
