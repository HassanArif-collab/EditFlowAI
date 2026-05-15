/**
 * EditFlow AI - Sequence Reader
 * Reads the current state of the active Premiere Pro sequence.
 */

var sequenceReader = (function() {
    "use strict";

    /**
     * Read the current active sequence.
     * @returns {Object} Sequence state
     */
    function readCurrentSequence() {
        var project = app.project;
        if (!project) {
            return { success: false, error: "No project open" };
        }

        var seq = project.activeSequence;
        if (!seq) {
            return { success: false, error: "No active sequence" };
        }

        var state = {
            success: true,
            name: seq.name,
            id: seq.sequenceID,
            width: seq.frameSizeHorizontal,
            height: seq.frameSizeVertical,
            fps: seq.timebase,
            duration: getSeqDuration(seq),
            videoTracks: seq.videoTracks.numTracks,
            audioTracks: seq.audioTracks.numTracks,
            clips: []
        };

        // Read all video track clips
        for (var t = 0; t < seq.videoTracks.numTracks; t++) {
            var track = seq.videoTracks[t];
            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                state.clips.push(readClip(clip, t, "video"));
            }
        }

        // Read all audio track clips
        for (var t = 0; t < seq.audioTracks.numTracks; t++) {
            var track = seq.audioTracks[t];
            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                state.clips.push(readClip(clip, t, "audio"));
            }
        }

        return state;
    }

    /**
     * Read a single clip's info.
     * @param {TrackItem} clip
     * @param {number} trackIndex
     * @param {string} trackType
     * @returns {Object} Clip info
     */
    function readClip(clip, trackIndex, trackType) {
        var info = {
            name: clip.name,
            trackIndex: trackIndex,
            trackType: trackType,
            startTime: clip.start.seconds,
            endTime: clip.end.seconds,
            inPoint: clip.inPoint.seconds,
            outPoint: clip.outPoint.seconds,
            duration: clip.duration.seconds,
            type: clip.type
        };

        // Get media path if available
        try {
            var projectItem = clip.projectItem;
            if (projectItem) {
                info.mediaPath = projectItem.getMediaPath() || "";
                info.projectItemId = projectItem.nodeId;
                info.label = getClipLabelName(clip);
            }
        } catch(e) {
            info.mediaPath = "";
            info.label = "";
        }

        // Get speed
        try {
            info.speed = clip.getSpeed();
        } catch(e) {
            info.speed = 1.0;
        }

        return info;
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

    /**
     * Get total sequence duration in seconds.
     * @param {Sequence} seq
     * @returns {number} Duration in seconds
     */
    function getSeqDuration(seq) {
        var maxEnd = 0;
        for (var t = 0; t < seq.videoTracks.numTracks; t++) {
            var track = seq.videoTracks[t];
            for (var c = 0; c < track.clips.numItems; c++) {
                var end = track.clips[c].end.seconds;
                if (end > maxEnd) maxEnd = end;
            }
        }
        return maxEnd;
    }

    /**
     * Check if a time range on a track is free (no clips).
     * @param {Sequence} seq
     * @param {number} trackIndex
     * @param {string} trackType - "video" or "audio"
     * @param {number} startTime
     * @param {number} endTime
     * @returns {boolean} True if range is free
     */
    function isTimeRangeFree(seq, trackIndex, trackType, startTime, endTime) {
        var tracks = (trackType === "video") ? seq.videoTracks : seq.audioTracks;
        if (trackIndex >= tracks.numTracks) return true;

        var track = tracks[trackIndex];
        for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            var clipStart = clip.start.seconds;
            var clipEnd = clip.end.seconds;

            // Check for overlap
            if (startTime < clipEnd && endTime > clipStart) {
                return false; // Overlap detected
            }
        }
        return true;
    }

    function getSelectedClips() {
        var project = app.project;
        if (!project) {
            return { success: false, error: "No project open", clips: [] };
        }

        var seq = project.activeSequence;
        if (!seq) {
            return { success: false, error: "No active sequence", clips: [] };
        }

        if (!seq.getSelection) {
            return {
                success: true,
                clips: [],
                warning: "This Premiere scripting API does not expose selected timeline clips."
            };
        }

        var selected = seq.getSelection();
        var clips = [];
        var count = selected && selected.length !== undefined ? selected.length : 0;
        for (var i = 0; i < count; i++) {
            clips.push(readSelectedClip(selected[i]));
        }
        return { success: true, sequenceName: seq.name, clips: clips, count: clips.length };
    }

    function readSelectedClip(clip) {
        var info = {
            name: clip && clip.name ? clip.name : "",
            startTime: 0,
            endTime: 0,
            inPoint: 0,
            outPoint: 0,
            duration: 0,
            mediaPath: "",
            label: ""
        };

        try { info.startTime = clip.start.seconds; } catch(e1) {}
        try { info.endTime = clip.end.seconds; } catch(e2) {}
        try { info.inPoint = clip.inPoint.seconds; } catch(e3) {}
        try { info.outPoint = clip.outPoint.seconds; } catch(e4) {}
        try { info.duration = clip.duration.seconds; } catch(e5) {}
        try {
            if (clip.projectItem) {
                info.mediaPath = clip.projectItem.getMediaPath() || "";
                info.projectItemId = clip.projectItem.nodeId;
                info.label = getClipLabelName(clip);
            }
        } catch(e6) {}
        return info;
    }

    function verifyTimelineChange(options) {
        options = options || {};
        var state = readCurrentSequence();
        if (!state || state.success === false) {
            return {
                success: false,
                verified: false,
                error: state && state.error ? state.error : "Could not read sequence"
            };
        }

        var expectedMinClips = Number(options.expectedMinClips);
        var expectedClipCount = Number(options.expectedClipCount);
        var clipCount = state.clips ? state.clips.length : 0;
        var warnings = [];

        if (!isNaN(expectedMinClips) && clipCount < expectedMinClips) {
            warnings.push("Clip count is lower than expected minimum");
        }
        if (!isNaN(expectedClipCount) && clipCount !== expectedClipCount) {
            warnings.push("Clip count does not match expected count");
        }

        return {
            success: true,
            verified: warnings.length === 0,
            sequenceName: state.name,
            clipCount: clipCount,
            warnings: warnings,
            state: state
        };
    }

    // Public API
    return {
        readCurrentSequence: readCurrentSequence,
        readClip: readClip,
        getSeqDuration: getSeqDuration,
        getClipLabelName: getClipLabelName,
        isTimeRangeFree: isTimeRangeFree,
        getSelectedClips: getSelectedClips,
        verifyTimelineChange: verifyTimelineChange
    };
})();
