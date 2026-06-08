/**
 * chat-ui.js — One renderer per message kind for the EditFlow chat surface.
 *
 * Exports: appendMessage(kind, payload), updateProgress(id, payload),
 *          clearChat(), scrollToBottom().
 *
 * Message kinds:
 *   agent-text, user-text, error, bin-summary-card, progress,
 *   plan-card, extract-card, success, transcript-summary-card,
 *   ask-card, tool-running-card, prompt-box
 */

const $ = (sel) => document.querySelector(sel);
let msgCounter = 0;

/**
 * Append a message to the chat scroll area.
 * @param {string} kind - Message kind (see list above)
 * @param {object} payload - Kind-specific data
 * @returns {string} The message DOM id
 */
function appendMessage(kind, payload) {
  const scroll = $('#chat-scroll');
  if (!scroll) return null;

  const id = `msg-${++msgCounter}`;
  const el = document.createElement('div');
  el.id = id;

  switch (kind) {
    case 'agent-text':
      el.className = 'msg msg-agent';
      el.innerHTML = `<div class="msg-label">EditFlow</div><div class="msg-body">${_escapeHtml(payload.text)}</div>`;
      break;

    case 'user-text':
      el.className = 'msg msg-user';
      el.innerHTML = `<div class="msg-label">You</div><div class="msg-body">${_escapeHtml(payload.text)}</div>`;
      break;

    case 'error':
      el.className = 'msg msg-error';
      el.innerHTML = `<div class="msg-label">Error</div><div class="msg-body">${_escapeHtml(payload.text)}</div>`;
      if (payload.retryFn) {
        const btn = document.createElement('button');
        btn.className = 'btn-retry';
        btn.textContent = 'Retry';
        btn.addEventListener('click', () => payload.retryFn());
        el.appendChild(btn);
      }
      if (payload.dismissFn) {
        const btn = document.createElement('button');
        btn.className = 'btn-retry';
        btn.textContent = 'Dismiss';
        btn.style.marginLeft = '6px';
        btn.addEventListener('click', () => { el.remove(); payload.dismissFn(); });
        el.appendChild(btn);
      }
      break;

    case 'bin-summary-card':
      el.className = 'msg msg-agent';
      el.innerHTML = `<div class="msg-label">EditFlow</div>` +
        `<div class="msg-body">${_escapeHtml(payload.intro || '')}</div>` +
        _renderBinCard(payload.bins || []);
      // Bind bin-row click handlers
      setTimeout(() => _bindBinRowClicks(el, payload), 0);
      break;

    case 'progress':
      el.className = 'msg msg-agent';
      el.dataset.progressId = payload.id || id;
      el.innerHTML = `<div class="msg-label">EditFlow</div>` +
        `<div class="msg-body">${_escapeHtml(payload.label || 'Working...')}</div>` +
        `<div class="progress-wrap">` +
          `<div class="progress-bar-bg"><div class="progress-bar-fill" style="width: ${payload.pct || 0}%"></div></div>` +
          `<div class="progress-label">${_escapeHtml(payload.detail || '')}</div>` +
        `</div>`;
      break;

    case 'plan-card':
      el.className = 'msg msg-agent';
      el.innerHTML = `<div class="msg-label">EditFlow</div>` +
        _renderPlanCard(payload);
      setTimeout(() => _bindPlanActions(el, payload), 0);
      break;

    case 'extract-card':
      el.className = 'msg msg-agent';
      el.innerHTML = `<div class="msg-label">EditFlow</div>` +
        `<div class="msg-body">${_escapeHtml(payload.intro || '')}</div>` +
        _renderExtractCard(payload);
      setTimeout(() => _bindExtractActions(el, payload), 0);
      break;

    case 'transcript-summary-card':
      el.className = 'msg msg-agent';
      el.innerHTML = `<div class="msg-label">EditFlow</div>` +
        `<div class="msg-body">${_escapeHtml(payload.intro || 'Transcripts ready:')}</div>` +
        _renderTranscriptSummaryCard(payload);
      break;

    case 'ask-card':
      el.className = 'msg msg-agent';
      el.innerHTML = `<div class="msg-label">EditFlow</div>` +
        `<div class="msg-body">${_escapeHtml(payload.question || '')}</div>` +
        _renderAskCard(payload);
      setTimeout(() => _bindAskActions(el, payload), 0);
      break;

    case 'tool-running-card':
      el.className = 'msg msg-agent';
      el.innerHTML = `<div class="msg-label">EditFlow</div>` +
        `<div class="msg-body">${_escapeHtml(payload.label || 'Running tool...')} <span class="tool-spinner">&#8987;</span></div>`;
      break;

    case 'success':
      el.className = 'msg msg-agent';
      el.innerHTML = `<div class="msg-label">EditFlow</div>` +
        `<div class="msg-body">${_escapeHtml(payload.text)}</div>`;
      if (payload.newEditFn) {
        const btn = document.createElement('button');
        btn.className = 'btn-new-edit';
        btn.textContent = 'Start a new edit';
        btn.addEventListener('click', () => payload.newEditFn());
        el.appendChild(btn);
      }
      break;

    case 'prompt-box':
      el.className = 'msg msg-agent';
      el.innerHTML = `<div class="msg-label">EditFlow</div>` +
        `<div class="prompt-box">` +
        `<div class="prompt-box-header">LLM Prompt — copy this into Claude / ChatGPT / Gemini</div>` +
        `<textarea class="prompt-box-textarea" readonly spellcheck="false"></textarea>` +
        `<div class="prompt-box-actions"><button class="prompt-box-copy">Copy to clipboard</button></div>` +
        (payload.prompt_path ? `<div class="prompt-box-footer">Also saved to: ${_escapeHtml(payload.prompt_path)}</div>` : '') +
        `</div>`;
      setTimeout(() => _bindPromptBox(el, payload), 0);
      break;

    default:
      el.className = 'msg msg-agent';
      el.innerHTML = `<div class="msg-label">EditFlow</div><div class="msg-body">${_escapeHtml(payload.text || JSON.stringify(payload))}</div>`;
  }

  scroll.appendChild(el);
  scrollToBottom();
  return id;
}

