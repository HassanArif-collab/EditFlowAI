import test from 'node:test';
import assert from 'node:assert/strict';
import { formatUserError } from '../cep-panel/client/src/captions-view.js';

test('formatUserError converts connection errors to human readable guidance', () => {
  const err = new Error('Failed to fetch');
  assert.equal(
    formatUserError(err),
    'Cannot connect to EditFlow backend. Please make sure the backend is running.'
  );
});

test('formatUserError unwraps HTTP status and JSON detail strings', () => {
  const raw = 'POST /api/captions/sequence-frame → 404: {"detail":"No active sequence frame"}';
  assert.equal(formatUserError(raw), 'No active sequence frame');
});

test('formatUserError strips raw FFmpeg stream tags and hex memory addresses', () => {
  const raw = '[vost#0:0/prores_ks @ 000001c0dbc38bc0] Error submitting a packet: No space left on device';
  const out = formatUserError(raw);
  assert.match(out, /Error submitting a packet: No space left on device/);
  assert.doesNotMatch(out, /000001c0dbc38bc0/);
});

test('formatUserError extracts error property from objects', () => {
  const obj = { success: false, error: 'No audio clips on unmuted tracks.' };
  assert.equal(formatUserError(obj), 'No audio clips on unmuted tracks.');
});

test('formatUserError handles GPU out of memory', () => {
  const err = new Error('CUDA out of memory: tried to allocate 2048 MB');
  assert.equal(
    formatUserError(err),
    'GPU memory is full. Please switch to CPU in Whisper settings or close other GPU apps.'
  );
});

test('formatUserError safely handles null or undefined', () => {
  assert.equal(formatUserError(null), 'An unknown error occurred.');
  assert.equal(formatUserError(undefined), 'An unknown error occurred.');
});
