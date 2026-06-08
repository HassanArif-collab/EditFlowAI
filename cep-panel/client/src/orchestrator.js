/**
 * orchestrator.js — Agent-side decision tree for EditFlow single-chat UX.
 *
 * Listens to state transitions and emits chat messages + side effects.
 * Owns the LLM prompts and coordinates the pipeline stages.
 */
import { getState, setState, setSession, transition, transitionError, transitionBack, subscribe, resetState } from './state.js';
import { apiGet, apiPost } from './api.js';
import { callExtendScript, scanProjectMedia, isExtendScriptAvailable } from './extendscript.js';
import { appendMessage, updateProgress, clearChat, scrollToBottom } from './chat-ui.js';
import { uploadScript } from './upload.js';
// openReview is exposed on window by main.js (loaded with the cache-buster) so we
// don't pull a second, un-busted copy of review-view.js here.

const $ = (sel) => document.querySelector(sel);

// ── LLM Prompts ──────────────────────────────────────────────
const PROMPT_BIN_TOUR = `You are EditFlow, an AI editing assistant. The user just scanned their Premiere project. You see a list of bins and their contents. Write a 1-2 sentence summary of what you see, then ask which bin has their raw footage. Be concise and friendly.`;

const PROMPT_FIND_SCRIPT = `You are EditFlow, an AI editing assistant. The user uploaded a document that may contain a script mixed with other content (research notes, instructions, etc). Find the portion that looks like a spoken script (direct address to an audience, conversational tone). Return a JSON object with: { "candidate_script": "the extracted script text", "confidence": 0.0-1.0, "reasoning": "brief explanation" }. If no clear script is found, set confidence to 0 and explain.`;

// ── Progress tracking ────────────────────────────────────────
let _progressMsgId = null;
// Holds {clipsTotal, clipsDone, currentName} while pre-warm runs so the WS
// `progress` handler can render sub-clip Whisper progress on the same message.
let _prewarmCtx = null;

/**
 * Reject any "agent reply" that smells like the rule-based developer-docs
 * fallback (`POST /api/pipeline/analyze...`). Belt-and-suspenders so the
 * user never sees internal docs in the chat.
 */
function _looksLikeDocsDump(text) {
  if (!text || typeof text !== 'string') return false;
  return /POST\s+\/api\/|GET\s+\/api\/|use\s+the\s+\/api\//i.test(text);
}

// ── Public API ───────────────────────────────────────────────

/**
 * Handle Scan button click → Stage 0 → Stage 1.
 */
async function onScanClicked() {
  const hero = $('#hero');
  const chatScroll = $('#chat-scroll');
  const footer = $('#app-footer');

  // Hide hero, show chat
  if (hero) hero.classList.add('hidden');
  if (chatScroll) chatScroll.classList.remove('hidden');
  if (footer) footer.classList.remove('hidden');

  appendMessage('agent-text', { text: 'Scanning your Premiere project...' });

  try {
    // Check backend is reachable first
    await apiGet('/api/ping', { timeoutMs: 3000 });
  } catch (_) {
    appendMessage('error', {
      text: 'Backend not reachable. Check that run.py is running.',
      retryFn: onScanClicked,
    });
    return;
  }

  try {
    let scanResult;

    if (isExtendScriptAvailable()) {
      // Call ExtendScript to scan the project
      scanResult = await scanProjectMedia();
    } else {
      // Try the REST endpoint (for development/testing outside Premiere)
      try {
        const resp = await apiGet('/api/premiere/context', { timeoutMs: 5000 });
        scanResult = resp;
      } catch (_) {
        // No project context yet — show a helpful message
        appendMessage('agent-text', {
          text: 'I couldn\'t reach Premiere\'s project data. Make sure the panel is running inside Premiere Pro, or use the backend API to register assets directly.',
        });
        return;
      }
    }

    // POST scan result to backend
    try {
      // The backend's /api/premiere/context expects {items, bins, sequences}.
      // scanProjectMedia returns the same keys at top level — pass through.
      const ctx = {
        items: scanResult.items || [],
        bins: scanResult.bins || [],
        sequences: scanResult.sequences || [],
      };
      await apiPost('/api/premiere/context', ctx, { timeoutMs: 10000 });
    } catch (err) {
      console.warn('[orchestrator] Failed to POST context:', err);
    }

    setSession({ scan: scanResult });
    onScanComplete(scanResult);
  } catch (err) {
    appendMessage('error', {
      text: `Scan failed: ${err.message}`,
      retryFn: onScanClicked,
    });
  }
}

/**
 * Process scan result → build bin summary card → transition to scanned.
 */
