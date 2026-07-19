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
  // The single-chat rewrite relocated this wiring from main.js into
  // extendscript.js. The intent is unchanged and still worth guarding:
  // resolve the extension root from CSInterface, then hand it to the jsx
  // BEFORE any command dispatches (so module reloads use the right root).
  const source = fs.readFileSync(
    path.join(repoRoot, 'cep-panel', 'client', 'src', 'extendscript.js'),
    'utf8'
  );

  assert.match(source, /_csInterface\.SYSTEM_PATH && _csInterface\.SYSTEM_PATH\.EXTENSION/);
  assert.match(source, /getSystemPath\(extensionPathKey\)/);
  assert.match(source, /callExtendScript\('editflowConfigureExtensionRoot', extensionRoot\)/);
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

test('CEP panel wires the native captions workflow end-to-end', () => {
  // Replaces the legacy "sequence phrase" assertions. The native-captions
  // rewrite swapped the Premiere panel's primary workflow, so this guards
  // the real current entry points: header button -> lazily-loaded view
  // module -> exposed opener. If any link breaks, the panel's main feature
  // silently fails to open — exactly the regression worth catching.
  const source = fs.readFileSync(
    path.join(repoRoot, 'cep-panel', 'client', 'src', 'main.js'),
    'utf8'
  );
  // The view is lazy-loaded (cache-buster) and its opener captured.
  assert.match(source, /import\('\.\/native-captions-view\.js' \+ bust\)/);
  assert.match(source, /openNativeCaptions = ncMod\.openNativeCaptions/);
  // Exposed on window so the header/command can open it.
  assert.match(source, /window\.__editflowOpenNativeCaptions = openNativeCaptions/);
  // Button must exist and be bound to the opener.
  assert.match(source, /const btnNativeCaptions = \$\('#btn-native-captions'\)/);
  assert.match(source, /btnNativeCaptions\.addEventListener\('click'/);
  assert.match(source, /if \(openNativeCaptions\) openNativeCaptions\(\)/);
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
