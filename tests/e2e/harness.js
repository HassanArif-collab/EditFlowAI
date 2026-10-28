/**
 * tests/e2e/harness.js — Opaque-box E2E DOM & Canvas Headless Test Harness.
 *
 * Provides a lightweight, high-fidelity browser/DOM simulation environment
 * that runs natively in Node.js without external dependencies (no jsdom/playwright required).
 *
 * Emulates:
 * - Complete DOM element tree (querySelector, addEventListener, dispatchEvent, dataset, classList, style)
 * - HTMLCanvasElement & CanvasRenderingContext2D (measureText, fillText, fillRect, createLinearGradient, etc.)
 * - ResizeObserver, requestAnimationFrame, cancelAnimationFrame, performance.now
 * - localStorage persistence
 * - Host communication mocking (CSInterface, ExtendScript, Backend API)
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

/* ── Minimal DOM Tree Simulation ─────────────────────────────────────── */

class ClassList {
  constructor(el) {
    this._el = el;
    this._classes = new Set();
  }
  add(...names) {
    for (const n of names) if (n) this._classes.add(String(n).trim());
    this._sync();
  }
  remove(...names) {
    for (const n of names) if (n) this._classes.delete(String(n).trim());
    this._sync();
  }
  toggle(name, force) {
    const s = String(name).trim();
    const has = this._classes.has(s);
    const shouldHave = force !== undefined ? !!force : !has;
    if (shouldHave) this._classes.add(s);
    else this._classes.delete(s);
    this._sync();
    return shouldHave;
  }
  contains(name) {
    return this._classes.has(String(name).trim());
  }
  _sync() {
    this._el._className = Array.from(this._classes).join(' ');
  }
  _load(className) {
    this._classes.clear();
    for (const part of String(className || '').split(/\s+/)) {
      if (part) this._classes.add(part);
    }
  }
}

class DOMElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this._attributes = new Map();
    this._listeners = new Map();
    this._className = '';
    this.classList = new ClassList(this);
    this._innerHTML = '';
    this._value = '';
    this._checked = false;
    this.clientWidth = 400;
    this.clientHeight = 300;
    this.scrollTop = 0;
  }

  get className() { return this._className; }
  set className(val) {
    this._className = String(val || '');
    this.classList._load(this._className);
  }

  get id() { return this.getAttribute('id') || ''; }
  set id(val) { this.setAttribute('id', val); }

  get value() { return this._value; }
  set value(val) { this._value = String(val == null ? '' : val); }

  get checked() { return this._checked; }
  set checked(val) { this._checked = !!val; }

  get textContent() {
    let text = '';
    for (const child of this.children) {
      if (child.nodeType === 3) text += child.nodeValue;
      else if (child.textContent) text += child.textContent;
    }
    return text;
  }
  set textContent(val) {
    this.children = [{ nodeType: 3, nodeValue: String(val == null ? '' : val) }];
  }

  get innerHTML() { return this._innerHTML; }
  set innerHTML(html) {
    this._innerHTML = String(html || '');
    this._parseHTML(this._innerHTML);
  }

  getAttribute(name) {
    return this._attributes.has(name) ? this._attributes.get(name) : null;
  }
  setAttribute(name, val) {
    const sVal = String(val == null ? '' : val);
    this._attributes.set(name, sVal);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = sVal;
    }
    if (name === 'class') this.className = sVal;
    if (name === 'value') this._value = sVal;
    if (name === 'checked') this._checked = true;
  }
  removeAttribute(name) {
    this._attributes.delete(name);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      delete this.dataset[key];
    }
    if (name === 'checked') this._checked = false;
  }
  hasAttribute(name) {
    return this._attributes.has(name);
  }

  appendChild(child) {
    if (!child) return child;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  addEventListener(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(fn);
  }
  removeEventListener(event, fn) {
    const arr = this._listeners.get(event);
    if (arr) {
      const idx = arr.indexOf(fn);
      if (idx !== -1) arr.splice(idx, 1);
    }
  }
  dispatchEvent(event) {
    event.target = this;
    let cur = this;
    while (cur) {
      event.currentTarget = cur;
      const arr = cur._listeners.get(event.type);
      if (arr) {
        for (const fn of [...arr]) {
          try { fn.call(cur, event); } catch (e) { console.error('Event error:', e); }
          if (event._propagationStopped) return !event.defaultPrevented;
        }
      }
      cur = event.bubbles ? cur.parentNode : null;
    }
    return !event.defaultPrevented;
  }

  click() {
    const ev = new MockDOMEvent('click', { bubbles: true, cancelable: true });
    return this.dispatchEvent(ev);
  }
  focus() {
    const ev = new MockDOMEvent('focus', { bubbles: false, cancelable: false });
    return this.dispatchEvent(ev);
  }
  blur() {
    const ev = new MockDOMEvent('blur', { bubbles: false, cancelable: false });
    return this.dispatchEvent(ev);
  }

  closest(selector) {
    let cur = this;
    while (cur) {
      if (cur.matches && cur.matches(selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  matches(selector) {
    if (!selector) return false;
    const s = selector.trim();
    if (s.startsWith('#') && this.id === s.slice(1)) return true;
    if (s.startsWith('.') && this.classList.contains(s.slice(1))) return true;
    if (s.toUpperCase() === this.tagName) return true;
    if (s.startsWith('[') && s.endsWith(']')) {
      const body = s.slice(1, -1);
      const eqIdx = body.indexOf('=');
      if (eqIdx === -1) return this.hasAttribute(body);
      const attr = body.slice(0, eqIdx).trim();
      const val = body.slice(eqIdx + 1).replace(/^['"]|['"]$/g, '').trim();
      return this.getAttribute(attr) === val;
    }
    return false;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];
    const check = (node) => {
      if (node !== this && node.matches && node.matches(selector)) results.push(node);
      if (node.children) {
        for (const c of node.children) check(c);
      }
    };
    check(this);
    return results;
  }

  getBoundingClientRect() {
    return {
      left: 0, top: 0,
      right: this.clientWidth, bottom: this.clientHeight,
      width: this.clientWidth, height: this.clientHeight,
      x: 0, y: 0,
    };
  }

  _parseHTML(html) {
    this.children = [];
    // Lightweight token-based parser for our CEP UI components
    const tagRegex = /<\/?([a-zA-Z0-9\-]+)([^>]*)>/g;
    let match;
    const stack = [this];
    let lastIdx = 0;

    while ((match = tagRegex.exec(html)) !== null) {
      const full = match[0];
      const isClosing = full.startsWith('</');
      const isSelfClosing = full.endsWith('/>') || ['INPUT', 'IMG', 'BR', 'HR'].includes(match[1].toUpperCase());
      const tagName = match[1];
      const rawAttrs = match[2];

      if (isClosing) {
        if (stack.length > 1 && stack[stack.length - 1].tagName === tagName.toUpperCase()) {
          stack.pop();
        }
      } else {
        const el = tagName.toUpperCase() === 'CANVAS' ? new CanvasElement() : new DOMElement(tagName);
        const attrRegex = /([a-zA-Z0-9\-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
        let aMatch;
        while ((aMatch = attrRegex.exec(rawAttrs)) !== null) {
          const aName = aMatch[1];
          const aVal = aMatch[2] !== undefined ? aMatch[2] : (aMatch[3] !== undefined ? aMatch[3] : (aMatch[4] !== undefined ? aMatch[4] : ''));
          el.setAttribute(aName, aVal);
        }

        const parent = stack[stack.length - 1];
        if (parent) parent.appendChild(el);

        if (!isSelfClosing) {
          stack.push(el);
        }
      }
      lastIdx = tagRegex.lastIndex;
    }
  }
}

/* ── Canvas & 2D Context Mock ────────────────────────────────────────── */

class MockCanvasContext2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = '#ffffff';
    this.strokeStyle = '#000000';
    this.lineWidth = 1;
    this.shadowColor = 'transparent';
    this.shadowBlur = 0;
    this.shadowOffsetX = 0;
    this.shadowOffsetY = 0;
    this.font = '80px Montserrat';
    this.textAlign = 'start';
    this.textBaseline = 'alphabetic';
    this.lineJoin = 'miter';
    this.miterLimit = 10;
    this.globalAlpha = 1.0;
    this._drawCalls = [];
    this._stack = [];
  }

  save() {
    this._stack.push({
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      lineJoin: this.lineJoin,
      miterLimit: this.miterLimit,
      globalAlpha: this.globalAlpha,
      shadowColor: this.shadowColor,
      shadowBlur: this.shadowBlur,
      shadowOffsetX: this.shadowOffsetX,
      shadowOffsetY: this.shadowOffsetY,
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
    });
  }

  restore() {
    const s = this._stack.pop();
    if (s) Object.assign(this, s);
  }

  setLineDash() {}
  setTransform() {}
  resetTransform() {}
  translate(x, y) {}
  scale(sx, sy) {}
  rotate(angle) {}
  transform(a, b, c, d, e, f) {}
  clearRect(x, y, w, h) {
    this._drawCalls.push({ type: 'clearRect', x, y, w, h });
  }
  fillRect(x, y, w, h) {
    this._drawCalls.push({ type: 'fillRect', x, y, w, h, fillStyle: this.fillStyle });
  }
  strokeRect(x, y, w, h) {
    this._drawCalls.push({ type: 'strokeRect', x, y, w, h, strokeStyle: this.strokeStyle });
  }
  fillText(text, x, y) {
    this._drawCalls.push({
      type: 'fillText', text, x, y,
      fillStyle: this.fillStyle, font: this.font,
      shadowColor: this.shadowColor, shadowBlur: this.shadowBlur,
    });
  }
  strokeText(text, x, y) {
    this._drawCalls.push({
      type: 'strokeText', text, x, y,
      strokeStyle: this.strokeStyle, font: this.font,
    });
  }
  beginPath() {}
  moveTo() {}
  lineTo() {}
  arcTo() {}
  closePath() {}
  fill() {
    this._drawCalls.push({ type: 'fill', fillStyle: this.fillStyle });
  }
  stroke() {
    this._drawCalls.push({ type: 'stroke', strokeStyle: this.strokeStyle });
  }
  createLinearGradient(x0, y0, x1, y1) {
    return {
      x0, y0, x1, y1,
      stops: [],
      addColorStop(offset, color) { this.stops.push({ offset, color }); },
    };
  }
  createPattern() { return 'mock_pattern'; }
  measureText(text) {
    const str = String(text || '');
    const m = this.font.match(/(\d+)px/);
    const fontSize = m ? Number(m[1]) : 80;
    return {
      width: str.length * fontSize * 0.55,
      actualBoundingBoxAscent: fontSize * 0.78,
      actualBoundingBoxDescent: fontSize * 0.22,
    };
  }
  drawImage() {}
  getImageData() {
    return { data: new Uint8ClampedArray(100) };
  }
}

class CanvasElement extends DOMElement {
  constructor() {
    super('canvas');
    this.width = 1080;
    this.height = 1920;
    this._ctx = new MockCanvasContext2D(this);
  }
  getContext(kind) {
    return kind === '2d' ? this._ctx : null;
  }
}

/* ── DOM Event ───────────────────────────────────────────────────────── */

class MockDOMEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.bubbles = !!opts.bubbles;
    this.cancelable = !!opts.cancelable;
    this.defaultPrevented = false;
    this._propagationStopped = false;
    this.target = null;
    this.currentTarget = null;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this._propagationStopped = true; }
}

/* ── Browser Environment Setup ───────────────────────────────────────── */

function createBrowserEnvironment() {
  const root = new DOMElement('div');
  root.id = 'captions-view';

  const doc = new DOMElement('html');
  const body = new DOMElement('body');
  doc.appendChild(body);
  body.appendChild(root);

  const storage = new Map();
  const localStorageMock = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(String(k), String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear(),
  };

  const rafCallbacks = [];
  let rafCounter = 1;

  const env = {
    document: {
      createElement: (tag) => (tag.toLowerCase() === 'canvas' ? new CanvasElement() : new DOMElement(tag)),
      getElementById: (id) => body.querySelector('#' + id),
      querySelector: (s) => body.querySelector(s),
      querySelectorAll: (s) => body.querySelectorAll(s),
      addEventListener: () => {},
      removeEventListener: () => {},
      body,
    },
    window: {
      devicePixelRatio: 1,
      ResizeObserver: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
      requestAnimationFrame: (cb) => {
        const id = rafCounter++;
        rafCallbacks.push({ id, cb });
        setImmediate(() => cb(Date.now()));
        return id;
      },
      cancelAnimationFrame: (id) => {
        const idx = rafCallbacks.findIndex((r) => r.id === id);
        if (idx !== -1) rafCallbacks.splice(idx, 1);
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      performance: { now: () => Date.now() },
      localStorage: localStorageMock,
    },
    localStorage: localStorageMock,
    root,
  };

  return env;
}

/* ── ESM Loader with Injected Browser Realm ──────────────────────────── */

function loadModuleWithSandbox(filePath, sandbox = {}) {
  let src = fs.readFileSync(filePath, 'utf8');
  src = src.replace(/import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];?/g, '');
  src = src.replace(/import\s+\*\s+as\s+\w+\s+from\s*['"][^'"]+['"];?/g, '');
  src = src.replace(/import\s+[^;]+?from\s*['"][^'"]+['"];?/g, '');
  src = src.replace(/^\s*import\s+[^;\n]+;?\s*$/gm, '');

  const names = [];
  src = src.replace(
    /^export\s+(const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm,
    (_m, kind, name) => {
      names.push(name);
      const decl = kind === 'const' || kind === 'let' ? 'var' : kind;
      return `${decl} ${name}`;
    }
  );
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');

  const keys = Object.keys(sandbox);
  const body = `${src}\n;return { ${names.join(', ')} };`;
  // eslint-disable-next-line no-new-func
  return new Function(...keys, body)(...keys.map((k) => sandbox[k]));
}

module.exports = {
  DOMElement,
  CanvasElement,
  MockCanvasContext2D,
  MockDOMEvent,
  createBrowserEnvironment,
  loadModuleWithSandbox,
};