function onScanComplete(scanResult) {
  const bins = _extractBins(scanResult);
  const items = scanResult.items || scanResult.clips || [];

  // Build bin summary with descriptions
  const summaryBins = bins.map(bin => {
    const binItems = items.filter(item =>
      (item.binPath || item.bin_path || '') === (bin.path || bin.binPath || '')
    );
    const audioItems = binItems.filter(_itemHasUsableAudio);
    const audioDuration = audioItems.reduce((sum, item) => sum + (item.duration || 0), 0);
    const hasAudio = audioItems.length > 0;

    return {
      name: bin.name,
      binPath: bin.path || bin.binPath || '',
      itemCount: binItems.length || bin.item_count || bin.itemCount || 0,
      hasAudio,
      desc: hasAudio
        ? `${binItems.length} clips, ~${_fmtDur(audioDuration)} audio`
        : `${binItems.length} clips, no audio`,
    };
  });

  // Try LLM-narrated description (bonus, not load-bearing)
  _narrateBinTour(summaryBins, items).then(intro => {
    transition('scan_clicked');
    appendMessage('bin-summary-card', {
      intro: intro || `I scanned your project. I see ${bins.length} bin${bins.length !== 1 ? 's' : ''}. Which bin has your raw footage?`,
      bins: summaryBins,
      onBinClick: (binName, binPath) => {
        onSourceProvided({ type: 'bin', name: binName, path: binPath });
      },
    });
  }).catch(() => {
    // Fallback: deterministic template
    transition('scan_clicked');
    appendMessage('bin-summary-card', {
      intro: `I scanned your project. I see ${bins.length} bin${bins.length !== 1 ? 's' : ''}. Which bin has your raw footage? Type @, drop a bin, or click one below:`,
      bins: summaryBins,
      onBinClick: (binName, binPath) => {
        onSourceProvided({ type: 'bin', name: binName, path: binPath });
      },
    });
  });
}

/**
 * User provided a source (bin, clip, or file) → Stage 1 → Stage 2.
 */
async function onSourceProvided(source) {
  const state = getState();
  const sourceRef = _sourceToReference(source);

  // Show user message
  if (source.type === 'bin') {
    appendMessage('user-text', { text: sourceRef });
  } else if (source.type === 'clip') {
    appendMessage('user-text', { text: sourceRef });
  } else {
    appendMessage('user-text', { text: source.name || source.path || 'Dropped file(s)' });
  }

  // Add to sources list
  const sources = _addSource(state.session.sources || [], source);
  setSession({ sources });

  if (state.current === 'idle') {
    // Need to scan first — shouldn't happen normally but handle it
    appendMessage('agent-text', { text: 'Please scan the project first.' });
    return;
  }

  if (state.current === 'scanned' || state.current === 'source_picked') {
    await _startTranscription(source);
  } else if (state.current === 'transcribing') {
    // Already transcribing — add more jobs
    await _addTranscriptionJobs(source);
  } else if (state.current === 'script_needed') {
    // Already past transcription — just add source info
    appendMessage('agent-text', { text: `Noted: ${sourceRef}. I'll include this in the edit.` });
  }
}

/**
 * Handle Premiere project items from drag-and-drop or selection chip.
 */
async function onPProItemsProvided(items) {
  const state = getState();

  // Group items by type (bins vs clips)
  const binNames = [];
  const clipNames = [];

  for (const item of items) {
    if (item.isBin || item.is_bin) {
      binNames.push(item.name);
    } else {
      clipNames.push(item.name);
    }
  }

  // Show user message
  const parts = [];
  if (binNames.length > 0) parts.push(`@bin:${binNames.join(', @bin:')}`);
  if (clipNames.length > 0) parts.push(clipNames.length === 1 ? `@clip:${clipNames[0]}` : `${clipNames.length} clips`);
  appendMessage('user-text', { text: parts.join(' + ') });

  // Process each item
  let sources = state.session.sources || [];
  for (const item of items) {
    const source = {
      type: item.isBin || item.is_bin ? 'bin' : 'clip',
      name: item.name,
      path: item.binPath || item.bin_path || '',
      mediaPath: item.mediaPath || item.media_path || '',
      hasAudio: item.hasAudio ?? item.has_audio,
      duration: item.duration || 0,
    };
    sources = _addSource(sources, source);
    setSession({ sources });

    if (state.current === 'scanned' || state.current === 'source_picked') {
      await _startTranscription(source);
    }
  }
}

/**
 * Handle a media file dropped from OS.
 */
async function onMediaFileDropped(file) {
  const filePath = file.path || file.name;
  const source = { type: 'file', name: file.name, path: filePath };
  const state = getState();

  appendMessage('user-text', { text: file.name });

  // The MVP backend works against clips already in the Premiere project,
  // not separately-registered files. Tell the user to drag the file into a
  // Premiere bin first, then drop that bin onto this panel.
  appendMessage('agent-text', {
    text: `I can't add raw files yet. Drag "${file.name}" into a bin inside Premiere first, then drop that bin onto this panel.`,
  });
}

/**
 * Handle a script file dropped from OS.
 */
async function onScriptFileDropped(file) {
  const state = getState();

  appendMessage('user-text', { text: `${file.name} — attached` });

  const hasSource = (state.session.sources || []).some(source => source.type === 'bin' || source.type === 'clip');
  if (state.current === 'script_needed' || hasSource) {
    if (state.current === 'error') {
      setState({ current: 'script_needed' });
    }
    await _processScriptFile(file);
  } else {
    // Hold the script for later
    appendMessage('agent-text', { text: "I'll hold this script for after you pick a source." });
    setSession({ pendingScriptFile: file });
  }
}