/**
 * Update a progress message in-place.
 */
function updateProgress(msgId, { pct, label, detail }) {
  const el = msgId ? document.getElementById(msgId) : null;
  if (!el) return;

  const fill = el.querySelector('.progress-bar-fill');
  if (fill && pct !== undefined) {
    fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  }

  const labelEl = el.querySelector('.progress-label');
  if (labelEl && detail !== undefined) {
    labelEl.textContent = detail;
  }

  // Update the main label text if provided
  if (label !== undefined) {
    const body = el.querySelector('.msg-body');
    if (body) body.textContent = label;
  }
}

/**
 * Clear all messages and reset counter.
 */
function clearChat() {
  const scroll = $('#chat-scroll');
  if (scroll) scroll.innerHTML = '';
  msgCounter = 0;
}

/**
 * Scroll chat to bottom.
 */
function scrollToBottom() {
  const scroll = $('#chat-scroll');
  if (scroll) {
    requestAnimationFrame(() => {
      scroll.scrollTop = scroll.scrollHeight;
    });
  }
}

// ── Private helpers ──────────────────────────────────────────
function _escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _renderBinCard(bins) {
  if (!bins.length) return '<div class="bin-card"><div style="padding:8px 12px;color:var(--text-dim)">No bins found</div></div>';
  return '<div class="bin-card">' +
    bins.map(b => {
      const icon = b.hasAudio ? '&#127908;' : '&#127909;';
      return `<div class="bin-row" data-bin-name="${_escapeHtml(b.name)}" data-bin-path="${_escapeHtml(b.binPath || b.path || '')}">` +
        `<span class="bin-icon">${icon}</span>` +
        `<span class="bin-name">${_escapeHtml(b.name)}</span>` +
        `<span class="bin-desc">${_escapeHtml(b.desc || '')}</span>` +
      `</div>`;
    }).join('') +
  '</div>';
}

function _bindBinRowClicks(el, payload) {
  const rows = el.querySelectorAll('.bin-row');
  rows.forEach(row => {
    row.addEventListener('click', () => {
      const binName = row.dataset.binName;
      const binPath = row.dataset.binPath;
      if (payload.onBinClick) {
        payload.onBinClick(binName, binPath);
      }
    });
  });
}

function _renderPlanCard(payload) {
  const plan = payload.plan || {};
  const beats = plan.beats || [];
  const totalCuts = beats.length;
  const totalDuration = plan.totalDuration || payload.totalDuration || 0;
  const unmatched = plan.unmatched || 0;

  let html = `<div class="msg-body">${_escapeHtml(payload.intro || 'I built a plan:')}</div>`;
  html += '<div class="plan-card">';
  html += `<div class="plan-summary">` +
    `<span class="plan-stat"><strong>${totalCuts}</strong> cuts</span>` +
    `<span class="plan-stat"><strong>${_formatDuration(totalDuration)}</strong> total</span>`;
  if (unmatched > 0) {
    html += `<span class="plan-stat" style="color:var(--error)"><strong>${unmatched}</strong> unmatched</span>`;
  }
  html += `</div>`;

  if (beats.length > 0) {
    html += '<div class="plan-beats">';
    beats.forEach((beat, i) => {
      if (beat.unmatched) {
        html += `<div class="plan-beat plan-warning">&#9888; Beat ${i + 1} — no good match found</div>`;
      } else {
        html += `<div class="plan-beat">` +
          `<span class="beat-num">${i + 1}.</span> ` +
          `"<span class="beat-clip">${_escapeHtml(beat.text || '')}</span>" — ` +
          `<span class="beat-clip">${_escapeHtml(beat.clipName || '')}</span> ` +
          `<span class="beat-time">@ ${_formatTime(beat.start)} &rarr; ${_formatTime(beat.end)}</span> ` +
          `<span class="beat-dur">(${_formatDuration(beat.duration)})</span>` +
        `</div>`;
      }
    });
    html += '</div>';
  }

  html += `<div class="plan-actions" data-plan-id="${_escapeHtml(payload.planId || '')}">`;
  html += `<button class="btn-approve" data-action="approve">Build sequence</button>`;
  html += `<button class="btn-regenerate" data-action="regenerate">Regenerate with a hint</button>`;
  html += `</div>`;
  html += '</div>';
  return html;
}

