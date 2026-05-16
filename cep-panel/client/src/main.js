/**
 * EditFlow AI - CEP Panel Client
 * Multi-provider chat interface for Adobe Premiere Pro.
 *
 * Architecture:
 * - Non-blocking initialization (never hangs on provider issues)
 * - Settings panel for adding/removing LLM providers
 * - Auto-discovery of models from configured providers
 * - Graceful degradation when providers are unavailable
 * - CSInterface bridge for ExtendScript communication
 */

// ── Configuration ──
let BACKEND_URL = 'http://localhost:8765';
const WS_BASE = '/api/chat/ws';

// ── State ──
let sessionId = null;
let clientId = 'cep-' + Math.random().toString(36).substr(2, 8);
let ws = null;
let currentScriptId = null;
let isConnected = false;
let providers = [];       // Provider list from API
let allModels = [];       // Flat model list for selectors
let editingProviderId = null;  // Track which provider we're editing
let lastUndoCount = 1;         // Track how many clips were modified to undo properly
let sequenceContext = null;    // Last normalized sequence state sent to backend/chat
let currentV2PlanId = null;    // Current v2 edit plan shown in preview
let currentV2DryRun = null;    // Current v2 dry-run result
let v2State = {
    assetId: null,
    scriptId: null,
    visualMapId: null,
    planId: null,
};
let featureFlags = {
    phase1_reference_only: true,
    enable_v2_bin_workflow: true,
    enable_v2_edit_planning: false,
    enable_legacy_premiere_commands: false,
    enable_old_import_files: false,
    enable_old_generate_script: false,
};

// ── DOM Elements ──
const chatMessages = document.getElementById('chat-messages');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const modelSelector = document.getElementById('model-selector');
const connectionStatus = document.getElementById('connection-status');
const scriptPreview = document.getElementById('script-preview');
const scriptTitle = document.getElementById('script-title');
const scriptContent = document.getElementById('script-content');
const executeBtn = document.getElementById('execute-btn');
const refineBtn = document.getElementById('refine-btn');
const closeScriptBtn = document.getElementById('close-script-btn');
const settingsBtn = document.getElementById('settings-btn');
const providerBar = document.getElementById('provider-bar');
const providerBarText = document.getElementById('provider-bar-text');
const providerBarSettings = document.getElementById('provider-bar-settings');
const v2ToggleBtn = document.getElementById('v2-toggle-btn');
const v2Panel = document.getElementById('v2-panel');
const v2StateText = document.getElementById('v2-state-text');
const v2RawRootPath = document.getElementById('v2-raw-root-path');
const v2RawPath = document.getElementById('v2-raw-path');
const v2ScriptText = document.getElementById('v2-script-text');
const v2VisualMapText = document.getElementById('v2-visual-map-text');
const v2SetRawRootBtn = document.getElementById('v2-set-raw-root-btn');
const v2ScanProjectBtn = document.getElementById('v2-scan-project-btn');
const v2RegisterBtn = document.getElementById('v2-register-btn');
const v2AnalyzeBtn = document.getElementById('v2-analyze-btn');
const v2IngestScriptBtn = document.getElementById('v2-ingest-script-btn');
const v2IngestMapBtn = document.getElementById('v2-ingest-map-btn');
const v2DryRunBtn = document.getElementById('v2-dry-run-btn');
const v2ExecuteBtn = document.getElementById('v2-execute-btn');

// Settings panel elements
const settingsOverlay = document.getElementById('settings-overlay');
const settingsClose = document.getElementById('settings-close');
const activeChatSelect = document.getElementById('active-chat-select');
const activeVisionSelect = document.getElementById('active-vision-select');
const addProviderBtn = document.getElementById('add-provider-btn');
const providersList = document.getElementById('providers-list');
const providerForm = document.getElementById('provider-form');
const providerFormTitle = document.getElementById('provider-form-title');
const pfName = document.getElementById('pf-name');
const pfType = document.getElementById('pf-type');
const pfBaseUrl = document.getElementById('pf-base-url');
const pfApiKey = document.getElementById('pf-api-key');
const pfTimeout = document.getElementById('pf-timeout');
const pfChatModel = document.getElementById('pf-chat-model');
const pfVisionModel = document.getElementById('pf-vision-model');
const pfTest = document.getElementById('pf-test');
const pfSave = document.getElementById('pf-save');
const pfCancel = document.getElementById('pf-cancel');
const pfTestResult = document.getElementById('pf-test-result');
const backendUrlInput = document.getElementById('backend-url-input');
const testBackendBtn = document.getElementById('test-backend-btn');
const backendStatus = document.getElementById('backend-status');

// ── CSInterface (for ExtendScript calls) ──
let csInterface = null;
try {
    if (typeof CSInterface !== 'undefined') {
        csInterface = new CSInterface();
    } else {
        console.log('CSInterface unavailable - standalone mode');
    }
} catch(e) {
    console.log('Not running in Premiere Pro - standalone mode');
}

// ════════════════════════════════════════════
// Initialization (Non-Blocking)
// ════════════════════════════════════════════

async function init() {
    setupEventListeners();
    applyFeatureFlags();

    // Load backend URL from localStorage
    const savedUrl = localStorage.getItem('editflow_backend_url');
    if (savedUrl) {
        BACKEND_URL = savedUrl;
        backendUrlInput.value = savedUrl;
    }

    // These all run independently and never block each other
    checkBackendHealth();      // Don't await - fire and forget
    loadModels();              // Don't await - fire and forget
    createNewSession();        // Don't await - fire and forget

    // Connect WebSocket after a small delay (give backend check time)
    setTimeout(() => {
        connectWebSocket();
        loadExtendScript().then(() => autoScanProject());
    }, 500);
}

function loadExtendScript() {
    if (!csInterface) return Promise.resolve(false);
    const extPath = csInterface.getSystemPath(SystemPath.EXTENSION);
    const jsxPath = extPath + '/extendscript/index.jsx';
    const escapedPath = jsxPath.replace(/\\/g, '\\\\');
    
    const script = `
        try {
            $.evalFile("${escapedPath}");
            "SUCCESS";
        } catch(e) {
            e.toString() + " at " + e.fileName + ":" + e.line;
        }
    `;
    
    return new Promise((resolve) => {
        csInterface.evalScript(script, (res) => {
            if (res !== "SUCCESS") {
                console.error("ExtendScript Init Error:", res);
                addMessage('system', "Premiere Pro Script Error: " + res);
                resolve(false);
            } else {
                console.log("ExtendScript loaded successfully.");
                resolve(true);
            }
        });
    });
}

async function autoScanProject() {
    return scanProjectContext(false);
}

async function scanProjectContext(showMessage = true) {
    if (!csInterface) {
        if (showMessage) addMessage('system', 'Premiere bridge is not available, so I could not scan the project bins.');
        return null;
    }
    try {
        await apiPost('/api/project/context/clear', {}, 5000).catch(e => {
            console.warn('Could not clear stale project context:', e);
        });
        const result = await callExtendScript('scanProjectMedia');
        if (!result || result.success === false) {
            if (showMessage) addMessage('system', 'Project scan failed: ' + ((result && result.error) || 'Unknown error'));
            return null;
        }

        const registry = await apiPost('/api/project/context', result, 10000).catch(e => {
            if (showMessage) addMessage('system', 'Project scan finished, but backend sync failed: ' + e.message);
            return null;
        });
        const itemCount = result.total_items || (result.items && result.items.length) || 0;
        const binCount = (result.bins && result.bins.length) || 0;
        console.log("Project scanned and synced", registry);
        if (showMessage) {
            const summaries = await apiGet('/api/references/premiere-bins?limit=20', 5000).catch(e => null);
            addMessage('system', `Project references synced: ${itemCount} item(s), ${binCount} bin(s). ${formatBinSummaries(summaries && summaries.bins)}`);
        }
        return result;
    } catch(e) {
        console.warn("Auto-scan failed:", e);
        if (showMessage) addMessage('system', 'Project scan failed: ' + e.message);
    }
    return null;
}

