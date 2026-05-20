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
        bindSettings();

        // Auto-expand textarea
        const chatInput = $('#chat-input');
        chatInput.addEventListener('input', () => {
            chatInput.style.height = 'auto';
            chatInput.style.height = Math.min(chatInput.scrollHeight, 80) + 'px';
        });

        // Try to connect
        checkConnection();

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
            addChatMessage('assistant', 'Cut plan has been applied to the Premiere Pro timeline!');
        } catch (e) {
            addChatMessage('error', 'Failed to send to Premiere: ' + e.message);
        }
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

            const resp = await fetch(CONFIG.serverUrl + '/pipeline/visuals/upload-map', {
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
                $('#premiere-status').textContent = `Sequence: ${state.sequenceState.name || 'Active'} (${state.sequenceState.videoTracks?.length || 0}V / ${state.sequenceState.audioTracks?.length || 0}A)`;
                $('#premiere-status').className = 'status-line connected';

                // Also sync to backend
                await apiPost('/premiere/context', {
                    items: [],
                    bins: [],
                    sequences: [state.sequenceState],
                });

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

                // Sync to backend
                await apiPost('/premiere/context', {
                    items: state.projectState.items || [],
                    bins: state.projectState.bins || [],
                    sequences: state.projectState.sequences || [],
                });

                const itemCount = (state.projectState.items || []).length;
                const binCount = (state.projectState.bins || []).length;
                addChatMessage('assistant', `Scanned project: **${binCount}** bins, **${itemCount}** items. Context synced with the AI.`);
            }
        } catch (e) {
            addChatMessage('error', 'Failed to scan project: ' + e.message);
        }
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

            let script;
            if (command === 'processEDL') {
                // processEDL needs a file path; we'll write the data to a temp file first
                // For now, use editflowDispatch for in-memory operations
                script = `editflowDispatch('${command}', '${payload || ''}')`;
            } else if (command === 'getSequenceState') {
                script = 'getSequenceState()';
            } else if (command === 'scanProject') {
                script = 'scanProjectMedia()';
            } else {
                script = `editflowDispatch('${command}', '${payload || ''}')`;
            }

            state.csInterface.evalScript(script, (result) => {
                if (result === 'EvalScript error.' || result === 'undefined') {
                    reject(new Error(result));
                } else {
                    resolve(result);
                }
            });
        });
    }

    // ═══════ API Helpers ═══════
    async function apiGet(path) {
        const resp = await fetch(CONFIG.serverUrl + path);
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ detail: resp.statusText }));
            throw new Error(err.detail || resp.statusText);
        }
        return resp.json();
    }

    async function apiPost(path, body) {
        const resp = await fetch(CONFIG.serverUrl + path, {
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
