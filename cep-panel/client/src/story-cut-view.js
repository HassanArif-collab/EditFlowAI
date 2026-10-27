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
 * - Context-aware footer dock with single-undo Premiere Pro assembly
 */
import { apiGet, apiPost, getBaseUrl } from './api.js';
import { callExtendScript, reloadExtensionRoot } from './extendscript.js';

const S = {
  mode: 'timeline_overlay', // 'timeline_overlay' (default for overlays) or 'rough_cut'
  activeSequence: null, // { name, duration, id }
  targetVideoTrack: 1, // 1 = Track V2 (0-based), -1 = Auto-detect empty track
  scripts: [],
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
  assetsCount: 0,
  showFolderModal: false,
  visualFolders: [],
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

  S.prevView = {
    hero: hero ? !hero.classList.contains('hidden') : false,
    chat: chat ? !chat.classList.contains('hidden') : false,
    footer: footer ? !footer.classList.contains('hidden') : false,
  };

  [hero, chat, footer, captions].forEach((el) => el && el.classList.add('hidden'));
  view.classList.remove('hidden');

  if (!S.audioElement) {
    S.audioElement = new Audio();
    S.audioElement.addEventListener('timeupdate', onAudioTimeUpdate);
    S.audioElement.addEventListener('ended', onAudioEnded);
  }

  detectActiveSequence();
  loadVisualFolders();
  if (!S.scripts.length) {
    loadScripts();
  } else {
    render();
  }
}

export function closeStoryCut() {
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
  if (!S.projectFolder) {
    try {
      const res = await callExtendScript('getProjectDirectory', {});
      if (res && res.projectDirectory) {
        S.projectFolder = res.projectDirectory;
        localStorage.setItem('editflow_project_folder', S.projectFolder);
      }
    } catch (e) {}
  }
  if (!S.projectFolder) {
    S.projectFolder = 'D:\\MARKETING\\Rahima Aziz Foundation\\AI Automation';
    localStorage.setItem('editflow_project_folder', S.projectFolder);
  }
  S.projectName = getProjectDisplayName(S.projectFolder);
}