/**
 * Handle user text message from the input.
 */
async function onUserMessage(text) {
  const state = getState();
  text = text.trim();
  if (!text) return;

  // External-LLM paste workflow.  These commands are recognised in ANY state
  // (including script_needed, where the legacy path would otherwise swallow
  // them as a script).  Four forms:
  //   /transcribe              → step 1: prompt to transcribe the video in Gemini
  //   /llm-prompt              → build a Whisper-bundled paste-into-Claude file
  //   /cutplan                 → step 2: build the Gemini-flow cut-planning prompt
  //   /paste-plan <json>       → ingest the model's JSON reply, queue Build seq
  // The slash-command prefix is unambiguous; the orchestrator never matches
  // a real script against it because Urdu/English scripts don't start with
  // "/".  We also accept "/llm prompt" with a space for forgiving typing.
  if (/^\/review\b/i.test(text)) {
    // Open the transcript-first cut editor (additive; leaves chat state intact).
    appendMessage('user-text', { text: '/review' });
    if (typeof window !== 'undefined' && typeof window.__editflowOpenReview === 'function') {
      window.__editflowOpenReview();
    } else {
      appendMessage('agent-text', { text: 'Review editor is still loading — try again in a moment.' });
    }
    return;
  }
  if (/^\/(transcribe|transcript|gemini[-_ ]?transcribe)\b/i.test(text)) {
    // Gemini flow step 1: show the prompt the user pastes into Gemini (with the
    // video attached) to get a segment-level transcript JSON to feed /cutplan.
    appendMessage('user-text', { text });
    await _handleTranscriptionPromptCommand();
    return;
  }
  if (/^\/(llm[-_ ]?prompt|prompt|llm)\b/i.test(text)) {
    appendMessage('user-text', { text });
    await _handleLlmPromptCommand();
    return;
  }
  if (/^\/cut[-_ ]?plan\b/i.test(text)) {
    // Gemini flow: build the prompt the user pastes into the cut-planning model
    // (no Whisper transcript bundled; they paste the Gemini transcript instead).
    appendMessage('user-text', { text });
    await _handleCutplanPromptCommand();
    return;
  }
  if (/^\/(paste[-_ ]?plan|plan|apply[-_ ]?plan)\b/i.test(text)) {
    // Everything after the command word is the JSON body.
    const body = text.replace(/^\/\S+\s*/, '');
    appendMessage('user-text', { text: '/paste-plan (json hidden)' });
    await _handlePastePlanCommand(body);
    return;
  }

  const sourceRefs = _extractSourceReferences(text);
  const canPickSource =
    state.current === 'scanned' ||
    state.current === 'source_picked' ||
    (state.current === 'script_needed' && _looksLikeSourceCommand(text));

  if (sourceRefs.length > 0 && canPickSource) {
    for (const source of sourceRefs) {
      await onSourceProvided(source);
    }
    return;
  }

  // Stage: script_needed — treat as script paste
  if (state.current === 'script_needed') {
    appendMessage('user-text', { text });
    await _ingestScript(text);
    return;
  }

  // Stage: script_understood — treat as manual script
  if (state.current === 'script_understood') {
    appendMessage('user-text', { text });
    await _ingestScript(text);
    return;
  }

  // Default: show as user message, let agent respond
  appendMessage('user-text', { text });

  // Try LLM chat as fallback
  try {
    const resp = await apiPost('/api/chat/message', {
      message: `You are EditFlow, an AI editing assistant. Help the user with their video editing project. Be concise.\n\nUser: ${text}`,
      session_id: state.session.clientId || 'panel-chat',
    });
    const replyRaw = resp.choices?.[0]?.message?.content || resp.response || resp.message || '';
    const reply = (replyRaw && typeof replyRaw === 'object') ? replyRaw.content : replyRaw;
    if (reply && !_looksLikeDocsDump(reply)) {
      appendMessage('agent-text', { text: reply });
    } else {
      appendMessage('agent-text', { text: "I'm not sure how to help with that yet. Try scanning your project first." });
    }
  } catch (_) {
    appendMessage('agent-text', { text: "I'm not sure how to help with that yet. Try scanning your project first." });
  }
}

/**
 * Handle plan approval → execute and build sequence.
 */
