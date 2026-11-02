const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { loadEsm } = require('./_load-esm');

function fonts() {
  const measured = [];
  const document = { createElement: () => ({ getContext: () => ({ measureText: text => {
    measured.push(text);
    const rtl = /[\u0600-\u06ff]/.test(text);
    return { width: text.length * 40, actualBoundingBoxAscent: rtl ? 110 : 58,
      actualBoundingBoxDescent: rtl ? 64 : 16 };
  } }) }) };
  return { ...loadEsm(path.resolve('cep-panel/client/src/captions/fonts.js'), { document }), measured };
}

test('English captions use Latin metrics even when Urdu fallback fonts are installed', () => {
  const f = fonts();
  const m = f.makeMeasurer({fontFamily:'Montserrat',fontSize:80}, 'Make every word count');
  assert.equal(m.fontMetrics.ascent, 58);
  assert.equal(m.fontMetrics.descent, 16);
  assert.ok(!f.measured.some(text => /[\u0600-\u06ff]/.test(text)));
});

test('Urdu text keeps calligraphy clearance when using a mixed-script font stack', () => {
  const f = fonts();
  const m = f.makeMeasurer({fontFamily:'Montserrat',fontSize:80}, 'الحمد');
  assert.equal(m.fontMetrics.ascent, 110);
  assert.equal(m.fontMetrics.descent, 64);
});
