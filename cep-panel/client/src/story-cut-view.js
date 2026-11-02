/**
 * story-cut-view.js — EditFlow Story Cut & B-Roll Studio.
 *
 * Minimalist, native Adobe Spectrum dark slate design system.
 * Zero AI gimmicks, zero emojis. 100% vector SVG icons.
 *
 * Core capabilities:
 * - Timeline Visual Overlay mode: auto-transcribes active Premiere sequence & matches micro-visuals
 * - Rough Cut mode: autonomous rough-cut assembly with multi-speaker indexing & J-cuts
 * - Multi-track overlay (Auto-detect empty track V2..V8 or explicit track targeting)
 * - Micro-action controls: live audio preview, take swapping, in/out nudge steppers, visual swapping
 * - Inline thumbnail preview cards for B-roll visuals
 * - Slide-down project settings & Visual Library folder management drawer
 * - Context-aware footer dock with review sequence assembly
 */
import { apiGet, apiPost, getBaseUrl } from './api.js';
import { callExtendScript, reloadExtensionRoot } from './extendscript.js';

const S = {
  mode: 'rough_cut', // Script assembly and timeline analysis are explicit, separate workflows.
  operationToken: 0,
  planKind: null,
  activeSequence: null, // { name, duration, id }
  targetVideoTrack: 1, // 1 = Track V2 (0-based), -1 = Auto-detect empty track
  scripts: [],
  scriptLibrary: null,
  showScriptLibrary: false,
  scriptReference: null,
  scriptLibraryToken: 0,
  scriptReferenceToken: 0,
  selectedScriptPath: '',
  selectedScriptTitle: '',
  sequenceName: '',
  aspectRatio: '9:16',
  fps: 30.0,
  pacing: 'editorial', // 'dynamic', 'editorial', 'talking_head'
  customMode: false,
  customContent: '',
  plan: null,
  edlOps: [],
  busy: false,
  status: null,
  prevView: null,
  projectFolder: localStorage.getItem('editflow_project_folder') || '',
  projectName: '',
  scriptsFolder: '',
  mediaRoot: '',
  availableProjects: [],
  showEmptyProjects: localStorage.getItem('editflow_show_empty_projects') === 'true',
  projectInitialized: false,
  projectLoadToken: 0,
  assetsCount: 0,
  showFolderModal: false,
  visualFolders: [],
  basicSources: [],
  sourceScan: null,
  activeBrand: localStorage.getItem('editflow_active_brand') || '',
  availableBrands: [],
  isTranscribingVl: false,
  vlProgressMsg: '',
  vlProgressPercent: 0,
  showAddVlModal: false,
  showMoreDrawer: false,
  activeTrimCutIndex: null,
  playingCutIndex: null,
  audioElement: null,
  activePopoverCutIndex: null,
  popoverType: null, // 'take' or 'broll'
  popoverItems: [],
};

window.__storyCutState = S;

// ── SVG Vector Icon Library (Zero Emojis) ────────────────────

function svgIcon(name, extraClass = '') {
  const cls = `sc-svg-icon ${extraClass}`.trim();
  switch (name) {
    case 'layers':
      return `<svg class="${cls}" viewBox="0 0 16 16"><path d="M8 1L1 4.5l7 3.5 7-3.5L8 1zm0 5.2L2.6 4.5 8 1.8l5.4 2.7L8 6.2zM1 7.5l7 3.5 7-3.5v1.8l-7 3.5-7-3.5V7.5zm0 3.8l7 3.5 7-3.5v1.8l-7 3.5-7-3.5v-1.8z"/></svg>`;
    case 'film':
      return `<svg class="${cls}" viewBox="0 0 16 16"><path d="M1 2v12h14V2H1zm3 1v2H2V3h2zm0 3v2H2V6h2zm0 3v2H2V9h2zm0 3v1H2v-1h2zm8-9v10H5V3h7zm3 0v2h-2V3h2zm0 3v2h-2V6h2zm0 3v2h-2V9h2zm0 3v1h-2v-1h2z"/></svg>`;
    case 'timeline':
      return `<svg class="${cls}" viewBox="0 0 16 16"><path d="M1 2h14v2H1V2zm0 4h9v2H1V6zm0 4h14v2H1v-2zm0 4h6v2H1v-2z"/></svg>`;
    case 'more':
      return `<svg class="${cls}" viewBox="0 0 16 16"><circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/></svg>`;
    case 'close':
      return `<svg class="${cls}" viewBox="0 0 16 16"><path d="M12.7 3.3a1 1 0 0 0-1.4 0L8 6.6 4.7 3.3a1 1 0 0 0-1.4 1.4L6.6 8l-3.3 3.3a1 1 0 1 0 1.4 1.4L8 9.4l3.3 3.3a1 1 0 0 0 1.4-1.4L9.4 8l3.3-3.3a1 1 0 0 0 0-1.4z"/></svg>`;
    case 'folder':
      return `<svg class="${cls}" viewBox="0 0 16 16"><path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 14.5 4H7.4L5.7 2.3A1.5 1.5 0 0 0 4.6 2H1.5z"/></svg>`;
    case 'refresh':
      return `<svg class="${cls}" viewBox="0 0 16 16"><path d="M13.6 2.4A7.9 7.9 0 0 0 8 0C3.6 0 0 3.6 0 8s3.6 8 8 8c3.7 0 6.8-2.6 7.7-6h-2.1c-.8 2.3-3 4-5.6 4-3.3 0-6-2.7-6-6s2.7-6 6-6c1.7 0 3.1.7 4.2 1.8L9 7h7V0l-2.4 2.4z"/></svg>`;
    case 'play':
      return `<svg class="${cls}" viewBox="0 0 16 16"><path d="M3 2l11 6-11 6V2z"/></svg>`;
    case 'pause':
      return `<svg class="${cls}" viewBox="0 0 16 16"><path d="M3 2h3v12H3V2zm7 0h3v12h-3V2z"/></svg>`;
    case 'swap':
      return `<svg class="${cls}" viewBox="0 0 16 16"><path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-5 7c0-2.5 3.5-4 5-4s5 1.5 5 4v1H3v-1z"/></svg>`;
    case 'broll':
      return `<svg class="${cls}" viewBox="0 0 16 16"><path d="M14 2H2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1zm-1 10H3l3-4 2 2.5 3-3.8 2 5.3zM5 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/></svg>`;
    case 'trim':
      return `<svg class="${cls}" viewBox="0 0 16 16"><path d="M3.5 0a3.5 3.5 0 0 0-1.7 6.6L6 9.8 1.8 14l1.4 1.4 5.3-5.3 5.3 5.3 1.4-1.4L11 9.8l4.2-3.2A3.5 3.5 0 0 0 13.5 0c-1.3 0-2.5.7-3.1 1.8L8 5.6 5.6 1.8A3.5 3.5 0 0 0 3.5 0zm0 2c.8 0 1.5.7 1.5 1.5S4.3 5 3.5 5 2 4.3 2 3.5 2.7 2 3.5 2zm9 0c.8 0 1.5.7 1.5 1.5s-.7 1.5-1.5 1.5-1.5-.7-1.5-1.5.7-1.5 1.5-1.5z"/></svg>`;
    case 'plus':
      return `<svg class="${cls}" viewBox="0 0 16 16"><path d="M7 2h2v5h5v2H9v5H7V9H2V7h5V2z"/></svg>`;
    case 'trash':
      return `<svg class="${cls}" viewBox="0 0 16 16"><path d="M2.5 3h11v2h-1v9a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V5h-1V3zm3-2h5v1h-5V1zm1 5v7h1V6h-1zm3 0v7h1V6h-1z"/></svg>`;
    case 'check':
      return `<svg class="${cls}" viewBox="0 0 16 16"><path d="M13.5 3.5L6 11 2.5 7.5l1.4-1.4L6 8.2l6.1-6.1 1.4 1.4z"/></svg>`;
    case 'alert':
      return `<svg class="${cls}" viewBox="0 0 16 16"><path d="M8 1L0 15h16L8 1zm0 3.5l5.5 9.5H2.5L8 4.5zM7 7h2v3H7V7zm0 4h2v2H7v-2z"/></svg>`;
    case 'info':
      return `<svg class="${cls}" viewBox="0 0 16 16"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm0 3.5a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4zM7 7h2v5H7V7z"/></svg>`;
    case 'chevron_down':
      return `<svg class="${cls}" viewBox="0 0 16 16"><path d="M3.5 5.5l4.5 4.5 4.5-4.5 1 1-5.5 5.5-5.5-5.5 1-1z"/></svg>`;
    case 'captions':
      return `<svg class="${cls}" viewBox="0 0 16 16"><path d="M1 2h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm1 2v8h12V4H2zm2 2h3v1.5H5.5v1H7V10H4V6zm5 0h3v1.5h-1.5v1H12V10H9V6z"/></svg>`;
    case 'waveform':
      return `<svg class="${cls}" viewBox="0 0 16 16"><path d="M7 1h2v14H7V1zm-4 3h2v8H3V4zm8 0h2v8h-2V4zm-8 3h2v2H3V7zm12 0h2v2h-2V7z"/></svg>`;
    case 'spinner':
      return `<svg class="${cls} sc-spin" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="28" stroke-dashoffset="10"/></svg>`;
    default:
      return '';
  }
}

// ── Lifecycle & Setup ────────────────────────────────────────

export function openStoryCut() {
  ensureStyles();
  const view = ensureContainer();

  const hero = document.getElementById('hero');
  const chat = document.getElementById('chat-scroll');
  const footer = document.getElementById('app-footer');
  const captions = document.getElementById('captions-view');
  const review = document.getElementById('review-view');

  S.prevView = {
    hero: hero ? !hero.classList.contains('hidden') : false,
    chat: chat ? !chat.classList.contains('hidden') : false,
    footer: footer ? !footer.classList.contains('hidden') : false,
  };

  [hero, chat, footer, captions, review].forEach((el) => el && el.classList.add('hidden'));
  view.classList.remove('hidden');

  if (!S.audioElement) {
    S.audioElement = new Audio();
    S.audioElement.addEventListener('timeupdate', onAudioTimeUpdate);
    S.audioElement.addEventListener('ended', onAudioEnded);
  }

  detectActiveSequence();
  startScriptWatch();
  if (!S.projectInitialized) {
    loadScripts();
  } else {
    loadVisualFolders();
    refreshSelectedScript();
    render();
  }
}

export function closeStoryCut() {
  if (S.scriptWatchTimer) { clearInterval(S.scriptWatchTimer); S.scriptWatchTimer = null; }
  stopAudioPreview();
  const view = document.getElementById('story-cut-view');
  if (view) view.classList.add('hidden');

  const map = { hero: 'hero', chat: 'chat-scroll', footer: 'app-footer' };
  if (S.prevView) {
    for (const k of Object.keys(map)) {
      const el = document.getElementById(map[k]);
      if (el) el.classList.toggle('hidden', !S.prevView[k]);
    }
  }
}

