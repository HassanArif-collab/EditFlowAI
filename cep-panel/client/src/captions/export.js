/**
 * captions/export.js — render the captions to a transparent video.
 *
 * Every frame is drawn by drawFrame() — the same function as the live
 * preview — at the sequence's exact frame rate, read back from the canvas
 * and streamed to the backend encoder (ProRes 4444 / Animation with alpha).
 * Frames identical to the previous one (holds, silences) are sent as a
 * 5-byte "repeat" instead of pixels; only the band of rows captions can
 * touch is read back.
 */
import { frameCount, frameTime, frameKey } from './model.js';
import { drawFrame, captionBand } from './render.js';
import { ensureFont } from './fonts.js';

const BATCH_BYTES = 24 * 1024 * 1024;

function repeatRecord(n) {
  const b = new Uint8Array(5);
  b[0] = 2;
  new DataView(b.buffer).setUint32(1, n, true);
  return b;
}
const FRAME_OP = new Uint8Array([1]);

async function post(base, path, body, signal, raw) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' },
    body: raw ? body : JSON.stringify(body || {}),
    signal,
  });
  if (!res.ok) {
    let msg = res.status + '';
    try { const j = await res.json(); msg = (j && j.detail) || msg; } catch (_) { /* not json */ }
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return res.json();
}

/**
 * Render `scene` to a .mov. opts: { baseUrl, name, codec, signal,
 * onProgress(done, total, etaSeconds) }. Returns { path, frames, seconds,
 * band, elapsed }.
 */
export async function renderOverlay(scene, settings, opts) {
  const o = opts || {};
  const fps = scene.fps;
  const W = scene.width, H = scene.height;

  // Pre-load bundled/system fonts to ensure identical BiDi shaping and font metrics
  if (settings && settings.style) {
    try {
      await ensureFont(settings.style.fontFamily, settings.style.fontWeight);
    } catch (_) {}
  }

  let band = captionBand(scene, settings);
  const hasRtl = scene && scene.captions && scene.captions.some((c) =>
    (c.descent >= (scene.fontSize || 80) * 0.50) ||
    (c.lines && c.lines.some((l) => l.rtl || (l.words && l.words.some((w) => w.rtl))))
  );
  if (hasRtl && scene.fontSize) {
    const rtlPad = Math.ceil(scene.fontSize * 0.52);
    const y0 = Math.max(0, band.y - Math.ceil(scene.fontSize * 0.20));
    const h0 = Math.min(H - y0, band.h + (band.y - y0) + rtlPad);
    let ey = y0, eh = h0;
    if (ey % 2) { ey -= 1; eh += 1; }
    if (eh % 2) { eh = Math.min(H - ey, eh + 1); }
    band = { y: ey, h: Math.max(2, eh) };
  }
  const tStart = Math.max(0, Number(o.tStart) || 0);
  const duration = Math.max(0.1, Number(o.duration != null ? o.duration : (scene.duration - tStart)));
  const total = Math.max(1, frameCount(duration, fps));
  const base = o.baseUrl || '';
  let job = null;
  job = await post(base, '/api/captions/encode/start', {
    width: W, height: H, band_y: band.y, band_h: band.h,
    fps_num: fps.num, fps_den: fps.den, name: o.name || 'Captions', codec: o.codec || 'prores',
  }, o.signal);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = band.h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const t0 = performance.now();
  let parts = [], bytes = 0, repeat = 0, lastKey = null, done = 0;

  const flushRepeat = () => { if (repeat) { parts.push(repeatRecord(repeat)); repeat = 0; } };
  const send = async () => {
    flushRepeat();
    if (!parts.length) return;
    const body = new Blob(parts);
    parts = []; bytes = 0;
    await post(base, `/api/captions/encode/${job.job_id}/frames`, body, o.signal, true);
  };

  try {
    for (let k = 0; k < total; k++) {
      if (o.signal && o.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const t = tStart + frameTime(k, fps);
      const key = frameKey(scene, t, settings.motion);
      if (key === lastKey) {
        repeat++;
      } else {
        flushRepeat();
        drawFrame(ctx, scene, settings, t, { offsetY: band.y });
        const px = ctx.getImageData(0, 0, W, band.h).data;
        parts.push(FRAME_OP, px);
        bytes += px.length;
        lastKey = key;
      }
      done = k + 1;
      if (bytes >= BATCH_BYTES || k % 240 === 239) {
        await send();
        if (o.onProgress) {
          const spent = (performance.now() - t0) / 1000;
          o.onProgress(done, total, done ? (spent / done) * (total - done) : 0);
        }
      }
    }
    await send();
    if (o.onProgress) o.onProgress(total, total, 0);
    const fin = await post(base, `/api/captions/encode/${job.job_id}/finish`, {}, o.signal);
    return Object.assign({ band, renderSeconds: (performance.now() - t0) / 1000, tStart, duration }, fin);
  } catch (e) {
    if (job && job.job_id) {
      try { await fetch(`${base}/api/captions/encode/${job.job_id}/cancel`, { method: 'POST' }); } catch (_) { /* ignore */ }
    }
    throw e;
  }
}
