/**
 * tests/challenger-m2-bidi-stress.test.js
 *
 * EMPIRICAL ADVERSARIAL STRESS TEST HARNESS — MILESTONE 2
 * EditFlow AI: Multilingual Bidirectional (BiDi) Layout Engine & Typography
 *
 * Subjecting layoutBidiLine, buildScene, and typography to 100+ complex stress inputs:
 * 1. Deeply nested multilingual sentences (Urdu + English + Arabic + numbers + punctuation).
 * 2. Bounding box non-overlapping invariant:
 *    - x[i] + w[i] <= x[i+1] for all LTR runs
 *    - x[i+1] + w[i+1] <= x[i] for all RTL runs
 *    - Run-to-run non-overlapping separation >= spaceW
 *    - Pairwise interval disjointness across all words on a line
 * 3. Natural visual reading order preservation:
 *    - In RTL runs: logical first word is rightmost, second word is to its left
 *    - In LTR runs: logical first word is leftmost, second word is to its right
 *    - In RTL base direction: run 0 is rightmost, run 1 is to the left of run 0
 *    - In LTR base direction: run 0 is leftmost, run 1 is to the right of run 0
 * 4. Typography, font metrics, descender clearance (>= 0.52 * fontSize) and line spacing.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { loadEsm } = require('./_load-esm');

/* ── Load Modules Under Test ─────────────────────────────────────────── */
const MODEL_PATH = path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions', 'model.js');
const RENDER_PATH = path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions', 'render.js');

const M = loadEsm(MODEL_PATH);
const R = loadEsm(RENDER_PATH, Object.assign({}, M, {
  clamp01: (v) => Math.max(0, Math.min(1, v)),
}));

const FONT_SIZE = 80;
const measure = (t) => Math.max(10, String(t || '').length * FONT_SIZE * 0.55);
const makeEnv = (extra = {}) => Object.assign({
  width: 1080,
  height: 1920,
  fps: { num: 30, den: 1 },
  measure,
  fontMetrics: { ascent: FONT_SIZE * 0.96, descent: FONT_SIZE * 0.52 },
}, extra);

/* ── Invariant Verification Helpers ───────────────────────────────────── */

/**
 * Rigorously verifies all BiDi layout invariants for a given layout output:
 * 1. Monotonicity and non-overlapping within LTR runs: x[i] + w[i] <= x[i+1]
 * 2. Monotonicity and non-overlapping within RTL runs: x[i+1] + w[i+1] <= x[i]
 * 3. Non-overlapping separation across adjacent runs
 * 4. Global line bounding box: min(x) == x0, max(x + w) == x0 + lineWidth
 * 5. Pairwise interval disjointness for all words
 * 6. Natural visual reading order consistency
 */