function ensureStyles() {
  let link = document.getElementById('sc-style-link');
  if (!link) {
    link = document.createElement('link');
    link.id = 'sc-style-link';
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  link.href = 'styles/story-cut.css?v=' + Date.now();
}

function ensureContainer() {
  let v = document.getElementById('story-cut-view');
  if (!v) {
    v = document.createElement('div');
    v.id = 'story-cut-view';
    v.className = 'sc-view';
    const main = document.getElementById('app-main');
    (main || document.body).appendChild(v);
  }
  return v;
}

function getProjectDisplayName(folderPath) {
  if (!folderPath) return 'Project';
  const clean = folderPath.replace(/[\\/]+$/, '');
  const parts = clean.split(/[\\/]/);
  const last = parts[parts.length - 1];
  if (last && last.toLowerCase() === 'ai automation' && parts.length > 1) {
    return parts[parts.length - 2];
  }
  return last || 'Project';
}

async function initProjectFolder() {
  let folder = S.projectFolder;
  if (!S.projectInitialized) {
    try {
      const res = await callExtendScript('getProjectDirectory', {});
      if (res && res.projectDirectory) {
        folder = res.projectDirectory;
      }
    } catch (e) {}
  }
  if (!folder) {
    S.showFolderModal = true;
    return null;
  }
  return apiPost('/api/script-assembly/scripts-folder', { project_folder: folder });
}

function projectStorageKey(folder = S.projectFolder) {
  return 'editflow_project_scripts:' + folder.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function rememberProject() {
  if (!S.projectFolder) return;
  try {
    localStorage.setItem(projectStorageKey(), JSON.stringify({
      selectedScriptPath: S.selectedScriptPath,
      mode: S.mode,
      customMode: S.customMode,
      customContent: S.customContent,
    }));
    localStorage.setItem('editflow_brand_project:' + S.activeBrand.toLowerCase(), S.projectFolder);
  } catch (_) {}
}

function clearProjectPlan() {
  invalidatePlan();
  stopAudioPreview();
  S.scripts = [];
  S.basicSources = [];
  S.sourceScan = null;
  S.scriptLibrary = null;
  S.scriptReference = null;
  S.showScriptLibrary = false;
  S.scriptLibraryToken++;
  S.scriptReferenceToken++;
  S.selectedScriptPath = '';
  S.variantId = 'primary';
  S.selectedScriptTitle = '';
  S.sequenceName = '';
  S.sequenceNameEdited = false;
  S.customMode = false;
  S.customContent = '';
  S.plan = null;
  S.edlOps = [];
  S.assetsCount = 0;
  S.scriptsFolder = '';
  S.status = null;
  S.isTranscribingVl = false;
  S.vlProgressMsg = '';
  S.vlProgressPercent = 0;
}

async function loadBrandProjects() {
  const brand = S.activeBrand;
  if (!brand) return;
  const res = await apiGet(`/api/script-assembly/projects?brand=${encodeURIComponent(brand)}`);
  if (brand !== S.activeBrand) return;
  S.availableProjects = res.projects || [];
}

export function visibleScriptProjects() {
  return S.availableProjects.filter(project => S.showEmptyProjects || project.script_count > 0 || project.path === S.projectFolder);
}

let checkingScriptList = false;
export async function refreshProjectScriptList() {
  const project = S.projectFolder, token = S.projectLoadToken;
  if (!project || S.busy || checkingScriptList) return;
  checkingScriptList = true;
  try {
  const result = await apiGet(`/api/script-assembly/scripts?folder_path=${encodeURIComponent(project)}&_=${Date.now()}`);
  if (project !== S.projectFolder || token !== S.projectLoadToken) return;
  const next = result.scripts || [];
  if (JSON.stringify(next) === JSON.stringify(S.scripts)) return;
  S.scripts = next;
  const info = S.availableProjects.find(item => item.path === project);
  if (info) info.script_count = next.length;
  if (S.selectedScriptPath && !next.some(item => item.full_path === S.selectedScriptPath)) {
    S.selectedScriptPath = '';
    invalidatePlan();
    setStatus('error', 'The selected script was moved or removed. Choose its current location.');
  }
  render();
  } finally { checkingScriptList = false; }
}

export function selectStoryCutProject(folder) {
  rememberProject();
  clearProjectPlan();
  S.projectFolder = folder;
  S.projectName = getProjectDisplayName(folder);
  S.projectInitialized = true;
  return loadScripts();
}

async function selectBrand(brand) {
  rememberProject();
  const token = ++S.projectLoadToken;
  clearProjectPlan();
  S.activeBrand = brand;
  S.projectFolder = '';
  S.projectName = '';
  S.mediaRoot = '';
  S.availableProjects = [];
  S.visualFolders = [];
  S.projectInitialized = true;
  try { localStorage.setItem('editflow_active_brand', brand); } catch (_) {}
  setBusy(true, 'Loading dated projects...');
  try {
    await Promise.all([loadBrandProjects(), loadVisualFolders()]);
    if (token !== S.projectLoadToken) return;
    let saved = '';
    try { saved = localStorage.getItem('editflow_brand_project:' + brand.toLowerCase()) || ''; } catch (_) {}
    const selected = S.availableProjects.find(p => p.path === saved);
    if (selected) {
      S.projectFolder = selected.path;
      await loadScripts();
    } else {
      setBusy(false);
      S.showFolderModal = false;
      setStatus('info', 'Choose this brand\'s dated project folder to load its scripts.');
      render();
    }
  } catch (e) {
    if (token !== S.projectLoadToken) return;
    setBusy(false);
    setStatus('error', 'Could not load projects: ' + e.message);
    render();
  }
}

async function loadScripts(forceIndex = false) {
  const token = ++S.projectLoadToken;
  invalidatePlan();
  setBusy(true, 'Indexing project assets & loading scripts...');
  try {
    const info = await initProjectFolder();
    if (token !== S.projectLoadToken) return;
    if (!info) return;
    S.projectFolder = info.project_folder;
    S.projectName = info.project_name;
    S.scriptsFolder = info.scripts_folder;
    S.mediaRoot = info.brand_root || info.project_folder;
    S.projectInitialized = true;
    S.activeBrand = info.brand || '';
    try {
      localStorage.setItem('editflow_project_folder', S.projectFolder);
      localStorage.setItem('editflow_active_brand', S.activeBrand);
    } catch (_) {}
    await loadBrands();
    if (token !== S.projectLoadToken) return;
    await loadBrandProjects();
    if (token !== S.projectLoadToken) return;
    try {
      const idxRes = await apiPost('/api/media-resolver/index', {
        root_dir: S.mediaRoot,
        force: forceIndex,
      });
      if (token !== S.projectLoadToken) return;
      if (idxRes) {
        S.assetsCount = idxRes.total_items || 0;
      }
    } catch (ie) {
      console.warn('[StoryCut] Index failed:', ie);
    }

    try {
      await loadVisualFolders();
    } catch (vle) {
      console.warn('[StoryCut] Load visual folders failed:', vle);
    }

    const res = await apiGet(`/api/script-assembly/scripts?folder_path=${encodeURIComponent(S.projectFolder)}`);
    if (token !== S.projectLoadToken) return;
    if (res && res.scripts) {
      S.scripts = res.scripts;
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(projectStorageKey()) || '{}'); } catch (_) {}
      S.customMode = !!saved.customMode;
      S.customContent = saved.customContent || '';
      S.mode = saved.mode === 'timeline_overlay' ? 'timeline_overlay' : 'rough_cut';
      const selected = S.selectedScriptPath || saved.selectedScriptPath;
      const defaultScript = S.scripts.find(s => s.full_path === selected) || S.scripts[0];
      if (defaultScript) {
        S.selectedScriptPath = defaultScript.full_path;
        S.selectedScriptTitle = defaultScript.name.replace(/\.md$/i, '');
        S.sequenceName = `Rough Cut - ${S.selectedScriptTitle}`;
      } else {
        S.selectedScriptPath = '';
        S.selectedScriptTitle = '';
        S.sequenceName = 'Rough Cut';
      }
      rememberProject();
      setStatus('info', S.scripts.length
        ? `${S.scripts.length} scripts loaded for ${S.projectName}.`
        : `Save this project's scripts in ${S.scriptsFolder}`);
    }
  } catch (e) {
    if (token !== S.projectLoadToken) return;
    console.error('[StoryCut] Failed to load scripts:', e);
    setStatus('error', 'Could not load script library: ' + e.message);
  } finally {
    if (token === S.projectLoadToken) {
      setBusy(false);
      render();
      if (S.mode === 'rough_cut' && S.selectedScriptPath) await compileScript();
    }
  }
}

function invalidatePlan() {
  S.operationToken++;
  S.plan = null;
  S.planKind = null;
  S.planInputKey = null;
  S.edlOps = [];
}

function scriptSelectionKey() {
  return JSON.stringify([S.projectFolder,S.selectedScriptPath,S.customMode,S.customContent,S.variantId,S.aspectRatio,S.fps]);
}

let checkingScript = false;
export async function refreshSelectedScript(force = false) {
  if (checkingScript || S.busy || S.mode !== 'rough_cut' || S.customMode || !S.selectedScriptPath) return;
  checkingScript = true;
  const selection = scriptSelectionKey();
  try {
    const fresh = await apiGet(`/api/script-assembly/script-content?path=${encodeURIComponent(S.selectedScriptPath)}&_=${Date.now()}`);
    if (selection !== scriptSelectionKey() || S.mode !== 'rough_cut') return;
    const changed = !S.plan || fresh.revision !== S.plan.script_revision || fresh.execution_revision !== (S.plan.execution_revision || '');
    if (force || changed) await compileScript();
  } catch (e) {
    if (selection === scriptSelectionKey()) {
      invalidatePlan();
      setStatus('error', `Cannot read the current script: ${e.message}`);
      render();
    }
  } finally { checkingScript = false; }
}

export async function openScriptLibrary(query = '') {
  const brand = S.activeBrand, project = S.projectFolder;
  const requestToken = ++S.scriptLibraryToken;
  S.scriptReferenceToken++;
  if (!brand) { setStatus('error', 'Choose a brand to browse previous scripts.'); render(); return; }
  S.showScriptLibrary = true;
  S.scriptReference = null;
  S.scriptLibrary = null;
  render();
  try {
    const result = await apiGet(`/api/script-assembly/script-catalog?brand=${encodeURIComponent(brand)}&project_folder=${encodeURIComponent(project)}&query=${encodeURIComponent(query)}`);
    if (!result?.success) throw new Error(result?.detail || 'Script catalog is unavailable.');
    if (requestToken !== S.scriptLibraryToken || brand !== S.activeBrand || project !== S.projectFolder || !S.showScriptLibrary) return;
    S.scriptLibrary = result;
  } catch (e) { if (brand === S.activeBrand && project === S.projectFolder) setStatus('error', `Cannot load previous scripts: ${e.message}`); }
  render();
}

export async function readScriptReference(path) {
  const brand = S.activeBrand, project = S.projectFolder;
  const requestToken = ++S.scriptReferenceToken;
  S.scriptReference = null;
  try {
    const result = await apiGet(`/api/script-assembly/script-reference?brand=${encodeURIComponent(brand)}&path=${encodeURIComponent(path)}`);
    if (!result?.success) throw new Error(result?.detail || 'Script reference is unavailable.');
    if (requestToken !== S.scriptReferenceToken || brand !== S.activeBrand || project !== S.projectFolder || !S.showScriptLibrary) return;
    S.scriptReference = result;
  } catch (e) { if (brand === S.activeBrand && project === S.projectFolder) setStatus('error', `Cannot read previous script: ${e.message}`); }
  render();
}

function startScriptWatch() {
  if (S.scriptWatchTimer) return;
  S.scriptWatchTimer = setInterval(() => {
    const view = document.getElementById('story-cut-view');
    if (!document.hidden && view && !view.classList.contains('hidden')) {
      refreshProjectScriptList().catch(e => console.warn('[StoryCut] Script list refresh:', e.message));
      refreshSelectedScript();
    }
  }, 3000);
}
window.addEventListener('focus', () => {
  const view = document.getElementById('story-cut-view');
  if (view && !view.classList.contains('hidden')) refreshSelectedScript();
});

export async function compileScript() {
  if (S.mode !== 'rough_cut') return;
  invalidatePlan();
  if (!(S.customMode ? S.customContent : S.selectedScriptPath)) { setBusy(false); render(); return; }

  stopAudioPreview();
  const projectToken = S.projectLoadToken;
  const operationToken = S.operationToken;
  const selection = scriptSelectionKey();
  const current = () => projectToken === S.projectLoadToken && operationToken === S.operationToken && selection === scriptSelectionKey() && S.mode === 'rough_cut';
  setBusy(true, 'Compiling cuts & resolving takes...');
  try {
    const payload = S.customMode
      ? {
          script_content: S.customContent,
          project_folder: S.projectFolder,
          title: S.sequenceName || 'Custom Cut',
          aspect_ratio: S.aspectRatio,
          fps: S.fps,
          auto_broll: true,
          pacing_style: S.pacing || 'editorial',
        }
      : {
          script_path: S.selectedScriptPath,
          project_folder: S.projectFolder,
          title: S.selectedScriptTitle,
          aspect_ratio: S.aspectRatio,
          fps: S.fps,
          auto_broll: true,
          pacing_style: S.pacing || 'editorial',
        };
    payload.brand = S.activeBrand;
    payload.variant_id = S.variantId || 'primary';

    const res = await apiPost('/api/script-assembly/compile', payload);
    if (!current()) return;
    if (res && res.success && res.plan) {
      S.plan = res.plan;
      S.planKind = 'script';
      S.planInputKey = selection;
      S.edlOps = res.edl_ops || [];
      if (!S.sequenceNameEdited) {
        S.sequenceName = `Rough Cut - ${S.plan.title}`;
      }
      for (const op of S.edlOps) { if (op.action === 'create_sequence') op.name = S.sequenceName; }
      const errors = (S.plan.validation && S.plan.validation.errors) || [];
      const warnings = (S.plan.validation && S.plan.validation.warnings) || [];
      setStatus(errors.length ? 'error' : 'info', errors.length
        ? errors.map(e => `Beat ${e.beat || '?'}: ${e.message}`).join(' • ')
        : `Compiled ${S.plan.cuts.length} cuts (${S.plan.summary.total_duration}s), revision ${(S.plan.script_revision || '').slice(0,8)}. ${warnings.map(w => w.message).join(' ') || 'Ready to review and assemble.'}`);
    } else {
      setStatus('error', (res && res.detail) || 'Failed to compile script.');
    }
  } catch (e) {
    if (!current()) return;
    console.error('[StoryCut] Compilation error:', e);
    setStatus('error', 'Compile error: ' + e.message);
  } finally {
    if (current()) {
      setBusy(false);
      render();
    }
  }
}

// ── Timeline Visual Overlay Functions ─────────────────────────

async function detectActiveSequence() {
  try {
    const res = await callExtendScript('callModule', { module: 'captionsManager', fn: 'sequenceInfo' });
    if (res && res.name) {
      S.activeSequence = {
        id: res.id,
        fps: res.fps,
        name: res.name,
        duration: res.duration || 0,
        width: res.width || 1080,
        height: res.height || 1920,
      };
      if (S.mode === 'timeline_overlay' && !S.selectedScriptPath && S.scripts.length) {
        autoSelectMatchingScript(res.name);
      }
    }
  } catch (e) {
    console.warn('[StoryCut] Could not query sequenceInfo:', e);
  }
}

function autoSelectMatchingScript(sequenceName) {
  if (!sequenceName || !S.scripts.length) return;
  const cleanSeq = sequenceName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const match = S.scripts.find((s) => {
    const cleanS = s.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return cleanSeq.includes(cleanS) || cleanS.includes(cleanSeq);
  });
  if (match) {
    S.selectedScriptPath = match.full_path;
    S.selectedScriptTitle = match.name.replace(/\.md$/i, '');
  }
}

export async function switchMode(newMode) {
  if (S.mode === newMode) return;
  invalidatePlan();
  setBusy(false);
  S.mode = newMode;
  rememberProject();
  stopAudioPreview();
  if (newMode === 'timeline_overlay') {
    await detectActiveSequence();
    if (S.activeSequence && S.activeSequence.name) {
      setStatus('info', `Switched to Timeline Overlay: "${S.activeSequence.name}" active.`);
    }
  } else {
    setStatus('info', 'Switched to Rough Cut mode.');
    if (!S.plan && S.selectedScriptPath) {
      await compileScript();
    }
  }
  render();
}

