/**
 * Caption engine tests — the rules that make captions read as polished.
 * Each test names the on-screen glitch it prevents (the old overlay showed
 * all of these). Run: node --test tests/captions-model.test.js
 */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const test = require('node:test');
const { loadEsm } = require('./_load-esm');

const M = loadEsm(path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions', 'model.js'));

const FONT = 80;
// Deterministic stand-in for canvas measureText: 0.55 em per character.
const measure = (t) => String(t).length * FONT * 0.55;
const env = (extra) => Object.assign({ width: 1080, height: 1920, fps: { num: 30, den: 1 }, measure }, extra || {});

function words(spec) {
  // "text@start-end" shorthand
  return spec.split(/\s+/).filter(Boolean).map((s, i) => {
    const [text, times] = s.split('@');
    const [a, b] = times.split('-').map(Number);
    return { id: i, text, start: a, end: b };
  });
}

function fixtureWords() {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'short', 'interview_short.transcript.json'), 'utf8'));
  return d.segments.flatMap((s) => s.words.map((w) => ({ text: w.word.trim(), start: w.start, end: w.end })));
}

const SETTINGS = {
  style: { fontSize: FONT, punctuation: 'keep' },
  layout: { boxWidth: 86, posY: 72 },
  grouping: {},          // the shipped defaults
  timing: {},
};

/* ── frame rates ── */

test('NTSC frame rates stay exact rationals (29.97 must not become 30)', () => {
  // WHY: the old overlay always rendered 30 fps, so every 29.97 sequence
  // got a dropped frame about every 33 s and the motion stuttered.
  assert.deepEqual(M.fpsFromTicks(8475667200), { num: 30000, den: 1001 });
  assert.deepEqual(M.fpsFromTicks(10594584000), { num: 24000, den: 1001 });
  assert.deepEqual(M.fpsFromTicks(10160640000), { num: 25, den: 1 });
  assert.deepEqual(M.fpsFromNumber(59.94), { num: 60000, den: 1001 });
  const f = M.fpsFromNumber(29.97);
  assert.equal(M.frameTime(30000, f), 1001);          // 30000 frames = 1001 s exactly
  assert.equal(M.frameCount(1001, f), 30000);
});

/* ── words ── */

test('sanitizeWords repairs engine timestamps and honours hidden words', () => {
  const w = M.sanitizeWords([
    { word: ' world ', start: 1.0, end: 1.0 },          // zero length
    { text: 'hello', start: 0.2, end: 1.4 },            // overlaps next, out of order
    { text: '   ', start: 2, end: 3 },                  // empty → dropped
    { text: 'um', start: 1.5, end: 1.6, keep: false },  // legacy "unticked" flag
  ]);
  assert.deepEqual(w.map((x) => x.text), ['hello', 'world', 'um']);
  assert.ok(w[0].end <= w[1].start, 'no overlap');
  assert.ok(w[1].end - w[1].start >= 0.04, 'minimum duration');
  assert.equal(w[2].hidden, true, 'unticked word is hidden');
});

test('displayText: soft punctuation gives the clean social look, keeps ? and !', () => {
  const o = { punctuation: 'soft' };
  assert.equal(M.displayText('channel.', o), 'channel');
  assert.equal(M.displayText('Hello,', o), 'Hello');
  assert.equal(M.displayText('really?', o), 'really?');
  assert.equal(M.displayText("you'll", o), "you'll");
  assert.equal(M.displayText('3.5', o), '3.5');
  assert.equal(M.displayText('wow', { textCase: 'upper' }), 'WOW');
});

test('displayText: no_dots keeps commas and ?!, drops ending dots and ellipses', () => {
  const o = { punctuation: 'no_dots' };
  assert.equal(M.displayText('channel.', o), 'channel');
  assert.equal(M.displayText('Hello,', o), 'Hello,');
  assert.equal(M.displayText('wait...', o), 'wait');
  assert.equal(M.displayText('really?', o), 'really?');
  assert.equal(M.displayText('awesome!', o), 'awesome!');
  assert.equal(M.displayText('3.5', o), '3.5');
  // Urdu punctuation
  assert.equal(M.displayText('بات،', o), 'بات،');
  assert.equal(M.displayText('ہے۔', o), 'ہے');
  assert.equal(M.displayText('کیوں؟', o), 'کیوں؟');
});

