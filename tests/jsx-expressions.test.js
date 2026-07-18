/* Eval-based verification of index.jsx expression builders.
   Loading the whole jsx in a vm sandbox is also the ES3/ES5 syntax gate:
   its top level only declares vars/functions, so it parses and runs with
   no AE globals. Generated expressions are then evaluated with mocked
   time/textIndex/thisLayer to assert the per-word animation ramps. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const JSX_PATH = path.resolve(__dirname, '..', 'cep-panel-ae', 'extendscript', 'index.jsx');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(JSX_PATH, 'utf8'), sandbox, { filename: 'index.jsx' });

function evalExpr(expr, { time, textIndex, inPoint }) {
  const r = vm.runInNewContext(expr, { time, textIndex, textTotal: 99, thisLayer: { inPoint } });
  return Array.from(r);   // vm realm arrays fail host deepStrictEqual prototype checks
}

/* ── jsx parses + builders exist ── */
test('index.jsx defines the single-layer engine builders', () => {
  for (const fn of ['ef_probeExpressionSelector', 'ef_wordProgressExpr', 'ef_applyWordAnimators',
    'ef_buildCaptionLayer', 'ef_groupHasPill', 'ef_setGroupTiming']) {
    assert.equal(typeof sandbox[fn], 'function', fn);
  }
});

/* ── word progress expression ── */
const EXPR = () => sandbox.ef_wordProgressExpr([0, 0.4, 0.9], 0.3, 'ease_out');

test('word not yet started → amount 100 (animator fully applied = hidden)', () => {
  const a = evalExpr(EXPR(), { time: 10.39, textIndex: 2, inPoint: 10 });
  assert.deepEqual(a, [100, 100, 100]);
});

test('word fully entered → amount 0 (visible, in place)', () => {
  const a = evalExpr(EXPR(), { time: 10.7, textIndex: 2, inPoint: 10 });
  assert.deepEqual(a, [0, 0, 0]);
});

test('mid-fade → amount strictly between 0 and 100', () => {
  const a = evalExpr(EXPR(), { time: 10.55, textIndex: 2, inPoint: 10 });
  assert.ok(a[0] > 0 && a[0] < 100, String(a[0]));
});

test('later word untouched while word 2 animates', () => {
  const a = evalExpr(EXPR(), { time: 10.55, textIndex: 3, inPoint: 10 });
  assert.deepEqual(a, [100, 100, 100]);
});

test('textIndex out of range clamps instead of erroring', () => {
  assert.deepEqual(evalExpr(EXPR(), { time: 20, textIndex: 50, inPoint: 10 }), [0, 0, 0]);
  assert.deepEqual(evalExpr(EXPR(), { time: 20, textIndex: 0, inPoint: 10 }), [0, 0, 0]);
});

test('expression is finite across a time sweep (no NaN)', () => {
  for (let t = 9.8; t <= 12.5; t += 0.07) {
    for (const idx of [1, 2, 3]) {
      const a = evalExpr(EXPR(), { time: t, textIndex: idx, inPoint: 10 });
      assert.ok(Number.isFinite(a[0]), `t=${t} idx=${idx}`);
    }
  }
});

test('generated expressions contain no ES5+ tokens (legacy expression engine)', () => {
  for (const easing of ['linear', 'ease_in', 'ease_out', 'ease_in_out']) {
    const e = sandbox.ef_wordProgressExpr([0, 0.5], 0.3, easing);
    for (const tok of ['=>', 'let ', 'const ', '.map(']) {
      assert.ok(!e.includes(tok), `${easing} contains ${tok}`);
    }
  }
});

/* ── legacy grouping parity ── */
test('ef_groupWords breaks on urdu sentence end', () => {
  const w = (text, start, end) => ({ text, start, end });
  const g = sandbox.ef_groupWords(
    [w('ٹھیک۔', 0, 0.3), w('اگلا', 0.35, 0.6)],
    { maxWordsPerSegment: 8, maxCharsPerSegment: 60, maxDurationPerSegment: 5, maxGap: 1 }
  );
  assert.equal(g.length, 2);
});

/* ── group timing ── */
test('ef_setGroupTiming uses exact tIn/tOut from panel groups', () => {
  const layer = {};
  sandbox.ef_setGroupTiming(layer, { start: 1, end: 2, tIn: 1, tOut: 2.6 }, 2.4);
  assert.equal(layer.inPoint, 1);
  assert.equal(layer.outPoint, 2.6);
});

test('ef_setGroupTiming falls back to capped 50ms-gap rule without tIn/tOut', () => {
  const layer = {};
  sandbox.ef_setGroupTiming(layer, { start: 1, end: 2 }, 2.2);
  assert.equal(layer.inPoint, 1);
  assert.ok(Math.abs(layer.outPoint - 2.15) < 1e-9, String(layer.outPoint));
});

/* ── pill span math (pure geometry for single-layer pills) ── */
test('ef_pillSpanMath places word spans inside centered lines', () => {
  // Two lines: "AA BB" (width 100) and "CC" (width 40), centered on x=500.
  const lines = [{ startIdx: 0, endIdx: 1 }, { startIdx: 2, endIdx: 2 }];
  const meas = { lineWidths: [100, 40], prefixW: [45, 100, 40], selfW: [45, 50, 40] };
  const spans = sandbox.ef_pillSpanMath(lines, meas, {
    centerX: 500, centerY: 800, fontSize: 80, shrink: 1,
  });
  // line 1 left edge = 450; word0 right = 450+45; word1 = [500, 550]
  assert.equal(spans[0].left, 450);
  assert.equal(spans[0].right, 495);
  assert.equal(spans[1].left, 500);
  assert.equal(spans[1].right, 550);
  // line 2 centered: [480, 520]; below line 1 by 1.2em (96px): y=800±48
  assert.equal(spans[2].left, 480);
  assert.equal(spans[2].right, 520);
  assert.equal(spans[0].y, 800 - 48);
  assert.equal(spans[2].y, 800 + 48);
});

test('ef_pillSpanMath shrink scales spans about the block center', () => {
  const lines = [{ startIdx: 0, endIdx: 0 }];
  const meas = { lineWidths: [200], prefixW: [200], selfW: [200] };
  const full = sandbox.ef_pillSpanMath(lines, meas, { centerX: 500, centerY: 800, fontSize: 80, shrink: 1 });
  const half = sandbox.ef_pillSpanMath(lines, meas, { centerX: 500, centerY: 800, fontSize: 80, shrink: 0.5 });
  assert.equal(full[0].left, 400);
  assert.equal(half[0].left, 450);   // halfway toward center
  assert.equal(half[0].right, 550);
  assert.equal(half[0].y, 800);      // single line sits on the center
});

test('single-layer pill builders exist (AE-side, exercised via bridge)', () => {
  for (const fn of ['ef_measureWordSpans', 'ef_addPillsToCaption', 'ef_pillSpanMath']) {
    assert.equal(typeof sandbox[fn], 'function', fn);
  }
});

test('agent dev-loop tools exist (AE-side, exercised via bridge)', () => {
  for (const fn of ['ef_dumpLayers', 'ef_renderFrameAt', 'ef_setupTestComp']) {
    assert.equal(typeof sandbox[fn], 'function', fn);
  }
});
