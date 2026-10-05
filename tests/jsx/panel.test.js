/**
 * Headless panel harness — imports the REAL captions-view.js with a stub
 * DOM and exercises it like a user would (open, switch tabs, drag every
 * control). Catches render throws without Premiere or a browser.
 * Run: node --test tests/jsx/panel.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CLIENT = path.join('cep-panel', 'client');

let currentEls = null; // active document registry (set by makeDocument)

function makeEl(tag) {
  const el = {
    tag, children: [], dataset: {}, style: {}, value: '',
    textContent: '', checked: false, files: [],
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, f) { f ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    listeners: {},
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    removeEventListener() {},
    querySelector(sel) {
      this._q = this._q || {};
      // #ids resolve through the shared registry so the SAME instance the
      // view wired is returned (else handler tests pass vacuously).
      const m = sel.match && sel.match(/^#([\w-]+)$/);
      if (m && currentEls && currentEls[m[1]]) return currentEls[m[1]];
      if (!this._q[sel]) this._q[sel] = makeEl('div');
      return this._q[sel];
    },
    querySelectorAll(sel) {
      // Reproduce data-tab buttons from the last innerHTML assignment so
      // tests can click through every tab for real. Results are cached per
      // html so the SAME instances the view wired are returned.
      if (sel === '[data-tab]') {
        if (this._qHtml !== this._html) {
          const out = [];
          const re = /data-tab="(\d)"/g;
          let m;
          const html = this._html || '';
          while ((m = re.exec(html))) {
            const b = makeEl('button');
            b.dataset.tab = m[1];
            out.push(b);
          }
          this._qHtml = this._html;
          this._qTabs = out;
        }
        return this._qTabs || [];
      }
      return [];
    },
    getBoundingClientRect() { return { left: 0, right: 100, width: 100, top: 0, bottom: 0 }; },
    getContext() {
      return new Proxy({}, { get: (t, p) => (p === 'measureText' ? () => ({ width: 10 }) : () => {}) });
    },
    set onclick(f) { this._oc = f; }, get onclick() { return this._oc; },
    set onchange(f) { this._oc2 = f; }, get onchange() { return this._oc2; },
    set oninput(f) { this._oi = f; }, get oninput() { return this._oi; },
    set onmousedown(f) { this._om = f; }, get onmousedown() { return this._om; },
    clientHeight: 220, clientWidth: 360, offsetParent: {},
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html || ''; },
    set(h) {
      this._html = h;
      if (currentEls) {
        const re = /id="([\w-]+)"/g;
        let m;
        while ((m = re.exec(String(h)))) {
          if (!currentEls[m[1]]) {
            const c = makeEl('div'); c.id = m[1]; currentEls[m[1]] = c;
          }
        }
      }
    },
  });
  return el;
}

function makeDocument() {
  const els = {};
  currentEls = els;
  const doc = {
    _els: els,
    head: makeEl('head'),
    body: makeEl('body'),
    getElementById(id) { return els[id] || null; },
    querySelector(sel) {
      if (sel === '#app-main') return els['app-main'] || null;
      const m = sel.match(/^#([\w-]+)$/);
      if (m) return els[m[1]] || null;
      // attribute selectors: return a generic stub element (browser would
      // match inside innerHTML; the stub tracks created ids only)
      if (sel.startsWith('[')) {
        const key = 'attr:' + sel;
        if (!els[key]) { const c = makeEl('div'); c.id = key; els[key] = c; }
        return els[key];
      }
      return null;
    },
    createElement(tag) { return makeEl(tag); },
    addEventListener() {},
    removeEventListener() {},
  };
  for (const id of ['app-main', 'hero', 'chat-scroll', 'app-footer']) {
    const el = makeEl('div'); el.id = id; els[id] = el;
  }
  // innerHTML id-tracking lives in makeEl itself now.
  const origCreate = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const el = origCreate(tag);
    let _id = '';
    Object.defineProperty(el, 'id', {
      get() { return _id; },
      set(v) { _id = v; if (v) els[v] = el; },
    });
    return el;
  };
  return doc;
}

async function loadPanel() {
  const document = makeDocument();
  const store = {};
  const sandbox = {
    console,
    document,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    sessionStorage: {
      getItem: () => null, setItem: () => {}, removeItem: () => {},
    },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    window: {},
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const files = {
    './api.js': path.join(CLIENT, 'src', 'api.js'),
    './extendscript.js': path.join(CLIENT, 'src', 'extendscript.js'),
    './state.js': path.join(CLIENT, 'src', 'state.js'),
  };
  const cache = {};
  async function loadMod(name) {
    if (cache[name]) return cache[name];
    const file = files[name] || path.join(CLIENT, 'src', name.replace('./', ''));
    const code = fs.readFileSync(file, 'utf8');
    const exp = {};
    const mod = { exports: exp };
    const req = (n) => loadMod(n);
    const fn = vm.runInContext(
      `(function(require, module, exports) { ${code.replace(/^import .*$/gm, '').replace(/export\s*\{[^}]*\};?/g, '')} })`,
      sandbox, { filename: file });
    // Collect exports manually: re-run with export capture via transform.
    const transformed = code
      .replace(/^import\s+.*?from\s+['"][^'"]+['"];?/gm, '')
      .replace(/export\s*\{([^}]*)\};?/g, (_, list) => {
        const names = list.split(',').map(s => s.trim()).filter(Boolean);
        return names.map(n => `module.exports.${n} = (typeof ${n} !== 'undefined' ? ${n} : undefined);`).join('\n');
      })
      .replace(/^export\s+(async\s+)?function\s+(\w+)/gm, 'module.exports.$2 = $1function $2');
    const fn2 = vm.runInContext(
      `(function(require, module, exports) { ${transformed} })`, sandbox, { filename: file });
    await fn2(req, mod, mod.exports);
    cache[name] = mod.exports;
    return mod.exports;
  }
  const api = await loadMod('./api.js');
  return { sandbox, api, loadMod, document };
}

test('captions view opens and Style tab renders without throwing', async () => {
  const { loadMod } = await loadPanel();
  const cc = await loadMod('./captions-view.js');
  assert.equal(typeof cc.openCaptions, 'function');
  cc.openCaptions(); // must not throw (this exact call failed live)
});

test('switching every tab renders without throwing', async () => {
  const { loadMod, document } = await loadPanel();
  const cc = await loadMod('./captions-view.js');
  cc.openCaptions();
  const view = document.getElementById('captions-view');
  assert.ok(view, 'container exists');
  for (let i = 0; i < 5; i++) {
    const btns = view.querySelectorAll('[data-tab]');
    assert.equal(btns.length, 5, 'five tab buttons, tab ' + i);
    const btn = btns[i];
    assert.ok(btn.onclick, 'tab button wired, tab ' + i);
    btn.onclick(); // real _render() of that tab — must not throw
  }
});

function fireControl(document, id, value) {
  const el = document.getElementById(id);
  assert.ok(el, 'control exists: ' + id);
  if (value !== undefined) {
    if ('value' in el) el.value = value;
    if (el.checked !== undefined && typeof value === 'boolean') el.checked = value;
  }
  if (el.oninput) el.oninput({ target: el });
  else if (el.onchange) el.onchange({ target: el });
  else if (el.onclick) el.onclick({ target: el, preventDefault() {} });
}

test('every Style control mutates without throwing', async () => {
  const { loadMod, document } = await loadPanel();
  const cc = await loadMod('./captions-view.js');
  cc.openCaptions();
  const view = document.getElementById('captions-view');
  view.querySelectorAll('[data-tab]')[2].onclick(); // Style tab
  for (const [id, val] of [
    ['cc-fontfam', null], ['cc-fontcustom', 'Verdana'], ['cc-fontbold', null],
    ['cc-caps', null], ['cc-fontsize', '120'], ['cc-textcolor', '#ff0000'],
    ['cc-strokecolor', '#00ff00'], ['cc-strokew', '4'], ['cc-shadowon', null],
    ['cc-shadowcolor', '#111111'], ['cc-shadowop', '70'], ['cc-shadowdist', '6'],
    ['cc-shadowblur', '8'], ['cc-posx', '40'], ['cc-posy', '70'],
    ['cc-boxw', '80'], ['cc-pillcolor', '#123456'], ['cc-pillop', '60'],
    ['cc-pillstrokecolor', '#abcdef'], ['cc-pillstrokew', '3'],
    ['cc-pillradius', '20'], ['cc-pilloutline', null],
  ]) fireControl(document, id, val);
});

test('every Animate control mutates without throwing', async () => {
  const { loadMod, document } = await loadPanel();
  const cc = await loadMod('./captions-view.js');
  cc.openCaptions();
  const view = document.getElementById('captions-view');
  view.querySelectorAll('[data-tab]')[3].onclick(); // Animate tab
  for (const [id, val] of [
    ['cc-animpreset', null], ['cc-intensity', '1.5'], ['cc-fadedur', '0.4'],
    ['cc-slidedist', '40'], ['cc-easing', null],
  ]) fireControl(document, id, val);
});
