const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { loadEsm } = require('./_load-esm');

const M = loadEsm(path.resolve(
  __dirname, '..', 'cep-panel-ae', 'client', 'src', 'caption-model.js'
));

function words(specs) {
  // "text:start:end" shorthand
  return specs.map((s, i) => {
    const [text, start, end] = s.split(':');
    return { word: text, text, start: parseFloat(start), end: parseFloat(end), idx: i };
  });
}

/* ── SENTENCE_END ── */
test('sentence end matches latin + urdu + arabic + hindi + cjk punctuation', () => {
  for (const t of ['end.', 'ok?', 'wow!', 'ٹھیک۔', 'کیا؟', 'ठीक।', '了。', 'so…', 'he said."']) {
    assert.equal(M.SENTENCE_END.test(t), true, t);
  }
  for (const t of ['word', 'a,b', 'میں', 'x;']) {
    assert.equal(M.SENTENCE_END.test(t), false, t);
  }
});

/* ── groupWords ── */
const GOPTS = { maxWordsPerSegment: 4, maxCharsPerSegment: 30, maxDurationPerSegment: 3, maxGap: 0.4, maxLinesPerSegment: 1 };

test('groupWords breaks on time gap > maxGap', () => {
  const g = M.groupWords(words(['a:0:0.2', 'b:0.25:0.4', 'c:1.0:1.2']), GOPTS);
  assert.equal(g.length, 2);
  assert.equal(g[0].text, 'a b');
  assert.equal(g[1].text, 'c');
});

test('groupWords breaks on maxWords', () => {
  const g = M.groupWords(words(['a:0:0.1', 'b:0.1:0.2', 'c:0.2:0.3', 'd:0.3:0.4', 'e:0.4:0.5']), GOPTS);
  assert.equal(g[0].words.length, 4);
  assert.equal(g[1].words.length, 1);
});

test('groupWords breaks after sentence-ending word, including urdu', () => {
  const g = M.groupWords(words(['done.:0:0.2', 'next:0.25:0.4']), GOPTS);
  assert.equal(g.length, 2);
  const gu = M.groupWords(words(['ٹھیک۔:0:0.2', 'اگلا:0.25:0.4']), GOPTS);
  assert.equal(gu.length, 2);
});

test('groupWords keeps the sentence-ending word WITH its sentence (no orphans)', () => {
  const g = M.groupWords(words(['to:0:0.1', 'my:0.1:0.2', 'channel.:0.2:0.4', 'Today:0.5:0.7']), GOPTS);
  assert.equal(g.length, 2);
  assert.equal(g[0].text, 'to my channel.');
  assert.equal(g[1].text, 'Today');
});

test('groupWords char budget scales with maxLines', () => {
  const w = words(['aaaaaaaaaa:0:0.1', 'bbbbbbbbbb:0.1:0.2', 'cccccccccc:0.2:0.3', 'dddddddddd:0.3:0.4']);
  const one = M.groupWords(w, { ...GOPTS, maxCharsPerSegment: 22, maxLinesPerSegment: 1 });
  const two = M.groupWords(w, { ...GOPTS, maxCharsPerSegment: 22, maxLinesPerSegment: 2 });
  assert.ok(one.length > two.length, `expected more groups at 1 line (${one.length}) than 2 lines (${two.length})`);
});

test('groupWords keeps idx and pill flags, skips empty words', () => {
  const w = [
    { word: 'hi', start: 0, end: 0.2, pill: true },
    { word: '', start: 0.2, end: 0.3 },
    { word: 'there', start: 0.3, end: 0.5 },
  ];
  const g = M.groupWords(w, GOPTS);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].words.map((x) => x.idx), [0, 2]);
  assert.equal(g[0].words[0].pill, true);
  assert.equal(g[0].words[1].pill, false);
});

test('groupWords empty input → []', () => {
  assert.deepEqual(M.groupWords([], GOPTS), []);
});

/* ── wrapLines ── */
test('wrapLines fills lines by char budget, capped at maxLines, order kept', () => {
  const g = M.groupWords(words(['alpha:0:1', 'beta:1:2', 'gamma:2:3', 'delta:3:4']),
    { ...GOPTS, maxWordsPerSegment: 8, maxCharsPerSegment: 11, maxLinesPerSegment: 2, maxDurationPerSegment: 10, maxGap: 5 });
  assert.equal(g.length, 1);
  const lines = M.wrapLines(g[0], { maxCharsPerSegment: 11, maxLinesPerSegment: 2 });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'alpha beta');           // 10 chars fits
  assert.equal(lines[1].text, 'gamma delta');          // overflow tolerated on last line
  assert.equal(lines[0].startIdx, 0);
  assert.equal(lines[0].endIdx, 1);
  assert.equal(lines[1].startIdx, 2);
  assert.equal(lines[1].endIdx, 3);
});