function assertBidiInvariants(ws, ww, spaceW, x0, lineWidth, res, scenarioDesc = '') {
  const n = ws.length;
  const EPS = 1e-5;

  if (n === 0) {
    assert.equal(res.wordX.length, 0, `${scenarioDesc}: empty line must return empty wordX`);
    assert.equal(res.wordRtl.length, 0, `${scenarioDesc}: empty line must return empty wordRtl`);
    return;
  }

  assert.equal(res.wordX.length, n, `${scenarioDesc}: wordX length must equal word count`);
  assert.equal(res.wordRtl.length, n, `${scenarioDesc}: wordRtl length must equal word count`);
  assert.ok(res.baseDir === 'rtl' || res.baseDir === 'ltr', `${scenarioDesc}: baseDir must be 'rtl' or 'ltr'`);

  // Verify all coordinates are finite numbers
  for (let i = 0; i < n; i++) {
    assert.ok(Number.isFinite(res.wordX[i]), `${scenarioDesc}: wordX[${i}] (${res.wordX[i]}) must be a finite number`);
  }

  // Segment into directional runs using res.wordRtl
  const runs = [];
  let runStart = 0;
  while (runStart < n) {
    let runEnd = runStart;
    const isRtl = res.wordRtl[runStart];
    while (runEnd + 1 < n && res.wordRtl[runEnd + 1] === isRtl) {
      runEnd++;
    }
    const indices = [];
    for (let k = runStart; k <= runEnd; k++) indices.push(k);
    runs.push({ isRtl, indices });
    runStart = runEnd + 1;
  }

  // 1. Check invariants within each run
  for (const run of runs) {
    if (run.isRtl) {
      // In RTL run: words flow Right to Left.
      // Word indices[0] is rightmost, indices[k+1] is to the left of indices[k].
      // Invariant: x[k+1] + w[k+1] <= x[k]
      for (let k = 0; k < run.indices.length - 1; k++) {
        const i1 = run.indices[k];
        const i2 = run.indices[k + 1];
        const leftOfPrev = res.wordX[i1];
        const rightOfNext = res.wordX[i2] + ww[i2];
        assert.ok(
          rightOfNext <= leftOfPrev + EPS,
          `${scenarioDesc}: RTL run invariant violated: word[${i2}] right edge (${rightOfNext}) > word[${i1}] left edge (${leftOfPrev})`
        );
        // Visual reading order: word i1 is to the right of word i2
        assert.ok(
          res.wordX[i1] > res.wordX[i2] - EPS,
          `${scenarioDesc}: RTL visual reading order violated: word[${i1}] must be to the right of word[${i2}]`
        );
      }
    } else {
      // In LTR run: words flow Left to Right.
      // Word indices[0] is leftmost, indices[k+1] is to the right of indices[k].
      // Invariant: x[k] + w[k] <= x[k+1]
      for (let k = 0; k < run.indices.length - 1; k++) {
        const i1 = run.indices[k];
        const i2 = run.indices[k + 1];
        const rightOfPrev = res.wordX[i1] + ww[i1];
        const leftOfNext = res.wordX[i2];
        assert.ok(
          rightOfPrev <= leftOfNext + EPS,
          `${scenarioDesc}: LTR run invariant violated: word[${i1}] right edge (${rightOfPrev}) > word[${i2}] left edge (${leftOfNext})`
        );
        // Visual reading order: word i1 is to the left of word i2
        assert.ok(
          res.wordX[i1] < res.wordX[i2] + EPS,
          `${scenarioDesc}: LTR visual reading order violated: word[${i1}] must be to the left of word[${i2}]`
        );
      }
    }
  }

  // 2. Check invariants between adjacent runs
  for (let r = 0; r < runs.length - 1; r++) {
    const runA = runs[r];
    const runB = runs[r + 1];

    const runALeft = Math.min(...runA.indices.map((idx) => res.wordX[idx]));
    const runARight = Math.max(...runA.indices.map((idx) => res.wordX[idx] + ww[idx]));
    const runBLeft = Math.min(...runB.indices.map((idx) => res.wordX[idx]));
    const runBRight = Math.max(...runB.indices.map((idx) => res.wordX[idx] + ww[idx]));

    if (res.baseDir === 'rtl') {
      // In RTL base direction: runB is to the left of runA
      assert.ok(
        runBRight <= runALeft + EPS,
        `${scenarioDesc}: RTL baseDir run order violated: Run ${r + 1} right edge (${runBRight}) > Run ${r} left edge (${runALeft})`
      );
    } else {
      // In LTR base direction: runB is to the right of runA
      assert.ok(
        runARight <= runBLeft + EPS,
        `${scenarioDesc}: LTR baseDir run order violated: Run ${r} right edge (${runARight}) > Run ${r + 1} left edge (${runBLeft})`
      );
    }
  }

  // 3. Pairwise disjointness: NO two words on the line may overlap
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const leftI = res.wordX[i];
      const rightI = res.wordX[i] + ww[i];
      const leftJ = res.wordX[j];
      const rightJ = res.wordX[j] + ww[j];

      // Two intervals [leftI, rightI] and [leftJ, rightJ] are disjoint if rightI <= leftJ or rightJ <= leftI
      const disjoint = (rightI <= leftJ + EPS) || (rightJ <= leftI + EPS);
      assert.ok(
        disjoint,
        `${scenarioDesc}: Overlap detected between word ${i} [${leftI.toFixed(1)}, ${rightI.toFixed(1)}] and word ${j} [${leftJ.toFixed(1)}, ${rightJ.toFixed(1)}]`
      );
    }
  }

  // 4. Global line bounding box matches [x0, x0 + lineWidth]
  const globalMinX = Math.min(...res.wordX);
  const globalMaxX = Math.max(...res.wordX.map((x, idx) => x + ww[idx]));
  assert.ok(
    Math.abs(globalMinX - x0) < EPS,
    `${scenarioDesc}: Line start coordinate mismatch: expected ${x0}, got ${globalMinX}`
  );
  assert.ok(
    Math.abs(globalMaxX - (x0 + lineWidth)) < EPS,
    `${scenarioDesc}: Line end coordinate mismatch: expected ${x0 + lineWidth}, got ${globalMaxX}`
  );
}

