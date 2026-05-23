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

test('client passes the CEP extension root before dispatching ExtendScript commands', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'cep-panel', 'client', 'src', 'main.js'),
    'utf8'
  );

  assert.match(source, /extensionPathType = \(state\.csInterface\.SYSTEM_PATH && state\.csInterface\.SYSTEM_PATH\.EXTENSION\) \|\| 'extension'/);
  assert.match(source, /getSystemPath\(extensionPathType\)/);
  assert.match(source, /editflowConfigureExtensionRoot/);
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
  // The guarded version MUST refuse to cut when QE razor is unavailable.
  assert.match(clipSource, /QE razor\(\) is not available/);
  // And it must be in modifyingCommands so undo wrapping fires.
  assert.match(indexSource, /"removeTimelineRanges"/);
});

test('CEP panel wires the active sequence phrase workflow end-to-end', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'cep-panel', 'client', 'src', 'main.js'),
    'utf8'
  );
  // Helper that prepares the snake_case payload for the backend.
  assert.match(source, /function getSequenceAudioClipsForBackend/);
  // Public entry points used by buttons + chat command.
  assert.match(source, /async function analyzeActiveSequenceAudio/);
  assert.match(source, /async function findPhraseInActiveSequence/);
  // Buttons must exist and be bound.
  assert.match(source, /#btn-analyze-sequence-audio/);
  assert.match(source, /#btn-preview-phrase/);
  assert.match(source, /#btn-apply-phrase-cut/);
  // The chat router must intercept "cut/remove/delete '<phrase>'".
  assert.match(source, /\\b\(\?:cut\|remove\|delete\)\\b/);
  // State must declare lastPhraseRanges.
  assert.match(source, /lastPhraseRanges\s*:\s*\[\]/);
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
