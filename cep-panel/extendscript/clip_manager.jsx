/*
 * clip_manager.jsx - Manage clips on the Premiere Pro timeline.
 * Handles adding, removing, moving, and organizing clips.
 * Also processes EDL (Edit Decision List) JSON files for batch operations.
 */
clipManager = (function() {
    "use strict";

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
                        seq = app.project.activeSequence;
                        break;
                    case "add_marker":
                        result = addMarkerToSequence(seq, op);
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

        return editflowUtils.safeStringify({ success: true, totalOperations: operations.length, results: results });
    }

    // ── Individual Operations ──

    function addClipToSequence(seq, options) {
        var mediaPath = editflowUtils.getParam(options, 'mediaPath', 'path');
        var trackIndex = editflowUtils.getParam(options, 'trackIndex', 'track') || 0;
        var startTime = editflowUtils.getParam(options, 'startTime', 'time') || 0;
        var inPoint = editflowUtils.getParam(options, 'inPoint', 'in') || 0;
        var outPoint = editflowUtils.getParam(options, 'outPoint', 'out') || 0;

        try {
            var projectItem = findProjectItem(mediaPath);
            if (!projectItem) {
                projectItem = ensureProjectItemForPath(mediaPath);
                if (!projectItem) {
                    return { success: false, error: "Could not find or import: " + mediaPath };
                }
            }

            var targetTrack = seq.videoTracks[trackIndex];
            if (!targetTrack) {
                return { success: false, error: "Video track " + trackIndex + " not found" };
            }

            // Set in/out points if specified
            if (inPoint > 0 || outPoint > 0) {
                try {
                    if (inPoint > 0) projectItem.setInPoint(editflowUtils.secondsToTicks(inPoint));
                    if (outPoint > 0) projectItem.setOutPoint(editflowUtils.secondsToTicks(outPoint));
                } catch (e) {}
            }

            targetTrack.overwriteClip(projectItem, editflowUtils.secondsToTicks(startTime));

            // ── Phase 2 (M13): Audio fade support ────────────────────────
            // After the clip is placed, try to set audio fade-in / fade-out
            // via the Premiere API.  Non-critical: gracefully degrades on
            // older PPro builds that don't expose these methods.
            try {
                var lastClip = targetTrack.clips[targetTrack.clips.numItems - 1];
                if (lastClip && op.audio_fade_in_ms) {
                    var fadeInTicks = editflowUtils.secondsToTicks(op.audio_fade_in_ms / 1000);
                    if (typeof lastClip.setAudioFadeIn === 'function') {
                        lastClip.setAudioFadeIn(fadeInTicks);
                    }
                }
                if (lastClip && op.audio_fade_out_ms) {
                    var fadeOutTicks = editflowUtils.secondsToTicks(op.audio_fade_out_ms / 1000);
                    if (typeof lastClip.setAudioFadeOut === 'function') {
                        lastClip.setAudioFadeOut(fadeOutTicks);
                    }
                }
            } catch (e) {
                // Audio fade API not available in this PPro version — non-critical
            }

            return { success: true, name: projectItem.name, startTime: startTime };

        } catch (e) {
            return { success: false, error: e.toString() };
        }
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
            clip.start = editflowUtils.secondsToTicks(newStartTime);
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

            // Speed
            var speed = editflowUtils.getParam(options, 'speed');
            if (speed !== undefined) {
                try {
                    clip.setSpeed(speed);
                    modified.push("speed=" + speed);
                } catch (e) {}
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
        for (var i = 0; i < bin.children.numItems; i++) {
            var item = bin.children[i];
            if (item.type === ProjectItemType.BIN) {
                var found = findItemInBin(item, mediaPath);
                if (found) return found;
            } else {
                try {
                    var itemPath = item.getMediaPath ? item.getMediaPath() : "";
                    if (itemPath === mediaPath) return item;
                } catch (e) {}
            }
        }
        return null;
    }

    function ensureProjectItemForPath(mediaPath) {
        /* Import file into project if it's not already there */
        var existing = findProjectItem(mediaPath);
        if (existing) return existing;

        try {
            var project = app.project;
            var root = project.rootItem;

            // Create an "EditFlow Imports" bin
            var importBin = editflowUtils.findBin(root, "EditFlow Imports");
            if (!importBin) {
                root.createBin("EditFlow Imports");
                importBin = editflowUtils.findBin(root, "EditFlow Imports");
            }
            if (!importBin) importBin = root;

            // Import the file
            project.importFiles([mediaPath], true, importBin, false);

            // Wait briefly and search again
            $.sleep(500);
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
                        clip.setColorLabel(0); // Reset to Violet/Default
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

        try {
            var project = app.project;
            var root = project.rootItem;

            var importBin = editflowUtils.findBin(root, "EditFlow Imports");
            if (!importBin) {
                root.createBin("EditFlow Imports");
                importBin = editflowUtils.findBin(root, "EditFlow Imports");
            }
            if (!importBin) importBin = root;

            project.importFiles(paths, true, importBin, false);

            return editflowUtils.safeStringify({ success: true, imported: paths.length });

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
        var name = editflowUtils.getParam(options, 'name') || "EditFlow Cut";
        try {
            var seq = app.project.createSequence(name);
            return editflowUtils.safeStringify({ success: true, name: name, id: seq.sequenceID });
        } catch (e) {
            return editflowUtils.safeStringify({ success: false, error: e.toString() });
        }
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
            clip.setColorLabel(labelIndex);
            return editflowUtils.safeStringify({ success: true });
        } catch (e) {
            return editflowUtils.safeStringify({ success: false, error: e.toString() });
        }
    }

    function removeTimelineRanges(options) {
        /*
         * Remove or "ripple delete" arbitrary timeline ranges (in seconds).
         * Used by the spoken-phrase removal workflow.
         *
         * GUARDED: This first version refuses to actually cut the timeline
         * unless Premiere's QE razor() and lift()/extract() APIs are available
         * AND the caller explicitly opts in. Otherwise it returns a diagnostic
         * so the panel can surface exactly what's missing before destroying
         * user work.
         */
        var seq = app.project.activeSequence;
        if (!seq) {
            return editflowUtils.safeStringify({ success: false, error: "No active sequence" });
        }

        var ranges = editflowUtils.getParam(options, "ranges") || [];
        if (!ranges.length) {
            return editflowUtils.safeStringify({ success: false, error: "No ranges provided" });
        }

        var confirmed = editflowUtils.getParam(options, "confirmed") === true;

        try {
            app.enableQE();
        } catch (e) {
            return editflowUtils.safeStringify({
                success: false,
                error: "QE not available: " + e.toString(),
                ranges: ranges
            });
        }

        var qeSeq;
        try {
            qeSeq = qe.project.getActiveSequence();
        } catch (e) {
            return editflowUtils.safeStringify({
                success: false,
                error: "Cannot read QE sequence: " + e.toString()
            });
        }
        if (!qeSeq) {
            return editflowUtils.safeStringify({ success: false, error: "No active QE sequence" });
        }
        if (typeof qeSeq.razor !== "function") {
            return editflowUtils.safeStringify({
                success: false,
                error: "QE razor() is not available in this Premiere build",
                ranges: ranges
            });
        }

        if (!confirmed) {
            // Sentinel: caller saw the preview but hasn't actually confirmed yet.
            return editflowUtils.safeStringify({
                success: false,
                error: "Range removal needs Premiere QE razor verification before destructive editing.",
                ranges: ranges,
                requires_confirmation: true
            });
        }

        // Destructive path — implemented in a follow-up once QE is verified
        // by hand on the user's machine.
        return editflowUtils.safeStringify({
            success: false,
            error: "Destructive removal path not yet enabled. Use Preview to inspect ranges.",
            ranges: ranges
        });
    }

    // ── EditFlow Script Cut Operations ──

    function ensureBin(options) {
        var binName = editflowUtils.getParam(options, 'bin_name', 'name') || "EditFlow Output";
        var project = app.project;
        if (!project) return { success: false, error: "No project open" };

        var root = project.rootItem;
        var existing = editflowUtils.findBin(root, binName);
        if (existing) return { success: true, name: binName, existed: true };

        try {
            root.createBin(binName);
            return { success: true, name: binName, existed: false };
        } catch (e) {
            return { success: false, error: e.toString() };
        }
    }

    function createSequenceFromOps(options) {
        var name = editflowUtils.getParam(options, 'name') || "EditFlow Cut";
        try {
            var newSeq = app.project.createSequence(name);
            return { success: true, name: name, id: newSeq.sequenceID };
        } catch (e) {
            return { success: false, error: e.toString() };
        }
    }

    function addMarkerToSequence(seq, options) {
        if (!seq) return { success: false, error: "No active sequence" };

        var time = editflowUtils.getParam(options, 'time', 'position') || 0;
        var markerName = editflowUtils.getParam(options, 'name', 'label') || "EditFlow Marker";
        var color = editflowUtils.getParam(options, 'color') || 0;

        try {
            var markers = seq.markers;
            if (markers && markers.createMarker) {
                var ticks = editflowUtils.secondsToTicks(time);
                var marker = markers.createMarker(ticks);
                if (marker) {
                    marker.name = markerName;
                    try { marker.comments = "EditFlow auto-marker"; } catch (e) {}
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

    return {
        processEDL: processEDL,
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
        organizeIntoBins: organizeIntoBins,
        setClipLabelColor: setClipLabelColor
    };
})();
