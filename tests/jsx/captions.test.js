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

/* ── Caption studio: sequence facts, audio clips, overlay placement ── */

const TICKS = 254016000000;
const tk = (s) => ({ ticks: String(Math.round(s * TICKS)), seconds: s });

function makeTimeline(host, spec) {
  // spec: { video: [[{name,path,start,end}]...], audio: [{muted, clips:[...]}...] }
  const removed = [];
  const placed = [];
  const item = (c) => ({ name: c.name || c.path.split(/[\\/]/).pop(), getMediaPath: () => c.path });
  const makeClips = (list) => {
    const arr = list.map((c) => ({
      projectItem: c.nested ? { name: 'Nested', getMediaPath: () => '' } : item(c),
      start: tk(c.start), end: tk(c.end), inPoint: tk(c.in || 0), outPoint: tk((c.in || 0) + c.end - c.start),
      disabled: !!c.disabled,
      remove(ripple, align) {
        removed.push({ name: this.projectItem.name, ripple, align });
        arr.splice(arr.indexOf(this), 1);
      },
    }));
    Object.defineProperty(arr, 'numItems', { get() { return arr.length; } });
    return arr;
  };
  const vtracks = (spec.video || []).map((clips, i) => {
    const t = { name: 'V' + (i + 1), clips: makeClips(clips), isLocked: () => false };
    t.overwriteClip = (projItem, time) => {
      placed.push({ track: i, name: projItem.name, ticks: time.ticks });
      t.clips.push({ projectItem: projItem, start: { ticks: time.ticks }, end: { ticks: time.ticks } });
    };
    return t;
  });
  const atracks = (spec.audio || []).map((a, i) => ({ name: 'A' + (i + 1), clips: makeClips(a.clips), isMuted: () => !!a.muted }));
  Object.defineProperty(vtracks, 'numTracks', { get() { return vtracks.length; } });
  Object.defineProperty(atracks, 'numTracks', { get() { return atracks.length; } });
  Object.assign(host.app.project.activeSequence, {
    name: 'Short 01', sequenceID: 'seq-1', frameSizeHorizontal: 1080, frameSizeVertical: 1920,
    timebase: '8475667200', end: String(60 * TICKS),
    getPlayerPosition: () => tk(12.5),
    videoTracks: vtracks, audioTracks: atracks,
    insertClip() { throw new Error('insertClip must never be used for captions (it ripples)'); },
  });
  return { removed, placed };
}

function loadWithTime(host) {
  const sb = loadEngine(host);
  // ExtendScript's Time class: a bag with ticks/seconds.
  sb.Time = function Time() { this.ticks = '0'; this.seconds = 0; };
  return sb;
}

function callCM(sb, fn, args) {
  return dispatch(sb, 'callModule', Object.assign({ module: 'captionsManager', fn }, args || {}));
}

function stubBins(host, newName, newPath) {
  host.app.project.rootItem.createBin = (name) => {
    const kids = [];
    Object.defineProperty(kids, 'numItems', { get() { return kids.length; } });
    host.children.push({ name, type: 1, children: kids });
  };
  host.app.project.importFiles = (paths, suppress, bin) => {
    host.imported.push(...paths);
    bin.children.push({ name: newName, getMediaPath: () => newPath });
  };
}

test('sequenceInfo reports exact timebase, size, playhead and audio tracks', () => {
  const host = makeHost();
  makeTimeline(host, { video: [[]], audio: [{ clips: [] }, { muted: true, clips: [] }] });
  const sb = loadWithTime(host);
  const info = callCM(sb, 'sequenceInfo');
  assert.equal(info.success, true);
  assert.equal(info.timebase, '8475667200');            // 29.97 — kept as ticks, never rounded to 30
  assert.ok(Math.abs(info.fps - 30000 / 1001) < 1e-6);
  assert.equal(info.width, 1080);
  assert.equal(info.playhead, 12.5);
  assert.deepEqual(info.audioTracks.map((t) => t.muted), [false, true]);
});

