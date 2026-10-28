'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { loadEsm } = require('./_load-esm');

const { normalizeHex } = loadEsm(path.resolve(__dirname, '..', 'cep-panel', 'client', 'src', 'captions', 'render.js'));

test('Color Normalization: Standard 6-digit hex with hash', () => {
  assert.equal(normalizeHex('#3b82f6'), '#3b82f6');
  assert.equal(normalizeHex('#3B82F6'), '#3b82f6');
  assert.equal(normalizeHex('#000000'), '#000000');
  assert.equal(normalizeHex('#ffffff'), '#ffffff');
});

test('Color Normalization: Unhashed 6-digit hex', () => {
  assert.equal(normalizeHex('3b82f6'), '#3b82f6');
  assert.equal(normalizeHex('3B82F6'), '#3b82f6');
  assert.equal(normalizeHex('ffffff'), '#ffffff');
  assert.equal(normalizeHex('000000'), '#000000');
});

test('Color Normalization: 3-digit hex shorthand', () => {
  assert.equal(normalizeHex('#fff'), '#ffffff');
  assert.equal(normalizeHex('#FFF'), '#ffffff');
  assert.equal(normalizeHex('#f0a'), '#ff00aa');
  assert.equal(normalizeHex('#38f'), '#3388ff');
});

test('Color Normalization: Unhashed 3-digit shorthand', () => {
  assert.equal(normalizeHex('fff'), '#ffffff');
  assert.equal(normalizeHex('FFF'), '#ffffff');
  assert.equal(normalizeHex('f0a'), '#ff00aa');
  assert.equal(normalizeHex('000'), '#000000');
});

test('Color Normalization: 4-digit and 8-digit hex with alpha channel', () => {
  assert.equal(normalizeHex('#ffff'), '#ffffff');
  assert.equal(normalizeHex('#3b82f6ff'), '#3b82f6');
  assert.equal(normalizeHex('3b82f680'), '#3b82f6');
});

test('Color Normalization: rgb() and rgba() functional notation', () => {
  assert.equal(normalizeHex('rgb(59, 130, 246)'), '#3b82f6');
  assert.equal(normalizeHex('rgba(59, 130, 246, 0.8)'), '#3b82f6');
  assert.equal(normalizeHex('rgb(255, 0, 128)'), '#ff0080');
  assert.equal(normalizeHex('rgb( 255 , 255 , 255 )'), '#ffffff');
  assert.equal(normalizeHex('rgb(0, 0, 0)'), '#000000');
  // Clamping
  assert.equal(normalizeHex('rgb(300, 0, 255)'), '#ff00ff');
});

test('Color Normalization: Whitespace tolerance', () => {
  assert.equal(normalizeHex('  #3b82f6  '), '#3b82f6');
  assert.equal(normalizeHex('\t3b82f6\n'), '#3b82f6');
});

test('Color Normalization: Graceful rejection and fallback handling', () => {
  assert.equal(normalizeHex(''), '#ffffff');
  assert.equal(normalizeHex('xyz'), '#ffffff');
  assert.equal(normalizeHex('#12'), '#ffffff');
  assert.equal(normalizeHex('#12345'), '#ffffff');
  assert.equal(normalizeHex('#gggggg'), '#ffffff');
  assert.equal(normalizeHex('1234567'), '#ffffff');
  assert.equal(normalizeHex(null), '#ffffff');
  assert.equal(normalizeHex(undefined), '#ffffff');
  // Custom fallback
  assert.equal(normalizeHex('invalid', null), null);
  assert.equal(normalizeHex('invalid', '#000000'), '#000000');
});