test('wrapLines with maxLines=1 returns a single line', () => {
  const g = M.groupWords(words(['a:0:1', 'b:1:2']), GOPTS);
  const lines = M.wrapLines(g[0], { maxCharsPerSegment: 3, maxLinesPerSegment: 1 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'a b');
});

test('wrapLines puts an over-long single word on its own line', () => {
  // Construct the group directly — grouping's char budget would split this
  // pair into two captions, but wrap behavior itself is what's under test.
  const ws = words(['supercalifragilistic:0:1', 'ok:1:2'])
    .map((w, i) => ({ text: w.text, start: w.start, end: w.end, idx: i, pill: false }));
  const g = { words: ws, start: 0, end: 2, text: 'supercalifragilistic ok' };
  const lines = M.wrapLines(g, { maxCharsPerSegment: 8, maxLinesPerSegment: 2 });
  assert.equal(lines[0].text, 'supercalifragilistic');
  assert.equal(lines[1].text, 'ok');
});

/* ── easings ── */
test('easings are bounded and monotonic-ish', () => {
  for (const name of ['linear', 'ease_in', 'ease_out', 'ease_in_out']) {
    const f = M.EASINGS[name];
    assert.equal(typeof f, 'function', name);
    assert.equal(f(0), 0);
    assert.equal(f(1), 1);
    let prev = -1;
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const v = f(p);
      assert.ok(v >= prev - 1e-9, `${name} not monotonic at ${p}`);
      prev = v;
    }
  }
});

/* ── wordAnim ── */
const AP = { start: 2.0, fadeDur: 0.4, slideDist: 50, easing: 'ease_out', intensity: 1.0 };

test('fadeup_words: hidden before start, settled after fadeDur', () => {
  const before = M.wordAnim('fadeup_words', AP, 1.9);
  assert.equal(before.opacity, 0);
  assert.equal(before.dy, 50);
  const after = M.wordAnim('fadeup_words', AP, 2.4);
  assert.equal(after.opacity, 1);
  assert.equal(after.dy, 0);
  const mid = M.wordAnim('fadeup_words', AP, 2.2);
  assert.ok(mid.opacity > 0 && mid.opacity < 1);
  assert.ok(mid.dy > 0 && mid.dy < 50);
  assert.equal(!!before.captionLevel, false);
});

test('popin: scale overshoots past 1 then settles at 1', () => {
  let overshot = false;
  for (let t = 2.0; t <= 3.2; t += 0.02) {
    const a = M.wordAnim('popin', AP, t);
    if (a.scaleX > 1.02) overshot = true;
  }
  assert.equal(overshot, true, 'no overshoot observed');
  const settled = M.wordAnim('popin', AP, 4.5);
  assert.ok(Math.abs(settled.scaleX - 1) < 0.02);
  assert.equal(M.wordAnim('popin', AP, 1.9).opacity, 0);
});

test('bounce: vertical oscillation that decays', () => {
  const early = M.wordAnim('bounce', AP, 2.05);
  assert.ok(Math.abs(early.dy) > 1, 'bounce should displace early');
  const late = M.wordAnim('bounce', AP, 4.0);
  assert.ok(Math.abs(late.dy) < 2, 'bounce should settle');
});

test('squash: asymmetric x/y scales that settle at 1', () => {
  let asymmetric = false;
  for (let t = 2.0; t <= 2.5; t += 0.02) {
    const a = M.wordAnim('squash', AP, t);
    if (Math.abs(a.scaleX - a.scaleY) > 0.02) asymmetric = true;
  }
  assert.equal(asymmetric, true);
  const s = M.wordAnim('squash', AP, 5.0);
  assert.ok(Math.abs(s.scaleX - 1) < 0.02 && Math.abs(s.scaleY - 1) < 0.02);
});

test('typewriter: instant per-word step', () => {
  assert.equal(M.wordAnim('typewriter', AP, 1.99).opacity, 0);
  assert.equal(M.wordAnim('typewriter', AP, 2.01).opacity, 1);
  assert.equal(M.wordAnim('typewriter', AP, 2.01).dy, 0);
});

test('fade and fadeup are caption-level', () => {
  assert.equal(M.wordAnim('fade', AP, 2.2).captionLevel, true);
  assert.equal(M.wordAnim('fadeup', AP, 2.2).captionLevel, true);
  assert.equal(M.wordAnim('fade', AP, 2.2).dy, 0);
  assert.ok(M.wordAnim('fadeup', AP, 2.1).dy > 0);
});

