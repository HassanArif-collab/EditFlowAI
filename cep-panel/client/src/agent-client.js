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

const $ = (sel) => document.querySelector(sel);

// ── Session ID (persists across turns) ────────────────────────
const SESSION_ID = 'cep-agent-' + Math.random().toString(36).substring(2, 10);
const CLIENT_ID = SESSION_ID; // reuse as WS client_id

// ── Progress tracking ─────────────────────────────────────────
let _progressMsgId = null;

// ── Core: post a turn to the agent ────────────────────────────

async function _postTurn(event, payload = {}) {
  try {
    const resp = await apiPost('/api/agent/turn', {
      session_id: SESSION_ID,
      event,
      payload,
      client_id: CLIENT_ID,
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
      await callExtendScript('processEDL', JSON.stringify({ ops }));
      updateProgress(_progressMsgId, { pct: 100, detail: 'Done.' });
      appendMessage('success', {
        text: `Done. "${seqName}" is in your Premiere project. Switch to Premiere to play it back.`,
        newEditFn: onNewEdit,
      });
      // Notify the agent
      await _postTurn('extendscript_done', { sequence_name: seqName });
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
  appendMessage('user-text', { text });
  await _postTurn('user_message', { text });
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