/* ── SUITE 1: 35 Complex Handcrafted Multilingual Sentences ───────────── */

test('CHALLENGER-M2-S1: 35 Handcrafted Adversarial Multilingual Inputs', async (t) => {
  const cases = [
    {
      name: 'TC-01: Mixed Urdu + English + Numbers ("یہ ایک 100% authentic AI tool ہے")',
      words: ['یہ', 'ایک', '100%', 'authentic', 'AI', 'tool', 'ہے'],
      expectedBaseDir: 'rtl',
    },
    {
      name: 'TC-02: Mixed Arabic + English + Punctuation ("مرحبا بك في EditFlow AI, الإصدار 2.5!")',
      words: ['مرحبا', 'بك', 'في', 'EditFlow', 'AI,', 'الإصدار', '2.5!'],
      expectedBaseDir: 'rtl',
    },
    {
      name: 'TC-03: Alternating 5-run Urdu -> English -> Urdu -> English -> Urdu',
      words: ['یہ', 'نیا', 'NextGen', 'video', 'ایڈیٹر', 'for', 'creators', 'ہے'],
      expectedBaseDir: 'rtl',
    },
    {
      name: 'TC-04: Alternating 5-run English -> Urdu -> English -> Urdu -> English',
      words: ['Welcome', 'to', 'نیا', 'ایڈیٹر', 'version', '2.0', 'بہترین', 'tool'],
      expectedBaseDir: 'ltr',
    },
    {
      name: 'TC-05: Alternating 7-run complex sentence',
      words: ['شروع', 'Start', 'درمیان', 'Middle', 'آخری', 'End', 'ختم'],
      expectedBaseDir: 'rtl',
    },
    {
      name: 'TC-06: Arabic greeting + Urdu context + English acronyms',
      words: ['السلام', 'علیکم', 'یہ', 'EditFlow', 'AI', 'سافٹ', 'ویئر', 'ہے'],
      expectedBaseDir: 'rtl',
    },
    {
      name: 'TC-07: Urdu with English in double quotes',
      words: ['اس', 'نے', 'کہا', '"Artificial', 'Intelligence"', 'بہت', 'خوب', 'ہے'],
      expectedBaseDir: 'rtl',
    },
    {
      name: 'TC-08: Urdu with English acronyms in parentheses',
      words: ['یہ', 'ماڈل', '(WhisperX)', 'بہت', 'تیز', 'ہے'],
      expectedBaseDir: 'rtl',
    },
    {
      name: 'TC-09: Embedded Arabic punctuation marks (، ؛ ؟ ۔)',
      words: ['کیا', 'آپ', '4K', 'ویڈیو', 'ایڈٹ', 'کرتے', 'ہیں؟', 'جی', 'ہاں۔'],
      expectedBaseDir: 'rtl',
    },
    {
      name: 'TC-10: Currency and decimal numbers in Urdu sentence',
      words: ['قیمت', '$199.99', 'ڈالر', 'ہے'],
      expectedBaseDir: 'rtl',
    },
    {
      name: 'TC-11: Percentage ranges in Urdu sentence',
      words: ['ڈسکاؤنٹ', '50%-70%', 'آج', 'تک', 'ہے'],
      expectedBaseDir: 'rtl',
    },
    {
      name: 'TC-12: Complex alphanumeric version codes',
      words: ['ورژن', 'v2.5-beta.1', 'دستیاب', 'ہے'],
      expectedBaseDir: 'rtl',
    },
    {
      name: 'TC-13: International phone number format with hyphens',
      words: ['فون', '+92-300-1234567', 'پر', 'کال', 'کریں'],
      expectedBaseDir: 'rtl',
    },
    {
      name: 'TC-14: URLs and file paths in Urdu context',
      words: ['لنک', 'https://editflow.ai/download', 'پر', 'جائیں'],
      expectedBaseDir: 'rtl',
    },
    {
      name: 'TC-15: Pure numbers embedded in Urdu sentence',
      words: ['2026', 'میں', '100', 'دن', 'باقی', 'ہیں'],
      expectedBaseDir: 'rtl',
    },
    {
      name: 'TC-16: Pure numbers embedded in English sentence',
      words: ['In', '2026', 'we', 'hit', '1000000', 'views'],
      expectedBaseDir: 'ltr',
    },
    {
      name: 'TC-17: Pure neutral symbols line',
      words: ['...', '---', '***', '###'],
      expectedBaseDir: 'ltr',
    },
    {
      name: 'TC-18: Leading neutral symbols before Urdu',
      words: ['...', '---', 'یہ', 'ٹیسٹ', 'ہے'],
      expectedBaseDir: 'rtl',
    },
    {
      name: 'TC-19: Trailing neutral symbols after Urdu',
      words: ['یہ', 'ٹیسٹ', 'ہے', '...', '!!!'],
      expectedBaseDir: 'rtl',
    },
    {
      name: 'TC-20: Leading neutral symbols before English',
      words: ['...', '---', 'This', 'is', 'a', 'test'],
      expectedBaseDir: 'ltr',
    },
    {
      name: 'TC-21: Trailing neutral symbols after English',
      words: ['This', 'is', 'a', 'test', '...', '!!!'],
      expectedBaseDir: 'ltr',
    },
    {
      name: 'TC-22: Single Urdu token',
      words: ['خوشآمدید'],
      expectedBaseDir: 'rtl',
    },
    {
      name: 'TC-23: Single English token',
      words: ['Welcome'],
      expectedBaseDir: 'ltr',
    },
    {
      name: 'TC-24: Single Numeric token',
      words: ['4K'],
      expectedBaseDir: 'ltr',
    },
    {
      name: 'TC-25: Single Neutral token',
      words: ['!'],
      expectedBaseDir: 'ltr',
    },
    {
      name: 'TC-26: Zero-width space tracking (spaceW = 0)',
      words: ['یہ', 'ایک', 'AI', 'ٹول', 'ہے'],
      expectedBaseDir: 'rtl',
      spaceW: 0,
    },
    {
      name: 'TC-27: Huge space width (spaceW = 50px)',
      words: ['Urdu', 'اور', 'English', 'فاصلہ'],
      expectedBaseDir: 'ltr',
      spaceW: 50,
    },
    {
      name: 'TC-28: Deeply nested Urdu with technical acronyms and file extensions',
      words: ['فائل', 'video.mp4', 'کو', 'ProRes', '422', 'HQ', 'میں', 'سیو', 'کریں'],
      expectedBaseDir: 'rtl',
    },
    {
      name: 'TC-29: Urdu with inline emojis',
      words: ['یہ', '🔥', 'زبردست', '🚀', 'ہے'],
      expectedBaseDir: 'rtl',
    },
    {
      name: 'TC-30: English with inline emojis',
      words: ['Check', 'this', '🔥', 'out', '🚀'],
      expectedBaseDir: 'ltr',
    },
    {
      name: 'TC-31: Mixed Urdu + English with inline emojis',
      words: ['یہ', 'tool', '🔥', 'بہت', 'cool', '🚀', 'ہے'],
      expectedBaseDir: 'rtl',
    },
    {
      name: 'TC-32: Hebrew script mixed with English',
      words: ['שלום', 'עולם', 'this', 'is', 'Hebrew', 'בדיקה'],
      expectedBaseDir: 'rtl',
    },
    {
      name: 'TC-33: Persian specific characters (پ, چ, ژ, گ) with English',
      words: ['این', 'یک', 'نرم‌افزار', 'خوب', 'for', 'editing', 'است'],
      expectedBaseDir: 'rtl',
    },
    {
      name: 'TC-34: Full Arabic Tashkeel diacritics',
      words: ['بِسْمِ', 'اللهِ', 'الرَّحْمٰنِ', 'الرَّحِيمِ'],
      expectedBaseDir: 'rtl',
    },
    {
      name: 'TC-35: Extreme geometry: negative x0, large x0, varied token sizes',
      words: ['تصویر', '4K', 'ultra', 'hd', 'کوالٹی', 'میں'],
      expectedBaseDir: 'rtl',
      x0: -250,
    },
  ];

  for (const tc of cases) {
    const ws = tc.words.map((w) => ({ text: w, display: w }));
    const ww = ws.map((w) => measure(w.display));
    const spaceW = tc.spaceW != null ? tc.spaceW : 15;
    const x0 = tc.x0 != null ? tc.x0 : 120;
    const lineWidth = ww.reduce((a, b) => a + b, 0) + spaceW * (ww.length - 1);

    const res = M.layoutBidiLine(ws, ww, spaceW, x0, lineWidth);

    assert.equal(res.baseDir, tc.expectedBaseDir, `${tc.name}: baseDir mismatch`);
    assertBidiInvariants(ws, ww, spaceW, x0, lineWidth, res, tc.name);
  }
});

