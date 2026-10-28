/*
 * index.jsx - Main ExtendScript entry point for EditFlow AI v2.
 * Loads all modules and provides the editflowDispatch() command router
 * that the CEP panel calls via CSInterface.evalScript().
 *
 * This is the bridge between the HTML/JS panel and Premiere Pro's DOM.
 */
// ── Load Dependencies ──
var editflowLoadErrors = [];
var editflowConfiguredScriptDir = "";
var editflowModuleNames = [
    "json2.jsx",
    "utils.jsx",
    "sequence_reader.jsx",
    "project_scanner.jsx",
    "clip_manager.jsx",
    "audio_manager.jsx",
    "marker_manager.jsx",
    "track_manager.jsx",
    "export_manager.jsx",
    "effects_manager.jsx",
    "capability_probe.jsx",
    "captions_manager.jsx"
];

function editflowEscapeJSON(value) {
    return String(value)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, "\\\"")
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n");
}

function editflowErrorResult(error, command) {
    var message = error && error.toString ? error.toString() : String(error);
    var cmd = command || "";
    try {
        if (typeof editflowUtils !== "undefined" && editflowUtils.safeStringify) {
            return editflowUtils.safeStringify({
                success: false,
                error: message,
                command: cmd
            });
        }
    } catch (ignore) {}

    return '{"success":false,"error":"' + editflowEscapeJSON(message) +
        '","command":"' + editflowEscapeJSON(cmd) + '"}';
}

function editflowSuccessResult(obj) {
    try {
        if (typeof editflowUtils !== "undefined" && editflowUtils.safeStringify) {
            return editflowUtils.safeStringify(obj);
        }
    } catch (ignore) {}

    var scriptDir = obj && obj.scriptDir ? obj.scriptDir : "";
    return '{"success":true,"scriptDir":"' + editflowEscapeJSON(scriptDir) + '"}';
}

function editflowGetScriptDir(scriptFile) {
    var slashIndex = scriptFile.lastIndexOf('/');
    var backslashIndex = scriptFile.lastIndexOf('\\');
    var separatorIndex = Math.max(slashIndex, backslashIndex);
    if (separatorIndex >= 0) {
        return scriptFile.substring(0, separatorIndex).replace(/\\/g, '/');
    }

    try {
        return File(scriptFile).parent.fsName.replace(/\\/g, '/');
    } catch (e) {
        return "";
    }
}