// ── Event Listeners ──
function setupEventListeners() {
    sendBtn.addEventListener('click', sendMessage);
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Auto-resize textarea
    messageInput.addEventListener('input', () => {
        messageInput.style.height = 'auto';
        messageInput.style.height = Math.min(messageInput.scrollHeight, 100) + 'px';
    });

    // Model selector change - set active chat model
    modelSelector.addEventListener('change', async () => {
        const val = modelSelector.value;
        if (!val) return;
        const [providerId, model] = val.split('||');
        if (providerId && model) {
            try {
                await apiPost('/api/providers/set-active', {
                    provider_id: providerId,
                    model: model,
                    role: 'chat',
                });
            } catch(e) {
                console.error('Failed to set active model:', e);
            }
        }
    });

    executeBtn.addEventListener('click', () => {
        if (currentV2PlanId) {
            executeV2Plan();
        } else {
            executeScript();
        }
    });
    refineBtn.addEventListener('click', () => {
        messageInput.value = "I'd like to refine the current script. ";
        messageInput.focus();
    });
    closeScriptBtn.addEventListener('click', () => {
        scriptPreview.classList.add('hidden');
    });

    // Settings panel
    settingsBtn.addEventListener('click', openSettings);
    providerBarSettings.addEventListener('click', openSettings);
    settingsClose.addEventListener('click', closeSettings);
    settingsOverlay.addEventListener('click', (e) => {
        if (e.target === settingsOverlay) closeSettings();
    });

    // Provider form
    addProviderBtn.addEventListener('click', () => showProviderForm());
    pfTest.addEventListener('click', testProviderConnection);
    pfSave.addEventListener('click', saveProvider);
    pfCancel.addEventListener('click', hideProviderForm);

    // Backend connection
    backendUrlInput.addEventListener('change', () => {
        BACKEND_URL = backendUrlInput.value.replace(/\/+$/, '');
        localStorage.setItem('editflow_backend_url', BACKEND_URL);
    });
    testBackendBtn.addEventListener('click', testBackendConnection);

    v2ToggleBtn.addEventListener('click', () => {
        v2Panel.classList.toggle('hidden');
    });
    v2SetRawRootBtn.addEventListener('click', setV2RawRoot);
    if (v2ScanProjectBtn) v2ScanProjectBtn.addEventListener('click', () => scanProjectContext(true));
    v2RegisterBtn.addEventListener('click', registerV2RawAsset);
    v2AnalyzeBtn.addEventListener('click', analyzeV2RawAsset);
    v2IngestScriptBtn.addEventListener('click', ingestV2Script);
    v2IngestMapBtn.addEventListener('click', ingestV2VisualMap);
    v2DryRunBtn.addEventListener('click', createV2DryRun);
    v2ExecuteBtn.addEventListener('click', executeV2Plan);
}

// ════════════════════════════════════════════
// API Helpers (with timeout protection)
// ════════════════════════════════════════════

async function apiRequest(path, options = {}) {
    const method = options.method || 'GET';
    const body = options.body;
    const timeoutMs = options.timeoutMs || 5000;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => {
        if (controller) controller.abort();
    }, timeoutMs);

    const fetchOptions = {
        method,
        headers: { 'Accept': 'application/json' },
    };
    if (controller) fetchOptions.signal = controller.signal;
    if (body !== undefined && body !== null) {
        fetchOptions.headers['Content-Type'] = 'application/json';
        fetchOptions.body = JSON.stringify(body);
    }

    let response;
    try {
        const fetchPromise = fetch(`${BACKEND_URL}${path}`, fetchOptions);
        if (controller) {
            response = await fetchPromise;
        } else {
            response = await Promise.race([
                fetchPromise,
                new Promise((_, reject) => setTimeout(() => reject(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs)),
            ]);
        }
    } catch(e) {
        if (e.name === 'AbortError') {
            throw new Error(`Request timeout after ${timeoutMs}ms`);
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }

    const text = await response.text();
    let data = {};
    if (text) {
        try {
            data = JSON.parse(text);
        } catch(e) {
            if (response.ok) {
                throw new Error(`Invalid JSON response from ${path}`);
            }
            data = { detail: text };
        }
    }

    if (!response.ok) {
        const detail = data.detail || data.error || data.message || `HTTP ${response.status}`;
        throw new Error(Array.isArray(detail) ? JSON.stringify(detail) : detail);
    }

    return data;
}

async function apiGet(path, timeoutMs = 5000) {
    return apiRequest(path, { method: 'GET', timeoutMs });
}

async function apiPost(path, body, timeoutMs = 10000) {
    return apiRequest(path, { method: 'POST', body, timeoutMs });
}

async function apiDelete(path, timeoutMs = 5000) {
    return apiRequest(path, { method: 'DELETE', timeoutMs });
}

async function apiPut(path, body, timeoutMs = 10000) {
    return apiRequest(path, { method: 'PUT', body, timeoutMs });
}

// ════════════════════════════════════════════
// Backend Communication
// ════════════════════════════════════════════

async function checkBackendHealth() {
    try {
        const ping = await apiGet('/api/ping', 1500);
        featureFlags = ping.feature_flags || featureFlags;
        applyFeatureFlags();
        isConnected = true;
        connectionStatus.className = 'status-dot connected';
        connectionStatus.title = 'Connected';

        try {
            const data = await apiGet('/api/status', 6000);
            featureFlags = data.feature_flags || featureFlags;
            applyFeatureFlags();
            updateProviderBar(data);
            return data;
        } catch(statusError) {
            providerBar.classList.remove('hidden', 'connected', 'partial');
            providerBarText.textContent = 'Backend running - provider status unavailable';
            return ping;
        }
    } catch(e) {
        isConnected = false;
        connectionStatus.className = 'status-dot disconnected';
        connectionStatus.title = 'Backend unavailable';
        providerBar.classList.remove('hidden', 'connected', 'partial');
        providerBarText.textContent = 'Backend not running - start the server first';
        return null;
    }
}

function applyFeatureFlags() {
    const phase1 = featureFlags.phase1_reference_only || !featureFlags.enable_v2_edit_planning;
    if (v2DryRunBtn) {
        v2DryRunBtn.disabled = phase1;
        v2DryRunBtn.title = phase1 ? 'Phase 1 only: verify references first' : '';
    }
    if (v2ExecuteBtn) {
        v2ExecuteBtn.disabled = phase1;
        v2ExecuteBtn.title = phase1 ? 'Phase 1 only: execution comes after reference verification' : '';
    }
}

function updateProviderBar(statusData) {
    if (!statusData) return;

    const providers = statusData.providers || {};
    const connected = Object.values(providers).filter(p => p.connected);
    const total = Object.keys(providers).length;

    if (total === 0) {
        providerBar.classList.remove('hidden', 'connected', 'partial');
        providerBarText.textContent = 'No LLM providers configured';
    } else if (connected.length === 0) {
        providerBar.classList.remove('hidden', 'connected', 'partial');
        providerBarText.textContent = `No LLM providers connected (${total} configured)`;
    } else if (connected.length < total) {
        providerBar.classList.remove('hidden', 'connected');
        providerBar.classList.add('partial');
        providerBarText.textContent = `${connected.length}/${total} providers connected`;
    } else {
        providerBar.classList.add('connected');
        providerBarText.textContent = `${connected.length} provider(s) connected`;
        // Auto-hide after 3 seconds
        setTimeout(() => {
            if (providerBar.classList.contains('connected')) {
                providerBar.classList.add('hidden');
            }
        }, 3000);
    }
}

async function loadModels() {
    try {
        const data = await apiGet('/api/models/list', 8000);

        // Build flat model list from multi-provider format
        allModels = [];
        const providerData = Array.isArray(data.providers) ? data.providers : [];

        modelSelector.innerHTML = '';

        for (const provider of providerData) {
            const models = provider.models || [];
            if (models.length === 0) continue;

            const optgroup = document.createElement('optgroup');
            optgroup.label = provider.name || provider.id;

            for (const m of models) {
                const modelId = m.id || m.name;
                const optionValue = `${provider.id}||${modelId}`;

                allModels.push({
                    id: modelId,
                    name: m.name || modelId,
                    provider_id: provider.id,
                    provider_name: provider.name,
                    provider_type: provider.type,
                    size: m.size || '',
                    is_vision: m.is_vision || false,
                });

                const opt = document.createElement('option');
                opt.value = optionValue;
                const sizeStr = m.size ? ` (${m.size})` : '';
                opt.textContent = `${m.name || modelId}${sizeStr}`;

                // Mark active model
                if (provider.is_active_chat && modelId === data.active_chat_model) {
                    opt.selected = true;
                }

                optgroup.appendChild(opt);
            }

            modelSelector.appendChild(optgroup);
        }

        if (modelSelector.options.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'No models found - check Settings';
            modelSelector.appendChild(opt);
        }

        // Update settings panel selectors
        updateSettingsSelectors(data);

    } catch(e) {
        modelSelector.innerHTML = `<option value="">Error loading models: ${escapeHtml(e.message)}</option>`;
        console.error('Failed to load models:', e);
    }
}

function updateSettingsSelectors(data) {
    // Chat model selector in settings
    activeChatSelect.innerHTML = '<option value="">No model selected</option>';
    activeVisionSelect.innerHTML = '<option value="">No model selected</option>';

    for (const m of allModels) {
        const value = `${m.provider_id}||${m.id}`;

        const chatOpt = document.createElement('option');
        chatOpt.value = value;
        chatOpt.textContent = `${m.provider_name}: ${m.name}`;
        if (data && data.active_chat_provider === m.provider_id && data.active_chat_model === m.id) {
            chatOpt.selected = true;
        }
        activeChatSelect.appendChild(chatOpt);

        const visOpt = document.createElement('option');
        visOpt.value = value;
        visOpt.textContent = `${m.provider_name}: ${m.name}`;
        if (data && data.active_vision_provider === m.provider_id && data.active_vision_model === m.id) {
            visOpt.selected = true;
        }
        activeVisionSelect.appendChild(visOpt);
    }
}

async function createNewSession() {
    try {
        const data = await apiPost('/api/chat/session/new', {}, 3000);
        sessionId = data.session_id;
    } catch(e) {
        sessionId = 'local-' + Math.random().toString(36).substr(2, 8);
    }
}

// ════════════════════════════════════════════
// WebSocket
// ════════════════════════════════════════════

function connectWebSocket() {
    const wsUrl = BACKEND_URL.replace(/^http/, 'ws') + `${WS_BASE}/${clientId}`;
    try {
        ws = new WebSocket(wsUrl);
        ws.onopen = () => console.log('WebSocket connected');
        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            handleWSMessage(data);
        };
        ws.onclose = () => {
            console.log('WebSocket closed, reconnecting...');
            setTimeout(connectWebSocket, 3000);
        };
        ws.onerror = (err) => console.warn('WebSocket error:', err);
    } catch(e) {
        console.warn('WebSocket not available');
    }
}