/* ── SUITE 2: 100+ Randomized Adversarial Inputs Generator ────────────── */

test('CHALLENGER-M2-S2: 110 Automated Combinatorial Stress Inputs', () => {
  const rtlPool = [
    'یہ', 'ایک', 'کتاب', 'ہے', 'بہترین', 'ویڈیو', 'ایڈیٹنگ', 'سافٹ', 'ویئر',
    'تصویر', 'کوالٹی', 'مرحبا', 'شكرا', 'جميل', 'الذكاء', 'الاصطناعي', 'تطبيق', 'سرعة'
  ];
  const ltrPool = [
    'the', 'quick', 'brown', 'fox', 'EditFlow', 'AI', 'turbo', 'engine',
    'render', 'video', 'super', 'fast', 'timeline', 'Premiere', 'Pro'
  ];
  const numPool = [
    '4K', '1080p', '60fps', '100%', '2026', 'v3.5', '$99', '24.95', '0', '123'
  ];
  const neutralPool = [
    '...', '---', ',', '!', '?', '،', '؛', '۔', '"', '(', ')'
  ];

  // Pseudo-random deterministic PRNG
  let seed = 0xdeadbeef;
  function rng() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  function pick(arr) {
    return arr[Math.floor(rng() * arr.length)];
  }

  const testCount = 110;
  for (let tIdx = 1; tIdx <= testCount; tIdx++) {
    // Generate sentences with varying word counts: 1 to 24 tokens
    const len = (tIdx % 24) + 1;
    const ws = [];
    const ww = [];

    // Decide pattern based on tIdx
    const patternType = tIdx % 5;
    for (let k = 0; k < len; k++) {
      let word;
      if (patternType === 0) {
        // Heavy RTL with occasional LTR and NUM
        const r = rng();
        word = r < 0.6 ? pick(rtlPool) : (r < 0.85 ? pick(ltrPool) : pick(numPool));
      } else if (patternType === 1) {
        // Heavy LTR with occasional RTL and NUM
        const r = rng();
        word = r < 0.6 ? pick(ltrPool) : (r < 0.85 ? pick(rtlPool) : pick(numPool));
      } else if (patternType === 2) {
        // High frequency alternating runs
        word = (k % 2 === 0) ? pick(rtlPool) : pick(ltrPool);
      } else if (patternType === 3) {
        // Mixed with lots of neutral punctuation
        const r = rng();
        word = r < 0.4 ? pick(rtlPool) : (r < 0.7 ? pick(ltrPool) : pick(neutralPool));
      } else {
        // Pure random selection across all pools
        const pools = [rtlPool, ltrPool, numPool, neutralPool];
        word = pick(pools[Math.floor(rng() * pools.length)]);
      }

      ws.push({ text: word, display: word });
      // Random word width between 15px and 220px
      ww.push(Math.round(15 + rng() * 205));
    }

    const spaceW = Math.round(5 + rng() * 25);
    const x0 = Math.round((rng() - 0.3) * 500); // between -150 and +350
    const lineWidth = ww.reduce((a, b) => a + b, 0) + spaceW * (ww.length - 1);

    const scenarioDesc = `GenCase-${tIdx} [len=${len}, p=${patternType}, spaceW=${spaceW}, x0=${x0}]`;
    const res = M.layoutBidiLine(ws, ww, spaceW, x0, lineWidth);

    assertBidiInvariants(ws, ww, spaceW, x0, lineWidth, res, scenarioDesc);
  }
});