test('unknown preset falls back to fadeup_words behavior', () => {
  const a = M.wordAnim('nope', AP, 2.4);
  assert.equal(a.opacity, 1);
});

/* ── captionTiming ── */
const TOPT = { frameDur: 1 / 30, overlapFrames: 2, minDur: 0.7, tailHold: 0.5, maxHold: 1.5 };

test('captionTiming holds each caption into the next by overlap frames', () => {
  const groups = [
    { start: 0, end: 1.0 },
    { start: 1.2, end: 2.0 },
    { start: 2.1, end: 2.4 },
  ];
  const t = M.captionTiming(groups, TOPT);
  assert.equal(t[0].in, 0);
  assert.ok(Math.abs(t[0].out - (1.2 + 2 / 30)) < 1e-9, 'ends 2 frames after next start');
  assert.ok(Math.abs(t[1].out - (2.1 + 2 / 30)) < 1e-9);
});

test('captionTiming caps hold at maxHold during long silences', () => {
  const groups = [
    { start: 0, end: 1.0 },
    { start: 8.0, end: 9.0 },
  ];
  const t = M.captionTiming(groups, TOPT);
  assert.ok(Math.abs(t[0].out - (1.0 + 1.5)) < 1e-9, `expected 2.5, got ${t[0].out}`);
});

test('captionTiming enforces minDur and last-caption tail hold', () => {
  const groups = [{ start: 0, end: 0.2 }];
  const t = M.captionTiming(groups, TOPT);
  assert.ok(t[0].out >= 0.7, 'minDur');
  const groups2 = [{ start: 0, end: 1.0 }];
  assert.ok(Math.abs(M.captionTiming(groups2, TOPT)[0].out - 1.5) < 1e-9, 'tail hold');
});

test('captionTiming out is always after in', () => {
  const groups = [
    { start: 0, end: 0.1 },
    { start: 0.05, end: 0.2 },   // pathological near-overlap input
  ];
  for (const t of M.captionTiming(groups, TOPT)) {
    assert.ok(t.out > t.in);
  }
});

test('captionTiming computed on full list survives batch slicing', () => {
  const groups = [
    { start: 0, end: 1 }, { start: 1.2, end: 2 }, { start: 2.2, end: 3 }, { start: 3.2, end: 4 },
  ];
  const all = M.captionTiming(groups, TOPT);
  const sliced = [all.slice(0, 2), all.slice(2)];
  assert.ok(Math.abs(sliced[0][1].out - (2.2 + 2 / 30)) < 1e-9, 'batch boundary keeps next-group hold');
});

/* ── wrapLines width mode (caption box) ── */
const BOXW = (specs) => ({ words: specs.map((t, i) => ({ text: t, start: i, end: i + 0.5 })) });
const MEAS = (text) => text.length * 10;   // fake metrics: 10px per char

test('width-mode wrap breaks by measured width against the box', () => {
  // widths: 40 each, space 5: "aaaa bbbb" = 85 <= 95; + " cccc" = 130 > 95
  const lines = M.wrapLines(BOXW(['aaaa', 'bbbb', 'cccc']), {
    maxLinesPerSegment: 2, maxWidthPx: 95, measure: MEAS, spacePx: 5,
  });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'aaaa bbbb');
  assert.equal(lines[1].text, 'cccc');
});

test('width-mode respects maxLines=1 (never wraps)', () => {
  const lines = M.wrapLines(BOXW(['aaaa', 'bbbb', 'cccc']), {
    maxLinesPerSegment: 1, maxWidthPx: 95, measure: MEAS, spacePx: 5,
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'aaaa bbbb cccc');
});

test('width-mode: a single word wider than the box stays alone, unsplit', () => {
  const lines = M.wrapLines(BOXW(['aaaaaaaaaaaaaaaa', 'b']), {
    maxLinesPerSegment: 2, maxWidthPx: 50, measure: MEAS, spacePx: 5,
  });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'aaaaaaaaaaaaaaaa');
  assert.equal(lines[1].text, 'b');
});

test('width-mode overflow beyond maxLines lands on the last line', () => {
  const lines = M.wrapLines(BOXW(['aaaa', 'bbbb', 'cccc', 'dddd']), {
    maxLinesPerSegment: 2, maxWidthPx: 45, measure: MEAS, spacePx: 5,
  });
  assert.equal(lines.length, 2);
  assert.equal(lines[1].text, 'bbbb cccc dddd');
});

test('char mode still works when no measure is provided (back-compat)', () => {
  const lines = M.wrapLines(BOXW(['aaaa', 'bbbb', 'cccc']), {
    maxLinesPerSegment: 2, maxCharsPerSegment: 9,
  });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'aaaa bbbb');
});