async function onApprovePlan() {
  const state = getState();
  const planId = state.session.planId;
  if (!planId) return;

  transition('approve_clicked');
  _progressMsgId = appendMessage('progress', {
    label: 'Creating sequence in Premiere...',
    pct: 0,
    detail: 'Executing plan...',
  });

  try {
    // Apply the plan: backend builds ExtendScript ops, we dispatch via processEDL.
    const applyResult = await apiPost(`/api/edit/plan/${planId}/apply`, {}, { timeoutMs: 60000 });
    const extendscriptOps = applyResult.extendscript_ops || [];
    const targetSeqName = applyResult.target_sequence_name || `EditFlow Cut`;
    setSession({ edl: applyResult, targetSequenceName: targetSeqName });

    if (isExtendScriptAvailable()) {
      updateProgress(_progressMsgId, { pct: 50, detail: 'Placing clips in Premiere...' });
      await callExtendScript('processEDL', JSON.stringify({ ops: extendscriptOps }));
      updateProgress(_progressMsgId, { pct: 100, detail: 'Done.' });

      transition('extendscript_done');
      appendMessage('success', {
        text: `Done. "${targetSeqName}" is in your Premiere project. Switch to Premiere to play it back.`,
        newEditFn: onNewEdit,
      });
    } else {
      transition('extendscript_done');
      appendMessage('agent-text', {
        text: `Plan applied. ${extendscriptOps.length} ExtendScript ops generated. To execute, open the panel inside Premiere Pro.`,
      });
    }
  } catch (err) {
    transitionError(`Execution failed: ${err.message}`);
    appendMessage('error', {
      text: `Failed to execute plan: ${err.message}`,
      retryFn: onApprovePlan,
      dismissFn: transitionBack,
    });
  }
}

/**
 * Handle plan regeneration with a hint.
 */
async function onRegeneratePlan(hint) {
  const state = getState();
  const scriptText = state.session.scriptText;
  const sources = state.session.sources;

  transition('regenerate_clicked');
  appendMessage('agent-text', { text: 'Regenerating plan with your hint...' });

  try {
    await _createEditPlan(sources, scriptText, hint);
  } catch (err) {
    transitionError(`Regeneration failed: ${err.message}`);
    appendMessage('error', {
      text: `Failed to regenerate: ${err.message}`,
      dismissFn: transitionBack,
    });
  }
}

/**
 * Start a new edit → reset state.
 */
function onNewEdit() {
  resetState();
  clearChat();

  const hero = $('#hero');
  const chatScroll = $('#chat-scroll');
  const footer = $('#app-footer');

  if (hero) hero.classList.remove('hidden');
  if (chatScroll) chatScroll.classList.add('hidden');
  if (footer) footer.classList.add('hidden');
}

// ── Private: Source pickup (no separate transcribe step on this backend) ──
//
// The MVP backend's `/api/edit/analyze` runs the entire pipeline in one call:
// resolve bin references → transcribe (cached per fingerprint) → match → plan.
// So at source-pickup time we just collect the bin reference, optionally
// pre-warm transcripts via `/api/media/transcribe` so the user sees progress,
// and transition to `script_needed`. The expensive work runs inside
// `_createEditPlan` when the script arrives.

async function _startTranscription(source) {
  // We intentionally do NOT eagerly transcribe the whole bin on pickup anymore —
  // that was slow and surprising ("it transcribed everything"). Transcription is
  // now lazy: it happens when a script arrives (/api/edit/analyze transcribes on
  // demand) or via the Review editor / Scribe. The state-machine flow
  // (source_provided → all_jobs_complete → script_needed) is preserved.
  transition('source_provided');

  const clips = _resolveClipsFromScan(source);
  const sourceRef = _sourceToReference(source);

  transition('transcription_started');
  transition('all_jobs_complete');

  const n = clips.length;
  appendMessage('agent-text', {
    text: n
      ? `Got it — I'll use ${sourceRef} (${n} clip${n > 1 ? 's' : ''}). Share your script to auto-cut, or open Review (📝 in the header) to cut by transcript. I only transcribe when needed.`
      : `Got it. I'll work with ${sourceRef}. Share your script when ready.`,
  });

  const state = getState();
  if (state.session.pendingScriptFile) {
    const file = state.session.pendingScriptFile;
    setSession({ pendingScriptFile: null });
    await _processScriptFile(file);
  }
}

async function _addTranscriptionJobs(source) {
  // No eager transcription — just acknowledge the added source.
  appendMessage('agent-text', { text: `Added ${source.name} to the source list.` });
}

/**
 * Resolve a source (bin/clip ref) to a list of concrete clip records
 * by walking the cached project scan. No backend call — the backend's
 * `/api/edit/analyze` does its own authoritative resolve.
 */
function _resolveClipsFromScan(source) {
  const state = getState();
  const scan = state.session.scan || {};
  const items = scan.items || scan.clips || [];

  if (source.type === 'clip') {
    const target = (source.name || source.path || '').toLowerCase();
    return items.filter(it => {
      if (!_itemHasUsableAudio(it)) return false;
      const name = (it.name || '').toLowerCase();
      const media = (it.mediaPath || it.media_path || '').toLowerCase();
      return name === target || media.endsWith(target);
    });
  }

  const targets = [source.path, source.name]
    .filter(Boolean)
    .map(value => String(value).toLowerCase());
  return items.filter(it => {
    if (!_itemHasUsableAudio(it)) return false;
    const binPath = (it.binPath || it.bin_path || '').toLowerCase();
    if (!binPath) return false;
    return targets.some(target => (
      binPath === target ||
      binPath.endsWith('/' + target) ||
      binPath.split('/').pop() === target
    ));
  });
}

