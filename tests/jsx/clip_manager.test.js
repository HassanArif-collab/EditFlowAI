/**
 * ExtendScript harness for clip_manager.jsx and EDL processing.
 * Tests autonomous sequence assembly, video-only B-roll overlay,
 * Scale punch-in (108%), 4-frame J-cuts, and sequence markers.
 *
 * Run: node --test tests/jsx/clip_manager.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ES_DIR = path.join(__dirname, '..', '..', 'cep-panel', 'extendscript');
const TICKS = 254016000000;
const tk = (s) => ({ ticks: String(Math.round(s * TICKS)), seconds: s });

function makeHost(overrides = {}) {
  const imported = [];
  const children = [];
  Object.defineProperty(children, 'numItems', {
    get() { return children.length; },
  });

  const markerList = [];

  function makeTrack(name, isAudio) {
    const clips = [];
    Object.defineProperty(clips, 'numItems', {
      get() { return clips.length; }
    });
    const trk = {
      name,
      clips,
      insertClip(projectItem, timeTicks) {
        const c = createClip(projectItem, timeTicks);
        clips.push(c);
        return c;
      },
      overwriteClip(projectItem, timeTicks) {
        return trk.insertClip(projectItem, timeTicks);
      }
    };
    return trk;
  }

  function createClip(projectItem, timeTicks) {
    const tNum = typeof timeTicks === 'string' ? parseFloat(timeTicks) : Number(timeTicks);
    const scaleProp = {
      displayName: 'Scale',
      value: 100,
      setValue(v) { this.value = v; }
    };
    const motionComp = {
      displayName: 'Motion',
      properties: [scaleProp]
    };
    Object.defineProperty(motionComp.properties, 'numItems', {
      get() { return motionComp.properties.length; }
    });

    const comps = [motionComp];
    Object.defineProperty(comps, 'numItems', {
      get() { return comps.length; }
    });

    return {
      name: projectItem ? projectItem.name : 'Clip',
      projectItem,
      start: { ticks: String(tNum) },
      end: { ticks: String(tNum + 5 * TICKS) },
      inPoint: { ticks: '0' },
      outPoint: { ticks: String(5 * TICKS) },
      components: comps,
      scaleProp
    };
  }

  const vtracks = [makeTrack('V1', false), makeTrack('V2', false), makeTrack('V3', false)];
  Object.defineProperty(vtracks, 'numTracks', { get() { return vtracks.length; } });

  const atracks = [makeTrack('A1', true), makeTrack('A2', true), makeTrack('A3', true)];
  Object.defineProperty(atracks, 'numTracks', { get() { return atracks.length; } });

  const activeSequence = {
    name: 'Active Sequence',
    sequenceID: 'seq-default',
    timebase: '8467200000', // 30 fps
    videoTracks: vtracks,
    audioTracks: atracks,
    insertClip(projectItem, timeTicks, vTrackIdx, aTrackIdx) {
      if (vtracks[vTrackIdx]) {
        vtracks[vTrackIdx].insertClip(projectItem, timeTicks);
      }
      if (aTrackIdx >= 0 && atracks[aTrackIdx]) {
        atracks[aTrackIdx].insertClip(projectItem, timeTicks);
      }
    },
    markers: {
      createMarker(timeInSec) {
        const m = {
          start: timeInSec,
          name: '',
          comments: '',
          color: 0,
          type: 'Standard',
          setColorByIndex(c) { m.color = c; }
        };
        markerList.push(m);
        return m;
      }
    }
  };

  const host = {
    imported,
    children,
    markerList,
    app: {
      version: '25.6.4',
      project: {
        path: 'D:\\TestProject\\Test.prproj',
        activeSequence,
        rootItem: {
          children,
          createBin(name) {
            const binKids = [];
            Object.defineProperty(binKids, 'numItems', { get() { return binKids.length; } });
            const binItem = { name, type: 1, children: binKids };
            children.push(binItem);
            return binItem;
          }
        },
        importFiles(paths, suppressUI, targetBin) {
          imported.push(...paths);
          const bin = targetBin || host.app.project.rootItem;
          for (const p of paths) {
            if (p.includes('NonExistent') || p.includes('Ghost')) continue;
            const fileName = p.split(/[\\/]/).pop();
            const item = {
              name: fileName,
              type: 0,
              getMediaPath() { return p; },
              setInPoint(t, f) { this.inPoint = t; },
              setOutPoint(t, f) { this.outPoint = t; }
            };
            bin.children.push(item);
          }
        },
        createNewSequence(name, id) {
          const s = Object.assign({}, activeSequence, { name, sequenceID: id });
          host.app.project.activeSequence = s;
          return s;
        }
      }
    },
    ProjectItemType: { BIN: 1 }
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
    File: function (f) {
      const s = String(f);
      return {
        fsName: s,
        get exists() { return fs.existsSync(s); }
      };
    },
    Folder: function (p) {
      const s = String(p || '');
      return {
        fsName: s,
        get exists() { return fs.existsSync(s); }
      };
    },
    app: host.app,
    ProjectItemType: host.ProjectItemType,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const entry = fs.readFileSync(path.join(ES_DIR, 'index.jsx'), 'utf8');
  vm.runInContext(entry, sandbox, { filename: 'index.jsx' });
  return sandbox;
}

function dispatch(sandbox, command, payload) {
  const script = `editflowDispatch(${JSON.stringify(command)}, ${JSON.stringify(JSON.stringify(payload || {}))})`;
  const raw = vm.runInContext(script, sandbox);
  return JSON.parse(raw);
}

test('processEDL executes script assembly pipeline with bins, sequences, cuts and markers', () => {
  const host = makeHost();
  const sb = loadEngine(host);

  const ops = [
    { action: 'beginUndoGroup', name: 'Story Cut Assembly' },
    { action: 'ensure_bin', name: 'EditFlow Sequences' },
    { action: 'create_sequence', name: 'Rough Cut - Script 20' },
    {
      action: 'import_file',
      path: 'D:\\MARKETING\\Jamia Masjid Chicago\\2026-9-23 New Construction Data of Ground\\Cam A\\C5032.MP4'
    },
    {
      action: 'add',
      path: 'D:\\MARKETING\\Jamia Masjid Chicago\\2026-9-23 New Construction Data of Ground\\Cam A\\C5032.MP4',
      start_time: 0.0,
      in_point: 10.5,
      out_point: 14.8,
      video_track_index: 0,
      audio_track_index: 0
    },
    {
      action: 'add_marker',
      time: 0.0,
      name: 'Beat 1: The Foundations',
      comments: 'Hook beat: caissons completed',
      color_index: 4
    },
    { action: 'endUndoGroup' }
  ];

  const res = dispatch(sb, 'processEDL', { ops });
  assert.equal(res.success, true);
  assert.equal(res.totalOperations, ops.length);
  assert.equal(host.app.project.activeSequence.name, 'Rough Cut - Script 20');
  assert.equal(host.app.project.activeSequence.videoTracks[0].clips.length, 1);
  assert.equal(host.app.project.activeSequence.audioTracks[0].clips.length, 1);
  assert.equal(host.markerList.length, 1);
  assert.equal(host.markerList[0].name, 'Beat 1: The Foundations');
  assert.equal(host.markerList[0].color, 4);
  assert.equal(host.markerList[0].comments, 'Hook beat: caissons completed');
});

test('addClipToSequence places video-only B-roll overlay when audioTrackIndex < 0', () => {
  const host = makeHost();
  const sb = loadEngine(host);

  const testFile = 'D:\\MARKETING\\Jamia Masjid Chicago\\2026-9-23 New Construction Data of Ground\\Broll\\Drone_Concrete.MP4';
  host.app.project.importFiles([testFile]);

  const res = dispatch(sb, 'callModule', {
    module: 'clipManager',
    fn: 'addClipToSequence',
    seq: host.app.project.activeSequence,
    mediaPath: testFile,
    trackIndex: 1, // Track V2
    audioTrackIndex: -1, // Video only!
    startTime: 5.0,
    inPoint: 2.0,
    outPoint: 6.0
  });

  assert.equal(res.success, true);
  // Video placed on V2
  const v2Clips = host.app.project.activeSequence.videoTracks[1].clips;
  assert.equal(v2Clips.length, 1);
  assert.equal(v2Clips[0].name, 'Drone_Concrete.MP4');

  // Audio tracks remain untouched
  for (let a = 0; a < host.app.project.activeSequence.audioTracks.length; a++) {
    assert.equal(host.app.project.activeSequence.audioTracks[a].clips.length, 0);
  }
});

test('addClipToSequence places B-roll overlay with natural audio routed to empty audio track protecting A1/A2 dialogue', () => {
  const host = makeHost();
  const sb = loadEngine(host);

  // Pre-populate A1 (0) and A2 (1) with dialogue clips
  host.app.project.activeSequence.audioTracks[0].insertClip({ name: 'Dialogue_Speaker1.wav' }, 0);
  host.app.project.activeSequence.audioTracks[1].insertClip({ name: 'Dialogue_Speaker2.wav' }, 5 * TICKS);

  const testFile = 'D:\\MARKETING\\Jamia Masjid Chicago\\2026-9-23 New Construction Data of Ground\\Broll\\Drone_Concrete.MP4';
  host.app.project.importFiles([testFile]);

  const res = dispatch(sb, 'callModule', {
    module: 'clipManager',
    fn: 'addClipToSequence',
    seq: host.app.project.activeSequence,
    mediaPath: testFile,
    trackIndex: 1, // Track V2
    audioTrackIndex: 'auto', // Auto-route to clean empty audio track
    startTime: 2.0,
    inPoint: 1.0,
    outPoint: 4.0
  });

  assert.equal(res.success, true);
  // Video on V2
  assert.equal(host.app.project.activeSequence.videoTracks[1].clips.length, 1);
  // Dialogue on A1 and A2 remain protected and untouched
  assert.equal(host.app.project.activeSequence.audioTracks[0].clips.length, 1);
  assert.equal(host.app.project.activeSequence.audioTracks[0].clips[0].name, 'Dialogue_Speaker1.wav');
  assert.equal(host.app.project.activeSequence.audioTracks[1].clips.length, 1);
  assert.equal(host.app.project.activeSequence.audioTracks[1].clips[0].name, 'Dialogue_Speaker2.wav');
  // B-roll natural sound placed on clean empty track A3 (idx 2)
  assert.equal(host.app.project.activeSequence.audioTracks[2].clips.length, 1);
  assert.equal(host.app.project.activeSequence.audioTracks[2].clips[0].name, 'Drone_Concrete.MP4');
});

test('addClipToSequence applies 108% Scale punch-in to Motion component', () => {
  const host = makeHost();
  const sb = loadEngine(host);

  const testFile = 'D:\\MARKETING\\Jamia Masjid Chicago\\2026-9-23 New Construction Data of Ground\\Cam A\\C5032.MP4';
  host.app.project.importFiles([testFile]);

  const res = dispatch(sb, 'callModule', {
    module: 'clipManager',
    fn: 'addClipToSequence',
    seq: host.app.project.activeSequence,
    mediaPath: testFile,
    trackIndex: 0,
    audioTrackIndex: 0,
    startTime: 0.0,
    scale_punch_in: 1.08 // 108% punch-in
  });

  assert.equal(res.success, true);
  assert.equal(res.trim_diag.scale_applied, 108);

  const clip = host.app.project.activeSequence.videoTracks[0].clips[0];
  assert.equal(clip.scaleProp.value, 108);
});

test('addClipToSequence applies 4-frame J-cut audio lead frame adjustment', () => {
  const host = makeHost();
  const sb = loadEngine(host);

  const testFile = 'D:\\MARKETING\\Jamia Masjid Chicago\\2026-9-23 New Construction Data of Ground\\Cam A\\C5032.MP4';
  host.app.project.importFiles([testFile]);

  const res = dispatch(sb, 'callModule', {
    module: 'clipManager',
    fn: 'addClipToSequence',
    seq: host.app.project.activeSequence,
    mediaPath: testFile,
    trackIndex: 0,
    audioTrackIndex: 1, // Checkerboard A2
    startTime: 10.0,
    audio_lead_frames: 4 // 4 frames at 30fps = 4/30 = 0.1333s
  });

  assert.equal(res.success, true);
  assert.ok(res.trim_diag.audio_lead_sec > 0);
  const audioClip = host.app.project.activeSequence.audioTracks[1].clips[0];
  // Verify audio clip start was shifted earlier than 10.0s
  const rawStart = typeof audioClip.start === 'object' ? audioClip.start.ticks : audioClip.start;
  const audioStartTicks = parseFloat(rawStart);
  const tenSecTicks = 10.0 * TICKS;
  assert.ok(audioStartTicks < tenSecTicks, 'Audio start must be shifted earlier for J-cut');
});

test('findProjectItem matches mixed forward/backslashes and filename fallback', () => {
  const host = makeHost();
  const sb = loadEngine(host);

  // Pre-populate bin with forward-slash media path
  const item = {
    name: 'Interview_01.mp4',
    type: 0,
    getMediaPath() { return 'd:/marketing/project/raw/interview_01.mp4'; }
  };
  host.children.push(item);

  // Search with Windows backslashes and uppercase drive
  const found = sb.clipManager.findProjectItem('D:\\Marketing\\Project\\Raw\\Interview_01.mp4');
  assert.ok(found, 'Item must be found regardless of slash orientation or case');
  assert.equal(found.name, 'Interview_01.mp4');

  // Search by filename fallback when getMediaPath returns empty
  const item2 = {
    name: 'Broll_Drone_05.mp4',
    type: 0,
    getMediaPath() { return ''; }
  };
  host.children.push(item2);
  const found2 = sb.clipManager.findProjectItem('D:\\Some\\Other\\Path\\Broll_Drone_05.mp4');
  assert.ok(found2, 'Item must be matched by filename fallback');
  assert.equal(found2.name, 'Broll_Drone_05.mp4');
});

test('processEDL captures errors accurately instead of reporting false-positive success', () => {
  const host = makeHost();
  const sb = loadEngine(host);

  const ops = [
    { action: 'beginUndoGroup', name: 'Test Error Group' },
    { action: 'create_sequence', name: 'Error Test Seq' },
    {
      action: 'add',
      path: 'Z:\\NonExistent\\Drive\\Ghost.mp4',
      startTime: 0.0
    },
    { action: 'endUndoGroup' }
  ];

  const res = dispatch(sb, 'processEDL', { ops });
  assert.equal(res.success, false, 'processEDL must return success=false when clip placement fails');
  assert.equal(res.failedCount, 1);
  assert.ok(res.error, 'Error message must be present in result');
});