async function analyzeTimelineVisuals() {
  if (S.mode !== 'timeline_overlay' || S.busy) return;
  invalidatePlan();
  const operationToken = S.operationToken;
  const projectToken = S.projectLoadToken;
  stopAudioPreview();
  // Clear any previous cuts so no stale "Place Visuals" button is shown while transcribing
  S.plan = null;
  S.edlOps = [];
  setBusy(true, 'Extracting sequence audio cuts from active Premiere sequence...', 1, 'Extracting Sequence Audio');
  let stageTimer = null;
  try {
    await detectActiveSequence();
    if (operationToken !== S.operationToken) return;
    const analyzedSequenceId = S.activeSequence && S.activeSequence.id;
    const clipsRes = await callExtendScript('callModule', {
      module: 'captionsManager',
      fn: 'sequenceAudioClips',
      useInOut: false,
    });
    if (!clipsRes || !clipsRes.clips || !clipsRes.clips.length) {
      setStatus('error', 'No unmuted audio clips found in the active Premiere Pro sequence.');
      setBusy(false);
      return;
    }

    setBusy(true, `Transcribing timeline dialogue (${clipsRes.clips.length} clips) with GPU Whisper...`, 2, 'Transcribing Dialogue (Whisper AI)');

    stageTimer = setTimeout(() => {
      if (operationToken === S.operationToken && S.busy && S.busyStage === 2) {
        const bCount = (S.visualFolders || []).reduce((acc, f) => acc + (f.broll_count || 0), 0);
        setBusy(true, `Matching micro-visuals from Visual Library (${bCount || 0} B-Rolls)...`, 3, 'Matching Micro-Visuals');
      }
    }, 7000);

    const payload = {
      brand: S.activeBrand,
      project_folder: S.projectFolder,
      sequence_width: S.activeSequence && S.activeSequence.width,
      sequence_height: S.activeSequence && S.activeSequence.height,
      fps: (S.activeSequence && S.activeSequence.fps) || S.fps,
      clips: clipsRes.clips,
      sequence_name: (S.activeSequence && S.activeSequence.name) || clipsRes.name || 'Active Sequence',
      duration: (S.activeSequence && S.activeSequence.duration) || 60.0,
      script_path: S.customMode ? undefined : (S.selectedScriptPath || undefined),
      script_content: S.customMode ? S.customContent : undefined,
      aspect_ratio: S.aspectRatio,
      pacing_style: S.pacing || 'editorial',
      target_track: S.targetVideoTrack !== undefined ? S.targetVideoTrack : 1,
    };

    const res = await apiPost('/api/timeline-visuals/analyze', payload, { timeoutMs: 180000 });
    if (projectToken !== S.projectLoadToken || operationToken !== S.operationToken) return;
    if (res && res.success) {
      S.planKind = 'timeline';
      S.plan = {
        source_sequence_id: analyzedSequenceId,
        title: res.sequence_name,
        target_duration: Math.round((res.duration || 60) * 100) / 100,
        cuts: res.cuts || [],
        broll_clips: res.broll_placements || [],
        transcription_segments: res.transcription_segments || [],
        summary: res.summary,
      };
      S.edlOps = res.edl_ops || [];
      const vCount = res.summary ? res.summary.total_visuals : S.plan.broll_clips.length;
      const trkDisplay = S.targetVideoTrack === -1 ? 'Auto Empty Track' : `Track V${S.targetVideoTrack + 1}`;
      setStatus('success', `Transcribed ${res.cuts.length} beats & matched ${vCount} visuals for ${trkDisplay}.`);
    } else {
      setStatus('error', (res && res.detail) || 'Failed to analyze timeline visuals.');
    }
  } catch (e) {
    if (operationToken !== S.operationToken) return;
    console.error('[StoryCut] Timeline visuals error:', e);
    setStatus('error', 'Timeline visuals error: ' + e.message);
  } finally {
    if (stageTimer) clearTimeout(stageTimer);
    if (projectToken === S.projectLoadToken && operationToken === S.operationToken) setBusy(false);
  }
}

async function recomputeTimelineVisuals() {
  if (S.mode !== 'timeline_overlay') { await compileScript(); return; }
  if (!S.plan || S.planKind !== 'timeline' || !S.plan.transcription_segments || !S.plan.transcription_segments.length) {
    setStatus('info', 'Use Transcribe & Match Visuals to analyze the timeline explicitly.');
    return;
  }
  const operationToken = ++S.operationToken;
  S.edlOps = [];
  setBusy(true, `Recomputing ${S.pacing} visual placements...`);
  const projectToken = S.projectLoadToken;
  try {
    const res = await apiPost('/api/timeline-visuals/recompute', {
      brand: S.activeBrand,
      project_folder: S.projectFolder,
      sequence_width: S.activeSequence && S.activeSequence.width,
      sequence_height: S.activeSequence && S.activeSequence.height,
      fps: (S.activeSequence && S.activeSequence.fps) || S.fps,
      segments: S.plan.transcription_segments,
      sequence_name: S.plan.title,
      duration: S.plan.target_duration,
      aspect_ratio: S.aspectRatio,
      pacing_style: S.pacing || 'editorial',
      target_track: S.targetVideoTrack !== undefined ? S.targetVideoTrack : 1,
    }, { timeoutMs: 60000 });
    if (projectToken !== S.projectLoadToken || operationToken !== S.operationToken) return;
    if (res && res.success) {
      S.plan.cuts = res.cuts || [];
      S.plan.broll_clips = res.broll_placements || [];
      S.plan.summary = res.summary;
      S.edlOps = res.edl_ops || [];
      const vCount = res.summary ? res.summary.total_visuals : S.plan.broll_clips.length;
      const trkDisplay = S.targetVideoTrack === -1 ? 'Auto Empty Track' : `Track V${S.targetVideoTrack + 1}`;
      setStatus('info', `Recomputed ${vCount} visuals (${res.pacing_style}) for ${trkDisplay}.`);
    }
  } catch (e) {
    if (operationToken !== S.operationToken) return;
    console.warn('[StoryCut] Recompute error:', e);
  } finally {
    if (projectToken === S.projectLoadToken && operationToken === S.operationToken) { setBusy(false); render(); }
  }
}

// ── Audio Preview Controls ───────────────────────────────────

function toggleAudioPreview(cutIndex) {
  if (S.playingCutIndex === cutIndex) {
    stopAudioPreview();
    render();
    return;
  }

  const cut = S.plan && S.plan.cuts.find((c) => c.cut_index === cutIndex);
  if (!cut || !cut.source_file) {
    setStatus('error', 'No audio source available for this cut.');
    return;
  }

  const base = getBaseUrl ? getBaseUrl() : 'http://127.0.0.1:8765';
  const url = `${base}/api/media-resolver/audio-preview?path=${encodeURIComponent(cut.source_file)}`;

  S.playingCutIndex = cutIndex;
  S.audioElement.src = url;
  S.audioElement.currentTime = cut.source_in || 0;
  S.audioElement.play().catch((err) => {
    console.warn('[StoryCut] Audio playback prevented:', err);
    stopAudioPreview();
    render();
  });

  render();
}

function onAudioTimeUpdate() {
  if (!S.playingCutIndex || !S.plan) return;
  const cut = S.plan.cuts.find((c) => c.cut_index === S.playingCutIndex);
  if (!cut) return;

  if (S.audioElement.currentTime >= cut.source_out) {
    stopAudioPreview();
    render();
  }
}

function onAudioEnded() {
  stopAudioPreview();
  render();
}

function stopAudioPreview() {
  if (S.audioElement) {
    try {
      S.audioElement.pause();
    } catch (_) {}
  }
  S.playingCutIndex = null;
}

// ── In/Out Nudge Steppers ────────────────────────────────────

function nudgeCut(cutIndex, field, delta) {
  if (!S.plan || !S.plan.cuts) return;
  const cut = S.plan.cuts.find((c) => c.cut_index === cutIndex);
  if (!cut) return;

  if (field === 'in') {
    cut.source_in = Math.max(0, Math.round((cut.source_in + delta) * 100) / 100);
    cut.duration = Math.max(0.3, Math.round((cut.source_out - cut.source_in) * 100) / 100);
  } else if (field === 'out') {
    cut.source_out = Math.max(cut.source_in + 0.3, Math.round((cut.source_out + delta) * 100) / 100);
    cut.duration = Math.max(0.3, Math.round((cut.source_out - cut.source_in) * 100) / 100);
  }

  let runningTimeline = 0.0;
  for (const c of S.plan.cuts) {
    c.timeline_start = Math.round(runningTimeline * 100) / 100;
    c.timeline_end = Math.round((runningTimeline + c.duration) * 100) / 100;
    runningTimeline += c.duration;
  }
  S.plan.target_duration = Math.round(runningTimeline * 100) / 100;

  updateEdlOpsFromPlan();
  render();
}

// ── Interactive Take Swapping ────────────────────────────────

async function openTakeSwap(cutIndex) {
  if (S.activePopoverCutIndex === cutIndex && S.popoverType === 'take') {
    closePopover();
    render();
    return;
  }

  const cut = S.plan && S.plan.cuts.find((c) => c.cut_index === cutIndex);
  if (!cut || !cut.speaker) return;

  setBusy(true, `Finding alternative takes for ${cut.speaker}...`);
  try {
    const res = await apiGet(`/api/media-resolver/speaker/${encodeURIComponent(cut.speaker)}/clips`);
    if (res && res.clips && res.clips.length) {
      S.popoverItems = res.clips;
      S.activePopoverCutIndex = cutIndex;
      S.popoverType = 'take';
    } else {
      setStatus('info', `No alternate takes found for ${cut.speaker}.`);
    }
  } catch (e) {
    console.error('[StoryCut] Error fetching speaker clips:', e);
  } finally {
    setBusy(false);
    render();
  }
}

function selectTakeSwap(cutIndex, clip) {
  const cut = S.plan.cuts.find((c) => c.cut_index === cutIndex);
  if (!cut) return;

  cut.source_stem = clip.stem;
  cut.source_file = clip.path;
  closePopover();
  updateEdlOpsFromPlan();
  setStatus('info', `Cut #${cutIndex} swapped to ${clip.name}.`);
  render();
}

// ── Visual Library Folders Management ────────────────────────

async function loadBrands() {
  try {
    const res = await apiGet('/api/visual-library/brands');
    if (res && res.success && res.brands) {
      S.availableBrands = res.brands;
      if (S.activeBrand && !S.availableBrands.includes(S.activeBrand)) S.availableBrands.push(S.activeBrand);
      render();
    }
  } catch (e) {
    console.warn('[StoryCut] Error loading brands:', e);
  }
}

async function loadVisualFolders() {
  const brand = S.activeBrand;
  const project = S.projectFolder;
  try {
    if (!brand) { S.visualFolders = []; return; }
    const brandParam = `?brand=${encodeURIComponent(brand)}`;
    const res = await apiGet(`/api/visual-library/folders${brandParam}`);
    if (brand !== S.activeBrand) return;
    if (res && res.success) {
      S.visualFolders = res.folders || [];
      try {
        const linked = await apiGet(`/api/library-sources/visuals?brand=${encodeURIComponent(brand)}&project_folder=${encodeURIComponent(project)}`);
        if (brand !== S.activeBrand || project !== S.projectFolder) return;
        S.basicSources = linked.sources || [];
      } catch (_) { S.basicSources = []; }
      render();
    }
  } catch (e) {
    console.warn('[StoryCut] Error loading visual folders:', e);
  }
}

async function saveBasicSource(values) {
  if (!S.projectFolder || !S.activeBrand) return;
  const project = S.projectFolder, brand = S.activeBrand;
  setBusy(true, 'Linking visual source...');
  try {
    await apiPost('/api/library-sources/visuals', { brand, project_folder: project, ...values }, {timeoutMs:120000});
    if (project !== S.projectFolder || brand !== S.activeBrand) return;
    invalidatePlan();
    await loadVisualFolders();
    setStatus('info', 'Visual sources updated. The current script will refresh.');
  } catch (e) { setStatus('error', e.message); }
  finally { if (project === S.projectFolder && brand === S.activeBrand) { setBusy(false); render(); } }
}

async function scanVisualBins() {
  const token = S.projectLoadToken;
  setBusy(true, 'Reading Premiere bins...');
  try {
    const scan = await callExtendScript('scanProject', {});
    if (token !== S.projectLoadToken) return;
    if (!scan?.path || !scan?.bins) throw new Error('Open and save the Premiere project first.');
    S.sourceScan = scan;
  } catch (e) { setStatus('error', e.message); }
  finally { setBusy(false); render(); }
}

