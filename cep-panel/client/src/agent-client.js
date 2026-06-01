/**
 * agent-client.js — LLM-driven agent orchestrator for EditFlow.
 *
 * Replaces the rigid 7-stage state machine in orchestrator.js with
 * a tool-calling agent loop.  Every user action posts an event to
 * POST /api/agent/turn and renders the returned messages.
 *
 * Exports the same function names as orchestrator.js so main.js can
 * swap them via the feature flag.
 */
import { apiGet, apiPost, connectWS, getBaseUrl } from './api.js';
import { callExtendScript, scanProjectMedia, isExtendScriptAvailable } from './extendscript.js';
import { appendMessage, updateProgress, clearChat, scrollToBottom } from './chat-ui.js';
import { uploadScript } from './upload.js';
import { getState } from './state.js';

const $ = (sel) => document.querySelector(sel);

// ── Session ID (persists across turns) ────────────────────────
// SESSION_ID is the agent-session key — unique per page load, used by the
// backend to thread context across agent turns.
const SESSION_ID = 'cep-agent-' + Math.random().toString(36).substring(2, 10);

// CLIENT_ID must match the WebSocket connection's client_id (set in main.js
// and stored in state.session.clientId) so backend WS pushes — agent_tool
// events, progress ticks, etc. — actually reach this panel. We previously
// reused SESSION_ID, which was a DIFFERENT random string than the WS one,
// so every send_to(req.client_id, ...) hit a dead end and no progress
// events ever rendered. Falling back to SESSION_ID keeps server-side
// behavior working if state hasn't been initialized yet (defensive only).
function _wsClientId() {
  try {
    return getState()?.session?.clientId || SESSION_ID;
  } catch (_) {
    return SESSION_ID;
  }
}

// ── Progress tracking ─────────────────────────────────────────
let _progressMsgId = null;

// ── Core: post a turn to the agent ────────────────────────────

async function _postTurn(event, payload = {}) {
  try {
    const resp = await apiPost('/api/agent/turn', {
      session_id: SESSION_ID,
      event,
      payload,
      client_id: _wsClientId(),
    }, { timeoutMs: 1800000 }); // 30 min for long transcribes

    for (const msg of (resp.messages || [])) {
      _renderMessage(msg);
    }
    return resp;
  } catch (err) {
    appendMessage('error', {
      text: `Agent error: ${err.message}`,
      retryFn: () => _postTurn(event, payload),
    });
  }
}

// ── Render a message from the agent response ──────────────────

function _renderMessage(msg) {
  switch (msg.kind) {
    case 'agent_text':
      appendMessage('agent-text', { text: msg.text });
      break;

    case 'ui_card':
      _renderCard(msg.card);
      break;

    case 'ask':
      appendMessage('ask-card', {
        question: msg.question,
        options: msg.options || [],
        onOptionClick: (value) => _handleAskOption(value, msg),
      });
      break;

    default:
      appendMessage('agent-text', { text: msg.text || JSON.stringify(msg) });
  }
}

// ── Render a UI card from a tool result ────────────────────────

function _renderCard(card) {
  if (!card) return;

  switch (card.kind) {
    case 'bin_summary':
      appendMessage('bin-summary-card', {
        intro: (card.payload || {}).intro || 'Project bins:',
        bins: (card.payload || {}).bins || [],
        onBinClick: (binName, binPath) => {
          onSourceProvided({ type: 'bin', name: binName, path: binPath });
        },
      });
      break;

    case 'transcript_summary':
      appendMessage('transcript-summary-card', card.payload || {});
      break;

    case 'plan_card':
      _renderPlanCard(card.payload || {});
      break;

    case 'extract_card':
      appendMessage('extract-card', card.payload || {});
      break;

    case 'request_scan':
      _runScan();
      break;

    case 'plan_apply_request':
      _dispatchEDL(card.payload || {});
      break;

    case 'ack':
      appendMessage('agent-text', { text: (card.payload || {}).text || '' });
      break;

    case 'paste_prompt_card':
      appendMessage('prompt-box', card.payload || {});
      break;

    case 'progress':
      _progressMsgId = appendMessage('progress', {
        label: (card.payload || {}).label || 'Working...',
        pct: (card.payload || {}).pct || 0,
        detail: (card.payload || {}).detail || '',
      });
      break;

    default:
      appendMessage('agent-text', {
        text: (card.payload || {}).text || (card.payload || {}).intro || 'Card rendered.',
      });
  }
}

