/**
 * EditFlow AI - Clip Manager
 * Creates, moves, removes clips on the Premiere Pro timeline.
 * This is the main module that executes EDL instructions.
 */

var clipManager = (function() {
    "use strict";

    /**
     * Process a complete EDL instruction file.
     * @param {string} edlJsonPath - Path to the EDL JSON file
     * @returns {Object} Execution result
     */
    function processEDL(edlJsonPath) {
        var result = {
            success: true,
            edlId: "",
            processed: 0,
            failed: 0,
            errors: [],
            undoGroup: "EditFlow AI"
        };

        try {
            // Read EDL JSON file
            var edlFile = new File(edlJsonPath);
            if (!edlFile.exists) {
                result.success = false;
                result.error = "EDL file not found: " + edlJsonPath;
                return result;
            }

            edlFile.open("r");
            var edlText = edlFile.read();
            edlFile.close();

            var edl = JSON.parse(edlText); // Parse JSON

            result.edlId = edl.id || "";
            result.undoGroup = edl.undo_group || "EditFlow AI";

            // Begin undo group
            app.enableQE();

            var seq = resolveSequenceForEDL(edl);
            if (!seq) {
                result.success = false;
                result.error = "No target sequence could be created or found";
                return result;
            }

            // Process each clip instruction
            for (var i = 0; i < edl.clips.length; i++) {
                var clipInstruction = edl.clips[i];
                try {
                    processClipInstruction(seq, clipInstruction);
                    result.processed++;
                } catch (e) {
                    result.failed++;
                    result.errors.push({
                        clipId: clipInstruction.id,
                        error: e.toString()
                    });
                }
            }

            if (result.failed > 0) {
                result.success = false;
                result.error = result.failed + " clip(s) failed to process";
            }

        } catch (e) {
            result.success = false;
            result.error = e.toString();
        }

        return result;
    }

    /**
     * Process a single clip instruction.
     * @param {Sequence} seq - Target sequence
     * @param {Object} instruction - Clip instruction
     */
    function processClipInstruction(seq, instruction) {
        switch (instruction.action) {
            case "add":
                addClipToSequence(seq, instruction);
                break;
            case "remove":
                removeClipFromSequence(seq, instruction);
                break;
            case "move":
                moveClipOnSequence(seq, instruction);
                break;
            case "modify":
                modifyClipOnSequence(seq, instruction);
                break;
            default:
                throw new Error("Unknown action: " + instruction.action);
        }
    }

    /**
     * Add a clip to the sequence.
     * @param {Sequence} seq
     * @param {Object} instruction
     */
    function addClipToSequence(seq, instruction) {
        // Find the project item by path
        var projectItem = ensureProjectItemForPath(instruction.source_path);
        if (!projectItem) {
            throw new Error("Project item not found: " + instruction.source_path);
        }

        // Calculate time codes (ticks)
        var timebase = seq.timebase;
        var startTicks = secondsToTicks(instruction.start_time, timebase);
        var inTicks = secondsToTicks(instruction.in_point, timebase);
        var outTicks = secondsToTicks(instruction.out_point, timebase);

        // Determine target track
        var clipType = instruction.clip_type || instruction.clipType || "b_roll";
        var trackIndex = instruction.track_index;
        if (trackIndex === undefined) trackIndex = instruction.trackIndex;
        trackIndex = Number(trackIndex || 0);
        var isAudio = clipType === "a_audio" || clipType === "audio";
        ensureTrackCount(seq, isAudio ? "audio" : "video", trackIndex);
        var targetTrack = isAudio ? seq.audioTracks[trackIndex] : seq.videoTracks[trackIndex];

        if (!targetTrack) {
            throw new Error("Track not found: index " + trackIndex);
        }

        // Insert clip
        // Set in/out points on source first
        projectItem.setInPoint(inTicks);
        projectItem.setOutPoint(outTicks);
        
        // Overwrite at destination
        targetTrack.overwriteClip(projectItem, startTicks);


        // Apply scale if needed
        if (instruction.scale && instruction.scale !== 100) {
            applyScaleToLastClip(seq, targetTrack, instruction.scale);
        }
    }

    /**
     * Remove a clip from the sequence.
     * @param {Sequence} seq
     * @param {Object} instruction
     */
    function removeClipFromSequence(seq, instruction) {
        var startTime = secondsToTicks(instruction.start_time, seq.timebase);
        var track = getTrack(seq, instruction);

        if (track) {
            // Find clip at the specified time
            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                if (Math.abs(clip.start.ticks - startTime) < 10) {
                    clip.remove(true, true); // ripple, align to video
                    break;
                }
            }
        }
    }

    /**
     * Move a clip on the sequence.
     * @param {Sequence} seq
     * @param {Object} instruction
     */
    function moveClipOnSequence(seq, instruction) {
        // Premiere Pro doesn't have a direct "move" API
        // We need to remove and re-add
        removeClipFromSequence(seq, instruction);
        instruction.action = "add";
        addClipToSequence(seq, instruction);
    }

    /**
     * Modify a clip's properties.
     * @param {Sequence} seq
     * @param {Object} instruction
     */
    function modifyClipOnSequence(seq, instruction) {
        var startTime = secondsToTicks(instruction.start_time, seq.timebase);
        var track = getTrack(seq, instruction);

        if (track) {
            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                if (Math.abs(clip.start.ticks - startTime) < 10) {
                    // Apply scale
                    if (instruction.scale) {
                        applyScale(clip, instruction.scale);
                    }
                    // Apply speed
                    if (instruction.speed && instruction.speed !== 1.0) {
                        clip.setSpeed(instruction.speed);
                    }
                    break;
                }
            }
        }
    }

    /**
     * Find a project item by its media path.
     * @param {string} path - Media file path
     * @returns {ProjectItem|null}
     */
    function findProjectItem(path) {
        var project = app.project;
        if (!project) return null;

        return searchForItem(project.rootItem, path);
    }

    function ensureProjectItemForPath(path) {
        if (!path) return null;

        var existing = findProjectItem(path);
        if (existing) return existing;

        try {
            var file = new File(path);
            if (!file.exists) return null;

            var targetBin = getOrCreateBin("EditFlow Imports");
            app.project.importFiles([file.fsName], true, targetBin, false);
            return findProjectItem(file.fsName) || findProjectItem(path);
        } catch(e) {
            return null;
        }
    }

    function searchForItem(bin, path) {
        for (var i = 0; i < bin.children.numItems; i++) {
            var item = bin.children[i];

            if (item.type === ProjectItemType.BIN) {
                var found = searchForItem(item, path);
                if (found) return found;
            }
            else if (item.type === ProjectItemType.CLIP ||
                     item.type === ProjectItemType.FILE) {
                try {
                    var mediaPath = item.getMediaPath();
                    if (mediaPath && mediaPath.toLowerCase() === path.toLowerCase()) {
                        return item;
                    }
                } catch(e) {}
            }
        }
        return null;
    }

    function secondsToTicks(seconds) {
        return editflowUtils.secondsToTicks(seconds);
    }

    function resolveSequenceForEDL(edl) {
        var project = app.project;
        if (!project) return null;

        var target = edl.target || "";
        if (target && target !== "@new_sequence") {
            var named = getTargetSequence(target);
            if (named && named.name === target) return named;
        }

        if (target === "@new_sequence" || !project.activeSequence) {
            var created = createSequenceFromEDL(edl);
            if (created) return created;
        }

        return project.activeSequence;
    }

    function createSequenceFromEDL(edl) {
        try {
            var firstItem = null;
            for (var i = 0; i < edl.clips.length; i++) {
                firstItem = ensureProjectItemForPath(edl.clips[i].source_path);
                if (firstItem) break;
            }
            if (!firstItem) return null;

            var name = edl.sequence_name || edl.sequenceName || ("EditFlow " + (edl.id || "Sequence"));
            var seq = app.project.createNewSequenceFromClips(name, [firstItem], app.project.rootItem);
            if (!seq) return app.project.activeSequence;

            clearSequenceTracks(seq);
            ensureTrackCount(seq, "video", 1);
            ensureTrackCount(seq, "audio", 0);
            return seq;
        } catch(e) {
            return null;
        }
    }

    function clearSequenceTracks(seq) {
        try {
            for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) {
                var vtrack = seq.videoTracks[vt];
                for (var vc = vtrack.clips.numItems - 1; vc >= 0; vc--) {
                    vtrack.clips[vc].remove(false, false);
                }
            }
            for (var at = 0; at < seq.audioTracks.numTracks; at++) {
                var atrack = seq.audioTracks[at];
                for (var ac = atrack.clips.numItems - 1; ac >= 0; ac--) {
                    atrack.clips[ac].remove(false, false);
                }
            }
        } catch(e) {}
    }

    function ensureTrackCount(seq, trackType, trackIndex) {
        try {
            if (trackType === "audio") {
                while (seq.audioTracks.numTracks <= trackIndex && seq.audioTracks.createAudioTrack) {
                    seq.audioTracks.createAudioTrack("Audio " + (seq.audioTracks.numTracks + 1));
                }
            } else {
                while (seq.videoTracks.numTracks <= trackIndex && seq.videoTracks.createVideoTrack) {
                    seq.videoTracks.createVideoTrack("Video " + (seq.videoTracks.numTracks + 1));
                }
            }
        } catch(e) {}
    }

    /**
     * Get a track from the sequence.
     * @param {Sequence} seq
     * @param {Object} instruction
     * @returns {Track|null}
     */

    /**
     * Get a track from the sequence.
     * @param {Sequence} seq
     * @param {Object} instruction
     * @returns {Track|null}
     */
    function getTrack(seq, instruction) {
        var isVideo = (instruction.clip_type !== "a_audio");
        var tracks = isVideo ? seq.videoTracks : seq.audioTracks;
        var idx = instruction.track_index || 0;
        return (idx < tracks.numTracks) ? tracks[idx] : null;
    }

    /**
     * Remove clips from the current/target sequence by rule.
     * Supported options:
     * - mode: "broll" removes video clips on V2 and above
     * - mode: "label" removes clips whose project item label matches label_name
     * @param {Object} options
     * @returns {Object}
     */
    function removeTimelineClips(options) {
        options = options || {};
        var result = {
            success: true,
            mode: options.mode || "",
            labelName: options.label_name || options.labelName || "",
            sequenceName: "",
            scanned: 0,
            removed: 0,
            errors: []
        };

        try {
            var requestedSequence = options.sequence_name || options.sequenceName || "";
            var seq = getTargetSequence(requestedSequence);
            if (!seq) {
                result.success = false;
                result.error = "Target sequence not found or no active sequence";
                return result;
            }
            result.sequenceName = seq.name || "";

            if (requestedSequence && seq.name !== requestedSequence) {
                result.success = false;
                result.error = "Active sequence is '" + seq.name + "', not '" + requestedSequence + "'";
                return result;
            }

            if (result.mode === "label") {
                removeByLabel(seq, result.labelName, result);
            } else if (result.mode === "broll") {
                removeBroll(seq, result);
            } else {
                result.success = false;
                result.error = "Unsupported removal mode: " + result.mode;
            }
        } catch (e) {
            result.success = false;
            result.error = e.toString();
            result.line = e.line;
        }

        return result;
    }

    /**
     * Clear/reset matching timeline clip labels without deleting clips.
     * @param {Object} options
     * @returns {Object}
     */
    function clearTimelineLabels(options) {
        options = options || {};
        var result = {
            success: true,
            mode: "label",
            labelName: options.label_name || options.labelName || "",
            sequenceName: "",
            scanned: 0,
            changed: 0,
            errors: []
        };

        try {
            var requestedSequence = options.sequence_name || options.sequenceName || "";
            var seq = getTargetSequence(requestedSequence);
            if (!seq) {
                result.success = false;
                result.error = "Target sequence not found or no active sequence";
                return result;
            }
            result.sequenceName = seq.name || "";

            if (requestedSequence && seq.name !== requestedSequence) {
                result.success = false;
                result.error = "Active sequence is '" + seq.name + "', not '" + requestedSequence + "'";
                return result;
            }

            clearLabelOnTracks(seq.videoTracks, result);
            clearLabelOnTracks(seq.audioTracks, result);
        } catch (e) {
            result.success = false;
            result.error = e.toString();
            result.line = e.line;
        }

        return result;
    }

    function getTargetSequence(sequenceName) {
        var seq = app.project.activeSequence;
        if (!sequenceName || (seq && seq.name === sequenceName)) {
            return seq;
        }

        try {
            var sequences = app.project.sequences;
            for (var i = 0; i < sequences.numSequences; i++) {
                var candidate = sequences[i];
                if (candidate && candidate.name === sequenceName) {
                    return candidate;
                }
            }
        } catch (e) {}

        return seq;
    }

    function removeBroll(seq, result) {
        for (var t = seq.videoTracks.numTracks - 1; t >= 1; t--) {
            var track = seq.videoTracks[t];
            for (var c = track.clips.numItems - 1; c >= 0; c--) {
                result.scanned++;
                removeClipSafely(track.clips[c], result);
            }
        }
    }

    function removeByLabel(seq, labelName, result) {
        var expected = normalizeText(labelName);
        if (!expected) {
            result.success = false;
            result.error = "No label name provided";
            return;
        }

        for (var t = seq.videoTracks.numTracks - 1; t >= 0; t--) {
            var track = seq.videoTracks[t];
            for (var c = track.clips.numItems - 1; c >= 0; c--) {
                var clip = track.clips[c];
                result.scanned++;
                var label = getClipLabelName(clip);
                if (normalizeText(label) === expected) {
                    removeClipSafely(clip, result);
                }
            }
        }

        for (var at = seq.audioTracks.numTracks - 1; at >= 0; at--) {
            var audioTrack = seq.audioTracks[at];
            for (var ac = audioTrack.clips.numItems - 1; ac >= 0; ac--) {
                var audioClip = audioTrack.clips[ac];
                result.scanned++;
                var audioLabel = getClipLabelName(audioClip);
                if (normalizeText(audioLabel) === expected) {
                    removeClipSafely(audioClip, result);
                }
            }
        }
    }

    function clearLabelOnTracks(tracks, result) {
        var expected = normalizeText(result.labelName);
        if (!expected) {
            result.success = false;
            result.error = "No label name provided";
            return;
        }

        for (var t = tracks.numTracks - 1; t >= 0; t--) {
            var track = tracks[t];
            for (var c = track.clips.numItems - 1; c >= 0; c--) {
                var clip = track.clips[c];
                result.scanned++;
                var label = getClipLabelName(clip);
                if (normalizeText(label) === expected) {
                    clearClipLabelSafely(clip, result);
                }
            }
        }
    }

    function removeClipSafely(clip, result) {
        try {
            clip.remove(false, true);
            result.removed++;
        } catch (e) {
            result.errors.push(e.toString());
        }
    }

    function clearClipLabelSafely(clip, result) {
        try {
            if (clip.setColorLabel) {
                clip.setColorLabel(0);
                result.changed++;
                return;
            }
        } catch (e1) {
            result.errors.push(e1.toString());
        }

        try {
            if (clip.projectItem && clip.projectItem.setColorLabel) {
                clip.projectItem.setColorLabel(0);
                result.changed++;
                return;
            }
        } catch (e2) {
            result.errors.push(e2.toString());
        }

        try {
            if (clip.projectItem && clip.projectItem.label !== undefined) {
                clip.projectItem.label = 0;
                result.changed++;
                return;
            }
        } catch (e3) {
            result.errors.push(e3.toString());
        }

        result.errors.push("Could not clear label for clip: " + (clip.name || "unknown"));
    }

    function getClipLabelName(clip) {
        try {
            if (clip.getColorLabel) {
                return labelValueToName(clip.getColorLabel());
            }
        } catch (e1) {}

        try {
            if (clip.projectItem && clip.projectItem.getColorLabel) {
                return labelValueToName(clip.projectItem.getColorLabel());
            }
        } catch (e2) {}

        try {
            if (clip.projectItem && clip.projectItem.label) {
                return labelValueToName(clip.projectItem.label);
            }
        } catch (e3) {}

        return "";
    }

    function labelValueToName(value) {
        if (value === undefined || value === null) return "";
        if (typeof value === "string") return value;

        var labels = [
            "Violet", "Iris", "Caribbean", "Lavender",
            "Cerulean", "Forest", "Rose", "Mango"
        ];
        var idx = Number(value);
        if (!isNaN(idx) && idx >= 0 && idx < labels.length) {
            return labels[idx];
        }

        return String(value);
    }

    function normalizeText(value) {
        return String(value || "").replace(/^\s+|\s+$/g, "").toLowerCase();
    }

    /**
     * Apply scale effect to a clip.
     * @param {TrackItem} clip
     * @param {number} scalePercent
     */
    function applyScale(clip, scalePercent) {
        try {
            var components = clip.components;
            for (var i = 0; i < components.numItems; i++) {
                var comp = components[i];
                if (comp.displayName === "Motion" || comp.matchName === "motion") {
                    var props = comp.properties;
                    for (var p = 0; p < props.numItems; p++) {
                        var prop = props[p];
                        if (prop.displayName === "Scale") {
                            prop.setValue(scalePercent);
                            break;
                        }
                    }
                    break;
                }
            }
        } catch(e) {
            // Scale application failed, log but don't throw
            $.writeln("Scale apply failed: " + e.toString());
        }
    }

    /**
     * Apply scale to the last clip on a track.
     * @param {Sequence} seq
     * @param {Track} track
     * @param {number} scalePercent
     */
    function applyScaleToLastClip(seq, track, scalePercent) {
        try {
            var lastClip = track.clips[track.clips.numItems - 1];
            if (lastClip) {
                applyScale(lastClip, scalePercent);
            }
        } catch(e) {}
    }

    /**
     * Add media file to timeline.
     * @param {Object} options - {media_type, filename, track_index, start_time}
     * @returns {Object} Result
     */
    function addMediaToTimeline(options) {
        var result = { success: false };
        var mediaType = options.mediaType || options.media_type || 'audio';
        var filename = options.filename || options.clipName || options.clip_name || '';
        var trackIndex = options.trackIndex || options.track_index || 0;
        var startTime = options.startTime || options.start_time || 0;

        try {
            var proj = app.project;
            if (!proj) {
                result.error = "No active project";
                return result;
            }

            // Get or create the sequence
            var seq = proj.activeSequence;
            if (!seq) {
                result.error = "No active sequence";
                return result;
            }

            // Find the media in project - search by filename
            var projectItem = findProjectItemByName(filename);
            if (!projectItem) {
                result.error = "Media file not found in project: " + filename;
                return result;
            }

            // Determine track type
            var isAudio = (mediaType === 'music' || mediaType === 'audio');
            var trackName = "";
            
            // Create track if needed
            if (isAudio) {
                if (trackIndex >= seq.audioTracks.numTracks) {
                    for (var i = seq.audioTracks.numTracks; i <= trackIndex; i++) {
                        seq.audioTracks.createAudioTrack("Music " + (i + 1));
                    }
                }
                var targetTrack = seq.audioTracks[trackIndex];
                trackName = targetTrack.name;
                
                // Insert media on audio track using insertMedia
                var inserted = targetTrack.insertMedia(projectItem, false);
                
                if (inserted && inserted.length > 0) {
                    result.success = true;
                } else {
                    result.error = "Failed to insert media on track";
                }
            } else {
                // Video track
                if (trackIndex >= seq.videoTracks.numTracks) {
                    for (var i = seq.videoTracks.numTracks; i <= trackIndex; i++) {
                        seq.videoTracks.createVideoTrack("Video " + (i + 1));
                    }
                }
                var targetTrack = seq.videoTracks[trackIndex];
                trackName = targetTrack.name;
                
                var inserted = targetTrack.insertMedia(projectItem, false);
                
                if (inserted && inserted.length > 0) {
                    result.success = true;
                } else {
                    result.error = "Failed to insert media on track";
                }
            }
            
            result.trackName = trackName;
            result.clipName = projectItem.name;
            
        } catch(e) {
            result.error = e.toString() + " (line " + e.line + ")";
        }
        
        return result;
    }

    /**
     * Find project item by filename (partial match).
     * @param {string} filename - Filename to search for
     * @returns {ProjectItem|null}
     */
    function findProjectItemByName(filename) {
        var project = app.project;
        if (!project) return null;

        var searchName = filename.toLowerCase().replace(/[\[\]]/g, '');
        
        return searchForItemByName(project.rootItem, searchName);
    }

    function searchForItemByName(bin, searchName) {
        for (var i = 0; i < bin.children.numItems; i++) {
            var item = bin.children[i];

            if (item.type === ProjectItemType.BIN) {
                var found = searchForItemByName(item, searchName);
                if (found) return found;
            }
            else if (item.type === ProjectItemType.CLIP ||
                     item.type === ProjectItemType.FILE) {
                try {
                    var itemName = item.name.toLowerCase();
                    if (itemName.indexOf(searchName) !== -1) {
                        return item;
                    }
                } catch(e) {}
            }
        }
        return null;
    }

    function importFilesFromPaths(options) {
        try {
            var paths = options.paths || [];
            if (paths.length === 0) return { success: false, error: "No paths provided" };
            var suppressUI = true;
            var targetBin = app.project.rootItem;
            if (options.targetBin || options.target_bin) {
                targetBin = getOrCreateBin(options.targetBin || options.target_bin);
            }
            app.project.importFiles(paths, suppressUI, targetBin, false);
            return { success: true, imported: paths.length };
        } catch(e) { return { success: false, error: e.toString() }; }
    }

    function getOrCreateBin(binName) {
        var found = editflowUtils.findBin(app.project.rootItem, binName);
        if (found) return found;
        return app.project.rootItem.createBin(binName);
    }

    function addAllBinClipsToSequence(options) {
        try {
            var seq = app.project.activeSequence;
            if (!seq && (options.sequenceName || options.sequence_name)) seq = getTargetSequence(options.sequenceName || options.sequence_name);
            if (!seq) return { success: false, error: "No active sequence" };
            
            var binName = options.source || "all";
            var itemsToInsert = [];
            
            function collectClips(bin) {
                for (var i = 0; i < bin.children.numItems; i++) {
                    var item = bin.children[i];
                    if (item.type === ProjectItemType.BIN) {
                        collectClips(item);
                    } else if (item.type === ProjectItemType.CLIP || item.type === ProjectItemType.FILE) {
                        var isVideo = typeof item.hasVideo === 'function' ? (item.hasVideo() === 1 || item.hasVideo() === true) : true;
                        var isAudio = typeof item.hasAudio === 'function' ? (item.hasAudio() === 1 || item.hasAudio() === true) : true;
                        
                        if (options.filter === "video" && !isVideo) continue;
                        if (options.filter === "audio") {
                            if (!isAudio) continue;
                            if (isVideo) continue; // Exclude clips that have video if we specifically want audio/music
                        }
                        
                        itemsToInsert.push(item);
                    }
                }
            }
            
            if (binName === "all") collectClips(app.project.rootItem);
            else collectClips(getOrCreateBin(binName));
            
            var trackIndex = options.trackIndex || options.track_index || 0;
            if (itemsToInsert.length > 0) {
                var targetTrack;
                if (options.filter === "audio") {
                    targetTrack = seq.audioTracks[trackIndex] || seq.audioTracks[0];
                } else {
                    targetTrack = seq.videoTracks[trackIndex] || seq.videoTracks[0];
                }
                
                var time = editflowUtils.getSequenceEnd(seq);
                for (var j = 0; j < itemsToInsert.length; j++) {
                    targetTrack.insertClip(itemsToInsert[j], time);
                    time = editflowUtils.getSequenceEnd(seq);
                }
                return { success: true, count: itemsToInsert.length };
            }
            return { success: true, count: 0, message: "No clips found" };
        } catch(e) { return { success: false, error: e.toString() }; }
    }

    function insertClipAtTime(options) {
        try {
            var seq = app.project.activeSequence;
            if (!seq) return { success: false, error: "No active sequence" };
            var item = findProjectItemByName(options.clipName || options.clip_name);
            if (!item) return { success: false, error: "Clip not found" };
            var trackIdx = options.trackIndex || options.track_index || 0;
            var timeTicks = secondsToTicks(options.startTime || options.start_time || 0);
            var trackType = options.trackType || options.track_type || "video";
            var track = trackType === "audio" ? seq.audioTracks[trackIdx] : seq.videoTracks[trackIdx];
            if (!track) return { success: false, error: "Track not found" };
            track.insertClip(item, timeTicks);
            return { success: true };
        } catch(e) { return { success: false, error: e.toString() }; }
    }

    function findTimelineClip(seq, options) {
        var trackType = options.trackType || options.track_type || "video";
        var trackIdx = options.trackIndex || options.track_index || 0;
        var clipName = normalizeText(options.clipName || options.clip_name || "");
        var startTime = options.startTime;
        if (startTime === undefined) startTime = options.start_time;
        var tracks = trackType === "audio" ? seq.audioTracks : seq.videoTracks;
        if (trackIdx >= tracks.numTracks) return null;
        var track = tracks[trackIdx];
        for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            var nameMatches = !clipName || normalizeText(clip.name).indexOf(clipName) !== -1;
            var timeMatches = true;
            if (startTime !== undefined && startTime !== null && startTime !== "") {
                timeMatches = Math.abs(clip.start.seconds - Number(startTime)) < 0.05;
            }
            if (nameMatches && timeMatches) return clip;
        }
        return null;
    }

    function modifyClipByOptions(options) {
        options = options || {};
        try {
            var seq = getTargetSequence(options.sequenceName || options.sequence_name || "");
            if (!seq) return { success: false, error: "No active sequence" };
            var clip = findTimelineClip(seq, options);
            if (!clip) return { success: false, error: "Matching timeline clip not found" };
            var changed = 0;
            if (options.scale !== undefined && options.scale !== null) {
                applyScale(clip, Number(options.scale));
                changed++;
            }
            if (options.speed !== undefined && options.speed !== null) {
                if (!clip.setSpeed) return { success: false, error: "Speed changes are not available in this Premiere scripting API" };
                clip.setSpeed(Number(options.speed));
                changed++;
            }
            if (!changed) return { success: false, error: "No supported clip property was provided" };
            return { success: true, changed: changed, clipName: clip.name };
        } catch(e) {
            return { success: false, error: e.toString(), line: e.line };
        }
    }

    function moveClipByOptions(options) {
        options = options || {};
        try {
            var seq = getTargetSequence(options.sequenceName || options.sequence_name || "");
            if (!seq) return { success: false, error: "No active sequence" };
            var clip = findTimelineClip(seq, options);
            if (!clip) return { success: false, error: "Matching timeline clip not found" };
            var newStart = options.newStartTime;
            if (newStart === undefined) newStart = options.new_start_time;
            if (newStart === undefined || newStart === null || newStart === "") {
                return { success: false, error: "newStartTime is required to move a clip" };
            }
            if (!clip.move) return { success: false, error: "Clip move is not available in this Premiere scripting API" };
            clip.move(secondsToTicks(Number(newStart)));
            return { success: true, clipName: clip.name, startTime: Number(newStart) };
        } catch(e) {
            return { success: false, error: e.toString(), line: e.line };
        }
    }

    function createNewSequence(options) {
        try {
            var name = options.name || "New Sequence";
            var firstMedia = null;
            function findFirst(bin) {
                if (firstMedia) return;
                for (var i = 0; i < bin.children.numItems; i++) {
                    var item = bin.children[i];
                    if (item.type === ProjectItemType.BIN) findFirst(item);
                    else {
                        var hasV = typeof item.hasVideo === 'function' ? item.hasVideo() : true;
                        var hasA = typeof item.hasAudio === 'function' ? item.hasAudio() : true;
                        if (hasV || hasA) { firstMedia = item; return; }
                    }
                }
            }
            findFirst(app.project.rootItem);
            if (!firstMedia) return { success: false, error: "No media to base sequence on" };
            var seq = app.project.createNewSequenceFromClips(name, [firstMedia], app.project.rootItem);
            if (seq) {
                for (var t = 0; t < seq.videoTracks.numTracks; t++) {
                    for(var c = seq.videoTracks[t].clips.numItems-1; c>=0; c--) {
                        seq.videoTracks[t].clips[c].remove(false, false);
                    }
                }
                for (var t = 0; t < seq.audioTracks.numTracks; t++) {
                    for(var c = seq.audioTracks[t].clips.numItems-1; c>=0; c--) {
                        seq.audioTracks[t].clips[c].remove(false, false);
                    }
                }
                return { success: true, name: seq.name };
            }
            return { success: false, error: "Failed to create" };
        } catch(e) { return { success: false, error: e.toString() }; }
    }

    function organizeIntoBins(options) {
        options = options || {};
        try {
            var rules = options.rules || [];
            if (!rules.length && (options.binName || options.bin_name)) {
                rules = [{ binName: options.binName || options.bin_name, filter: options.filter || "all" }];
            }
            if (!rules.length) return { success: false, error: "No organization rules provided" };
            var moved = 0;
            for (var r = 0; r < rules.length; r++) {
                var rule = rules[r] || {};
                var binName = rule.binName || rule.bin_name;
                if (!binName) continue;
                moved += moveMatchingItemsToBin(app.project.rootItem, getOrCreateBin(binName), rule);
            }
            return { success: true, moved: moved };
        } catch(e) {
            return { success: false, error: e.toString(), line: e.line };
        }
    }

    function moveMatchingItemsToBin(bin, targetBin, rule) {
        var moved = 0;
        var filter = normalizeText(rule.filter || "all");
        var keyword = normalizeText(rule.keyword || rule.nameContains || "");
        for (var i = bin.children.numItems - 1; i >= 0; i--) {
            var item = bin.children[i];
            if (item === targetBin) continue;
            if (item.type === ProjectItemType.BIN) {
                moved += moveMatchingItemsToBin(item, targetBin, rule);
            } else if (item.type === ProjectItemType.CLIP || item.type === ProjectItemType.FILE) {
                if (!projectItemMatchesRule(item, filter, keyword)) continue;
                try {
                    if (item.moveBin) {
                        item.moveBin(targetBin);
                        moved++;
                    }
                } catch(e) {}
            }
        }
        return moved;
    }

    function projectItemMatchesRule(item, filter, keyword) {
        if (keyword && normalizeText(item.name).indexOf(keyword) === -1) return false;
        var hasV = editflowUtils.hasVideo(item);
        var hasA = editflowUtils.hasAudio(item);
        if (filter === "video") return hasV;
        if (filter === "audio") return hasA && !hasV;
        return true;
    }

    function setClipLabelColor(options) {
        try {
            var seq = getTargetSequence(options.sequenceName || options.sequence_name || "");
            if (!seq) return { success: false, error: "No active sequence" };
            var labelName = options.label || options.labelName || options.label_name || "";
            var labels = ["Violet", "Iris", "Caribbean", "Lavender", "Cerulean", "Forest", "Rose", "Mango"];
            var colorIdx = labels.indexOf(labelName);
            if (colorIdx === -1) colorIdx = 0;
            var changed = 0;
            for (var t = 0; t < seq.videoTracks.numTracks; t++) {
                var track = seq.videoTracks[t];
                for (var c = 0; c < track.clips.numItems; c++) {
                    var clip = track.clips[c];
                    try {
                        if (clip.projectItem) {
                            clip.projectItem.setColorLabel(colorIdx);
                            changed++;
                        }
                    } catch(e){}
                }
            }
            return { success: true, changed: changed };
        } catch(e) { return { success: false, error: e.toString() }; }
    }

    // Public API
    return {
        processEDL: processEDL,
        addClipToSequence: addClipToSequence,
        removeClipFromSequence: removeClipFromSequence,
        moveClipOnSequence: moveClipOnSequence,
        modifyClipOnSequence: modifyClipOnSequence,
        findProjectItem: findProjectItem,
        removeTimelineClips: removeTimelineClips,
        clearTimelineLabels: clearTimelineLabels,
        applyScale: applyScale,
        addMediaToTimeline: addMediaToTimeline,
        importFilesFromPaths: importFilesFromPaths,
        addAllBinClipsToSequence: addAllBinClipsToSequence,
        insertClipAtTime: insertClipAtTime,
        moveClipByOptions: moveClipByOptions,
        modifyClipByOptions: modifyClipByOptions,
        createNewSequence: createNewSequence,
        organizeIntoBins: organizeIntoBins,
        setClipLabelColor: setClipLabelColor
    };
})();
