const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');

function native() {
  const seq = {sequenceID:'original', name:'Original', clone(){}};
  const sandbox = {
    app:{project:{path:'D:/brand/project/Finals/video.prproj', activeSequence:seq, sequences:{numSequences:1,0:seq}}},
    editflowUtils:{safeStringify:JSON.stringify, getParam:(o,k,alias)=>o[k] === undefined ? o[alias] : o[k]},
    Time:function(){}, $:{writeln(){}},
  };
  vm.runInNewContext(fs.readFileSync(path.resolve('cep-panel/extendscript/clip_manager.jsx'),'utf8'),sandbox);
  return {sandbox,seq,run:opts=>JSON.parse(sandbox.clipManager.processEDLOps(opts))};
}

test('changed project blocks every operation before editing',()=>{
  const n=native();
  const result=n.run({expected_project_path:'D:/other/video.prproj',ops:[{action:'ensure_bin'}]});
  assert.equal(result.success,false);
  assert.match(result.error,/project changed/);
  assert.equal(n.seq.name,'Original');
});

test('changed active sequence blocks overlay application',()=>{
  const n=native();
  const result=n.run({expected_sequence_id:'another',ops:[{action:'add'}]});
  assert.equal(result.success,false);
  assert.match(result.error,/sequence changed/);
});

test('failed operation stops the assembly before subsequent timeline writes',()=>{
  const n=native();
  const result=n.run({sequence_name:'Must not rename original',ops:[{action:'unsupported'},{action:'add',mediaPath:'missing.mp4'}]});
  assert.equal(result.success,false);
  assert.equal(result.results.length,1);
  assert.equal(n.seq.name,'Original');
});

test('failed duplication never places overlays on the original',()=>{
  const n=native();
  const result=n.run({ops:[{action:'clone_sequence',name:'Review'},{action:'add',mediaPath:'missing.mp4'}]});
  assert.equal(result.success,false);
  assert.equal(result.results.length,1);
  assert.equal(n.seq.name,'Original');
});
