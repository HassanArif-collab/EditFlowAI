/**
 * captions/model.js — the caption engine's single source of truth.
 *
 * Pure functions only: no DOM, no canvas, no Premiere. The live preview,
 * the frame exporter and the Node tests all run THIS code, so the preview
 * cannot drift from what lands on the timeline (the old overlay path had
 * three separate implementations that disagreed).
 *
 * Pipeline:  words → sanitizeWords → groupWords (+wrapLines) →
 *            captionTiming → buildScene → wordState()/frameKey() per frame
 *
 * Grouping and timing rules come from the EditFlow AE engine (hold until
 * the next caption, minimum on-screen time, capped hold through silence)
 * plus the fixes found in the Premiere audit: two-line captions are shown
 * together (never as sequential flashes), breaks avoid dangling "the/to/
 * and", single-word orphans are avoided, and captions hand off with a
 * crossfade so there is never a blank or popping frame.
 */

export const TICKS_PER_SECOND = 254016000000;

/* ── Frame rates ─────────────────────────────────────────────────────── */

// Premiere reports frame duration in ticks; NTSC rates must stay exact
// rationals (29.97 = 30000/1001) or frames drift against the sequence.
const KNOWN_RATES = [
  [24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1], [48000, 1001],
  [48, 1], [50, 1], [60000, 1001], [60, 1], [100, 1], [120000, 1001], [120, 1],
];

/** {num, den} from a frames-per-second number (29.97 → 30000/1001). */
export function fpsFromNumber(fps) {
  const f = Number(fps);
  if (!(f > 0)) return { num: 30, den: 1 };
  for (const [num, den] of KNOWN_RATES) {
    if (Math.abs(num / den - f) < 0.002) return { num, den };
  }
  return { num: Math.round(f * 1000), den: 1000 };
}

/** {num, den} from Premiere's ticks-per-frame (sequence.timebase). */
export function fpsFromTicks(ticksPerFrame) {
  const t = Number(ticksPerFrame);
  if (!(t > 0)) return { num: 30, den: 1 };
  return fpsFromNumber(TICKS_PER_SECOND / t);
}

export function fpsValue(fps) { return fps.num / fps.den; }
/** Time (s) of frame k. */
export function frameTime(k, fps) { return (k * fps.den) / fps.num; }
/** Frames needed to cover `seconds`. */
export function frameCount(seconds, fps) {
  return Math.max(0, Math.ceil((seconds * fps.num) / fps.den - 1e-9));
}

/* ── Easing ──────────────────────────────────────────────────────────── */

export const EASINGS = {
  linear: (p) => p,
  ease_out: (p) => 1 - Math.pow(1 - p, 3),
  ease_in_out: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  expo_out: (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
  back_out: (p) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
  },
};

export function clamp01(p) { return p < 0 ? 0 : p > 1 ? 1 : p; }
function ease(name, p) { return (EASINGS[name] || EASINGS.ease_out)(clamp01(p)); }
function mix(a, b, k) { return a + (b - a) * k; }

export function fmtTime(s) {
  if (!isFinite(s) || s < 0) return '0:00.0';
  const tenths = Math.round(s * 10);
  const m = Math.floor(tenths / 600);
  const remSec = Math.floor((tenths % 600) / 10);
  const remTenths = tenths % 10;
  return m + ':' + (remSec < 10 ? '0' : '') + remSec + '.' + remTenths;
}

const MIN_WORD = 0.04;   // shortest word we keep on the clock (s)

/**
 * Clean a raw word list into the model's shape. Accepts {word|text, start,
 * end} from any source (Whisper, WhisperX, Scribe, pasted JSON) and keeps
 * editor flags (hidden, emphasis, breakBefore). Sorted, trimmed, empty
 * words dropped, every duration positive, no word overlapping the next.
 */
