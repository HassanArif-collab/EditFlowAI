/*
 * clip_manager.jsx - Manage clips on the Premiere Pro timeline.
 * Handles adding, removing, moving, and organizing clips.
 * Also processes EDL (Edit Decision List) JSON files for batch operations.
 */
clipManager = (function() {
    "use strict";

    // ── Helper Utilities ──

    function _normPath(p) {
        if (!p) return "";
        try {
            var s = String(p).replace(/\\/g, "/");
            if (s.length > 1 && s.charAt(s.length - 1) === "/") {
                s = s.substring(0, s.length - 1);
            }
            return s.toLowerCase();
        } catch (e) {
            return String(p || "").toLowerCase();
        }
    }

    function _fileName(p) {
        if (!p) return "";
        try {
            var s = String(p).replace(/\\/g, "/");
            var idx = s.lastIndexOf("/");
            return (idx >= 0 ? s.substring(idx + 1) : s).toLowerCase();
        } catch (e) {
            return "";
        }
    }

    function _makeTime(seconds, ticksStr) {
        try {
            if (typeof Time !== 'undefined') {
                var t = new Time();
                if (ticksStr) {
                    t.ticks = String(ticksStr);
                } else if (seconds !== undefined) {
                    t.seconds = Number(seconds);
                }
                return t;
            }
        } catch (e) {}
        return ticksStr || String(editflowUtils.secondsToTicksString(seconds || 0));
    }

    function _findDefaultPreset(fps) {
        try {
            if (typeof Folder === 'undefined' || !Folder.appPackage) return null;
            var pproFolder = Folder.appPackage;
            if (!pproFolder.exists) return null;

            var presetsDir = new Folder(pproFolder.fsName + "/Settings/SequencePresets");
            if (!presetsDir.exists) {
                presetsDir = new Folder(pproFolder.fsName + "\\Settings\\SequencePresets");
            }
            if (!presetsDir.exists) return null;

            var targetName = "HD 1080p 29.97 fps.sqpreset";
            if (fps) {
                var numFps = parseFloat(fps);
                if (Math.abs(numFps - 25.0) < 0.1) targetName = "HD 1080p 25 fps.sqpreset";
                else if (Math.abs(numFps - 23.976) < 0.1 || Math.abs(numFps - 24.0) < 0.1) targetName = "HD 1080p 23.976 fps.sqpreset";
                else if (Math.abs(numFps - 50.0) < 0.1) targetName = "HD 1080p 50 fps.sqpreset";
                else if (Math.abs(numFps - 59.94) < 0.1 || Math.abs(numFps - 60.0) < 0.1) targetName = "HD 1080p 59.94 fps.sqpreset";
                else if (Math.abs(numFps - 30.0) < 0.1) targetName = "HD 1080p 29.97 fps.sqpreset";
            }

            var f = new File(presetsDir.fsName + "/HD 1080p/" + targetName);
            if (f.exists) return f.fsName;
            f = new File(presetsDir.fsName + "\\HD 1080p\\" + targetName);
            if (f.exists) return f.fsName;

            var hdFolder = new Folder(presetsDir.fsName + "/HD 1080p");
            if (hdFolder.exists && typeof hdFolder.getFiles === 'function') {
                var list = hdFolder.getFiles("*.sqpreset");
                if (list && list.length > 0) return list[0].fsName;
            }

            if (typeof presetsDir.getFiles === 'function') {
                var allPresets = presetsDir.getFiles("*.sqpreset");
                if (allPresets && allPresets.length > 0) return allPresets[0].fsName;
            }
        } catch (e) {}
        return null;
    }

    function _findAnyMediaClip(bin) {
        if (!bin || !bin.children) return null;
        for (var i = 0; i < bin.children.numItems; i++) {
            var item = bin.children[i];
            if (!item) continue;
            if (item.type === ProjectItemType.BIN || (item.children && typeof item.children.numItems !== 'undefined')) {
                var found = _findAnyMediaClip(item);
                if (found) return found;
            } else if (item.type !== ProjectItemType.BIN) {
                var itemPath = item.getMediaPath ? item.getMediaPath() : "";
                if (itemPath && !itemPath.match(/\.prproj$/i) && !itemPath.match(/\.sqpreset$/i)) {
                    return item;
                }
                if (item.name && !item.name.match(/\.prproj$/i)) {
                    return item;
                }
            }
        }
        return null;
    }

    // ── EDL Processing ──

    function processEDL(edlJsonPath) {
        /*
         * Reads an EDL JSON file from disk and applies the clip operations
         * to the active sequence. This is the primary way the Python backend
         * communicates timeline changes to Premiere.
         *
         * EDL format:
         * {
         *   "sequence_name": "Cut Sequence",
         *   "operations": [
         *     { "action": "add", "mediaPath": "C:/video.mp4", "trackIndex": 0, "startTime": 0, "inPoint": 0, "outPoint": 10 },
         *     { "action": "remove", "trackIndex": 0, "clipIndex": 1 },
         *     { "action": "move", "trackIndex": 0, "clipIndex": 0, "newStartTime": 15.5 }
         *   ]
         * }
         */
        var seq = app.project.activeSequence;
        if (!seq) return editflowUtils.safeStringify({ success: false, error: "No active sequence" });

        var results = [];

        try {
            var edlFile = new File(edlJsonPath);
            edlFile.open('r');
            var content = edlFile.read();
            edlFile.close();

            var edl = JSON.parse(content);
            var operations = edl.operations || [];

            for (var i = 0; i < operations.length; i++) {
                var op = operations[i];
                var action = op.action || "";
                var result;

                switch (action) {
                    case "beginUndoGroup":
                        try { app.beginUndoGroup(op.name || "EditFlow Operation"); } catch (e) {}
                        result = { success: true };
                        break;
                    case "endUndoGroup":
                        try { app.endUndoGroup(); } catch (e) {}
                        result = { success: true };
                        break;
                    case "import_file":
                        var pItem = ensureProjectItemForPath(op.mediaPath, op.bin_name);
                        result = { success: !!pItem };
                        break;
                    case "add":
                        result = addClipToSequence(seq, op);
                        break;
                    case "remove":
                        result = removeClipFromSequence(seq, op);
                        break;
                    case "move":
                        result = moveClipOnSequence(seq, op);
                        break;
                    case "modify":
                        result = modifyClipOnSequence(seq, op);
                        break;
                    case "ensure_bin":
                        result = ensureBin(op);
                        break;
                    case "create_sequence":
                        result = createSequenceFromOps(op);
                        if (result && result.success && result.sequence) {
                            seq = result.sequence;
                        } else {
                            seq = app.project.activeSequence;
                        }
                        if (!seq && app.project && app.project.sequences && app.project.sequences.numSequences > 0) {
                            seq = app.project.sequences[app.project.sequences.numSequences - 1];
                            try { app.project.openSequence(seq); } catch (e) {}
                        }
                        break;
                    case "add_marker":
                        result = addMarkerToSequence(seq, op);
                        break;
                    case "add_captions":
                        // Tier-1 captions via EDL: {action:"add_captions", srt_path:"..."}.
                        // captionsManager returns a JSON string; parse it back
                        // to an object so per-op results stay uniform (strict
                        // mode forbids stamping .operation onto a string).
                        try {
                            result = JSON.parse(captionsManager.importSRTAsCaptionTrack(op));
                        } catch (e) {
                            result = { success: false, error: e.toString() };
                        }
                        break;
                    default:
                        result = { success: false, error: "Unknown action: " + action };
                }

                result.operation = i;
                result.action = action;
                results.push(result);
            }

            // If EDL specifies a sequence name, rename
            if (edl.sequence_name && seq.name !== edl.sequence_name) {
                try { seq.name = edl.sequence_name; } catch (e) {}
            }

        } catch (e) {
            return editflowUtils.safeStringify({ success: false, error: e.toString(), results: results });
        }

        var failedCount = 0;
        var firstError = null;
        for (var k = 0; k < results.length; k++) {
            if (results[k] && results[k].success === false) {
                failedCount++;
                if (!firstError) {
                    firstError = results[k].error || ("Step " + results[k].operation + " (" + results[k].action + ") failed");
                }
            }
        }

        return editflowUtils.safeStringify({
            success: (failedCount === 0),
            totalOperations: operations.length,
            failedCount: failedCount,
            error: firstError,
            results: results
        });
    }

    // ── Dynamic Track Resolution & Auto-Creation ──

    function _findOrCreateEmptyVideoTrack(seq) {
        if (!seq || !seq.videoTracks) return 1;
        for (var v = 1; v < seq.videoTracks.numTracks; v++) {
            if (seq.videoTracks[v].clips.numItems === 0) return v;
        }
        try {
            if (typeof app.enableQE === 'function') app.enableQE();
            var qs = (typeof qe !== 'undefined' && qe.project) ? qe.project.getActiveSequence() : null;
            if (qs && typeof qs.addTracks === 'function') {
                var curV = seq.videoTracks.numTracks;
                qs.addTracks(1, curV, 0, 0, 0);
                return curV;
            }
        } catch (e) {}
        return (seq.videoTracks.numTracks > 1) ? (seq.videoTracks.numTracks - 1) : 0;
    }

    function _findOrCreateEmptyAudioTrack(seq) {
        if (!seq || !seq.audioTracks) return 0;
        // Search starting from index 2 (A3) or 1 (A2) to protect dialogue tracks A1/A2
        var startA = (seq.audioTracks.numTracks > 2) ? 2 : 1;
        for (var a = startA; a < seq.audioTracks.numTracks; a++) {
            if (seq.audioTracks[a].clips.numItems === 0) return a;
        }
        try {
            if (typeof app.enableQE === 'function') app.enableQE();
            var qs = (typeof qe !== 'undefined' && qe.project) ? qe.project.getActiveSequence() : null;
            if (qs && typeof qs.addTracks === 'function') {
                var curA = seq.audioTracks.numTracks;
                qs.addTracks(0, 0, 1, 2, curA);
                return curA;
            }
        } catch (e) {}
        return (seq.audioTracks.numTracks > 1) ? (seq.audioTracks.numTracks - 1) : 0;
    }

    // ── Individual Operations ──

    function addClipToSequence(seq, options) {
        // Support both addClipToSequence(seq, options) and addClipToSequence(options) / callModule
        if (!options && seq && (!seq.videoTracks && (seq.mediaPath || seq.path || seq.trackIndex !== undefined || seq.video_track_index !== undefined))) {
            options = seq;
            seq = app.project ? app.project.activeSequence : null;
        }
        if (!seq && app.project) {
            seq = app.project.activeSequence;
        }
        if (!seq) return { success: false, error: "No active sequence" };
        var mediaPath = editflowUtils.getParam(options, 'mediaPath', 'path');
        var startTime = editflowUtils.getParam(options, 'startTime', 'time') || 0;
        var inPoint = editflowUtils.getParam(options, 'inPoint', 'in') || 0;
        var outPoint = editflowUtils.getParam(options, 'outPoint', 'out') || 0;

        // Track indices for placement
        var videoTrackIndex = editflowUtils.getParam(options, 'video_track_index', 'videoTrackIndex');
        var audioTrackIndex = editflowUtils.getParam(options, 'audio_track_index', 'audioTrackIndex');

        // Backward-compat: legacy callers pass trackIndex only (defaults to V1/A1)
        if (videoTrackIndex === undefined) {
            var legacyTrack = editflowUtils.getParam(options, 'trackIndex', 'track');
            videoTrackIndex = (legacyTrack !== undefined) ? legacyTrack : 0;
        }

        // Resolve Target Video Track (Auto-detect empty track V2..V8 or explicit track index)
        var targetV = 1;
        if (videoTrackIndex === "auto" || videoTrackIndex === -1 || (videoTrackIndex === undefined && options.auto_detect_track)) {
            targetV = _findOrCreateEmptyVideoTrack(seq);
        } else {
            targetV = parseInt(videoTrackIndex, 10);
            if (isNaN(targetV) || targetV < 0) {
                targetV = _findOrCreateEmptyVideoTrack(seq);
            } else {
                while (targetV >= seq.videoTracks.numTracks) {
                    try {
                        if (typeof app.enableQE === 'function') app.enableQE();
                        var qs = (typeof qe !== 'undefined' && qe.project) ? qe.project.getActiveSequence() : null;
                        if (qs && typeof qs.addTracks === 'function') {
                            var curV = seq.videoTracks.numTracks;
                            qs.addTracks(1, curV, 0, 0, 0);
                        } else { break; }
                    } catch (e) { break; }
                }
                if (targetV >= seq.videoTracks.numTracks) targetV = seq.videoTracks.numTracks - 1;
            }
        }

        // Resolve Target Audio Track
        // isVideoOnly: caller explicitly requested video-only overlay with no audio on any track.
        // isAutoAudio: caller requested overlay with natural audio preserved on an empty audio track (A3..A8),
        // preventing dialogue on A1/A2 from ever being overwritten or wiped out.
        var isVideoOnly = (audioTrackIndex === -1 || options.video_only === true) && !options.include_audio && !options.preserve_broll_audio && audioTrackIndex !== "auto";
        var isAutoAudio = (audioTrackIndex === "auto" || options.auto_detect_audio || options.include_audio || options.preserve_broll_audio || (audioTrackIndex === undefined && targetV > 0));

        var targetA = 0;
        if (isVideoOnly || isAutoAudio) {
            targetA = _findOrCreateEmptyAudioTrack(seq);
        } else {
            targetA = parseInt(audioTrackIndex, 10);
            if (isNaN(targetA) || targetA < 0) targetA = 0;
            while (targetA >= seq.audioTracks.numTracks) {
                try {
                    if (typeof app.enableQE === 'function') app.enableQE();
                    var qs = (typeof qe !== 'undefined' && qe.project) ? qe.project.getActiveSequence() : null;
                    if (qs && typeof qs.addTracks === 'function') {
                        var curA = seq.audioTracks.numTracks;
                        qs.addTracks(0, 0, 1, 2, curA);
                    } else { break; }
                } catch (e) { break; }
            }
            if (targetA >= seq.audioTracks.numTracks) targetA = seq.audioTracks.numTracks - 1;
        }

        try {
            var projectItem = findProjectItem(mediaPath);
            if (!projectItem) {
                projectItem = ensureProjectItemForPath(mediaPath);
                if (!projectItem) {
                    return { success: false, error: "Could not find or import: " + mediaPath };
                }
            }

            // ── FIX-A: Pre-trim via projectItem.setInPoint/setOutPoint ─────
            // Setting in/out on the projectItem before placement ensures that
            // overwriteClip captures the exact sub-clip slice natively.
            var inSec = parseFloat(inPoint) || 0;
            var outSec = parseFloat(outPoint) || 0;
            if (inSec > 0 || outSec > 0) {
                try {
                    if (inSec > 0 && typeof projectItem.setInPoint === 'function') {
                        projectItem.setInPoint(editflowUtils.secondsToTicksString(inSec), 4);
                    }
                    if (outSec > inSec && typeof projectItem.setOutPoint === 'function') {
                        projectItem.setOutPoint(editflowUtils.secondsToTicksString(outSec), 4);
                    }
                } catch (e) {
                    try { $.writeln("setInPoint/setOutPoint failed: " + e.toString()); } catch (_) {}
                }
            }

            var startSec = parseFloat(startTime);
            if (isNaN(startSec)) startSec = 0;
            var placeErr = null;
            var placed = false;

            // If caller explicitly requested video-only overlay, attempt 4-arg insertClip with -1 first
            if (isVideoOnly && typeof seq.insertClip === 'function') {
                try {
                    seq.insertClip(projectItem, editflowUtils.secondsToTicksString(startSec), targetV, -1);
                    if (_findClipAtTime(seq.videoTracks[targetV], startSec)) {
                        placed = true;
                    }
                } catch (_) {}
            }

            // Sequence-level overwriteClip: 100% reliable in Premiere Pro (time must be float seconds)
            if (!placed && typeof seq.overwriteClip === 'function') {
                try {
                    seq.overwriteClip(projectItem, startSec, targetV, targetA);
                    placed = true;
                } catch (e1) {
                    placeErr = e1.toString();
                    try {
                        seq.overwriteClip(projectItem, String(startSec), targetV, targetA);
                        placed = true;
                    } catch (e2) {
                        placeErr = e2.toString();
                    }
                }
            }
            if (!placed && typeof seq.insertClip === 'function') {
                try {
                    seq.insertClip(projectItem, editflowUtils.secondsToTicksString(startSec), targetV, targetA);
                    placed = true;
                } catch (e3) {
                    placeErr = e3.toString();
                }
            }

            // ── Verify Placed Clips ──────────────────────────────────────
            var placedClip = _findClipAtTime(seq.videoTracks[targetV], startSec);
            var placedAudio = (targetA >= 0 && seq.audioTracks && seq.audioTracks[targetA])
                ? _findClipAtTime(seq.audioTracks[targetA], startSec)
                : null;

            if (!placed && !placedClip) {
                return {
                    success: false,
                    error: "Failed to place clip on Track V" + (targetV + 1) + ": " + (placeErr || "unknown error"),
                    mediaPath: mediaPath,
                    startTime: startSec
                };
            }

            var diag = {
                found: !!placedClip,
                found_audio: !!placedAudio,
                target_v: targetV,
                target_a: targetA,
                requested_in: inPoint,
                requested_out: outPoint
            };

            if (placedClip) {
                try {
                    diag.placed_in_ticks    = String(placedClip.inPoint.ticks || "");
                    diag.placed_out_ticks   = String(placedClip.outPoint.ticks || "");
                    diag.placed_start_ticks = String(placedClip.start.ticks || "");
                    diag.placed_end_ticks   = String(placedClip.end.ticks || "");
                } catch (e) {}

                if (inSec > 0) {
                    try { placedClip.inPoint = editflowUtils.secondsToTicksString(inSec); } catch (e) { diag.in_err = e.toString(); }
                }
                if (outSec > inSec) {
                    try { placedClip.outPoint = editflowUtils.secondsToTicksString(outSec); } catch (e) { diag.out_err = e.toString(); }
                }
            }

            if (placedAudio) {
                if (inSec > 0) {
                    try { placedAudio.inPoint = editflowUtils.secondsToTicksString(inSec); } catch (e) {}
                }
                if (outSec > inSec) {
                    try { placedAudio.outPoint = editflowUtils.secondsToTicksString(outSec); } catch (e) {}
                }
            }

            // ── Video-Only Overlay Handling ──────────────────────────────
            // If caller explicitly requested video-only overlay (audioTrackIndex < 0),
            // remove any audio TrackItem placed by overwriteClip so audio tracks remain clean.
            if (isVideoOnly && placedClip && typeof placedClip.getLinkedItems === 'function') {
                try {
                    var lItems = placedClip.getLinkedItems();
                    if (lItems) {
                        for (var li = 0; li < lItems.numItems; li++) {
                            if (lItems[li] && lItems[li].mediaType === "Audio") {
                                try { lItems[li].remove(false, false); } catch (_) {}
                            }
                        }
                    }
                } catch (_) {}
                placedAudio = null;
                diag.found_audio = false;
            }

            // ── Clean Dialogue Channel Management ────────────────────────
            // Eliminate two audio clips stacked on top of each other.
            // Sony/DSLR footage imports with 2 audio channels (Ch1 Lav/Dialogue, Ch2 Scratch/Ambient).
            // ONLY purge spillover channels if explicit dialogue cut on Track V1/A1.
            // Overlays (V2..V8) MUST NEVER purge audio channels!
            var singleChannelDialogue = editflowUtils.getParam(options, 'single_channel_dialogue', 'singleChannelDialogue');
            if (targetV > 0 || isVideoOnly || isAutoAudio) {
                singleChannelDialogue = false;
            } else if (singleChannelDialogue === undefined) {
                singleChannelDialogue = true;
            }

            if (singleChannelDialogue && placedClip && typeof placedClip.getLinkedItems === 'function') {
                try {
                    var linkedItems = placedClip.getLinkedItems();
                    if (linkedItems) {
                        for (var li = 0; li < linkedItems.numItems; li++) {
                            var lItem = linkedItems[li];
                            if (lItem && lItem.mediaType === "Audio" && lItem.parentTrackIndex !== targetA) {
                                try {
                                    lItem.remove(false, false);
                                    diag.spill_channel_removed = lItem.parentTrackIndex;
                                } catch (e) {}
                            }
                        }
                    }
                } catch (e) {
                    diag.spill_channel_err = e.toString();
                }
            }

            // ── FIX-C: Scale punch-in on same-clip splices ───────────────
            var scalePunchIn = editflowUtils.getParam(options, 'scale_punch_in', 'scale');
            if (scalePunchIn && placedClip) {
                var targetScale = parseFloat(scalePunchIn);
                if (targetScale > 0) {
                    if (targetScale <= 2.5) { targetScale = targetScale * 100.0; }
                    try {
                        var comp = placedClip.components;
                        if (comp) {
                            for (var ci = 0; ci < comp.numItems; ci++) {
                                if (comp[ci].displayName === "Motion") {
                                    var props = comp[ci].properties;
                                    for (var pi = 0; pi < props.numItems; pi++) {
                                        if (props[pi].displayName === "Scale") {
                                            props[pi].setValue(targetScale, true);
                                            diag.scale_applied = targetScale;
                                            break;
                                        }
                                    }
                                    break;
                                }
                            }
                        }
                    } catch (e) {
                        diag.scale_err = e.toString();
                    }
                }
            }

            // ── FIX-D: J-Cut Audio Lead Frame Adjustment & Unlinking ─────
            // When audioLeadFrames > 0, we extend the audio start earlier by leadSec.
            // To prevent Premiere Pro from displaying red out-of-sync warning badges
            // ([-0:136] / [+0:136]), we cleanly unlink the placed video & audio clips
            // via seq.unlinkSelection() before shifting audio start and inPoint.
            var audioLeadFrames = editflowUtils.getParam(options, 'audio_lead_frames', 'audioLeadFrames') || 0;
            if (audioLeadFrames > 0 && audioTrackIndex >= 0 && placedAudio && placedClip) {
                try {
                    var seqFps = 30.0;
                    var tb = parseFloat(seq.timebase);
                    if (tb > 0) { seqFps = 254016000000 / tb; }
                    var leadSec = audioLeadFrames / seqFps;

                    if (startTime >= leadSec) {
                        // 1. Deselect all clips on timeline to avoid unwanted unlinks
                        _deselectAllClips(seq);

                        // 2. Select this video clip AND ALL its linked items
                        if (typeof placedClip.setSelected === 'function') {
                            placedClip.setSelected(true, true);
                        }
                        if (typeof placedClip.getLinkedItems === 'function') {
                            var lItems = placedClip.getLinkedItems();
                            if (lItems) {
                                for (var li = 0; li < lItems.numItems; li++) {
                                    if (typeof lItems[li].setSelected === 'function') {
                                        lItems[li].setSelected(true, true);
                                    }
                                }
                            }
                        }
                        if (placedAudio && typeof placedAudio.setSelected === 'function') {
                            placedAudio.setSelected(true, true);
                        }

                        // 3. Unlink them so Premiere does not treat them as a desynced pair
                        if (typeof seq.unlinkSelection === 'function') {
                            seq.unlinkSelection();
                            diag.unlinked_for_jcut = true;
                        }

                        // 4. Adjust audio inPoint, start, and end earlier
                        var adjAudioStart = startTime - leadSec;
                        var adjAudioIn = Math.max(0, inPoint - leadSec);
                        if (adjAudioIn > 0) {
                            try { placedAudio.inPoint = editflowUtils.secondsToTicksString(adjAudioIn); } catch (e) {}
                        }
                        placedAudio.start = editflowUtils.secondsToTicksString(adjAudioStart);
                        if (outPoint > inPoint) {
                            var sliceDur = outPoint - inPoint;
                            try {
                                placedAudio.end = editflowUtils.secondsToTicksString(adjAudioStart + sliceDur + leadSec);
                            } catch (e) {}
                        }
                        diag.audio_lead_sec = leadSec;
                    }
                } catch (e) {
                    diag.audio_lead_err = e.toString();
                }
            }

            // ── Phase 2 (M13): Audio fade support ────────────────────────
            // NOTE: setAudioFadeIn/setAudioFadeOut do NOT exist in the official
            // PPro TrackItem API. Audio fades must be set via keyframes on the
            // Volume component (see audio_manager.jsx applyAudioFade()). The
            // audio_manager is the correct path for fades; this placeholder is
            // kept for forward-compat if Adobe adds these methods later.
            try {
                var lastClip = seq.videoTracks[videoTrackIndex].clips[seq.videoTracks[videoTrackIndex].clips.numItems - 1];
                if (lastClip && options.audio_fade_in_ms) {
                    if (typeof lastClip.setAudioFadeIn === 'function') {
                        var fadeInTicks = editflowUtils.secondsToTicksString(options.audio_fade_in_ms / 1000);
                        lastClip.setAudioFadeIn(fadeInTicks);
                    }
                }
                if (lastClip && options.audio_fade_out_ms) {
                    if (typeof lastClip.setAudioFadeOut === 'function') {
                        var fadeOutTicks = editflowUtils.secondsToTicksString(options.audio_fade_out_ms / 1000);
                        lastClip.setAudioFadeOut(fadeOutTicks);
                    }
                }
            } catch (e) {
                // Audio fade API not available in this PPro version — non-critical
            }

            return { success: true, name: projectItem.name, startTime: startTime, trim_diag: diag };

        } catch (e) {
            return { success: false, error: e.toString() };
        }
    }

    function _findClipAtTime(track, startTimeSeconds) {
        if (!track || !track.clips) return null;
        var targetTicks = editflowUtils.secondsToTicks(startTimeSeconds);
        var tolerance = editflowUtils.secondsToTicks(0.2); // 0.2s tolerance for frame snapping
        for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            if (!clip || !clip.start) continue;
            var clipStart = parseFloat(clip.start.ticks !== undefined ? clip.start.ticks : clip.start);
            if (clipStart < 1000 && targetTicks > 1000) {
                // Raw seconds mock harness support
                if (Math.abs(clipStart - startTimeSeconds) <= 0.2) return clip;
            }
            if (Math.abs(clipStart - targetTicks) <= tolerance) {
                return clip;
            }
        }
        return null;
    }

    function _deselectAllClips(seq) {
        if (!seq) return;
        try {
            if (seq.videoTracks) {
                for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) {
                    var vtrack = seq.videoTracks[vt];
                    if (vtrack && vtrack.clips) {
                        for (var c = 0; c < vtrack.clips.numItems; c++) {
                            if (typeof vtrack.clips[c].setSelected === 'function') {
                                vtrack.clips[c].setSelected(false, true);
                            }
                        }
                    }
                }
            }
            if (seq.audioTracks) {
                for (var at = 0; at < seq.audioTracks.numTracks; at++) {
                    var atrack = seq.audioTracks[at];
                    if (atrack && atrack.clips) {
                        for (var c = 0; c < atrack.clips.numItems; c++) {
                            if (typeof atrack.clips[c].setSelected === 'function') {
                                atrack.clips[c].setSelected(false, true);
                            }
                        }
                    }
                }
            }
        } catch (e) {}
    }

    function removeClipFromSequence(seq, options) {
        var trackIndex = editflowUtils.getParam(options, 'trackIndex', 'track') || 0;
        var clipIndex = editflowUtils.getParam(options, 'clipIndex', 'index');

        try {
            var track = seq.videoTracks[trackIndex];
            if (!track || clipIndex >= track.clips.numItems) {
                return { success: false, error: "Clip not found at track " + trackIndex + ", index " + clipIndex };
            }

            var clip = track.clips[clipIndex];
            clip.remove(true, true); // ripple, align
            return { success: true, removedClip: clip.name };

        } catch (e) {
            return { success: false, error: e.toString() };
        }
    }

    function moveClipOnSequence(seq, options) {
        var trackIndex = editflowUtils.getParam(options, 'trackIndex', 'track') || 0;
        var clipIndex = editflowUtils.getParam(options, 'clipIndex', 'index');
        var newStartTime = editflowUtils.getParam(options, 'newStartTime', 'startTime') || 0;

        try {
            var track = seq.videoTracks[trackIndex];
            if (!track || clipIndex >= track.clips.numItems) {
                return { success: false, error: "Clip not found" };
            }

            var clip = track.clips[clipIndex];
            // clip.start expects a tick STRING, not a raw number — matching the
            // premiere-pro-mcp reference and PPro's Time-object property setter.
            clip.start = editflowUtils.secondsToTicksString(newStartTime);
            return { success: true, name: clip.name, newStartTime: newStartTime };

        } catch (e) {
            return { success: false, error: e.toString() };
        }
    }

    function modifyClipOnSequence(seq, options) {
        var trackIndex = editflowUtils.getParam(options, 'trackIndex', 'track') || 0;
        var clipIndex = editflowUtils.getParam(options, 'clipIndex', 'index');

        try {
            var track = seq.videoTracks[trackIndex];
            if (!track || clipIndex >= track.clips.numItems) {
                return { success: false, error: "Clip not found" };
            }

            var clip = track.clips[clipIndex];
            var modified = [];

            // Speed — NOTE: There is NO official ExtendScript API to set clip
            // speed. Only getSpeed() (getter) exists. Speed must be changed
            // manually or via the QE DOM (unsupported). Log the request but
            // do not attempt to call a non-existent setter.
            var speed = editflowUtils.getParam(options, 'speed');
            if (speed !== undefined) {
                // No-op: clip speed cannot be set via ExtendScript API
                modified.push("speed=" + speed + " (unsupported)");
            }

            // Scale
            var scaleX = editflowUtils.getParam(options, 'scaleX', 'scale');
            var scaleY = editflowUtils.getParam(options, 'scaleY');
            if (scaleX !== undefined) {
                try {
                    var comp = clip.components;
                    for (var ci = 0; ci < comp.numItems; ci++) {
                        if (comp[ci].displayName === "Motion") {
                            var props = comp[ci].properties;
                            for (var pi = 0; pi < props.numItems; pi++) {
                                if (props[pi].displayName === "Scale") {
                                    props[pi].setValue(scaleX, true);
                                    modified.push("scale=" + scaleX);
                                    break;
                                }
                            }
                            break;
                        }
                    }
                } catch (e) {}
            }

            return { success: true, name: clip.name, modified: modified };

        } catch (e) {
            return { success: false, error: e.toString() };
        }
    }

    // ── Helper Functions ──

    function findProjectItem(mediaPath) {
        var project = app.project;
        if (!project) return null;

        var root = project.rootItem;
        return findItemInBin(root, mediaPath);
    }

    function findItemInBin(bin, mediaPath) {
        if (!bin || !bin.children) return null;
        var targetNorm = _normPath(mediaPath);
        var targetFile = _fileName(mediaPath);

        for (var i = 0; i < bin.children.numItems; i++) {
            var item = bin.children[i];
            if (!item) continue;
            if (item.type === ProjectItemType.BIN) {
                var found = findItemInBin(item, mediaPath);
                if (found) return found;
            } else {
                try {
                    var itemPath = item.getMediaPath ? item.getMediaPath() : "";
                    if (itemPath && _normPath(itemPath) === targetNorm) return item;
                    if (targetFile && item.name && _fileName(item.name) === targetFile) return item;
                } catch (e) {}
            }
        }
        return null;
    }

    function ensureProjectItemForPath(mediaPath, targetBinName) {
        if (!mediaPath) return null;
        var existing = findProjectItem(mediaPath);
        if (existing) return existing;

        try {
            var project = app.project;
            if (!project) return null;
            var root = project.rootItem;

            var binLabel = targetBinName || "EditFlow Imports";
            var binRes = _resolveOrCreateBinPath(root, binLabel);
            var importBin = (binRes && binRes.bin) ? binRes.bin : root;

            var prevCount = (importBin.children && importBin.children.numItems) ? importBin.children.numItems : 0;
            var pathStr = mediaPath;
            try {
                var f = new File(mediaPath);
                if (f.fsName) pathStr = f.fsName;
            } catch (e) {}

            project.importFiles([pathStr], true, importBin, false);

            $.sleep(300);

            if (importBin.children && importBin.children.numItems > prevCount) {
                var targetFile = _fileName(mediaPath);
                for (var b = 0; b < importBin.children.numItems; b++) {
                    var cItem = importBin.children[b];
                    if (cItem && cItem.name && _fileName(cItem.name) === targetFile) {
                        return cItem;
                    }
                }
            }

            return findProjectItem(mediaPath);
        } catch (e) {
            return null;
        }
    }

    function removeTimelineClips(options) {
        var seq = app.project.activeSequence;
        if (!seq) return editflowUtils.safeStringify({ success: false, error: "No active sequence" });

        var mode = editflowUtils.getParam(options, 'mode', 'type') || "broll";
        var removed = 0;

        for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) {
            var track = seq.videoTracks[vt];
            // Collect clips to remove (iterate in reverse to avoid index shifting)
            var toRemove = [];
            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                if (mode === "broll" && vt > 0) {
                    toRemove.push(c);
                } else if (mode === "all") {
                    toRemove.push(c);
                }
            }
            for (var i = toRemove.length - 1; i >= 0; i--) {
                track.clips[toRemove[i]].remove(true, true);
                removed++;
            }
        }

        return editflowUtils.safeStringify({ success: true, removed: removed });
    }

    function clearTimelineLabels(options) {
        var seq = app.project.activeSequence;
        if (!seq) return editflowUtils.safeStringify({ success: false, error: "No active sequence" });

        var labelName = editflowUtils.getParam(options, 'label', 'color') || "Iris";
        var cleared = 0;

        for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) {
            var track = seq.videoTracks[vt];
            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                try {
                    var currentLabel = sequenceReader.getClipLabelName(clip);
                    if (currentLabel === labelName) {
                        // setColorLabel is a ProjectItem method, not TrackItem
                        try { clip.projectItem.setColorLabel(0); } catch (e) {} // Reset to Violet/Default
                        cleared++;
                    }
                } catch (e) {}
            }
        }

        return editflowUtils.safeStringify({ success: true, cleared: cleared });
    }

    function addMediaToTimeline(options) {
        var seq = app.project.activeSequence;
        if (!seq) return editflowUtils.safeStringify({ success: false, error: "No active sequence" });

        var mediaPath = editflowUtils.getParam(options, 'mediaPath', 'path');
        var trackIndex = editflowUtils.getParam(options, 'trackIndex', 'track') || 0;
        var startTime = editflowUtils.getParam(options, 'startTime', 'time') || 0;

        var result = addClipToSequence(seq, {
            mediaPath: mediaPath,
            trackIndex: trackIndex,
            startTime: startTime
        });

        return editflowUtils.safeStringify(result);
    }

    function importFilesFromPaths(options) {
        var paths = editflowUtils.getParam(options, 'paths', 'files');
        if (!paths || !paths.length) {
            return editflowUtils.safeStringify({ success: false, error: "No file paths provided" });
        }
        var targetBinName = editflowUtils.getParam(options, 'bin_name', 'binName') || "EditFlow Imports";

        try {
            var project = app.project;
            var root = project.rootItem;

            var binRes = _resolveOrCreateBinPath(root, targetBinName);
            var importBin = (binRes && binRes.bin) ? binRes.bin : root;

            project.importFiles(paths, true, importBin, false);

            return editflowUtils.safeStringify({ success: true, imported: paths.length, bin: targetBinName });

        } catch (e) {
            return editflowUtils.safeStringify({ success: false, error: e.toString() });
        }
    }

    function insertClipAtTime(options) {
        var seq = app.project.activeSequence;
        if (!seq) return editflowUtils.safeStringify({ success: false, error: "No active sequence" });

        var result = addClipToSequence(seq, options);
        return editflowUtils.safeStringify(result);
    }

    function createNewSequence(options) {
        var res = createSequenceFromOps(options);
        return editflowUtils.safeStringify(res);
    }

    function organizeIntoBins(options) {
        var rules = editflowUtils.getParam(options, 'rules');
        if (!rules || !rules.length) {
            return editflowUtils.safeStringify({ success: false, error: "No organization rules provided" });
        }

        var project = app.project;
        var root = project.rootItem;
        var organized = 0;

        for (var r = 0; r < rules.length; r++) {
            var rule = rules[r];
            var binName = rule.binName || rule.name;
            var bin = editflowUtils.findBin(root, binName);
            if (!bin) {
                root.createBin(binName);
                bin = editflowUtils.findBin(root, binName);
            }

            if (bin && rule.extensions) {
                for (var i = 0; i < root.children.numItems; i++) {
                    var item = root.children[i];
                    if (item.type !== ProjectItemType.BIN) {
                        var mediaPath = item.getMediaPath ? item.getMediaPath() : "";
                        var ext = mediaPath.split('.').pop().toLowerCase();
                        if (rule.extensions.indexOf(ext) >= 0) {
                            try {
                                item.moveBin(bin);
                                organized++;
                            } catch (e) {}
                        }
                    }
                }
            }
        }

        return editflowUtils.safeStringify({ success: true, organized: organized });
    }

    function setClipLabelColor(options) {
        var seq = app.project.activeSequence;
        if (!seq) return editflowUtils.safeStringify({ success: false, error: "No active sequence" });

        var trackIndex = editflowUtils.getParam(options, 'trackIndex', 'track') || 0;
        var clipIndex = editflowUtils.getParam(options, 'clipIndex', 'index') || 0;
        var labelIndex = editflowUtils.getParam(options, 'labelIndex', 'label') || 0;

        try {
            var track = seq.videoTracks[trackIndex];
            if (!track || clipIndex >= track.clips.numItems) {
                return editflowUtils.safeStringify({ success: false, error: "Clip not found" });
            }
            var clip = track.clips[clipIndex];
            // setColorLabel is a ProjectItem method, not TrackItem
            clip.projectItem.setColorLabel(labelIndex);
            return editflowUtils.safeStringify({ success: true });
        } catch (e) {
            return editflowUtils.safeStringify({ success: false, error: e.toString() });
        }
    }

    function removeTimelineRanges(options) {
        /*
         * Remove or "ripple delete" arbitrary timeline ranges (in seconds).
         * Used for:
         *   1. Word-level cuts from transcript (clicking word and hitting Del)
         *   2. 1-click filler word removal ("um", "uh", "er")
         *   3. 1-click silence & pause tightening
         *
         * Cuts are executed in reverse chronological order (highest start time
         * down to lowest) so later cuts ripple without invalidating earlier
         * sequence timestamps.
         */
        var seq = app.project ? app.project.activeSequence : null;
        if (!seq) {
            return editflowUtils.safeStringify({ success: false, error: "No active sequence" });
        }

        var rawRanges = editflowUtils.getParam(options, "ranges") || [];
        if (!rawRanges.length) {
            return editflowUtils.safeStringify({ success: false, error: "No ranges provided" });
        }

        // Clean & validate input ranges
        var cleanRanges = [];
        for (var i = 0; i < rawRanges.length; i++) {
            var r = rawRanges[i];
            var s = parseFloat(r.start);
            var e = parseFloat(r.end);
            if (!isNaN(s) && !isNaN(e) && e > s) {
                cleanRanges.push({
                    start: Math.max(0, s),
                    end: Math.max(0, e),
                    label: r.label || ""
                });
            }
        }

        if (!cleanRanges.length) {
            return editflowUtils.safeStringify({ success: false, error: "All provided ranges were invalid" });
        }

        // Sort ascending to merge overlapping or touching ranges
        cleanRanges.sort(function(a, b) { return a.start - b.start; });
        var merged = [];
        var cur = cleanRanges[0];
        for (var j = 1; j < cleanRanges.length; j++) {
            var nxt = cleanRanges[j];
            if (nxt.start <= cur.end + 0.04) {
                cur.end = Math.max(cur.end, nxt.end);
                if (nxt.label && cur.label.indexOf(nxt.label) === -1) {
                    cur.label += ", " + nxt.label;
                }
            } else {
                merged.push(cur);
                cur = nxt;
            }
        }
        merged.push(cur);

        var totalTimeSaved = 0;
        for (var k = 0; k < merged.length; k++) {
            totalTimeSaved += (merged[k].end - merged[k].start);
        }

        var previewOnly = editflowUtils.getParam(options, "previewOnly") === true;
        if (previewOnly) {
            return editflowUtils.safeStringify({
                success: true,
                preview: true,
                ranges: merged,
                totalRanges: merged.length,
                totalTimeSaved: totalTimeSaved
            });
        }

        // Execute timeline cuts
        try {
            app.enableQE();
        } catch (_) {}

        var qeSeq = null;
        try {
            if (typeof qe !== "undefined" && qe.project && typeof qe.project.getActiveSequence === "function") {
                qeSeq = qe.project.getActiveSequence();
            }
        } catch (_) {}

        var fps = 30;
        try {
            if (seq.timebase) {
                var tb = parseFloat(seq.timebase);
                if (tb > 0) fps = Math.round((254016000000 / tb) * 100) / 100;
            }
        } catch (_) {}

        // Sort in DESCENDING order so later timeline cuts ripple without shifting earlier timestamps
        var cutsDesc = merged.slice(0).sort(function(a, b) { return b.start - a.start; });
        var cutsCompleted = 0;
        var cutErrors = [];

        for (var c = 0; c < cutsDesc.length; c++) {
            var cut = cutsDesc[c];
            var inTicks = editflowUtils.secondsToTicksString(cut.start);
            var outTicks = editflowUtils.secondsToTicksString(cut.end);

            try {
                if (typeof seq.setInPoint === "function") seq.setInPoint(inTicks);
                if (typeof seq.setOutPoint === "function") seq.setOutPoint(outTicks);
            } catch (eSet) {
                try {
                    if (typeof seq.setInPoint === "function") seq.setInPoint(cut.start);
                    if (typeof seq.setOutPoint === "function") seq.setOutPoint(cut.end);
                } catch (_) {}
            }

            // Also set on QE sequence if available
            if (qeSeq) {
                try {
                    var tcIn = editflowUtils.secondsToTimecode(cut.start, fps);
                    var tcOut = editflowUtils.secondsToTimecode(cut.end, fps);
                    if (tcIn && typeof qeSeq.setInPoint === "function") qeSeq.setInPoint(tcIn);
                    if (tcOut && typeof qeSeq.setOutPoint === "function") qeSeq.setOutPoint(tcOut);
                } catch (_) {}
            }

            var extractOk = false;
            if (qeSeq && typeof qeSeq.extract === "function") {
                try {
                    qeSeq.extract();
                    extractOk = true;
                    cutsCompleted++;
                } catch (eExt) {
                    cutErrors.push("Cut " + c + " extract failed: " + eExt.toString());
                }
            } else if (typeof seq.extract === "function") {
                try {
                    seq.extract();
                    extractOk = true;
                    cutsCompleted++;
                } catch (eSeqExt) {
                    cutErrors.push("Cut " + c + " seq.extract failed: " + eSeqExt.toString());
                }
            } else {
                cutErrors.push("No extract API available (QE not available)");
            }
        }

        // Clean up in/out markers so the user's timeline remains clean
        try { if (seq.clearInPoint) seq.clearInPoint(); } catch (_) {}
        try { if (seq.clearOutPoint) seq.clearOutPoint(); } catch (_) {}
        try { if (qeSeq && qeSeq.clearInPoint) qeSeq.clearInPoint(); } catch (_) {}
        try { if (qeSeq && qeSeq.clearOutPoint) qeSeq.clearOutPoint(); } catch (_) {}

        return editflowUtils.safeStringify({
            success: cutsCompleted > 0 || (merged.length === 0),
            cutsCompleted: cutsCompleted,
            totalRequested: merged.length,
            totalTimeSaved: totalTimeSaved,
            ranges: merged,
            errors: cutErrors
        });
    }

    // ── EditFlow Script Cut Operations ──

    function _resolveOrCreateBinPath(root, binPath) {
        if (!binPath) return { bin: root, existed: true, path: "" };
        var norm = String(binPath).replace(/\\/g, "/");
        var parts = norm.split("/");
        var current = root;
        var createdAny = false;
        for (var i = 0; i < parts.length; i++) {
            var seg = parts[i].replace(/^\s+|\s+$/g, "");
            if (!seg) continue;
            var found = null;
            if (current && current.children) {
                for (var c = 0; c < current.children.numItems; c++) {
                    var child = current.children[c];
                    if (child && child.type === ProjectItemType.BIN && child.name === seg) {
                        found = child;
                        break;
                    }
                }
            }
            if (!found && current === root) {
                found = editflowUtils.findBin(root, seg);
            }
            if (!found) {
                var created = current.createBin(seg);
                createdAny = true;
                found = created || editflowUtils.findBin(current, seg);
            }
            if (found) {
                current = found;
            }
        }
        return { bin: current, existed: !createdAny, path: norm };
    }

    function ensureBin(options) {
        var binName = editflowUtils.getParam(options, 'bin_name', 'name') || "EditFlow Output";
        var parentBin = editflowUtils.getParam(options, 'parent_bin', 'parentBin');
        if (parentBin) {
            binName = String(parentBin).replace(/\/+$/, "") + "/" + String(binName).replace(/^\/+/, "");
        }
        var project = app.project;
        if (!project) return { success: false, error: "No project open" };

        try {
            var res = _resolveOrCreateBinPath(project.rootItem, binName);
            return { success: true, name: binName, existed: res.existed };
        } catch (e) {
            return { success: false, error: e.toString() };
        }
    }

    function createSequenceFromOps(options) {
        var name = editflowUtils.getParam(options, 'name') || "EditFlow Cut";
        var clipPath = editflowUtils.getParam(options, 'preset_from_clip_path', 'presetFromClipPath');
        var presetPath = editflowUtils.getParam(options, 'presetPath', 'preset');
        var fps = parseFloat(editflowUtils.getParam(options, 'fps') || 30.0);
        var seqID = name + '-' + new Date().getTime();
        var newSeq = null;

        var targetWidth = editflowUtils.getParam(options, 'width');
        var targetHeight = editflowUtils.getParam(options, 'height');
        var aspectRatio = editflowUtils.getParam(options, 'aspect_ratio', 'aspectRatio');
        if (!targetWidth && !targetHeight && aspectRatio) {
            if (aspectRatio === '9:16') {
                targetWidth = 1080;
                targetHeight = 1920;
            } else if (aspectRatio === '16:9') {
                targetWidth = 1920;
                targetHeight = 1080;
            } else if (aspectRatio === '1:1') {
                targetWidth = 1080;
                targetHeight = 1080;
            } else if (aspectRatio === '4:5') {
                targetWidth = 1080;
                targetHeight = 1350;
            }
        }

        var clipItem = null;
        if (clipPath) { try { clipItem = ensureProjectItemForPath(clipPath); } catch (e) {} }
        if (!clipItem && app.project && app.project.rootItem) {
            try { clipItem = _findAnyMediaClip(app.project.rootItem); } catch (e) {}
        }

        // 1) Primary method: create sequence from clip (100% silent, never opens dialog!)
        if (clipItem && typeof app.project.createNewSequenceFromClips === 'function') {
            try {
                newSeq = app.project.createNewSequenceFromClips(name, [clipItem]);
                if (newSeq) {
                    try {
                        if (newSeq.videoTracks && newSeq.videoTracks[0] && newSeq.videoTracks[0].clips && newSeq.videoTracks[0].clips.numItems > 0) {
                            newSeq.videoTracks[0].clips[0].remove(false, false);
                        }
                    } catch (e1) {}
                    try {
                        if (newSeq.audioTracks && newSeq.audioTracks[0] && newSeq.audioTracks[0].clips && newSeq.audioTracks[0].clips.numItems > 0) {
                            newSeq.audioTracks[0].clips[0].remove(false, false);
                        }
                    } catch (e2) {}
                }
            } catch (e) { newSeq = null; }
        }

        // 2) Secondary method: QE DOM with .sqpreset (100% silent, never opens dialog!)
        if (!newSeq) {
            var defPreset = presetPath || _findDefaultPreset(fps);
            if (defPreset) {
                try {
                    if (typeof app.enableQE === 'function') app.enableQE();
                    if (typeof qe !== 'undefined' && qe.project && typeof qe.project.newSequence === 'function') {
                        var qeRes = qe.project.newSequence(name, defPreset);
                        if (qeRes) {
                            newSeq = app.project.activeSequence;
                        }
                    }
                } catch (eQE) { newSeq = null; }
            }
        }

        // 3) Fallback: standard createNewSequence with empty sequenceID (avoids dialog if default exists)
        if (!newSeq) {
            try { newSeq = app.project.createNewSequence(name, ""); }
            catch (e) {
                try { newSeq = app.project.createNewSequence(name); }
                catch (e2) { return { success: false, error: e2.toString() }; }
            }
        }

        if (!newSeq) {
            return { success: false, error: "Failed to create sequence" };
        }

        // Force sequence dimensions (e.g. 1080x1920 for 9:16 vertical)
        if (targetWidth && targetHeight && typeof newSeq.getSettings === 'function' && typeof newSeq.setSettings === 'function') {
            try {
                var seqSettings = newSeq.getSettings();
                if (seqSettings) {
                    seqSettings.videoFrameWidth = parseInt(targetWidth, 10);
                    seqSettings.videoFrameHeight = parseInt(targetHeight, 10);
                    newSeq.setSettings(seqSettings);
                }
            } catch (err) {}
        }

        // Ensure newly created sequence is open and active
        try {
            if (typeof app.project.openSequence === 'function') {
                app.project.openSequence(newSeq);
            }
        } catch (e1) {
            try {
                if (newSeq.sequenceID && typeof app.project.openSequence === 'function') {
                    app.project.openSequence(newSeq.sequenceID);
                }
            } catch (e2) {}
        }
        try { app.project.activeSequence = newSeq; } catch (e) {}

        return {
            success: true,
            name: name,
            id: newSeq.sequenceID || "",
            sequence: newSeq
        };
    }

    function addMarkerToSequence(seq, options) {
        if (!options && seq && (!seq.markers && (seq.time !== undefined || seq.name !== undefined))) {
            options = seq;
            seq = app.project ? app.project.activeSequence : null;
        }
        if (!seq && app.project) {
            seq = app.project.activeSequence;
        }
        if (!seq) return { success: false, error: "No active sequence" };

        var time = editflowUtils.getParam(options, 'time', 'position') || 0;
        var markerName = editflowUtils.getParam(options, 'name', 'label') || "EditFlow Marker";
        var color = editflowUtils.getParam(options, 'color_index', 'color');
        if (color === undefined) { color = 4; }
        var comments = editflowUtils.getParam(options, 'comments', 'comment') || "EditFlow auto-marker";

        try {
            var markers = seq.markers;
            if (markers && markers.createMarker) {
                // createMarker takes seconds (number) in modern Premiere Pro (>= v11).
                // Earlier "fix" to tick string caused 'Illegal Parameter type' rejections.
                var marker = markers.createMarker(time);
                if (marker) {
                    marker.name = markerName;
                    try { marker.comments = comments; } catch (e) {}
                    try {
                        // Color index: 0=Green, 1=Red, 2=Purple, 3=Orange, 4=Yellow, etc.
                        if (typeof marker.setColorByIndex === 'function') {
                            marker.setColorByIndex(color);
                        }
                    } catch (e) {}
                }
                return { success: true, name: markerName, time: time };
            }
            return { success: false, error: "Markers API not available" };
        } catch (e) {
            return { success: false, error: e.toString() };
        }
    }

    // ── Inline EDL Processing (no file on disk) ──

    function processEDLOps(options) {
        /*
         * Processes EDL operations passed as inline JSON (not from a file).
         * This is the path used by the agent flow: the backend generates
         * extendscript_ops and the panel sends them directly via
         * editflowDispatch("processEDL", ...).
         *
         * Supports the action types produced by plan_to_edl_ops():
         *   beginUndoGroup, endUndoGroup, ensure_bin, import_file,
         *   create_sequence, add, add_marker
         */
        var seq = app.project.activeSequence;
        var results = [];
        var undoGroupName = "EditFlow";

        try {
            // The panel sends { ops: [...] }, the old file format uses
            // { operations: [...] }.  Accept both keys.
            var operations = options.ops || options.operations || [];

            for (var i = 0; i < operations.length; i++) {
                var op = operations[i];
                var action = op.action || "";
                var result;

                switch (action) {
                    case "beginUndoGroup":
                        undoGroupName = op.name || "EditFlow";
                        // Premiere doesn't have a beginUndoGroup JS API —
                        // we record the name for diagnostics only.
                        result = { success: true, action: "beginUndoGroup" };
                        break;

                    case "endUndoGroup":
                        result = { success: true, action: "endUndoGroup" };
                        break;

                    case "import_file":
                        var importedItem = ensureProjectItemForPath(op.mediaPath || op.path, op.bin_name || op.binName);
                        result = importedItem
                            ? { success: true, path: op.mediaPath || op.path }
                            : { success: false, error: "Import failed: " + (op.mediaPath || op.path) };
                        break;

                    case "add":
                        // Ensure we have an active sequence
                        if (!seq) {
                            result = { success: false, error: "No active sequence" };
                        } else {
                            result = addClipToSequence(seq, op);
                        }
                        break;

                    case "ensure_bin":
                        result = ensureBin(op);
                        break;

                    case "create_sequence":
                        result = createSequenceFromOps(op);
                        if (result && result.success && result.sequence) {
                            seq = result.sequence;
                        } else {
                            seq = app.project.activeSequence;
                        }
                        if (!seq && app.project && app.project.sequences && app.project.sequences.numSequences > 0) {
                            seq = app.project.sequences[app.project.sequences.numSequences - 1];
                            try { app.project.openSequence(seq); } catch (e) {}
                        }
                        break;

                    case "add_marker":
                        if (!seq) {
                            result = { success: false, error: "No active sequence" };
                        } else {
                            result = addMarkerToSequence(seq, op);
                        }
                        break;

                    case "add_captions":
                        // Tier-1 captions via EDL: {action:"add_captions", srt_path:"..."}.
                        // captionsManager returns a JSON string; parse it back
                        // to an object so results stay uniform.
                        try {
                            result = JSON.parse(captionsManager.importSRTAsCaptionTrack(op));
                        } catch (e) {
                            result = { success: false, error: e.toString() };
                        }
                        break;

                    case "remove":
                        if (!seq) {
                            result = { success: false, error: "No active sequence" };
                        } else {
                            result = removeClipFromSequence(seq, op);
                        }
                        break;

                    case "move":
                        if (!seq) {
                            result = { success: false, error: "No active sequence" };
                        } else {
                            result = moveClipOnSequence(seq, op);
                        }
                        break;

                    case "modify":
                        if (!seq) {
                            result = { success: false, error: "No active sequence" };
                        } else {
                            result = modifyClipOnSequence(seq, op);
                        }
                        break;

                    default:
                        result = { success: false, error: "Unknown action: " + action };
                }

                result.operation = i;
                result.action = action;
                results.push(result);
            }

            // If options specify a sequence name, rename the active sequence
            if (options.sequence_name && seq && seq.name !== options.sequence_name) {
                try { seq.name = options.sequence_name; } catch (e) {}
            }

        } catch (e) {
            return editflowUtils.safeStringify({ success: false, error: e.toString(), results: results });
        }

        var failedCount = 0;
        var firstError = null;
        for (var k = 0; k < results.length; k++) {
            if (results[k] && results[k].success === false) {
                failedCount++;
                if (!firstError) {
                    firstError = results[k].error || ("Step " + results[k].operation + " (" + results[k].action + ") failed");
                }
            }
        }

        return editflowUtils.safeStringify({
            success: (failedCount === 0),
            totalOperations: operations.length,
            failedCount: failedCount,
            error: firstError,
            results: results
        });
    }

    return {
        processEDL: processEDL,
        processEDLOps: processEDLOps,
        addClipToSequence: addClipToSequence,
        removeClipFromSequence: removeClipFromSequence,
        moveClipOnSequence: moveClipOnSequence,
        modifyClipOnSequence: modifyClipOnSequence,
        findProjectItem: findProjectItem,
        ensureProjectItemForPath: ensureProjectItemForPath,
        removeTimelineClips: removeTimelineClips,
        removeTimelineRanges: removeTimelineRanges,
        clearTimelineLabels: clearTimelineLabels,
        addMediaToTimeline: addMediaToTimeline,
        importFilesFromPaths: importFilesFromPaths,
        insertClipAtTime: insertClipAtTime,
        createNewSequence: createNewSequence,
        ensureBin: ensureBin,
        organizeIntoBins: organizeIntoBins,
        setClipLabelColor: setClipLabelColor
    };
})();
