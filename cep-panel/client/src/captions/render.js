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
  textCase: 'as_is',        // as_is | upper | title | lower
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
  bgPadY: 0.165,            // em (vertical padding)
  hlBoxColor: '#6d4aff',    // highlight: box
  gradient: false,          // 2-color vertical linear gradient fill
  gradientColor: '#ffea00', // bottom color for gradient
  activeGlow: false,        // neon bloom glow on active word
  activeGlowColor: '#00f0ff',
  activeGlowBlur: 16,
  speakerColoring: false,   // multi-speaker coloring
  speakerColors: ['#ffffff', '#00f0ff', '#ffd84d', '#ff6b6b'],
  emojiEnabled: false,      // keyword emojis (default: off)
  emojiPlacement: 'above',  // above | inline
  emojiScale: 1.0,          // relative emoji size
};

export function fontString(style, size) {
  const fam = String(style.fontFamily || 'Montserrat').replace(/"/g, '');
  const fallbacks = /urdu|nastaliq|arabic/i.test(fam)
    ? '"Noto Nastaliq Urdu", "Urdu Typesetting", "Jameel Noori Nastaliq", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", Arial, sans-serif'
    : '"Arial Black", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", Arial, sans-serif';
  return `${style.fontWeight || 700} ${size || style.fontSize || 80}px "${fam}", ${fallbacks}`;
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

function drawText(ctx, text, x, y, color, st, devScale, asc, desc) {
  const safeColor = (typeof color === 'string' && color.trim()) ? color.trim() : '#ffffff';
  const stroke = (Number(st.strokeWidth) || 0) > 0;
  if (st.shadow && (Number(st.shadowOpacity) || 0) > 0) {
    try {
      ctx.shadowColor = rgba(st.shadowColor || '#000000', st.shadowOpacity);
      ctx.shadowBlur = Math.max(0, Number(st.shadowBlur) || 0);
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = Number(st.shadowDistance) || 0;
    } catch (_) {}
  }
  if (stroke) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = (Number(st.strokeWidth) || 0) * 2;      // half is hidden under the fill
    ctx.strokeStyle = st.strokeColor || '#000000';
    try { ctx.strokeText(text, x, y); } catch (_) {}
    ctx.shadowColor = 'transparent';         // one shadow, under the outline
  }
  let fillApplied = false;
  if (st.gradient && st.gradientColor && typeof ctx.createLinearGradient === 'function') {
    try {
      const a = Number(asc) || 60;
      const d = Number(desc) || 20;
      const y0 = isFinite(y - a) ? (y - a) : (y - 60);
      const y1 = isFinite(y + d) ? (y + d) : (y + 20);
      const grad = ctx.createLinearGradient(0, y0, 0, y1);
      grad.addColorStop(0, safeColor);
      const gradBottom = (typeof st.gradientColor === 'string' && st.gradientColor.trim()) ? st.gradientColor.trim() : '#ffea00';
      grad.addColorStop(1, gradBottom);
      ctx.fillStyle = grad;
      fillApplied = true;
    } catch (_) {
      fillApplied = false;
    }
  }
  if (!fillApplied) {
    ctx.fillStyle = safeColor;
  }
  try {
    ctx.fillText(text, x, y);
  } catch (_) {}
  ctx.shadowColor = 'transparent';
}

/**
 * Draw the captions visible at time t.
 *   opts.scale   output px → canvas px (preview < 1, export 1)
 *   opts.offsetY output y drawn at the canvas top (export renders a band)
 *   opts.clear   clear the canvas first (default true)
 */
export function drawFrame(ctx, scene, settings, t, opts) {
  if (!ctx || !scene) return 0;
  const o = opts || {};
  const sc = o.scale || 1;
  if (o.clear !== false) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }
  const caps = activeCaptions(scene, t);
  if (!caps.length) return 0;
  try {
    const st = Object.assign({}, STYLE_DEFAULTS, (settings && settings.style) || {});
    const motion = (settings && settings.motion) || {};
    const lay = (settings && settings.layout) || {};
    ctx.save();
    ctx.setTransform(sc, 0, 0, sc, 0, -(o.offsetY || 0) * sc);
    ctx.font = fontString(st, scene.fontSize);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    for (const c of caps) {
      try {
        drawCaption(ctx, c, scene, st, motion, lay, t, sc);
      } catch (capErr) {
        console.warn('[Captions] drawCaption render error:', capErr);
      }
    }
    ctx.restore();
    return caps.length;
  } catch (err) {
    console.error('[Captions] drawFrame top-level error:', err);
    try { ctx.restore(); } catch (_) {}
    return 0;
  }
}