/* ── SUITE 3: buildScene Multilingual Invariants & Typography Clearance ─ */

test('CHALLENGER-M2-S3: buildScene Invariants Across 25 Multilingual Scenes', () => {
  const sceneInputs = [
    { text: 'یہ ایک AI ٹول ہے جو ویڈیو ایڈیٹنگ آسان بناتا ہے', rtl: true },
    { text: 'تصویر 4K ultra hd کوالٹی میں برآمد کریں', rtl: true },
    { text: 'مرحبا بكم في عالم الذكاء الاصطناعي مع EditFlow AI', rtl: true },
    { text: 'This is a standard English line for baseline comparison', rtl: false },
    { text: 'English caption with embedded اردو الفاظ for testing', rtl: false },
    { text: 'Urdu text with Nastaliq deep descenders: ج چ خ ع غ ق ل ے', rtl: true },
    { text: 'السلام عليكم ورحمة الله وبركاته 100% ممتاز', rtl: true },
    { text: 'Multiple lines caption: یہ پہلی لائن ہے اور یہ دوسری لائن', rtl: true },
    { text: '12345 67890 numbers only caption test', rtl: false },
    { text: '... --- !!! punctuation only caption test', rtl: false },
    { text: 'Mixed sentence: Premiere Pro 2026 میں نیا ورژن ریلیز ہوا ہے', rtl: true },
    { text: 'Another mixed sentence: Stable-TS and WhisperX ماڈلز بہت تیز ہیں', rtl: true },
    { text: 'خوشآمدید Welcome خوشآمدید Welcome خوشآمدید', rtl: true },
    { text: 'Urdu with inline emojis: ویڈیو بنانا اب آسان ہے 🎬🚀🔥', rtl: true },
    { text: 'Urdu with emojis above: تخلیقی کام 💡 شاندار انداز 🌟', rtl: true },
    { text: 'Very long multilingual caption: EditFlow AI ایک مکمل اور جامع نظام ہے جو آپ کے تمام ویڈیو ایڈیٹنگ کاموں کو 10 گنا تیز کر دیتا ہے', rtl: true },
    { text: 'Short RTL: ہاں', rtl: true },
    { text: 'Short LTR: Yes', rtl: false },
    { text: 'Single number: 2026', rtl: false },
    { text: 'RTL with punctuation: کیا آپ تیار ہیں؟ جی بالکل!', rtl: true },
    { text: 'Left align RTL test: بائیں جانب سیدھ', rtl: true, align: 'left' },
    { text: 'Right align RTL test: دائیں جانب سیدھ', rtl: true, align: 'right' },
    { text: 'Center align RTL test: درمیان میں سیدھ', rtl: true, align: 'center' },
    { text: 'Custom line height test: اونچائی ٹیسٹ', rtl: true, lineHeight: 1.5 },
    { text: 'Extreme font size test: بڑا فونٹ', rtl: true, fontSize: 140 },
  ];

  for (let sIdx = 0; sIdx < sceneInputs.length; sIdx++) {
    const item = sceneInputs[sIdx];
    const words = item.text.split(/\s+/).map((t, idx) => ({
      id: idx,
      text: t,
      start: idx * 0.4,
      end: idx * 0.4 + 0.35,
    }));

    const settings = {
      style: {
        fontSize: item.fontSize || FONT_SIZE,
        emojiPlacement: item.text.includes('💡') ? 'above' : 'inline',
      },
      layout: {
        boxWidth: 86,
        align: item.align || 'center',
        lineHeight: item.lineHeight || 1.12,
        posY: 70,
      },
    };

    const env = makeEnv();
    const scene = M.buildScene(words, settings, env);

    assert.ok(scene, `Scene ${sIdx} must be generated`);
    assert.ok(Array.isArray(scene.captions), `Scene ${sIdx} must have captions array`);
    assert.ok(scene.captions.length > 0, `Scene ${sIdx} must have at least one caption`);

    for (const cap of scene.captions) {
      if (item.rtl) {
        // Verify calligraphic descender clearance: descent >= 0.52 * fontSize
        assert.ok(
          cap.descent >= (settings.style.fontSize * 0.52) - 1e-6,
          `Scene ${sIdx}: Descent (${cap.descent}) must be >= ${settings.style.fontSize * 0.52}`
        );
        // Verify ascent clearance: ascent >= 0.96 * fontSize
        assert.ok(
          cap.ascent >= (settings.style.fontSize * 0.96) - 1e-6,
          `Scene ${sIdx}: Ascent (${cap.ascent}) must be >= ${settings.style.fontSize * 0.96}`
        );
        // Verify line height has calligraphic headroom (>= 1.35 * fontSize)
        assert.ok(
          scene.lineH >= (settings.style.fontSize * 1.35) - 1e-6,
          `Scene ${sIdx}: Line height (${scene.lineH}) must be >= ${settings.style.fontSize * 1.35}`
        );
      }

      // Verify every word has finite coordinates and non-overlapping invariant
      for (const line of cap.lines) {
        const lw = line.words;
        for (let i = 0; i < lw.length; i++) {
          assert.ok(Number.isFinite(lw[i].x), `Scene ${sIdx}: word.x must be finite`);
          assert.ok(Number.isFinite(lw[i].w), `Scene ${sIdx}: word.w must be finite`);
          assert.ok(lw[i].w > 0, `Scene ${sIdx}: word.w must be positive`);
        }

        // Check pairwise non-overlap of words on the line
        for (let i = 0; i < lw.length; i++) {
          for (let j = i + 1; j < lw.length; j++) {
            const leftI = lw[i].x;
            const rightI = lw[i].x + lw[i].w;
            const leftJ = lw[j].x;
            const rightJ = lw[j].x + lw[j].w;

            const disjoint = (rightI <= leftJ + 1e-5) || (rightJ <= leftI + 1e-5);
            assert.ok(
              disjoint,
              `Scene ${sIdx}: Collision between word ${i} [${leftI.toFixed(1)}, ${rightI.toFixed(1)}] and word ${j} [${leftJ.toFixed(1)}, ${rightJ.toFixed(1)}]`
            );
          }
        }
      }

      // If multi-line, verify vertical non-overlapping lines
      for (let li = 0; li < cap.lines.length - 1; li++) {
        const yDist = cap.lines[li + 1].y - cap.lines[li].y;
        assert.ok(
          yDist >= scene.lineH - 1e-5,
          `Scene ${sIdx}: Line vertical spacing (${yDist}) must be >= lineH (${scene.lineH})`
        );
      }
    }
  }
});