test('displayText: custom punctuation respects granular switches', () => {
  // Keep dots, drop commas
  const c1 = { punctuation: 'custom', punctCommas: false, punctDots: true, punctExpressive: true };
  assert.equal(M.displayText('Hello,', c1), 'Hello');
  assert.equal(M.displayText('channel.', c1), 'channel.');
  assert.equal(M.displayText('really?', c1), 'really?');

  // Keep commas, drop dots, drop expressive
  const c2 = { punctuation: 'custom', punctCommas: true, punctDots: false, punctExpressive: false };
  assert.equal(M.displayText('Hello,', c2), 'Hello,');
  assert.equal(M.displayText('channel.', c2), 'channel');
  assert.equal(M.displayText('really?', c2), 'really');
});

/* ── grouping ── */

function group(ws, opts) {
  const hideFillers = !(opts && opts.hideFillers === false);
  const vis = M.sanitizeWords(ws).filter((w) => M.isVisible(w, hideFillers));
  vis.forEach((w) => { w.display = w.text; });
  return M.groupWords(vis, Object.assign({}, M.GROUP_DEFAULTS, opts),
    { measure, spaceW: measure(' '), maxWidth: 1080 * 0.86 });
}
const texts = (gs) => gs.map((g) => g.words.map((w) => w.text).join(' '));

test('captions never end on a dangling weak word when a better split exists', () => {
  // WHY: greedy grouping produced "Today I | want to talk" — reads broken.
  const g = group(words('Today@0-0.3 I@0.3-0.4 want@0.4-0.6 to@0.6-0.7 talk@0.7-0.9 about@0.9-1.1 something@1.1-1.5 cool.@1.5-1.9'));
  for (const t of texts(g).slice(0, -1)) {
    const last = t.split(' ').pop();
    assert.equal(M.isWeak(last), false, `caption "${t}" ends on "${last}"`);
  }
});

test('a real pause always splits, a sentence end always splits', () => {
  const g = group(words('Okay@0-0.3 so@0.3-0.5 first.@0.5-0.8 Then@0.85-1.0 we@1.0-1.1 wait@2.4-2.7 here@2.7-3.0'));
  const t = texts(g);
  assert.ok(t.some((x) => /first\.$/.test(x)), 'sentence ends a caption');
  assert.ok(!t.some((x) => /we wait/.test(x)), 'the 1.3 s pause splits');
});

test('manual "break here" and hidden words are honoured', () => {
  const ws = words('one@0-0.2 two@0.2-0.4 three@0.4-0.6 four@0.6-0.8');
  ws[2].breakBefore = true;
  ws[1].hidden = true;
  const t = texts(group(ws));
  assert.deepEqual(t, ['one', 'three four']);
});

test('fillers are dropped by default, but a word un-hidden by hand stays', () => {
  const ws = words('So@0-0.2 uh,@0.2-0.4 we@0.4-0.6 um@0.6-0.8 start@0.8-1.1');
  assert.deepEqual(texts(group(ws)), ['So we start']);
  ws[3].hidden = false;   // the user wants this "um" on screen
  assert.deepEqual(texts(group(ws)), ['So we um start']);
  assert.equal(texts(group(ws, { hideFillers: false })).join(' '), 'So uh, we um start');
});

test('a caption does not end inside a noun phrase ("a fascinating | topic")', () => {
  const ws = words('Today@0-0.2 I@0.2-0.3 want@0.3-0.5 to@0.5-0.6 discuss@0.6-0.9 a@0.9-1.0 fascinating@1.0-1.5 topic@1.5-1.9 that@1.9-2.0 I@2.0-2.1 think@2.1-2.3 you\'ll@2.3-2.5 enjoy.@2.5-3.0');
  for (const t of texts(group(ws, { maxWords: 4, maxLines: 2 }))) {
    assert.ok(!/\b(a|the) \w+$/.test(t), `caption "${t}" ends mid noun phrase`);
  }
});