function drawCaption(ctx, c, scene, st, motion, lay, t, sc) {
  const fs = scene.fontSize;
  const mode = highlightMode(motion);
  const asc = c.ascent, desc = c.descent;
  const pad = (st.bgPad != null ? st.bgPad : 0.22) * fs;
  const padY = st.bgPadY != null ? st.bgPadY * fs : pad * 0.75;
  ctx.save();
  if (lay && lay.rotation) {
    ctx.translate(c.cx, c.cy);
    ctx.rotate((lay.rotation * Math.PI) / 180);
    ctx.translate(-c.cx, -c.cy);
  }
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
      if (st.speakerColoring && Array.isArray(st.speakerColors) && st.speakerColors.length > 0) {
        const spkIdx = (w.speaker != null && isFinite(w.speaker)) ? Math.max(0, Math.floor(w.speaker)) : 0;
        color = st.speakerColors[spkIdx % st.speakerColors.length] || st.color;
      }
      const emph = w.emphasis;
      if (emph && (st.emphasis === 'color' || st.emphasis === 'both')) color = st.emphasisColor;
      if (s.hi > 0 && mode === 'color') color = mixHex(color, st.activeColor, s.hi);
      if (motion.spokenDim) alpha *= (0.4 + 0.6 * s.spoken);

      const pill = st.background === 'pills' || (emph && (st.emphasis === 'pill' || st.emphasis === 'both'));
      if (pill) {
        const pk = emph && st.background !== 'pills' ? st.pillOpacity : st.bgOpacity;
        const pc = emph && st.background !== 'pills' ? st.pillColor : st.bgColor;
        const pw = s.chars >= 0 ? (w.w * Math.min(1, s.chars / Math.max(1, w.text.length))) : w.w;
        const pillPadX = Math.min(pad * 0.7, 12);
        fillRound(ctx, w.x - pillPadX + s.dx, l.y - asc - padY + s.dy, pw + 2 * pillPadX, asc + desc + 2 * padY,
          Math.max(0.5, st.bgRadius), pc, pk * alpha);
      }

      const scale = s.scale * (mode === 'scale' ? 1 + 0.12 * s.hi : 1);
      const cy = l.y - (asc - desc) / 2 + s.dy;          // scale about the word's true visual centre
      const ox = w.x + w.w / 2 + s.dx;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(ox, cy);
      if (scale !== 1) ctx.scale(scale, scale);
      if (st.activeGlow && s.hi > 0) {
        ctx.save();
        ctx.shadowColor = st.activeGlowColor || '#00f0ff';
        ctx.shadowBlur = (st.activeGlowBlur || 16) * s.hi;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.fillStyle = st.activeGlowColor || '#00f0ff';
        ctx.fillText(text, -w.w / 2, (asc - desc) / 2);
        ctx.restore();
      }
      if (w.emoji && (st.emojiPlacement || 'above') === 'above') {
        ctx.save();
        const emojiSize = Math.max(16, Math.round(fs * (st.emojiScale || 1.0) * 0.72));
        ctx.font = `${emojiSize}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Segoe UI Symbol", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.shadowColor = 'transparent';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(w.emoji, 0, -(asc + desc) / 2 - 4);
        ctx.restore();
      }
      drawText(ctx, text, -w.w / 2, (asc - desc) / 2, color, st, devScale * scale, asc, desc);
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
  const lay = (settings && settings.layout) || {};
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
  const rot = lay.rotation || 0;
  const rotPad = rot ? Math.abs(Math.sin((rot * Math.PI) / 180)) * (scene.width * 0.45) : 0;
  const emojiPad = ((st.emojiPlacement || 'above') === 'above') ? (fs * 0.85 * (st.emojiScale || 1.0)) : 0;
  const fx = st.strokeWidth + (st.shadow ? st.shadowBlur * 1.5 + st.shadowDistance : 0) + (st.activeGlow ? (st.activeGlowBlur || 16) * 1.5 : 0) + (st.bgPad || 0.22) * fs + 16;
  let y = Math.floor(top - travel - fx - rotPad - emojiPad), h = Math.ceil(bot + travel + fx + rotPad) - y;
  y = Math.max(0, y);
  h = Math.min(scene.height - y, h);
  // even rows: ProRes 4:4:4 is fine with odd sizes, but keep the pad simple
  if (y % 2) { y -= 1; h += 1; }
  if (h % 2) h = Math.min(scene.height - y, h + 1);
  return { y, h: Math.max(2, h) };
}