/**
 * Pre-warm transcripts so the analyze step is fast and the user sees progress.
 *
 * Calls `/api/media/transcribe` per clip. Whisper caches by content fingerprint,
 * so the later `/api/edit/analyze` call will not re-transcribe. The WS progress
 * channel handles intra-clip progress; we count clips finished here.
 */
async function _prewarmTranscripts(clips) {
  const state = getState();
  const clientId = state.session.clientId || '';
  let done = 0;
  _prewarmCtx = { clipsTotal: clips.length, clipsDone: 0, currentName: '' };

  for (const clip of clips) {
    const mediaPath = clip.mediaPath || clip.media_path;
    if (!mediaPath) { done++; _prewarmCtx.clipsDone = done; continue; }

    _prewarmCtx.currentName = clip.name || mediaPath.split(/[\\/]/).pop();
    const currentIdx = done + 1;
    updateProgress(_progressMsgId, {
      pct: Math.round((done / clips.length) * 100),
      detail: `Clip ${currentIdx} of ${clips.length} — starting "${_prewarmCtx.currentName}"...`,
    });

    try {
      const qs = new URLSearchParams({ path: mediaPath });
      if (clientId) qs.set('client_id', clientId);
      await apiPost(`/api/media/transcribe?${qs.toString()}`, null, { timeoutMs: 1800000 });
    } catch (err) {
      console.warn(`[orchestrator] Pre-warm failed for ${mediaPath}:`, err);
    }

    done++;
    _prewarmCtx.clipsDone = done;
    const finishedDetail = done === clips.length
      ? `${done} of ${clips.length} clips complete`
      : `${done} of ${clips.length} clips done — starting next...`;
    updateProgress(_progressMsgId, {
      pct: Math.round((done / clips.length) * 100),
      detail: finishedDetail,
    });
  }
  _prewarmCtx = null;
}

/**
 * Called from main.js when the WebSocket emits a `progress` event.
 * Updates the in-flight progress message with sub-clip Whisper progress so
 * the bar moves DURING a long transcription, not just between clips.
 */
function onWsProgress(payload) {
  if (!payload || !_progressMsgId || !_prewarmCtx) return;
  const taskType = payload.task_type || payload.taskType || '';
  if (!/transcribe/i.test(taskType)) return;

  const innerPct = Math.max(0, Math.min(1, Number(payload.progress) || 0));
  const { clipsTotal, clipsDone, currentName } = _prewarmCtx;
  const overall = ((clipsDone + innerPct) / Math.max(1, clipsTotal)) * 100;
  const currentIdx = Math.min(clipsTotal, clipsDone + 1);
  const innerPctText = `${Math.round(innerPct * 100)}%`;
  const namePart = currentName ? ` — "${currentName}" ${innerPctText}` : '';
  updateProgress(_progressMsgId, {
    pct: Math.round(overall),
    detail: `Clip ${currentIdx} of ${clipsTotal}${namePart}`,
  });
}

// ── Private: Script pipeline ─────────────────────────────────

async function _processScriptFile(file) {
  try {
    const result = await uploadScript(file);
    const fullText = result.full_text || '';
    const pageCount = result.page_count || 1;

    appendMessage('agent-text', {
      text: `I read ${pageCount} page${pageCount > 1 ? 's' : ''} from ${result.filename || file.name}.`,
    });

    // Heuristic: if short and homogenous, ingest directly
    if (fullText.length < 3000 && !fullText.includes('\n\n\n')) {
      await _ingestScript(fullText);
      return;
    }

    // Longer/mixed — try LLM extraction
    transition('script_ambiguous');
    await _extractScriptWithLLM(fullText, result.filename || file.name);
  } catch (err) {
    appendMessage('error', { text: `Failed to process document: ${err.message}` });
  }
}

