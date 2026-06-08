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
        var startTime = editflowUtils.getParam(options, 'startTime', 'time') || 0;
        var inPoint = editflowUtils.getParam(options, 'inPoint', 'in') || 0;
        var outPoint = editflowUtils.getParam(options, 'outPoint', 'out') || 0;

        // Track indices for insertClip's 4-arg form
        var videoTrackIndex = editflowUtils.getParam(options, 'video_track_index', 'videoTrackIndex');
        var audioTrackIndex = editflowUtils.getParam(options, 'audio_track_index', 'audioTrackIndex');

        // Backward-compat: legacy callers pass trackIndex only (defaults to V1/A1)
        if (videoTrackIndex === undefined) {
            var legacyTrack = editflowUtils.getParam(options, 'trackIndex', 'track');
            videoTrackIndex = (legacyTrack !== undefined) ? legacyTrack : 0;
        }
        if (audioTrackIndex === undefined) {
            audioTrackIndex = 0;
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
            // PPro's insertClip captures the projectItem's current in/out at
            // placement time, so setting them before insertClip causes the
            // placed TrackItem to inherit those values.  Each loop iteration
            // sets fresh values, so previously-placed clips are unaffected.
            // setInPoint/setOutPoint signature: (timeValue, mediaType)
            //   timeValue: string (parsed as ticks), number (seconds), or Time object
            //   mediaType: 1=video, 2=audio, 4=all media types
            if (inPoint > 0 || outPoint > 0) {
                try {
                    if (inPoint > 0 && typeof projectItem.setInPoint === 'function') {
                        projectItem.setInPoint(editflowUtils.secondsToTicksString(inPoint), 4);
                    }
                    if (outPoint > 0 && typeof projectItem.setOutPoint === 'function') {
                        projectItem.setOutPoint(editflowUtils.secondsToTicksString(outPoint), 4);
                    }
                } catch (e) {
                    // Diagnostic only — non-fatal; FIX-B may still trim
                    try { $.writeln("FIX-A setInPoint/setOutPoint failed: " + e.toString()); } catch (_) {}
                }
            }

            // Pass startTime as a tick STRING (not a seconds number) so video and audio
            // both anchor on the exact same integer tick — eliminates frame-rounding
            // drift that surfaced as PPro's red sync-offset badge between V and A.
            // Safe now that FIX-A pre-trims in/out via projectItem.setInPoint/setOutPoint.
            var startTicksStr = editflowUtils.secondsToTicksString(startTime);
            seq.insertClip(projectItem, startTicksStr, videoTrackIndex, audioTrackIndex);

            // ── FIX-B: Post-placement direct string assignment ───────────
            // Belt-and-suspenders with FIX-A.  The premiere-pro-mcp reference
            // repo uses direct string assignment (no .ticks).  We try both
            // strategies and capture before/after diagnostics so the panel can
            // prove which one actually trims the clip.
            var placedClip = _findClipAtTime(seq.videoTracks[videoTrackIndex], startTime);
            var diag = {
                found: !!placedClip,
                requested_in: inPoint,
                requested_out: outPoint
            };
            if (placedClip) {
                try {
                    // Capture BEFORE state
                    diag.before_in_ticks    = String(placedClip.inPoint.ticks || "");
                    diag.before_out_ticks   = String(placedClip.outPoint.ticks || "");
                    diag.before_start_ticks = String(placedClip.start.ticks || "");
                    diag.before_end_ticks   = String(placedClip.end.ticks || "");
                } catch (e) {}

                if (inPoint > 0) {
                    try { placedClip.inPoint = editflowUtils.secondsToTicksString(inPoint); } catch (e) { diag.in_err = e.toString(); }
                }
                if (outPoint > 0) {
                    try { placedClip.outPoint = editflowUtils.secondsToTicksString(outPoint); } catch (e) { diag.out_err = e.toString(); }
                }

                try {
                    // Capture AFTER state — proof of whether trim stuck
                    diag.after_in_ticks    = String(placedClip.inPoint.ticks || "");
                    diag.after_out_ticks   = String(placedClip.outPoint.ticks || "");
                    diag.after_start_ticks = String(placedClip.start.ticks || "");
                    diag.after_end_ticks   = String(placedClip.end.ticks || "");
                } catch (e) {}
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
        /* Find the clip on a track whose start matches startTimeSeconds.
         * Used after insertClip to locate the placed clip for in/out trimming.
         * Compares within ±0.05s tolerance to handle frame snapping. */
        if (!track) return null;
        var targetTicks = editflowUtils.secondsToTicks(startTimeSeconds);
        var tolerance = editflowUtils.secondsToTicks(0.05);
        for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            var clipStart = parseFloat(clip.start.ticks);
            if (Math.abs(clipStart - targetTicks) <= tolerance) {
                return clip;
            }
        }
        // Fallback: if there's only one clip on the track, it must be
        // the one we just placed — return it.
        if (track.clips.numItems === 1) {
            return track.clips[0];
        }
        return null;
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
            var seqID = name + '-' + new Date().getTime();
            var seq = app.project.createNewSequence(name, seqID);
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
        // The source clip path lets us build a sequence whose settings MATCH the
        // footage, so the "New Sequence" preset dialog never has to pop (spec §8.4).
        var clipPath = editflowUtils.getParam(options, 'preset_from_clip_path', 'presetFromClipPath');
        var presetPath = editflowUtils.getParam(options, 'presetPath', 'preset');
        var seqID = name + '-' + new Date().getTime();
        var newSeq = null;

        // Pre-import the source clip so Premiere can match its format (and so the
        // clip is already in the project before we add cuts).
        var clipItem = null;
        if (clipPath) { try { clipItem = ensureProjectItemForPath(clipPath); } catch (e) {} }

        // 1) Explicit .sqpreset path → 3-arg createNewSequence, no dialog.
        if (presetPath) {
            try { newSeq = app.project.createNewSequence(name, seqID, presetPath); } catch (e) { newSeq = null; }
        }
        // 2) Build a sequence directly from the source clip — matches its settings
        //    and skips the dialog. API name varies by build, so feature-detect.
        if (!newSeq && clipItem) {
            try {
                if (typeof app.project.createNewSequenceFromClips === 'function') {
                    newSeq = app.project.createNewSequenceFromClips(name, [clipItem]);
                }
            } catch (e) { newSeq = null; }
        }
        // 3) Fallback: default 2-arg create (may show the preset dialog on builds
        //    without the APIs above).
        if (!newSeq) {
            try { newSeq = app.project.createNewSequence(name, seqID); }
            catch (e) { return { success: false, error: e.toString() }; }
        }

        try { return { success: true, name: name, id: newSeq.sequenceID }; }
        catch (e) { return { success: true, name: name }; }
    }

    function addMarkerToSequence(seq, options) {
        if (!seq) return { success: false, error: "No active sequence" };

        var time = editflowUtils.getParam(options, 'time', 'position') || 0;
        var markerName = editflowUtils.getParam(options, 'name', 'label') || "EditFlow Marker";
        var color = editflowUtils.getParam(options, 'color') || 0;

        try {
            var markers = seq.markers;
            if (markers && markers.createMarker) {
                // createMarker takes seconds (number) in modern Premiere Pro (>= v11).
                // Earlier "fix" to tick string caused 'Illegal Parameter type' rejections.
                var marker = markers.createMarker(time);
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
                        var importedItem = ensureProjectItemForPath(op.mediaPath || op.path);
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
                        // After creating a sequence, it becomes the active one
                        seq = app.project.activeSequence;
                        break;

                    case "add_marker":
                        if (!seq) {
                            result = { success: false, error: "No active sequence" };
                        } else {
                            result = addMarkerToSequence(seq, op);
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

        return editflowUtils.safeStringify({ success: true, totalOperations: operations.length, results: results });
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
        organizeIntoBins: organizeIntoBins,
        setClipLabelColor: setClipLabelColor
    };
})();