test('no stranded single words in continuous speech', () => {
  // WHY: the old overlay showed "topic", "interesting," and "fascinating."
  // alone for under a second — the choppiest-looking captions.
  const g = group(fixtureWords());
  const singles = g.filter((x) => x.words.length === 1);
  for (const s of singles) {
    const w = s.words[0];
    assert.ok(M.endsSentence(w.text) || /^[A-Z]/.test(w.text),
      `stranded single word "${w.text}"`);
  }
  assert.ok(singles.length <= 1, `too many single-word captions: ${singles.map((s) => s.words[0].text)}`);
});

test('two-line captions stay ONE caption with balanced lines', () => {
  // WHY: the old overlay showed line 1 then line 2 as separate flashes.
  const ws = words('talk@0-0.3 about@0.3-0.5 something@0.5-0.9 really@0.9-1.2 interesting@1.2-1.8');
  const g = group(ws, { maxWords: 5, maxLines: 2 });
  assert.equal(g.length, 1);
  assert.equal(g[0].lines.length, 2);
  const [a, b] = g[0].lines;
  const len = (r) => g[0].words.slice(r[0], r[1] + 1).map((w) => w.text).join(' ').length;
  assert.ok(Math.abs(len(a) - len(b)) <= 12, 'lines are balanced');
});

test('captions respect the box width (no text off-screen)', () => {
  const g = group(words('extraordinarily@0-0.5 uncharacteristically@0.5-1 long@1-1.2 words@1.2-1.5'));
  for (const c of g) {
    for (const [a, b] of c.lines) {
      const ws = c.words.slice(a, b + 1);
      const w = ws.reduce((s, x) => s + measure(x.text), 0) + measure(' ') * (ws.length - 1);
      assert.ok(ws.length === 1 || w <= 1080 * 0.86, `line "${ws.map((x) => x.text).join(' ')}" too wide`);
    }
    assert.ok(c.lines.length <= M.GROUP_DEFAULTS.maxLines);
  }
});

/* ── timing ── */

function scene(ws, extra) {
  return M.buildScene(ws, Object.assign({}, SETTINGS, extra || {}), env());
}

test('continuous speech never shows a blank frame between captions', () => {
  // WHY: the old overlay hard-cut one chunk out on the exact frame the next
  // chunk's first word was still at 0 % opacity — a visible blink.
  const sc = scene(fixtureWords());
  const motion = { preset: 'fade_up', duration: 0.28 };
  for (let i = 0; i + 1 < sc.captions.length; i++) {
    const a = sc.captions[i], b = sc.captions[i + 1];
    if (b.tIn - a.lines[a.lines.length - 1].words.slice(-1)[0].end > 0.6) continue;  // real silence
    for (let t = b.tIn; t < b.tIn + 0.2; t += 1 / 30) {
      let ink = 0;
      for (const c of M.activeCaptions(sc, t)) {
        for (const l of c.lines) for (const w of l.words) ink = Math.max(ink, M.wordState(t, w, c, motion, FONT).alpha);
      }
      assert.ok(ink > 0.35, `blank-ish frame at ${t.toFixed(3)} between "${a.id}" and "${b.id}"`);
    }
  }
});

test('captions clear during silence instead of lingering', () => {
  // WHY: the old overlay held "really cool." 2.9 s into dead air.
  const sc = scene(fixtureWords());
  for (const c of sc.captions) {
    const lastEnd = c.lines[c.lines.length - 1].words.slice(-1)[0].end;
    const held = c.tOut - Math.max(lastEnd, c.tIn + M.TIMING_DEFAULTS.minDuration);
    assert.ok(held <= M.TIMING_DEFAULTS.maxHold + M.TIMING_DEFAULTS.exitDuration + 1e-6 ||
              c === sc.captions[sc.captions.length - 1], `caption ${c.id} lingers ${held.toFixed(2)} s`);
  }
});