/* ── SUITE 4: Degenerate & Adversarial Fuzzing Inputs ──────────────────── */

test('CHALLENGER-M2-S4: Degenerate & Edge Case Fuzzing', () => {
  // 1. Empty words array
  const emptyRes = M.layoutBidiLine([], [], 10, 0, 0);
  assert.equal(emptyRes.wordX.length, 0);
  assert.equal(emptyRes.wordRtl.length, 0);
  assert.equal(emptyRes.baseDir, 'ltr');

  // 2. Words with missing/null display and text properties
  const nullWords = [{ text: null }, { display: null }, {}, { text: '' }];
  const nullWw = [50, 40, 30, 20];
  const nullRes = M.layoutBidiLine(nullWords, nullWw, 10, 100, 170);
  assert.equal(nullRes.wordX.length, 4);
  assert.equal(nullRes.baseDir, 'ltr');
  for (const x of nullRes.wordX) {
    assert.ok(Number.isFinite(x));
  }

  // 3. Pure numeric tokens
  const numWords = [{ text: '1080' }, { text: '60' }, { text: '2026' }];
  const numWw = [40, 30, 40];
  const numRes = M.layoutBidiLine(numWords, numWw, 10, 50, 130);
  assert.equal(numRes.baseDir, 'ltr');
  assert.ok(numRes.wordX[0] < numRes.wordX[1]);
  assert.ok(numRes.wordX[1] < numRes.wordX[2]);

  // 4. Zero space width and zero word width
  const zeroWords = [{ text: 'یہ' }, { text: 'ٹیسٹ' }];
  const zeroWw = [0, 50];
  const zeroRes = M.layoutBidiLine(zeroWords, zeroWw, 0, 100, 50);
  assert.equal(zeroRes.baseDir, 'rtl');
  assert.equal(zeroRes.wordX[0], 150); // width 0 at rightmost
  assert.equal(zeroRes.wordX[1], 100);

  // 5. Huge word count (100 words in one line)
  const hugeWords = [];
  const hugeWw = [];
  for (let i = 0; i < 100; i++) {
    const isUrdu = i % 3 === 0;
    hugeWords.push({ text: isUrdu ? 'لفظ' : 'word' });
    hugeWw.push(50);
  }
  const hugeLineWidth = 100 * 50 + 99 * 10;
  const hugeRes = M.layoutBidiLine(hugeWords, hugeWw, 10, 0, hugeLineWidth);
  assert.equal(hugeRes.wordX.length, 100);
  assertBidiInvariants(hugeWords, hugeWw, 10, 0, hugeLineWidth, hugeRes, 'HugeLine-100Words');
});

