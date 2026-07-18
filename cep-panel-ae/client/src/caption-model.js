/**
 * caption-model.js — single source of truth for caption logic shared by the
 * panel preview, the config sent to ExtendScript, and Node tests.
 *
 * Pure functions only: no DOM, no CSInterface, no AE APIs. The jsx builds
 * expressions from the SAME formulas (see ef_wordProgressExpr in index.jsx);
 * tests/jsx-expressions.test.js asserts the two stay in agreement.
 */

/* Sentence-ending punctuation across scripts:
   . ? !  latin · ؟ arabic question · ۔ urdu full stop · । devanagari danda
   ؛ arabic semicolon · 。！？ CJK · … ellipsis. Optional closing quote/bracket. */
export const SENTENCE_END = /[.?!؟۔।؛。！？…]["')\]]?\s*$/;

export const EASINGS = {
  linear: (p) => p,
  ease_in: (p) => p * p * p,
  ease_out: (p) => 1 - Math.pow(1 - p, 3),
  ease_in_out: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
};

/* Layout constants shared with the jsx (mirrored into cfg by the panel). */
export const LAYOUT = {
  wordGapEm: 0.32,      // inter-word gap = fontSize * this
  pillPadXEm: 0.28,
  pillPadYEm: 0.16,
  lineHeightEm: 1.2,
  fitMaxWidthRatio: 0.94, // auto-shrink threshold vs comp width
};

function clamp01(p) { return p < 0 ? 0 : p > 1 ? 1 : p; }

/* ── Grouping ─────────────────────────────────────────────── */

/**
 * Group word objects ({word|text, start, end, pill?}) into captions.
 * Breaks on: silence gap > maxGap, word count, duration, char budget
 * (maxChars × maxLines), or sentence-ending punctuation.
 */
export function groupWords(words, opts) {
  const maxWords = Math.max(1, opts.maxWordsPerSegment || 4);
  const maxChars = opts.maxCharsPerSegment || 30;
  const maxLines = Math.max(1, opts.maxLinesPerSegment || 1);
  const maxDur = opts.maxDurationPerSegment || 3;
  const maxGap = opts.maxGap != null ? opts.maxGap : 0.4;
  const charBudget = maxChars * maxLines;

  const groups = [];
  let cur = [];
  for (let i = 0; i < (words || []).length; i++) {
    const w = words[i];
    const text = w.word || w.text || '';
    if (!text) continue;
    const norm = {
      text,
      start: parseFloat(w.start),
      end: parseFloat(w.end),
      idx: w.idx != null ? w.idx : i,
      pill: !!w.pill,
    };
    if (cur.length === 0) { cur.push(norm); continue; }

    const prev = cur[cur.length - 1];
    const gap = norm.start - prev.end;
    const dur = norm.end - cur[0].start;
    let chars = 0;
    for (const c of cur) chars += c.text.length + 1;
    chars += text.length;

    // Break AFTER a sentence-ending word (prev), never before the current
    // word — the old `currEnds` rule orphaned "channel." into its own caption.
    if (gap > maxGap || cur.length >= maxWords || dur > maxDur ||
        chars > charBudget || SENTENCE_END.test(prev.text)) {
      groups.push(_toGroup(cur));
      cur = [norm];
    } else {
      cur.push(norm);
    }
  }
  if (cur.length) groups.push(_toGroup(cur));
  return groups;
}

function _toGroup(seg) {
  let text = '';
  for (let k = 0; k < seg.length; k++) text += (k ? ' ' : '') + seg[k].text;
  return { words: seg, start: seg[0].start, end: seg[seg.length - 1].end, text };
}

/* ── Line wrapping ────────────────────────────────────────── */

/**
 * Assign a group's words to lines. Returns [{startIdx, endIdx, text}] with
 * indices into group.words. Overflow beyond maxLines lands on the last line.
 *
 * Width mode (preferred): pass maxWidthPx + measure(text)→px (+ spacePx) —
 * greedy fill by MEASURED width, the caption-box contract. The panel decides
 * lines with real font metrics; AE renders them verbatim, so they agree.
 * Char mode (fallback): character budget per line (maxCharsPerSegment).
 */
export function wrapLines(group, opts) {
  const maxLines = Math.max(1, opts.maxLinesPerSegment || 1);
  const ws = group.words;
  const lines = [];
  let start = 0;

  if (opts.measure && opts.maxWidthPx > 0) {
    const space = opts.spacePx || 0;
    let width = 0;
    for (let i = 0; i < ws.length; i++) {
      const wpx = opts.measure(ws[i].text);
      const withWord = width === 0 ? wpx : width + space + wpx;
      const lastLine = lines.length === maxLines - 1;
      if (width > 0 && withWord > opts.maxWidthPx && !lastLine) {
        lines.push(_lineOf(ws, start, i - 1));
        start = i;
        width = wpx;
      } else {
        width = withWord;
      }
    }
    lines.push(_lineOf(ws, start, ws.length - 1));
    return lines;
  }

  const maxChars = opts.maxCharsPerSegment || 30;
  let chars = 0;
  for (let i = 0; i < ws.length; i++) {
    const wlen = ws[i].text.length;
    const withWord = chars === 0 ? wlen : chars + 1 + wlen;
    const lastLine = lines.length === maxLines - 1;
    if (chars > 0 && withWord > maxChars && !lastLine) {
      lines.push(_lineOf(ws, start, i - 1));
      start = i;
      chars = wlen;
    } else {
      chars = withWord;
    }
  }
  lines.push(_lineOf(ws, start, ws.length - 1));
  return lines;
}

function _lineOf(ws, a, b) {
  let text = '';
  for (let k = a; k <= b; k++) text += (k > a ? ' ' : '') + ws[k].text;
  return { startIdx: a, endIdx: b, text };
}

/* ── Per-word animation model ─────────────────────────────── */

/**
 * Animation state of one word at absolute time t.
 * params: { start, fadeDur, slideDist, easing, intensity }
 * Returns { opacity 0..1, dy px (comp px, +down), scaleX, scaleY, captionLevel }.
 * captionLevel=true means the preset animates the whole caption from the
 * group's start (caller passes group start as `start`).
 */
export function wordAnim(preset, params, t) {
  const start = params.start || 0;
  const fadeDur = params.fadeDur || 0.3;
  const slideDist = params.slideDist != null ? params.slideDist : 40;
  const ease = EASINGS[params.easing] || EASINGS.linear;
  const intensity = params.intensity || 1.0;
  const dt = t - start;
  const base = { opacity: 1, dy: 0, scaleX: 1, scaleY: 1, captionLevel: false };

  switch (preset) {
    case 'popin': {
      if (dt < 0) return { ...base, opacity: 0, scaleX: 0, scaleY: 0 };
      // Damped spring (matches jsx EF_SPRING_SCALE: f=3.0, d=6.0)
      const s = 1 - Math.exp(-6 * dt) * Math.cos(3 * 2 * Math.PI * dt);
      const o = clamp01(dt / 0.1);
      return { ...base, opacity: o, scaleX: s, scaleY: s };
    }
    case 'bounce': {
      if (dt < 0) return { ...base, opacity: 0 };
      const o = Math.exp(-6 * dt) * Math.cos(2 * 2 * Math.PI * dt);
      return { ...base, opacity: clamp01(dt / 0.1), dy: -160 * intensity * o };
    }
    case 'squash': {
      if (dt < 0) return { ...base, opacity: 0, scaleX: 0, scaleY: 0 };
      // Matches jsx ef_squashExpr: maxDev=13i, spd=18i, decay=1
      const dev = Math.abs(13 * intensity * Math.exp(-1 * dt) * Math.sin(18 * intensity * dt));
      const sx = (100 - dev) / 100;
      const sy = (100 + dev) / 100;
      return { ...base, opacity: clamp01(dt / 0.1), scaleX: sx, scaleY: sy };
    }
    case 'typewriter': {
      return { ...base, opacity: dt >= 0 ? 1 : 0 };
    }
    case 'fade': {
      const p = ease(clamp01(dt / fadeDur));
      return { ...base, opacity: p, captionLevel: true };
    }
    case 'fadeup': {
      const p = ease(clamp01(dt / fadeDur));
      return { ...base, opacity: p, dy: slideDist * (1 - p), captionLevel: true };
    }
    case 'fadeup_words':
    default: {
      if (dt < 0) return { ...base, opacity: 0, dy: slideDist };
      const p = ease(clamp01(dt / fadeDur));
      return { ...base, opacity: p, dy: slideDist * (1 - p) };
    }
  }
}

/* ── Caption timing (in/out points) ───────────────────────── */

/**
 * Compute layer in/out for each group. Rules (the user's manual fix, automated):
 *  - in  = group's first word start
 *  - out = next group's start + overlapFrames·frameDur ("hold until next"),
 *          capped at (visible end + maxHold) so long silences still clear
 *  - visible end = max(group end, in + minDur)
 *  - last group: visible end + tailHold
 * Returns [{in, out}] aligned with groups.
 */
export function captionTiming(groups, opts) {
  const frameDur = opts.frameDur || 1 / 30;
  const overlap = (opts.overlapFrames != null ? opts.overlapFrames : 2) * frameDur;
  const minDur = opts.minDur != null ? opts.minDur : 0.7;
  const tailHold = opts.tailHold != null ? opts.tailHold : 0.5;
  const maxHold = opts.maxHold != null ? opts.maxHold : 1.5;

  return groups.map((g, i) => {
    const tIn = g.start;
    const visibleEnd = Math.max(g.end, tIn + minDur);
    const next = groups[i + 1];
    let tOut;
    if (next) {
      tOut = Math.min(next.start + overlap, visibleEnd + maxHold);
      // never end before the caption's own words finish
      if (tOut < g.end) tOut = g.end;
    } else {
      tOut = visibleEnd + tailHold;
    }
    if (tOut <= tIn) tOut = tIn + frameDur;
    return { in: tIn, out: tOut };
  });
}