function handleWSMessage(data) {
    if (data.type === 'progress') {
        const p = data.payload;
        showProgress(p.task_type, p.progress, p.message, p.status);
    } else if (data.type === 'chat_response') {
        addMessage('assistant', data.payload.message.content, data.payload.intent);
        if (data.payload.script_preview) {
            showScriptPreview(data.payload.script_preview);
        }
    }
}

// ════════════════════════════════════════════
// Send Message
// ════════════════════════════════════════════

async function sendMessage() {
    const text = messageInput.value.trim();
    if (!text) return;

    // Add user message to chat
    addMessage('user', text);
    messageInput.value = '';
    messageInput.style.height = 'auto';

    // Show typing indicator
    showTyping(true);

    try {
        const data = await apiPost('/api/chat/message', {
            message: text,
            session_id: sessionId,
            context: sequenceContext ? { sequence: sequenceContext } : {},
        }, 30000);
        showTyping(false);

        addMessage('assistant', data.message.content, data.intent);

        // Handle actions
        if (data.actions && data.actions.length > 0) {
            handleActions(data.actions);
        }

        // Show script preview if available
        if (data.script_preview) {
            showScriptPreview(data.script_preview);
        }

    } catch(e) {
        showTyping(false);
        addMessage('system', 'Connection error. Is the backend running?');
        console.error('Send message error:', e);
    }
}

// ── Handle Actions ──

async function handleActions(actions) {
    for (const action of actions) {
        if (action.type === 'premiere_command') {
            await executePremiereCommand(action.command, action.parameters);
        } else if (action.type === 'generate_script') {
            try {
                const data = await apiPost('/api/sequence/generate-script', action.parameters || {}, 30000);
                if (data.id) {
                    currentScriptId = data.id;
                    showScriptPreview(data);
                    addMessage('system', 'Script generated! Review it below and click Execute when ready.');
                }
            } catch(e) {
                addMessage('system', 'Failed to generate script: ' + e.message);
            }
        } else if (action.type === 'execute_script') {
            if (currentScriptId) {
                await executeScript();
            } else {
                addMessage('system', 'No script to execute. Generate one first!');
            }
        } else if (action.type === 'refine_script') {
            addMessage('system', 'Tell me what changes you want to make to the script.');
        } else if (action.type === 'add_media') {
            await addMediaToTimeline(action.parameters || action.entities || {});
        } else if (action.type === 'timeline_remove') {
            await removeTimelineClips(action.parameters || action.entities || {});
        } else if (action.type === 'timeline_clear_label') {
            await clearTimelineLabels(action.parameters || action.entities || {});
        } else if (action.type === 'v2_folder_sequence') {
            await handleV2FolderSequence(action.parameters || {});
        } else if (action.type === 'query_sequence') {
            try {
                await syncSequenceStateFromPremiere();
                const data = await apiGet('/api/sequence/state', 5000);
                addMessage('system', formatSequenceState(data));
                
                // Automatically ask the LLM to answer the user's question using the newly fetched state
                showTyping(true);
                const response = await apiPost('/api/chat/message', {
                    session_id: sessionId,
                    message: "SYSTEM INSTRUCTION: I have just scanned the timeline. Please answer the user's previous question using the project context data provided.",
                    context: sequenceContext
                });
                showTyping(false);
                
                if (response && response.message) {
                    addMessage('ai', response.message.content);
                    if (response.actions && response.actions.length > 0) {
                        handleActions(response.actions);
                    }
                }
            } catch(e) {
                showTyping(false);
                addMessage('system', 'Could not read sequence state.');
            }
        }
    }
}