export function sanitizeWords(raw) {
  const out = [];
  (raw || []).forEach((w, i) => {
    if (!w) return;
    const text = String(w.text != null ? w.text : (w.word != null ? w.word : ''))
      .replace(/\s+/g, ' ').trim();
    if (!text) return;
    let start = Number(w.start), end = Number(w.end);
    if (!isFinite(start)) start = 0;
    if (!isFinite(end)) end = start;
    out.push({
      id: w.id != null ? w.id : i,
      text,
      start: Math.max(0, start),
      end: Math.max(0, end),
      // tri-state: true = hidden, false = forced visible, undefined = auto
      hidden: (w.hidden === true || w.keep === false) ? true : (w.hidden === false ? false : undefined),
      emphasis: !!(w.emphasis || w.pill),
      breakBefore: !!w.breakBefore,
    });
  });
  out.sort((a, b) => a.start - b.start);
  for (let i = 0; i < out.length; i++) {
    const w = out[i], next = out[i + 1];
    if (next) {
      if (next.start < w.start) next.start = w.start;
      if (w.end > next.start) w.end = Math.max(w.start + MIN_WORD, next.start);
    }
    if (w.end - w.start < MIN_WORD) {
      w.end = w.start + MIN_WORD;
      if (next && next.start < w.end) next.start = w.end;
    }
  }
  return out;
}

/* ── Text helpers ────────────────────────────────────────────────────── */