async function addVisualFolder(folderPath) {
  if (!folderPath) return;
  const cleanPath = folderPath.replace(/^["']|["']$/g, '').trim();
  setBusy(true, 'Adding raw data folder to Visual Library...');
  try {
    const res = await apiPost('/api/visual-library/folders', {
      folder_path: cleanPath,
      brand: S.activeBrand,
      auto_analyze: true
    });
    if (res && res.success) {
      setStatus('success', `Added "${res.folder.name}" to Visual Library.`);
      await loadVisualFolders();
    } else {
      setStatus('error', res.detail || res.error || 'Failed to add folder.');
    }
  } catch (e) {
    setStatus('error', 'Error adding folder: ' + e.message);
  } finally {
    setBusy(false);
    render();
  }
}

async function transcribeAndIndexVl(folderPath = null) {
  const jobBrand = S.activeBrand;
  const projectToken = S.projectLoadToken;
  S.isTranscribingVl = true;
  S.vlProgressMsg = 'Starting Whisper transcription...';
  S.vlProgressPercent = 0;
  setStatus('info', 'Visual Library indexing started in background...');
  render();

  try {
    const res = await apiPost('/api/visual-library/transcribe-and-index', {
      folder_path: folderPath,
      brand: S.activeBrand,
      force: false
    });
    if (res && res.success) {
      const pollTimer = setInterval(async () => {
        if (projectToken !== S.projectLoadToken || jobBrand !== S.activeBrand) { clearInterval(pollTimer); return; }
        try {
          const st = await apiGet(`/api/visual-library/status?brand=${encodeURIComponent(jobBrand)}`);
          if (st && st.status) {
            if (st.status.job_id !== res.job_id) return;
            if (st.status.is_busy) {
              S.isTranscribingVl = true;
              S.vlProgressMsg = st.status.message || 'Transcribing footage...';
              S.vlProgressPercent = st.status.percent || 0;
              render();
            } else {
              clearInterval(pollTimer);
              S.isTranscribingVl = false;
              S.vlProgressMsg = '';
              S.vlProgressPercent = 100;
              setStatus(st.status.state === 'failed' ? 'error' : 'success', st.status.message || 'Visual Library indexing complete.');
              await loadVisualFolders();
              render();
            }
          }
        } catch (_) {
          clearInterval(pollTimer);
          S.isTranscribingVl = false;
          render();
        }
      }, 1500);
    } else {
      S.isTranscribingVl = false;
      setStatus('error', (res && res.detail) || 'Failed to initiate transcription.');
      render();
    }
  } catch (e) {
    S.isTranscribingVl = false;
    setStatus('error', 'Transcription error: ' + e.message);
    render();
  }
}

async function removeVisualFolder(folderPath) {
  if (!folderPath) return;
  setBusy(true, 'Removing folder from Visual Library...');
  try {
    const base = getBaseUrl();
    const delRes = await fetch(`${base}/api/visual-library/folders?folder_path=${encodeURIComponent(folderPath)}`, { method: 'DELETE' });
    const data = await delRes.json();
    if (data && data.success) {
      setStatus('info', 'Folder unlinked from Visual Library.');
      await loadVisualFolders();
    } else {
      setStatus('error', (data && data.detail) || 'Failed to remove folder.');
    }
  } catch (e) {
    setStatus('error', 'Error removing folder: ' + e.message);
  } finally {
    setBusy(false);
    render();
  }
}

async function rescanVisualLibrary() {
  setBusy(true, 'Triggering video quality scan across all raw data folders in background...');
  try {
    const res = await apiPost(`/api/visual-library/analyze?brand=${encodeURIComponent(S.activeBrand)}`);
    if (res && res.success) {
      setStatus('success', 'Visual Library analysis started in background.');
    } else {
      setStatus('error', (res && res.detail) || 'Failed to trigger rescan.');
    }
  } catch (e) {
    setStatus('error', 'Rescan error: ' + e.message);
  } finally {
    setBusy(false);
    render();
  }
}

async function autoPlaceBroll() {
  await compileScript();
}

// ── Interactive B-Roll Inserter ──────────────────────────────

async function openBrollSwap(cutIndex) {
  if (S.activePopoverCutIndex === cutIndex && S.popoverType === 'broll') {
    closePopover();
    render();
    return;
  }

  const cut = S.plan.cuts.find((c) => c.cut_index === cutIndex);
  if (!cut) return;

  const cue = cut.marker_comment || cut.quote || cut.caption_text || 'parking broken';
  setBusy(true, 'Finding matching visual B-roll from library...');
  try {
    const res = await apiGet(`/api/visual-library/match-cut?cue=${encodeURIComponent(cue)}&aspect_ratio=${encodeURIComponent(S.aspectRatio)}&brand=${encodeURIComponent(S.activeBrand)}&limit=12`);
    if (res && res.matches && res.matches.length) {
      S.popoverItems = res.matches;
      S.activePopoverCutIndex = cutIndex;
      S.popoverType = 'broll';
    } else {
      setStatus('info', 'No matching visual clips found in the library.');
    }
  } catch (e) {
    console.error('[StoryCut] Error finding B-roll:', e);
  } finally {
    setBusy(false);
    render();
  }
}

function selectBrollInsert(cutIndex, brollMatch) {
  const cut = S.plan.cuts.find((c) => c.cut_index === cutIndex);
  if (!cut) return;

  const inSec = parseFloat(brollMatch.recommended_in != null ? brollMatch.recommended_in : 0.0);
  const outSec = parseFloat(brollMatch.recommended_out != null ? brollMatch.recommended_out : inSec + 4.0);
  const dur = Math.min(cut.duration, outSec - inSec);
  const targetTrk = S.targetVideoTrack >= 0 ? S.targetVideoTrack : 1;

  if (!S.plan.broll_clips) S.plan.broll_clips = [];
  S.plan.broll_clips = S.plan.broll_clips.filter((b) => {
    if (b.cut_index != null && b.cut_index === cutIndex) return false;
    if (Math.abs(b.timeline_start - cut.timeline_start) < 0.2) return false;
    if (b.timeline_start >= cut.timeline_start && b.timeline_start < cut.timeline_end) return false;
    return true;
  });

  const clipName = brollMatch.filename || brollMatch.name || brollMatch.stem || 'Visual';
  S.plan.broll_clips.push({
    cut_index: cutIndex,
    name: clipName,
    stem: brollMatch.stem,
    source_file: brollMatch.path,
    source_in: inSec,
    source_out: inSec + dur,
    timeline_start: cut.timeline_start,
    timeline_end: cut.timeline_start + dur,
    duration: dur,
    cluster: brollMatch.category || 'B-Roll',
    track: targetTrk,
    video_track: targetTrk,
    item_id: brollMatch.id || '',
  });

  cut.has_broll_overlay = true;
  cut.broll_name = clipName;

  closePopover();
  updateEdlOpsFromPlan();
  setStatus('success', `Added visual overlay "${clipName}" on Track V${targetTrk + 1}.`);
  render();
}

function removeMicroBroll(cutIndex, brollIndex) {
  if (!S.plan || !S.plan.cuts) return;
  const cut = S.plan.cuts.find((c) => c.cut_index === cutIndex);
  if (!cut || !S.plan.broll_clips) return;

  const cutBrolls = S.plan.broll_clips.filter(
    (b) => (b.cut_index != null && b.cut_index === cutIndex) ||
           (b.timeline_start >= cut.timeline_start && b.timeline_start < cut.timeline_end)
  );

  if (brollIndex >= 0 && brollIndex < cutBrolls.length) {
    const targetBroll = cutBrolls[brollIndex];
    S.plan.broll_clips = S.plan.broll_clips.filter((b) => b !== targetBroll);
  }

  const remaining = S.plan.broll_clips.filter(
    (b) => (b.cut_index != null && b.cut_index === cutIndex) ||
           (b.timeline_start >= cut.timeline_start && b.timeline_start < cut.timeline_end)
  );

  if (remaining.length === 0) {
    cut.has_broll_overlay = false;
    cut.broll_name = null;
  } else {
    cut.broll_name = remaining.map((b) => b.name || 'Visual').slice(0, 2).join(' -> ');
  }

  updateEdlOpsFromPlan();
  setStatus('info', `Removed visual from Cut #${cutIndex}.`);
  render();
}

function closePopover() {
  S.activePopoverCutIndex = null;
  S.popoverType = null;
  S.popoverItems = [];
}

// ── EDL Ops Regeneration ─────────────────────────────────────

function updateEdlOpsFromPlan() {
  if (!S.plan) return;
  if (S.planKind !== (S.mode === 'rough_cut' ? 'script' : 'timeline')) { S.edlOps = []; return; }
  if (S.plan.validation && !S.plan.validation.valid) { S.edlOps = []; return; }

  // Timeline Overlay Mode: Only generate B-roll overlay operations (never touch dialogue sequence)
  if (S.mode === 'timeline_overlay') {
    const trkDisplay = S.targetVideoTrack === -1 ? 'Auto Track' : `Track V${S.targetVideoTrack + 1}`;
    const ops = [];
    ops.push({ action: 'beginUndoGroup', name: `EditFlow: Place Visuals on ${trkDisplay}` });
    ops.push({ action: 'clone_sequence', name: `${S.plan.title} - Visuals review` });
    ops.appendBin = true;
    ops.push({ action: 'ensure_bin', bin_name: '_EditFlow Raw' });

    const files = new Set();
    if (S.plan.broll_clips) {
      for (const b of S.plan.broll_clips) if (b.source_file) files.add(b.source_file);
    }
    for (const f of files) {
      ops.push({ action: 'import_file', mediaPath: f, bin_name: '_EditFlow Raw' });
    }

    if (S.plan.broll_clips) {
      const targetTrk = S.targetVideoTrack;
      for (const b of S.plan.broll_clips) {
        if (!b.source_file) continue;
        ops.push({
          action: 'add',
          mediaPath: b.source_file,
          startTime: b.timeline_start,
          inPoint: b.source_in,
          outPoint: b.source_out,
          video_track_index: (b.video_track != null && b.video_track >= 0) ? b.video_track : targetTrk,
          audio_track_index: -1,
          fit_mode: b.is_still ? 'contain' : 'fill',
          zoom: 1.0,
          ...(b.framing || {}),
          auto_detect_track: S.targetVideoTrack === -1,
        });
      }
    }

    ops.push({ action: 'endUndoGroup' });
    S.edlOps = ops;
    return;
  }

  // Rough Cut Mode: Full sequence assembly from scratch
  const seqName = S.sequenceName || `Rough Cut - ${S.plan.title}`;
  const ops = [];

  ops.push({ action: 'beginUndoGroup', name: `EditFlow: ${seqName}` });
  ops.appendBin = true;
  ops.push({ action: 'ensure_bin', bin_name: '_EditFlow Raw' });

  const files = new Set();
  for (const c of S.plan.cuts) if (c.source_file) files.add(c.source_file);
  if (S.plan.broll_clips) {
    for (const b of S.plan.broll_clips) if (b.source_file) files.add(b.source_file);
  }
  for (const f of files) {
    ops.push({ action: 'import_file', mediaPath: f, bin_name: '_EditFlow Raw' });
  }

  const baseClip = S.plan.cuts[0] ? S.plan.cuts[0].source_file : null;
  ops.push({ action: 'ensure_bin', bin_name: 'EditFlow Rough Cuts' });
  ops.push({
    action: 'create_sequence',
    name: seqName,
    preset_from_clip_path: baseClip,
    width: S.plan.width,
    height: S.plan.height,
    fps: S.plan.fps,
  });

  for (const c of S.plan.cuts) {
    if (!c.source_file) continue;
    ops.push({
      action: 'add',
      mediaPath: c.source_file,
      startTime: c.timeline_start,
      inPoint: c.source_in,
      outPoint: c.source_out,
      video_track_index: c.video_track || 0,
      audio_track_index: c.audio_track || 0,
      audio_lead_frames: c.audio_lead_frames || 0,
      scale_punch_in: c.scale_punch_in || 1.0,
      fit_mode: c.fit_mode || 'fill',
      zoom: c.scale_punch_in || 1.0,
      single_channel_dialogue: true,
      ...(c.framing || {}),
    });
    const dialogue = c.quote || c.caption_text || c.marker_comment || '';
    ops.push({
      action: 'add_marker',
      time: c.timeline_start,
      name: `[${c.speaker}] Cut ${c.cut_index}`,
      comments: dialogue ? `"${dialogue}"` : 'Dialogue cut',
      color_index: 4,
    });
  }

  if (S.plan.broll_clips) {
    const targetTrk = S.targetVideoTrack === -1 ? 'auto' : (S.targetVideoTrack >= 0 ? S.targetVideoTrack : 1);
    for (const b of S.plan.broll_clips) {
      if (!b.source_file) continue;
      ops.push({
        action: 'add',
        mediaPath: b.source_file,
        startTime: b.timeline_start,
        inPoint: b.source_in,
        outPoint: b.source_out,
        video_track_index: b.video_track != null ? b.video_track : targetTrk,
        audio_track_index: -1,
        fit_mode: b.is_still ? 'contain' : 'fill',
        zoom: 1.0,
        ...(b.framing || {}),
        auto_detect_track: S.targetVideoTrack === -1,
      });
    }
  }

  ops.push({ action: 'endUndoGroup' });
  S.edlOps = ops;
}

// ── Assembly Dispatch ────────────────────────────────────────

let assemblyInFlight = false;
export async function assembleInPremiere() {
  if (assemblyInFlight || S.busy) return;
  assemblyInFlight = true;
  try { await assembleReviewedPlan(); } finally { assemblyInFlight = false; }
}

async function assembleReviewedPlan() {
  if (S.busy) return;
  const expectedKind = S.mode === 'rough_cut' ? 'script' : 'timeline';
  if (!S.plan || S.planKind !== expectedKind || !S.edlOps.length) {
    setStatus('error', S.mode === 'rough_cut' ? 'Compile the selected script before assembling.' : 'Use Transcribe & Match Visuals explicitly before placing timeline visuals.');
    return;
  }
  if (expectedKind === 'script' && S.planInputKey !== scriptSelectionKey()) {
    invalidatePlan();
    setStatus('error', 'The script selection or draft changed. Compile the current script first.');
    render();
    return;
  }
  const reviewedPlan = S.plan;
  const reviewedToken = S.operationToken;
  const stillReviewed = () => S.plan === reviewedPlan && S.operationToken === reviewedToken && S.planKind === expectedKind;
  if (S.plan) {
    try {
      const checked = await apiPost('/api/script-assembly/validate-plan', { plan: S.plan });
      if (!stillReviewed()) return;
      if (!checked || !checked.valid) {
        setStatus('error', ((checked && checked.errors) || []).map(e => e.message).join(' • ') || 'Review validation failed. Compile again.');
        return;
      }
    } catch (e) { setStatus('error', `Could not validate reviewed media: ${e.message}`); return; }
  }
  if (S.plan && S.plan.validation && !S.plan.validation.valid) {
    setStatus('error', 'Resolve the listed script sources and ranges, then compile again.');
    return;
  }
  if (S.plan && S.plan.script_path && S.plan.script_revision) {
    const fresh = await apiGet(`/api/script-assembly/script-content?path=${encodeURIComponent(S.plan.script_path)}`);
    if (!stillReviewed()) return;
    if (!fresh || fresh.revision !== S.plan.script_revision || fresh.execution_revision !== (S.plan.execution_revision || '')) {
      setStatus('error', 'The script changed since this review. Compile it again before assembly.');
      return;
    }
  }

  setBusy(true, 'Building sequence in Premiere Pro...', 3, 'Assembling Timeline in Premiere');
  try {
    try {
      if (typeof reloadExtensionRoot === 'function') {
        await reloadExtensionRoot();
      }
    } catch (ignore) {}

    const seqName = S.mode === 'timeline_overlay'
      ? ((S.activeSequence && S.activeSequence.name) || (S.plan && S.plan.title) || 'Active Sequence')
      : (S.sequenceName || (S.plan && S.plan.title ? `Rough Cut - ${S.plan.title}` : 'Rough Cut'));

    setStatus('info', `Executing ${S.edlOps.length} timeline operations on a review sequence...`);

    const project = await callExtendScript('getProjectDirectory', {});
    const normalizePath = p => String(p || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    if (!project || !project.projectPath || !normalizePath(project.projectPath).startsWith(normalizePath(S.projectFolder) + '/')) {
      setStatus('error', 'Open the selected project in Premiere before applying this review.');
      return;
    }
    if (!stillReviewed()) return;
    const res = await callExtendScript('processEDL', {
      ops: S.edlOps, sequence_name: seqName,
      expected_project_path: project.projectPath,
      expected_sequence_id: S.mode === 'timeline_overlay' ? S.plan.source_sequence_id : undefined,
    });
    if (!stillReviewed()) return;

    if (res && res.success && (!res.failedCount || res.failedCount === 0)) {
      const count = (S.plan && S.plan.broll_clips) ? S.plan.broll_clips.length : 0;
      const trkDisplay = S.targetVideoTrack === -1 ? 'empty video track' : `Track V${S.targetVideoTrack + 1}`;
      const msg = S.mode === 'timeline_overlay'
        ? `Placed ${count} visual overlays on ${trkDisplay}! Review copy created.`
        : `Assembled "${seqName}" with ${S.plan.cuts.length} cuts! Review copy created.`;
      setStatus('success', msg);
      await apiPost('/api/visual-library/usage', {
        brand: S.activeBrand,
        sequence_name: seqName,
        stems: (S.plan.broll_clips || []).map(b => b.name.replace(/\.[^.]+$/, '')),
      }).catch(e => console.warn('[StoryCut] Usage history:', e));
    } else {
      const err = (res && (res.error || (res.failedCount ? `${res.failedCount} timeline operations failed.` : null))) ||
        'ExtendScript assembly returned an error.';
      setStatus('error', err);
    }
  } catch (e) {
    console.error('[StoryCut] Assembly failed:', e);
    setStatus('error', 'Assembly error: ' + e.message);
  } finally {
    if (stillReviewed()) setBusy(false);
  }
}

function handoffToCaptions() {
  if (typeof window.__editflowOpenCaptions === 'function') {
    closeStoryCut();
    window.__editflowOpenCaptions();
  } else {
    alert('Captions Studio module is not available.');
  }
}

function setBusy(val, msg, stage = 1, title = null) {
  S.busy = val;
  S.busyStage = val ? stage : null;
  S.busyTitle = val ? title : null;
  if (msg) setStatus('info', msg);
  render();
}

function setStatus(type, message) {
  S.status = { type, message };
  const strip = document.getElementById('sc-live-status-strip');
  if (strip) {
    strip.className = `sc-status-strip ${type}`;
    let iconSvg = svgIcon('info');
    if (type === 'success') iconSvg = svgIcon('check');
    else if (type === 'error') iconSvg = svgIcon('alert');
    strip.innerHTML = `${iconSvg}<span class="sc-ellipsis" style="flex:1;">${escapeHtml(message)}</span>`;
  }
}

// ── Render Function ──────────────────────────────────────────

function render() {
  const v = document.getElementById('story-cut-view');
  if (!v) return;

  const plan = S.plan;
  const cuts = plan ? plan.cuts : [];
  const base = getBaseUrl ? getBaseUrl() : 'http://127.0.0.1:8765';
  const totalBrolls = (S.visualFolders || []).reduce((acc, f) => acc + (f.broll_count || 0), 0);
  const vlPillLabel = totalBrolls > 0 ? `${totalBrolls} B-Rolls` : 'Visual Library';
  const vlPillHtml = `
    <button id="sc-btn-toolbar-vl" class="sc-vl-pill" title="Visual Library: ${totalBrolls} B-Roll clips ready. Click to manage folders.">
      ${svgIcon('broll')}
      <span>${vlPillLabel}</span>
    </button>
  `;

  // 1. Storyboard Rows or Progress Card or Empty State
  let storyboardHtml = '';
  if (S.busy) {
    const stage = typeof S.busyStage === 'number' ? S.busyStage : 1;
    const isOverlay = S.mode === 'timeline_overlay';
    const step1Label = isOverlay ? '1. Audio Extract' : '1. Parse Script';
    const step2Label = isOverlay ? '2. Speech-to-Text' : '2. Match Takes';
    const step3Label = isOverlay ? '3. Visual Matching' : '3. Build Cuts';
    const centerIcon = stage === 1 ? 'waveform' : (stage === 2 ? 'timeline' : 'broll');

    storyboardHtml = `
      <div class="sc-progress-card">
        <div class="sc-progress-spinner">
          <svg class="sc-spinner-svg" viewBox="0 0 52 52">
            <circle class="sc-spinner-track" cx="26" cy="26" r="22" fill="none" stroke-width="3"></circle>
            <circle class="sc-spinner-head" cx="26" cy="26" r="22" fill="none" stroke-width="3"></circle>
          </svg>
          <div class="sc-progress-center-icon">
            ${svgIcon(centerIcon)}
          </div>
        </div>
        <div class="sc-progress-title">
          ${escapeHtml(S.busyTitle || (stage === 1 ? 'Extracting Sequence Audio' : (stage === 2 ? 'Transcribing Speech (Whisper AI)' : (stage === 3 ? 'Matching Micro-Visuals' : 'Processing Timeline'))))}
        </div>
        <div class="sc-progress-desc">
          ${escapeHtml(S.status ? S.status.message : 'Please wait while EditFlow processes your sequence...')}
        </div>
        <div class="sc-progress-steps">
          <div class="sc-step ${stage === 1 ? 'active' : (stage > 1 ? 'done' : '')}">
            <span class="sc-step-dot"></span>
            <span>${step1Label}</span>
          </div>
          <div class="sc-step-line ${stage > 1 ? 'done' : ''}"></div>
          <div class="sc-step ${stage === 2 ? 'active' : (stage > 2 ? 'done' : '')}">
            <span class="sc-step-dot"></span>
            <span>${step2Label}</span>
          </div>
          <div class="sc-step-line ${stage > 2 ? 'done' : ''}"></div>
          <div class="sc-step ${stage === 3 ? 'active' : (stage > 3 ? 'done' : '')}">
            <span class="sc-step-dot"></span>
            <span>${step3Label}</span>
          </div>
        </div>
        <div class="sc-pulse-bar-wrap">
          <div class="sc-pulse-bar"></div>
        </div>
        <div class="sc-progress-hint">
          Running on local hardware · GPU acceleration active · Mercury Playback safe
        </div>
      </div>
    `;
  } else if (cuts.length > 0) {
    storyboardHtml = cuts.map((c) => {
      const isPlaying = S.playingCutIndex === c.cut_index;
      const isJcut = c.audio_lead_frames > 0;
      const isPunch = c.scale_punch_in > 1.0;
      const isTrimOpen = S.activeTrimCutIndex === c.cut_index;

      const cutBrolls = (plan.broll_clips || []).filter(
        (b) => (b.cut_index != null && b.cut_index === c.cut_index) ||
               (b.timeline_start >= c.timeline_start && b.timeline_start < c.timeline_end)
      );

      let visualChipsHtml = '';
      if (cutBrolls.length > 0) {
        visualChipsHtml = cutBrolls.map((b, bIdx) => {
          const bId = b.item_id || b.id;
          const thumbUrl = bId ? `${base}/api/visual-library/thumb/${encodeURIComponent(bId)}` : '';
          const bName = b.name || (b.source_file ? b.source_file.split(/[\\/]/).pop() : null) || b.stem || 'Visual';
          const bDur = (b.duration || (b.timeline_end - b.timeline_start) || 2.0).toFixed(1);
          const bTrkNum = b.track != null ? b.track : (S.targetVideoTrack >= 0 ? S.targetVideoTrack : 1);
          const bTrkDisplay = `V${bTrkNum + 1}`;

          return `
            <div class="sc-broll-chip" title="${escapeHtml(bName)}">
              <div class="sc-broll-thumb-wrap">
                ${thumbUrl ? `
                  <img class="sc-broll-thumb" src="${thumbUrl}" alt="Visual" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" />
                  <div class="sc-broll-thumb-fallback" style="display:none;">${svgIcon('broll')}</div>
                ` : `
                  <div class="sc-broll-thumb-fallback">${svgIcon('broll')}</div>
                `}
                <span class="sc-broll-dur-tag">${bDur}s</span>
              </div>
              <div class="sc-broll-text">
                <div class="sc-broll-name">${escapeHtml(bName)}</div>
                <div class="sc-broll-track">Track ${bTrkDisplay}</div>
              </div>
              <button class="sc-broll-del-btn" data-action="remove-micro-broll" data-cut="${c.cut_index}" data-broll-idx="${bIdx}" title="Remove visual overlay">
                ${svgIcon('close')}
              </button>
            </div>
          `;
        }).join('');
      } else {
        visualChipsHtml = `
          <button class="sc-broll-empty-slot" data-action="open-broll-swap" data-cut="${c.cut_index}">
            ${svgIcon('plus')} Visual
          </button>
        `;
      }

      const quote = c.quote || c.caption_text || c.marker_comment || (plan.captions && plan.captions.find((cap) => Math.abs(cap.start - c.timeline_start) < 0.25) || {}).text || '';

      return `
        <div class="sc-row-item ${isPlaying ? 'playing' : ''}">
          <!-- Meta Column -->
          <div class="sc-col-meta">
            <span class="sc-meta-index">CUT #${c.cut_index}</span>
            <span class="sc-meta-time sc-mono">${c.timeline_start.toFixed(1)}s-${c.timeline_end.toFixed(1)}s</span>
            <span class="sc-meta-speaker" title="${escapeHtml(c.speaker || 'Voice')}">${escapeHtml(c.speaker || 'Voice')}</span>
            ${isJcut ? '<span style="font-size:9px; color:var(--sc-accent); margin-top:1px;">4f J-Cut</span>' : ''}
            ${isPunch ? '<span style="font-size:9px; color:#e68619; margin-top:1px;">108% Punch</span>' : ''}
          </div>

          <!-- Dialogue Quote Column -->
          <div class="sc-col-quote">
            "${escapeHtml(quote)}"
          </div>

          <!-- Visual B-Roll Column -->
          <div class="sc-col-visual">
            ${visualChipsHtml}
          </div>

          <!-- Actions Column (Hover-activated) -->
          <div class="sc-col-actions">
            <button class="sc-action-btn ${isPlaying ? 'active' : ''}" data-action="toggle-audio" data-cut="${c.cut_index}" title="${isPlaying ? 'Pause' : 'Preview sliced audio'}">
              ${isPlaying ? svgIcon('pause') : svgIcon('play')}
            </button>
            <button class="sc-action-btn" data-action="open-take-swap" data-cut="${c.cut_index}" title="Swap Take">
              ${svgIcon('swap')}
            </button>
            <button class="sc-action-btn" data-action="open-broll-swap" data-cut="${c.cut_index}" title="Match B-Roll">
              ${svgIcon('broll')}
            </button>
            <button class="sc-action-btn ${isTrimOpen ? 'active' : ''}" data-action="toggle-trim" data-cut="${c.cut_index}" title="Nudge In/Out">
              ${svgIcon('trim')}
            </button>
          </div>

          <!-- Inline Trim Popover -->
          ${isTrimOpen ? `
            <div class="sc-trim-popover">
              <div class="sc-trim-group">
                <span class="sc-trim-lbl">In:</span>
                <button class="sc-trim-stepper" data-action="nudge" data-cut="${c.cut_index}" data-field="in" data-delta="-0.5">-0.5s</button>
                <button class="sc-trim-stepper" data-action="nudge" data-cut="${c.cut_index}" data-field="in" data-delta="0.5">+0.5s</button>
                <span class="sc-mono" style="font-size:10px; color:var(--sc-text-secondary); margin-left:2px;">${fmtSec(c.source_in)}</span>
              </div>
              <div class="sc-trim-group">
                <span class="sc-trim-lbl">Out:</span>
                <button class="sc-trim-stepper" data-action="nudge" data-cut="${c.cut_index}" data-field="out" data-delta="-0.5">-0.5s</button>
                <button class="sc-trim-stepper" data-action="nudge" data-cut="${c.cut_index}" data-field="out" data-delta="0.5">+0.5s</button>
                <span class="sc-mono" style="font-size:10px; color:var(--sc-text-secondary); margin-left:2px;">${fmtSec(c.source_out)}</span>
              </div>
              <button class="sc-icon-btn" data-action="close-trim" style="width:20px; height:20px; margin-left:6px;" title="Close Nudge Controls">
                ${svgIcon('close')}
              </button>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
  } else {
    const vlEmptyCallout = totalBrolls === 0 ? `
      <div class="sc-vl-empty-card">
        <div class="sc-vl-empty-icon">${svgIcon('folder')}</div>
        <div class="sc-vl-empty-title">Visual Library Empty</div>
        <div class="sc-vl-empty-desc">Link your local B-Roll folder to allow EditFlow to automatically match visuals to your timeline speech.</div>
        <button id="sc-btn-empty-add-vl" class="sc-btn-primary" style="margin-top:4px; font-size:11.5px; height:28px;">
          ${svgIcon('plus')} Link Footage Folder
        </button>
      </div>
    ` : '';

    storyboardHtml = `
      ${vlEmptyCallout}
      <div style="flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; color:var(--sc-text-muted); padding:20px; text-align:center;">
        <div style="width:36px; height:36px; display:flex; align-items:center; justify-content:center; background:#242424; border-radius:50%; border:1px solid var(--sc-border);">
          ${svgIcon('timeline')}
        </div>
        <p style="font-size:12.5px; font-weight:500; color:var(--sc-text-secondary); margin:0;">
          ${S.mode === 'timeline_overlay' ? (totalBrolls > 0 ? `${totalBrolls} B-Roll Clips Indexed · Active Timeline Ready` : 'Active Timeline Ready to Transcribe') : 'No Script Compiled Yet'}
        </p>
        <p style="font-size:11px; max-width:320px; line-height:1.4; margin:0;">
          ${S.mode === 'timeline_overlay'
            ? 'Click "Transcribe & Match Visuals" below to extract speech and auto-place rhythmic B-rolls on an empty video track.'
            : 'Select a project script from the dropdown above or paste a custom script to compile rough cuts.'
          }
        </p>
      </div>
    `;
  }

  // 2. Script options
  const scriptOptions = S.scripts.map((s) => {
    const selected = s.full_path === S.selectedScriptPath ? 'selected' : '';
    const name = s.name.replace(/\.md$/i, '');
    const cat = s.category ? `[${s.category}] ` : '';
    return `<option value="${escapeHtml(s.full_path)}" ${selected}>${escapeHtml(cat + name)}</option>`;
  }).join('');

  // 3. Status indicator in footer
  let statusIcon = svgIcon('info');
  let statusClass = 'info';
  if (S.status) {
    statusClass = S.status.type;
    if (S.status.type === 'success') statusIcon = svgIcon('check');
    else if (S.status.type === 'error') statusIcon = svgIcon('alert');
  }

  v.innerHTML = `
    <!-- Native Header Row (38px) -->
    <header class="sc-header">
      <div class="sc-header-title">
        ${svgIcon('layers')}
        <span>Story Cut Studio</span>
      </div>

      <!-- Segmented Mode Control -->
      <div class="sc-segmented">
        <button class="sc-seg-btn ${S.mode === 'timeline_overlay' ? 'active' : ''}" data-action="switch-mode" data-mode="timeline_overlay" title="Transcribe active Premiere sequence and auto-place visuals">
          ${svgIcon('timeline')} Timeline Overlay
        </button>
        <button class="sc-seg-btn ${S.mode === 'rough_cut' ? 'active' : ''}" data-action="switch-mode" data-mode="rough_cut" title="Build rough cut from scratch with dialogue takes">
          ${svgIcon('film')} Rough Cut
        </button>
      </div>

      <div class="sc-header-spacer"></div>

      <!-- Settings / Drawer Toggle -->
      <button id="sc-btn-drawer" class="sc-icon-btn ${S.showMoreDrawer ? 'active' : ''}" title="Visual Library Folders & Project Settings">
        ${svgIcon('more')}
      </button>

      <!-- Close Panel -->
      <button id="sc-btn-close" class="sc-icon-btn" title="Close Story Cut">
        ${svgIcon('close')}
      </button>
    </header>

    <div class="sc-project-context">
      <label>Brand
        <select id="sc-brand-select" class="sc-compact-select" aria-label="Brand">
          ${!S.activeBrand ? '<option value="" selected>Choose brand</option>' : ''}
          ${S.availableBrands.map(b => `<option value="${escapeHtml(b)}" ${b === S.activeBrand ? 'selected' : ''}>${escapeHtml(b)}</option>`).join('')}
        </select>
      </label>
      <label>Project
        <select id="sc-project-select" class="sc-compact-select" aria-label="Dated project">
          ${!S.projectFolder ? '<option value="">Choose a dated project</option>' : ''}
          ${S.projectFolder && !S.availableProjects.some(p => p.path === S.projectFolder) ? `<option value="${escapeHtml(S.projectFolder)}" selected>${escapeHtml(S.projectName)}</option>` : ''}
          ${visibleScriptProjects().map(p => `<option value="${escapeHtml(p.path)}" ${p.path === S.projectFolder ? 'selected' : ''}>${escapeHtml(p.name)} (${p.script_count} scripts)</option>`).join('')}
        </select>
      </label>
      <button id="sc-toggle-empty-projects" class="sc-btn-subtle" aria-pressed="${S.showEmptyProjects}" title="Show or hide project folders with no scripts">${S.showEmptyProjects ? 'Hide empty' : 'Show empty'}</button>
      <button id="sc-btn-browse-project" class="sc-btn-subtle" title="Choose another project folder">${svgIcon('folder')}</button>
    </div>

    ${S.mode === 'rough_cut' && !S.customMode && S.selectedScriptPath ? `<div class="sc-drawer-row" style="padding:6px 12px;overflow-wrap:anywhere;user-select:text">Current script: ${escapeHtml(S.plan?.script_path || S.selectedScriptPath)}${S.plan?.script_revision ? ` · Revision ${escapeHtml(S.plan.script_revision.slice(0,8))}` : ''}</div>` : ''}

    ${S.showScriptLibrary ? `
      <section class="sc-drawer" aria-label="All scripts reference library">
        <div class="sc-drawer-row"><strong>All Scripts · ${escapeHtml(S.activeBrand)}</strong>
          <button id="sc-close-script-library" class="sc-btn-subtle">Close</button></div>
        <p>Read previous scripts for inspiration. New scripts belong in this project's Scripts folder.</p>
        <div class="sc-drawer-row"><input id="sc-library-query" class="sc-input" placeholder="Search titles, hooks or dialogue" aria-label="Search previous scripts">
          <button id="sc-search-script-library" class="sc-btn-subtle">Search</button></div>
        <select id="sc-reference-select" class="sc-compact-select" style="width:100%" aria-label="Previous script">
          <option value="">${S.scriptLibrary ? `Choose from ${S.scriptLibrary.total} scripts` : 'Loading scripts…'}</option>
          ${(S.scriptLibrary?.scripts || []).map(item => `<option value="${escapeHtml(item.full_path)}" ${S.scriptReference?.full_path === item.full_path ? 'selected' : ''}>[${escapeHtml(item.project_name)}] ${escapeHtml(item.name)}</option>`).join('')}
        </select>
        ${(S.scriptLibrary?.missing_paths || []).map(path => `<p>Missing library location: ${escapeHtml(path)}</p>`).join('')}
        ${S.scriptReference ? `<p style="overflow-wrap:anywhere">Original: ${escapeHtml(S.scriptReference.full_path)} · Revision ${escapeHtml(S.scriptReference.revision.slice(0,8))}</p>
          <pre style="white-space:pre-wrap;max-height:320px;overflow:auto;user-select:text">${escapeHtml(S.scriptReference.content)}</pre>` : ''}
      </section>` : ''}

    <!-- Slide-Down Drawer (Settings & Visual Library Folders) -->
    ${S.showMoreDrawer ? `
      <div class="sc-drawer">
        <div class="sc-drawer-row">
          <span class="sc-drawer-lbl">Project Folder:</span>
          <div class="sc-drawer-content">
            <div class="sc-drawer-chip" title="${escapeHtml(S.projectFolder)}">
              <span class="chip-name">${escapeHtml(S.projectName || 'Project')}</span>
              <span class="chip-count">${S.assetsCount} items</span>
            </div>
            <button id="sc-btn-change-folder" class="sc-btn-subtle" title="Switch project folder">
              ${svgIcon('folder')} Switch
            </button>
          </div>
        </div>

        <div class="sc-drawer-row">
          <span class="sc-drawer-lbl">Scripts Folder:</span>
          <div class="sc-drawer-content">
            <input class="sc-input sc-script-location" aria-label="Scripts folder path" readonly value="${escapeHtml(S.scriptsFolder)}" title="Save the agent's scripts here. Select and copy this path.">
          </div>
        </div>

        <div style="padding:8px 0">
          <strong>Visual sources for this project</strong>
          <p>Link a folder or a Premiere bin. Only its video/image paths are added. No transcription starts.</p>
          <input id="sc-basic-folder" class="sc-input" placeholder="Visuals folder path" aria-label="Visuals folder path">
          <button id="sc-basic-add-folder" class="sc-btn-subtle" ${S.busy ? 'disabled' : ''}>Link folder</button>
          <button id="sc-basic-scan" class="sc-btn-subtle" ${S.busy ? 'disabled' : ''}>Choose Premiere bin</button>
          ${S.sourceScan ? `<p>From: ${escapeHtml(S.sourceScan.path)}</p><select id="sc-basic-bin" class="sc-compact-select">
            ${S.sourceScan.bins.map(bin=>`<option value="${escapeHtml(bin.path)}">${escapeHtml(bin.path)}</option>`).join('')}</select>
            <button id="sc-basic-add-bin" class="sc-btn-subtle" ${S.busy ? 'disabled' : ''}>Link bin and sub-bins</button>` : ''}
          ${S.basicSources.filter(source=>!source.metadata.removed).map(source=>`<div style="padding:6px 0">
            ${escapeHtml(source.metadata.name)} · ${source.paths?.length || 0} files · ${source.enabled ? 'Enabled' : 'Disabled'}
            <button class="sc-btn-subtle" data-basic-id="${source.id}" data-basic-enabled="${!source.enabled}">${source.enabled ? 'Disable' : 'Enable'}</button>
            <button class="sc-btn-subtle" data-basic-remove="${source.id}">Remove</button>
            <details><summary>File paths</summary><pre style="max-height:150px;overflow:auto;white-space:pre-wrap;user-select:text">${escapeHtml((source.paths || []).join('\n'))}</pre></details>
          </div>`).join('')}
          <p>${S.basicSources.length ? 'The linked sources above control visual matching, including an empty selection when all are disabled.' : 'Your existing visual library is used until you link a source here.'}</p>
        </div>
        ${S.isTranscribingVl ? `
          <div class="sc-drawer-row" style="background:rgba(20, 115, 230, 0.08); border:1px solid rgba(20, 115, 230, 0.25); border-radius:6px; padding:8px 12px; margin-bottom:8px;">
            <div style="display:flex; justify-content:space-between; align-items:center; width:100%; margin-bottom:4px;">
              <span style="font-weight:600; font-size:11.5px; color:var(--sc-accent, #3b82f6); display:flex; align-items:center; gap:6px;">
                ${svgIcon('spinner')} Indexing Visual Footage
              </span>
              <span style="font-size:11px; color:var(--sc-text-secondary);">${escapeHtml(S.vlProgressMsg || '')}</span>
            </div>
            <div style="width:100%; height:4px; background:#222; border-radius:2px; overflow:hidden;">
              <div style="width:${S.vlProgressPercent || 0}%; height:100%; background:var(--sc-accent, #3b82f6); transition:width 0.3s ease;"></div>
            </div>
          </div>
        ` : ''}

        <div class="sc-drawer-row">
          <span class="sc-drawer-lbl">Visual Library:</span>
          <div class="sc-drawer-content" style="flex-wrap:wrap; gap:6px;">
            ${(S.visualFolders && S.visualFolders.length > 0) ? S.visualFolders.map((f) => `
              <div class="sc-drawer-chip" title="${escapeHtml(f.path)}">
                <span class="chip-name">${escapeHtml(f.name)}</span>
                <span class="chip-count" title="${f.broll_count} B-roll clips, ${f.total_assets} total">${f.broll_count} B-roll / ${f.total_assets}</span>
                <span class="chip-status ${f.transcribed_count >= f.total_assets && f.total_assets > 0 ? 'ready' : 'pending'}" style="font-size:10px; opacity:0.85;" title="${f.transcribed_count || 0}/${f.total_assets} clips transcribed">🎙️ ${f.transcribed_count || 0}/${f.total_assets}</span>
                <button class="chip-del" data-action="remove-vl-folder" data-path="${escapeHtml(f.path)}" title="Unlink folder">&times;</button>
              </div>
            `).join('') : '<span style="color:var(--sc-text-muted); font-size:11px;">No raw footage folders linked for this brand</span>'}
            <button id="sc-btn-open-add-vl" class="sc-btn-subtle" title="Add raw footage folder">
              ${svgIcon('plus')} Add Folder
            </button>
            <button id="sc-btn-transcribe-vl" class="sc-btn-subtle" style="color:var(--sc-accent, #3b82f6); font-weight:600;" title="Transcribe and index all footage in linked folders">
              ⚡ Transcribe &amp; Index
            </button>
            <button id="sc-btn-rescan-vl" class="sc-btn-subtle" title="Rescan video quality">
              ${svgIcon('refresh')} Rescan
            </button>
          </div>
        </div>

        ${S.mode === 'rough_cut' ? `
          <div class="sc-drawer-row">
            <span class="sc-drawer-lbl">Sequence Format:</span>
            <div class="sc-drawer-content">
              <div class="sc-segmented" style="padding:1px;">
                <button class="sc-seg-btn ${S.aspectRatio === '9:16' ? 'active' : ''}" data-aspect="9:16">9:16</button>
                <button class="sc-seg-btn ${S.aspectRatio === '16:9' ? 'active' : ''}" data-aspect="16:9">16:9</button>
                <button class="sc-seg-btn ${S.aspectRatio === '1:1' ? 'active' : ''}" data-aspect="1:1">1:1</button>
              </div>
              <input id="sc-seq-name-input" class="sc-input" style="max-width:220px;" type="text" value="${escapeHtml(S.sequenceName)}" placeholder="Sequence Name">
            </div>
          </div>
        ` : ''}
      </div>
    ` : ''}

    <!-- Compact Single-Row Controls Toolbar (36px) -->
    <div class="sc-toolbar">
      ${S.mode === 'timeline_overlay' ? `
        <!-- Active Sequence Breadcrumb -->
        <div class="sc-seq-breadcrumb" title="${escapeHtml(S.activeSequence ? S.activeSequence.name : 'Detecting sequence...')}">
          ${svgIcon('timeline')}
          <span class="sc-ellipsis">${escapeHtml((S.activeSequence && S.activeSequence.name) ? S.activeSequence.name : 'Active Sequence')}</span>
        </div>
        <button id="sc-btn-refresh-seq" class="sc-icon-btn" style="width:24px; height:24px;" title="Refresh active sequence from Premiere">
          ${svgIcon('refresh')}
        </button>

        <!-- Target Video Track Select -->
        <div class="sc-compact-select-wrap" style="margin-left:4px;">
          <select id="sc-track-select" class="sc-compact-select" title="Target video track for overlays">
            <option value="-1" ${S.targetVideoTrack === -1 ? 'selected' : ''}>Auto: Empty Track</option>
            <option value="1" ${S.targetVideoTrack === 1 ? 'selected' : ''}>Track V2</option>
            <option value="2" ${S.targetVideoTrack === 2 ? 'selected' : ''}>Track V3</option>
            <option value="3" ${S.targetVideoTrack === 3 ? 'selected' : ''}>Track V4</option>
            <option value="4" ${S.targetVideoTrack === 4 ? 'selected' : ''}>Track V5</option>
            <option value="5" ${S.targetVideoTrack === 5 ? 'selected' : ''}>Track V6</option>
            <option value="6" ${S.targetVideoTrack === 6 ? 'selected' : ''}>Track V7</option>
            <option value="7" ${S.targetVideoTrack === 7 ? 'selected' : ''}>Track V8</option>
          </select>
          <span class="sc-select-arrow">${svgIcon('chevron_down')}</span>
        </div>

        <!-- Pacing Style Select -->
        <div class="sc-compact-select-wrap">
          <select id="sc-pacing-select" class="sc-compact-select" title="Micro-visual pacing style">
            <option value="editorial" ${S.pacing === 'editorial' ? 'selected' : ''}>Editorial (1.4-2.2s)</option>
            <option value="dynamic" ${S.pacing === 'dynamic' ? 'selected' : ''}>Dynamic (1.0-1.6s)</option>
            <option value="talking_head" ${S.pacing === 'talking_head' ? 'selected' : ''}>Story (2.0-3.5s)</option>
          </select>
          <span class="sc-select-arrow">${svgIcon('chevron_down')}</span>
        </div>

        <!-- Visual Library Pill -->
        ${vlPillHtml}

        <!-- Optional Script Alignment Select -->
        <div class="sc-compact-select-wrap" style="flex:1; min-width:140px;">
          <select id="sc-alignment-select" class="sc-compact-select" style="width:100%;" title="Optional alignment reference for timeline analysis; does not build this script" ${S.busy ? 'disabled' : ''}>
            <option value="">Auto-Detect from Audio (No Script)</option>
            ${scriptOptions}
          </select>
          <span class="sc-select-arrow">${svgIcon('chevron_down')}</span>
        </div>
      ` : `
        <!-- Rough Cut Toolbar -->
        <div class="sc-compact-select-wrap" style="flex:1; min-width:160px;">
          <select id="sc-script-select" class="sc-compact-select" style="width:100%;" ${S.busy ? 'disabled' : ''}>
            <option value="">${S.scripts.length ? `-- Choose from ${S.scripts.length} Project Scripts --` : '-- No scripts found --'}</option>
            ${scriptOptions}
          </select>
          <span class="sc-select-arrow">${svgIcon('chevron_down')}</span>
        </div>

        <button id="sc-btn-toggle-custom" class="sc-btn-subtle" title="Toggle custom Markdown script">
          ${S.customMode ? 'Script Library' : 'Custom Script'}
        </button>
        <button id="sc-btn-refresh-script" class="sc-btn-subtle" ${S.busy ? 'disabled' : ''} title="Read the current file and recompile">Refresh script</button>
        <button id="sc-btn-script-library" class="sc-btn-subtle">All Scripts</button>

        ${S.plan && S.plan.variants && S.plan.variants.length > 1 ? `
          <select id="sc-variant-select" class="sc-compact-select" aria-label="Script version" ${S.busy ? 'disabled' : ''}>
            ${S.plan.variants.map(v => `<option value="${escapeHtml(v.id)}" ${v.id === (S.variantId || 'primary') ? 'selected' : ''}>${escapeHtml(v.label)} (${v.duration}s)</option>`).join('')}
          </select>` : ''}

        <div class="sc-compact-select-wrap">
          <select id="sc-pacing-select" class="sc-compact-select" title="Pacing Style">
            <option value="editorial" ${S.pacing === 'editorial' ? 'selected' : ''}>Editorial Pacing</option>
            <option value="dynamic" ${S.pacing === 'dynamic' ? 'selected' : ''}>Dynamic Pacing</option>
            <option value="talking_head" ${S.pacing === 'talking_head' ? 'selected' : ''}>Story Pacing</option>
          </select>
          <span class="sc-select-arrow">${svgIcon('chevron_down')}</span>
        </div>

        <!-- Visual Library Pill -->
        ${vlPillHtml}
      `}
    </div>

    <!-- Custom Script Input (when active) -->
    ${S.customMode ? `
      <div style="padding:8px 12px; background:#222222; border-bottom:1px solid var(--sc-border); display:flex; flex-direction:column; gap:6px;">
        <textarea id="sc-custom-input" class="sc-input" style="height:80px; resize:vertical; font-family:var(--sc-mono); font-size:11px;" placeholder="Paste script markdown here (CUT LIST table or dialogue beats)...">${escapeHtml(S.customContent)}</textarea>
        <div style="display:flex; justify-content:flex-end;">
          <button id="sc-btn-compile-custom" class="sc-btn-primary" ${S.busy ? 'disabled' : ''}>Analyze &amp; Map Takes</button>
        </div>
      </div>
    ` : ''}

    <!-- Storyboard Beats Container -->
    <main class="sc-storyboard">
      ${S.plan && S.plan.validation && (S.plan.validation.errors.length || S.plan.validation.warnings.length) ? `
        <div class="sc-validation" role="status">
          ${S.plan.validation.errors.map(e => `<p class="sc-validation-error"><strong>${e.beat ? `Beat ${e.beat}: ` : ''}</strong>${escapeHtml(e.message)}</p>`).join('')}
          ${S.plan.validation.warnings.map(e => `<p>${escapeHtml(e.message)}</p>`).join('')}
        </div>` : ''}
      ${storyboardHtml}
    </main>

    <!-- Dedicated Full-Width Status Strip (Zero Cutoff) -->
    <div id="sc-live-status-strip" class="sc-status-strip ${statusClass}">
      ${statusIcon}
      <span class="sc-ellipsis" style="flex:1;">${escapeHtml(S.isTranscribingVl ? `🎙️ Visual Library: ${S.vlProgressMsg || 'Indexing...'}` : (S.status ? S.status.message : (cuts.length ? `${cuts.length} cuts ready for assembly` : 'Active timeline ready to transcribe')))}</span>
    </div>

    <!-- Context-Aware Bottom Dock (48px) -->
    <footer class="sc-footer">
      <div class="sc-status-quiet" style="font-size:11px; color:var(--sc-text-secondary); white-space:nowrap;">
        ${cuts.length ? `<span class="sc-mono" style="color:var(--sc-accent); font-weight:600;">${cuts.length} Beats</span>` : (S.busy ? '<span class="sc-mono" style="color:var(--sc-accent);">Processing...</span>' : '<span style="color:var(--sc-text-muted);">Ready</span>')}
      </div>

      <div style="display:flex; align-items:center; gap:8px; flex:none; margin-left:auto;">
        ${S.mode === 'timeline_overlay' ? `
          <button id="sc-btn-transcribe-timeline" class="${cuts.length > 0 ? 'sc-btn-subtle' : 'sc-btn-primary'}" ${S.busy ? 'disabled' : ''} title="Transcribe timeline audio and match micro-visuals">
            ${S.busy ? svgIcon('spinner') : svgIcon('refresh')} ${S.busy ? 'Processing Timeline...' : (cuts.length > 0 ? 'Re-Transcribe Timeline' : 'Transcribe &amp; Match Visuals')}
          </button>
          ${(!S.busy && cuts.length > 0) ? `
            <button id="sc-btn-apply-timeline" class="sc-btn-primary" title="Place visuals on a duplicate sequence">
              ${(S.busy && S.busyTitle && S.busyTitle.includes('Premiere')) ? svgIcon('spinner') : svgIcon('check')} Place Visuals on ${S.targetVideoTrack === -1 ? 'Auto Track' : `Track V${S.targetVideoTrack + 1}`} (${(S.plan && S.plan.broll_clips) ? S.plan.broll_clips.length : S.edlOps.filter((o) => o.action === 'add').length})
            </button>
          ` : ''}
        ` : `
          <button id="sc-btn-auto-broll" class="sc-btn-subtle" ${S.busy || !cuts.length ? 'disabled' : ''} title="Auto-match B-roll overlays on Track V2">
            ${svgIcon('broll')} Auto B-Roll
          </button>
          <button id="sc-btn-assemble" class="sc-btn-primary" ${S.busy || !cuts.length || !S.edlOps.length ? 'disabled' : ''} title="Assemble rough cut into Premiere Pro">
            ${svgIcon('film')} Assemble Rough Cut
          </button>
        `}

        <button id="sc-btn-captions" class="sc-icon-btn" title="Open Captions Studio 3.0" style="width:30px; height:30px; flex:none;">
          ${svgIcon('captions')}
        </button>
      </div>
    </footer>

    <!-- Take Swapping Popover Modal -->
    ${(S.activePopoverCutIndex != null && S.popoverType === 'take') ? `
      <div class="sc-popover-backdrop" id="sc-popover-backdrop">
        <div class="sc-modal-box">
          <div class="sc-modal-header">
            <span>Swap Take for Cut #${S.activePopoverCutIndex}</span>
            <button class="sc-icon-btn" data-action="close-popover">${svgIcon('close')}</button>
          </div>
          <div class="sc-modal-body">
            <p class="sc-modal-desc" style="margin:0;">Select an alternative verified speaker take from your project footage:</p>
            <div style="display:flex; flex-direction:column; gap:4px; margin-top:4px;">
              ${S.popoverItems.map((item) => `
                <div class="sc-broll-card-row" data-action="swap-take" data-cut="${S.activePopoverCutIndex}" data-stem="${escapeHtml(item.stem)}" data-path="${escapeHtml(item.path)}" data-name="${escapeHtml(item.name)}">
                  <div style="width:28px; height:28px; display:flex; align-items:center; justify-content:center; background:#181818; border-radius:3px; flex:none;">
                    ${svgIcon('swap')}
                  </div>
                  <div style="flex:1; min-width:0;">
                    <div class="sc-broll-card-title">${escapeHtml(item.name)}</div>
                    <div class="sc-broll-card-sub">
                      <span>${item.file_type || 'Take'}</span>
                    </div>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
          <div class="sc-modal-footer">
            <button class="sc-btn-subtle" data-action="close-popover">Cancel</button>
          </div>
        </div>
      </div>
    ` : ''}

    <!-- B-Roll Matching Popover Modal -->
    ${(S.activePopoverCutIndex != null && S.popoverType === 'broll') ? `
      <div class="sc-popover-backdrop" id="sc-popover-backdrop">
        <div class="sc-modal-box" style="width:460px;">
          <div class="sc-modal-header">
            <span>Select Visual for Cut #${S.activePopoverCutIndex}</span>
            <button class="sc-icon-btn" data-action="close-popover">${svgIcon('close')}</button>
          </div>
          <div class="sc-modal-body">
            <p class="sc-modal-desc" style="margin:0;">Suggested visual B-roll clips from your indexed library (${S.popoverItems.length} matches):</p>
            <div class="sc-broll-grid" style="margin-top:4px;">
              ${S.popoverItems.map((match) => {
                const thumbUrl = match.id ? `${base}/api/visual-library/thumb/${encodeURIComponent(match.id)}` : '';
                const name = match.filename || match.name || match.stem;
                const dur = (match.recommended_duration || (match.recommended_out - match.recommended_in) || match.duration || 4).toFixed(1);
                const score = Math.round(match.quality_score || 100);
                const cat = match.category === 'pure_broll' ? 'Pure B-Roll' : (match.category === 'demonstration_broll' ? 'Demonstration' : (match.category || 'B-Roll'));

                return `
                  <div class="sc-broll-card-row" data-action="add-broll" data-cut="${S.activePopoverCutIndex}" data-stem="${escapeHtml(match.stem)}" data-path="${escapeHtml(match.path)}" data-name="${escapeHtml(name)}" data-in="${match.recommended_in || 0}" data-out="${match.recommended_out || 4}" data-id="${escapeHtml(match.id || '')}">
                    <div class="sc-broll-card-thumb">
                      ${thumbUrl ? `
                        <img src="${thumbUrl}" alt="Thumb" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
                        <div class="sc-broll-thumb-fallback" style="display:none; width:100%; height:100%; align-items:center; justify-content:center;">${svgIcon('broll')}</div>
                      ` : `
                        <div class="sc-broll-thumb-fallback" style="width:100%; height:100%; display:flex; align-items:center; justify-content:center;">${svgIcon('broll')}</div>
                      `}
                    </div>
                    <div class="sc-broll-card-info">
                      <div class="sc-broll-card-title">${escapeHtml(name)}</div>
                      <div class="sc-broll-card-sub">
                        <span class="sc-broll-card-badge">${escapeHtml(cat)}</span>
                        <span class="sc-broll-card-badge">${dur}s</span>
                        <span class="sc-broll-card-badge">Score: ${score}</span>
                      </div>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
          <div class="sc-modal-footer">
            <button class="sc-btn-subtle" data-action="close-popover">Cancel</button>
          </div>
        </div>
      </div>
    ` : ''}

    <!-- Add Raw Folder Modal -->
    ${S.showAddVlModal ? `
      <div class="sc-popover-backdrop" id="sc-popover-backdrop">
        <div class="sc-modal-box">
          <div class="sc-modal-header">
            <span>Add Raw Data Folder to Visual Library</span>
            <button class="sc-icon-btn" id="sc-btn-addvl-close">${svgIcon('close')}</button>
          </div>
          <div class="sc-modal-body">
            <p class="sc-modal-desc">
              Select or paste any folder containing raw footage. EditFlow will automatically index sharpness, exposure, and Golden Sections in the background.
            </p>
            <input id="sc-input-vl-folder" class="sc-input" type="text" placeholder="e.g. D:\\MARKETING\\Rahima Aziz Foundation\\Raw Data\\RAF Sep Videos">
          </div>
          <div class="sc-modal-footer">
            <button id="sc-btn-addvl-cancel" class="sc-btn-subtle">Cancel</button>
            <button id="sc-btn-addvl-apply" class="sc-btn-primary">Add &amp; Index</button>
          </div>
        </div>
      </div>
    ` : ''}

    <!-- Switch Project Folder Modal -->
    ${S.showFolderModal ? `
      <div class="sc-popover-backdrop" id="sc-popover-backdrop">
        <div class="sc-modal-box">
          <div class="sc-modal-header">
            <span>Select Project Folder</span>
            <button class="sc-icon-btn" id="sc-btn-modal-close">${svgIcon('close')}</button>
          </div>
          <div class="sc-modal-body">
            <p class="sc-modal-desc">
              Choose the dated project folder that owns this edit. Its scripts belong in the Scripts subfolder.
            </p>
            <input id="sc-input-folder-path" class="sc-input" type="text" value="${escapeHtml(S.projectFolder)}" placeholder="Brand / YYYY-MM-DD Project name">
          </div>
          <div class="sc-modal-footer">
            <button id="sc-btn-detect-folder" class="sc-btn-subtle" title="Detect from active Premiere project">
              ${svgIcon('film')} Detect from Premiere
            </button>
            <div style="flex:1"></div>
            <button id="sc-btn-modal-cancel" class="sc-btn-subtle">Cancel</button>
            <button id="sc-btn-modal-apply" class="sc-btn-primary">Switch &amp; Index</button>
          </div>
        </div>
      </div>
    ` : ''}
  `;

  // Attach Event Handlers
  attachEventHandlers(v);
}

// ── Event Handlers ───────────────────────────────────────────

function attachEventHandlers(v) {
  // Close Story Cut
  const btnClose = v.querySelector('#sc-btn-close');
  if (btnClose) btnClose.onclick = closeStoryCut;

  // Drawer Toggle
  const btnDrawer = v.querySelector('#sc-btn-drawer');
  if (btnDrawer) {
    btnDrawer.onclick = () => {
      S.showMoreDrawer = !S.showMoreDrawer;
      render();
    };
  }

  // Visual Library Pill in Toolbar (Opens drawer)
  const btnToolbarVl = v.querySelector('#sc-btn-toolbar-vl');
  if (btnToolbarVl) {
    btnToolbarVl.onclick = () => {
      S.showMoreDrawer = !S.showMoreDrawer;
      render();
    };
  }

  // Mode Switch
  v.querySelectorAll('[data-action="switch-mode"]').forEach((btn) => {
    btn.onclick = (e) => {
      const mode = e.currentTarget.dataset.mode;
      switchMode(mode);
    };
  });

  // Active Sequence Refresh
  const btnRefreshSeq = v.querySelector('#sc-btn-refresh-seq');
  if (btnRefreshSeq) {
    btnRefreshSeq.onclick = async () => {
      await detectActiveSequence();
      render();
    };
  }

  // Target Video Track Select
  const selTrack = v.querySelector('#sc-track-select');
  if (selTrack) {
    selTrack.onchange = (e) => {
      const trk = parseInt(e.target.value, 10);
      if (trk !== S.targetVideoTrack) {
        S.targetVideoTrack = trk;
        if (S.plan && S.plan.transcription_segments && S.plan.transcription_segments.length) {
          recomputeTimelineVisuals();
        } else {
          render();
        }
      }
    };
  }

  // Pacing Select
  const selPacing = v.querySelector('#sc-pacing-select');
  if (selPacing) {
    selPacing.onchange = (e) => {
      const p = e.target.value;
      if (p !== S.pacing) {
        S.pacing = p;
        if (S.mode === 'timeline_overlay' && S.plan && S.plan.transcription_segments && S.plan.transcription_segments.length) {
          recomputeTimelineVisuals();
        } else {
          compileScript();
        }
      }
    };
  }

  // Script Select
  const basicFolder = v.querySelector('#sc-basic-add-folder');
  if (basicFolder) basicFolder.onclick = () => saveBasicSource({ folder:v.querySelector('#sc-basic-folder').value });
  const basicScan = v.querySelector('#sc-basic-scan');
  if (basicScan) basicScan.onclick = scanVisualBins;
  const basicBin = v.querySelector('#sc-basic-add-bin');
  if (basicBin) basicBin.onclick = () => saveBasicSource({project_path:S.sourceScan.path,bin_path:v.querySelector('#sc-basic-bin').value,items:S.sourceScan.items});
  v.querySelectorAll('[data-basic-id]').forEach(button=>button.onclick=()=>saveBasicSource({source_id:button.dataset.basicId,enabled:button.dataset.basicEnabled==='true'}));
  v.querySelectorAll('[data-basic-remove]').forEach(button=>button.onclick=()=>saveBasicSource({source_id:button.dataset.basicRemove,enabled:false,removed:true}));
  const emptyProjects = v.querySelector('#sc-toggle-empty-projects');
  if (emptyProjects) emptyProjects.onclick = () => { S.showEmptyProjects = !S.showEmptyProjects; localStorage.setItem('editflow_show_empty_projects', String(S.showEmptyProjects)); render(); };
  const libraryButton = v.querySelector('#sc-btn-script-library');
  if (libraryButton) libraryButton.onclick = () => openScriptLibrary();
  const closeLibrary = v.querySelector('#sc-close-script-library');
  if (closeLibrary) closeLibrary.onclick = () => { S.showScriptLibrary = false; render(); };
  const searchLibrary = v.querySelector('#sc-search-script-library');
  if (searchLibrary) searchLibrary.onclick = () => openScriptLibrary(v.querySelector('#sc-library-query').value);
  const referenceSelect = v.querySelector('#sc-reference-select');
  if (referenceSelect) referenceSelect.onchange = e => { if (e.target.value) readScriptReference(e.target.value); };
  const selScript = v.querySelector('#sc-script-select');
  if (selScript) {
    selScript.onchange = (e) => {
      S.selectedScriptPath = e.target.value;
      S.customMode = false;
      S.mode = 'rough_cut';
      S.variantId = 'primary';
      const opt = selScript.options[selScript.selectedIndex];
      S.selectedScriptTitle = opt ? opt.text.replace(/^\[.*?\]\s*/, '') : '';
      S.sequenceName = `Rough Cut - ${S.selectedScriptTitle}`;
      S.sequenceNameEdited = false;
      rememberProject();
      compileScript();
    };
  }

  // Sequence Name Input
  const refreshScript = v.querySelector('#sc-btn-refresh-script');
  if (refreshScript) refreshScript.onclick = () => refreshSelectedScript(true);
  const alignmentSelect = v.querySelector('#sc-alignment-select');
  if (alignmentSelect) alignmentSelect.onchange = e => {
    S.selectedScriptPath = e.target.value;
    rememberProject();
    if (S.planKind === 'timeline') recomputeTimelineVisuals();
  };

  // Sequence Name Input
  const variantSelect = v.querySelector('#sc-variant-select');
  if (variantSelect) variantSelect.onchange = e => { S.variantId = e.target.value; compileScript(); };

  // Sequence Name Input
  const seqInput = v.querySelector('#sc-seq-name-input');
  if (seqInput) {
    seqInput.onchange = (e) => {
      S.sequenceName = e.target.value.trim() || `Rough Cut - ${S.selectedScriptTitle}`;
      S.sequenceNameEdited = true;
      updateEdlOpsFromPlan();
    };
  }

  // Aspect Ratio Buttons
  v.querySelectorAll('[data-aspect]').forEach((btn) => {
    btn.onclick = (e) => {
      const asp = e.currentTarget.dataset.aspect;
      if (asp && asp !== S.aspectRatio) {
        S.aspectRatio = asp;
        compileScript();
      }
    };
  });

  // Action Buttons
  const btnTranscribeTimeline = v.querySelector('#sc-btn-transcribe-timeline');
  if (btnTranscribeTimeline) btnTranscribeTimeline.onclick = analyzeTimelineVisuals;

  const btnApplyTimeline = v.querySelector('#sc-btn-apply-timeline');
  if (btnApplyTimeline) btnApplyTimeline.onclick = assembleInPremiere;

  const btnAutoBroll = v.querySelector('#sc-btn-auto-broll');
  if (btnAutoBroll) btnAutoBroll.onclick = autoPlaceBroll;

  const btnAssemble = v.querySelector('#sc-btn-assemble');
  if (btnAssemble) btnAssemble.onclick = assembleInPremiere;

  const btnCaptions = v.querySelector('#sc-btn-captions');
  if (btnCaptions) btnCaptions.onclick = handoffToCaptions;

  // Custom Script Toggle
  const btnToggle = v.querySelector('#sc-btn-toggle-custom');
  if (btnToggle) {
    btnToggle.onclick = () => {
      S.customMode = !S.customMode;
      invalidatePlan();
      rememberProject();
      render();
    };
  }

  const customInput = v.querySelector('#sc-custom-input');
  if (customInput) {
    customInput.oninput = (e) => {
      S.customContent = e.target.value;
      invalidatePlan();
      rememberProject();
    };
  }

  const btnCompileCustom = v.querySelector('#sc-btn-compile-custom');
  if (btnCompileCustom) btnCompileCustom.onclick = compileScript;

  // Visual Library Drawer Actions
  const btnOpenAddVl = v.querySelector('#sc-btn-open-add-vl');
  if (btnOpenAddVl) {
    btnOpenAddVl.onclick = () => {
      S.showAddVlModal = true;
      render();
    };
  }

  const brandSelect = v.querySelector('#sc-brand-select');
  if (brandSelect) {
    brandSelect.onchange = (e) => {
      selectBrand(e.target.value);
    };
  }
  const projectSelect = v.querySelector('#sc-project-select');
  if (projectSelect) projectSelect.onchange = e => {
    if (e.target.value) selectStoryCutProject(e.target.value);
  };

  const btnTranscribeVl = v.querySelector('#sc-btn-transcribe-vl');
  if (btnTranscribeVl) btnTranscribeVl.onclick = () => transcribeAndIndexVl();

  const btnRescanVl = v.querySelector('#sc-btn-rescan-vl');
  if (btnRescanVl) btnRescanVl.onclick = rescanVisualLibrary;

  // Project Folder Modal Actions
  for (const btn of v.querySelectorAll('#sc-btn-change-folder, #sc-btn-browse-project')) {
    btn.onclick = () => {
      S.showFolderModal = true;
      render();
    };
  }

  const btnModalClose = v.querySelector('#sc-btn-modal-close');
  const btnModalCancel = v.querySelector('#sc-btn-modal-cancel');
  const closeFolderModal = () => {
    S.showFolderModal = false;
    render();
  };
  if (btnModalClose) btnModalClose.onclick = closeFolderModal;
  if (btnModalCancel) btnModalCancel.onclick = closeFolderModal;

  const btnDetectFolder = v.querySelector('#sc-btn-detect-folder');
  if (btnDetectFolder) {
    btnDetectFolder.onclick = async () => {
      try {
        const res = await callExtendScript('getProjectDirectory', {});
        if (res && res.projectDirectory) {
          const input = v.querySelector('#sc-input-folder-path');
          if (input) input.value = res.projectDirectory;
        } else {
          alert('No saved Premiere Pro project detected.');
        }
      } catch (err) {
        alert('Could not query Premiere Pro: ' + err.message);
      }
    };
  }

  const btnModalApply = v.querySelector('#sc-btn-modal-apply');
  if (btnModalApply) {
    btnModalApply.onclick = () => {
      const input = v.querySelector('#sc-input-folder-path');
      const val = input ? input.value.trim() : '';
      if (!val) {
        alert('Please enter a valid folder path.');
        return;
      }
      S.showFolderModal = false;
      selectStoryCutProject(val);
    };
  }

  // Add Visual Library Folder Modal Actions
  const btnAddVlClose = v.querySelector('#sc-btn-addvl-close');
  const btnAddVlCancel = v.querySelector('#sc-btn-addvl-cancel');
  const closeAddVl = () => {
    S.showAddVlModal = false;
    render();
  };
  if (btnAddVlClose) btnAddVlClose.onclick = closeAddVl;
  if (btnAddVlCancel) btnAddVlCancel.onclick = closeAddVl;

  const btnAddVlApply = v.querySelector('#sc-btn-addvl-apply');
  if (btnAddVlApply) {
    btnAddVlApply.onclick = () => {
      const input = v.querySelector('#sc-input-vl-folder');
      const val = input ? input.value.trim() : '';
      if (!val) {
        alert('Please enter a folder path.');
        return;
      }
      S.showAddVlModal = false;
      addVisualFolder(val);
    };
  }

  // Popover Backdrop Close
  const backdrop = v.querySelector('#sc-popover-backdrop');
  if (backdrop) {
    backdrop.onclick = (e) => {
      if (e.target === backdrop) {
        closePopover();
        S.showAddVlModal = false;
        S.showFolderModal = false;
        render();
      }
    };
  }

  // Delegated Click Handlers
  v.onclick = (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;
    const cutIdx = parseInt(target.dataset.cut, 10);

    if (action === 'toggle-audio') {
      toggleAudioPreview(cutIdx);
    } else if (action === 'toggle-trim') {
      S.activeTrimCutIndex = S.activeTrimCutIndex === cutIdx ? null : cutIdx;
      render();
    } else if (action === 'close-trim') {
      S.activeTrimCutIndex = null;
      render();
    } else if (action === 'nudge') {
      const field = target.dataset.field;
      const delta = parseFloat(target.dataset.delta);
      nudgeCut(cutIdx, field, delta);
    } else if (action === 'open-take-swap') {
      openTakeSwap(cutIdx);
    } else if (action === 'swap-take') {
      const stem = target.dataset.stem;
      const path = target.dataset.path;
      const name = target.dataset.name;
      selectTakeSwap(cutIdx, { stem, path, name });
    } else if (action === 'open-broll-swap') {
      openBrollSwap(cutIdx);
    } else if (action === 'add-broll') {
      const stem = target.dataset.stem;
      const path = target.dataset.path;
      const name = target.dataset.name;
      const inSec = parseFloat(target.dataset.in || '0');
      const outSec = parseFloat(target.dataset.out || '4');
      const id = target.dataset.id || '';
      selectBrollInsert(cutIdx, {
        stem,
        path,
        filename: name,
        name,
        recommended_in: inSec,
        recommended_out: outSec,
        category: 'B-Roll',
        id,
      });
    } else if (action === 'remove-micro-broll') {
      const brollIdx = parseInt(target.dataset.brollIdx, 10);
      removeMicroBroll(cutIdx, brollIdx);
    } else if (action === 'close-popover') {
      closePopover();
      render();
    } else if (action === 'remove-vl-folder') {
      const folderPath = target.dataset.path;
      if (folderPath && confirm(`Unlink folder "${folderPath}" from Visual Library?`)) {
        removeVisualFolder(folderPath);
      }
    }
  };
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtSec(sec) {
  if (sec == null || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 10);
  return `${m}:${s < 10 ? '0' : ''}${s}.${ms}`;
}

window.addEventListener('editflow:folder-added', () => { loadVisualFolders(); });