async function executePremiereCommand(command, parameters) {
    if (!csInterface) {
        addMessage('system', 'Premiere bridge is not available. Reload the extension inside Premiere and try again.');
        return;
    }

    if (command === 'importFiles' && (!parameters || !Array.isArray(parameters.paths) || parameters.paths.length === 0)) {
        addMessage('system', 'I stopped before touching Premiere because no exact file paths were resolved. Use V2 folder planning or set a root folder first.');
        return;
    }

    addMessage('system', `Executing: ${command}...`);

    try {
        // If the command is undoAction, inject the last action's count
        if (command === 'undoAction' && !parameters.count) {
            parameters.count = lastUndoCount;
        }

        const result = await callExtendScriptCommand(command, parameters || {});
        if (!result || result.success === false) {
            addMessage('system', 'Command failed: ' + ((result && result.error) || 'Unknown Premiere error'));
            return;
        }

        if (command === 'scanProject') {
            await apiPost('/api/project/context', result, 10000).catch(e => {});
            addMessage('system', `Project scan complete: ${result.total_items || (result.items && result.items.length) || 0} item(s), ${(result.bins && result.bins.length) || 0} bin(s) found.`);
        } else {
            const suffix = result.warning ? ` Warning: ${result.warning}` : '';
            addMessage('system', `Command ${command} completed successfully.${suffix}`);
        }
        
        // Track the count for the next undo if present
        if (result && typeof result.count === 'number') {
            lastUndoCount = result.count;
        } else if (command !== 'undoAction') {
            lastUndoCount = 1; // reset for non-multi actions
        }

        if (command.includes('Timeline') || command.includes('Sequence') || command.includes('Clip')) {
            await syncSequenceStateFromPremiere();
        }
    } catch(e) {
        addMessage('system', 'Command failed: ' + e.message);
    }
}

async function removeTimelineClips(options) {
    if (!csInterface) {
        addMessage('system', 'Premiere bridge is not available. Reload the extension inside Premiere and try again.');
        return;
    }

    try {
        const result = await callExtendScriptCommand('removeTimelineClips', options || {});
        if (!result || result.success === false) {
            addMessage('system', 'Timeline removal failed: ' + ((result && result.error) || 'Unknown Premiere error'));
            return;
        }

        const removed = result.removed || 0;
        const scanned = result.scanned || 0;
        const detail = result.mode === 'label' && result.labelName
            ? `${result.labelName} labeled clip(s)`
            : 'B-roll clip(s)';
        addMessage('system', `Removed ${removed} ${detail} from ${result.sequenceName || 'the active sequence'} (${scanned} clip(s) scanned).`);
        await syncSequenceStateFromPremiere();
    } catch(e) {
        addMessage('system', 'Timeline removal failed: ' + e.message);
    }
}

async function clearTimelineLabels(options) {
    if (!csInterface) {
        addMessage('system', 'Premiere bridge is not available. Reload the extension inside Premiere and try again.');
        return;
    }

    try {
        const result = await callExtendScriptCommand('clearTimelineLabels', options || {});
        if (!result || result.success === false) {
            addMessage('system', 'Label cleanup failed: ' + ((result && result.error) || 'Unknown Premiere error'));
            return;
        }

        const changed = result.changed || 0;
        const scanned = result.scanned || 0;
        addMessage('system', `Cleared ${result.labelName || 'matching'} label color from ${changed} clip(s) in ${result.sequenceName || 'the active sequence'} (${scanned} clip(s) scanned).`);
        await syncSequenceStateFromPremiere();
    } catch(e) {
        addMessage('system', 'Label cleanup failed: ' + e.message);
    }
}

async function addMediaToTimeline(options) {
    if (!csInterface) {
        addMessage('system', 'Premiere bridge is not available. Reload the extension inside Premiere and try again.');
        return;
    }

    const mediaType = options.media_type || 'audio';
    const filename = options.filename || 'unknown';

    addMessage('system', `Adding ${filename} to timeline...`);

    try {
        const result = await callExtendScriptCommand('addMediaToTimeline', {
            media_type: mediaType,
            filename: filename,
            track_index: options.track_index || 0,
            start_time: options.start_time || 0
        });
        
        if (!result || result.success === false) {
            addMessage('system', 'Failed to add media: ' + ((result && result.error) || 'Unknown Premiere error'));
            return;
        }

        addMessage('system', `Added ${filename} to ${result.trackName || 'audio track'}.`);
        await syncSequenceStateFromPremiere();
    } catch(e) {
        addMessage('system', 'Failed to add media: ' + e.message);
    }
}

// ── Script Execution ──

// V2 Script-Aware Draft Flow

function updateV2StateText() {
    const bits = [];
    if (v2State.assetId) bits.push('raw');
    if (v2State.scriptId) bits.push('script');
    if (v2State.visualMapId) bits.push('visuals');
    if (v2State.planId) bits.push('plan');
    v2StateText.textContent = bits.length ? bits.join(' | ') : 'No draft';
}

async function setV2RawRoot() {
    const path = v2RawRootPath.value.trim();
    if (!path) {
        addMessage('system', 'Add the raw root folder path first.');
        return null;
    }

    try {
        const root = await apiPost('/api/references/roots', {
            alias: 'raw',
            path,
            description: 'Raw footage root folder',
        }, 10000);
        addMessage('system', `Raw root set: ${root.path}`);
        return root;
    } catch(e) {
        addMessage('system', 'Could not set raw root: ' + e.message);
        return null;
    }
}

async function handleV2FolderSequence(options) {
    addMessage('system', 'Refreshing Premiere references and resolving the folder/bin...');
    try {
        await scanProjectContext(false);
        const referenceOnly = featureFlags.phase1_reference_only || !featureFlags.enable_v2_edit_planning;
        let binSummaries = null;
        if (referenceOnly) {
            binSummaries = await apiGet('/api/references/premiere-bins?limit=200', 5000).catch(e => null);
            if (!binSummaries || !Array.isArray(binSummaries.bins) || binSummaries.bins.length === 0) {
                addMessage('system', 'Project scan did not reach backend. No Premiere bins are indexed, so I will not use old local folder data.');
                return null;
            }
            addMessage('system', formatBinSummaries(binSummaries.bins));
        }
        const explicitBinRef = options.binPath
            ? (/\s/.test(options.binPath) ? `@bin:"${options.binPath}"` : `@bin:${options.binPath}`)
            : '';
        const requestText = options.binPath
            ? `${options.request || ''} ${explicitBinRef}`
            : (options.request || '');
        const resolved = await apiPost(referenceOnly ? '/api/references/verify-bin' : '/api/references/resolve', {
            text: requestText,
            kind: referenceOnly ? 'bin' : (options.kind || 'bin_or_folder'),
            root_alias: options.rootAlias || 'raw',
            folder_name: options.folderName || '',
            register_assets: !referenceOnly,
            recursive: false,
        }, 30000);

        if (!resolved.success) {
            v2Panel.classList.remove('hidden');
            addMessage('system', `${resolved.message} ${formatSuggestions(resolved.suggestions)}`);
            return null;
        }

        showV2ReferencePreview(resolved);

        if (referenceOnly) {
            addMessage('system', `Reference verified: ${resolved.media_count} media file(s) from ${formatResolvedReference(resolved)}. Phase 1 stops here; no dry run or edit was created.`);
            return resolved;
        }

        if (!resolved.asset_ids || resolved.asset_ids.length === 0) {
            addMessage('system', `Resolved ${formatResolvedReference(resolved)}, but no usable media files were found.`);
            return null;
        }

        const plan = await apiPost('/api/edit-plans/create', {
            operation: 'combine_folder_videos_new_sequence',
            sources: resolved.asset_ids.map(id => `@asset:${id}`),
            target: '@new_sequence',
            constraints: {
                resolved_path: resolved.resolved_path,
                resolved_kind: resolved.kind,
                bin_path: resolved.bin_path || '',
                requested_text: options.request || '',
                default_clip_duration: 5,
            },
        }, 15000);
        v2State.planId = plan.id;
        currentV2PlanId = plan.id;
        updateV2StateText();

        const dryRun = await apiPost(`/api/edit-plans/${plan.id}/dry-run`, {}, 30000);
        currentV2DryRun = dryRun;
        showV2DryRunPreview(dryRun);
        addMessage('system', `Resolved ${resolved.media_count} media file(s) from ${formatResolvedReference(resolved)}. Dry run is ready; review it and click Execute.`);
        return dryRun;
    } catch(e) {
        addMessage('system', 'Folder planning failed: ' + e.message);
        return null;
    }
}