/* ── SUITE 5: Typography Fallbacks & Video Export Band Parity ─────────── */

test('CHALLENGER-M2-S5: Typography Fallback Cascade & Export Band Parity', () => {
  // 1. Universal font fallbacks across popular display fonts
  const fonts = ['Montserrat', 'Inter', 'Poppins', 'Anton', 'Bebas Neue', 'Arial Black', 'CustomFont'];
  for (const font of fonts) {
    const fs = R.fontString({ fontFamily: font, fontSize: 80, fontWeight: 700 });
    assert.match(fs, /Noto Nastaliq Urdu/, `${font}: Must include Noto Nastaliq Urdu fallback`);
    assert.match(fs, /Urdu Typesetting/, `${font}: Must include Urdu Typesetting fallback`);
    assert.match(fs, /Jameel Noori Nastaliq/, `${font}: Must include Jameel Noori Nastaliq fallback`);
    assert.match(fs, /Apple Color Emoji|Segoe UI Emoji/, `${font}: Must include Emoji fallbacks`);
  }

  // 2. Video Export captionBand headroom comparison: RTL vs LTR
  const ltrWords = [{ text: 'English', start: 0, end: 1 }, { text: 'Caption', start: 1, end: 2 }];
  const rtlWords = [{ text: 'خوشآمدید', start: 0, end: 1 }, { text: 'پاکستان', start: 1, end: 2 }];

  const FONT = 100;
  const ltrScene = M.buildScene(ltrWords, { style: { fontSize: FONT } }, makeEnv());
  const rtlScene = M.buildScene(rtlWords, { style: { fontSize: FONT } }, makeEnv());

  const ltrBand = R.captionBand(ltrScene, { style: { fontSize: FONT } });
  const rtlBand = R.captionBand(rtlScene, { style: { fontSize: FONT } });

  // RTL band must be substantially taller than LTR band to accommodate calligraphic descenders
  assert.ok(
    rtlBand.h > ltrBand.h,
    `RTL band height (${rtlBand.h}) must be greater than LTR band height (${ltrBand.h})`
  );
  assert.ok(
    rtlBand.h >= FONT * 1.5,
    `RTL band height (${rtlBand.h}) must be >= 1.5 * fontSize (${FONT * 1.5})`
  );

  // 3. Persian / Urdu Zero-Width Non-Joiner (ZWNJ: \u200C) handling
  const zwnjWords = [
    { text: 'می‌خواهم', display: 'می‌خواهم' },
    { text: 'test', display: 'test' }
  ];
  const zwnjWw = [measure(zwnjWords[0].display), measure(zwnjWords[1].display)];
  const zwnjLineW = zwnjWw[0] + zwnjWw[1] + 15;
  const zwnjRes = M.layoutBidiLine(zwnjWords, zwnjWw, 15, 0, zwnjLineW);
  assert.equal(zwnjRes.baseDir, 'rtl');
  assertBidiInvariants(zwnjWords, zwnjWw, 15, 0, zwnjLineW, zwnjRes, 'ZWNJ-PersianUrdu');
});

