/**
 * captions/fonts.js — fonts for the caption renderer.
 *
 * Two sources:
 *   • bundled caption fonts (styles/caption-fonts.css) — always available,
 *     identical on every machine, work offline;
 *   • fonts installed on this PC — listed by the backend (GET
 *     /api/captions/fonts), drawn by Chromium by family name.
 * Measuring waits for the font to load: grouping on fallback metrics and
 * re-wrapping when the real font arrives looked like a glitch.
 */
import { fontString } from './render.js';

export const BUNDLED = [
  { family: 'Montserrat', weights: [700, 800, 900], note: 'Classic caption font' },
  { family: 'Poppins', weights: [600, 700, 800], note: 'Clean & round' },
  { family: 'Inter', weights: [700, 800, 900], note: 'Modern, neutral' },
  { family: 'Anton', weights: [400], note: 'Tall & punchy' },
  { family: 'Bebas Neue', weights: [400], note: 'All-caps display' },
];

const WEIGHT_NAMES = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium',
  600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };
export function weightName(w) { return WEIGHT_NAMES[w] || String(w); }

export function isBundled(family) {
  return BUNDLED.some((f) => f.family.toLowerCase() === String(family || '').toLowerCase());
}

let _fontCss = null;
/**
 * Inject the bundled @font-face rules once. Resolves when the stylesheet
 * has loaded — before that, document.fonts.load() finds no faces and a
 * bundled font would wrongly look "missing".
 */
export function injectFontStyles() {
  if (_fontCss) return _fontCss;
  if (typeof document === 'undefined') return (_fontCss = Promise.resolve());
  _fontCss = new Promise((resolve) => {
    const link = document.createElement('link');
    link.id = 'cc-font-link';
    link.rel = 'stylesheet';
    link.onload = () => resolve();
    link.onerror = () => resolve();
    setTimeout(resolve, 5000);
    link.href = 'styles/caption-fonts.css?v=1';
    document.head.appendChild(link);
  });
  return _fontCss;
}

let _probe = null;
function probeCtx() {
  if (!_probe) _probe = document.createElement('canvas').getContext('2d');
  return _probe;
}

/**
 * Is this family actually drawable? Compares widths against two generic
 * fallbacks — a missing font measures exactly like its fallback.
 */
export function isFontAvailable(family, weight) {
  if (typeof document === 'undefined') return true;
  const c = probeCtx();
  const sample = 'mmmmmmmmwwwwwwlliI10O@#&QgjyH';
  const sampleUrdu = 'ابپتٹثجچحخدڈذرڑزژسشصضطظعغفقکگلمنووہھیئے';
  const w = (f, text) => { c.font = `${weight || 400} 72px ${f}`; return c.measureText(text).width; };
  const fam = `"${String(family).replace(/"/g, '')}"`;
  const latinDiff = w(`${fam}, monospace`, sample) !== w('monospace', sample) || w(`${fam}, serif`, sample) !== w('serif', sample);
  if (latinDiff) return true;
  return w(`${fam}, monospace`, sampleUrdu) !== w('monospace', sampleUrdu) || w(`${fam}, serif`, sampleUrdu) !== w('serif', sampleUrdu);
}

/** Wait for a family/weight to load (bundled fonts load lazily). */
export async function ensureFont(family, weight) {
  if (typeof document === 'undefined' || !document.fonts) return true;
  await injectFontStyles();
  try {
    await Promise.race([
      document.fonts.load(`${weight || 400} 64px "${String(family).replace(/"/g, '')}"`, 'AaBbHgWq0 ابپتٹث'),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
  } catch (_) { /* fall through to the availability check */ }
  return isFontAvailable(family, weight);
}

/**
 * Text measurer for the model, in OUTPUT pixels, using the exact font
 * string the renderer draws with.
 */
export function makeMeasurer(style) {
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = fontString(style, style.fontSize);
  const cache = new Map();
  const measure = (t) => {
    let v = cache.get(t);
    if (v === undefined) { v = ctx.measureText(t).width; cache.set(t, v); }
    return v;
  };
  const size = style.fontSize || 80;
  const mH = ctx.measureText('H');
  const mg = ctx.measureText('gjpqy');
  const mUrdu = ctx.measureText('ٹآقےج');
  let capH = mH.actualBoundingBoxAscent > 0 ? mH.actualBoundingBoxAscent : size * 0.72;
  if (mUrdu && mUrdu.actualBoundingBoxAscent > capH) capH = mUrdu.actualBoundingBoxAscent;
  let desc = mg.actualBoundingBoxDescent > 0 ? mg.actualBoundingBoxDescent : size * 0.2;
  if (mUrdu && mUrdu.actualBoundingBoxDescent > desc) desc = mUrdu.actualBoundingBoxDescent;
  if (style.textCase === 'upper') desc *= 0.3;      // no descenders in caps
  return { measure, fontMetrics: { ascent: capH, descent: desc } };
}

let _systemFonts = null;
/** Installed fonts from the backend: [{ family, weights: [...] }]. Cached. */
export async function listSystemFonts(apiGet) {
  if (_systemFonts) return _systemFonts;
  try {
    const r = await apiGet('/api/captions/fonts', { timeoutMs: 15000 });
    _systemFonts = (r && r.fonts) || [];
  } catch (_) {
    _systemFonts = [];
  }
  return _systemFonts;
}