function formatResolvedReference(resolved) {
    if (!resolved) return 'the reference';
    if (resolved.kind === 'bin') return `Premiere bin ${resolved.bin_path || resolved.resolved_path}`;
    return resolved.resolved_path || resolved.bin_path || 'the reference';
}

function formatBinSummaries(bins) {
    if (!Array.isArray(bins) || bins.length === 0) return 'Project scan did not reach backend. No bins were indexed.';
    const lines = bins.slice(0, 12).map(bin => {
        const mediaCount = bin.media_count || 0;
        const itemCount = bin.item_count || 0;
        return `${bin.bin_path}: ${mediaCount} media / ${itemCount} item(s)`;
    });
    const suffix = bins.length > lines.length ? ` (${bins.length - lines.length} more)` : '';
    return 'Bins: ' + lines.join(' | ') + suffix;
}

function formatSuggestions(suggestions) {
    if (!Array.isArray(suggestions) || suggestions.length === 0) return '';
    return 'Suggestions: ' + suggestions.join(' ');
}

async function registerV2RawAsset() {
    const path = v2RawPath.value.trim();
    if (!path) {
        addMessage('system', 'Add a raw video path first.');
        return null;
    }

    try {
        const asset = await apiPost('/api/assets/register', {
            path,
            source_type: 'local_file',
            tags: ['raw', 'talking-head'],
        }, 15000);
        v2State.assetId = asset.id;
        v2State.planId = null;
        currentV2PlanId = null;
        updateV2StateText();
        addMessage('system', `Registered raw asset: ${asset.name || asset.id}`);
        return asset;
    } catch(e) {
        addMessage('system', 'Raw asset registration failed: ' + e.message);
        return null;
    }
}

async function analyzeV2RawAsset() {
    if (!v2State.assetId) {
        const asset = await registerV2RawAsset();
        if (!asset) return null;
    }

    addMessage('system', 'Queued raw asset analysis in the background.');
    try {
        const job = await apiPost(`/api/assets/${v2State.assetId}/analyze-async`, {
            transcribe: true,
            create_candidates: true,
            force: false,
        }, 10000);
        const completed = await pollV2Job(job.id, {
            waitingMessage: 'Analysis is still running...',
            timeoutMessage: 'Analysis is still running in the background. You can continue using the panel.',
        });
        if (!completed) return job;
        if (completed.status === 'failed') {
            addMessage('system', 'Analysis failed: ' + (completed.error || completed.message || 'Unknown error'));
            return completed;
        }
        const result = completed.result || {};
        addMessage('system', `Analysis ready: ${result.candidate_count || 0} speech candidate(s).`);
        return result;
    } catch(e) {
        addMessage('system', 'Analysis failed: ' + e.message);
        return null;
    }
}

function sleepMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function pollV2Job(jobId, options = {}) {
    const maxAttempts = options.maxAttempts || 240;
    const intervalMs = options.intervalMs || 2500;
    let lastStatus = '';

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const job = await apiGet(`/api/jobs/${jobId}`, 10000);
        if (job.status !== lastStatus) {
            lastStatus = job.status;
            if (job.status === 'running' || job.status === 'queued') {
                const pct = Math.round((Number(job.progress || 0)) * 100);
                addMessage('system', `${job.message || options.waitingMessage || 'Job running'}${pct ? ` (${pct}%)` : ''}`);
            }
        }
        if (job.status === 'completed' || job.status === 'failed') {
            return job;
        }
        await sleepMs(intervalMs);
    }

    addMessage('system', options.timeoutMessage || 'Job is still running in the background.');
    return null;
}

async function ingestV2Script() {
    const content = v2ScriptText.value.trim();
    if (!content) {
        addMessage('system', 'Paste a script or outline first.');
        return null;
    }

    try {
        const script = await apiPost('/api/scripts/ingest', {
            title: 'Panel Script',
            content,
            source_type: 'pasted_panel',
        }, 15000);
        v2State.scriptId = script.id;
        v2State.planId = null;
        currentV2PlanId = null;
        updateV2StateText();
        addMessage('system', `Script ingested: ${script.line_count || 0} line(s).`);
        return script;
    } catch(e) {
        addMessage('system', 'Script ingest failed: ' + e.message);
        return null;
    }
}

async function ingestV2VisualMap() {
    const content = v2VisualMapText.value.trim();
    if (!content) {
        v2State.visualMapId = null;
        updateV2StateText();
        addMessage('system', 'No visual map provided. The draft can still use A-roll only.');
        return null;
    }

    try {
        const visualMap = await apiPost('/api/visual-maps/ingest', {
            title: 'Panel Visual Map',
            content,
            source_type: 'pasted_panel',
        }, 30000);
        v2State.visualMapId = visualMap.id;
        v2State.planId = null;
        currentV2PlanId = null;
        updateV2StateText();
        addMessage('system', `Visual map ingested: ${visualMap.entry_count || 0} row(s).`);
        return visualMap;
    } catch(e) {
        addMessage('system', 'Visual map ingest failed: ' + e.message);
        return null;
    }
}

async function createV2DryRun() {
    if (featureFlags.phase1_reference_only || !featureFlags.enable_v2_edit_planning) {
        addMessage('system', 'Phase 1 is reference-check only. Verify a Premiere bin first; dry runs come in Phase 2.');
        return null;
    }

    if (!v2State.assetId) {
        const asset = await registerV2RawAsset();
        if (!asset) return null;
    }
    if (!v2State.scriptId) {
        const script = await ingestV2Script();
        if (!script) return null;
    }
    if (v2VisualMapText.value.trim() && !v2State.visualMapId) {
        await ingestV2VisualMap();
    }

    try {
        const plan = await apiPost('/api/edit-plans/create', {
            operation: 'build_script_guided_talking_head_sequence',
            sources: [`@asset:${v2State.assetId}`],
            script_id: v2State.scriptId,
            visual_map_id: v2State.visualMapId,
            target: '@new_sequence',
            cleanup_style: 'natural_clean',
            matching: 'best_meaning_match',
            visual_density: 'script_guided_balanced',
            constraints: {
                track_layout: 'v1_a1_talking_head_v2_visuals',
            },
        }, 15000);
        v2State.planId = plan.id;
        currentV2PlanId = plan.id;

        const dryRun = await apiPost(`/api/edit-plans/${plan.id}/dry-run`, {}, 30000);
        currentV2DryRun = dryRun;
        updateV2StateText();
        showV2DryRunPreview(dryRun);
        addMessage('system', `Dry run ready: ${dryRun.would_change || 0} planned timeline item(s), ${dryRun.missing_lines?.length || 0} missing line(s).`);
        return dryRun;
    } catch(e) {
        addMessage('system', 'Dry run failed: ' + e.message);
        return null;
    }
}

