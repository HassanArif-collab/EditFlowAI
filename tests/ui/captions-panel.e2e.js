/**
 * Captions Studio — real-browser end-to-end check.
 *
 * Drives the REAL panel (served by a running backend) in headless Chromium:
 *   1. every bound control on Style + Motion changes the saved setting AND
 *      what the preview draws (the "checkboxes don't do anything" class of
 *      bug cannot come back silently);
 *   2. transcript edits (hide / emphasis / new caption / edit / undo) change
 *      the captions;
 *   3. rendering produces a transparent video at the exact frame rate whose
 *      frames match the preview pixel-for-pixel (WYSIWYG).
 *
 * Needs: backend on :8765 (python run.py), Playwright (npm i -g playwright),
 * ffmpeg/ffprobe on PATH. Run: node tests/ui/captions-panel.e2e.js
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {
  console.log('SKIP: playwright not installed (npm i -g playwright)');
  process.exit(0);
}

const BASE = process.env.EDITFLOW_URL || 'http://127.0.0.1:8765';
const FIX = path.join(__dirname, '..', 'fixtures', 'short', 'interview_short.transcript.json');
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); console.log((ok ? 'ok   ' : 'FAIL ') + msg); };

function fixtureWords() {
  const d = JSON.parse(fs.readFileSync(FIX, 'utf8'));
  return d.segments.flatMap((s) => s.words.map((w) => ({ word: w.word.trim(), start: w.start, end: w.end })));
}

(async () => {
  try { await fetch(BASE + '/api/ping'); } catch (_) {
    console.log(`FAIL: no backend at ${BASE} - start it first (python run.py)`);
    process.exit(1);
  }
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => { try { localStorage.clear(); } catch (_) {} });
  await page.goto(BASE + '/panel/cep-loader.html', { waitUntil: 'networkidle' });
  await page.waitForSelector('.cc-tabs');
  await page.click('[data-act="paste-toggle"]');
  await page.fill('#cc-paste', JSON.stringify(fixtureWords()));
  await page.click('[data-act="paste-use"]');
  await page.waitForFunction(() => window.__editflowCaptions.state().scene && window.__editflowCaptions.state().scene.captions.length > 5);

  // Emphasise one word and turn the highlight on so colour controls have something to colour.
  await page.click('.cc-w[data-i="2"]');
  await page.click('[data-act="w-emph"]');

  // Fingerprint of what the panel would draw: the full-res frame at several times.
  const fingerprint = () => page.evaluate(() => {
    const api = window.__editflowCaptions;
    const S = api.state();
    const cv = document.createElement('canvas');
    cv.width = 270; cv.height = Math.round(270 * S.seq.height / S.seq.width);
    const ctx = cv.getContext('2d');
    let h = 2166136261;
    const times = [2.0, 2.65, 3.0, 3.6, 6.2, 8.9, 9.8, 12.3];
    for (const t of times) {
      ctx.clearRect(0, 0, cv.width, cv.height);
      api.drawAt(cv, t);
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 0; i < d.length; i += 7) { h ^= d[i]; h = Math.imul(h, 16777619); }
    }
    const sc = S.scene;
    return h + ':' + sc.captions.length + ':' + sc.captions.map((c) => c.tIn.toFixed(3) + '-' + c.tOut.toFixed(3)).join(',');
  });
  const settingAt = (p) => page.evaluate((p) => p.split('.').reduce((o, k) => o && o[k], window.__editflowCaptions.state().settings), p);

  // Set a control through the UI exactly as a user would.
  async function setControl(bind, kind, value) {
    if (kind === 'seg') {
      await page.click(`.cc-seg[data-bind="${bind}"] button[data-value="${value}"]`);
    } else if (kind === 'checkbox') {
      const cur = await page.$eval(`[data-bind="${bind}"]`, (e) => e.checked);
      if (cur !== value) await page.click(`label.cc-toggle:has([data-bind="${bind}"])`);
    } else {
      await page.$eval(`[data-bind="${bind}"]`, (e, v) => {
        e.value = String(v);
        e.dispatchEvent(new Event(e.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
      }, value);
    }
    await page.waitForTimeout(160);
  }
  const hashColor = (s) => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return '#' + (h & 0xffffff | 0x404040).toString(16).padStart(6, '0'); };

  // Each control is changed from the same baseline, checked, then restored,
  // so no control hides another (e.g. Shadow off hides the shadow colour).
  async function exercise(tab, prep) {
    await page.click(`[data-tab="${tab}"]`);
    await page.waitForTimeout(250);
    for (const [b, k, v] of prep || []) await setControl(b, k, v);
    const binds = await page.$$eval(`#cc-body [data-bind]`, (els) => Array.from(new Set(els.map((e) => e.dataset.bind))));
    for (const bind of binds) {
      if (tested.has(bind)) continue;
      const el = await page.$(`#cc-body [data-bind="${bind}"]`);
      if (!el) continue;                                  // hidden by a sibling's state
      const info = await el.evaluate((e) => ({
        kind: e.classList.contains('cc-seg') ? 'seg' : (e.type || e.tagName.toLowerCase()),
        value: e.classList.contains('cc-seg') ? (e.querySelector('.cc-on') || {}).dataset?.value : (e.type === 'checkbox' ? e.checked : e.value),
        min: e.min, max: e.max,
        options: e.classList.contains('cc-seg') ? Array.from(e.querySelectorAll('button')).map((b) => b.dataset.value)
          : (e.tagName === 'SELECT' ? Array.from(e.options).map((o) => o.value) : null),
      }));
      const kind = info.kind === 'select-one' ? 'select' : info.kind;
      const orig = info.value;
      let candidates;
      if (kind === 'seg' || kind === 'select') {
        candidates = info.options.filter((o) => String(o) !== String(orig) && !/^(Caladea|Carlito|FreeMono|DejaVu Sans Mono|Liberation Mono)/.test(o)).slice(0, 2);
      } else if (kind === 'checkbox') candidates = [!orig];
      else if (kind === 'color') candidates = [hashColor(bind)];
      else if (kind === 'range') {
        const min = +info.min, max = +info.max, v = +orig;
        candidates = [v + (max - min) * (v > (min + max) / 2 ? -0.3 : 0.3), min, max];
      } else { console.log(`skip ${bind} (${kind})`); continue; }
      if (!candidates.length) { console.log(`skip ${bind} (single option)`); continue; }
      tested.add(bind);
      const before = await fingerprint();
      const vBefore = JSON.stringify(await settingAt(bind));
      let changed = false, vAfter = vBefore, visual = false;
      for (const c of candidates) {
        await setControl(bind, kind, c);
        vAfter = JSON.stringify(await settingAt(bind));
        if (vAfter !== vBefore) changed = true;
        visual = (await fingerprint()) !== before;
        if (changed && visual) break;
      }
      const noVisual = /^(transcribe\.|output\.)/.test(bind);
      check(changed && (visual || noVisual), `${tab}: ${bind} (${kind}) ${vBefore} → ${vAfter}${noVisual ? '' : visual ? ', preview changed' : ', PREVIEW UNCHANGED'}`);
      await setControl(bind, kind, orig);                 // restore the baseline
      await page.click(`[data-tab="${tab}"]`);
      await page.waitForTimeout(120);
    }
  }
  const tested = new Set();
  await exercise('style');
  await exercise('motion', [['motion.highlight', 'seg', 'color']]);
  await page.click('[data-motion="karaoke"]');
  await exercise('motion', [['motion.highlight', 'seg', 'box']]);
  await exercise('style');                               // controls revealed by the motion changes
  await page.click('[data-tab="motion"]');
  await page.click('[data-motion="fade_up"]');
  await setControl('motion.highlight', 'seg', 'none');

  // ── transcript edits ──
  await page.click('[data-tab="transcript"]');
  const capText = () => page.evaluate(() => window.__editflowCaptions.state().scene.captions
    .map((c) => c.lines.map((l) => l.words.map((w) => w.text).join(' ')).join(' / ')).join(' | '));
  const t0 = await capText();
  await page.click('.cc-w[data-i="5"]');
  await page.keyboard.press('h');
  await page.waitForTimeout(150);
  const t1 = await capText();
  check(t1 !== t0 && !/\bmy\b/.test(t1.split(' | ')[1] || ''), 'transcript: H hides the selected word from the captions');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  check((await capText()) === t0, 'transcript: Ctrl+Z restores it');
  await page.dblclick('.cc-w[data-i="3"]');
  await page.fill('#cc-w-edit', 'returning');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  check(/returning/i.test(await capText()), 'transcript: double-click edit changes the caption text');
  await page.click('.cc-w[data-i="7"]');
  await page.keyboard.press('b');
  await page.waitForTimeout(150);
  const breakOk = await page.evaluate(() => {
    const S = window.__editflowCaptions.state();
    const id = S.words[7].id;
    return S.scene.captions.some((c) => c.lines[0].words[0].id === id);
  });
  check(breakOk, 'transcript: B starts a new caption at the selected word');

  // ── render + WYSIWYG ──
  await page.click('[data-tab="export"]');
  await page.click('.cc-seg[data-bind="output.codec"] button[data-value="prores"]');
  await page.click('#cc-footer [data-act="export"]');
  await page.waitForFunction(() => { const S = window.__editflowCaptions.state(); return !S.busy && (S.lastRender || (S.status && S.status.kind === 'error')); }, null, { timeout: 600000 });
  const res = await page.evaluate(() => { const S = window.__editflowCaptions.state(); return { r: S.lastRender, st: S.status, fps: S.seq.fps, w: S.seq.width, h: S.seq.height, dur: S.scene.duration }; });
  check(!!res.r, 'export: render finished ' + (res.r ? `(${res.r.frames} frames in ${Math.round(res.r.renderSeconds)} s)` : JSON.stringify(res.st)));
  if (res.r) {
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-count_packets', '-show_entries',
      'stream=codec_name,profile,width,height,r_frame_rate,nb_read_packets,pix_fmt', '-of', 'json', res.r.path]).toString()).streams[0];
    check(probe.codec_name === 'prores' && /4444/.test(probe.profile), `export: ProRes 4444 (${probe.codec_name} ${probe.profile}, ${probe.pix_fmt})`);
    check(probe.r_frame_rate === `${res.fps.num}/${res.fps.den}`, `export: exact frame rate ${probe.r_frame_rate}`);
    check(probe.width === res.w && probe.height === res.h, `export: full frame ${probe.width}x${probe.height}`);
    check(Math.abs(+probe.nb_read_packets - res.r.frames) === 0, `export: ${probe.nb_read_packets} frames written`);
    // Compare a mid-animation frame of the video with the panel's own drawing.
    const fps = res.fps.num / res.fps.den;
    for (const k of [62, 80, 101, 190, 400]) {
      const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', res.r.path, '-vf', `select=eq(n\\,${k})`,
        '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 64 * 1024 * 1024 });
      const diff = await page.evaluate(({ b64, k }) => {
        const api = window.__editflowCaptions;
        const S = api.state();
        const W = S.seq.width, H = S.seq.height;
        const t = k * S.seq.fps.den / S.seq.fps.num;
        const a = document.createElement('canvas'); a.width = W; a.height = H;
        api.drawAt(a, t);
        const da = a.getContext('2d').getImageData(0, 0, W, H).data;
        const bin = atob(b64);
        let sum = 0, n = 0, worst = 0;
        for (let i = 0; i < da.length; i += 4) {
          const ba = bin.charCodeAt(i + 3);
          if (da[i + 3] < 8 && ba < 8) continue;
          n++;
          const w = Math.min(da[i + 3], ba) / 255;
          const d = Math.abs(da[i + 3] - ba) + w * (Math.abs(da[i] - bin.charCodeAt(i)) + Math.abs(da[i + 1] - bin.charCodeAt(i + 1)) + Math.abs(da[i + 2] - bin.charCodeAt(i + 2)));
          sum += d; if (d > worst) worst = d;
        }
        return { mean: n ? sum / n : 0, n, worst };
      }, { b64: raw.toString('base64'), k });
      check(diff.mean < 3, `export: frame ${k} = preview (mean diff ${diff.mean.toFixed(2)}, worst ${diff.worst.toFixed(0)}, ${diff.n} px with ink)`);
    }
  }
  check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  const bar = await page.$('#editflow-error-bar');
  check(!bar, 'no global error banner');
  await browser.close();
  console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