const SENTENCE_END = /[.?!؟۔।…]["')\]]*$/;
const SOFT_BREAK = /[,;:—–-]["')\]]*$/;
// Words that read wrong at the END of a caption ("Today I | want to").
const WEAK = new Set(('a an the to of in on at by for with from into onto as and or but nor so ' +
  'if than that my your his her its our their this these those i we you he she they ' +
  'is am are was were be been very just really about over under after before through ' +
  'between without within around across against toward towards like because while ' +
  'when where how what why which who whose some any every each no not').split(' '));

// Words that open a noun phrase: "a fascinating | topic" splits the phrase.
const DETERMINERS = new Set('a an the my your his her its our their this these those some any every each no'.split(' '));
const FILLER = /^(u+h+m*|u+m+|e+r+m*|a+h+|h+m+|m+h*m+)$/;

export function endsSentence(text) { return SENTENCE_END.test(String(text || '')); }
function bare(text) { return String(text || '').toLowerCase().replace(/[^a-z0-9']/g, ''); }
export function isWeak(text) { return WEAK.has(bare(text)); }
export function isFiller(text) { return FILLER.test(bare(text)); }

/**
 * Is a word shown? hidden === true → never; hidden === false → always (the
 * user un-hid it); otherwise shown unless it's a filler and fillers are off.
 */
export function isVisible(w, hideFillers) {
  if (w.hidden === true) return false;
  if (w.hidden === false) return true;
  return !(hideFillers && isFiller(w.text));
}

/**
 * What the viewer sees for a word. punctuation: 'keep' | 'soft' (drop
 * trailing , . ; : — the clean social-caption look; keep ? !) | 'none'.
 * textCase: 'as_is' | 'upper' | 'lower'.
 */
export function displayText(text, opts) {
  let t = String(text || '');
  const p = (opts && opts.punctuation) || 'keep';

  let keepCommas = true;
  let keepDots = true;
  let keepExpressive = true;

  if (p === 'no_dots') {
    keepCommas = true;
    keepDots = false;
    keepExpressive = true;
  } else if (p === 'soft') {
    keepCommas = false;
    keepDots = false;
    keepExpressive = true;
  } else if (p === 'none') {
    keepCommas = false;
    keepDots = false;
    keepExpressive = false;
  } else if (p === 'custom') {
    keepCommas = opts && opts.punctCommas !== false;
    keepDots = !!(opts && opts.punctDots);
    keepExpressive = opts && opts.punctExpressive !== false;
  }

  // 1. Strip trailing sentence-ending dots if keepDots is false
  if (!keepDots) {
    t = t.replace(/(\.{1,}|…|۔+|।+|॥+)(["”’')\]»›]*)$/, '$2');
  }

  // 2. Strip trailing commas and inner pauses if keepCommas is false
  if (!keepCommas) {
    t = t.replace(/([,;:]+|،+|؛+)(["”’')\]»›]*)$/, '$2');
  }

  // 3. Strip trailing question & exclamation marks if keepExpressive is false
  if (!keepExpressive) {
    t = t.replace(/([?!]+|؟+|‽+)(["”’')\]»›]*)$/, '$2');
  }

  // 4. Strip decorative opening brackets / quotes in 'soft' mode
  if (p === 'soft') {
    t = t.replace(/^["“”«‹'‘(\[]+(?=[\p{L}\p{N}])/u, '');
  }

  // 5. In 'none' mode, strip all remaining non-word characters
  if (p === 'none') {
    t = t.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
  }

  const c = (opts && opts.textCase) || 'as_is';
  if (c === 'upper') t = t.toUpperCase();
  else if (c === 'lower') t = t.toLowerCase();
  if (p === 'none') return t;
  return t || String(text || '');
}

/* ── Line wrapping ───────────────────────────────────────────────────── */

/**
 * Split word widths into ≤ maxLines lines that fit maxWidth. One line if it
 * fits; otherwise the BALANCED split (two even lines read better than a
 * long line over a stub), avoiding a line that ends on a weak word.
 * Returns [[startIdx, endIdx], ...] or null when it cannot fit.
 */
export function wrapLines(widths, spaceW, maxWidth, maxLines, texts) {
  const n = widths.length;
  if (!n) return [];
  const span = (a, b) => {
    let w = 0;
    for (let i = a; i <= b; i++) w += widths[i];
    return w + spaceW * (b - a);
  };
  if (span(0, n - 1) <= maxWidth || n === 1) return [[0, n - 1]];
  if (maxLines < 2) return null;
  if (maxLines === 2 || n === 2) {
    let best = null, bestScore = Infinity;
    for (let b = 0; b < n - 1; b++) {
      const w1 = span(0, b), w2 = span(b + 1, n - 1);
      if (w1 > maxWidth || w2 > maxWidth) continue;
      let score = Math.abs(w1 - w2) + (w1 > w2 ? 0.05 * maxWidth : 0);
      if (texts && isWeak(texts[b])) score += 0.6 * maxWidth;
      if (score < bestScore) { bestScore = score; best = [[0, b], [b + 1, n - 1]]; }
    }
    if (best || maxLines === 2) return best;
  }
  // 3 lines: greedy fill (rarely used; keeps the code simple)
  const lines = [];
  let a = 0;
  while (a < n) {
    let b = a;
    while (b + 1 < n && span(a, b + 1) <= maxWidth) b++;
    lines.push([a, b]);
    a = b + 1;
    if (lines.length > maxLines) return null;
  }
  return lines;
}

/* ── Grouping ────────────────────────────────────────────────────────── */

export const GROUP_DEFAULTS = {
  maxWords: 4,          // words per caption
  maxLines: 2,          // lines per caption
  maxDuration: 3.0,     // seconds a caption may span
  splitGap: 0.45,       // a pause longer than this always splits
  breakOnSentence: true,
  hideFillers: true,    // drop "uh", "um", "erm" unless un-hidden by hand
};

/**
 * Group visible words into captions with a small dynamic program: among
 * every split that respects the hard limits (word count, box width × lines,
 * duration, pauses, sentence ends, manual breaks), pick the one with the
 * lowest "reads badly" cost — breaks mid-phrase, captions ending on weak
 * words, lonely single words. Greedy filling (the old engine) can't look
 * ahead, which is what produced captions like "Today I | want to".
 *
 * words: sanitized, hidden already removed. layout: { measure(text)→px,
 * spaceW, maxWidth } in output pixels; omit for char-count mode.
 * Returns [{ words, lines: [[a,b],...], start, end }].
 */
export function groupWords(words, opts, layout) {
  const o = Object.assign({}, GROUP_DEFAULTS, opts || {});
  const n = words.length;
  if (!n) return [];
  const maxWords = Math.max(1, o.maxWords | 0);
  const maxLines = Math.max(1, Math.min(3, o.maxLines | 0));
  const charMode = !(layout && typeof layout.measure === 'function' && layout.maxWidth > 0);
  const widths = words.map((w) => (charMode ? w.display.length : layout.measure(w.display)));
  const spaceW = charMode ? 1 : (layout.spaceW || 0);
  const maxWidth = charMode ? (o.maxChars || 24) : layout.maxWidth;
  const texts = words.map((w) => w.text);

  const gapBefore = (i) => (i > 0 ? words[i].start - words[i - 1].end : Infinity);
  const gapAfter = (i) => (i < n - 1 ? words[i + 1].start - words[i].end : Infinity);

  // Cost of ending a caption after word i (j = the caption's first word).
  const endCost = (i, j) => {
    if (i === n - 1) return 0;
    const t = words[i].text;
    if (endsSentence(t)) return 0;
    if (words[i + 1].breakBefore) return 0;
    if (SOFT_BREAK.test(t)) return 0.2;
    if (gapAfter(i) >= 0.25) return 0.3;
    // Worth an extra (even brief) caption to avoid: an extra caption costs
    // ~2, a brief one up to ~3 more.
    if (isWeak(t)) return 4.5;
    if (DETERMINERS.has(bare(t))) return 5.0;
    // "…a fascinating | topic": determiner + adjective with the noun pushed to next caption
    if (i > j && i + 1 < n && DETERMINERS.has(bare(words[i - 1].text)) && !isWeak(words[i + 1].text)) return 5.0;
    return 1.0;
  };

  const best = new Array(n + 1).fill(Infinity);
  const from = new Array(n + 1).fill(-1);
  const lineSplit = new Array(n + 1).fill(null);
  best[0] = 0;
  for (let i = 1; i <= n; i++) {          // caption ends at word i-1
    const last = i - 1;
    for (let j = last; j >= Math.max(0, i - maxWords); j--) {   // starts at j
      if (j < last) {
        // hard limits that only get worse as j moves left → break the loop
        if (words[j + 1].breakBefore) break;
        if (gapBefore(j + 1) > o.splitGap) break;
        if (o.breakOnSentence && endsSentence(words[j].text)) break;
        if (words[last].end - words[j].start > o.maxDuration) break;
      }
      const lines = wrapLines(widths.slice(j, i), spaceW, maxWidth, maxLines, texts.slice(j, i));
      if (!lines) break;                    // wider groups only get wider
      const size = i - j;
      let cost = 1 + endCost(last, j);
      if (size === 1 && maxWords > 1) {
        // a lone word mid-sentence flashes by — the choppiest look there is
        const w = words[j];
        const isolated = gapBefore(j) > 0.35 && gapAfter(last) > 0.35;
        const lingers = w.end - w.start >= 0.6;
        cost += (isolated || lingers || endsSentence(w.text)) ? 0.4 : 2.6;
      } else {
        cost += 0.15 * (maxWords - size);
      }
      if (lines.length > 1) {                // prefer one line when it reads as well
        cost += 0.25 * (lines.length - 1);
      }
      // on screen until the next caption starts: under ~0.7 s is a flash
      const shown = (i < n ? words[i].start : words[last].end + 0.6) - words[j].start;
      if (shown < 0.7) cost += 3.0 * (1 - shown / 0.7);
      if (best[j] + cost < best[i]) {
        best[i] = best[j] + cost; from[i] = j; lineSplit[i] = lines;
      }
    }
    if (from[i] === -1) {                    // nothing fits (a giant word): alone
      best[i] = best[i - 1] + 5; from[i] = i - 1; lineSplit[i] = [[0, 0]];
    }
  }
  const groups = [];
  for (let i = n; i > 0; i = from[i]) {
    const ws = words.slice(from[i], i);
    groups.push({ words: ws, lines: lineSplit[i], start: ws[0].start, end: ws[ws.length - 1].end });
  }
  return groups.reverse();
}

/* ── Timing ──────────────────────────────────────────────────────────── */

export const TIMING_DEFAULTS = {
  offset: 0,          // shift every caption (s); + = later
  minDuration: 0.6,   // a caption stays at least this long
  maxHold: 0.8,       // after the last word, hold at most this long in silence
  tailHold: 0.6,      // the final caption's hold
  exit: 'fade',       // 'fade' | 'cut'
  exitDuration: 0.08, // crossfade length for 'fade' (~2 frames: no ghosting)
};

/**
 * In/out for each group. "Hold until next" (AE rule) so the screen never
 * blanks between captions, capped by maxHold so captions clear through real
 * silence. 'fade' exits crossfade into the next caption; 'cut' keeps the old
 * caption two frames into the next (its first word is still transparent then).
 * Returns [{ tIn, tOut, exitStart }].
 */
export function captionTiming(groups, opts, fps) {
  const o = Object.assign({}, TIMING_DEFAULTS, opts || {});
  const frame = fps ? fps.den / fps.num : 1 / 30;
  const exitDur = o.exit === 'fade' ? Math.max(0, o.exitDuration) : 0;
  const ins = groups.map((g) => Math.max(0, g.start + o.offset));
  return groups.map((g, i) => {
    const tIn = ins[i];
    const wordsEnd = g.end + o.offset;
    const visibleEnd = Math.max(wordsEnd, tIn + o.minDuration);
    let tOut, exitStart;
    if (i + 1 < groups.length) {
      const handoff = ins[i + 1];
      const held = visibleEnd + o.maxHold;
      if (handoff <= held) {                 // next caption takes over
        tOut = exitDur > 0 ? handoff + exitDur : handoff;
        exitStart = exitDur > 0 ? handoff : handoff;
      } else {                               // silence: clear on our own
        tOut = held;
        exitStart = tOut - exitDur;
      }
    } else {
      tOut = visibleEnd + o.tailHold;
      exitStart = tOut - exitDur;
    }
    if (tOut <= tIn) tOut = tIn + frame;
    if (exitStart < tIn) exitStart = tIn;
    return { tIn, tOut, exitStart };
  });
}

const RTL_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
export function isRTLText(text) {
  return RTL_REGEX.test(String(text || ''));
}

/**
 * Everything the renderer needs, in OUTPUT pixels:
 *   env: { width, height, fps, measure(text)→px for the caption font at
 *          style.fontSize, fontMetrics: {ascent, descent} }
 * Returns { width, height, fps, captions:[{ id, tIn, tOut, exitStart,
 *   lines:[{ y, width, words:[{ text, x, w, start, end, emphasis, gi }] }],
 *   box:{ x, y, w, h }, fit }], duration }.
 */
export function buildScene(rawWords, settings, env) {
  const s = settings || {};
  const st = s.style || {};
  const lay = s.layout || {};
  const hideFillers = !(s.grouping && s.grouping.hideFillers === false);
  const words = sanitizeWords(rawWords).filter((w) => isVisible(w, hideFillers));
  for (const w of words) w.display = displayText(w.text, st);
  const W = env.width, H = env.height;
  const fontSize = st.fontSize || 80;
  const measure = env.measure;
  const spaceW = measure ? measure(' ') : fontSize * 0.28;
  const maxWidth = W * ((lay.boxWidth || 86) / 100);
  const groups = groupWords(words, s.grouping, measure ? { measure, spaceW, maxWidth } : null);
  const timing = captionTiming(groups, s.timing, env.fps);
  const lineH = fontSize * (lay.lineHeight || 1.12);
  const asc = (env.fontMetrics && env.fontMetrics.ascent) || fontSize * 0.78;
  const desc = (env.fontMetrics && env.fontMetrics.descent) || fontSize * 0.22;
  const align = lay.align || 'center';
  const ax = W * ((lay.posX != null ? lay.posX : 50) / 100);
  const margin = H * 0.03;

  let gi = 0;
  const captions = groups.map((g, ci) => {
    const lines = g.lines.map(([a, b]) => {
      const ws = g.words.slice(a, b + 1);
      const ww = ws.map((w) => (measure ? measure(w.display) : w.display.length * fontSize * 0.55));
      const width = ww.reduce((x, y) => x + y, 0) + spaceW * (ws.length - 1);
      return { ws, ww, width };
    });
    const widest = Math.max.apply(null, lines.map((l) => l.width));
    const fit = widest > maxWidth ? maxWidth / widest : 1;   // only for a giant word
    const blockH = lines.length * lineH;
    // centre the block on posY, clamped inside the frame
    let cy = H * ((lay.posY != null ? lay.posY : 72) / 100);
    const half = (blockH * fit) / 2;
    cy = Math.min(H - margin - half, Math.max(margin + half, cy));
    const top = cy - blockH / 2;
    const outLines = lines.map((l, li) => {
      let x0 = align === 'left' ? ax - maxWidth / 2
        : align === 'right' ? ax + maxWidth / 2 - l.width : ax - l.width / 2;
      const baseline = top + li * lineH + (lineH - (asc + desc)) / 2 + asc;
      const isRtl = l.ws.some((w) => isRTLText(w.display || w.text));
      let x = isRtl ? (x0 + l.width) : x0;
      const lw = l.ws.map((w, k) => {
        const itemX = isRtl ? (x - l.ww[k]) : x;
        const item = { text: w.display, src: w.text, x: itemX, w: l.ww[k], start: w.start + ((s.timing && s.timing.offset) || 0),
                       end: w.end + ((s.timing && s.timing.offset) || 0), emphasis: w.emphasis, id: w.id, gi: gi++, rtl: isRtl };
        if (isRtl) x -= (l.ww[k] + spaceW);
        else x += (l.ww[k] + spaceW);
        return item;
      });
      return { y: baseline, x: x0, width: l.width, words: lw, rtl: isRtl };
    });
    const bx = Math.min.apply(null, outLines.map((l) => l.x));
    const bw = Math.max.apply(null, outLines.map((l) => l.x + l.width)) - bx;
    return Object.assign({ id: ci, lines: outLines, fit, cx: ax, cy,
      box: { x: bx, y: top, w: bw, h: blockH }, ascent: asc, descent: desc }, timing[ci]);
  });
  const duration = captions.length ? captions[captions.length - 1].tOut : 0;
  return linkWords({ width: W, height: H, fps: env.fps || { num: 30, den: 1 }, fontSize, lineH, captions, duration });
}

/** Captions on screen at time t (normally 0–2 during a crossfade). */
export function activeCaptions(scene, t) {
  const out = [];
  for (const c of scene.captions) {
    if (t >= c.tIn && t < c.tOut) out.push(c);
    else if (c.tIn > t) break;
  }
  return out;
}

/* ── Motion ──────────────────────────────────────────────────────────── */

export const MOTION_DEFAULTS = {
  preset: 'fade_up',  // fade_up | pop | bounce | typewriter | karaoke | fade | slide_up | none
  duration: 0.28,     // entrance length (s)
  distance: 0.35,     // travel as a fraction of font size
  easing: 'expo_out',
  intensity: 1,
  highlight: 'none',  // none | color | box | scale
  spokenDim: false,   // words not yet spoken show dimmed (karaoke fill)
};

// Word-level presets reveal each word at its own time; the others reveal
// the whole caption at once.
export const WORD_LEVEL = { fade_up: 1, pop: 1, bounce: 1, typewriter: 1 };

/**
 * Animation state of one word at time t.
 * Returns { alpha, dx, dy, scale, chars (-1 = whole word), hi (0..1
 * active-word highlight), spoken (0..1) } — dy/dx in output pixels.
 */
export function wordState(t, word, cap, motion, fontSize) {
  const m = Object.assign({}, MOTION_DEFAULTS, motion || {});
  const dur = Math.max(0.04, m.duration);
  const dist = (m.distance || 0) * fontSize;
  const spokenK = clamp01((t - (word.start - 0.04)) / 0.08);
  const st = { alpha: 1, dx: 0, dy: 0, scale: 1, chars: -1, hi: 0, spoken: spokenK };
  const wordLevel = !!WORD_LEVEL[m.preset];
  const t0 = wordLevel ? word.start : cap.tIn;
  const dt = t - t0;

  switch (m.preset) {
    case 'fade_up': {
      if (dt < 0) { st.alpha = 0; break; }
      const e = ease(m.easing, dt / dur);
      st.alpha = clamp01(e * 1.25);
      st.dy = dist * (1 - e);
      break;
    }
    case 'pop': {
      if (dt < 0) { st.alpha = 0; st.scale = 0.6; break; }
      const durScale = 0.25 / dur;
      const k = 9 * durScale, w = 2 * Math.PI * 2.2 * durScale;
      const over = 0.4 * Math.min(2, m.intensity || 1);
      st.scale = 1 - over * Math.exp(-k * dt) * Math.cos(w * dt);
      st.alpha = clamp01(dt / Math.min(0.07, dur * 0.3));
      break;
    }
    case 'bounce': {
      if (dt < 0) { st.alpha = 0; break; }
      // drops in from above and settles with two shrinking hops
      const durScale = 0.25 / dur;
      st.alpha = clamp01(dt / Math.min(0.06, dur * 0.25));
      st.dy = dt > dur * 2 ? 0 : -0.9 * fontSize * (m.intensity || 1) *
        Math.exp(-7 * dt * durScale) * Math.abs(Math.cos(2 * Math.PI * 1.6 * dt * durScale));
      break;
    }
    case 'typewriter': {
      if (dt < 0) { st.alpha = 0; st.chars = 0; break; }
      const n = word.text.length;
      const span = Math.max(0.05, Math.min(word.end - word.start, n * 0.045));
      st.chars = Math.min(n, Math.floor((dt / span) * n) + 1);
      if (st.chars >= n) st.chars = -1;
      break;
    }
    case 'fade': {
      st.alpha = ease(m.easing, dt / dur);
      break;
    }
    case 'slide_up': {
      const e = ease(m.easing, dt / dur);
      st.alpha = clamp01(e * 1.25);
      st.dy = dist * (1 - e);
      break;
    }
    case 'karaoke': {
      st.alpha = clamp01(dt / 0.08);
      break;
    }
    default: break;   // 'none'
  }
  // active-word highlight: on from this word's start until the next word
  // (or the caption's end), with 70 ms in/out so it glides instead of blinking
  if (highlightMode(m) !== 'none') {
    const nextStart = word.nextStart != null ? word.nextStart : Math.min(cap.exitStart, word.end + 0.08);
    const inK = clamp01((t - word.start) / 0.07);
    const outK = clamp01((t - nextStart) / 0.07);
    st.hi = Math.max(0, inK - outK);
  }
  st.alpha *= exitFactor(cap, t);
  return st;
}

/** 1 → 0 across a caption's exit fade (1 outside it). */
export function exitFactor(cap, t) {
  if (cap.exitStart < cap.tOut && t >= cap.exitStart) {
    return 1 - ease('ease_in_out', (t - cap.exitStart) / (cap.tOut - cap.exitStart));
  }
  return 1;
}

/** Effective active-word highlight mode (karaoke implies 'color'). */
export function highlightMode(motion) {
  const m = motion || {};
  if (m.highlight && m.highlight !== 'none') return m.highlight;
  return m.preset === 'karaoke' ? 'color' : 'none';
}

/** Link each word to the next word's start (for the highlight hand-off). */
export function linkWords(scene) {
  for (const c of scene.captions) {
    const flat = [];
    for (const l of c.lines) for (const w of l.words) flat.push(w);
    for (let i = 0; i < flat.length; i++) flat[i].nextStart = i + 1 < flat.length ? flat[i + 1].start : null;
  }
  return scene;
}

/**
 * Where the sliding highlight box sits at time t: interpolates from the
 * previous active word to the current one so it glides between words.
 * Returns { x, w, line, k (0..1 opacity) } or null.
 */
export function highlightBox(t, cap, motionDur) {
  const flat = [];
  cap.lines.forEach((l, li) => l.words.forEach((w) => flat.push({ w, li, y: l.y })));
  let idx = -1;
  for (let i = 0; i < flat.length; i++) if (t >= flat[i].w.start) idx = i;
  if (idx < 0) return null;
  const cur = flat[idx];
  const prev = idx > 0 ? flat[idx - 1] : null;
  const glide = Math.max(0.06, Math.min(0.14, motionDur || 0.12));
  const k = prev && prev.li === cur.li ? ease('ease_out', (t - cur.w.start) / glide) : 1;
  const from = prev && prev.li === cur.li ? prev.w : cur.w;
  return { x: mix(from.x, cur.w.x, k), w: mix(from.w, cur.w.w, k), y: cur.y, k: clamp01((t - flat[0].w.start) / 0.08) };
}

/**
 * Cheap fingerprint of everything visible at time t. Two frames with the
 * same key render identically, so the exporter sends a "repeat" instead of
 * pixels (most frames during holds are static).
 */
export function frameKey(scene, t, motion) {
  const caps = activeCaptions(scene, t);
  if (!caps.length) return '';
  const q = (v, s) => Math.round(v * s);
  let key = '';
  for (const c of caps) {
    // caption-level entrance (backgrounds fade in over 0.12 s) + exit
    key += c.id + ':' + q(clamp01((t - c.tIn) / 0.12), 255) + ',' + q(exitFactor(c, t), 255) + ':';
    for (const l of c.lines) for (const w of l.words) {
      const s = wordState(t, w, c, motion, scene.fontSize);
      key += q(s.alpha, 255) + ',' + q(s.dx, 8) + ',' + q(s.dy, 8) + ',' + q(s.scale, 1000) + ',' + s.chars + ',' + q(s.hi, 255) + ',' + q(s.spoken, 255) + ';';
    }
    if (highlightMode(motion) === 'box') {
      const hb = highlightBox(t, c, motion.duration);
      if (hb) key += 'h' + q(hb.x, 8) + ',' + q(hb.y, 8) + ',' + q(hb.w, 8) + ',' + q(hb.k, 255);
    }
    key += '|';
  }
  return key;
}