async function executeV2Plan() {
    if (featureFlags.phase1_reference_only || !featureFlags.enable_v2_edit_planning) {
        addMessage('system', 'Phase 1 is reference-check only. Execution is disabled until the reference workflow is verified.');
        return;
    }

    const planId = currentV2PlanId || v2State.planId;
    if (!planId) {
        addMessage('system', 'Create a v2 dry run first.');
        return;
    }

    if (!csInterface) {
        addMessage('system', 'Premiere bridge is not available. Open this panel inside Premiere to execute the draft.');
        return;
    }

    try {
        const submitted = await apiPost(`/api/edit-plans/${planId}/execute`, {}, 30000);
        if (!submitted || submitted.success === false || !submitted.edl_path) {
            addMessage('system', 'V2 execute did not produce an EDL: ' + ((submitted && submitted.message) || 'Unknown error'));
            return;
        }

        addMessage('system', `Executing v2 EDL with ${submitted.clip_count || 0} clip instruction(s)...`);
        const premiereResult = await callExtendScript('processEDL', submitted.edl_path);
        if (!premiereResult || premiereResult.success === false) {
            await apiPost(`/api/edit-plans/${planId}/verify`, {
                premiere_result: premiereResult || { success: false, error: 'No Premiere result returned' },
            }, 10000).catch(e => {});
            addMessage('system', 'Premiere execution failed: ' + ((premiereResult && premiereResult.error) || 'Unknown ExtendScript error'));
            return;
        }

        const sequenceState = await syncSequenceStateFromPremiere();
        if (sequenceState) {
            await apiPost('/api/premiere/snapshot', {
                snapshot_type: 'sequence',
                payload: sequenceState,
            }, 5000).catch(e => {});
        }

        const verification = await apiPost(`/api/edit-plans/${planId}/verify`, {
            premiere_result: premiereResult,
            sequence_state: sequenceState,
        }, 15000);

        if (verification.verified) {
            addMessage('system', `V2 edit verified in Premiere. ${submitted.clip_count || 0} clip instruction(s) were checked.`);
        } else {
            const warning = (verification.warnings || []).join(' ');
            addMessage('system', 'V2 edit executed, but verification found an issue: ' + (warning || 'Mismatch detected.'));
        }
    } catch(e) {
        addMessage('system', 'V2 execution failed: ' + e.message);
    }
}

async function executeScript() {
    if (!currentScriptId) {
        addMessage('system', 'No script selected for execution.');
        return;
    }

    addMessage('system', 'Executing script on timeline...');

    try {
        const data = await apiPost(`/api/sequence/execute/${currentScriptId}`, {}, 30000);

        if (data.status === 'submitted') {
            if (csInterface && data.edl_path) {
                const result = await callExtendScript('processEDL', data.edl_path);
                if (result && result.success === false) {
                    addMessage('system', 'Premiere execution failed: ' + (result.error || 'Unknown ExtendScript error'));
                } else {
                    addMessage('system', 'Script executed in Premiere.');
                    await syncSequenceStateFromPremiere();
                }
            } else {
                addMessage('system', 'Script submitted. Premiere bridge is not available in standalone mode.');
            }
        } else {
            addMessage('system', 'Execution result: ' + JSON.stringify(data));
        }
    } catch(e) {
        addMessage('system', 'Execution failed: ' + e.message);
    }
}

// ── ExtendScript Bridge ──

function callExtendScript(functionName, ...args) {
    if (!csInterface) {
        console.warn('Not running in Premiere Pro');
        return Promise.resolve(null);
    }

    return new Promise((resolve) => {
        const argStr = args.map(a => JSON.stringify(a)).join(',');
        csInterface.evalScript(`${functionName}(${argStr})`, (result) => {
            if (result === 'EvalScript error.') {
                resolve({ success: false, error: result });
                return;
            }
            try {
                resolve(JSON.parse(result));
            } catch(e) {
                resolve(result);
            }
        });
    });
}

function callExtendScriptCommand(command, payload) {
    return callExtendScript('editflowDispatch', command, normalizePremiereCommandParams(payload || {}));
}

function normalizePremiereCommandParams(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload || {};
    const aliases = {
        target_bin: 'targetBin',
        bin_name: 'binName',
        sequence_name: 'sequenceName',
        clip_name: 'clipName',
        track_index: 'trackIndex',
        track_type: 'trackType',
        start_time: 'startTime',
        new_start_time: 'newStartTime',
        label_name: 'labelName',
        effect_name: 'effectName',
        transition_name: 'transitionName',
        clip_index: 'clipIndex',
        level_db: 'levelDb',
        target_db: 'targetDb',
        fade_in: 'fadeIn',
        fade_out: 'fadeOut',
        output_path: 'outputPath',
        preset_path: 'presetPath',
        media_type: 'mediaType',
    };
    const normalized = { ...payload };
    for (const [oldKey, newKey] of Object.entries(aliases)) {
        if (Object.prototype.hasOwnProperty.call(normalized, oldKey) &&
            !Object.prototype.hasOwnProperty.call(normalized, newKey)) {
            normalized[newKey] = normalized[oldKey];
        }
    }
    if (normalized.mode === 'label' && !normalized.labelName && normalized.label) {
        normalized.labelName = normalized.label;
    }
    if (Array.isArray(normalized.rules)) {
        normalized.rules = normalized.rules.map(rule => normalizePremiereCommandParams(rule));
    }
    return normalized;
}

async function syncSequenceStateFromPremiere() {
    if (!csInterface) return null;

    const state = await callExtendScript('getSequenceState');
    if (!state || typeof state !== 'object') return null;
    if (state.success === false) {
        console.warn('Could not read Premiere sequence:', state.error);
        return null;
    }

    try {
        const normalized = normalizeSequenceState(state);
        sequenceContext = normalized;
        await apiPost('/api/sequence/state', normalized, 5000);
        await apiPost('/api/premiere/snapshot', {
            snapshot_type: 'sequence',
            payload: normalized,
        }, 5000).catch(e => {});
        return normalized;
    } catch(e) {
        console.warn('Could not sync sequence state:', e);
    }
    return null;
}

function pickValue(primary, fallback, defaultValue) {
    if (primary !== undefined && primary !== null) return primary;
    if (fallback !== undefined && fallback !== null) return fallback;
    return defaultValue;
}

function numberValue(value, defaultValue) {
    const n = Number(value);
    return Number.isFinite(n) ? n : defaultValue;
}

function normalizeSequenceState(state) {
    const clips = Array.isArray(state.clips) ? state.clips : [];
    return {
        name: state.name || 'Untitled Sequence',
        width: numberValue(state.width, 1080),
        height: numberValue(state.height, 1920),
        fps: numberValue(state.fps, 60),
        duration: numberValue(state.duration, 0),
        video_tracks: numberValue(pickValue(state.video_tracks, state.videoTracks, 0), 0),
        audio_tracks: numberValue(pickValue(state.audio_tracks, state.audioTracks, 0), 0),
        clips: clips.map((clip) => ({
            name: clip.name || '',
            path: pickValue(clip.path, clip.mediaPath, ''),
            track_index: numberValue(pickValue(clip.track_index, clip.trackIndex, 0), 0),
            track_type: pickValue(clip.track_type, clip.trackType, 'video'),
            in_point: numberValue(pickValue(clip.in_point, clip.inPoint, 0), 0),
            out_point: numberValue(pickValue(clip.out_point, clip.outPoint, 0), 0),
            start_time: numberValue(pickValue(clip.start_time, clip.startTime, 0), 0),
            end_time: numberValue(pickValue(clip.end_time, clip.endTime, 0), 0),
            duration: numberValue(clip.duration, 0),
            scale: numberValue(clip.scale, 100),
            speed: numberValue(clip.speed, 1),
        })),
    };
}

// ════════════════════════════════════════════
// Settings Panel
// ════════════════════════════════════════════

function openSettings() {
    settingsOverlay.classList.remove('hidden');
    loadProvidersList();
}

function closeSettings() {
    settingsOverlay.classList.add('hidden');
    hideProviderForm();
}

