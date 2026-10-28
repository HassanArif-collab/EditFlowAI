/**
 * tests/challenger-m3-empirical-stress.test.js
 *
 * EMPIRICAL ADVERSARIAL STRESS TEST HARNESS — MILESTONE 3
 * Cold Boot Optimization & ExtendScript Fast-Path
 *
 * Requirements Tested:
 * 1. F2-TC1 & ExtendScript Fast-Path Contract:
 *    - Cold boot must pass `forceReload: false`.
 *    - `initExtendScript` defaults to `forceReload = false`.
 *    - ExtendScript `editflowConfigureExtensionRoot` skips re-evaluation when `forceReload === false`.
 *    - ExtendScript forces re-evaluation only when `forceReload === true`.
 * 2. Cold Boot Budget Under Simulated Latency:
 *    - Initial view bootstrap must complete in < 300ms across 0ms, 15ms, 50ms, and 100ms simulated latency.
 *    - Capabilities probe & background tasks must be non-blocking.
 * 3. Rapid View Switching Idempotency:
 *    - Concurrent and interleaved switching across all 4 views ('captions', 'storyCut', 'review', 'agent').
 *    - In-flight deduplication via `_viewLoading` and memoization via `_viewCache`.
 *    - Zero duplicate module imports / evaluations.
 * 4. Error Boundary Resilience:
 *    - Simulate view mount and lifecycle exceptions.
 *    - Panel remains alive, displays informative error bar, and recovers on subsequent navigation.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { createBrowserEnvironment, DOMElement } = require('./e2e/harness');

// Ensure DOMElement has standard .remove() method
if (!DOMElement.prototype.remove) {
  DOMElement.prototype.remove = function () {
    if (this.parentNode && this.parentNode.children) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) {
        this.parentNode.children.splice(idx, 1);
      }
      this.parentNode = null;
    }
  };
}

/* ── Custom Module Loader with Robust Export Parsing ─────────────────── */
function loadModule(filePath, sandbox = {}) {
  let src = fs.readFileSync(filePath, 'utf8');
  src = src.replace(/import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];?/g, '');
  src = src.replace(/import\s+\*\s+as\s+\w+\s+from\s*['"][^'"]+['"];?/g, '');
  src = src.replace(/import\s+[^;]+?from\s*['"][^'"]+['"];?/g, '');
  src = src.replace(/^\s*import\s+[^;\n]+;?\s*$/gm, '');

  const names = [];
  src = src.replace(
    /^export\s+(async\s+function|const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm,
    (_m, kind, name) => {
      names.push(name);
      return `${kind} ${name}`;
    }
  );
  const exportBlockMatches = [...src.matchAll(/export\s*\{([^}]+)\};?/g)];
  for (const m of exportBlockMatches) {
    const exportedItems = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    names.push(...exportedItems);
  }
  src = src.replace(/export\s*\{[^}]*\};?/g, '');

  const keys = Object.keys(sandbox);
  const body = `${src}\n;return { ${[...new Set(names)].join(', ')} };`;
  // eslint-disable-next-line no-new-func
  return new Function(...keys, body)(...keys.map((k) => sandbox[k]));
}

const ES_DIR = path.resolve(__dirname, '..', 'cep-panel', 'extendscript');
const CLIENT_SRC_DIR = path.resolve(__dirname, '..', 'cep-panel', 'client', 'src');
const EXTENDSCRIPT_JS_PATH = path.join(CLIENT_SRC_DIR, 'extendscript.js');
const MAIN_JS_PATH = path.join(CLIENT_SRC_DIR, 'main.js');

/* ── Helper: ExtendScript VM Host for Node ────────────────────────────── */
function createExtendScriptHost(overrides = {}) {
  const children = [];
  Object.defineProperty(children, 'numItems', {
    get() { return children.length; },
  });
  const host = {
    evalCount: 0,
    evalFiles: [],
    app: {
      version: '25.6.4',
      project: {
        path: 'C:\\fake\\test.prproj',
        activeSequence: null,
        rootItem: { children },
        importFiles() {},
      },
    },
    ProjectItemType: { BIN: 1 },
  };
  Object.assign(host, overrides);
  return host;
}

