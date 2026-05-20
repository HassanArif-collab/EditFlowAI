/*
 * index.jsx - Main ExtendScript entry point for EditFlow AI v2.
 * Loads all modules and provides the editflowDispatch() command router
 * that the CEP panel calls via CSInterface.evalScript().
 *
 * This is the bridge between the HTML/JS panel and Premiere Pro's DOM.
 */
// ── Load Dependencies ──
function editflowLoadModule(path) {
    try {
        var file = new File(path);
        if (file.exists) {
            file.open('r');
            var content = file.read();
            file.close();
            eval(content);
        }
    } catch (e) {
        $.writeln("EditFlow: Failed to load module " + path + ": " + e.toString());
    }
}

// Load modules relative to this script's location
var scriptFile = $.fileName;
var scriptDir = scriptFile.substring(0, scriptFile.lastIndexOf('/'));

editflowLoadModule(scriptDir + '/json2.jsx');
editflowLoadModule(scriptDir + '/utils.jsx');
editflowLoadModule(scriptDir + '/sequence_reader.jsx');
editflowLoadModule(scriptDir + '/project_scanner.jsx');
editflowLoadModule(scriptDir + '/clip_manager.jsx');
editflowLoadModule(scriptDir + '/audio_manager.jsx');
editflowLoadModule(scriptDir + '/marker_manager.jsx');
editflowLoadModule(scriptDir + '/track_manager.jsx');
editflowLoadModule(scriptDir + '/export_manager.jsx');
editflowLoadModule(scriptDir + '/effects_manager.jsx');


// ── Command Dispatcher ──
var _undoCounter = 0;

function editflowDispatch(command, payloadData) {
    /*
     * Main command router called from the CEP panel.
     *
     * @param {string} command - The action to perform
     * @param {string} payloadData - JSON string with command parameters
     * @returns {string} - JSON string with the result
     */
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
        case "scanProject":
        case "getProjectState":
            result = projectScanner.scanAll();
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

        case "createSequence":
            result = clipManager.createNewSequence(options);
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

        case "getMarkers":
            result = markerManager.getSequenceMarkers();
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

        default:
            result = editflowUtils.safeStringify({
                success: false,
                error: "Unknown command: " + command
            });
    }

    // Track undo level for timeline-modifying operations
    var modifyingCommands = [
        "addMediaToTimeline", "insertClipAtTime", "moveClip", "modifyClip",
        "removeTimelineClips", "clearTimelineLabels", "manageTracks",
        "setAudioLevel", "normalizeAudio", "audioFade", "addMarker",
        "applyEffect", "applyTransitionToAll", "setClipLabel"
    ];
    if (modifyingCommands.indexOf(command) >= 0) {
        _undoCounter++;
    }

    return result;
}


// ── Standalone Top-Level Functions ──
// These can be called directly via CSInterface.evalScript()
// for backward compatibility and convenience.

function processEDL(edlJsonPath) {
    return clipManager.processEDL(edlJsonPath);
}

function getSequenceState() {
    return sequenceReader.readCurrentSequence();
}

function scanProjectMedia() {
    return projectScanner.scanAll();
}

function removeTimelineClips() {
    return clipManager.removeTimelineClips({ mode: "broll" });
}

function clearTimelineLabels() {
    return clipManager.clearTimelineLabels({ label: "Iris" });
}

function undoLastAction() {
    var undone = 0;
    try {
        if (typeof qe !== 'undefined') {
            qe.project.undoAction();
            undone = 1;
        }
    } catch (e) {}
    _undoCounter = Math.max(0, _undoCounter - 1);
    return editflowUtils.safeStringify({ success: undone > 0 });
}