// ── Render a plan card (mirrors orchestrator.js logic) ────────

function _renderPlanCard(payload) {
  const plan = payload.plan || {};
  const beats = plan.beats || [];
  const totalDuration = plan.totalDuration || 0;
  const unmatched = plan.unmatched || 0;
  const planId = payload.plan_id || '';

  appendMessage('plan-card', {
    intro: payload.intro || `I built a plan: ${beats.length} cuts.`,
    planId,
    plan: { beats, totalDuration, unmatched },
    onApprove: () => onApprovePlan(),
    onRegenerate: (hint) => onRegeneratePlan(hint),
  });
}

// ── Handle "ask" option clicks ────────────────────────────────

function _handleAskOption(value, askMsg) {
  appendMessage('user-text', { text: value });

  // Map common option values to actions
  if (value === 'no_script') {
    // User wants transcript-only cuts
    _postTurn('user_message', {
      text: 'I don\'t have a script. Just cut my transcripts well, removing false starts and hesitations.',
    });
  } else if (value === 'paste_script') {
    appendMessage('agent-text', { text: 'Paste your script below:' });
  } else if (value === 'extract') {
    _postTurn('user_message', {
      text: 'Try to extract a script from the uploaded document.',
    });
  } else if (value === 'approve_plan') {
    onApprovePlan();
  } else {
    // Generic: send the option value back as a user message
    _postTurn('user_message', { text: value });
  }
}

// ── Scan flow ─────────────────────────────────────────────────

async function _runScan() {
  if (isExtendScriptAvailable()) {
    try {
      const scanResult = await scanProjectMedia();
      // POST scan result to backend
      try {
        await apiPost('/api/premiere/context', {
          items: scanResult.items || [],
          bins: scanResult.bins || [],
          sequences: scanResult.sequences || [],
        }, { timeoutMs: 10000 });
      } catch (_) { /* ignore */ }

      // Post scan_completed to agent
      await _postTurn('scan_completed', scanResult);
    } catch (err) {
      appendMessage('error', {
        text: `Scan failed: ${err.message}`,
        retryFn: _runScan,
      });
    }
  } else {
    try {
      const ctx = await apiGet('/api/premiere/context', { timeoutMs: 5000 });
      await _postTurn('scan_completed', ctx);
    } catch (_) {
      appendMessage('agent-text', {
        text: 'I couldn\'t reach Premiere\'s project data. Make sure the panel is running inside Premiere Pro.',
      });
    }
  }
}

// ── Apply plan (ExtendScript dispatch) ────────────────────────

async function _dispatchEDL(payload) {
  const ops = payload.extendscript_ops || [];
  const seqName = payload.target_sequence_name || 'EditFlow Cut';

  _progressMsgId = appendMessage('progress', {
    label: 'Creating sequence in Premiere...',
    pct: 50,
    detail: 'Placing clips in Premiere...',
  });

  try {
    if (isExtendScriptAvailable()) {
      const result = await callExtendScript('processEDL', JSON.stringify({
        ops,
        sequence_name: seqName,
      }));

      // Validate individual op results — don't claim "Done" if ops failed
      const opResults = (result && result.results) || [];
      const failedOps = opResults.filter(r => r.success === false);

      // ── FIX-C: Surface trim diagnostics for add ops ─────────────
      // The JSX now returns a trim_diag object per 'add' op with before/after
      // tick values so we can prove whether the in/out trim actually stuck.
      const addOps = opResults.filter(r => r.action === 'add' && r.trim_diag);
      if (addOps.length > 0) {
        const trimLines = addOps.map((r, i) => {
          const d = r.trim_diag;
          if (!d.found) {
            return `  cut${i}: placed clip NOT found on track (trim skipped)`;
          }
          const inOK  = d.after_in_ticks  !== d.before_in_ticks;
          const outOK = d.after_out_ticks !== d.before_out_ticks;
          const inErr  = d.in_err  ? ` [err: ${d.in_err}]`  : '';
          const outErr = d.out_err ? ` [err: ${d.out_err}]` : '';
          return `  cut${i}: in ${inOK ? '\u2713' : '\u2717'} (${d.before_in_ticks}\u2192${d.after_in_ticks})${inErr}  out ${outOK ? '\u2713' : '\u2717'} (${d.before_out_ticks}\u2192${d.after_out_ticks})${outErr}`;
        }).join('\n');
        appendMessage('agent-text', { text: `Trim diagnostics:\n${trimLines}` });
      }

      if (failedOps.length > 0) {
        const failedSummary = failedOps
          .map(r => `${r.action || 'op'}:${r.error || 'unknown'}`)
          .join('; ');
        updateProgress(_progressMsgId, { pct: 100, detail: 'Some operations failed.' });
        appendMessage('error', {
          text: `Plan partially applied: ${failedOps.length} of ${opResults.length} operations failed. ${failedSummary}`,
          retryFn: () => _dispatchEDL(payload),
        });
        // Still notify the agent so it knows the result
        await _postTurn('extendscript_done', {
          sequence_name: seqName,
          partial_failure: true,
          failed_count: failedOps.length,
        });
      } else {
        updateProgress(_progressMsgId, { pct: 100, detail: 'Done.' });
        appendMessage('success', {
          text: `Done. "${seqName}" is in your Premiere project. Switch to Premiere to play it back.`,
          newEditFn: onNewEdit,
        });
        await _postTurn('extendscript_done', { sequence_name: seqName });
      }
    } else {
      appendMessage('agent-text', {
        text: `Plan applied. ${ops.length} ExtendScript ops generated. To execute, open the panel inside Premiere Pro.`,
      });
    }
  } catch (err) {
    appendMessage('error', {
      text: `Failed to execute plan: ${err.message}`,
      retryFn: () => _dispatchEDL(payload),
    });
  }
}