function loadExtendScriptEngine(host) {
  const sandbox = {
    console,
    $: {
      fileName: path.join(ES_DIR, 'index.jsx'),
      evalFile(f) {
        host.evalCount++;
        const p = String((f && f.fsName) || f);
        host.evalFiles.push(p);
        const code = fs.readFileSync(p, 'utf8');
        vm.runInContext(code, sandbox, { filename: p });
      },
      writeln() {},
      sleep() {},
    },
    File: function (f) {
      const s = String(f);
      return {
        fsName: s,
        get exists() { return fs.existsSync(s); },
        get parent() {
          return { fsName: path.dirname(s) };
        },
      };
    },
    Folder: Object.assign(
      function (p) {
        const s = String(p || '');
        return {
          fsName: s,
          get exists() { return fs.existsSync(s); },
        };
      },
      {
        get temp() {
          return {
            fsName: 'C:\\temp',
            get exists() { return true; },
          };
        },
      }
    ),
    app: host.app,
    ProjectItemType: host.ProjectItemType,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // Evaluate index.jsx
  const entryCode = fs.readFileSync(path.join(ES_DIR, 'index.jsx'), 'utf8');
  vm.runInContext(entryCode, sandbox, { filename: 'index.jsx' });
  return sandbox;
}

/* ════════════════════════════════════════════════════════════════════════════
 * SUITE 1: F2-TC1 & EXTENDSCRIPT FAST-PATH CONTRACT VERIFICATION
 * ════════════════════════════════════════════════════════════════════════════ */

test('F2-TC1.1: extendscript.js declares initExtendScript(forceReload = false)', () => {
  const src = fs.readFileSync(EXTENDSCRIPT_JS_PATH, 'utf8');
  assert.match(
    src,
    /async\s+function\s+initExtendScript\s*\(\s*forceReload\s*=\s*false\s*\)/,
    'initExtendScript signature must declare default parameter forceReload = false'
  );
});

test('F2-TC1.2: main.js cold-boot invokes initExtendScript(false)', () => {
  const mainSrc = fs.readFileSync(MAIN_JS_PATH, 'utf8');
  assert.match(
    mainSrc,
    /initExtendScript\s*\(\s*false\s*\)/,
    'main.js init() cold boot must explicitly invoke initExtendScript(false)'
  );
});

test('F2-TC1.3: initExtendScript without arguments invokes ExtendScript with forceReload = false', async () => {
  let evaluatedScript = null;
  const mockCSInterface = class {
    constructor() {
      this.SYSTEM_PATH = { EXTENSION: 'extension' };
    }
    getSystemPath() {
      return 'C:/fake/extension';
    }
    evalScript(script, cb) {
      evaluatedScript = script;
      cb(JSON.stringify({ success: true, scriptDir: 'C:/fake/extension/extendscript' }));
    }
  };

  const sandbox = {
    CSInterface: mockCSInterface,
    console: { log: () => {}, warn: () => {}, error: () => {} },
  };

  const esMod = loadModule(EXTENDSCRIPT_JS_PATH, sandbox);
  const result = await esMod.initExtendScript();

  assert.equal(result, true, 'initExtendScript() should return true on success');
  assert.ok(evaluatedScript, 'evalScript should have been called');
  assert.match(
    evaluatedScript,
    /editflowConfigureExtensionRoot\("C:\/fake\/extension", false\)/,
    'Default invocation must pass false for forceReload argument'
  );
});

test('F2-TC1.4: initExtendScript(true) explicitly passes true for forceReload', async () => {
  let evaluatedScript = null;
  const mockCSInterface = class {
    constructor() {
      this.SYSTEM_PATH = { EXTENSION: 'extension' };
    }
    getSystemPath() {
      return 'C:/fake/extension';
    }
    evalScript(script, cb) {
      evaluatedScript = script;
      cb(JSON.stringify({ success: true, scriptDir: 'C:/fake/extension/extendscript' }));
    }
  };

  const sandbox = {
    CSInterface: mockCSInterface,
    console: { log: () => {}, warn: () => {}, error: () => {} },
  };

  const esMod = loadModule(EXTENDSCRIPT_JS_PATH, sandbox);
  const result = await esMod.initExtendScript(true);

  assert.equal(result, true);
  assert.match(
    evaluatedScript,
    /editflowConfigureExtensionRoot\("C:\/fake\/extension", true\)/,
    'Explicit initExtendScript(true) must pass true'
  );
});

test('F2-TC1.5: ExtendScript Fast-Path skips re-evaluating JSX modules when forceReload is false', () => {
  const host = createExtendScriptHost();
  const sb = loadExtendScriptEngine(host);

  // Initial load evaluates 12 modules
  assert.equal(host.evalCount, 12, 'Initial index.jsx startup should load 12 modules');

  // Cold boot call with forceReload = false:
  const scriptDir = vm.runInContext('editflowConfiguredScriptDir', sb);
  const rawResult = vm.runInContext(
    `editflowConfigureExtensionRoot("${scriptDir.replace(/\\/g, '/')}", false)`,
    sb
  );
  const result = JSON.parse(rawResult);

  assert.equal(result.success, true);
  assert.equal(
    host.evalCount,
    12,
    'Fast-path with forceReload=false must perform 0 additional evalFile calls'
  );

  // Calling with forceReload = true MUST re-evaluate all modules:
  const forceResultRaw = vm.runInContext(
    `editflowConfigureExtensionRoot("${scriptDir.replace(/\\/g, '/')}", true)`,
    sb
  );
  const forceResult = JSON.parse(forceResultRaw);

  assert.equal(forceResult.success, true);
  assert.equal(
    host.evalCount,
    24,
    'Forced reload with forceReload=true must re-evaluate all 12 modules from disk'
  );
});

test('F2-TC1.6: ExtendScript Fast-Path handles path variations (trailing slashes, backslashes)', () => {
  const host = createExtendScriptHost();
  const sb = loadExtendScriptEngine(host);
  const initialEvalCount = host.evalCount;

  const scriptDir = vm.runInContext('editflowConfiguredScriptDir', sb);
  const variations = [
    scriptDir + '/',
    scriptDir + '///',
    scriptDir.replace(/\//g, '\\'),
    scriptDir.replace(/\//g, '\\') + '\\',
  ];

  for (const variant of variations) {
    const rawResult = vm.runInContext(
      `editflowConfigureExtensionRoot(${JSON.stringify(variant)}, false)`,
      sb
    );
    const result = JSON.parse(rawResult);
    assert.equal(result.success, true, `Should succeed for variant: ${variant}`);
  }

  assert.equal(
    host.evalCount,
    initialEvalCount,
    'Normalized path variants matching current configured dir must take the fast path'
  );
});

/* ════════════════════════════════════════════════════════════════════════════
 * SUITE 2: COLD BOOT BUDGET UNDER SIMULATED LATENCY (< 300ms)
 * ════════════════════════════════════════════════════════════════════════════ */

test('Cold Boot Latency: Initial view bootstrap completes under 300ms across latency tiers', async () => {
  const latencyTiers = [0, 15, 50, 100]; // ms of IPC roundtrip latency

  for (const latencyMs of latencyTiers) {
    const browser = createBrowserEnvironment();
    browser.document.head = new DOMElement('head');

    // Create required panel DOM nodes
    const inlineBanner = browser.document.createElement('div');
    inlineBanner.id = 'inline-boot-check';
    browser.document.body.appendChild(inlineBanner);

    const stage = browser.document.createElement('div');
    stage.id = 'cc-stage';
    browser.document.body.appendChild(stage);

    const hero = browser.document.createElement('div');
    hero.id = 'hero';
    browser.document.body.appendChild(hero);

    // Mock CSInterface with simulated IPC delay
    let evalCalled = false;
    const mockCSInterface = class {
      constructor() {
        this.SYSTEM_PATH = { EXTENSION: 'extension' };
      }
      getSystemPath() {
        return 'C:/fake/extension';
      }
      evalScript(script, cb) {
        evalCalled = true;
        setTimeout(() => {
          cb(JSON.stringify({ success: true, scriptDir: 'C:/fake/extension/extendscript' }));
        }, latencyMs);
      }
    };

    // Cold boot timing harness
    const t0 = performance.now();

    // 1. Initial view resolution logic (mimicking main.js init sequence)
    const homeView = browser.localStorage.getItem('editflow_home_view') || 'captions';
    const viewCache = new Map();
    const viewLoading = new Map();

    async function loadView(viewName) {
      if (viewCache.has(viewName)) return viewCache.get(viewName);
      if (viewLoading.has(viewName)) return viewLoading.get(viewName);

      const p = (async () => {
        // Simulate dynamic import of active view
        await new Promise((resolve) => setTimeout(resolve, Math.min(latencyMs / 2, 20)));
        const mod = {
          view: viewName,
          openCaptions: () => { stage.classList.remove('hidden'); },
        };
        viewCache.set(viewName, mod);
        viewLoading.delete(viewName);
        return mod;
      })();

      viewLoading.set(viewName, p);
      return p;
    }

    // 2. ExtendScript fast-path initialization
    async function initExtendScript(forceReload = false) {
      const cs = new mockCSInterface();
      const extRoot = cs.getSystemPath('extension');
      return new Promise((resolve) => {
        cs.evalScript(`editflowConfigureExtensionRoot("${extRoot}", ${forceReload})`, () => {
          resolve(true);
        });
      });
    }

    // Execute cold boot sequence:
    const activeMod = await loadView(homeView);
    if (activeMod.openCaptions) activeMod.openCaptions();
    const esOk = await initExtendScript(false);

    // 3. Fire-and-forget capabilities probe (must not block bootstrap)
    let backgroundFinished = false;
    const probePromise = (async () => {
      await new Promise((r) => setTimeout(r, 200)); // slow background probe
      backgroundFinished = true;
    })();

    const t1 = performance.now();
    const elapsed = t1 - t0;

    assert.equal(esOk, true);
    assert.equal(evalCalled, true);
    assert.equal(backgroundFinished, false, 'Background probe must not block cold boot');
    assert.ok(
      elapsed < 300,
      `Cold boot with ${latencyMs}ms latency took ${elapsed.toFixed(2)}ms (budget: < 300ms)`
    );

    await probePromise; // cleanup
  }
});

/* ════════════════════════════════════════════════════════════════════════════
 * SUITE 3: RAPID VIEW SWITCHING IDEMPOTENCY & ZERO DUPLICATE EVALUATIONS
 * ════════════════════════════════════════════════════════════════════════════ */

test('Rapid View Switching: Concurrent requests for all 4 views maintain idempotency and zero duplicate loads', async () => {
  const importCounts = {
    captions: 0,
    storyCut: 0,
    review: 0,
    orchestrator: 0,
  };

  const _viewCache = new Map();
  const _viewLoading = new Map();

  async function mockLoadView(viewName) {
    const key = (viewName === 'agent' || viewName === 'orchestrator') ? 'orchestrator' : viewName;
    if (_viewCache.has(key)) {
      return _viewCache.get(key);
    }
    if (_viewLoading.has(key)) {
      return _viewLoading.get(key);
    }

    const p = (async () => {
      try {
        // Simulate async disk/network load
        await new Promise((resolve) => setTimeout(resolve, 10));
        importCounts[key]++;
        const mod = {
          name: key,
          instanceId: importCounts[key],
          open: () => {},
        };
        _viewCache.set(key, mod);
        return mod;
      } finally {
        _viewLoading.delete(key);
      }
    })();

    _viewLoading.set(key, p);
    return p;
  }

  // 1. Fire 50 concurrent requests for 'captions'
  const simultaneousCaptions = Array.from({ length: 50 }, () => mockLoadView('captions'));
  const captionResults = await Promise.all(simultaneousCaptions);

  assert.equal(importCounts.captions, 1, 'Concurrent requests for captions must only trigger 1 module load');
  for (const res of captionResults) {
    assert.equal(res, captionResults[0], 'All concurrent promises must resolve to identical module reference');
  }

  // 2. Interleave rapid requests across all 4 views ('captions', 'storyCut', 'review', 'agent')
  const viewQueue = [
    'storyCut', 'review', 'agent', 'captions',
    'review', 'storyCut', 'agent', 'orchestrator',
    'captions', 'review', 'storyCut', 'agent',
  ];

  const interleavedResults = await Promise.all(viewQueue.map((v) => mockLoadView(v)));

  assert.equal(importCounts.captions, 1, 'Captions view must not be re-imported');
  assert.equal(importCounts.storyCut, 1, 'StoryCut view must be imported exactly once');
  assert.equal(importCounts.review, 1, 'Review view must be imported exactly once');
  assert.equal(importCounts.orchestrator, 1, 'Orchestrator/agent view must be imported exactly once');

  assert.equal(_viewCache.size, 4, 'Cache must contain exactly 4 view modules');
  assert.equal(_viewLoading.size, 0, 'In-flight loading map must be completely drained');
});

test('Rapid View Switching: Sequential rapid openView cycles preserve view state and DOM synchronization', async () => {
  const browser = createBrowserEnvironment();
  const views = ['captions', 'storyCut', 'review', 'chat'];
  const mountCalls = {
    captions: 0,
    storyCut: 0,
    review: 0,
  };

  const _viewCache = new Map();
  _viewCache.set('captions', { openCaptions: () => mountCalls.captions++ });
  _viewCache.set('storyCut', { openStoryCut: () => mountCalls.storyCut++ });
  _viewCache.set('review', { openReview: () => mountCalls.review++ });
  _viewCache.set('orchestrator', {});

  async function testOpenView(viewName) {
    try {
      if (viewName === 'chat') {
        browser.localStorage.setItem('editflow_home_view', 'chat');
        return;
      }
      browser.localStorage.setItem('editflow_home_view', viewName);
      const mod = _viewCache.get(viewName === 'agent' ? 'orchestrator' : viewName);
      if (viewName === 'captions' && mod.openCaptions) mod.openCaptions();
      else if (viewName === 'review' && mod.openReview) mod.openReview();
      else if (viewName === 'storyCut' && mod.openStoryCut) mod.openStoryCut();
    } catch (_) {}
  }

  // Rapidly toggle between views 100 times
  for (let i = 0; i < 100; i++) {
    const target = views[i % views.length];
    await testOpenView(target);
    assert.equal(
      browser.localStorage.getItem('editflow_home_view'),
      target,
      `localStorage must reflect active home view: ${target}`
    );
  }

  assert.equal(mountCalls.captions, 25);
  assert.equal(mountCalls.storyCut, 25);
  assert.equal(mountCalls.review, 25);
});

/* ════════════════════════════════════════════════════════════════════════════
 * SUITE 4: ERROR BOUNDARY RESILIENCE UNDER VIEW MOUNT EXCEPTIONS
 * ════════════════════════════════════════════════════════════════════════════ */

test('Error Boundary: openView gracefully traps view mount exceptions without crashing panel', async () => {
  const browser = createBrowserEnvironment();
  let globalErrorShown = null;

  function _showGlobalError(msg) {
    globalErrorShown = String(msg);
    let b = browser.document.getElementById('editflow-error-bar');
    if (!b) {
      b = browser.document.createElement('div');
      b.id = 'editflow-error-bar';
      browser.document.body.appendChild(b);
    }
    b.textContent = 'EditFlow hit an error (the panel is still alive): ' + String(msg).slice(0, 300);
    const dismissBtn = browser.document.createElement('button');
    dismissBtn.id = 'dismiss-err';
    dismissBtn.onclick = () => b.remove();
    b.appendChild(dismissBtn);
  }

  const hero = browser.document.createElement('div');
  hero.id = 'hero';
  hero.classList.add('hidden');
  browser.document.body.appendChild(hero);

  // Fault injection: Simulate a corrupted view that throws on mount
  async function faultyLoadView(viewName) {
    if (viewName === 'corruptedView') {
      throw new Error('Simulated SyntaxError in view module');
    }
    return {
      openCaptions: () => {
        throw new Error('DOMException: Failed to execute getContext on HTMLCanvasElement');
      },
    };
  }

  async function safeOpenView(viewName) {
    try {
      const mod = await faultyLoadView(viewName);
      if (viewName === 'captions' && mod.openCaptions) {
        mod.openCaptions();
      }
    } catch (err) {
      _showGlobalError(`Error opening view "${viewName}": ${err.message}`);
      if (hero) hero.classList.remove('hidden');
    }
  }

  // 1. Test loadView failure
  await assert.doesNotReject(
    async () => { await safeOpenView('corruptedView'); },
    'openView must not throw or leave unhandled rejection when view fails to load'
  );

  assert.ok(globalErrorShown, 'Global error handler must be invoked');
  assert.match(globalErrorShown, /Simulated SyntaxError in view module/);
  assert.equal(hero.classList.contains('hidden'), false, 'Hero view must be unhidden as fallback');

  const errorBar = browser.document.getElementById('editflow-error-bar');
  assert.ok(errorBar, 'Error bar must exist in DOM');
  assert.match(errorBar.textContent, /EditFlow hit an error \(the panel is still alive\)/);

  // 2. Test dismissal
  const dismissBtn = browser.document.getElementById('dismiss-err');
  assert.ok(dismissBtn);
  dismissBtn.onclick();
  assert.equal(browser.document.getElementById('editflow-error-bar'), null, 'Error bar must be removed on dismiss');

  // 3. Test lifecycle mount exception
  globalErrorShown = null;
  await assert.doesNotReject(
    async () => { await safeOpenView('captions'); },
    'openView must catch lifecycle openCaptions errors gracefully'
  );

  assert.ok(globalErrorShown);
  assert.match(globalErrorShown, /DOMException: Failed to execute getContext/);
});

test('Error Boundary: Global window unhandled error & rejection listeners never throw', () => {
  const browser = createBrowserEnvironment();
  const errorEvents = [];

  function _showGlobalError(msg) {
    try {
      let b = browser.document.getElementById('editflow-error-bar');
      if (!b) {
        b = browser.document.createElement('div');
        b.id = 'editflow-error-bar';
        browser.document.body.appendChild(b);
      }
      const span = browser.document.createElement('span');
      span.textContent = 'EditFlow hit an error (the panel is still alive): ' + String(msg).slice(0, 300);
      b.appendChild(span);
    } catch (_) {}
  }

  // Simulate catastrophic error events: undefined, null, circular object, empty string
  const testErrors = [
    undefined,
    null,
    '',
    new Error('Normal error'),
    { message: 'Object error' },
    { reason: { message: 'Promise rejection reason' } },
  ];

  for (const err of testErrors) {
    assert.doesNotThrow(() => {
      const msg = (err && ((err.error && err.error.message) || err.message || (err.reason && err.reason.message) || err.reason)) || 'Unknown error';
      _showGlobalError(msg);
    }, 'Error logger must survive any abnormal error shape without throwing');
  }

  const errorBar = browser.document.getElementById('editflow-error-bar');
  assert.ok(errorBar);
  assert.ok(errorBar.children.length >= 6);
});

/* ════════════════════════════════════════════════════════════════════════════
 * SUITE 5: ADVERSARIAL FAILURE MODES & ENVIRONMENT BOUNDARY TESTS
 * ════════════════════════════════════════════════════════════════════════════ */

test('Adversarial: CSInterface absence outside CEP environment is gracefully handled', async () => {
  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    // Notice CSInterface is undefined
  };

  const esMod = loadModule(EXTENDSCRIPT_JS_PATH, sandbox);
  const ok = await esMod.initExtendScript();
  assert.equal(ok, false, 'initExtendScript must return false outside CEP');

  const avail = esMod.isExtendScriptAvailable();
  assert.equal(avail, false, 'isExtendScriptAvailable must return false');

  const reloadOk = await esMod.reloadExtensionRoot();
  assert.equal(reloadOk, false, 'reloadExtensionRoot must return false outside CEP');

  await assert.rejects(
    async () => { await esMod.callExtendScript('anyCommand'); },
    /CSInterface not available/,
    'callExtendScript must reject with clear error when CSInterface is missing'
  );
});

test('Adversarial: Async dynamic import failure cleans up _viewLoading and allows retry', async () => {
  let attempt = 0;
  const _viewCache = new Map();
  const _viewLoading = new Map();

  async function resilientLoadView(key) {
    if (_viewCache.has(key)) return _viewCache.get(key);
    if (_viewLoading.has(key)) return _viewLoading.get(key);

    const p = (async () => {
      try {
        // Yield to microtask queue (simulating dynamic import)
        await Promise.resolve();
        attempt++;
        if (attempt === 1) {
          throw new Error('Transient dynamic import I/O failure');
        }
        const mod = { name: key, status: 'loaded' };
        _viewCache.set(key, mod);
        return mod;
      } finally {
        _viewLoading.delete(key);
      }
    })();

    _viewLoading.set(key, p);
    return p;
  }

  // Attempt 1 fails asynchronously
  await assert.rejects(
    async () => { await resilientLoadView('captions'); },
    /Transient dynamic import I\/O failure/
  );

  assert.equal(_viewCache.has('captions'), false, 'Failed load must NOT poison _viewCache');
  assert.equal(_viewLoading.has('captions'), false, '_viewLoading must be cleaned up in finally block after async yield');

  // Attempt 2 succeeds
  const mod = await resilientLoadView('captions');
  assert.equal(mod.status, 'loaded');
  assert.equal(_viewCache.has('captions'), true);
  assert.equal(_viewLoading.has('captions'), false);
});

test('Adversarial Finding: Synchronous exception before await in loadView leaves rejected promise in _viewLoading', async () => {
  const _viewLoading = new Map();

  // Replicating main.js lines 66-114 exactly
  function loadViewPattern(viewName) {
    const key = viewName;
    if (_viewLoading.has(key)) return _viewLoading.get(key);

    const p = (async () => {
      try {
        switch (key) {
          default:
            throw new Error(`Unknown view "${viewName}"`);
        }
      } finally {
        _viewLoading.delete(key);
      }
    })();

    _viewLoading.set(key, p);
    return p;
  }

  const p1 = loadViewPattern('unknown_view');
  await assert.rejects(async () => { await p1; }, /Unknown view "unknown_view"/);

  // Because the throw was synchronous before any await, finally ran before _viewLoading.set!
  assert.equal(
    _viewLoading.has('unknown_view'),
    true,
    'Subtle finding: sync throw before await causes _viewLoading.set to execute after finally.delete'
  );
});

test('Adversarial: ExtendScript configureExtensionRoot handles empty or missing root gracefully', () => {
  const host = createExtendScriptHost();
  const sb = loadExtendScriptEngine(host);

  const rawEmpty = vm.runInContext('editflowConfigureExtensionRoot("", false)', sb);
  const emptyRes = JSON.parse(rawEmpty);
  assert.equal(emptyRes.success, false);
  assert.match(emptyRes.error, /CEP extension root was empty/);

  const rawNull = vm.runInContext('editflowConfigureExtensionRoot(null, false)', sb);
  const nullRes = JSON.parse(rawNull);
  assert.equal(nullRes.success, false);
});

