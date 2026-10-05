/**
 * ExtendScript harness — runs the real cep-panel/extendscript/*.jsx in Node
 * with a stubbed Premiere host, so panel<->Premiere logic is tested without
 * opening Premiere. Catches the bug class that bit us live
 * ("capabilityProbe is undefined": file-scoped `var` invisible to the
 * dispatcher; missing dispatch cases; EDL op routing).
 *
 * Run: node --test tests/jsx/
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ES_DIR = path.join(__dirname, '..', '..', 'cep-panel', 'extendscript');

function makeHost(overrides = {}) {
  const imported = [];
  // A real Array: ExtendScript collections are indexed ([i]) and counted
  // (.numItems) — a plain object stub breaks child[childCountAfter - 1].
  const children = [];
  Object.defineProperty(children, 'numItems', {
    get() { return children.length; },
  });
  const host = {
    imported,
    children,
    failCaption: false,
    app: {
      version: '25.6.4',
      project: {
        path: 'G:\\fake\\test.prproj',
        activeSequence: null, // set below (needs closure over host)
        rootItem: { children },
        importFiles(paths) { imported.push(...paths); },
      },
    },
    ProjectItemType: { BIN: 1 },
  };
  host.app.project.activeSequence = {
    createCaptionTrack(item) {
      if (host.failCaption) throw new Error('not a function in this build');
      host.captionCreated = item;
      return 'TRACK_OK';
    },
  };
  Object.assign(host, overrides);
  return host;
}

function loadEngine(host) {
  const sandbox = {
    console,
    $: {
      fileName: path.join(ES_DIR, 'index.jsx'),
      evalFile(f) {
        const p = String((f && f.fsName) || f);
        const code = fs.readFileSync(p, 'utf8');
        vm.runInContext(code, sandbox, { filename: p });
      },
      writeln() {},
      sleep() {},
    },
  // NOTE: plain `function` (not shorthand methods) — ExtendScript calls
  // `new File(path)`, and shorthand methods cannot be constructed.
  File: function (f) { return { fsName: String(f), exists: fs.existsSync(String(f)) }; },
  Folder: function () { return { fsName: '' }; },
    app: host.app,
    ProjectItemType: host.ProjectItemType,
    qe: undefined,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // Mirror index.jsx boot: evaluate the entry point, which loads all modules.
  const entry = fs.readFileSync(path.join(ES_DIR, 'index.jsx'), 'utf8');
  vm.runInContext(entry, sandbox, { filename: 'index.jsx' });
  return sandbox;
}

function dispatch(sandbox, command, payload) {
  const script = `editflowDispatch(${JSON.stringify(command)}, ${JSON.stringify(JSON.stringify(payload || {}))})`;
  const raw = vm.runInContext(script, sandbox);
  return JSON.parse(raw);
}

test('all modules load with zero load errors', () => {
  const sb = loadEngine(makeHost());
  const res = dispatch(sb, 'probeCapabilities', {});
  assert.equal(res.success, true);
  assert.ok(res.capabilities, 'probe returns capabilities');
});

test('probe reports the caption keys (Tier-1 contract)', () => {
  const sb = loadEngine(makeHost());
  const caps = dispatch(sb, 'probeCapabilities', {}).capabilities;
  for (const k of ['caption_track_api', 'project_import_files', 'premiere_version',
                   'qe_available', 'active_sequence']) {
    assert.ok(k in caps, `missing key ${k}`);
  }
  assert.equal(caps.caption_track_api, true);
  assert.equal(caps.project_import_files, true);
  assert.equal(caps.premiere_version, '25.6.4');
});

test('importCaptionsFromSRT creates a caption track', () => {
  const host = makeHost();
  const sb = loadEngine(host);
  host.children.push({ name: 'captions.srt' }); // simulate fresh import
  const res = dispatch(sb, 'importCaptionsFromSRT', { srt_path: 'G:\\caps\\captions.srt' });
  assert.equal(res.success, true);
  assert.equal(res.method, 'createCaptionTrack');
  assert.deepEqual(host.imported, ['G:\\caps\\captions.srt']);
  assert.equal(host.captionCreated.name, 'captions.srt');
});

test('importCaptionsFromSRT falls back to importOnly without the API', () => {
  const host = makeHost({ failCaption: true });
  const sb = loadEngine(host);
  host.children.push({ name: 'captions.srt' });
  const res = dispatch(sb, 'importCaptionsFromSRT', { srt_path: 'G:\\caps\\captions.srt' });
  assert.equal(res.success, true);
  assert.equal(res.method, 'importOnly');
  assert.match(res.warning, /createCaptionTrack failed/);
});

test('importCaptionsFromSRT rejects missing path and missing sequence', () => {
  const sb = loadEngine(makeHost());
  assert.match(dispatch(sb, 'importCaptionsFromSRT', {}).error, /No srt_path/);
  const host2 = makeHost();
  host2.app.project.activeSequence = null;
  const sb2 = loadEngine(host2);
  assert.match(dispatch(sb2, 'importCaptionsFromSRT', { srt_path: 'x.srt' }).error, /No active sequence/);
});

test('callModule routes to module functions (hot path for future commands)', () => {
  const host = makeHost();
  const sb = loadEngine(host);
  host.children.push({ name: 'c.srt' });
  const res = dispatch(sb, 'callModule', { module: 'captionsManager', fn: 'importSRTAsCaptionTrack', srt_path: 'G:\\c.srt' });
  assert.equal(res.success, true);
  assert.equal(res.method, 'createCaptionTrack');
  const bad = dispatch(sb, 'callModule', { module: 'nope', fn: 'missing' });
  assert.equal(bad.success, false);
  assert.match(bad.error, /Unknown module fn/);
});

test('processEDL add_captions op flows through the cut backbone', () => {
  const host = makeHost();
  const sb = loadEngine(host);
  host.children.push({ name: 'c.srt' });
  const res = dispatch(sb, 'processEDL', { ops: [{ action: 'add_captions', srt_path: 'G:\\c.srt' }] });
  assert.equal(res.success, true);
  assert.equal(res.totalOperations, 1);
  assert.equal(res.results[0].action, 'add_captions');
});