async function loadProvidersList() {
    try {
        const data = await apiGet('/api/providers', 5000);
        providers = Array.isArray(data) ? data : [];
        renderProvidersList();
    } catch(e) {
        providersList.innerHTML = `<div class="provider-card"><div class="provider-card-error">Failed to load providers: ${escapeHtml(e.message)}</div></div>`;
    }
}

function renderProvidersList() {
    providersList.innerHTML = '';

    for (const p of providers) {
        const card = document.createElement('div');
        card.className = 'provider-card';
        card.dataset.id = p.id;

        const statusClass = p.status === 'connected' ? 'connected' :
                           p.status === 'error' ? 'error' :
                           p.status === 'connecting' ? 'connecting' : '';

        const typeLabel = p.type === 'ollama' ? 'Ollama' :
                         p.type === 'openai_compatible' ? 'OpenAI Compatible' :
                         'Custom';

        card.innerHTML = `
            <div class="provider-card-header">
                <div class="provider-card-name">
                    <span class="provider-status-dot ${statusClass}"></span>
                    ${escapeHtml(p.name)}
                </div>
                <div class="provider-card-actions">
                    ${!p.is_default ? `<button class="btn btn-danger" onclick="removeProvider('${p.id}')">Remove</button>` : ''}
                    <button class="btn btn-small btn-secondary" onclick="editProvider('${p.id}')">Edit</button>
                    <button class="btn btn-small btn-secondary" onclick="discoverModels('${p.id}')">Refresh</button>
                </div>
            </div>
            <div class="provider-card-meta">
                <span>${typeLabel} | ${escapeHtml(p.base_url)}</span>
                ${p.error ? `<span class="provider-card-error">${escapeHtml(p.error)}</span>` : ''}
                ${p.chat_model ? `<span>Chat: ${escapeHtml(p.chat_model)}</span>` : ''}
            </div>
        `;

        providersList.appendChild(card);
    }
}

function showProviderForm(providerId) {
    editingProviderId = providerId || null;
    providerForm.classList.remove('hidden');

    if (providerId) {
        const p = providers.find(p => p.id === providerId);
        if (p) {
            providerFormTitle.textContent = 'Edit Provider';
            pfName.value = p.name || '';
            pfType.value = p.type || 'openai_compatible';
            pfBaseUrl.value = p.base_url || '';
            pfApiKey.value = '';  // Don't expose the API key
            pfTimeout.value = p.timeout || 10;
            pfChatModel.value = p.chat_model || '';
            pfVisionModel.value = p.vision_model || '';
        }
    } else {
        providerFormTitle.textContent = 'Add Provider';
        pfName.value = '';
        pfType.value = 'openai_compatible';
        pfBaseUrl.value = '';
        pfApiKey.value = '';
        pfTimeout.value = 10;
        pfChatModel.value = '';
        pfVisionModel.value = '';
    }

    pfTestResult.classList.add('hidden');
}

function hideProviderForm() {
    providerForm.classList.add('hidden');
    editingProviderId = null;
}

async function editProvider(providerId) {
    showProviderForm(providerId);
}

async function removeProvider(providerId) {
    if (!confirm('Remove this provider?')) return;

    try {
        await apiDelete(`/api/providers/${providerId}`, 5000);
        await loadProvidersList();
        await loadModels();  // Refresh model list
    } catch(e) {
        alert('Failed to remove provider: ' + e.message);
    }
}

async function discoverModels(providerId, options = {}) {
    try {
        await apiPost(`/api/providers/${providerId}/discover?force=true`, {}, 15000);
        await loadModels();
        await loadProvidersList();
        if (!options.silent) {
            addMessage('system', `Models refreshed for provider`);
        }
    } catch(e) {
        console.error('Failed to discover models:', e);
        if (!options.silent) {
            addMessage('system', 'Failed to refresh models: ' + e.message);
        }
    }
}

async function saveProvider() {
    const config = {
        name: pfName.value.trim() || 'Custom Provider',
        type: pfType.value,
        base_url: pfBaseUrl.value.trim(),
        timeout: parseInt(pfTimeout.value) || 10,
        chat_model: pfChatModel.value.trim(),
        vision_model: pfVisionModel.value.trim(),
    };
    const apiKey = pfApiKey.value.trim();
    if (apiKey || !editingProviderId) {
        config.api_key = apiKey;
    }

    if (!config.base_url) {
        alert('Base URL is required');
        return;
    }

    try {
        let savedProvider;
        if (editingProviderId) {
            savedProvider = await apiPut(`/api/providers/${editingProviderId}`, config, 10000);
        } else {
            savedProvider = await apiPost('/api/providers', config, 10000);
        }

        hideProviderForm();
        await loadProvidersList();
        await loadModels();  // Refresh model list
        if (savedProvider && savedProvider.id) {
            await discoverModels(savedProvider.id, { silent: true });
        }
    } catch(e) {
        alert('Failed to save provider: ' + (e.message || 'Unknown error'));
    }
}

async function testProviderConnection() {
    pfTestResult.classList.remove('hidden', 'success', 'error');
    pfTestResult.textContent = 'Testing connection...';

    // First save the provider if it's new
    const config = {
        name: pfName.value.trim() || 'Test Provider',
        type: pfType.value,
        base_url: pfBaseUrl.value.trim(),
        timeout: parseInt(pfTimeout.value) || 10,
        chat_model: pfChatModel.value.trim(),
        vision_model: pfVisionModel.value.trim(),
    };
    const apiKey = pfApiKey.value.trim();
    if (apiKey || !editingProviderId) {
        config.api_key = apiKey;
    }

    if (!config.base_url) {
        pfTestResult.textContent = 'Base URL is required';
        pfTestResult.classList.add('error');
        return;
    }

    try {
        let testProviderId = editingProviderId;

        // Save first if new
        if (!testProviderId) {
            const result = await apiPost('/api/providers', config, 10000);
            testProviderId = result.id;
            editingProviderId = testProviderId;
        } else {
            await apiPut(`/api/providers/${testProviderId}`, config, 10000);
        }

        // Now test
        const result = await apiPost(`/api/providers/${testProviderId}/test`, {}, 15000);

        if (result.success) {
            pfTestResult.textContent = `Success! Response: "${result.response}"`;
            pfTestResult.classList.add('success');
        } else {
            pfTestResult.textContent = `Failed: ${result.error || 'Unknown error'}`;
            pfTestResult.classList.add('error');
        }
    } catch(e) {
        pfTestResult.textContent = `Error: ${e.message}`;
        pfTestResult.classList.add('error');
    }
}

