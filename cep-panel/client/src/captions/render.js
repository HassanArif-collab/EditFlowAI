/**
 * captions/render.js — draws one caption frame onto a 2D canvas.
 *
 * The live preview and the exporter both call drawFrame(), so what the
 * panel shows is pixel-for-pixel what lands on the timeline (scaled).
 * Geometry is in OUTPUT pixels; opts.scale maps it onto the target canvas.
 *
 * Chromium-88 safe (CEP 11): no ctx.roundRect, no ctx.letterSpacing.
 */
import { activeCaptions, wordState, highlightBox, highlightMode, exitFactor,
         WORD_LEVEL, clamp01 } from './model.js';

export const STYLE_DEFAULTS = {
  fontFamily: 'Montserrat',
  fontWeight: 800,
  fontSize: 80,             // px at the sequence's resolution
  textCase: 'as_is',        // as_is | upper | lower
  punctuation: 'no_dots',   // no_dots | keep | soft | none | custom
  punctCommas: true,
  punctDots: false,
  punctExpressive: true,
  color: '#ffffff',
  activeColor: '#ffd84d',   // active-word highlight
  emphasis: 'color',        // color | pill | both — words you mark as emphasised
  emphasisColor: '#ffd84d',
  pillColor: '#0a1a2e',
  pillOpacity: 0.85,
  strokeWidth: 0,           // outline thickness (px)
  strokeColor: '#000000',
  shadow: true,
  shadowColor: '#000000',
  shadowOpacity: 0.6,
  shadowBlur: 14,
  shadowDistance: 4,
  background: 'none',       // none | box (per line) | block (whole caption) | pills (every word)
  bgColor: '#000000',
  bgOpacity: 0.6,
  bgRadius: 0.35,           // 0 square … 1 full pill
  bgPad: 0.22,              // em
  hlBoxColor: '#6d4aff',    // highlight: box
};