// ── Public API (mirrors orchestrator.js exports) ──────────────

async function onScanClicked() {
  const hero = $('#hero');
  const chatScroll = $('#chat-scroll');
  const footer = $('#app-footer');

  if (hero) hero.classList.add('hidden');
  if (chatScroll) chatScroll.classList.remove('hidden');
  if (footer) footer.classList.remove('hidden');

  appendMessage('agent-text', { text: 'Scanning your Premiere project...' });

  // Check backend first
  try {
    await apiGet('/api/ping', { timeoutMs: 3000 });
  } catch (_) {
    appendMessage('error', {
      text: 'Backend not reachable. Check that run.py is running.',
      retryFn: onScanClicked,
    });
    return;
  }

  await _postTurn('init', {});
}

async function onSourceProvided(source) {
  if (source.type === 'bin') {
    appendMessage('user-text', { text: `@bin:${source.path || source.name}` });
  } else if (source.type === 'clip') {
    appendMessage('user-text', { text: `@clip:${source.name}` });
  } else {
    appendMessage('user-text', { text: source.name || source.path || 'Dropped file(s)' });
  }

  await _postTurn('user_message', {
    text: `I want to work with ${source.type}: ${source.name || source.path}`,
    source,
  });
}

async function onPProItemsProvided(items) {
  const parts = [];
  const binNames = [];
  const clipNames = [];

  for (const item of items) {
    if (item.isBin || item.is_bin) {
      binNames.push(item.name);
    } else {
      clipNames.push(item.name);
    }
  }

  if (binNames.length > 0) parts.push(`@bin:${binNames.join(', @bin:')}`);
  if (clipNames.length > 0) parts.push(clipNames.length === 1 ? `@clip:${clipNames[0]}` : `${clipNames.length} clips`);
  appendMessage('user-text', { text: parts.join(' + ') });

  await _postTurn('user_message', {
    text: `I want to work with these items: ${parts.join(', ')}`,
    items,
  });
}

async function onMediaFileDropped(file) {
  appendMessage('user-text', { text: file.name });
  appendMessage('agent-text', {
    text: `I can't add raw files yet. Drag "${file.name}" into a bin inside Premiere first, then drop that bin onto this panel.`,
  });
}

async function onScriptFileDropped(file) {
  appendMessage('user-text', { text: `${file.name} — attached` });

  try {
    // Upload and extract the document
    const result = await uploadScript(file);
    const fullText = result.full_text || '';
    const filename = result.filename || file.name;
    const pageCount = result.page_count || 1;

    appendMessage('agent-text', {
      text: `I read ${pageCount} page${pageCount > 1 ? 's' : ''} from ${filename}.`,
    });

    // Post document_uploaded event with extracted text
    await _postTurn('document_uploaded', {
      file_id: filename,
      filename,
      full_text: fullText,
      page_count: pageCount,
    });
  } catch (err) {
    appendMessage('error', {
      text: `Failed to process document: ${err.message}`,
    });
  }
}

