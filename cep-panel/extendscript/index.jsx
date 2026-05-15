/**
 * EditFlow AI - ExtendScript Bridge Index
 * Main entry point for ExtendScript modules.
 * Called from CEP panel via CSInterface.evalScript()
 */

function editflowLoadModule(fileName) {
    var base = new File($.fileName).parent;
    var moduleFile = new File(base.fsName + "/" + fileName);
    if (!moduleFile.exists) {
        throw new Error("EditFlow module not found: " + moduleFile.fsName);
    }
    $.evalFile(moduleFile);
}

editflowLoadModule("json2.jsx");
editflowLoadModule("utils.jsx");
editflowLoadModule("project_scanner.jsx");
editflowLoadModule("sequence_reader.jsx");
editflowLoadModule("clip_manager.jsx");
editflowLoadModule("effects_manager.jsx");
editflowLoadModule("track_manager.jsx");
editflowLoadModule("audio_manager.jsx");
editflowLoadModule("export_manager.jsx");
editflowLoadModule("marker_manager.jsx");
/**
 * Stable command dispatcher for CEP calls.
 * Passing JSON strings avoids ExtendScript eval quirks with object literals.
 * @param {string} command
 * @param {string} payloadJson
 * @returns {string} JSON result
 */
function editflowDispatch(command, payloadData) {
    try {
        var payload = {};
        if (typeof payloadData === "string" && payloadData !== "") {
            try { 
                payload = JSON.parse(payloadData);
            } catch(e1) {
                try { payload = eval("(" + payloadData + ")"); } catch(e2){}
            }
        } else if (payloadData) {
            payload = payloadData;
        }

        if (command === "removeTimelineClips") {
            return JSON.stringify(clipManager.removeTimelineClips(payload));
        }
        if (command === "clearTimelineLabels") {
            return JSON.stringify(clipManager.clearTimelineLabels(payload));
        }
        if (command === "getProjectState") {
            return JSON.stringify(projectScanner.scanAll());
        }
        if (command === "getSequenceState") {
            return JSON.stringify(sequenceReader.readCurrentSequence());
        }
        if (command === "getSelectedClips") {
            return JSON.stringify(sequenceReader.getSelectedClips());
        }
        if (command === "runTemplateScript") {
            return JSON.stringify(runTemplateScript(payload));
        }
        if (command === "runGeneratedScript") {
            return JSON.stringify(runGeneratedScript(payload));
        }
        if (command === "verifyTimelineChange") {
            return JSON.stringify(sequenceReader.verifyTimelineChange(payload));
        }
        if (command === "undoLastEditFlowJob") {
            return undoLastAction(payload);
        }
        if (command === "scanProject") return JSON.stringify(projectScanner.scanAll());
        if (command === "addMediaToTimeline") return JSON.stringify(clipManager.addMediaToTimeline(payload));
        if (command === "importFiles") return JSON.stringify(clipManager.importFilesFromPaths(payload));
        if (command === "addAllBinClips") return JSON.stringify(clipManager.addAllBinClipsToSequence(payload));
        if (command === "insertClipAtTime") return JSON.stringify(clipManager.insertClipAtTime(payload));
        if (command === "moveClip") return JSON.stringify(clipManager.moveClipByOptions(payload));
        if (command === "modifyClip") return JSON.stringify(clipManager.modifyClipByOptions(payload));
        if (command === "createSequence") return JSON.stringify(clipManager.createNewSequence(payload));
        if (command === "organizeBin") return JSON.stringify(clipManager.organizeIntoBins(payload));
        if (command === "setClipLabel") return JSON.stringify(clipManager.setClipLabelColor(payload));
        if (command === "manageTracks") return JSON.stringify(trackManager.manageTracks(payload));
        if (command === "applyEffect") return JSON.stringify(effectsManager.applyEffectToClip(payload));
        if (command === "applyTransitionToAll") return JSON.stringify(effectsManager.applyTransitionToAll(payload));
        if (command === "setAudioLevel") return JSON.stringify(audioManager.setAudioLevelWrapper(payload));
        if (command === "normalizeAudio") return JSON.stringify(audioManager.normalizeAudioWrapper(payload));
        if (command === "audioFade") return JSON.stringify(audioManager.audioFadeWrapper(payload));
        if (command === "exportSequence") return JSON.stringify(exportManager.exportCurrentSequence(payload));
        if (command === "addMarker") return JSON.stringify(markerManager.addMarkerToSequence(payload));
        if (command === "undoAction") return undoLastAction(payload);

        return JSON.stringify({
            success: false,
            error: "Unknown EditFlow command: " + command
        });
    } catch (e) {
        var errInfo = {
            success: false,
            error: e.toString(),
            line: e.line || "unknown"
        };
        try {
            return JSON.stringify(errInfo);
        } catch(e2) {
            return '{"success":false,"error":"JSON stringify failed after error: ' + e.toString().replace(/"/g, "'") + '"}';
        }
    }

}

function runTemplateScript(payload) {
    try {
        payload = payload || {};
        var templateCommand = payload.command || payload.templateCommand || "";
        if (!templateCommand) {
            return { success: false, error: "Template command is required" };
        }

        var raw = editflowDispatch(templateCommand, payload.parameters || {});
        try {
            return JSON.parse(raw);
        } catch(e) {
            return { success: false, error: "Template command returned invalid JSON", raw: raw };
        }
    } catch(e2) {
        return { success: false, error: e2.toString(), line: e2.line || "unknown" };
    }
}

function runGeneratedScript(payload) {
    payload = payload || {};
    if (payload.allowGeneratedJsx !== true) {
        return {
            success: false,
            error: "Generated JSX execution is disabled until the backend validator marks the script as approved."
        };
    }
    return {
        success: false,
        error: "Generated JSX approval was provided, but the runtime executor is intentionally not enabled in this bridge yet."
    };
}

/**
 * Main bridge function - processes EDL instructions from the Python backend.
 * @param {string} edlJsonPath - Path to the EDL JSON file
 * @returns {string} JSON result
 */
function processEDL(edlJsonPath) {
    try {
        var result = clipManager.processEDL(edlJsonPath);
        return JSON.stringify(result);
    } catch (e) {
        return JSON.stringify({
            success: false,
            error: e.toString(),
            line: e.line
        });
    }
}

/**
 * Get current sequence state for the backend.
 * @returns {string} JSON of sequence state
 */
function getSequenceState() {
    try {
        var state = sequenceReader.readCurrentSequence();
        return JSON.stringify(state);
    } catch (e) {
        return JSON.stringify({
            success: false,
            error: e.toString()
        });
    }
}

/**
 * Scan project for all media files.
 * @returns {string} JSON of project media
 */
function scanProjectMedia() {
    try {
        var media = projectScanner.scanAll();
        return JSON.stringify(media);
    } catch (e) {
        return JSON.stringify({
            success: false,
            error: e.toString()
        });
    }
}

/**
 * Remove clips from the active sequence using a structured rule.
 * @param {Object|string} options - Removal options from the CEP panel
 * @returns {string} JSON result
 */
function removeTimelineClips(options) {
    try {
        if (typeof options === "string") {
            options = eval("(" + options + ")");
        }
        var result = clipManager.removeTimelineClips(options || {});
        return JSON.stringify(result);
    } catch (e) {
        return JSON.stringify({
            success: false,
            error: e.toString(),
            line: e.line
        });
    }
}

/**
 * Clear/reset a label color from clips in the active sequence.
 * @param {Object|string} options
 * @returns {string} JSON result
 */
function clearTimelineLabels(options) {
    try {
        if (typeof options === "string") {
            options = eval("(" + options + ")");
        }
        var result = clipManager.clearTimelineLabels(options || {});
        return JSON.stringify(result);
    } catch (e) {
        return JSON.stringify({
            success: false,
            error: e.toString(),
            line: e.line
        });
    }
}

/**
 * Undo the last EditFlow action group.
 * @param {string} undoGroup - Name of the undo group to revert
 * @returns {string} JSON result
 */
function undoLastAction(options) {
    try {
        app.enableQE();
        if (qe && qe.project) {
            var count = options && typeof options.count === 'number' ? options.count : 1;
            for (var i = 0; i < count; i++) {
                qe.project.undo();
            }
            return JSON.stringify({ success: true, undid: count });
        }
        return JSON.stringify({ success: false, error: "QE DOM not available for Undo." });
    } catch (e) {
        return JSON.stringify({
            success: false,
            error: e.toString()
        });
    }
}