export function fontString(style, size) {
  const fam = String(style.fontFamily || 'Montserrat').replace(/"/g, '');
  return `${style.fontWeight || 700} ${size || style.fontSize || 80}px "${fam}", "Arial Black", Arial, sans-serif`;
}

/* ── colour helpers ── */

function hexRgb(hex) {
  let h = String(hex || '#ffffff').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt((h + '000000').slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgba(hex, a) {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${a == null ? 1 : Math.max(0, Math.min(1, a))})`;
}
function mixHex(a, b, k) {
  const x = hexRgb(a), y = hexRgb(b);
  const c = x.map((v, i) => Math.round(v + (y[i] - v) * clamp01(k)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/* ── shapes ── */

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function fillRound(ctx, x, y, w, h, radiusK, color, alpha) {
  if (alpha <= 0.002 || w <= 0 || h <= 0) return;
  ctx.save();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = rgba(color, alpha);
  roundRectPath(ctx, x, y, w, h, (h / 2) * radiusK);
  ctx.fill();
  ctx.restore();
}

/* ── text ── */

function drawText(ctx, text, x, y, color, st, devScale) {
  const stroke = st.strokeWidth > 0;
  if (st.shadow && st.shadowOpacity > 0) {
    // Canvas shadows ignore the transform — scale them by hand so the
    // preview's shadow matches the full-resolution render.
    ctx.shadowColor = rgba(st.shadowColor, st.shadowOpacity);
    ctx.shadowBlur = Math.max(0, st.shadowBlur * devScale);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = st.shadowDistance * devScale;
  }
  if (stroke) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = st.strokeWidth * 2;      // half is hidden under the fill
    ctx.strokeStyle = st.strokeColor;
    ctx.strokeText(text, x, y);
    ctx.shadowColor = 'transparent';         // one shadow, under the outline
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.shadowColor = 'transparent';
}

/**
 * Draw the captions visible at time t.
 *   opts.scale   output px → canvas px (preview < 1, export 1)
 *   opts.offsetY output y drawn at the canvas top (export renders a band)
 *   opts.clear   clear the canvas first (default true)
 */
export function drawFrame(ctx, scene, settings, t, opts) {
  const o = opts || {};
  const sc = o.scale || 1;
  if (o.clear !== false) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }
  const caps = activeCaptions(scene, t);
  if (!caps.length) return 0;
  const st = Object.assign({}, STYLE_DEFAULTS, (settings && settings.style) || {});
  const motion = (settings && settings.motion) || {};
  ctx.save();
  ctx.setTransform(sc, 0, 0, sc, 0, -(o.offsetY || 0) * sc);
  ctx.font = fontString(st, scene.fontSize);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  for (const c of caps) drawCaption(ctx, c, scene, st, motion, t, sc);
  ctx.restore();
  return caps.length;
}

function drawCaption(ctx, c, scene, st, motion, t, sc) {
  const fs = scene.fontSize;
  const mode = highlightMode(motion);
  const asc = c.ascent, desc = c.descent;
  const pad = (st.bgPad != null ? st.bgPad : 0.22) * fs;
  const padY = pad * 0.75;
  ctx.save();
  if (c.fit < 1) { ctx.translate(c.cx, c.cy); ctx.scale(c.fit, c.fit); ctx.translate(-c.cx, -c.cy); }
  const devScale = sc * c.fit;

  // How visible are the caption's backgrounds: word presets show the box
  // with the first word; caption presets fade it with the text.
  const first = c.lines[0].words[0];
  const bgK = WORD_LEVEL[motion.preset || 'fade_up']
    ? clamp01((t - c.tIn) / 0.12) * exitFactor(c, t)
    : wordState(t, first, c, motion, fs).alpha;

  if (st.background === 'box' || st.background === 'block') {
    const boxes = c.lines.map((l) => ({ x: l.x - pad, y: l.y - asc - padY, w: l.width + 2 * pad, h: asc + desc + 2 * padY }));
    if (st.background === 'block' && boxes.length) {
      const x0 = Math.min.apply(null, boxes.map((b) => b.x)), y0 = boxes[0].y;
      const x1 = Math.max.apply(null, boxes.map((b) => b.x + b.w));
      const y1 = boxes[boxes.length - 1].y + boxes[boxes.length - 1].h;
      fillRound(ctx, x0, y0, x1 - x0, y1 - y0, Math.min(st.bgRadius, 0.6), st.bgColor, st.bgOpacity * bgK);
    } else {
      for (const b of boxes) fillRound(ctx, b.x, b.y, b.w, b.h, st.bgRadius, st.bgColor, st.bgOpacity * bgK);
    }
  }

  if (mode === 'box') {
    const hb = highlightBox(t, c, motion.duration);
    if (hb) {
      const p = pad * 0.6;
      fillRound(ctx, hb.x - p, hb.y - asc - padY, hb.w + 2 * p, asc + desc + 2 * padY,
        Math.max(0.35, st.bgRadius), st.hlBoxColor, hb.k * exitFactor(c, t));
    }
  }

  for (const l of c.lines) {
    for (const w of l.words) {
      const s = wordState(t, w, c, motion, fs);
      let alpha = s.alpha;
      if (alpha <= 0.003) continue;
      let text = w.text;
      if (s.chars >= 0) text = text.slice(0, s.chars);
      if (!text) continue;

      let color = st.color;
      const emph = w.emphasis;
      if (emph && (st.emphasis === 'color' || st.emphasis === 'both')) color = st.emphasisColor;
      if (s.hi > 0 && mode === 'color') color = mixHex(color, st.activeColor, s.hi);
      if (motion.spokenDim && !s.spoken) alpha *= 0.4;

      const pill = st.background === 'pills' || (emph && (st.emphasis === 'pill' || st.emphasis === 'both'));
      if (pill) {
        const pk = emph && st.background !== 'pills' ? st.pillOpacity : st.bgOpacity;
        const pc = emph && st.background !== 'pills' ? st.pillColor : st.bgColor;
        const pw = s.chars >= 0 ? w.w : w.w;
        fillRound(ctx, w.x - pad * 0.7 + s.dx, l.y - asc - padY + s.dy, pw + pad * 1.4, asc + desc + 2 * padY,
          Math.max(0.5, st.bgRadius), pc, pk * alpha);
      }

      const scale = s.scale * (mode === 'scale' ? 1 + 0.12 * s.hi : 1);
      const ox = w.x + w.w / 2 + s.dx;
      const oy = l.y - asc / 2 + s.dy;          // scale about the word's visual centre
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(ox, oy);
      if (scale !== 1) ctx.scale(scale, scale);
      drawText(ctx, text, -w.w / 2, asc / 2, color, st, devScale * scale);
      ctx.restore();
    }
  }
  ctx.restore();
}

/**
 * Vertical band [y, y+h) of the output frame that captions can touch
 * (text + motion travel + outline + shadow + backgrounds), so the exporter
 * reads back only those rows instead of the whole frame.
 */
export function captionBand(scene, settings) {
  const st = Object.assign({}, STYLE_DEFAULTS, (settings && settings.style) || {});
  const m = (settings && settings.motion) || {};
  const fs = scene.fontSize;
  let top = Infinity, bot = -Infinity;
  for (const c of scene.captions) {
    const scaleK = c.fit;
    const y0 = c.cy + (c.box.y - c.cy) * scaleK;
    const y1 = c.cy + (c.box.y + c.box.h - c.cy) * scaleK;
    if (y0 < top) top = y0;
    if (y1 > bot) bot = y1;
  }
  if (!isFinite(top)) return { y: 0, h: 2 };
  const travel = Math.max((m.distance || 0.35) * fs, m.preset === 'bounce' ? 1.0 * fs * (m.intensity || 1) : 0,
    m.preset === 'pop' || m.highlight === 'scale' ? 0.5 * fs : 0);
  const fx = st.strokeWidth + (st.shadow ? st.shadowBlur * 1.5 + st.shadowDistance : 0) + (st.bgPad || 0.22) * fs + 8;
  let y = Math.floor(top - travel - fx), h = Math.ceil(bot + travel + fx) - y;
  y = Math.max(0, y);
  h = Math.min(scene.height - y, h);
  // even rows: ProRes 4:4:4 is fine with odd sizes, but keep the pad simple
  if (y % 2) { y -= 1; h += 1; }
  if (h % 2) h = Math.min(scene.height - y, h + 1);
  return { y, h: Math.max(2, h) };
}