async function onUserMessage(text) {
  text = (text || '').trim();
  if (!text) return;

  // External-LLM paste workflow slash commands (same as orchestrator.js)
  if (/^\/(llm[-_ ]?prompt|prompt|llm)\b/i.test(text)) {
    appendMessage('user-text', { text });
    await _handleLlmPromptCommand();
    return;
  }
  if (/^\/(paste[-_ ]?plan|plan|apply[-_ ]?plan)\b/i.test(text)) {
    const body = text.replace(/^\/\S+\s*/, '');
    appendMessage('user-text', { text: '/paste-plan (json hidden)' });
    await _handlePastePlanCommand(body);
    return;
  }

  appendMessage('user-text', { text });
  await _postTurn('user_message', { text });
}

// ── External-LLM paste workflow slash commands ────────────────

function _collectBinReferences() {
  try {
    const state = getState();
    const sources = (state?.session?.sources) || [];
    // Replicate _sourceToReference logic: filter non-file sources, map to refs
    return sources
      .filter(s => s.type !== 'file')
      .map(s => `@${s.type}:${s.path || s.name}`);
  } catch (_) {
    return [];
  }
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

  const scriptText = (getState()?.session?.scriptText || '').trim();
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

  const scriptText = (getState()?.session?.scriptText || '').trim();
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
  const cuts = resp.cuts_count || 0;
  const dur = (resp.summary || {}).total_duration || 0;
  updateProgress(msgId, { pct: 100, detail: 'Plan stored.' });

  appendMessage('agent-text', {
    text: `Plan ${planId} ingested: ${cuts} cut(s), ${dur.toFixed(1)}s total. Notifying the agent...`,
  });

  // Tell the agent about the pasted plan so it can continue the conversation.
  await _postTurn('tool_user_response', {
    action: 'plan_pasted',
    plan_id: planId,
  });
}

async function onApprovePlan() {
  appendMessage('user-text', { text: 'Build sequence' });
  await _postTurn('tool_user_response', { action: 'approve_plan' });
}

async function onRegeneratePlan(hint) {
  appendMessage('user-text', { text: `Regenerate: ${hint || 'with different approach'}` });
  await _postTurn('tool_user_response', { action: 'regenerate', hint: hint || '' });
}

function onNewEdit() {
  clearChat();
  // Reset the agent session
  apiPost('/api/agent/reset', {
    session_id: SESSION_ID,
  }).catch(() => {});

  const hero = $('#hero');
  const chatScroll = $('#chat-scroll');
  const footer = $('#app-footer');

  if (hero) hero.classList.remove('hidden');
  if (chatScroll) chatScroll.classList.add('hidden');
  if (footer) footer.classList.add('hidden');
}

function onWsProgress(payload) {
  if (!payload) return;
  const msgType = payload.type || payload.task_type || '';

  // Handle agent_tool WS events
  if (msgType === 'agent_tool' || payload.tool) {
    const tool = payload.tool;
    const status = payload.status;

    if (status === 'started' && tool === 'transcribe_clips') {
      _progressMsgId = appendMessage('progress', {
        label: `Transcribing ${payload.total || '?'} clip(s)...`,
        pct: 0,
        detail: 'Starting...',
      });
    } else if (status === 'clip_done' && _progressMsgId) {
      const idx = payload.index || 0;
      const total = payload.total || 1;
      updateProgress(_progressMsgId, {
        pct: Math.round((idx / total) * 100),
        detail: `Clip ${idx} of ${total} complete`,
      });
    } else if (status === 'completed' && _progressMsgId) {
      updateProgress(_progressMsgId, {
        pct: 100,
        detail: 'Transcription complete.',
      });
    }
    return;
  }

  // Handle regular progress events (from Whisper)
  if (/transcribe/i.test(msgType) && _progressMsgId) {
    const innerPct = Math.max(0, Math.min(1, Number(payload.progress) || 0));
    updateProgress(_progressMsgId, {
      detail: `Transcribing... ${Math.round(innerPct * 100)}%`,
    });
  }
}

export {
  onScanClicked,
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
