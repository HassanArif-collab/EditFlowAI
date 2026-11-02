const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');

test('CSInterface reports a missing Adobe CEP bridge explicitly', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'cep-panel', 'client', 'lib', 'CSInterface.js'),
    'utf8'
  );
  const sandbox = { window: {} };

  vm.runInNewContext(source, sandbox);

  let callbackResult = null;
  new sandbox.window.CSInterface().evalScript('scanProjectMedia()', (result) => {
    callbackResult = result;
  });

  assert.match(callbackResult, /Premiere Pro|Adobe CEP bridge/);
  assert.notEqual(callbackResult, 'EvalScript error.');
});

test('ExtendScript loader keeps dispatcher available and handles Windows paths', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'cep-panel', 'extendscript', 'index.jsx'),
    'utf8'
  );

  assert.match(source, /lastIndexOf\(['"]\\\\['"]\)/);
  assert.doesNotMatch(source, /throw\s+e\s*;\s*\n\s*}\s*\n\s*}\s*\n\s*\/\/ Load modules/);
});

test('client configures the CEP extension root before dispatching commands', async () => {
  const {loadEsm} = require('./_load-esm');
  const calls = [];
  class CSInterface {
    constructor(){this.SYSTEM_PATH={EXTENSION:'extension'};}
    getSystemPath(key){assert.equal(key,'extension'); return 'C:/Extensions/editflow';}
    evalScript(script,callback){calls.push(script);callback('{"success":true}');}
  }
  const bridge=loadEsm(path.join(repoRoot,'cep-panel/client/src/extendscript.js'),{CSInterface,console:{log(){},warn(){}}});
  assert.equal(await bridge.initExtendScript(),true);
  await bridge.callExtendScript('getSequenceState',{});
  assert.match(calls[0],/editflowConfigureExtensionRoot/);
  assert.match(calls[0],/C:\/Extensions\/editflow/);
  assert.match(calls[1],/editflowDispatch\("getSequenceState"/);
});

test('ExtendScript can reload modules from a CEP extension root', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'cep-panel', 'extendscript', 'index.jsx'),
    'utf8'
  );

  assert.match(source, /function editflowConfigureExtensionRoot/);
  assert.match(source, /return root \+ '\/extendscript'/);
});

test('ExtendScript modules are evaluated globally so manager singletons are visible', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'cep-panel', 'extendscript', 'index.jsx'),
    'utf8'
  );

  assert.match(source, /\$\.evalFile\(file\)/);
  assert.doesNotMatch(source, /eval\(content\)/);
});

test('ExtendScript exposes phrase range preview markers', () => {
  const indexSource = fs.readFileSync(
    path.join(repoRoot, 'cep-panel', 'extendscript', 'index.jsx'),
    'utf8'
  );
  const markerSource = fs.readFileSync(
    path.join(repoRoot, 'cep-panel', 'extendscript', 'marker_manager.jsx'),
    'utf8'
  );
  assert.match(indexSource, /case "addPhraseRangeMarkers"/);
  assert.match(markerSource, /function addPhraseRangeMarkers/);
  // Range markers must enter modifyingCommands so undo grouping works.
  assert.match(indexSource, /"addPhraseRangeMarkers"/);
});

test('ExtendScript exposes guarded timeline range removal', () => {
  const indexSource = fs.readFileSync(
    path.join(repoRoot, 'cep-panel', 'extendscript', 'index.jsx'),
    'utf8'
  );
  const clipSource = fs.readFileSync(
    path.join(repoRoot, 'cep-panel', 'extendscript', 'clip_manager.jsx'),
    'utf8'
  );
  assert.match(indexSource, /case "removeTimelineRanges"/);
  assert.match(clipSource, /function removeTimelineRanges/);
  // Refuse extraction before changing ranges when the host lacks the API.
  assert.match(clipSource, /Timeline extract is not available; no ranges were changed/);
  // And it must be in modifyingCommands so undo wrapping fires.
  assert.match(indexSource, /"removeTimelineRanges"/);
});

test('Story Cut wires project scripts through compilation and native assembly', () => {
  const source=fs.readFileSync(path.join(repoRoot,'cep-panel/client/src/story-cut-view.js'),'utf8');
  assert.match(source,/async function compileScript/);
  assert.match(source,/apiPost\('\/api\/script-assembly\/compile'/);
  assert.match(source,/project_folder: S\.projectFolder/);
  assert.match(source,/sc-script-select/);
  assert.match(source,/sc-btn-assemble/);
  assert.match(source,/callExtendScript\('processEDL'/);
  assert.match(source,/expected_project_path: project\.projectPath/);
});

test('ExtendScript manager modules export singletons without function-scoped var declarations', () => {
  const moduleExports = [
    ['utils.jsx', 'editflowUtils'],
    ['sequence_reader.jsx', 'sequenceReader'],
    ['project_scanner.jsx', 'projectScanner'],
    ['clip_manager.jsx', 'clipManager'],
    ['audio_manager.jsx', 'audioManager'],
    ['marker_manager.jsx', 'markerManager'],
    ['track_manager.jsx', 'trackManager'],
    ['export_manager.jsx', 'exportManager'],
    ['effects_manager.jsx', 'effectsManager'],
  ];

  for (const [fileName, exportName] of moduleExports) {
    const source = fs.readFileSync(
      path.join(repoRoot, 'cep-panel', 'extendscript', fileName),
      'utf8'
    );

    assert.doesNotMatch(source, new RegExp(`^var\\s+${exportName}\\s*=`, 'm'), fileName);
    assert.match(source, new RegExp(`^${exportName}\\s*=`, 'm'), fileName);
  }
});