function _bindPlanActions(el, payload) {
  const approveBtn = el.querySelector('[data-action="approve"]');
  const regenBtn = el.querySelector('[data-action="regenerate"]');

  if (approveBtn && payload.onApprove) {
    approveBtn.addEventListener('click', () => payload.onApprove());
  }

  if (regenBtn && payload.onRegenerate) {
    regenBtn.addEventListener('click', () => {
      // Toggle inline hint textarea
      const actionsDiv = el.querySelector('.plan-actions');
      if (el.querySelector('.regenerate-hint')) {
        el.querySelector('.regenerate-hint').remove();
        return;
      }
      const ta = document.createElement('textarea');
      ta.className = 'regenerate-hint';
      ta.placeholder = 'e.g. Avoid takes from the first 5 minutes...';
      const submitBtn = document.createElement('button');
      submitBtn.className = 'btn-regenerate';
      submitBtn.textContent = 'Submit hint';
      submitBtn.style.marginTop = '4px';
      submitBtn.addEventListener('click', () => {
        const hint = ta.value.trim();
        if (payload.onRegenerate) payload.onRegenerate(hint);
      });
      actionsDiv.appendChild(ta);
      actionsDiv.appendChild(submitBtn);
      ta.focus();
    });
  }
}

function _renderExtractCard(payload) {
  let html = '<div class="extract-card">';
  html += `<div class="extract-excerpt">${_escapeHtml(payload.excerpt || '')}</div>`;
  html += `<div class="extract-actions">`;
  html += `<button class="btn-confirm" data-action="confirm">Yes, use this</button>`;
  html += `<button class="btn-reject" data-action="reject">Pick a different part</button>`;
  html += `</div></div>`;
  return html;
}

function _bindExtractActions(el, payload) {
  const confirmBtn = el.querySelector('[data-action="confirm"]');
  const rejectBtn = el.querySelector('[data-action="reject"]');

  if (confirmBtn && payload.onConfirm) {
    confirmBtn.addEventListener('click', () => payload.onConfirm());
  }
  if (rejectBtn && payload.onReject) {
    rejectBtn.addEventListener('click', () => payload.onReject());
  }
}

function _formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function _formatTime(seconds) {
  if (!seconds && seconds !== 0) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function _renderTranscriptSummaryCard(payload) {
  const clips = payload.clips || [];
  if (!clips.length) return '<div class="bin-card"><div style="padding:8px 12px;color:var(--text-dim)">No transcripts available</div></div>';
  return '<div class="bin-card">' +
    clips.map(c => {
      const name = _escapeHtml(c.name || c.path || 'unknown');
      const dur = c.duration ? ` (${_formatDuration(c.duration)})` : '';
      const lang = c.language ? ` [${_escapeHtml(c.language)}]` : '';
      return `<div class="bin-row">` +
        `<span class="bin-icon">&#127898;</span>` +
        `<span class="bin-name">${name}</span>` +
        `<span class="bin-desc">${dur}${lang}</span>` +
      `</div>`;
    }).join('') +
  '</div>';
}

function _renderAskCard(payload) {
  const options = payload.options || [];
  let html = '<div class="ask-card">';
  for (const opt of options) {
    const label = _escapeHtml(opt.label || opt.value || '?');
    const value = _escapeHtml(opt.value || opt.label || '');
    html += `<button class="btn-approve ask-option-btn" data-option-value="${value}">${label}</button>`;
  }
  html += '</div>';
  return html;
}

function _bindAskActions(el, payload) {
  const buttons = el.querySelectorAll('.ask-option-btn');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const value = btn.dataset.optionValue;
      if (payload.onOptionClick) {
        payload.onOptionClick(value);
      }
    });
  });
}

function _bindPromptBox(el, payload) {
  const textarea = el.querySelector('.prompt-box-textarea');
  const copyBtn = el.querySelector('.prompt-box-copy');
  if (textarea && payload.prompt) {
    textarea.value = payload.prompt;
    // Auto-size to content, capped at 400px
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 400) + 'px';
  }
  if (copyBtn && payload.prompt) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(payload.prompt);
        copyBtn.textContent = 'Copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.textContent = 'Copy to clipboard';
          copyBtn.classList.remove('copied');
        }, 2000);
      } catch (_) {
        // Fallback: select the textarea text
        if (textarea) {
          textarea.select();
          textarea.setSelectionRange(0, textarea.value.length);
        }
      }
    });
  }
}

export { appendMessage, updateProgress, clearChat, scrollToBottom };
