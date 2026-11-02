const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { loadEsm } = require('./_load-esm');

function harness(overrides = {}) {
  const data = new Map();
  const window = { addEventListener() {} };
  const calls = [];
  const a = 'D:/MARKETING/Brand A/2026-10-02 First';
  const b = 'D:/MARKETING/Brand A/2026-10-30 Second';
  const info = folder => ({ project_folder: folder, project_name: folder.split('/').pop(),
    scripts_folder: folder + '/Scripts', brand: 'Brand A', brand_root: 'D:/MARKETING/Brand A' });
  const apiPost = async (url, body) => {
    calls.push({ url, body });
    if (url.endsWith('/scripts-folder')) return info(body.project_folder);
    if (url.endsWith('/index')) return { root_dir: 'D:/MARKETING/Brand A', total_items: 20 };
    if (url.endsWith('/compile')) return { success: false, detail: 'No fixture media' };
    throw new Error('Unexpected mutation: ' + url);
  };
  const apiGet = async url => {
    if (url.endsWith('/brands')) return { success: true, brands: ['Brand A'] };
    if (url.includes('/projects?')) return { projects: [a, b].map(folder => ({ path: folder })) };
    if (url.includes('/folders?')) return { success: true, folders: [] };
    if (url.includes('/scripts?')) {
      const folder = decodeURIComponent(url.split('folder_path=')[1]);
      return { ...info(folder), folder: folder + '/Scripts', scripts: [
        { name: 'Script 01.md', full_path: folder + '/Scripts/Script 01.md' },
        { name: 'Script 02.md', full_path: folder + '/Scripts/Script 02.md' },
      ] };
    }
    throw new Error('Unexpected read: ' + url);
  };
  const exports = loadEsm(path.resolve(__dirname, '../cep-panel/client/src/story-cut-view.js'), {
    window,
    document: { getElementById() { return null; }, querySelector() { return null; } },
    localStorage: { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) },
    apiGet, apiPost, getBaseUrl() { return 'http://localhost'; },
    callExtendScript: async () => ({}), reloadExtensionRoot: async () => ({}),
    ...overrides,
  });
  return { ...exports, state: window.__storyCutState, calls, info, a, b };
}

test('old script reference requests cannot leak across project switches or assemble', async () => {
  let resolveReference;
  const mutations=[];
  const h=harness({apiGet:async()=>new Promise(resolve=>{resolveReference=resolve;}),
    apiPost:async(...args)=>mutations.push(args)});
  h.state.activeBrand='Brand A';h.state.projectFolder=h.a;h.state.showScriptLibrary=true;
  const request=h.readScriptReference('old.md');
  h.state.activeBrand='Brand B';h.state.projectFolder=h.b;
  resolveReference({success:true,full_path:'old.md',content:'Other client words'});
  await request;
  assert.equal(h.state.scriptReference,null);
  assert.deepEqual(mutations,[]);
});

test('selecting another reference rejects a late response from the first script', async () => {
  const pending=[];
  const h=harness({apiGet:async()=>new Promise(resolve=>pending.push(resolve))});
  h.state.activeBrand='Brand A';h.state.projectFolder=h.a;h.state.showScriptLibrary=true;
  const first=h.readScriptReference('Script 51.md');
  const second=h.readScriptReference('Script 52.md');
  pending[1]({success:true,full_path:'Script 52.md',content:'New choice'});await second;
  pending[0]({success:true,full_path:'Script 51.md',content:'Earlier choice'});await first;
  assert.equal(h.state.scriptReference.full_path,'Script 52.md');
});

test('project picker hides empty folders and keeps an explicitly selected empty project accessible', () => {
  const h=harness();
  h.state.availableProjects=[{path:h.a,script_count:0},{path:h.b,script_count:4},{path:'empty',script_count:0}];
  assert.deepEqual(h.visibleScriptProjects().map(p=>p.path),[h.b]);
  h.state.projectFolder=h.a;
  assert.deepEqual(h.visibleScriptProjects().map(p=>p.path),[h.a,h.b]);
  h.state.showEmptyProjects=true;
  assert.equal(h.visibleScriptProjects().length,3);
});

test('script list discovers new assignments without restarting and invalidates a removed selected script', async () => {
  let scripts=[{full_path:'old.md'},{full_path:'Script 53.md'},{full_path:'Script 54.md'}];
  const h=harness({apiGet:async()=>({scripts})});
  h.state.projectFolder=h.a;h.state.scripts=[{full_path:'old.md'}];h.state.selectedScriptPath='old.md';
  h.state.plan={title:'Current plan'};h.state.edlOps=[{action:'add'}];
  await h.refreshProjectScriptList();
  assert.equal(h.state.scripts.length,3);
  assert.equal(h.state.selectedScriptPath,'old.md');
  assert.equal(h.state.plan.title,'Current plan');
  scripts=[{full_path:'Script 53.md'},{full_path:'Script 54.md'}];
  await h.refreshProjectScriptList();
  assert.equal(h.state.selectedScriptPath,'');
  assert.equal(h.state.plan,null);
  assert.deepEqual(h.state.edlOps,[]);
});

test('brand media indexing and script-directory responses never replace the dated project', async () => {
  const h = harness();
  await h.selectStoryCutProject(h.a);
  assert.equal(h.state.projectFolder, h.a);
  assert.equal(h.state.scriptsFolder, h.a + '/Scripts');
  assert.equal(h.calls.find(c => c.url.endsWith('/index')).body.root_dir, 'D:/MARKETING/Brand A');
});