test('every caption stays on screen long enough to read', () => {
  const sc = scene(fixtureWords());
  for (const c of sc.captions) {
    assert.ok(c.tOut - c.tIn >= 0.5, `caption ${c.id} flashes for ${(c.tOut - c.tIn).toFixed(2)} s`);
  }
});

/* ── motion ── */

test('whole-caption presets reveal every word together (no word snaps in)', () => {
  // WHY: the old "Fade Up"/"Simple Fade" showed later words instantly at
  // 100 % opacity while the first word was still fading.
  const sc = scene(words('one@0-0.3 two@0.6-0.9 three@1.2-1.5'));
  const c = sc.captions[0];
  const ws = c.lines.flatMap((l) => l.words);
  for (const preset of ['fade', 'slide_up', 'karaoke', 'none']) {
    for (const t of [c.tIn + 0.05, c.tIn + 0.15, 0.7, 1.3]) {
      const a = ws.map((w) => M.wordState(t, w, c, { preset }, FONT).alpha);
      assert.ok(Math.max(...a) - Math.min(...a) < 1e-9, `${preset} at ${t}: ${a}`);
    }
  }
});

test('word presets: hidden before the word, settled after the entrance', () => {
  const sc = scene(words('one@0-0.3 two@0.6-0.9'));
  const c = sc.captions[0];
  const w2 = c.lines[0].words[1];
  for (const preset of ['fade_up', 'pop', 'bounce', 'typewriter']) {
    const before = M.wordState(0.5, w2, c, { preset }, FONT);
    assert.equal(before.alpha, 0, `${preset} visible early`);
    const after = M.wordState(c.exitStart - 0.01, w2, c, { preset }, FONT);   // last frame before the exit
    assert.ok(after.alpha > 0.99 && Math.abs(after.dy) < 0.5 && Math.abs(after.scale - 1) < 0.01 && after.chars === -1,
      `${preset} not settled: ${JSON.stringify(after)}`);
  }
});

test('exit fades out smoothly to zero at tOut', () => {
  const sc = scene(words('one@0-0.3 two@0.3-0.6'));
  const c = sc.captions[0];
  const w = c.lines[0].words[0];
  const mid = M.wordState((c.exitStart + c.tOut) / 2, w, c, { preset: 'fade_up' }, FONT).alpha;
  const end = M.wordState(c.tOut - 1e-4, w, c, { preset: 'fade_up' }, FONT).alpha;
  assert.ok(mid > 0.2 && mid < 0.8, `mid-exit alpha ${mid}`);
  assert.ok(end < 0.02, `end alpha ${end}`);
});

test('active-word highlight follows speech and glides between words', () => {
  const sc = scene(words('one@0-0.3 two@0.4-0.7 three@0.8-1.1'));
  const c = sc.captions[0];
  const [a, b] = c.lines[0].words;
  const m = { preset: 'karaoke' };
  assert.ok(M.wordState(0.2, a, c, m, FONT).hi > 0.99);
  assert.equal(M.wordState(0.2, b, c, m, FONT).hi, 0);
  assert.ok(M.wordState(0.55, b, c, m, FONT).hi > 0.99);
  assert.ok(M.wordState(0.55, a, c, m, FONT).hi < 0.01);
  const hb = M.highlightBox(0.42, c, 0.12);
  assert.ok(hb.x > a.x && hb.x < b.x, 'box is mid-glide between words');
});

test('frameKey: static holds repeat, animation changes', () => {
  const sc = scene(words('one@0-0.3 two@0.3-0.6 three@0.6-2.0'));
  const m = { preset: 'fade_up', duration: 0.28 };
  assert.equal(M.frameKey(sc, 1.5, m), M.frameKey(sc, 1.5 + 1 / 30, m), 'hold is static');
  assert.notEqual(M.frameKey(sc, 0.05, m), M.frameKey(sc, 0.05 + 1 / 30, m), 'entrance animates');
  assert.equal(M.frameKey(sc, 50, m), '', 'nothing on screen');
});
