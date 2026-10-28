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
    if (b.tIn - a.lines[a.lines.length - 1].words.slice(-1)[0].end > 0.15) continue;  // real silence
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

test('captionTiming: 0 gap on continuous speech, clears during real speech silence', () => {
  // Continuous speech (pause <= 0.12s): handoff is exact, 0 gap between captions
  const continuous = [
    { start: 1.0, end: 2.0 },
    { start: 2.05, end: 3.0 }
  ];
  const tCont = M.captionTiming(continuous, { exit: 'cut' });
  assert.equal(tCont[0].tOut, tCont[1].tIn, 'continuous speech has 0 gap');

  // Silence pause (pause > 0.12s): clears during the silence, leaving screen clear before next
  const paused = [
    { start: 1.0, end: 2.0 },
    { start: 2.8, end: 3.8 }
  ];
  const tPause = M.captionTiming(paused, { exit: 'cut' });
  assert.ok(tPause[0].tOut < tPause[1].tIn, 'caption clears during silence');
  assert.ok(tPause[1].tIn - tPause[0].tOut >= 0.4, 'blank pause before next sentence starts');
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

test('fmtTime: tenths quantization avoids 0:60.0 rounding anomaly', () => {
  assert.equal(M.fmtTime(0), '0:00.0');
  assert.equal(M.fmtTime(59.94), '0:59.9');
  assert.equal(M.fmtTime(59.96), '1:00.0'); // 59.96s must roll over to 1:00.0, never 0:60.0
  assert.equal(M.fmtTime(65.4), '1:05.4');
  assert.equal(M.fmtTime(3600), '60:00.0');
  assert.equal(M.fmtTime(-5), '0:00.0');
});

test('cut exit timing: clean handoff without double-exposure overlap', () => {
  const ws = words('first@0-0.5 caption.@0.5-0.9 second@0.95-1.4 caption.@1.4-1.8');
  const sc = scene(ws, { timing: { exit: 'cut' } });
  assert.equal(sc.captions.length, 2);
  const [c0, c1] = sc.captions;
  assert.equal(c0.tOut, c1.tIn, 'c0 cuts out exactly when c1 begins');
  assert.equal(c0.exitStart, c1.tIn, 'c0 exitStart matches handoff');
});

test('RTL layout: Urdu and Arabic text is laid out right-to-left', () => {
  assert.equal(M.isRTLText('یہ ایک ٹیسٹ ہے'), true);
  assert.equal(M.isRTLText('This is English'), false);

  const urduWords = [
    { text: 'یہ', start: 0, end: 0.3 },
    { text: 'ایک', start: 0.3, end: 0.6 },
    { text: 'بات', start: 0.6, end: 0.9 },
    { text: 'ہے', start: 0.9, end: 1.2 }
  ];
  const sc = scene(urduWords);
  assert.equal(sc.captions.length, 1);
  const line = sc.captions[0].lines[0];
  assert.equal(line.rtl, true, 'line is marked RTL');
  assert.equal(line.words.length, 4);

  // In RTL layout, the first spoken word is positioned on the right (higher X coordinate)
  const firstWord = line.words[0];
  const secondWord = line.words[1];
  assert.ok(firstWord.x > secondWord.x, `RTL: first word x (${firstWord.x}) must be > second word x (${secondWord.x})`);
});

test('displayText: Title Case formats properly and handles apostrophes and punctuation', () => {
  assert.equal(M.displayText('make every word count', { textCase: 'title' }), 'Make Every Word Count');
  assert.equal(M.displayText('HELLO WORLD', { textCase: 'title' }), 'Hello World');
  assert.equal(M.displayText("you'll love this video", { textCase: 'title' }), "You'll Love This Video");
  assert.equal(M.displayText('fast-paced action', { textCase: 'title' }), 'Fast-Paced Action');
  assert.equal(M.displayText('(secret tip)', { textCase: 'title' }), '(Secret Tip)');
});

test('groupWords: maxWords controls retention cadence (1-word pop vs 2-3 words)', () => {
  const ws = words('make@0-0.3 every@0.3-0.6 word@0.6-0.9 count@0.9-1.2');
  const g1 = group(ws, { maxWords: 1 });
  assert.equal(g1.length, 4, 'maxWords: 1 produces 4 single-word captions');
  assert.deepEqual(g1.map(g => g.words.map(w => w.text).join(' ')), ['make', 'every', 'word', 'count']);

  const g2 = group(ws, { maxWords: 2 });
  assert.equal(g2.length, 2, 'maxWords: 2 produces 2 captions');
  assert.deepEqual(g2.map(g => g.words.map(w => w.text).join(' ')), ['make every', 'word count']);
});

test('presets: viral presets are valid with signature styling and motion', () => {
  const P = loadEsm(path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions', 'presets.js'));
  const viralIds = ['hormozi', 'mrbeast', 'ali_abdaal', 'urdu_nastaliq', 'neon_cyber'];
  for (const id of viralIds) {
    const p = P.findPreset(id);
    assert.ok(p, `Preset ${id} must exist in PRESETS`);
    assert.ok(p.name, `Preset ${id} has a display name`);
    assert.ok(p.style && p.style.fontFamily, `Preset ${id} has valid style and fontFamily`);
    assert.ok(p.motion && p.motion.preset, `Preset ${id} has valid motion preset`);
    if (p.motion.easing) {
      assert.ok(M.EASINGS[p.motion.easing], `Easing ${p.motion.easing} in preset ${id} must exist in EASINGS`);
    }
  }
});

test('findFillerRanges: detects verbal filler words', () => {
  const ws = [
    { text: 'Hello', start: 0, end: 0.5 },
    { text: 'um', start: 0.8, end: 1.1 },
    { text: 'world', start: 1.5, end: 2.0 },
    { text: 'uh', start: 2.2, end: 2.5 },
  ];
  const fillers = M.findFillerRanges(ws);
  assert.equal(fillers.length, 2);
  assert.equal(fillers[0].text, 'um');
  assert.equal(fillers[1].text, 'uh');
});

test('findSilenceRanges: detects long pauses and computes target tightening cut', () => {
  const ws = [
    { text: 'First', start: 0, end: 1.0 },
    // 2.0s pause from 1.0s to 3.0s
    { text: 'second', start: 3.0, end: 4.0 },
  ];
  const silences = M.findSilenceRanges(ws, 0.6, 0.2);
  assert.equal(silences.length, 1);
  assert.equal(silences[0].start, 1.2); // 1.0 + 0.2 target pause
  assert.equal(silences[0].end, 3.0);
  assert.equal(silences[0].saved, 1.8);
});

test('applyRippleDeletesToWords: excises words and shifts subsequent timestamps in sync with timeline', () => {
  const ws = [
    { text: 'Hello', start: 0, end: 1.0 },
    { text: 'um', start: 2.0, end: 2.5 },
    { text: 'world', start: 4.0, end: 5.0 },
    { text: 'uh', start: 6.0, end: 6.5 },
    { text: 'again', start: 8.0, end: 9.0 },
  ];
  const ranges = [
    { start: 2.0, end: 2.5 }, // 0.5s cut
    { start: 6.0, end: 6.5 }, // 0.5s cut
  ];
  const updated = M.applyRippleDeletesToWords(ws, ranges);
  assert.equal(updated.length, 3);
  assert.equal(updated[0].text, 'Hello');
  assert.equal(updated[0].start, 0);
  assert.equal(updated[0].end, 1.0);

  assert.equal(updated[1].text, 'world');
  assert.equal(updated[1].start, 3.5); // 4.0 - 0.5
  assert.equal(updated[1].end, 4.5);

  assert.equal(updated[2].text, 'again');
  assert.equal(updated[2].start, 7.0); // 8.0 - 1.0
  assert.equal(updated[2].end, 8.0);
});

test('user presets: CRUD functions load, save, delete, and list custom presets', () => {
  const store = {};
  global.localStorage = {
    getItem: (k) => store[k] || null,
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };

  const P = loadEsm(path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions', 'presets.js'), { localStorage: global.localStorage });

  assert.deepEqual(P.loadUserPresets(), []);

  const saved = P.saveUserPreset({
    name: 'Neon Brand',
    style: { fontFamily: 'Montserrat', color: '#ff00ff' },
    motion: { preset: 'pop' },
  });

  assert.ok(saved && saved.id, 'New preset has generated ID');
  assert.equal(saved.name, 'Neon Brand');
  assert.equal(saved.isUser, true);

  const list = P.loadUserPresets();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, saved.id);

  const found = P.findPreset(saved.id);
  assert.ok(found, 'findPreset resolves custom user preset');
  assert.equal(found.name, 'Neon Brand');

  const all = P.getAllPresets();
  assert.equal(all.length, P.PRESETS.length + 1);

  const deleted = P.deleteUserPreset(saved.id);
  assert.equal(deleted, true);
  assert.equal(P.loadUserPresets().length, 0);
  assert.equal(P.findPreset(saved.id), null);
});

test('multi-speaker: sanitizeWords preserves speaker tag and buildScene attaches speaker to words', () => {
  const raw = [
    { text: 'Host speaking', start: 0, end: 1.0, speaker: 0 },
    { text: 'Guest reply', start: 1.2, end: 2.2, speaker: 1 },
  ];
  const sanitized = M.sanitizeWords(raw);
  assert.equal(sanitized[0].speaker, 0);
  assert.equal(sanitized[1].speaker, 1);

  const sc = M.buildScene(sanitized, {}, env());
  assert.ok(sc.captions.length > 0);
  const allSceneWords = [];
  sc.captions.forEach((c) => c.lines.forEach((l) => l.words.forEach((w) => allSceneWords.push(w))));
  assert.equal(allSceneWords[0].speaker, 0);
  assert.equal(allSceneWords[1].speaker, 1);
});

test('Urdu / Nastaliq: buildScene applies enhanced calligraphy clearance when RTL text is present', () => {
  const latinWords = [{ text: 'Hello', start: 0, end: 0.5 }, { text: 'world', start: 0.6, end: 1.0 }];
  const urduWords = [{ text: 'خوش', start: 0, end: 0.5 }, { text: 'آمدید', start: 0.6, end: 1.0 }];

  const latinScene = M.buildScene(latinWords, {}, { width: 1080, height: 1920, fps: { num: 30, den: 1 } });
  const urduScene = M.buildScene(urduWords, {}, { width: 1080, height: 1920, fps: { num: 30, den: 1 } });

  const fontSize = 80;
  assert.equal(latinScene.captions[0].ascent, fontSize * 0.78);
  assert.equal(latinScene.captions[0].descent, fontSize * 0.22);

  // Urdu Nastaliq has higher vertical span for ligatures and diacritics (>= 0.52 * fontSize descent)
  assert.equal(urduScene.captions[0].ascent, fontSize * 0.96);
  assert.equal(urduScene.captions[0].descent, fontSize * 0.52);
});

test('safe zones: platform safety guides and title safe geometry are defined', () => {
  const SZ = loadEsm(path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions', 'safe-zones.js'));
  assert.ok(SZ.SAFE_ZONES.tiktok, 'TikTok safe zone exists');
  assert.ok(SZ.SAFE_ZONES.reels, 'Reels safe zone exists');
  assert.ok(SZ.SAFE_ZONES.shorts, 'Shorts safe zone exists');
  assert.ok(SZ.SAFE_ZONES.title, 'Title safe zone exists');

  // Title safe is 90% (5% margin each side)
  const title = SZ.SAFE_ZONES.title;
  assert.equal(title.unsafe.length, 4);

  // A box at the very bottom edge intersects TikTok unsafe area
  const bottomBox = { x: 0.2, y: 0.92, w: 0.6, h: 0.05 };
  const hits = SZ.boxIntersectsUnsafe('tiktok', bottomBox);
  assert.ok(hits.length > 0, 'Bottom caption intersects TikTok nav bar');

  // A box centered at y=0.5, w=0.5 does not intersect
  const safeBox = { x: 0.25, y: 0.5, w: 0.5, h: 0.1 };
  assert.equal(SZ.boxIntersectsUnsafe('tiktok', safeBox).length, 0);
});

test('renderer: gradients, active glow, speaker colors, and rotation render cleanly', () => {
  const R = loadEsm(path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions', 'render.js'), M);

  assert.equal(R.STYLE_DEFAULTS.gradient, false);
  assert.equal(R.STYLE_DEFAULTS.activeGlow, false);
  assert.equal(R.STYLE_DEFAULTS.speakerColoring, false);
  assert.ok(Array.isArray(R.STYLE_DEFAULTS.speakerColors));

  // Mock canvas 2D context
  const mockCtx = {
    canvas: { width: 540, height: 960 },
    save() {},
    restore() {},
    setTransform() {},
    clearRect() {},
    translate() {},
    rotate() {},
    scale() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arcTo() {},
    closePath() {},
    fill() {},
    stroke() {},
    fillText() {},
    strokeText() {},
    createLinearGradient() {
      return { addColorStop() {} };
    },
  };

  const ws = [
    { text: 'One', start: 0, end: 0.5, speaker: 0 },
    { text: 'Two', start: 0.5, end: 1.0, speaker: 1 },
  ];
  const sc = M.buildScene(ws, {}, env());

  const settings = {
    style: {
      gradient: true,
      gradientColor: '#ffea00',
      activeGlow: true,
      activeGlowColor: '#00f0ff',
      activeGlowBlur: 20,
      speakerColoring: true,
      speakerColors: ['#ffffff', '#00f0ff'],
    },
    motion: { preset: 'pop', highlight: 'color' },
    layout: { rotation: 4.5 },
  };

  // Rendering frame at t=0.2 (word 1 active)
  const drawn = R.drawFrame(mockCtx, sc, settings, 0.2, { scale: 0.5 });
  assert.equal(drawn, 1);

  // Band calculation with rotation & glow pad
  const bandWithoutRot = R.captionBand(sc, { style: { strokeWidth: 0 }, layout: { rotation: 0 } });
  const bandWithRot = R.captionBand(sc, { style: { strokeWidth: 0 }, layout: { rotation: 10 } });
  assert.ok(bandWithRot.h >= bandWithoutRot.h, 'Tilted caption band has height headroom');
});

test('emojis: keyword matching, stemming, and custom user mappings', () => {
  const store = {};
  const mockStorage = {
    getItem: (k) => store[k] || null,
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };

  const E = loadEsm(path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions', 'emojis.js'), { localStorage: mockStorage });

  // Direct keyword matching
  assert.equal(E.getEmojiSuggestion('money'), '💰');
  assert.equal(E.getEmojiSuggestion('fire'), '🔥');
  assert.equal(E.getEmojiSuggestion('rocket'), '🚀');
  assert.equal(E.getEmojiSuggestion('brain'), '🧠');

  // Punctuation and case normalization
  assert.equal(E.getEmojiSuggestion('Money!'), '💰');
  assert.equal(E.getEmojiSuggestion('"GROWTH"'), '🚀');
  assert.equal(E.getEmojiSuggestion('secret...'), '🤫');

  // Stemming & plural/possessive normalization
  assert.equal(E.getEmojiSuggestion('dollars'), '💵');
  assert.equal(E.getEmojiSuggestion("dollar's"), '💵');
  assert.equal(E.getEmojiSuggestion('growing'), '🌱');

  // Non-keywords return null
  assert.equal(E.getEmojiSuggestion('the'), null);
  assert.equal(E.getEmojiSuggestion('and'), null);
  assert.equal(E.getEmojiSuggestion('xyzabc123'), null);

  // Scan word list
  const words = [
    { text: 'How', start: 0, end: 0.5 },
    { text: 'to', start: 0.5, end: 0.8 },
    { text: 'make', start: 0.8, end: 1.1 },
    { text: 'money', start: 1.1, end: 1.6 },
    { text: 'fast', start: 1.6, end: 2.0 },
  ];
  const suggestions = E.findAllSuggestions(words);
  assert.equal(suggestions.length, 2);
  assert.equal(suggestions[0].word, 'money');
  assert.equal(suggestions[0].emoji, '💰');
  assert.equal(suggestions[1].word, 'fast');
  assert.equal(suggestions[1].emoji, '⚡');

  // Custom user mappings override
  E.saveCustomEmoji('coding', '💻');
  assert.equal(E.getEmojiSuggestion('coding'), '💻');
  E.deleteCustomEmoji('coding');
  assert.equal(E.getEmojiSuggestion('coding'), null);
});

test('emojis: model preserves emoji and applies inline vs above layout headroom', () => {
  const raw = [
    { text: 'Huge', start: 0, end: 0.5 },
    { text: 'profit', start: 0.5, end: 1.0, emoji: '📈' },
  ];
  const sanitized = M.sanitizeWords(raw);
  assert.equal(sanitized[1].emoji, '📈');

  // Above placement (default)
  const scAbove = M.buildScene(sanitized, { style: { emojiPlacement: 'above', emojiScale: 1.0 } }, env());
  const capAbove = scAbove.captions[0];
  const profitAbove = capAbove.lines[0].words[1];
  assert.equal(profitAbove.emoji, '📈');
  assert.equal(profitAbove.text, 'profit'); // text stays clean

  // Inline placement
  const scInline = M.buildScene(sanitized, { style: { emojiPlacement: 'inline' } }, env());
  const profitInline = scInline.captions[0].lines[0].words[1];
  assert.equal(profitInline.text, 'profit 📈'); // emoji rendered directly inline

  // Floating emoji allocates headroom in caption band
  const R = loadEsm(path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions', 'render.js'), M);
  const bandNormal = R.captionBand(scAbove, { style: { emojiPlacement: 'inline' } });
  const bandWithEmojiAbove = R.captionBand(scAbove, { style: { emojiPlacement: 'above', emojiScale: 1.0 } });
  assert.ok(bandWithEmojiAbove.h > bandNormal.h, 'Floating emoji expands caption band headroom');
});

test('chapters: formatting, parsing, and YouTube compliance validation', () => {
  const CH = loadEsm(path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions', 'chapters.js'));

  // 1. Timestamp formatting
  assert.equal(CH.fmtTimestamp(0), '00:00');
  assert.equal(CH.fmtTimestamp(84), '01:24');
  assert.equal(CH.fmtTimestamp(3665), '01:01:05');
  assert.equal(CH.fmtTimestamp(84, true), '00:01:24');
  assert.equal(CH.fmtTimestamp(-5), '00:00');

  // 2. Timestamp parsing
  assert.equal(CH.parseTimestamp('00:00'), 0);
  assert.equal(CH.parseTimestamp('0:00'), 0);
  assert.equal(CH.parseTimestamp('01:24'), 84);
  assert.equal(CH.parseTimestamp('[01:24]'), 84);
  assert.equal(CH.parseTimestamp('01:05:20'), 3920);
  assert.equal(CH.parseTimestamp('invalid'), null);

  // 3. Social chapter formatting
  const sample = [
    { time: 0, title: 'Introduction' },
    { time: 84, title: 'The Problem' },
    { time: 215, title: 'How It Works' },
  ];
  const ytText = CH.formatSocialChapters(sample, 'youtube');
  assert.equal(ytText, '00:00 Introduction\n01:24 The Problem\n03:35 How It Works');

  const bracketText = CH.formatSocialChapters(sample, 'brackets');
  assert.equal(bracketText, '[00:00] Introduction\n[01:24] The Problem\n[03:35] How It Works');

  const hyphenText = CH.formatSocialChapters(sample, 'hyphen');
  assert.equal(hyphenText, '00:00 - Introduction\n01:24 - The Problem\n03:35 - How It Works');

  // 4. Parsing pasted chapters
  const pasted = `
    Here are the chapters:
    00:00 Introduction
    01:24 The Problem
    [03:35] - How It Works
  `;
  const parsed = CH.parseSocialChapters(pasted);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].time, 0);
  assert.equal(parsed[0].title, 'Introduction');
  assert.equal(parsed[1].time, 84);
  assert.equal(parsed[1].title, 'The Problem');
  assert.equal(parsed[2].time, 215);
  assert.equal(parsed[2].title, 'How It Works');

  // 5. YouTube Validation
  const validCheck = CH.validateYouTubeChapters(sample);
  assert.ok(validCheck.valid, 'Valid chapters set passes YouTube check');
  assert.equal(validCheck.errors.length, 0);

  // Bad check: doesn't start at 0
  const badStart = CH.validateYouTubeChapters([
    { time: 15, title: 'Start' },
    { time: 35, title: 'Middle' },
    { time: 55, title: 'End' },
  ]);
  assert.ok(!badStart.valid);
  assert.ok(badStart.errors[0].includes('00:00'));

  // Bad check: fewer than 3 chapters
  const tooFew = CH.validateYouTubeChapters([
    { time: 0, title: 'Intro' },
    { time: 30, title: 'Outro' },
  ]);
  assert.ok(!tooFew.valid);
  assert.ok(tooFew.errors[0].includes('at least 3 chapters'));

  // Bad check: less than 10s gap
  const tooClose = CH.validateYouTubeChapters([
    { time: 0, title: 'Intro' },
    { time: 5, title: 'Next' },
    { time: 40, title: 'End' },
  ]);
  assert.ok(!tooClose.valid);
  assert.ok(tooClose.errors[0].includes('less than 10 seconds'));
});

test('chapters: autoDetectChapters extracts topics from hooks, pauses, and speakers', () => {
  const CH = loadEsm(path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions', 'chapters.js'));

  const words = [
    { text: 'Welcome', start: 0.0, end: 0.5, speaker: 'Host' },
    { text: 'to', start: 0.5, end: 0.7, speaker: 'Host' },
    { text: 'the', start: 0.7, end: 0.9, speaker: 'Host' },
    { text: 'video.', start: 0.9, end: 1.4, speaker: 'Host' },

    // Hook at 16s: "The problem is..."
    { text: 'The', start: 16.0, end: 16.3, speaker: 'Host' },
    { text: 'problem', start: 16.3, end: 16.8, speaker: 'Host' },
    { text: 'is', start: 16.8, end: 17.0, speaker: 'Host' },
    { text: 'most', start: 17.0, end: 17.3, speaker: 'Host' },
    { text: 'editors', start: 17.3, end: 17.8, speaker: 'Host' },
    { text: 'waste', start: 17.8, end: 18.2, speaker: 'Host' },
    { text: 'hours.', start: 18.2, end: 18.8, speaker: 'Host' },

    // Hook at 35s: "How it works..."
    { text: 'How', start: 35.0, end: 35.3, speaker: 'Host' },
    { text: 'it', start: 35.3, end: 35.5, speaker: 'Host' },
    { text: 'works', start: 35.5, end: 36.0, speaker: 'Host' },
    { text: 'is', start: 36.0, end: 36.2, speaker: 'Host' },
    { text: 'very', start: 36.2, end: 36.5, speaker: 'Host' },
    { text: 'simple.', start: 36.5, end: 37.0, speaker: 'Host' },

    // Conclusion at 55s: "In conclusion..."
    { text: 'In', start: 55.0, end: 55.3, speaker: 'Guest' },
    { text: 'conclusion', start: 55.3, end: 56.0, speaker: 'Guest' },
    { text: 'this', start: 56.0, end: 56.3, speaker: 'Guest' },
    { text: 'saves', start: 56.3, end: 56.7, speaker: 'Guest' },
    { text: 'time.', start: 56.7, end: 57.2, speaker: 'Guest' },
  ];

  const chapters = CH.autoDetectChapters(words, { minChapterDuration: 10 });
  assert.ok(chapters.length >= 4, 'Detected at least 4 chapters');
  assert.equal(chapters[0].time, 0);
  assert.equal(chapters[0].title, 'Introduction');

  // Verify hook chapters detected
  assert.ok(chapters.some((c) => c.title === 'The Problem' && c.time === 16.0));
  assert.ok(chapters.some((c) => c.title === 'How It Works' && c.time === 35.0));
  assert.ok(chapters.some((c) => c.title === 'Conclusion' && c.time === 55.0));

  // YouTube validation on detected chapters
  const valid = CH.validateYouTubeChapters(chapters);
  assert.ok(valid.valid, 'Auto-detected chapters are fully YouTube compliant');
});

/* ── Multilingual BiDi Layout & Typography (DEF-01, DEF-02) ── */

test('BiDi DEF-01: Mixed Urdu + English sentence ("یہ ایک AI tool ہے") maintains LTR reading order for embedded English phrase', () => {
  const mixedWords = [
    { text: 'یہ', start: 0.1, end: 0.4 },
    { text: 'ایک', start: 0.4, end: 0.7 },
    { text: 'AI', start: 0.7, end: 1.0 },
    { text: 'tool', start: 1.0, end: 1.3 },
    { text: 'ہے', start: 1.3, end: 1.6 },
  ];
  const sc = scene(mixedWords, { grouping: { maxWords: 6 } });
  const line = sc.captions[0].lines[0];
  assert.equal(line.rtl, true, 'Base line direction must be RTL');
  assert.equal(line.words.length, 5, 'All 5 words present');

  const wAI = line.words.find((w) => w.text === 'AI');
  const wTool = line.words.find((w) => w.text === 'tool');
  const wYeh = line.words.find((w) => w.text === 'یہ');
  const wEk = line.words.find((w) => w.text === 'ایک');
  const wHai = line.words.find((w) => w.text === 'ہے');

  // Embedded Latin tokens must be laid out Left-to-Right: x(AI) < x(tool)
  assert.ok(wAI.x < wTool.x, `x(AI) [${wAI.x}] must be < x(tool) [${wTool.x}]`);
  assert.ok(wAI.x + wAI.w <= wTool.x, 'AI bounding box does not overlap tool');

  // Urdu tokens flow Right-to-Left: x(یہ) > x(ایک)
  assert.ok(wYeh.x > wEk.x, `x(یہ) [${wYeh.x}] must be > x(ایک) [${wEk.x}]`);

  // Run 0 ("یہ ایک") is to the right of Run 1 ("AI tool")
  assert.ok(wEk.x > wTool.x, `Urdu run x(ایک) [${wEk.x}] must be > English run x(tool) [${wTool.x}]`);

  // Run 1 ("AI tool") is to the right of Run 2 ("ہے")
  assert.ok(wAI.x > wHai.x, `English run x(AI) [${wAI.x}] must be > Urdu run x(ہے) [${wHai.x}]`);
});

test('BiDi DEF-02: Mixed sentence with alphanumeric phrase ("تصویر 4K ultra hd کوالٹی میں") preserves embedded run order', () => {
  const mixedWords = [
    { text: 'تصویر', start: 0.1, end: 0.4 },
    { text: '4K', start: 0.4, end: 0.7 },
    { text: 'ultra', start: 0.7, end: 1.0 },
    { text: 'hd', start: 1.0, end: 1.3 },
    { text: 'کوالٹی', start: 1.3, end: 1.6 },
    { text: 'میں', start: 1.6, end: 1.9 },
  ];
  // Provide sufficient width so all words fit on one line for full run verification
  const sc = M.buildScene(mixedWords, { style: { fontSize: 40 }, grouping: { maxWords: 8, maxLines: 1 }, layout: { boxWidth: 95 } }, env({ width: 1920, height: 1080 }));
  const line = sc.captions[0].lines[0];
  assert.equal(line.rtl, true, 'Base line direction must be RTL');

  const wTasweer = line.words.find((w) => w.text === 'تصویر');
  const w4K = line.words.find((w) => w.text === '4K');
  const wUltra = line.words.find((w) => w.text === 'ultra');
  const wHd = line.words.find((w) => w.text === 'hd');
  const wQuality = line.words.find((w) => w.text === 'کوالٹی');
  const wMein = line.words.find((w) => w.text === 'میں');

  // Embedded alphanumeric run flows Left-to-Right: 4K < ultra < hd
  assert.ok(w4K.x < wUltra.x, `x(4K) [${w4K.x}] < x(ultra) [${wUltra.x}]`);
  assert.ok(wUltra.x < wHd.x, `x(ultra) [${wUltra.x}] < x(hd) [${wHd.x}]`);
  assert.ok(w4K.x + w4K.w <= wUltra.x, '4K bounding box does not overlap ultra');
  assert.ok(wUltra.x + wUltra.w <= wHd.x, 'ultra bounding box does not overlap hd');

  // Urdu runs flow Right-to-Left surrounding the Latin run
  assert.ok(wTasweer.x > wHd.x, `x(تصویر) [${wTasweer.x}] > x(hd) [${wHd.x}]`);
  assert.ok(w4K.x > wQuality.x, `x(4K) [${w4K.x}] > x(کوالٹی) [${wQuality.x}]`);
  assert.ok(wQuality.x > wMein.x, `x(کوالٹی) [${wQuality.x}] > x(میں) [${wMein.x}]`);
});

test('BiDi: Embedded RTL run inside LTR sentence preserves RTL word order within run', () => {
  const words = [
    { text: 'The', start: 0.1, end: 0.4 },
    { text: 'words', start: 0.4, end: 0.7 },
    { text: 'کتاب', start: 0.7, end: 1.0 },
    { text: 'مقدس', start: 1.0, end: 1.3 },
    { text: 'are', start: 1.3, end: 1.6 },
    { text: 'sacred', start: 1.6, end: 1.9 },
  ];
  const sc = M.buildScene(words, { style: { fontSize: 40 }, grouping: { maxWords: 8, maxLines: 1 }, layout: { boxWidth: 95 } }, env({ width: 1920, height: 1080 }));
  const line = sc.captions[0].lines[0];
  assert.equal(line.rtl, false, 'Base line direction is LTR');

  const wThe = line.words.find((w) => w.text === 'The');
  const wWords = line.words.find((w) => w.text === 'words');
  const wKitab = line.words.find((w) => w.text === 'کتاب');
  const wMuqaddas = line.words.find((w) => w.text === 'مقدس');
  const wAre = line.words.find((w) => w.text === 'are');
  const wSacred = line.words.find((w) => w.text === 'sacred');

  // LTR run 0:
  assert.ok(wThe.x < wWords.x);
  // Embedded RTL run 1: words flow Right to Left inside the run: x(کتاب) > x(مقدس)
  assert.ok(wKitab.x > wMuqaddas.x, `RTL run order: x(کتاب) [${wKitab.x}] > x(مقدس) [${wMuqaddas.x}]`);
  // LTR run 2:
  assert.ok(wAre.x < wSacred.x);
  // Overall run progression left-to-right:
  assert.ok(wWords.x < wMuqaddas.x);
  assert.ok(wKitab.x < wAre.x);
});

test('Typography: uppercase preset preserves descenders and ascenders when RTL text is present', () => {
  const FONT_SIZE = 80;
  const urduWords = [{ text: 'خوش', start: 0, end: 0.5 }, { text: 'آمدید', start: 0.6, end: 1.0 }];
  const sceneUpper = M.buildScene(urduWords, { style: { fontSize: FONT_SIZE, textCase: 'upper' } }, env());
  assert.ok(sceneUpper.captions[0].descent >= FONT_SIZE * 0.38, 'Descent must remain >= 0.38 * fontSize for RTL in uppercase presets');
  assert.ok(sceneUpper.captions[0].ascent >= FONT_SIZE * 0.92, 'Ascent must remain >= 0.92 * fontSize for RTL in uppercase presets');
});

/* ── BiDi & Typography Core Unit Tests ── */

test('BiDi: Character classification for RTL, LTR, Alphanumeric, and Neutral tokens', () => {
  assert.equal(M.isRTLText('یہ'), true);
  assert.equal(M.isRTLText('مرحبا'), true);
  assert.equal(M.isRTLText('سلام'), true);
  assert.equal(M.getWordDirection('یہ'), 'rtl');
  assert.equal(M.getWordDirection('مرحبا'), 'rtl');

  assert.equal(M.isRTLText('Hello'), false);
  assert.equal(M.isRTLText('AI'), false);
  assert.equal(M.getWordDirection('Hello'), 'ltr');
  assert.equal(M.getWordDirection('AI'), 'ltr');

  assert.equal(M.getWordDirection('4K'), 'ltr');
  assert.equal(M.getWordDirection('500'), 'ltr');
  assert.equal(M.getWordDirection('1080p'), 'ltr');

  assert.equal(M.getWordDirection(','), 'neutral');
  assert.equal(M.getWordDirection('-'), 'neutral');
  assert.equal(M.getWordDirection('!'), 'neutral');
  assert.equal(M.getWordDirection(''), 'neutral');
});

test('BiDi: Base line direction resolution via first strong token', () => {
  assert.equal(M.getLineBaseDirection([{ text: 'یہ' }, { text: 'AI' }]), 'rtl');
  assert.equal(M.getLineBaseDirection([{ text: 'تصویر' }, { text: '4K' }]), 'rtl');
  assert.equal(M.getLineBaseDirection([{ text: 'Hello' }, { text: 'world' }]), 'ltr');
  assert.equal(M.getLineBaseDirection([{ text: '...' }, { text: '---' }]), 'ltr');
});

test('BiDi: Pure RTL Urdu line layouts words monotonically right-to-left', () => {
  const ws = [{ text: 'یہ' }, { text: 'ایک' }, { text: 'کتاب' }, { text: 'ہے' }];
  const ww = [40, 50, 60, 45];
  const spaceW = 10;
  const x0 = 100;
  const lineWidth = ww.reduce((a, b) => a + b, 0) + spaceW * (ww.length - 1);

  const res = M.layoutBidiLine(ws, ww, spaceW, x0, lineWidth);
  assert.equal(res.baseDir, 'rtl');
  assert.ok(res.wordX[0] > res.wordX[1]);
  assert.ok(res.wordX[1] > res.wordX[2]);
  assert.ok(res.wordX[2] > res.wordX[3]);
  assert.equal(res.wordX[0] + ww[0], x0 + lineWidth);
  assert.equal(res.wordX[3], x0);
});

test('BiDi: Pure LTR English line layouts words monotonically left-to-right', () => {
  const ws = [{ text: 'This' }, { text: 'is' }, { text: 'a' }, { text: 'test' }];
  const ww = [50, 30, 20, 50];
  const spaceW = 10;
  const x0 = 100;
  const lineWidth = ww.reduce((a, b) => a + b, 0) + spaceW * (ww.length - 1);

  const res = M.layoutBidiLine(ws, ww, spaceW, x0, lineWidth);
  assert.equal(res.baseDir, 'ltr');
  assert.ok(res.wordX[0] < res.wordX[1]);
  assert.ok(res.wordX[1] < res.wordX[2]);
  assert.ok(res.wordX[2] < res.wordX[3]);
  assert.equal(res.wordX[0], x0);
  assert.equal(res.wordX[3] + ww[3], x0 + lineWidth);
});

test('Typography: buildScene allocates descent >= 0.52 * fontSize for RTL text preventing clipping', () => {
  const FONT_SIZE = 100;
  const urduWords = [{ text: 'خوشآمدید', start: 0.1, end: 1.0 }];
  const scene = M.buildScene(urduWords, { style: { fontSize: FONT_SIZE } }, env());
  const cap = scene.captions[0];
  assert.ok(cap.descent >= FONT_SIZE * 0.52, `Descent (${cap.descent}) must be >= ${FONT_SIZE * 0.52}`);
  assert.ok(cap.ascent >= FONT_SIZE * 0.96, `Ascent (${cap.ascent}) must be >= ${FONT_SIZE * 0.96}`);
});

test('Typography: fontString universal fallbacks and captionBand RTL clearance', () => {
  const R = loadEsm(path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions', 'render.js'));
  const strDefault = R.fontString({ fontFamily: 'Montserrat', fontSize: 80, fontWeight: 800 });
  assert.match(strDefault, /Noto Nastaliq Urdu/, 'Must include Noto Nastaliq Urdu fallback');
  assert.match(strDefault, /Urdu Typesetting/, 'Must include Urdu Typesetting fallback');
  assert.match(strDefault, /Jameel Noori Nastaliq/, 'Must include Jameel Noori Nastaliq fallback');

  // Verify captionBand allocates headroom for RTL
  const words = [{ text: 'خوشآمدید', start: 0.1, end: 1.0 }];
  const scene = M.buildScene(words, { style: { fontSize: 100 } }, env());
  const band = R.captionBand(scene, { style: { fontSize: 100 } });
  assert.ok(band.h >= 100 * 1.5, `Band height (${band.h}) must accommodate calligraphic vertical extent`);
});




