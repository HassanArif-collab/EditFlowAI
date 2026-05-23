/**
 * orchestrator.js — Agent-side decision tree for EditFlow single-chat UX.
 *
 * Listens to state transitions and emits chat messages + side effects.
 * Owns the LLM prompts and coordinates the pipeline stages.
 */
import { getState, setSession, transition, transitionError, transitionBack, subscribe, resetState } from './state.js';
import { apiGet, apiPost } from './api.js';
import { callExtendScript, scanProjectMedia, isExtendScriptAvailable } from './extendscript.js';
import { appendMessage, updateProgress, clearChat, scrollToBottom } from './chat-ui.js';
import { uploadScript } from './upload.js';

const $ = (sel) => document.querySelector(sel);

// ── LLM Prompts ──────────────────────────────────────────────
const PROMPT_BIN_TOUR = `You are EditFlow, an AI editing assistant. The user just scanned their Premiere project. You see a list of bins and their contents. Write a 1-2 sentence summary of what you see, then ask which bin has their raw footage. Be concise and friendly.`;

const PROMPT_FIND_SCRIPT = `You are EditFlow, an AI editing assistant. The user uploaded a document that may contain a script mixed with other content (research notes, instructions, etc). Find the portion that looks like a spoken script (direct address to an audience, conversational tone). Return a JSON object with: { "candidate_script": "the extracted script text", "confidence": 0.0-1.0, "reasoning": "brief explanation" }. If no clear script is found, set confidence to 0 and explain.`;

// ── Progress tracking ────────────────────────────────────────
let _progressMsgId = null;
let _jobStatuses = {};

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
        const resp = await apiGet('/api/project/context', { timeoutMs: 5000 });
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
      await apiPost('/api/project/context', scanResult, { timeoutMs: 10000 });
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
    const audioItems = binItems.filter(item => item.hasAudio || item.has_audio);
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

  // Show user message
  if (source.type === 'bin') {
    appendMessage('user-text', { text: `@bin:${source.name}` });
  } else if (source.type === 'clip') {
    appendMessage('user-text', { text: `@clip:${source.name}` });
  } else {
    appendMessage('user-text', { text: source.name || source.path || 'Dropped file(s)' });
  }

  // Add to sources list
  const sources = [...(state.session.sources || []), source];
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
    appendMessage('agent-text', { text: `Noted: ${source.name}. I'll include this in the edit.` });
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
  for (const item of items) {
    const source = {
      type: item.isBin || item.is_bin ? 'bin' : 'clip',
      name: item.name,
      path: item.binPath || item.bin_path || '',
      mediaPath: item.mediaPath || item.media_path || '',
      hasAudio: item.hasAudio || item.has_audio || false,
      duration: item.duration || 0,
    };
    const sources = [...(state.session.sources || []), source];
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

  // Register the asset with the backend
  try {
    const result = await apiPost('/api/v2/assets/register', {
      path: filePath,
      name: file.name,
    });
    source.assetId = result.id || result.asset_id;
  } catch (err) {
    appendMessage('error', { text: `Failed to register ${file.name}: ${err.message}` });
    return;
  }

  const sources = [...(state.session.sources || []), source];
  setSession({ sources });

  if (state.current === 'scanned' || state.current === 'source_picked' || state.current === 'idle') {
    // Ensure we're past scan stage
    if (state.current === 'idle') {
      transition('scan_clicked');
    }
    await _startTranscription(source);
  }
}

/**
 * Handle a script file dropped from OS.
 */