async function testBackendConnection() {
    backendStatus.textContent = 'Testing...';
    backendStatus.className = 'backend-status';

    const url = backendUrlInput.value.replace(/\/+$/, '');

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        try {
            const resp = await fetch(`${url}/api/status`, {
                signal: controller.signal,
            });
            clearTimeout(timer);
            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}`);
            }
            const data = await resp.json();
        backendStatus.textContent = `Connected! v${data.version || '0.1'}`;
        backendStatus.className = 'backend-status success';
        BACKEND_URL = url;
        localStorage.setItem('editflow_backend_url', url);
        // Refresh everything
        await loadModels();
    } catch(e) {
        backendStatus.textContent = 'Failed: ' + e.message;
        backendStatus.className = 'backend-status error';
    }
}

// Active model change from settings
activeChatSelect.addEventListener('change', async () => {
    const val = activeChatSelect.value;
    if (!val) return;
    const [providerId, model] = val.split('||');
    try {
        await apiPost('/api/providers/set-active', {
            provider_id: providerId,
            model: model,
            role: 'chat',
        });
        await loadModels();  // Refresh to update active indicators
    } catch(e) {
        console.error('Failed to set active chat model:', e);
    }
});

activeVisionSelect.addEventListener('change', async () => {
    const val = activeVisionSelect.value;
    if (!val) return;
    const [providerId, model] = val.split('||');
    try {
        await apiPost('/api/providers/set-active', {
            provider_id: providerId,
            model: model,
            role: 'vision',
        });
        await loadModels();
    } catch(e) {
        console.error('Failed to set active vision model:', e);
    }
});

// ════════════════════════════════════════════
// UI Helpers
// ════════════════════════════════════════════

function renderMarkdown(text) {
    if (!text) return '';
    let html = text.replace(/&/g, '&amp;')
                   .replace(/</g, '&lt;')
                   .replace(/>/g, '&gt;');
                   
    // Bold
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    // Code blocks
    html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    // Lists (simple)
    html = html.replace(/^- (.*)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
    // Line breaks
    html = html.replace(/\n/g, '<br>');
    
    // Clean up ul br
    html = html.replace(/<\/li><br>/g, '</li>');
    html = html.replace(/<ul><br>/g, '<ul>');
    
    return html;
}

function addMessage(role, content, intent) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    if (role === 'assistant') {
        contentDiv.innerHTML = renderMarkdown(content);
    } else {
        contentDiv.textContent = content;
    }
    div.appendChild(contentDiv);

    if (intent && role === 'assistant' && intent !== 'chat' && intent !== 'UNKNOWN') {
        const badge = document.createElement('div');
        badge.className = 'intent-badge';
        badge.textContent = intent;
        div.appendChild(badge);
    }

    const welcome = chatMessages.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showTyping(show) {
    let indicator = chatMessages.querySelector('.typing-indicator');
    if (show) {
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.className = 'typing-indicator';
            indicator.innerHTML = '<span></span><span></span><span></span>';
            chatMessages.appendChild(indicator);
        }
    } else {
        if (indicator) indicator.remove();
    }
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showProgress(taskType, progress, message, status) {
    let progressBar = chatMessages.querySelector(`.progress-bar[data-task="${taskType}"]`);
    if (!progressBar) {
        const msg = document.createElement('div');
        msg.className = 'message assistant';
        msg.innerHTML = `
            <div>${message}</div>
            <div class="progress-bar" data-task="${taskType}">
                <div class="progress-bar-fill" style="width: ${progress * 100}%"></div>
            </div>
        `;
        chatMessages.appendChild(msg);
        progressBar = msg.querySelector('.progress-bar');
    }
    progressBar.querySelector('.progress-bar-fill').style.width = `${progress * 100}%`;

    if (status === 'completed' || status === 'failed') {
        setTimeout(() => progressBar?.parentElement?.remove(), 3000);
    }
}

function showScriptPreview(script) {
    scriptPreview.classList.remove('hidden');
    currentV2PlanId = null;
    currentV2DryRun = null;
    currentScriptId = script.id;
    refineBtn.style.display = '';
    executeBtn.textContent = 'Execute';
    executeBtn.disabled = false;
    scriptTitle.textContent = script.title || 'Generated Script';

    let content = '';
    if (script.sections) {
        script.sections.forEach(section => {
            content += `\n--- ${section.name} ---\n`;
            content += `${section.description}\n`;
            if (section.clips) {
                section.clips.forEach(clip => {
                    content += `  ${clip.clip_type}: ${clip.source_file} [${clip.in_point}s-${clip.out_point}s] @${clip.start_time}s\n`;
                });
            }
        });
    }
    content += `\nTotal Duration: ${script.total_duration}s | Clips: ${script.all_clips?.length || 0} | Version: ${script.version || 1}`;
    scriptContent.textContent = content;
}

function showV2ReferencePreview(resolved) {
    scriptPreview.classList.remove('hidden');
    currentV2PlanId = null;
    currentV2DryRun = null;
    currentScriptId = null;
    refineBtn.style.display = 'none';
    executeBtn.textContent = 'Phase 2 Disabled';
    executeBtn.disabled = true;
    scriptTitle.textContent = 'Reference Check';

    const items = resolved.items || [];
    let content = '';
    content += `Reference: ${formatResolvedReference(resolved)}\n`;
    content += `Kind: ${resolved.kind || 'unknown'}\n`;
    content += `Media files: ${resolved.media_count || 0}\n\n`;
    if (items.length) {
        content += 'Items:\n';
        items.forEach((item, index) => {
            const name = item.name || item.media_path || 'unknown';
            const mediaPath = item.media_path || '(no media path)';
            content += `${index + 1}. ${name}\n   ${mediaPath}\n`;
        });
    } else if (resolved.media_paths && resolved.media_paths.length) {
        content += 'Files:\n';
        resolved.media_paths.forEach((path, index) => {
            content += `${index + 1}. ${path}\n`;
        });
    }
    if (resolved.warnings && resolved.warnings.length) {
        content += `\nWarnings:\n${resolved.warnings.join('\n')}\n`;
    }
    content += '\nPhase 1 mode: no dry run, import, sequence creation, or execution is allowed yet.';
    scriptContent.textContent = content;
}

function showV2DryRunPreview(dryRun) {
    scriptPreview.classList.remove('hidden');
    currentScriptId = null;
    scriptTitle.textContent = 'V2 Dry Run';
    executeBtn.textContent = 'Execute';
    executeBtn.disabled = false;
    refineBtn.style.display = 'none';

    const coverage = dryRun.script_coverage || [];
    const timelineItems = dryRun.timeline_items || [];
    const visuals = dryRun.visual_placements || [];
    const missing = dryRun.missing_lines || [];
    let content = '';
    content += `Plan: ${dryRun.plan_id}\n`;
    content += `Estimated duration: ${dryRun.estimated_duration || 0}s\n`;
    content += `Timeline items: ${dryRun.would_change || 0}\n`;
    content += `Missing lines: ${missing.length}\n\n`;
    if (timelineItems.length) {
        content += 'Timeline items\n';
        timelineItems.slice(0, 50).forEach((item, index) => {
            content += `${index + 1}. ${item.name || item.asset_id} @ ${item.start_time || 0}s for ${item.duration || 0}s\n`;
            if (item.warning) {
                content += `   warning: ${item.warning}\n`;
            }
        });
        content += '\n';
    }
    content += 'Script coverage\n';
    coverage.slice(0, 25).forEach((item, index) => {
        const status = item.candidate_id ? 'matched' : 'missing';
        content += `${index + 1}. ${status}: ${item.text || ''}\n`;
        if (item.transcript_excerpt) {
            content += `   -> ${item.transcript_excerpt}\n`;
        }
        if (item.warning) {
            content += `   warning: ${item.warning}\n`;
        }
    });
    if (coverage.length > 25) {
        content += `...${coverage.length - 25} more line(s)\n`;
    }

    if (visuals.length) {
        content += '\nVisual placements\n';
        visuals.slice(0, 25).forEach((item, index) => {
            content += `${index + 1}. ${item.keyword || 'visual'} -> ${item.visual_asset_id || 'missing asset'}\n`;
            if (item.warning) {
                content += `   warning: ${item.warning}\n`;
            }
        });
    }

    scriptContent.textContent = content;
}

function formatSequenceState(state) {
    if (!state || !state.clips) return 'No active sequence found.';
    let msg = `Sequence: ${state.name}\n`;
    msg += `Resolution: ${state.width}x${state.height} @ ${state.fps}fps\n`;
    msg += `Duration: ${state.duration}s | Tracks: ${state.video_tracks}V ${state.audio_tracks}A\n`;
    msg += `Clips on timeline: ${state.clips.length}`;
    return msg;
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ── Periodic Health Check ──
setInterval(async () => {
    await checkBackendHealth();
}, 30000);  // Every 30 seconds

// ── Start ──
init();
