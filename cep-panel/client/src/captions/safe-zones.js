/** (shared with the EditFlow AE panel)
 * safe-zones.js — where each platform's UI covers a 9:16 video.
 *
 * Rects are FRACTIONS {x, y, w, h} of the comp, so they scale to any
 * portrait size. "unsafe" = platform chrome (buttons, captions, nav) is
 * likely drawn there, so your captions shouldn't be.
 *
 * Schematic geometry only — no platform logos or assets. Numbers are
 * conservative (slightly larger than the real chrome) so a caption that
 * clears them here clears them on the phone.
 */

export const SAFE_ZONES = {
  tiktok: {
    label: 'TikTok',
    unsafe: [
      { x: 0.00, y: 0.00, w: 1.00, h: 0.06, tag: 'status / search' },
      { x: 0.80, y: 0.32, w: 0.20, h: 0.42, tag: 'like · comment · share' },
      { x: 0.00, y: 0.74, w: 0.80, h: 0.16, tag: 'caption + username' },
      { x: 0.00, y: 0.90, w: 1.00, h: 0.10, tag: 'nav bar' },
    ],
  },
  reels: {
    label: 'IG Reels',
    unsafe: [
      { x: 0.00, y: 0.00, w: 1.00, h: 0.08, tag: 'top bar' },
      { x: 0.82, y: 0.36, w: 0.18, h: 0.38, tag: 'action rail' },
      { x: 0.00, y: 0.78, w: 0.82, h: 0.14, tag: 'caption + audio' },
      { x: 0.00, y: 0.92, w: 1.00, h: 0.08, tag: 'nav' },
    ],
  },
  shorts: {
    label: 'YT Shorts',
    unsafe: [
      { x: 0.00, y: 0.00, w: 1.00, h: 0.07, tag: 'top bar' },
      { x: 0.84, y: 0.40, w: 0.16, h: 0.36, tag: 'action rail' },
      { x: 0.00, y: 0.80, w: 0.84, h: 0.12, tag: 'title + channel' },
      { x: 0.00, y: 0.92, w: 1.00, h: 0.08, tag: 'nav' },
    ],
  },
};

/** Unsafe rects a fractional box {x,y,w,h} overlaps (empty = safe). */
export function boxIntersectsUnsafe(zoneKey, box) {
  const z = SAFE_ZONES[zoneKey];
  if (!z || !box) return [];
  return z.unsafe.filter((r) =>
    box.x < r.x + r.w && box.x + box.w > r.x &&
    box.y < r.y + r.h && box.y + box.h > r.y);
}

/**
 * Draw the platform chrome over a canvas of size w×h. Schematic shapes
 * (rails of circles, caption lines) so it reads as a phone UI at a glance.
 */
export function drawSafeZones(ctx, w, h, zoneKey) {
  const z = SAFE_ZONES[zoneKey];
  if (!z) return;
  ctx.save();
  for (const r of z.unsafe) {
    const x = r.x * w, y = r.y * h, rw = r.w * w, rh = r.h * h;
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.fillRect(x, y, rw, rh);
    ctx.strokeStyle = 'rgba(255,255,255,.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, rw - 1, rh - 1);

    // schematic glyphs
    ctx.fillStyle = 'rgba(255,255,255,.32)';
    if (rw < w * 0.3 && rh > h * 0.2) {           // action rail: stacked circles
      const cx = x + rw / 2;
      for (let i = 0; i < 4; i++) {
        const cy = y + rh * (0.16 + i * 0.22);
        ctx.beginPath(); ctx.arc(cx, cy, Math.min(rw, rh) * 0.075, 0, Math.PI * 2); ctx.fill();
      }
    } else if (rh > h * 0.08 && r.y > 0.5) {      // caption block: text lines
      for (let i = 0; i < 2; i++) {
        ctx.fillRect(x + rw * 0.06, y + rh * (0.3 + i * 0.28), rw * (i ? 0.42 : 0.66), Math.max(2, rh * 0.08));
      }
    }
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(r.tag, x + 3, y + 2);
  }
  ctx.restore();
}