test('sequenceAudioClips skips muted tracks, disabled clips and nested sequences', () => {
  const host = makeHost();
  makeTimeline(host, { video: [[]], audio: [
    { clips: [{ path: 'G:\\a.mov', start: 0, end: 4, in: 10 }, { path: 'G:\\b.mov', start: 4, end: 6, disabled: true },
              { nested: true, path: '', start: 6, end: 8 }] },
    { muted: true, clips: [{ path: 'G:\\music.wav', start: 0, end: 60 }] },
  ] });
  const sb = loadWithTime(host);
  const res = callCM(sb, 'sequenceAudioClips');
  assert.equal(res.success, true);
  assert.deepEqual(res.clips.map((c) => c.path), ['G:\\a.mov']);
  assert.equal(res.clips[0].in, 10);
  assert.equal(res.clips[0].out, 14);
  assert.equal(res.nested, 1);
});

test('placeOverlay overwrites onto a free track and replaces old EditFlow captions (no ripple)', () => {
  // WHY: the old flow used insertClip at 0 — a ripple insert that pushed the
  // previous overlay down the timeline and stacked a new one on every run.
  const host = makeHost();
  const tl = makeTimeline(host, { video: [
    [{ path: 'G:\\footage.mov', start: 0, end: 60 }],                                       // V1 footage
    [{ path: 'G:\\broll.mov', start: 5, end: 9 }],                                          // V2 busy
    [{ path: 'G:\\EditFlowAI\\data\\output\\captions\\overlay-1234abcd.mov', start: 0, end: 30 }], // V3 old overlay
  ] });
  const sb = loadWithTime(host);
  const newPath = 'G:\\EditFlowAI\\data\\output\\captions\\EditFlow Captions - Short 01 - 20261006.mov';
  stubBins(host, 'EditFlow Captions - Short 01 - 20261006.mov', newPath);
  const res = callCM(sb, 'placeOverlay', { path: newPath, start: 0, duration: 58 });
  assert.equal(res.success, true, res.error);
  assert.equal(res.removed, 1);
  assert.deepEqual(tl.removed, [{ name: 'overlay-1234abcd.mov', ripple: false, align: false }]);
  assert.equal(res.track, 2, 'reuses the old overlay track (V3), not busy V2');
  assert.deepEqual(tl.placed, [{ track: 2, name: 'EditFlow Captions - Short 01 - 20261006.mov', ticks: '0' }]);
  assert.deepEqual(host.imported, [newPath]);
});

test('placeOverlay picks the lowest empty track above V1 the first time', () => {
  const host = makeHost();
  const tl = makeTimeline(host, { video: [[{ path: 'G:\\f.mov', start: 0, end: 60 }], [{ path: 'G:\\b.mov', start: 2, end: 3 }], [], []] });
  const sb = loadWithTime(host);
  const p = 'G:\\x\\data\\output\\captions\\EditFlow Captions - S.mov';
  stubBins(host, 'EditFlow Captions - S.mov', p);
  const res = callCM(sb, 'placeOverlay', { path: p, start: 1.5, duration: 10 });
  assert.equal(res.success, true, res.error);
  assert.equal(res.track, 2);                                   // V2 has b-roll at 2–3 s → V3
  assert.equal(tl.placed[0].ticks, String(Math.round(1.5 * TICKS)));
});

test('placeOverlay refuses (with a clear message) when no video track is free', () => {
  const host = makeHost();
  makeTimeline(host, { video: [[{ path: 'G:\\f.mov', start: 0, end: 60 }], [{ path: 'G:\\b.mov', start: 0, end: 60 }]] });
  const sb = loadWithTime(host);
  const p = 'G:\\x\\data\\output\\captions\\EditFlow Captions - S.mov';
  stubBins(host, 'EditFlow Captions - S.mov', p);
  const res = callCM(sb, 'placeOverlay', { path: p, start: 0, duration: 10 });
  assert.equal(res.success, false);
  assert.match(res.error, /Add one \(Sequence > Add Tracks\)/);
});
