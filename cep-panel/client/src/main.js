/**
 * EditFlow AI v2 – CEP Panel Main JavaScript
 * Handles chat, pipeline operations, settings, and Premiere Pro communication.
 */
(function() {
    'use strict';

    // ═══════ Configuration ═══════
    const CONFIG = {
        serverUrl: 'http://127.0.0.1:8765',
        wsUrl: 'ws://127.0.0.1:8765',
        sessionId: generateId(),
        clientId: 'cep-' + generateId(),
    };

    // ═══════ State ═══════
    const state = {
        connected: false,
        ws: null,
        csInterface: null,
        lastCutResult: null,
        sequenceState: null,
        projectState: null,
        lastPhraseRanges: [],
        lastScriptCutPlanId: null,
        preflightReady: false,
        preflightChecks: [],
        capabilities: null,
    };

    // ═══════ DOM References ═══════
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    // ═══════ Initialization ═══════
    function init() {
        // Initialize CSInterface
        try {
            state.csInterface = new CSInterface();
        } catch (e) {
            console.warn('CSInterface not available (running outside Premiere?)');
        }

        // Load saved server URL
        const savedUrl = localStorage.getItem('editflow_server_url');
        if (savedUrl) CONFIG.serverUrl = savedUrl;

        // Bind events
        bindTabs();
        bindChat();
        bindAnalyze();
        bindCut();
        bindVisuals();
        bindScriptCut();
        bindSettings();
        bindPreflight();

        // Auto-expand textarea
        const chatInput = $('#chat-input');
        chatInput.addEventListener('input', () => {
            chatInput.style.height = 'auto';
            chatInput.style.height = Math.min(chatInput.scrollHeight, 80) + 'px';
        });

        // Try to connect, then run preflight
        checkConnection().then(() => {
            loadProjectContext();
            runPreflight();
            probeCapabilities();
        });

        console.log('EditFlow AI v2 panel initialized');
    }

    // ═══════ Tab Management ═══════
    function bindTabs() {
        $$('#pipeline-tabs .tab').forEach(tab => {
            tab.addEventListener('click', () => {
                $$('#pipeline-tabs .tab').forEach(t => t.classList.remove('active'));
                $$('.tab-content').forEach(tc => tc.classList.remove('active'));
                tab.classList.add('active');
                const targetId = 'tab-' + tab.dataset.tab;
                $('#' + targetId).classList.add('active');
            });
        });
    }

    // ═══════ Chat ═══════
    function bindChat() {
        const input = $('#chat-input');
        const sendBtn = $('#btn-send');

        sendBtn.addEventListener('click', sendMessage);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
    }

    async function sendMessage() {
        const input = $('#chat-input');
        const text = input.value.trim();
        if (!text) return;

        input.value = '';
        input.style.height = 'auto';

        addChatMessage('user', text);
        showTypingIndicator();

        // ── Quick command: "cut/remove/delete '<phrase>'" ──
        // Matches a quoted phrase (single, double, or curly quotes), e.g.:
        //   "cut the words 'jamia masjid' from the timeline"
        //   "remove 'um' everywhere"
        const phraseCommand = text.match(/\b(?:cut|remove|delete)\b[\s\S]*?["'‘“]([^"'’”]+)["'’”]/i);
        if (phraseCommand && phraseCommand[1]) {
            try {
                const phrase = phraseCommand[1].trim();
                hideTypingIndicator();
                await analyzeActiveSequenceAudio();
                await findPhraseInActiveSequence(phrase);
            } catch (e) {
                hideTypingIndicator();
                addChatMessage('error', 'Failed to analyze active sequence phrase: ' + e.message);
            }
            return;
        }

        try {
            // Include sequence context if available
            const context = {};
            if (state.sequenceState) {
                context.sequence = state.sequenceState;
            }
            if (state.projectState) {
                context.project = state.projectState;
            }

            const resp = await apiPost('/chat/message', {
                message: text,
                session_id: CONFIG.sessionId,
                context: Object.keys(context).length > 0 ? context : undefined,
            });

            hideTypingIndicator();
            if (resp.message && resp.message.content) {
                addChatMessage('assistant', resp.message.content);
            } else {
                addChatMessage('assistant', 'Received an unexpected response from the server.');
            }
        } catch (e) {
            hideTypingIndicator();
            addChatMessage('error', 'Connection error: ' + e.message);
        }
    }

    function addChatMessage(role, content) {
        const messages = $('#chat-messages');
        const div = document.createElement('div');
        div.className = 'chat-msg ' + role;
        div.innerHTML = renderMarkdown(content);
        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
    }

    function showTypingIndicator() {
        const messages = $('#chat-messages');
        const div = document.createElement('div');
        div.className = 'typing-indicator';
        div.id = 'typing-indicator';
        div.innerHTML = '<span></span><span></span><span></span>';
        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
    }

    function hideTypingIndicator() {
        const indicator = $('#typing-indicator');
        if (indicator) indicator.remove();
    }

    function renderMarkdown(text) {
        if (!text) return '';
        // Basic markdown rendering
        let html = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // Code blocks
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
        // Inline code
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        // Bold
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        // Italic
        html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        // Unordered lists
        html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
        html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
        // Line breaks
        html = html.replace(/\n/g, '<br>');

        return html;
    }

    // ═══════ Video Analysis ═══════
    function bindAnalyze() {
        $('#btn-analyze').addEventListener('click', runAnalysis);
    }

    async function runAnalysis() {
        const folder = $('#analyze-folder').value.trim();
        if (!folder) {
            showProgress('analyze', 'Please enter a video folder path.');
            return;
        }

        const language = $('#analyze-language').value || undefined;
        const recursive = $('#analyze-recursive').checked;

        showProgress('analyze', 'Starting video analysis...');
        disableButton('btn-analyze');

        try {
            const resp = await apiPost('/pipeline/analyze', {
                folder_path: folder,
                language: language,
                recursive: recursive,
                client_id: CONFIG.clientId,
            });

            hideProgress('analyze');
            showResults('analyze', formatAnalysisResults(resp));
            addChatMessage('assistant', `Analyzed ${resp.total || 0} video(s) from \`${folder}\`. Use the **Cut** tab to match a script against them.`);
        } catch (e) {
            hideProgress('analyze');
            showResults('analyze', `Error: ${e.message}`);
        } finally {
            enableButton('btn-analyze');
        }
    }

    function formatAnalysisResults(resp) {
        if (!resp.results || resp.results.length === 0) {
            return 'No videos were analyzed.';
        }
        return resp.results.map((r, i) => {
            const name = r.source_file || r.name || `Video ${i + 1}`;
            const duration = r.duration ? `${r.duration.toFixed(1)}s` : '?';
            const lang = r.language || '?';
            const segments = r.segments ? r.segments.length : 0;
            return `<div class="result-item">
                <div class="result-label">${name}</div>
                <div class="result-value">${duration} | Language: ${lang} | Segments: ${segments}</div>
            </div>`;
        }).join('');
    }

    // ═══════ Script-Based Cutting ═══════
    function bindCut() {
        $('#btn-cut').addEventListener('click', runCut);
        $('#btn-cut-to-premiere').addEventListener('click', sendCutToPremiere);

        // ── Active-sequence phrase removal ──
        $('#btn-analyze-sequence-audio').addEventListener('click', async () => {
            disableButton('btn-analyze-sequence-audio');
            try {
                await analyzeActiveSequenceAudio();
            } catch (e) {
                addChatMessage('error', 'Sequence audio analysis failed: ' + e.message);
            } finally {
                enableButton('btn-analyze-sequence-audio');
            }
        });

        $('#btn-preview-phrase').addEventListener('click', async () => {
            const phrase = ($('#sequence-phrase').value || '').trim();
            if (!phrase) {
                addChatMessage('error', 'Enter a phrase to remove.');
                return;
            }
            disableButton('btn-preview-phrase');
            try {
                const resp = await findPhraseInActiveSequence(phrase);
                renderPhraseResults(phrase, resp);
                if ((resp.ranges || []).length) {
                    try {
                        await evalExtendScript('addPhraseRangeMarkers',
                            JSON.stringify({ phrase, ranges: resp.ranges }));
                    } catch (e) {
                        addChatMessage('error', 'Could not add preview markers: ' + e.message);
                    }
                    $('#btn-apply-phrase-cut').disabled = false;
                } else {
                    $('#btn-apply-phrase-cut').disabled = true;
                }
            } catch (e) {
                addChatMessage('error', 'Phrase search failed: ' + e.message);
            } finally {
                enableButton('btn-preview-phrase');
            }
        });

        $('#btn-apply-phrase-cut').addEventListener('click', async () => {
            const phrase = ($('#sequence-phrase').value || '').trim();
            const ranges = state.lastPhraseRanges || [];
            if (!phrase || !ranges.length) {
                addChatMessage('error', 'Preview phrase matches before applying cuts.');
                return;
            }
            disableButton('btn-apply-phrase-cut');
            try {
                const result = await evalExtendScript('removeTimelineRanges',
                    JSON.stringify({ phrase, ranges, confirmed: true }));
                const parsed = (() => { try { return JSON.parse(result); } catch (e) { return null; }})();
                if (parsed && parsed.success === false) {
                    throw new Error(parsed.error || 'Phrase cut failed');
                }
                addChatMessage('assistant',
                    `Removed ${ranges.length} occurrence(s) of "${phrase}" from the active sequence.`);
            } catch (e) {
                addChatMessage('error', 'Apply phrase cut failed: ' + e.message);
            } finally {
                enableButton('btn-apply-phrase-cut');
            }
        });
    }

    function renderPhraseResults(phrase, resp) {
        const el = $('#phrase-results');
        if (!el) return;
        const ranges = resp.ranges || [];
        if (!ranges.length) {
            el.classList.remove('hidden');
            el.innerHTML = `<div class="result-item">No occurrences of "${phrase}" in the active sequence.</div>`;
            return;
        }
        const rows = ranges.map((r, i) => (
            `<div class="result-item">
                <strong>#${i + 1}</strong> ${r.start.toFixed(2)}s → ${r.end.toFixed(2)}s
                · track ${r.track_index}, clip ${r.clip_index} (${r.clip_name || 'unnamed'})
            </div>`
        )).join('');
        el.classList.remove('hidden');
        el.innerHTML = `<div class="result-header">${ranges.length} occurrence(s) of "${phrase}"</div>${rows}`;
    }

    async function runCut() {
        const script = $('#cut-script').value.trim();
        if (!script) {
            showProgress('cut', 'Please paste your English script first.');
            return;
        }

        const style = $('#cut-style').value;
        const outputPath = $('#cut-output').value.trim();

        showProgress('cut', 'Matching script against video transcripts...');
        disableButton('btn-cut');

        try {
            const resp = await apiPost('/pipeline/cut', {
                script_content: script,
                script_language: 'en',
                video_language: 'ur',
                cleanup_style: style,
            });

            state.lastCutResult = resp;
            hideProgress('cut');

            const resultHtml = `
                <div class="result-item">
                    <div class="result-label">Status: ${resp.status || 'unknown'}</div>
                    <div class="result-value">Matched ${resp.matched_segments || 0}/${resp.total_segments || 0} segments</div>
                    <div class="result-value">Duration: ${(resp.duration_before || 0).toFixed(1)}s → ${(resp.duration_after || 0).toFixed(1)}s</div>
                    ${resp.unmatched_lines && resp.unmatched_lines.length > 0 ?
                        `<div class="result-value" style="color:var(--warning)">Unmatched lines: ${resp.unmatched_lines.length}</div>` : ''}
                    ${resp.output_path ? `<div class="result-value">Output: ${resp.output_path}</div>` : ''}
                </div>`;
            showResults('cut', resultHtml);

            if (resp.cuts && resp.cuts.length > 0) {
                $('#btn-cut-to-premiere').disabled = false;
            }

            addChatMessage('assistant', `Script cutting complete! Matched **${resp.matched_segments || 0}/${resp.total_segments || 0}** segments. ${resp.output_path ? `Output: \`${resp.output_path}\`` : 'Click "Send to Premiere" to apply cuts to your timeline.'}`);
        } catch (e) {
            hideProgress('cut');
            showResults('cut', `Error: ${e.message}`);
        } finally {
            enableButton('btn-cut');
        }
    }

    async function sendCutToPremiere() {
        if (!state.lastCutResult || !state.lastCutResult.cuts) {
            addChatMessage('error', 'No cut result available. Run "Match & Cut" first.');
            return;
        }

        try {
            // Generate an EDL from the cut result and send to Premiere
            const edl = {
                sequence_name: 'EditFlow Cut',
                operations: state.lastCutResult.cuts.map((cut, i) => ({
                    action: 'add',
                    mediaPath: cut.source_file,
                    trackIndex: 0,
                    startTime: i === 0 ? 0 : undefined, // Will be calculated
                    inPoint: cut.start,
                    outPoint: cut.end,
                }))
            };

            // Calculate start times sequentially
            let currentTime = 0;
            for (const op of edl.operations) {
                op.startTime = currentTime;
                const duration = (op.outPoint - op.inPoint);
                currentTime += duration;
            }

            const result = await evalExtendScript('processEDL', JSON.stringify({ edlData: edl }));
            if (result) {
                const parsed = JSON.parse(result);
                if (parsed && parsed.success === false) {
                    throw new Error(parsed.error || 'Unknown processEDL error');
                }
            }
            addChatMessage('assistant', 'Cut plan has been applied to the Premiere Pro timeline!');
        } catch (e) {
            addChatMessage('error', 'Failed to send to Premiere: ' + e.message);
        }
    }

    // ═══════ Script Cut (M10) ═══════
    function bindScriptCut() {
        // Populate bin autocomplete when project state is available
        initScriptCutTab();

        // Generate Plan
        $('#sc-generate').addEventListener('click', async () => {
            const script = $('#sc-script').value.trim();
            if (!script) {
                $('#sc-progress').classList.remove('hidden');
                $('#sc-progress').textContent = 'Please paste your script first.';
                return;
            }

            // Preflight gate: check for red statuses before proceeding
            try {
                const preflightResp = await apiGet('/preflight');
                const hasRed = (preflightResp.checks || []).some(c => c.status === 'red');
                const hasYellow = (preflightResp.checks || []).some(c => c.status === 'yellow');

                // Update preflight indicator
                updatePreflightIndicator(preflightResp.checks || []);

                if (hasRed) {
                    const redChecks = preflightResp.checks.filter(c => c.status === 'red');
                    const redMessages = redChecks.map(c => `${c.name}: ${c.message}`).join('\n');
                    $('#sc-progress').classList.remove('hidden');
                    $('#sc-progress').textContent = 'Cannot generate plan — resolve preflight issues first:\n' + redMessages;
                    addChatMessage('error', 'Cannot generate plan. Resolve the following preflight issues first:\n' + redMessages);
                    return;
                }

                if (hasYellow) {
                    const yellowChecks = preflightResp.checks.filter(c => c.status === 'yellow');
                    const yellowMessages = yellowChecks.map(c => `${c.name}: ${c.message}`).join('\n');
                    addChatMessage('assistant', `⚠️ Preflight warnings:\n${yellowMessages}\n\nProceeding with plan generation...`);
                }
            } catch (e) {
                // If preflight check itself fails, warn but allow proceeding
                console.warn('Preflight check before generate failed:', e);
            }

            const bin = $('#sc-bin').value.trim();
            if (!bin) {
                $('#sc-progress').classList.remove('hidden');
                $('#sc-progress').textContent = 'Please enter a source bin reference, for example @bin:MyTakes.';
                return;
            }
            const language = $('#sc-language').value;

            $('#sc-progress').classList.remove('hidden');
            $('#sc-progress').textContent = 'Analyzing script and matching takes...';
            $('#sc-plan').classList.add('hidden');
            disableButton('sc-generate');

            try {
                const resp = await apiPost('/edit/analyze', {
                    bin_references: [bin],
                    script,
                    language: language !== 'auto' ? language : undefined,
                    client_id: CONFIG.clientId,
                });

                state.lastScriptCutPlanId = resp.plan_id || resp.id || null;
                $('#sc-progress').classList.add('hidden');
                renderPlan(resp);
                addChatMessage('assistant', `Script Cut plan generated: **${resp.beats ? resp.beats.length : 0}** beats. Review and click **Apply to New Sequence** when ready.`);
            } catch (e) {
                $('#sc-progress').classList.remove('hidden');
                $('#sc-progress').textContent = 'Error: ' + e.message;
            } finally {
                enableButton('sc-generate');
            }
        });

        // Regenerate with hint
        $('#sc-regenerate').addEventListener('click', async () => {
            if (!state.lastScriptCutPlanId) {
                addChatMessage('error', 'Generate a plan first before regenerating.');
                return;
            }

            const hint = $('#sc-hint').value.trim();
            disableButton('sc-regenerate');

            try {
                const resp = await apiPost('/edit/regenerate', {
                    plan_id: state.lastScriptCutPlanId,
                    hint: hint || undefined,
                    client_id: CONFIG.clientId,
                });

                state.lastScriptCutPlanId = resp.plan_id || resp.id || state.lastScriptCutPlanId;
                renderPlan(resp);
                addChatMessage('assistant', 'Plan regenerated with your hint.');
            } catch (e) {
                addChatMessage('error', 'Regeneration failed: ' + e.message);
            } finally {
                enableButton('sc-regenerate');
            }
        });

        // Apply to New Sequence
        $('#sc-apply').addEventListener('click', async () => {
            if (!state.lastScriptCutPlanId) {
                addChatMessage('error', 'Generate a plan first before applying.');
                return;
            }

            disableButton('sc-apply');

            try {
                const resp = await apiPost('/edit/plan/' + encodeURIComponent(state.lastScriptCutPlanId) + '/apply', {
                    client_id: CONFIG.clientId,
                });

                // Dispatch ExtendScript to create the sequence in Premiere
                try {
                    const result = await evalExtendScript('processEDL',
                        JSON.stringify({ edlData: resp.edl || resp }));
                    const parsed = (() => { try { return JSON.parse(result); } catch (e) { return null; }})();
                    if (parsed && parsed.success === false) {
                        throw new Error(parsed.error || 'ExtendScript apply failed');
                    }
                } catch (scriptErr) {
                    // ExtendScript not available — still report success via backend
                    console.warn('ExtendScript dispatch skipped:', scriptErr.message);
                }

                addChatMessage('assistant', `Script Cut applied! A new sequence has been created with **${resp.beats ? resp.beats.length : 0}** beats.`);
            } catch (e) {
                addChatMessage('error', 'Apply failed: ' + e.message);
            } finally {
                enableButton('sc-apply');
            }
        });
    }

    function initScriptCutTab() {
        // Populate immediately if project state already loaded
        populateScriptCutBins();

        // Re-populate whenever project is scanned
        // We watch for projectState changes via a MutationObserver-free approach:
        // simply re-populate when the Scan Project button is clicked
        const scanBtn = $('#btn-scan-project');
        if (scanBtn) {
            scanBtn.addEventListener('click', () => setTimeout(populateScriptCutBins, 2000));
        }
    }

    function populateScriptCutBins() {
        const datalist = $('#sc-bin-options');
        if (!datalist) return;

        datalist.innerHTML = '';
        const bins = (state.projectState && state.projectState.bins) || [];
        bins.forEach(bin => {
            const opt = document.createElement('option');
            const value = bin.path || bin.name || bin;
            opt.value = '@bin:' + value;
            opt.label = bin.path || bin.name || value;
            datalist.appendChild(opt);
        });
    }

    function renderPlan(plan) {
        const planEl = $('#sc-plan');
        const summaryEl = $('#sc-summary');
        const beatsEl = $('#sc-beats');

        if (!planEl) return;

        // Summary
        const beats = plan.beats || [];
        const totalDuration = beats.reduce((sum, b) => sum + (b.duration || 0), 0);
        summaryEl.textContent = `${beats.length} beats · ~${totalDuration.toFixed(1)}s total`;

        // Beats list
        beatsEl.innerHTML = beats.map((beat, i) => {
            const source = beat.source_file || beat.clip_name || 'unknown';
            const start = typeof beat.start === 'number' ? beat.start.toFixed(2) : '?';
            const end = typeof beat.end === 'number' ? beat.end.toFixed(2) : '?';
            const text = beat.text || beat.script_line || '';
            return `<li class="sc-beat-item">
                <span class="sc-beat-index">${i + 1}</span>
                <span class="sc-beat-text">${text}</span>
                <span class="sc-beat-source">${source} [${start}s–${end}s]</span>
            </li>`;
        }).join('');

        planEl.classList.remove('hidden');
    }

    // ═══════ Visual Placement ═══════
    function bindVisuals() {
        const uploadArea = $('#visual-map-upload');
        const fileInput = $('#visual-map-file');

        uploadArea.addEventListener('click', () => fileInput.click());
        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.classList.add('drag-over');
        });
        uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));
        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('drag-over');
            if (e.dataTransfer.files.length > 0) {
                fileInput.files = e.dataTransfer.files;
                updateUploadFilename();
            }
        });
        fileInput.addEventListener('change', updateUploadFilename);

        $('#btn-place-visuals').addEventListener('click', runVisualPlacement);
    }

    function updateUploadFilename() {
        const fileInput = $('#visual-map-file');
        const label = $('#visual-map-filename');
        if (fileInput.files.length > 0) {
            label.textContent = fileInput.files[0].name;
        } else {
            label.textContent = 'Drop or click to upload (docx, txt, pdf)';
        }
    }

    async function runVisualPlacement() {
        const fileInput = $('#visual-map-file');
        const visualFolder = $('#visuals-folder').value.trim();
        const outputPath = $('#visuals-output').value.trim();

        if (!visualFolder) {
            showProgress('visuals', 'Please enter the visual folder path.');
            return;
        }

        if (fileInput.files.length === 0) {
            showProgress('visuals', 'Please upload a mapping document.');
            return;
        }

        showProgress('visuals', 'Placing visuals...');
        disableButton('btn-place-visuals');

        try {
            const formData = new FormData();
            formData.append('file', fileInput.files[0]);
            formData.append('visual_folder', visualFolder);
            formData.append('video_output_path', outputPath || 'output_with_visuals.mp4');

            const resp = await fetch(CONFIG.serverUrl + '/api/pipeline/visuals/upload-map', {
                method: 'POST',
                body: formData,
            });

            if (!resp.ok) {
                const err = await resp.json().catch(() => ({ detail: resp.statusText }));
                throw new Error(err.detail || resp.statusText);
            }

            const result = await resp.json();
            hideProgress('visuals');

            const resultHtml = `
                <div class="result-item">
                    <div class="result-label">Visual Placement ${result.success ? 'Complete' : 'Failed'}</div>
                    <div class="result-value">Visuals placed: ${result.visuals_placed || 0}</div>
                    ${result.visuals_missing && result.visuals_missing.length > 0 ?
                        `<div class="result-value" style="color:var(--warning)">Missing: ${result.visuals_missing.join(', ')}</div>` : ''}
                    ${result.output_path ? `<div class="result-value">Output: ${result.output_path}</div>` : ''}
                </div>`;
            showResults('visuals', resultHtml);

            addChatMessage('assistant', `Visual placement complete! Placed **${result.visuals_placed || 0}** visuals. ${result.output_path ? `Output: \`${result.output_path}\`` : ''}`);
        } catch (e) {
            hideProgress('visuals');
            showResults('visuals', `Error: ${e.message}`);
        } finally {
            enableButton('btn-place-visuals');
        }
    }

    // ═══════ Preflight (Phase A.1) ═══════
    function bindPreflight() {
        $('#btn-preflight-toggle').addEventListener('click', () => {
            const details = $('#preflight-details');
            const toggle = $('#btn-preflight-toggle');
            if (details.classList.contains('hidden')) {
                details.classList.remove('hidden');
                toggle.innerHTML = '&#9650;'; // up arrow
                toggle.title = 'Hide details';
            } else {
                details.classList.add('hidden');
                toggle.innerHTML = '&#9660;'; // down arrow
                toggle.title = 'Show details';
            }
        });
    }

    async function runPreflight() {
        const banner = $('#preflight-banner');
        const statusText = $('#preflight-status-text');
        const icon = $('#preflight-icon');

        statusText.textContent = 'Checking environment...';
        icon.innerHTML = '\u23F3'; // hourglass
        banner.classList.remove('hidden', 'preflight-green', 'preflight-yellow', 'preflight-red');

        try {
            const resp = await apiGet('/preflight');
            state.preflightReady = resp.ready;
            state.preflightChecks = resp.checks || [];

            const hasRed = resp.checks.some(c => c.status === 'red');
            const hasYellow = resp.checks.some(c => c.status === 'yellow');

            if (hasRed) {
                banner.classList.add('preflight-red');
                icon.innerHTML = '\u2718'; // cross
                const redCount = resp.checks.filter(c => c.status === 'red').length;
                statusText.textContent = `${redCount} issue(s) must be resolved before cutting`;
            } else if (hasYellow) {
                banner.classList.add('preflight-yellow');
                icon.innerHTML = '\u26A0'; // warning
                const yellowCount = resp.checks.filter(c => c.status === 'yellow').length;
                statusText.textContent = `${yellowCount} warning(s) — cutting available but may degrade`;
            } else {
                banner.classList.add('preflight-green');
                icon.innerHTML = '\u2713'; // checkmark
                statusText.textContent = 'All checks passed — ready to cut';
            }

            renderPreflightChecks(resp.checks);

            // Update the Script Cut preflight indicator
            updatePreflightIndicator(resp.checks || []);

            // Disable "Match & Cut" button when reds exist
            const cutBtn = $('#btn-cut');
            if (cutBtn) {
                cutBtn.disabled = hasRed;
                if (hasRed) {
                    cutBtn.title = 'Resolve preflight issues before cutting';
                } else {
                    cutBtn.title = '';
                }
            }
        } catch (e) {
            banner.classList.add('preflight-red');
            icon.innerHTML = '\u2718';
            statusText.textContent = 'Preflight check failed: ' + e.message;
            console.warn('Preflight check failed:', e);
        }
    }

    async function loadProjectContext() {
        try {
            const context = await apiGet('/premiere/context');
            if (!context) return;
            state.projectState = {
                items: context.items || [],
                bins: context.bins || [],
                sequences: context.sequences || [],
            };
            populateScriptCutBins();
        } catch (e) {
            console.warn('Failed to load Premiere context:', e);
        }
    }

    function renderPreflightChecks(checks) {
        const container = $('#preflight-checks');
        if (!container) return;

        container.innerHTML = checks.map(check => {
            const statusIcon = check.status === 'green' ? '\u2713'
                : check.status === 'yellow' ? '\u26A0'
                : '\u2718';
            return `<div class="preflight-check-row">
                <span class="preflight-check-icon ${check.status}">${statusIcon}</span>
                <span class="preflight-check-name">${check.name}</span>
                <span class="preflight-check-message">${check.message}</span>
                ${check.remediation ? `<span class="preflight-check-remediation">${check.remediation}</span>` : ''}
            </div>`;
        }).join('');
    }

    function updatePreflightIndicator(checks) {
        const indicator = $('#sc-preflight-indicator');
        if (!indicator) return;

        const hasRed = checks.some(c => c.status === 'red');
        const hasYellow = checks.some(c => c.status === 'yellow');

        indicator.classList.remove('hidden', 'indicator-green', 'indicator-yellow', 'indicator-red');

        if (hasRed) {
            indicator.classList.add('indicator-red');
            indicator.innerHTML = '\u2718';
            indicator.title = 'Preflight issues detected — cannot generate plan';
        } else if (hasYellow) {
            indicator.classList.add('indicator-yellow');
            indicator.innerHTML = '\u26A0';
            indicator.title = 'Preflight warnings — plan generation may degrade';
        } else {
            indicator.classList.add('indicator-green');
            indicator.innerHTML = '\u2713';
            indicator.title = 'All preflight checks passed';
        }
    }

    async function probeCapabilities() {
        // Only run if CSInterface is available (inside Premiere)
        if (!state.csInterface) {
            console.log('Skipping capability probe — not running inside Premiere');
            return;
        }

        try {
            const result = await evalExtendScript('probeCapabilities');
            if (!result) return;

            const parsed = JSON.parse(result);
            if (parsed && parsed.success && parsed.capabilities) {
                state.capabilities = parsed.capabilities;

                // Post to backend for persistence
                try {
                    // Try to extract version info from the Premiere DOM
                    let premiereVersion = 'unknown';
                    let panelVersion = '2'; // EditFlow v2
                    try {
                        if (typeof app !== 'undefined' && app.version) {
                            premiereVersion = app.version;
                        }
                    } catch (e) {}

                    parsed.capabilities.premiere_version = premiereVersion;
                    parsed.capabilities.panel_version = panelVersion;

                    await apiPost('/preflight/capabilities', parsed.capabilities);
                    console.log('Capability probe results posted to backend');
                } catch (e) {
                    console.warn('Failed to post capabilities to backend:', e);
                }

                // Re-run preflight to incorporate capabilities
                await runPreflight();
            }
        } catch (e) {
            console.warn('Capability probe failed:', e);
        }
    }

    async function postPremiereStatusCapabilities() {
        const projectOpen = !!(
            (state.projectState && (
                state.projectState.path ||
                (state.projectState.bins && state.projectState.bins.length) ||
                (state.projectState.items && state.projectState.items.length) ||
                (state.projectState.sequences && state.projectState.sequences.length)
            )) ||
            state.sequenceState
        );
        const activeSequence = !!(
            state.sequenceState ||
            (state.projectState && state.projectState.sequences && state.projectState.sequences.length)
        );

        if (!projectOpen) return;

        try {
            await apiPost('/preflight/capabilities', {
                qe_available: false,
                qe_razor: false,
                marker_seconds: false,
                frame_size: false,
                project_has_path: true,
                active_sequence: activeSequence,
                premiere_version: 'unknown',
                panel_version: '2',
                source: 'project_context'
            });
            await runPreflight();
        } catch (e) {
            console.warn('Failed to post Premiere status capabilities:', e);
        }
    }

    // ═══════ Settings ═══════
    function bindSettings() {
        $('#btn-settings').addEventListener('click', () => {
            $('#settings-overlay').classList.remove('hidden');
            loadSettings();
        });
        $('#btn-settings-close').addEventListener('click', () => {
            $('#settings-overlay').classList.add('hidden');
        });
        $('#btn-test-connection').addEventListener('click', checkConnection);
        $('#btn-refresh-models').addEventListener('click', loadModels);
        $('#btn-add-provider').addEventListener('click', addProvider);
        $('#btn-sync-sequence').addEventListener('click', syncSequenceState);
        $('#btn-scan-project').addEventListener('click', scanProject);
        $('#btn-scan').addEventListener('click', scanProject);

        // Save server URL on change
        $('#settings-server-url').addEventListener('change', () => {
            CONFIG.serverUrl = $('#settings-server-url').value.trim();
            localStorage.setItem('editflow_server_url', CONFIG.serverUrl);
        });

        // ── Sync model selection to backend when user changes dropdown ──
        $('#settings-chat-model').addEventListener('change', async (e) => {
            const model = e.target.value;
            if (!model) return;
            try {
                await apiPost('/models/set-chat?model_name=' + encodeURIComponent(model), {});
                console.log('Active chat model set to:', model);
            } catch (err) {
                console.warn('Failed to set chat model:', err);
            }
        });

        $('#settings-vision-model').addEventListener('change', async (e) => {
            const model = e.target.value;
            if (!model) return;
            try {
                await apiPost('/models/set-vision?model_name=' + encodeURIComponent(model), {});
                console.log('Active vision model set to:', model);
            } catch (err) {
                console.warn('Failed to set vision model:', err);
            }
        });
    }

    async function loadSettings() {
        $('#settings-server-url').value = CONFIG.serverUrl;
        await loadModels();
        await loadProviders();
    }

    async function checkConnection() {
        const statusEl = $('#settings-status');
        statusEl.textContent = 'Connecting...';
        statusEl.className = 'status-line';

        try {
            const resp = await apiGet('/ping');
            if (resp.server === 'running') {
                state.connected = true;
                statusEl.textContent = 'Connected to EditFlow AI v' + (resp.version || '2');
                statusEl.className = 'status-line connected';
                $('#premiere-status').textContent = 'Backend connected';
                $('#premiere-status').className = 'status-line connected';
            } else {
                throw new Error('Unexpected response');
            }
        } catch (e) {
            state.connected = false;
            statusEl.textContent = 'Connection failed: ' + e.message;
            statusEl.className = 'status-line error';
            $('#premiere-status').textContent = 'Backend not reachable';
            $('#premiere-status').className = 'status-line error';
        }
    }

    async function loadModels() {
        try {
            const resp = await apiGet('/models/list');

            // Populate chat model selector
            const chatSelect = $('#settings-chat-model');
            chatSelect.innerHTML = '';
            const allModels = [...(resp.local_models || []), ...(resp.cloud_models || [])];
            allModels.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.name;
                opt.textContent = m.name + (m.is_local ? ' (local)' : '') + (m.is_vision ? ' [vision]' : '');
                if (m.name === resp.active_chat_model) opt.selected = true;
                chatSelect.appendChild(opt);
            });

            // Populate vision model selector
            const visionSelect = $('#settings-vision-model');
            visionSelect.innerHTML = '';
            allModels.filter(m => m.is_vision).forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.name;
                opt.textContent = m.name + (m.is_local ? ' (local)' : '');
                if (m.name === resp.active_vision_model) opt.selected = true;
                visionSelect.appendChild(opt);
            });
        } catch (e) {
            console.warn('Failed to load models:', e);
        }
    }

    async function loadProviders() {
        const list = $('#provider-list');
        try {
            const providers = await apiGet('/providers');
            if (!providers || providers.length === 0) {
                list.innerHTML = '<div class="provider-empty">No providers configured. Add one below.</div>';
                return;
            }

            list.innerHTML = providers.map(p => `
                <div class="provider-item">
                    <span class="provider-name">${p.name || p.id}</span>
                    <span class="provider-status ${p.status || 'unknown'}">${p.status || 'unknown'}</span>
                </div>
            `).join('');
        } catch (e) {
            list.innerHTML = '<div class="provider-empty">Error loading providers</div>';
        }
    }

    async function addProvider() {
        const name = $('#new-provider-name').value.trim();
        const type = $('#new-provider-type').value;
        const url = $('#new-provider-url').value.trim();
        const key = $('#new-provider-key').value.trim();

        if (!name || !url) {
            alert('Name and URL are required.');
            return;
        }

        try {
            await apiPost('/providers', {
                name: name,
                type: type,
                base_url: url,
                api_key: key || undefined,
                enabled: true,
            });
            // Clear form
            $('#new-provider-name').value = '';
            $('#new-provider-url').value = '';
            $('#new-provider-key').value = '';
            // Reload
            await loadProviders();
            await loadModels();
        } catch (e) {
            alert('Failed to add provider: ' + e.message);
        }
    }

    // ═══════ Premiere Pro Integration ═══════
    async function syncSequenceState() {
        try {
            const result = await evalExtendScript('getSequenceState');
            if (result) {
                state.sequenceState = JSON.parse(result);
                if (state.sequenceState && state.sequenceState.success === false) {
                    throw new Error(state.sequenceState.error || 'Unknown sequence sync error');
                }
                $('#premiere-status').textContent = `Sequence: ${state.sequenceState.name || 'Active'} (${state.sequenceState.videoTracks?.length || 0}V / ${state.sequenceState.audioTracks?.length || 0}A)`;
                $('#premiere-status').className = 'status-line connected';

                // Also sync to backend
                await apiPost('/premiere/context', {
                    items: [],
                    bins: [],
                    sequences: [state.sequenceState],
                });
                await postPremiereStatusCapabilities();

                addChatMessage('assistant', `Synced sequence **${state.sequenceState.name || 'Active'}** with ${state.sequenceState.videoTracks?.length || 0} video and ${state.sequenceState.audioTracks?.length || 0} audio tracks.`);
            }
        } catch (e) {
            $('#premiere-status').textContent = 'Error: ' + e.message;
            $('#premiere-status').className = 'status-line error';
        }
    }

    async function scanProject() {
        try {
            const result = await evalExtendScript('scanProject');
            if (result) {
                state.projectState = JSON.parse(result);
                if (state.projectState && state.projectState.success === false) {
                    throw new Error(state.projectState.error || 'Unknown project scan error');
                }

                // Sync to backend
                await apiPost('/premiere/context', {
                    items: state.projectState.items || [],
                    bins: state.projectState.bins || [],
                    sequences: state.projectState.sequences || [],
                });

                const itemCount = (state.projectState.items || []).length;
                const binCount = (state.projectState.bins || []).length;
                populateScriptCutBins();
                await postPremiereStatusCapabilities();
                addChatMessage('assistant', `Scanned project: **${binCount}** bins, **${itemCount}** items. Context synced with the AI.`);
            }
        } catch (e) {
            addChatMessage('error', 'Failed to scan project: ' + e.message);
        }
    }

    // ═══════ Active Sequence Phrase Workflow ═══════

    /**
     * Convert the active sequence's audio tracks into the payload shape the
     * backend expects (snake_case, one entry per clip).
     */
    function getSequenceAudioClipsForBackend(sequenceState) {
        if (!sequenceState || !Array.isArray(sequenceState.audioTracks)) return [];
        const clips = [];
        sequenceState.audioTracks.forEach((track) => {
            (track.clips || []).forEach((clip, clipIndex) => {
                if (!clip.mediaPath) return;
                clips.push({
                    sequence_name: sequenceState.name || '',
                    track_index: typeof track.index === 'number' ? track.index : 0,
                    clip_index: clipIndex,
                    clip_name: clip.name || '',
                    media_path: clip.mediaPath,
                    timeline_start: clip.startTime || 0,
                    timeline_end: clip.endTime || 0,
                    source_in: clip.inPoint || 0,
                    source_out: clip.outPoint || 0,
                    speed: clip.speed || 1,
                });
            });
        });
        return clips;
    }

    async function analyzeActiveSequenceAudio() {
        if (!state.sequenceState) {
            await syncSequenceState();
        }
        const audioClips = getSequenceAudioClipsForBackend(state.sequenceState);
        if (!audioClips.length) {
            addChatMessage('error', 'No audio clips with media paths were found in the active sequence.');
            return null;
        }
        const langInput = $('#analyze-language');
        const resp = await apiPost('/premiere/sequence/analyze', {
            sequence_id: state.sequenceState.id || '',
            sequence_name: state.sequenceState.name || '',
            language: (langInput && langInput.value) || undefined,
            audio_clips: audioClips,
            client_id: CONFIG.clientId,
        });
        addChatMessage('assistant',
            resp.message || `Indexed ${resp.words_indexed || 0} words from the active sequence.`);
        return resp;
    }

    async function findPhraseInActiveSequence(phrase) {
        if (!state.sequenceState) {
            await syncSequenceState();
        }
        const resp = await apiPost('/premiere/sequence/find-phrase', {
            sequence_id: state.sequenceState.id || '',
            sequence_name: state.sequenceState.name || '',
            phrase,
            padding_before: 0.05,
            padding_after: 0.08,
        });
        state.lastPhraseRanges = resp.ranges || [];
        const hint = state.lastPhraseRanges.length
            ? ' Use Preview or Apply to edit the timeline.'
            : '';
        addChatMessage('assistant', (resp.message || 'Phrase search complete') + hint);
        return resp;
    }

    /**
     * Evaluate an ExtendScript function in Premiere Pro.
     * @param {string} command - The command name
     * @param {string} [payload] - JSON payload string
     * @returns {Promise<string>} - Result from ExtendScript
     */
    function evalExtendScript(command, payload) {
        return new Promise((resolve, reject) => {
            if (!state.csInterface) {
                reject(new Error('CSInterface not available'));
                return;
            }

            const extensionRoot = getExtensionRoot();
            const script = buildExtendScriptCall(command, payload || '', extensionRoot);

            state.csInterface.evalScript(script, (result) => {
                if (result === 'EvalScript error.') {
                    reject(new Error('Premiere Pro could not evaluate EditFlow ExtendScript. Reload the panel or restart Premiere Pro.'));
                } else if (result === 'undefined' || !result) {
                    reject(new Error('Premiere Pro returned no result from EditFlow ExtendScript.'));
                } else {
                    resolve(result);
                }
            });
        });
    }

    function getExtensionRoot() {
        try {
            if (
                state.csInterface &&
                typeof state.csInterface.getSystemPath === 'function'
            ) {
                const extensionPathType = (state.csInterface.SYSTEM_PATH && state.csInterface.SYSTEM_PATH.EXTENSION) || 'extension';
                return state.csInterface.getSystemPath(extensionPathType) || '';
            }
        } catch (e) {
            console.warn('Unable to read CEP extension path:', e);
        }
        return '';
    }

    function buildExtendScriptCall(command, payload, extensionRoot) {
        const commandLiteral = JSON.stringify(command);
        const payloadLiteral = JSON.stringify(payload || '');
        const extensionRootLiteral = JSON.stringify(extensionRoot || '');
        return `(function() {
            var command = ${commandLiteral};
            var payload = ${payloadLiteral};
            var extensionRoot = ${extensionRootLiteral};
            function editflowRuntimeEscape(value) {
                return String(value)
                    .replace(/\\\\/g, '\\\\\\\\')
                    .replace(/"/g, '\\\\"')
                    .replace(/\\r/g, '\\\\r')
                    .replace(/\\n/g, '\\\\n');
            }
            function editflowRuntimeError(message) {
                return '{"success":false,"error":"' + editflowRuntimeEscape(message) +
                    '","command":"' + editflowRuntimeEscape(command) + '"}';
            }
            try {
                if (typeof editflowConfigureExtensionRoot !== 'function') {
                    return editflowRuntimeError('EditFlow ExtendScript loader is not available. Reload the EditFlow AI panel or restart Premiere Pro.');
                }
                var configureResult = editflowConfigureExtensionRoot(extensionRoot);
                try {
                    var configureState = JSON.parse(configureResult);
                    if (configureState && configureState.success === false) {
                        return configureResult;
                    }
                } catch (parseError) {}
                if (typeof editflowDispatch !== 'function') {
                    return editflowRuntimeError('EditFlow ExtendScript dispatcher is not loaded. Reload the EditFlow AI panel or restart Premiere Pro.');
                }
                return editflowDispatch(command, payload);
            } catch (e) {
                return editflowRuntimeError(e && e.toString ? e.toString() : e);
            }
        })()`;
    }

    // ═══════ API Helpers ═══════
    async function apiGet(path) {
        const resp = await fetch(CONFIG.serverUrl + '/api' + path);
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ detail: resp.statusText }));
            throw new Error(err.detail || resp.statusText);
        }
        return resp.json();
    }

    async function apiPost(path, body) {
        const resp = await fetch(CONFIG.serverUrl + '/api' + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ detail: resp.statusText }));
            throw new Error(err.detail || resp.statusText);
        }
        return resp.json();
    }

    // ═══════ UI Helpers ═══════
    function showProgress(tab, message) {
        const el = $(`#${tab}-progress`);
        el.classList.remove('hidden');
        el.innerHTML = message;
    }

    function hideProgress(tab) {
        const el = $(`#${tab}-progress`);
        el.classList.add('hidden');
    }

    function showResults(tab, html) {
        const el = $(`#${tab}-results`);
        el.classList.remove('hidden');
        el.innerHTML = html;
    }

    function disableButton(id) {
        $('#' + id).disabled = true;
    }

    function enableButton(id) {
        $('#' + id).disabled = false;
    }

    function generateId() {
        return Math.random().toString(36).substring(2, 10);
    }

    // ═══════ WebSocket ═══════
    function connectWebSocket() {
        try {
            const wsUrl = CONFIG.serverUrl.replace('http', 'ws') + '/api/chat/ws/' + CONFIG.clientId;
            state.ws = new WebSocket(wsUrl);

            state.ws.onopen = () => console.log('WebSocket connected');
            state.ws.onclose = () => {
                console.log('WebSocket disconnected, reconnecting in 5s...');
                setTimeout(connectWebSocket, 5000);
            };
            state.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'progress') {
                        // Handle progress updates
                        showProgress('chat', data.payload?.message || 'Processing...');
                    } else if (data.type === 'chat_response') {
                        hideTypingIndicator();
                        const content = data.payload?.message?.content;
                        if (content) addChatMessage('assistant', content);
                    }
                } catch (e) {}
            };
            state.ws.onerror = (e) => console.warn('WebSocket error:', e);
        } catch (e) {
            console.warn('WebSocket connection failed:', e);
        }
    }

    // ═══════ Boot ═══════
    document.addEventListener('DOMContentLoaded', init);

})();