function editflowNormalizePath(path) {
    return String(path || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function editflowGetExtendScriptDir(extensionRoot) {
    var root = editflowNormalizePath(extensionRoot);
    if (!root) return "";
    if (/\/extendscript$/i.test(root)) return root;
    return root + '/extendscript';
}

function editflowLoadModule(path) {
    try {
        var file = new File(path);
        if (file.exists) {
            $.evalFile(file);
        } else {
            throw new Error("module not found: " + path);
        }
    } catch (e) {
        var message = "Failed to load module " + path + ": " + e.toString();
        editflowLoadErrors.push(message);
        try {
            $.writeln("EditFlow: " + message);
        } catch (ignore) {}
    }
}

function editflowLoadAllModules(baseDir) {
    var normalizedBaseDir = editflowNormalizePath(baseDir);
    editflowLoadErrors = [];
    editflowConfiguredScriptDir = normalizedBaseDir;

    for (var i = 0; i < editflowModuleNames.length; i++) {
        editflowLoadModule(normalizedBaseDir + '/' + editflowModuleNames[i]);
    }

    return editflowLoadErrors.length === 0;
}

function editflowConfigureExtensionRoot(extensionRoot, forceReload) {
    var baseDir = editflowGetExtendScriptDir(extensionRoot);
    if (!baseDir) {
        editflowLoadErrors = ["CEP extension root was empty."];
        return editflowErrorResult(new Error(editflowLoadErrors[0]), "configureExtensionRoot");
    }

    // Fast path: same dir, clean load, core module present → nothing to do.
    // forceReload (panel 🔁 / dev_reload) bypasses this so .jsx edits on
    // disk are actually re-evaluated — otherwise the engine keeps serving
    // the stale in-memory modules forever (one stale module can never heal).
    if (
        !forceReload &&
        baseDir === editflowConfiguredScriptDir &&
        editflowLoadErrors.length === 0 &&
        typeof projectScanner !== "undefined"
    ) {
        return editflowSuccessResult({ success: true, scriptDir: baseDir });
    }

    editflowLoadAllModules(baseDir);
    if (editflowLoadErrors.length > 0) {
        return editflowErrorResult(
            new Error("ExtendScript modules failed to load from " + baseDir + ": " + editflowLoadErrors.join(" | ")),
            "configureExtensionRoot"
        );
    }

    return editflowSuccessResult({ success: true, scriptDir: baseDir });
}

// Load modules relative to this script's location
var scriptFile = $.fileName;
var scriptDir = editflowGetScriptDir(scriptFile);

editflowLoadAllModules(scriptDir);


// ── Command Dispatcher ──
var _undoCounter = 0;

function editflowAssertReady(command) {
    if (editflowLoadErrors.length > 0) {
        throw new Error(
            "ExtendScript modules failed to load for " + (command || "command") +
            ": " + editflowLoadErrors.join(" | ")
        );
    }
}

function editflowArrayContains(items, value) {
    for (var i = 0; i < items.length; i++) {
        if (items[i] === value) return true;
    }
    return false;
}

function editflowDispatch(command, payloadData) {
    /*
     * Main command router called from the CEP panel.
     *
     * @param {string} command - The action to perform
     * @param {string} payloadData - JSON string with command parameters
     * @returns {string} - JSON string with the result
     */
    try {
        editflowAssertReady(command);

        var options = {};
        if (payloadData) {
            try {
                options = JSON.parse(payloadData);
            } catch (e) {
                options = {};
            }
        }

        var result;

    switch (command) {
        // ── Project Scanning ──
        case "getProjectDirectory": {
            var prjPath = "";
            var prjDir = "";
            try {
                if (app.project && app.project.path) {
                    prjPath = app.project.path;
                    var fileObj = new File(prjPath);
                    if (fileObj.parent && fileObj.parent.fsName) {
                        prjDir = fileObj.parent.fsName;
                    }
                }
            } catch (pErr) {}
            result = JSON.stringify({
                success: true,
                projectPath: prjPath,
                projectDirectory: prjDir
            });
            break;
        }

        case "scanProject":
        case "scanProjectMedia":
        case "getProjectState":
            result = projectScanner.scanAll();
            break;

        case "getSelectedProjectItems":
            result = getSelectedProjectItems();
            break;

        // ── Sequence State ──
        case "getSequenceState":
            result = sequenceReader.readCurrentSequence();
            break;

        case "getSelectedClips":
            result = sequenceReader.getSelectedClips();
            break;

        case "verifyTimelineChange":
            result = sequenceReader.verifyTimelineChange(options);
            break;

        // ── Clip Operations ──
        case "addMediaToTimeline":
            result = clipManager.addMediaToTimeline(options);
            break;

        case "importFiles":
            result = clipManager.importFilesFromPaths(options);
            break;

        case "insertClipAtTime":
            result = clipManager.insertClipAtTime(options);
            break;

        case "moveClip":
            result = clipManager.moveClipOnSequence(
                app.project.activeSequence, options
            );
            result = editflowUtils.safeStringify(result);
            break;

        case "modifyClip":
            result = clipManager.modifyClipOnSequence(
                app.project.activeSequence, options
            );
            result = editflowUtils.safeStringify(result);
            break;

        
        case "openSequence":
            result = clipManager.openSequence(options);
            break;

        case "createSequence":
            result = clipManager.createNewSequence(options);
            break;

        case "createBin":
        case "ensureBin":
            result = editflowUtils.safeStringify(clipManager.ensureBin(options));
            break;

        case "organizeBin":
            result = clipManager.organizeIntoBins(options);
            break;

        case "setClipLabel":
            result = clipManager.setClipLabelColor(options);
            break;

        case "removeTimelineClips":
            result = clipManager.removeTimelineClips(options);
            break;

        case "clearTimelineLabels":
            result = clipManager.clearTimelineLabels(options);
            break;

        // ── Track Operations ──
        case "manageTracks":
            result = trackManager.manageTracks(options);
            break;

        // ── Audio Operations ──
        case "setAudioLevel":
            result = audioManager.setAudioLevelWrapper(options);
            break;

        case "normalizeAudio":
            result = audioManager.normalizeAudioWrapper(options);
            break;

        case "audioFade":
            result = audioManager.audioFadeWrapper(options);
            break;

        // ── Marker Operations ──
        case "addMarker":
            result = markerManager.addMarkerToSequence(options);
            break;

        case "addPhraseRangeMarkers":
            result = markerManager.addPhraseRangeMarkers(options);
            break;

        case "getMarkers":
        case "getSequenceMarkers":
            result = markerManager.getSequenceMarkers();
            break;

        case "setChapterMarkers":
            result = markerManager.setChapterMarkers(options);
            break;

        // ── Active Sequence Phrase Removal ──
        case "removeTimelineRanges":
            result = clipManager.removeTimelineRanges(options);
            break;

        // ── Effects & Transitions ──
        case "applyEffect":
            result = effectsManager.applyEffectToClip(options);
            break;

        case "applyTransitionToAll":
            result = effectsManager.applyTransitionToAll(options);
            break;

        // ── Export ──
        case "exportSequence":
            result = exportManager.exportCurrentSequence(options);
            break;

        // ── Captions (Tier-1 native: SRT -> caption track) ──
        case "importCaptionsFromSRT":
            result = captionsManager.importSRTAsCaptionTrack(options);
            break;

        // ── Generic module call ──
        // Stability mechanism: index.jsx itself only (re-)evaluates at
        // Premiere/extension start — edits here need a Premiere restart.
        // Module files re-evaluate on every forced configure (🔁), so route
        // ALL future commands through here: {module, fn, ...args}. New
        // caption/cut commands then hot-reload with no restart, ever again.
        case "callModule": {
            var modName = editflowUtils.getParam(options, 'module');
            var fnName = editflowUtils.getParam(options, 'fn', 'func');
            var target = null;
            try {
                target = eval(modName);
            } catch (e0) {
                target = null;
            }
            if (!target || typeof target[fnName] !== "function") {
                result = editflowUtils.safeStringify({
                    success: false,
                    error: "Unknown module fn: " + modName + "." + fnName
                });
            } else {
                try {
                    var callOut = target[fnName](options);
                    result = (typeof callOut === "string")
                        ? callOut
                        : editflowUtils.safeStringify(callOut);
                } catch (e1) {
                    result = editflowUtils.safeStringify({
                        success: false, error: e1.toString()
                    });
                }
            }
            break;
        }

        // ── Capability Probe ──
        case "probeCapabilities":
            result = editflowUtils.safeStringify({
                success: true,
                capabilities: capabilityProbe.probe()
            });
            break;

        // ── Undo ──
        case "undoAction":
            var steps = editflowUtils.getParam(options, 'steps') || 1;
            var undone = 0;
            try {
                if (typeof qe !== 'undefined') {
                    for (var i = 0; i < steps; i++) {
                        qe.project.undoAction();
                        undone++;
                    }
                }
            } catch (e) {}
            _undoCounter -= undone;
            result = editflowUtils.safeStringify({ success: undone > 0, undoneSteps: undone });
            break;

        // ── Run Template Script ──
        case "runTemplateScript":
            var templateCommand = editflowUtils.getParam(options, 'command');
            var templatePayload = editflowUtils.getParam(options, 'payload');
            if (templateCommand) {
                result = editflowDispatch(templateCommand, templatePayload);
            } else {
                result = editflowUtils.safeStringify({ success: false, error: "No template command specified" });
            }
            break;

        // ── EDL Processing (inline ops from agent flow) ──
        case "processEDL":
            result = clipManager.processEDLOps(options);
            break;

        default:
            if (typeof $.global[command] === "function") {
                try {
                    var directRes = $.global[command](options);
                    result = (typeof directRes === "string") ? directRes : editflowUtils.safeStringify(directRes);
                } catch (eDirect) {
                    result = editflowUtils.safeStringify({ success: false, error: eDirect.toString() });
                }
            } else {
                result = editflowUtils.safeStringify({
                    success: false,
                    error: "Unknown command: " + command
                });
            }
    }

        // Track undo level for timeline-modifying operations
        var modifyingCommands = [
            "addMediaToTimeline", "insertClipAtTime", "moveClip", "modifyClip",
            "removeTimelineClips", "removeTimelineRanges",
            "clearTimelineLabels", "manageTracks",
            "setAudioLevel", "normalizeAudio", "audioFade", "addMarker", "addPhraseRangeMarkers",
            "applyEffect", "applyTransitionToAll", "setClipLabel", "processEDL",
            "importCaptionsFromSRT"
        ];
        if (editflowArrayContains(modifyingCommands, command)) {
            _undoCounter++;
        }

        return result;
    } catch (e) {
        return editflowErrorResult(e, command);
    }
}


// ── Standalone Top-Level Functions ──
// These can be called directly via CSInterface.evalScript()
// for backward compatibility and convenience.

function processEDL(edlJsonPath) {
    try {
        editflowAssertReady("processEDL");
        return clipManager.processEDL(edlJsonPath);
    } catch (e) {
        return editflowErrorResult(e, "processEDL");
    }
}

function getSequenceState() {
    try {
        editflowAssertReady("getSequenceState");
        return sequenceReader.readCurrentSequence();
    } catch (e) {
        return editflowErrorResult(e, "getSequenceState");
    }
}

function scanProjectMedia() {
    try {
        editflowAssertReady("scanProject");
        return projectScanner.scanAll();
    } catch (e) {
        return editflowErrorResult(e, "scanProject");
    }
}

function removeTimelineClips() {
    try {
        editflowAssertReady("removeTimelineClips");
        return clipManager.removeTimelineClips({ mode: "broll" });
    } catch (e) {
        return editflowErrorResult(e, "removeTimelineClips");
    }
}

function clearTimelineLabels() {
    try {
        editflowAssertReady("clearTimelineLabels");
        return clipManager.clearTimelineLabels({ label: "Iris" });
    } catch (e) {
        return editflowErrorResult(e, "clearTimelineLabels");
    }
}

function undoLastAction() {
    try {
        editflowAssertReady("undoAction");
        var undone = 0;
        try {
            if (typeof qe !== 'undefined') {
                qe.project.undoAction();
                undone = 1;
            }
        } catch (e) {}
        _undoCounter = Math.max(0, _undoCounter - 1);
        return editflowUtils.safeStringify({ success: undone > 0 });
    } catch (e) {
        return editflowErrorResult(e, "undoAction");
    }
}