async function _extractScriptWithLLM(fullText, filename) {
  try {
    const resp = await apiPost('/api/chat/message', {
      message: `${PROMPT_FIND_SCRIPT}\n\nDocument (${filename}):\n${fullText.substring(0, 8000)}`,
      session_id: 'script-extract',
    });

    const reply = resp.choices?.[0]?.message?.content || resp.response || resp.message?.content || '';
    let parsed;
    try {
      // Try to parse JSON from the reply
      const jsonMatch = reply.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch (_) {
      parsed = null;
    }

    if (parsed && parsed.candidate_script && parsed.confidence > 0.5) {
      const excerpt = parsed.candidate_script.substring(0, 240) + (parsed.candidate_script.length > 240 ? '...' : '');
      appendMessage('extract-card', {
        intro: `It looks like this document has a script portion. Use this excerpt?`,
        excerpt,
        onConfirm: async () => {
          await _ingestScript(parsed.candidate_script);
        },
        onReject: () => {
          appendMessage('agent-text', { text: 'Paste the correct script portion below:' });
        },
      });
    } else {
      // No clear script found — ask user to paste
      appendMessage('agent-text', {
        text: `I couldn't find a clear script in this document. Please paste your script below:`,
      });
    }
  } catch (err) {
    // LLM failed — fall back to asking user to paste
    appendMessage('agent-text', {
      text: 'I had trouble analyzing this document. Please paste your script below:',
    });
  }
}

// ── External-LLM paste workflow handlers ──────────────────────
// These talk to /api/external-plan/build-prompt and /api/external-plan/ingest
// (both stateless: they accept bin_references and resolve them server-side
// against the cached project scan).  We do NOT touch the legacy script-match
// flow — the orchestrator's other state transitions are unaffected.

function _collectBinReferences() {
  // Reuse the existing _sourceToReference helper that the legacy script
  // pipeline uses, so what we send matches what /api/edit/analyze accepts.
  const sources = getState().session.sources || [];
  return sources.filter(s => s.type !== 'file').map(_sourceToReference);
}

async function _handleLlmPromptCommand() {
  const binRefs = _collectBinReferences();
  if (binRefs.length === 0) {
    appendMessage('agent-text', {
      text: 'No source bins/clips selected yet. Pick a bin from your project first '
          + '(e.g. type @bin:Raw or drop one onto this panel).',
    });
    return;
  }

  const scriptText = (getState().session.scriptText || '').trim();
  const msgId = appendMessage('progress', {
    label: 'Building the LLM paste prompt...',
    pct: 30,
    detail: 'Loading cached transcripts for all clips in the bin.',
  });

  try {
    const resp = await apiPost(
      '/api/external-plan/build-prompt',
      { bin_references: binRefs, script: scriptText },
      { timeoutMs: 120000 },
    );
    updateProgress(msgId, { pct: 100, detail: 'Done.' });
    appendMessage('prompt-box', resp);
  } catch (err) {
    updateProgress(msgId, { pct: 100, detail: 'Failed.' });
    appendMessage('error', {
      text: `Couldn't build the LLM prompt: ${err.message || err}. `
          + `Are the clips transcribed yet?`,
    });
  }
}

async function _handleCutplanPromptCommand() {
  const binRefs = _collectBinReferences();
  if (binRefs.length === 0) {
    appendMessage('agent-text', {
      text: 'No source bins/clips selected yet. Pick a bin from your project first '
          + '(e.g. type @bin:Raw or drop one onto this panel).',
    });
    return;
  }

  const scriptText = (getState().session.scriptText || '').trim();
  const msgId = appendMessage('progress', {
    label: 'Building the cut-planning prompt...',
    pct: 40,
    detail: 'Collecting clip names from the bin.',
  });

  try {
    const resp = await apiPost(
      '/api/external-plan/cutplan-prompt',
      { bin_references: binRefs, script: scriptText },
      { timeoutMs: 60000 },
    );
    updateProgress(msgId, { pct: 100, detail: 'Done.' });
    appendMessage('prompt-box', resp);
  } catch (err) {
    updateProgress(msgId, { pct: 100, detail: 'Failed.' });
    appendMessage('error', {
      text: `Couldn't build the cut-planning prompt: ${err.message || err}.`,
    });
  }
}

async function _handleTranscriptionPromptCommand() {
  // Step 1 of the Gemini flow.  Static prompt — no bin/script needed; the user
  // pastes it into Gemini with the video attached to get a transcript JSON.
  const msgId = appendMessage('progress', {
    label: 'Building the transcription prompt...',
    pct: 50,
    detail: 'Preparing the Gemini transcription prompt.',
  });

  try {
    const resp = await apiGet(
      '/api/external-plan/transcription-prompt',
      { timeoutMs: 30000 },
    );
    updateProgress(msgId, { pct: 100, detail: 'Done.' });
    appendMessage('prompt-box', resp);
  } catch (err) {
    updateProgress(msgId, { pct: 100, detail: 'Failed.' });
    appendMessage('error', {
      text: `Couldn't build the transcription prompt: ${err.message || err}.`,
    });
  }
}

async function _handlePastePlanCommand(rawJson) {
  if (!rawJson || rawJson.length < 10) {
    appendMessage('agent-text', {
      text: 'Pass the JSON after /paste-plan. Example:\n'
          + '  /paste-plan {"cuts":[{"source_file":"...","source_in":12.3,"source_out":18.7}]}',
    });
    return;
  }

  const binRefs = _collectBinReferences();
  if (binRefs.length === 0) {
    appendMessage('agent-text', {
      text: 'No bin selected. Pick the bin those source_file names live in first.',
    });
    return;
  }

  const scriptText = (getState().session.scriptText || '').trim();
  const msgId = appendMessage('progress', {
    label: 'Applying pasted cut plan...',
    pct: 30,
    detail: 'Validating JSON and resolving source files.',
  });

  let resp;
  try {
    resp = await apiPost(
      '/api/external-plan/ingest',
      {
        pasted_text: rawJson,
        bin_references: binRefs,
        script: scriptText,
        user_hint: 'external_llm_paste',
      },
      { timeoutMs: 60000 },
    );
  } catch (err) {
    updateProgress(msgId, { pct: 100, detail: 'Failed.' });
    appendMessage('error', {
      text: `Plan rejected: ${err.message || err}. `
          + `Check the JSON schema (cuts: [{source_file, source_in, source_out}]).`,
    });
    return;
  }

  const planId = resp.plan_id;
  if (!planId) {
    updateProgress(msgId, { pct: 100, detail: 'Failed.' });
    appendMessage('error', { text: 'Ingest returned no plan_id.' });
    return;
  }
  const skipped = (resp.gaps || []).length;
  updateProgress(msgId, { pct: 100, detail: 'Plan stored.' });

  // Load the full plan so we render the SAME card the matcher uses.
  // _extractBeats handles the Cut serialisation identically for both paths.
  let plan;
  try {
    plan = await apiGet(`/api/edit/plan/${planId}`, { timeoutMs: 10000 });
  } catch (_) {
    plan = resp;
  }

  // Land in plan_ready the way the matcher path ends up there, so the card's
  // "Build sequence" button (onApprovePlan → transition('approve_clicked'),
  // valid only from plan_ready) works.  No table event reaches plan_ready from
  // an arbitrary state, so we set it via the state API rather than editing the
  // legacy transition table.  setState first, then setSession persists it.
  setState({ current: 'plan_ready' });
  setSession({ planId, dryRun: plan });

  const beats = _extractBeats(plan);
  const summary = plan.summary || resp.summary || {};
  const totalDuration =
    summary.total_duration || beats.reduce((s, b) => s + (b.duration || 0), 0);
  const unmatched = summary.unmatched != null ? summary.unmatched : skipped;

  appendMessage('plan-card', {
    intro: `Pasted plan: ${beats.length} cut${beats.length === 1 ? '' : 's'}, `
         + `${_fmtDur(totalDuration)} total`
         + (unmatched > 0 ? `, ${unmatched} skipped` : '') + '.',
    planId,
    plan: { beats, totalDuration, unmatched },
    onApprove: onApprovePlan,
    onRegenerate: () => {
      appendMessage('agent-text', {
        text: 'Regenerate is not available for pasted plans — paste a new /paste-plan instead.',
      });
    },
  });
}

async function _ingestScript(text) {
  // This backend has no separate `/scripts/ingest` endpoint - the script is
  // passed directly to `/api/edit/analyze` along with the bin references.
  // We keep the function name for state-machine compatibility.
  setSession({ scriptText: text });
  const state = getState();
  transition(state.current === 'script_understood' ? 'script_confirmed' : 'script_provided');
  appendMessage('agent-text', { text: 'Script received. Building your edit plan...' });

  const sources = getState().session.sources || [];
  await _createEditPlan(sources, text);
}

// Private: Edit plan pipeline ==

/**
 * Build an edit plan. On this backend, `/api/edit/analyze` is one all-in-one
 * call: resolve bin references -> transcribe (cached) -> match takes to script
 * -> return plan_id + summary. We then GET the full plan for the plan card.
 */
async function _createEditPlan(sources, scriptText, hint) {
  try {
    const binRefs = sources
      .filter(s => s.type !== 'file')
      .map(_sourceToReference);

    if (binRefs.length === 0) {
      throw new Error('No bin references collected. Pick a bin from Premiere first.');
    }

    const state = getState();
    const payload = {
      bin_references: binRefs,
      script: scriptText || state.session.scriptText || '',
      client_id: state.session.clientId || undefined,
    };
    if (hint) payload.user_hint = hint;

    _progressMsgId = appendMessage('progress', {
      label: 'Matching script to takes...',
      pct: 10,
      detail: 'Running matcher...',
    });

    const analyzeResult = await apiPost('/api/edit/analyze', payload, { timeoutMs: 600000 });
    const planId = analyzeResult.plan_id;

    if (!planId) {
      throw new Error('Analyze returned no plan_id.');
    }

    updateProgress(_progressMsgId, { pct: 90, detail: 'Loading plan...' });

    let plan;
    try {
      plan = await apiGet(`/api/edit/plan/${planId}`, { timeoutMs: 30000 });
    } catch (err) {
      plan = analyzeResult;
    }

    setSession({ planId, dryRun: plan });
    transition('dry_run_ready');

    const beats = _extractBeats(plan);
    const summary = plan.summary || analyzeResult.summary || {};
    const totalDuration =
      summary.total_duration || plan.total_duration || beats.reduce((s, b) => s + (b.duration || 0), 0);
    const unmatched = summary.unmatched || beats.filter(b => b.unmatched).length;
    const warnings = analyzeResult.warnings || plan.warnings || [];

    if (warnings.length > 0) {
      appendMessage('agent-text', { text: `Notes: ${warnings.slice(0, 3).join(' | ')}` });
    }

    appendMessage('plan-card', {
      intro: `I built a plan: ${beats.length} cuts, ${_fmtDur(totalDuration)} total${unmatched > 0 ? `, ${unmatched} beat${unmatched > 1 ? 's' : ''} unmatched` : ''}.`,
      planId,
      plan: { beats, totalDuration, unmatched },
      onApprove: onApprovePlan,
      onRegenerate: onRegeneratePlan,
    });
  } catch (err) {
    transitionError(`Plan creation failed: ${err.message}`);
    appendMessage('error', {
      text: `Failed to create edit plan: ${err.message}`,
      dismissFn: transitionBack,
    });
  }
}

function _extractBeats(plan) {
  // Try various possible structures from the backend
  const rawBeats = plan.beats || plan.cuts || plan.clips || plan.operations || [];

  return rawBeats.map((beat, i) => {
    if (beat.unmatched || beat.no_match) {
      return { unmatched: true, text: beat.text || beat.beat_text || beat.script_line || `Beat ${i + 1}` };
    }
    // External/review cuts use beat_text/source_in/source_out/take_source_file;
    // the matcher uses text/start/end/clip_name. Accept both (?? so a real 0 isn't
    // skipped). This is why the pasted-plan card used to show "" and 0:00.
    const srcPath = beat.clip_name || beat.take_source_file || beat.source || beat.asset_name || '';
    const start = beat.start ?? beat.source_in ?? beat.source_start ?? 0;
    const end = beat.end ?? beat.source_out ?? beat.source_end ?? 0;
    return {
      text: beat.text || beat.beat_text || beat.script_line || beat.phrase || '',
      clipName: String(srcPath).split(/[\\/]/).pop() || '',
      start,
      end,
      duration: beat.duration || (end - start),
      unmatched: false,
    };
  });
}

// ── Private: Helpers ─────────────────────────────────────────

function _extractBins(scanResult) {
  if (scanResult.bins) return scanResult.bins;
  if (scanResult.project && scanResult.project.bins) return scanResult.project.bins;

  // Try to derive bins from items
  const items = scanResult.items || scanResult.clips || [];
  const binMap = {};
  for (const item of items) {
    const binPath = item.binPath || item.bin_path || 'Root';
    if (!binMap[binPath]) {
      binMap[binPath] = { name: binPath.split('/').pop() || binPath, path: binPath, itemCount: 0 };
    }
    binMap[binPath].itemCount++;
  }
  return Object.values(binMap);
}

async function _narrateBinTour(bins, items) {
  try {
    const resp = await apiPost('/api/chat/message', {
      message: `${PROMPT_BIN_TOUR}\n\nProject scan:\n${JSON.stringify({ bins, itemCount: items.length })}\n\nReply in one short paragraph (max 2 sentences). Do NOT mention any API endpoints, URLs, or code.`,
      session_id: 'bin-tour',
    }, { timeoutMs: 10000 });
    const reply = resp.message?.content || resp.response || null;
    // Guard against the rule-based fallback that leaks API docs.
    if (reply && _looksLikeDocsDump(reply)) return null;
    return reply;
  } catch (_) {
    return null;
  }
}

function _itemHasUsableAudio(item) {
  if (!item) return false;
  if (item.hasAudio === true || item.has_audio === true) return true;
  if (item.hasAudio === false || item.has_audio === false) return false;

  const mediaPath = String(item.mediaPath || item.media_path || '').toLowerCase();
  return /\.(mov|mp4|m4v|avi|mxf|mts|m2ts|mpg|mpeg|webm|wav|mp3|aac|m4a|aif|aiff)$/i.test(mediaPath);
}

function _addSource(sources, source) {
  const sourceRef = _sourceToReference(source).toLowerCase();
  if (!sourceRef) return sources;

  const exists = sources.some(existing => _sourceToReference(existing).toLowerCase() === sourceRef);
  return exists ? sources : [...sources, source];
}

function _sourceToReference(source) {
  if (!source) return '';
  if (source.type === 'bin') return `@bin:${source.path || source.name || ''}`;
  if (source.type === 'clip') return `@clip:${source.name || source.path || ''}`;
  return source.name || source.path || '';
}

function _extractSourceReferences(text) {
  const refs = [];
  const explicit = text.match(/@(bin|clip):([^\s,;]+)/gi) || [];
  for (const ref of explicit) {
    const match = ref.match(/^@(bin|clip):(.+)/i);
    if (match) refs.push({ type: match[1].toLowerCase(), name: match[2].trim() });
  }

  const generic = text.match(/@([A-Za-z0-9_.-]+)/g) || [];
  for (const ref of generic) {
    if (/^@(bin|clip):/i.test(ref)) continue;
    refs.push({ type: 'bin', name: ref.substring(1).trim() });
  }

  return refs;
}

function _looksLikeSourceCommand(text) {
  return /\b(use|work|analy[sz]e|select|choose|pick|source|clips?|bins?|footage|takes?|inside|from)\b/i.test(text);
}

function _fmtDur(seconds) {
  if (!seconds || seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export {
  onScanClicked,
  onScanComplete,
  onSourceProvided,
  onPProItemsProvided,
  onMediaFileDropped,
  onScriptFileDropped,
  onUserMessage,
  onApprovePlan,
  onRegeneratePlan,
  onNewEdit,
  onWsProgress,
};