async function onScriptFileDropped(file) {
  const state = getState();

  appendMessage('user-text', { text: `${file.name} — attached` });

  if (state.current === 'script_needed') {
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

  // Check for @ references
  if (text.startsWith('@bin:') || text.startsWith('@clip:')) {
    const match = text.match(/^@(bin|clip):(.+)/i);
    if (match) {
      await onSourceProvided({ type: match[1], name: match[2].trim() });
      return;
    }
  }

  // Check for any @mention
  const atRefs = text.match(/@(\w[^\s@]*)/g);
  if (atRefs && (state.current === 'scanned' || state.current === 'source_picked')) {
    for (const ref of atRefs) {
      await onSourceProvided({ type: 'bin', name: ref.substring(1) });
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
      messages: [
        { role: 'system', content: 'You are EditFlow, an AI editing assistant. Help the user with their video editing project. Be concise.' },
        { role: 'user', content: text },
      ],
    });
    const reply = resp.choices?.[0]?.message?.content || resp.response || resp.message || '';
    if (reply) {
      appendMessage('agent-text', { text: reply });
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
    // Execute the plan
    const executeResult = await apiPost(`/api/v2/edit-plans/${planId}/execute`, {}, { timeoutMs: 60000 });
    const edl = executeResult.virtual_edit_spec || executeResult.edl || executeResult;

    setSession({ edl });

    // Send EDL to Premiere via ExtendScript
    if (isExtendScriptAvailable()) {
      updateProgress(_progressMsgId, { pct: 50, detail: 'Placing clips in Premiere...' });

      const edlPayload = edl.clips ? { ops: edl.clips } : edl;
      await callExtendScript('processEDL', JSON.stringify(edlPayload));

      updateProgress(_progressMsgId, { pct: 90, detail: 'Verifying...' });

      // Optional: verify
      try {
        await apiPost(`/api/v2/edit-plans/${planId}/verify`, { sequence_state: {} }, { timeoutMs: 10000 });
      } catch (_) { /* verification is optional */ }

      transition('extendscript_done');
      const seqName = state.session.targetSequenceName || `EditFlow Cut - ${new Date().toLocaleString()}`;
      appendMessage('success', {
        text: `Done. "${seqName}" is in your Premiere project. Switch to Premiere to play it back.`,
        newEditFn: onNewEdit,
      });
    } else {
      // No ExtendScript — show the EDL data
      transition('extendscript_done');
      appendMessage('agent-text', {
        text: `Plan executed. EDL data:\n${JSON.stringify(edl, null, 2).substring(0, 500)}...\n\nTo apply this, open the panel inside Premiere Pro.`,
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
  const scriptId = state.session.scriptId;
  const sources = state.session.sources;

  transition('regenerate_clicked');
  appendMessage('agent-text', { text: 'Regenerating plan with your hint...' });

  try {
    await _createEditPlan(sources, scriptId, hint);
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

// ── Private: Transcription pipeline ──────────────────────────

async function _startTranscription(source) {
  transition('source_provided');

  let resolvedClips = [];

  // Resolve the reference to get actual clips
  try {
    const resolveResult = await apiPost('/api/v2/references/resolve', {
      text: source.name,
      kind: source.type,
    }, { timeoutMs: 10000 });

    resolvedClips = resolveResult.clips || resolveResult.items || resolveResult.assets || [];

    if (resolvedClips.length === 0 && source.mediaPath) {
      // If resolve failed but we have a media path, try registering
      try {
        const regResult = await apiPost('/api/v2/assets/register', {
          path: source.mediaPath,
          name: source.name,
        });
        resolvedClips = [regResult];
      } catch (_) {}
    }
  } catch (err) {
    // Resolve failed — try to register directly
    if (source.mediaPath) {
      try {
        const regResult = await apiPost('/api/v2/assets/register', {
          path: source.mediaPath,
          name: source.name,
        });
        resolvedClips = [regResult];
      } catch (regErr) {
        appendMessage('agent-text', {
          text: `Got it. Transcribing ${source.name}.`,
        });
        // Continue anyway — the resolve might work on retry
      }
    }
  }

  if (resolvedClips.length === 0) {
    appendMessage('agent-text', {
      text: `Got it. I'll work with ${source.name}. Please share your script when ready.`,
    });
    transition('transcription_started');
    setTimeout(() => {
      transition('all_jobs_complete');
      appendMessage('agent-text', {
        text: 'Transcription complete. Now share your script \u2014 paste it below, or drop a .txt/.docx/.pdf onto this panel.',
      });
    }, 1000);
    return;
  }

  const clipCount = resolvedClips.length;
  const totalDuration = resolvedClips.reduce((s, c) => s + (c.duration || 0), 0);

  appendMessage('agent-text', {
    text: `Got it. Transcribing ${clipCount} clip${clipCount > 1 ? 's' : ''}, ~${_fmtDur(totalDuration)} audio.`,
  });

  transition('transcription_started');

  // Start async transcription jobs
  _jobStatuses = {};
  const jobIds = [];

  for (const clip of resolvedClips) {
    const assetId = clip.id || clip.asset_id;
    if (!assetId) continue;

    try {
      const jobResult = await apiPost(`/api/v2/assets/${assetId}/analyze-async`, {}, { timeoutMs: 10000 });
      const jobId = jobResult.job_id || jobResult.id;
      if (jobId) {
        jobIds.push(jobId);
        _jobStatuses[jobId] = { status: 'pending', assetId, clipName: clip.name || clip.original_name || '' };
      }
    } catch (err) {
      console.warn(`[orchestrator] Failed to start transcription for ${assetId}:`, err);
    }
  }

  if (jobIds.length === 0) {
    // No jobs started — skip to script_needed
    transition('all_jobs_complete');
    appendMessage('agent-text', {
      text: 'No transcription jobs started. You can share your script now.',
    });
    return;
  }

  // Show progress
  _progressMsgId = appendMessage('progress', {
    label: 'Transcribing...',
    pct: 0,
    detail: `0 of ${jobIds.length} complete`,
  });

  // Poll for job completion
  _pollJobs(jobIds);
}

async function _addTranscriptionJobs(source) {
  // Already in transcribing state — just resolve + start new jobs without re-triggering transitions
  appendMessage('agent-text', { text: `Adding ${source.name} to transcription queue...` });

  // Resolve the reference and start additional transcription jobs
  let resolvedClips = [];
  try {
    const resolveResult = await apiPost('/api/v2/references/resolve', {
      text: source.name,
      kind: source.type,
    }, { timeoutMs: 10000 });
    resolvedClips = resolveResult.clips || resolveResult.items || resolveResult.assets || [];
  } catch (err) {
    if (source.mediaPath) {
      try {
        const regResult = await apiPost('/api/v2/assets/register', {
          path: source.mediaPath,
          name: source.name,
        });
        resolvedClips = [regResult];
      } catch (_) {}
    }
  }

  // Start additional async transcription jobs
  for (const clip of resolvedClips) {
    const assetId = clip.id || clip.asset_id;
    if (!assetId) continue;
    try {
      const jobResult = await apiPost(`/api/v2/assets/${assetId}/analyze-async`, {}, { timeoutMs: 10000 });
      const jobId = jobResult.job_id || jobResult.id;
      if (jobId) {
        _jobStatuses[jobId] = { status: 'pending', assetId, clipName: clip.name || clip.original_name || '' };
      }
    } catch (err) {
      console.warn(`[orchestrator] Failed to start transcription for ${assetId}:`, err);
    }
  }
}

function _pollJobs(jobIds) {
  let pollTimer = setInterval(async () => {
    let completedCount = 0;
    let failedCount = 0;

    for (const jobId of jobIds) {
      const jobInfo = _jobStatuses[jobId];
      if (!jobInfo || jobInfo.status === 'completed' || jobInfo.status === 'failed') {
        if (jobInfo?.status === 'completed') completedCount++;
        if (jobInfo?.status === 'failed') failedCount++;
        continue;
      }

      try {
        const result = await apiGet(`/api/v2/jobs/${jobId}`, { timeoutMs: 3000 });
        const status = result.status || 'unknown';
        _jobStatuses[jobId].status = status;

        if (status === 'completed') completedCount++;
        if (status === 'failed') {
          failedCount++;
          appendMessage('error', {
            text: `Transcription failed for ${jobInfo.clipName}: ${result.error || 'Unknown error'}`,
          });
        }
      } catch (_) {
        // Job polling failed — skip
      }
    }

    const total = jobIds.length;
    const pct = Math.round((completedCount + failedCount) / total * 100);
    updateProgress(_progressMsgId, {
      pct,
      detail: `${completedCount} of ${total} complete${failedCount > 0 ? ` (${failedCount} failed)` : ''}`,
    });

    if (completedCount + failedCount >= total) {
      clearInterval(pollTimer);
      transition('all_jobs_complete');

      // Count total words from transcripts
      const wordCount = Object.values(_jobStatuses).reduce((sum, j) => sum + (j.wordCount || 0), 0);

      appendMessage('agent-text', {
        text: `Transcription complete (${completedCount} take${completedCount !== 1 ? 's' : ''}${wordCount > 0 ? `, ${wordCount} words` : ''}). Now share your script \u2014 paste it below, or drop a .txt/.docx/.pdf onto this panel.`,
      });

      // If there's a pending script file, process it now
      const state = getState();
      if (state.session.pendingScriptFile) {
        const file = state.session.pendingScriptFile;
        setSession({ pendingScriptFile: null });
        await _processScriptFile(file);
      }
    }
  }, 2000);
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
      messages: [
        { role: 'system', content: PROMPT_FIND_SCRIPT },
        { role: 'user', content: fullText.substring(0, 8000) }, // Truncate for LLM context
      ],
    });

    const reply = resp.choices?.[0]?.message?.content || resp.response || '';
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

async function _ingestScript(text) {
  try {
    const result = await apiPost('/api/v2/scripts/ingest', {
      title: `Script ${new Date().toLocaleString()}`,
      content: text,
    });

    const scriptId = result.id || result.script_id;
    setSession({ scriptId, scriptText: text });

    // Transition to matching and create edit plan
    transition('script_provided');
    appendMessage('agent-text', { text: 'Script received. Building your edit plan...' });

    await _createEditPlan(getState().session.sources, scriptId);
  } catch (err) {
    transitionError(`Script ingest failed: ${err.message}`);
    appendMessage('error', {
      text: `Failed to ingest script: ${err.message}`,
      dismissFn: transitionBack,
    });
  }
}

// ── Private: Edit plan pipeline ──────────────────────────────

async function _createEditPlan(sources, scriptId, hint) {
  try {
    const payload = {
      sources: sources.map(s => ({
        type: s.type,
        name: s.name,
        path: s.path || s.mediaPath || '',
        asset_id: s.assetId,
      })),
      script_id: scriptId,
      operation: 'combine_assets_new_sequence',
      constraints: hint ? { user_hint: hint } : {},
    };

    const createResult = await apiPost('/api/v2/edit-plans/create', payload, { timeoutMs: 60000 });
    const planId = createResult.plan_id || createResult.id;

    if (!planId) {
      throw new Error('No plan ID returned from create');
    }

    setSession({ planId });

    // Run dry-run
    let dryRun = null;
    try {
      dryRun = await apiPost(`/api/v2/edit-plans/${planId}/dry-run`, {}, { timeoutMs: 30000 });
    } catch (err) {
      console.warn('[orchestrator] Dry-run failed:', err);
      // Continue without dry-run
    }

    setSession({ dryRun });

    // Transition to plan_ready
    transition('dry_run_ready');

    // Build plan card from the results
    const plan = dryRun || createResult;
    const beats = _extractBeats(plan);
    const totalDuration = plan.total_duration || plan.duration || 0;
    const unmatched = beats.filter(b => b.unmatched).length;

    appendMessage('plan-card', {
      intro: `I built a plan: **${beats.length} cuts**, ${_fmtDur(totalDuration)} total${unmatched > 0 ? `, ${unmatched} beat${unmatched > 1 ? 's' : ''} I couldn't match` : ''}.`,
      planId,
      plan: {
        beats,
        totalDuration,
        unmatched,
      },
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
      return { unmatched: true, text: beat.text || beat.script_line || `Beat ${i + 1}` };
    }
    return {
      text: beat.text || beat.script_line || beat.phrase || '',
      clipName: beat.clip_name || beat.source || beat.asset_name || '',
      start: beat.start || beat.source_start || 0,
      end: beat.end || beat.source_end || 0,
      duration: beat.duration || (beat.end || 0) - (beat.start || 0),
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
      messages: [
        { role: 'system', content: PROMPT_BIN_TOUR },
        { role: 'user', content: JSON.stringify({ bins, itemCount: items.length }) },
      ],
    }, { timeoutMs: 10000 });
    return resp.choices?.[0]?.message?.content || resp.response || null;
  } catch (_) {
    return null;
  }
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
};