async function loadScripts(forceIndex = false) {
  setBusy(true, 'Indexing project assets & loading scripts...');
  try {
    await initProjectFolder();
    try {
      const idxRes = await apiPost('/api/media-resolver/index', {
        root_dir: S.projectFolder,
        force: forceIndex,
      });
      if (idxRes) {
        S.assetsCount = idxRes.total_items || 0;
        if (idxRes.root_dir) {
          S.projectFolder = idxRes.root_dir;
          S.projectName = getProjectDisplayName(S.projectFolder);
          localStorage.setItem('editflow_project_folder', S.projectFolder);
        }
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
    if (res && res.scripts) {
      S.scripts = res.scripts;
      if (res.folder) {
        S.projectFolder = res.folder;
        S.projectName = getProjectDisplayName(S.projectFolder);
      }
      const defaultScript = S.scripts.find((s) => s.name.includes('Script 01')) || S.scripts[0];
      if (defaultScript) {
        S.selectedScriptPath = defaultScript.full_path;
        S.selectedScriptTitle = defaultScript.name.replace(/\.md$/i, '');
        S.sequenceName = `Rough Cut - ${S.selectedScriptTitle}`;
      } else {
        S.selectedScriptPath = '';
        S.selectedScriptTitle = '';
        S.sequenceName = 'Rough Cut';
      }
    }
  } catch (e) {
    console.error('[StoryCut] Failed to load scripts:', e);
    setStatus('error', 'Could not load script library: ' + e.message);
  } finally {
    setBusy(false);
    render();
    if (S.mode === 'rough_cut' && S.selectedScriptPath) {
      compileScript();
    }
  }
}

async function compileScript() {
  if (!S.selectedScriptPath && !S.customContent) return;

  stopAudioPreview();
  setBusy(true, 'Compiling cuts & resolving takes...');
  try {
    const payload = S.customMode
      ? {
          script_content: S.customContent,
          title: S.sequenceName || 'Custom Cut',
          aspect_ratio: S.aspectRatio,
          fps: S.fps,
          auto_broll: true,
          pacing_style: S.pacing || 'editorial',
        }
      : {
          script_path: S.selectedScriptPath,
          title: S.selectedScriptTitle,
          aspect_ratio: S.aspectRatio,
          fps: S.fps,
          auto_broll: true,
          pacing_style: S.pacing || 'editorial',
        };

    const res = await apiPost('/api/script-assembly/compile', payload);
    if (res && res.success && res.plan) {
      S.plan = res.plan;
      S.edlOps = res.edl_ops || [];
      if (!S.sequenceName) {
        S.sequenceName = `Rough Cut - ${S.plan.title}`;
      }
      setStatus('info', `Compiled ${S.plan.cuts.length} cuts (${S.plan.target_duration}s) ready to assemble.`);
    } else {
      setStatus('error', (res && res.detail) || 'Failed to compile script.');
    }
  } catch (e) {
    console.error('[StoryCut] Compilation error:', e);
    setStatus('error', 'Compile error: ' + e.message);
  } finally {
    setBusy(false);
    render();
  }
}

// ── Timeline Visual Overlay Functions ─────────────────────────

async function detectActiveSequence() {
  try {
    const res = await callExtendScript('callModule', { module: 'captionsManager', fn: 'sequenceInfo' });
    if (res && res.name) {
      S.activeSequence = {
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

async function switchMode(newMode) {
  if (S.mode === newMode) return;
  S.mode = newMode;
  stopAudioPreview();
  if (newMode === 'timeline_overlay') {
    await detectActiveSequence();
    if (S.activeSequence && S.activeSequence.name) {
      setStatus('info', `Switched to Timeline Overlay: "${S.activeSequence.name}" active.`);
    }
  } else {
    setStatus('info', 'Switched to Rough Cut mode.');
    if (!S.plan && S.selectedScriptPath) {
      compileScript();
    }
  }
  render();
}

async function analyzeTimelineVisuals() {
  stopAudioPreview();
  setBusy(true, 'Extracting sequence audio cuts from Premiere Pro...', 1, 'Audio Clip Extraction');
  let stageTimer = null;
  try {
    const clipsRes = await callExtendScript('callModule', {
      module: 'captionsManager',
      fn: 'sequenceAudioClips',
      useInOut: false,
    });
    if (!clipsRes || !clipsRes.clips || !clipsRes.clips.length) {
      setStatus('error', 'No unmuted audio clips found in the active Premiere Pro sequence.');
      return;
    }

    setBusy(true, `Transcribing timeline audio (${clipsRes.clips.length} clips) with Whisper AI...`, 2, 'Speech-to-Text Transcription');

    stageTimer = setTimeout(() => {
      if (S.busy && S.busyStage === 2) {
        const bCount = (S.visualFolders || []).reduce((acc, f) => acc + (f.broll_count || 0), 0);
        setBusy(true, `Matching micro-visuals from Visual Library (${bCount || 204} B-Rolls)...`, 3, 'Matching Micro-Visuals');
      }
    }, 9000);

    const payload = {
      clips: clipsRes.clips,
      sequence_name: (S.activeSequence && S.activeSequence.name) || clipsRes.name || 'Active Sequence',
      duration: (S.activeSequence && S.activeSequence.duration) || 60.0,
      script_path: S.selectedScriptPath || undefined,
      script_content: S.customMode ? S.customContent : undefined,
      aspect_ratio: S.aspectRatio,
      pacing_style: S.pacing || 'editorial',
      target_track: S.targetVideoTrack !== undefined ? S.targetVideoTrack : 1,
    };

    const res = await apiPost('/api/timeline-visuals/analyze', payload, { timeoutMs: 180000 });
    if (res && res.success) {
      S.plan = {
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
    console.error('[StoryCut] Timeline visuals error:', e);
    setStatus('error', 'Timeline visuals error: ' + e.message);
  } finally {
    if (stageTimer) clearTimeout(stageTimer);
    setBusy(false);
  }
}

async function recomputeTimelineVisuals() {
  if (S.mode !== 'timeline_overlay' || !S.plan || !S.plan.transcription_segments || !S.plan.transcription_segments.length) {
    compileScript();
    return;
  }
  setBusy(true, `Recomputing ${S.pacing} visual placements...`);
  try {
    const res = await apiPost('/api/timeline-visuals/recompute', {
      segments: S.plan.transcription_segments,
      sequence_name: S.plan.title,
      duration: S.plan.target_duration,
      aspect_ratio: S.aspectRatio,
      pacing_style: S.pacing || 'editorial',
      target_track: S.targetVideoTrack !== undefined ? S.targetVideoTrack : 1,
    }, { timeoutMs: 60000 });
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
    console.warn('[StoryCut] Recompute error:', e);
  } finally {
    setBusy(false);
    render();
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

async function loadVisualFolders() {
  try {
    const res = await apiGet('/api/visual-library/folders');
    if (res && res.success) {
      S.visualFolders = res.folders || [];
      render();
    }
  } catch (e) {
    console.warn('[StoryCut] Error loading visual folders:', e);
  }
}

async function addVisualFolder(folderPath) {
  if (!folderPath) return;
  setBusy(true, 'Adding raw data folder to Visual Library...');
  try {
    const res = await apiPost('/api/visual-library/folders', { folder_path: folderPath, auto_analyze: true });
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
    const res = await apiPost('/api/visual-library/analyze');
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
  if (!S.plan || !S.plan.cuts || !S.plan.cuts.length) {
    setStatus('error', 'Compile a script first before placing B-roll.');
    return;
  }
  setBusy(true, 'Matching optimal B-roll from Visual Library across cuts...');
  try {
    const res = await apiPost('/api/script-assembly/compile', {
      script_path: S.selectedScriptPath,
      script_content: S.customMode ? S.customContent : undefined,
      title: S.sequenceName,
      aspect_ratio: S.aspectRatio,
      fps: S.fps,
      auto_broll: true,
      pacing_style: S.pacing || 'editorial',
    });
    if (res && res.success && res.plan) {
      S.plan = res.plan;
      S.edlOps = res.edl_ops || [];
      const count = S.plan.broll_clips ? S.plan.broll_clips.length : 0;
      setStatus('success', `Auto-placed ${count} visual overlays on Track V2.`);
    } else {
      setStatus('error', (res && res.detail) || 'Failed to auto-place B-roll.');
    }
  } catch (e) {
    console.error('[StoryCut] Auto-place B-roll error:', e);
    setStatus('error', 'Auto-place B-roll error: ' + e.message);
  } finally {
    setBusy(false);
    render();
  }
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
    const res = await apiGet(`/api/visual-library/match-cut?cue=${encodeURIComponent(cue)}&aspect_ratio=${encodeURIComponent(S.aspectRatio)}&limit=12`);
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

  // Timeline Overlay Mode: Only generate B-roll overlay operations (never touch dialogue sequence)
  if (S.mode === 'timeline_overlay') {
    const trkDisplay = S.targetVideoTrack === -1 ? 'Auto Track' : `Track V${S.targetVideoTrack + 1}`;
    const ops = [];
    ops.push({ action: 'beginUndoGroup', name: `EditFlow: Place Visuals on ${trkDisplay}` });
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
          audio_track_index: 'auto', // Routes to clean empty audio track (A3..A8), preserving dialogue
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
        audio_track_index: 'auto',
        auto_detect_track: S.targetVideoTrack === -1,
      });
    }
  }

  ops.push({ action: 'endUndoGroup' });
  S.edlOps = ops;
}

// ── Assembly Dispatch ────────────────────────────────────────

async function assembleInPremiere() {
  if (S.mode === 'timeline_overlay' && (!S.edlOps || !S.edlOps.length)) {
    // If user hasn't transcribed yet, seamlessly run analyzeTimelineVisuals first!
    setStatus('info', 'Analyzing active sequence and matching visuals...');
    await analyzeTimelineVisuals();
    if (!S.edlOps || !S.edlOps.length) {
      return;
    }
  } else if (!S.edlOps || !S.edlOps.length) {
    setStatus('error', 'No timeline operations to assemble. Compile or transcribe first.');
    return;
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

    setStatus('info', `Executing ${S.edlOps.length} timeline operations with single-undo...`);

    const res = await callExtendScript('processEDL', { ops: S.edlOps, sequence_name: seqName });

    if (res && res.success && (!res.failedCount || res.failedCount === 0)) {
      const count = (S.plan && S.plan.broll_clips) ? S.plan.broll_clips.length : 0;
      const trkDisplay = S.targetVideoTrack === -1 ? 'empty video track' : `Track V${S.targetVideoTrack + 1}`;
      const msg = S.mode === 'timeline_overlay'
        ? `Placed ${count} visual overlays on ${trkDisplay}! (Ctrl+Z in Premiere to undo).`
        : `Assembled "${seqName}" with ${S.plan.cuts.length} cuts! (Ctrl+Z in Premiere to undo).`;
      setStatus('success', msg);
    } else {
      const err = (res && (res.error || (res.failedCount ? `${res.failedCount} timeline operations failed.` : null))) ||
        'ExtendScript assembly returned an error.';
      setStatus('error', err);
    }
  } catch (e) {
    console.error('[StoryCut] Assembly failed:', e);
    setStatus('error', 'Assembly error: ' + e.message);
  } finally {
    setBusy(false);
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
          <span class="sc-drawer-lbl">Visual Library:</span>
          <div class="sc-drawer-content" style="flex-wrap:wrap; gap:6px;">
            ${(S.visualFolders && S.visualFolders.length > 0) ? S.visualFolders.map((f) => `
              <div class="sc-drawer-chip" title="${escapeHtml(f.path)}">
                <span class="chip-name">${escapeHtml(f.name)}</span>
                <span class="chip-count">${f.broll_count || f.total_assets || 0}</span>
                <button class="chip-del" data-action="remove-vl-folder" data-path="${escapeHtml(f.path)}" title="Unlink folder">&times;</button>
              </div>
            `).join('') : '<span style="color:var(--sc-text-muted); font-size:11px;">No raw footage folders linked</span>'}
            <button id="sc-btn-open-add-vl" class="sc-btn-subtle" title="Add raw footage folder">
              ${svgIcon('plus')} Add Folder
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
          <select id="sc-script-select" class="sc-compact-select" style="width:100%;" ${S.busy ? 'disabled' : ''}>
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
      ${storyboardHtml}
    </main>

    <!-- Dedicated Full-Width Status Strip (Zero Cutoff) -->
    <div id="sc-live-status-strip" class="sc-status-strip ${statusClass}">
      ${statusIcon}
      <span class="sc-ellipsis" style="flex:1;">${escapeHtml(S.status ? S.status.message : (cuts.length ? `${cuts.length} cuts ready for assembly` : 'Active timeline ready to transcribe'))}</span>
    </div>

    <!-- Context-Aware Bottom Dock (48px) -->
    <footer class="sc-footer">
      <div class="sc-status-quiet" style="font-size:11px; color:var(--sc-text-secondary); white-space:nowrap;">
        ${cuts.length ? `<span class="sc-mono" style="color:var(--sc-accent); font-weight:600;">${cuts.length} Beats</span>` : (S.busy ? '<span class="sc-mono" style="color:var(--sc-accent);">Processing...</span>' : '<span style="color:var(--sc-text-muted);">Ready</span>')}
      </div>

      <div style="display:flex; align-items:center; gap:8px; flex:none; margin-left:auto;">
        ${S.mode === 'timeline_overlay' ? `
          <button id="sc-btn-transcribe-timeline" class="${cuts.length > 0 ? 'sc-btn-subtle' : 'sc-btn-primary'}" ${S.busy ? 'disabled' : ''} title="Transcribe timeline audio and match micro-visuals">
            ${S.busy ? svgIcon('spinner') : svgIcon('refresh')} ${S.busy ? 'Transcribing...' : (cuts.length > 0 ? 'Re-Transcribe' : 'Transcribe &amp; Match Visuals')}
          </button>
          <button id="sc-btn-apply-timeline" class="${cuts.length > 0 ? 'sc-btn-primary' : 'sc-btn-subtle'}" ${S.busy || !cuts.length ? 'disabled' : ''} title="Place visuals on target video track with single Ctrl+Z undo">
            ${(S.busy && S.busyTitle && S.busyTitle.includes('Premiere')) ? svgIcon('spinner') : svgIcon('check')} ${(S.busy && S.busyTitle && S.busyTitle.includes('Premiere')) ? 'Placing Visuals...' : `Place Visuals on ${S.targetVideoTrack === -1 ? 'Auto Track' : `Track V${S.targetVideoTrack + 1}`}${cuts.length ? ` (${(S.plan && S.plan.broll_clips) ? S.plan.broll_clips.length : S.edlOps.filter((o) => o.action === 'add').length})` : ''}`}
          </button>
        ` : `
          <button id="sc-btn-auto-broll" class="sc-btn-subtle" ${S.busy || !cuts.length ? 'disabled' : ''} title="Auto-match B-roll overlays on Track V2">
            ${svgIcon('broll')} Auto B-Roll
          </button>
          <button id="sc-btn-assemble" class="sc-btn-primary" ${S.busy || !cuts.length ? 'disabled' : ''} title="Assemble rough cut into Premiere Pro">
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
              Point Story Cut to any directory containing your scripts, raw footage, or AI automation.
            </p>
            <input id="sc-input-folder-path" class="sc-input" type="text" value="${escapeHtml(S.projectFolder)}" placeholder="e.g. D:\\MARKETING\\Rahima Aziz Foundation\\AI Automation">
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
  const selScript = v.querySelector('#sc-script-select');
  if (selScript) {
    selScript.onchange = (e) => {
      S.selectedScriptPath = e.target.value;
      const opt = selScript.options[selScript.selectedIndex];
      S.selectedScriptTitle = opt ? opt.text.replace(/^\[.*?\]\s*/, '') : '';
      S.sequenceName = `Rough Cut - ${S.selectedScriptTitle}`;
      if (S.mode === 'timeline_overlay' && S.plan && S.plan.transcription_segments && S.plan.transcription_segments.length) {
        recomputeTimelineVisuals();
      } else {
        compileScript();
      }
    };
  }

  // Sequence Name Input
  const seqInput = v.querySelector('#sc-seq-name-input');
  if (seqInput) {
    seqInput.onchange = (e) => {
      S.sequenceName = e.target.value.trim() || `Rough Cut - ${S.selectedScriptTitle}`;
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
      render();
    };
  }

  const customInput = v.querySelector('#sc-custom-input');
  if (customInput) {
    customInput.oninput = (e) => {
      S.customContent = e.target.value;
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

  const btnRescanVl = v.querySelector('#sc-btn-rescan-vl');
  if (btnRescanVl) btnRescanVl.onclick = rescanVisualLibrary;

  // Project Folder Modal Actions
  const btnChangeFolder = v.querySelector('#sc-btn-change-folder');
  if (btnChangeFolder) {
    btnChangeFolder.onclick = () => {
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
      S.projectFolder = val;
      S.projectName = getProjectDisplayName(val);
      localStorage.setItem('editflow_project_folder', val);
      S.showFolderModal = false;
      loadScripts(true);
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