test('returning to a project restores its script and draft without carrying another project plan', async () => {
  const h = harness();
  await h.selectStoryCutProject(h.a);
  h.state.selectedScriptPath = h.a + '/Scripts/Script 02.md';
  h.state.customContent = 'A draft';
  h.state.customMode = true;
  h.state.plan = { title: 'Stale first project plan' };
  h.state.edlOps = [{ action: 'add' }];
  await h.selectStoryCutProject(h.b);
  assert.equal(h.state.plan, null);
  assert.deepEqual(h.state.edlOps, []);
  assert.equal(h.state.customContent, '');
  await h.selectStoryCutProject(h.a);
  assert.equal(h.state.selectedScriptPath, h.a + '/Scripts/Script 02.md');
  assert.equal(h.state.customContent, 'A draft');
  assert.equal(h.state.customMode, true);
});

test('a late response from the previous project cannot overwrite the new selection', async () => {
  let resolveFirst;
  const a = 'D:/MARKETING/Brand A/2026-10-02 First';
  const h = harness({ apiPost: async (url, body) => {
    if (url.endsWith('/index')) return { root_dir: 'D:/MARKETING/Brand A' };
    if (url.endsWith('/scripts-folder') && body.project_folder === a) {
      return new Promise(resolve => { resolveFirst = resolve; });
    }
    return { project_folder: body.project_folder, project_name: 'Second',
      scripts_folder: body.project_folder + '/Scripts', brand: 'Brand A', brand_root: 'D:/MARKETING/Brand A' };
  } });
  const first = h.selectStoryCutProject(h.a);
  await h.selectStoryCutProject(h.b);
  resolveFirst(h.info(h.a));
  await first;
  assert.equal(h.state.projectFolder, h.b);
  assert.ok(h.state.scripts.every(s => s.full_path.startsWith(h.b)));
});

test('assemble with no plan never extracts or transcribes timeline audio', async () => {
  const native=[];
  const posts=[];
  const h=harness({apiPost:async(...args)=>{posts.push(args);throw new Error('Unexpected API call');},callExtendScript:async(...args)=>{native.push(args);return {};}});
  assert.equal(h.state.mode,'rough_cut');
  await h.assembleInPremiere();
  h.state.mode='timeline_overlay';
  await h.assembleInPremiere();
  assert.deepEqual(posts,[]);
  assert.deepEqual(native,[]);
});

test('the latest script compile wins when responses arrive out of order', async () => {
  const pending=[];
  const h=harness({apiPost:async(url,body)=>new Promise(resolve=>pending.push({body,resolve}))});
  h.state.selectedScriptPath='old.md';
  const first=h.compileScript();
  h.state.selectedScriptPath='new.md';
  const second=h.compileScript();
  const response=title=>({success:true,plan:{title,cuts:[],summary:{total_duration:0},validation:{errors:[],warnings:[]}},edl_ops:[]});
  pending[1].resolve(response('New script'));
  await second;
  pending[0].resolve(response('Old script'));
  await first;
  assert.equal(h.state.plan.title,'New script');
  assert.equal(h.state.planKind,'script');
});

test('changing workflow invalidates in-flight script compilation', async () => {
  let resolve;
  const h=harness({apiPost:async()=>new Promise(r=>{resolve=r;})});
  h.state.selectedScriptPath='script.md';
  const compilation=h.compileScript();
  await h.switchMode('timeline_overlay');
  resolve({success:true,plan:{title:'Late script',cuts:[]},edl_ops:[{action:'add'}]});
  await compilation;
  assert.equal(h.state.plan,null);
  assert.deepEqual(h.state.edlOps,[]);
  assert.equal(h.state.busy,false);
});

test('refresh recompiles a changed disk revision without invoking transcription', async () => {
  const posted=[];
  const h=harness({apiGet:async()=>({revision:'new',execution_revision:''}),apiPost:async(url)=>{
    posted.push(url);return {success:true,plan:{title:'Current file',script_revision:'new',cuts:[],summary:{total_duration:0},validation:{errors:[],warnings:[]}},edl_ops:[]};
  }});
  h.state.selectedScriptPath='script.md';
  h.state.plan={script_revision:'old',execution_revision:''};
  h.state.planKind='script';
  await h.refreshSelectedScript();
  assert.equal(h.state.plan.script_revision,'new');
  assert.deepEqual(posted,['/api/script-assembly/compile']);
});

test('a workflow change during apply validation cannot dispatch an old plan', async () => {
  let validate;
  const native=[];
  const h=harness({callExtendScript:async(name)=>{native.push(name);return {};},apiPost:async(url)=>{
    if(url.endsWith('/validate-plan')) return new Promise(r=>{validate=r;});
    return {success:true,plan:{title:'Script',cuts:[],summary:{total_duration:0},validation:{valid:true,errors:[],warnings:[]}},edl_ops:[{action:'create_sequence'}]};
  }});
  h.state.selectedScriptPath='script.md';
  await h.compileScript();
  const apply=h.assembleInPremiere();
  await h.switchMode('timeline_overlay');
  validate({valid:true});
  await apply;
  assert.ok(!native.includes('processEDL'));
});
