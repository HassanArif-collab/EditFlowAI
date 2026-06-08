/*
 * sequence_reader.jsx - Read sequence state from the active Premiere Pro sequence.
 * Provides full state: name, dimensions, fps, tracks, all clips with timing.
 */
sequenceReader = (function() {
    "use strict";

    var LABEL_COLORS = {
        0: "Violet", 1: "Iris", 2: "Carnation", 3: "Lavender",
        4: "Columbine", 5: "Daffodil", 6: "Forest", 7: "Rose",
        8: "Slate", 9: "Fern", 10: "Caribbean", 11: "Lemon",
        12: "Sand", 13: "Mocha", 14: "Tangerine", 15: "Turquoise"
    };

    function readCurrentSequence() {
        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({ error: "No active sequence" });
        }

        var result = {
            name: seq.name,
            id: seq.sequenceID,
            width: seq.frameSizeHorizontal,
            height: seq.frameSizeVertical,
            fps: seq.timebase ? (1 / editflowUtils.ticksToSeconds(seq.timebase)) : 0,
            duration: editflowUtils.getSequenceEnd(seq),
            videoTracks: [],
            audioTracks: []
        };

        // Read video tracks
        for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) {
            var track = seq.videoTracks[vt];
            var trackData = {
                index: vt,
                name: track.name || ("Video " + (vt + 1)),
                muted: track.isMuted(),
                clips: []
            };

            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                trackData.clips.push(readClip(clip, vt, "video"));
            }
            result.videoTracks.push(trackData);
        }

        // Read audio tracks
        for (var at = 0; at < seq.audioTracks.numTracks; at++) {
            var track = seq.audioTracks[at];
            var trackData = {
                index: at,
                name: track.name || ("Audio " + (at + 1)),
                muted: track.isMuted(),
                clips: []
            };

            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                trackData.clips.push(readClip(clip, at, "audio"));
            }
            result.audioTracks.push(trackData);
        }

        return JSON.stringify(result);
    }

    function readClip(clip, trackIndex, trackType) {
        var startTime = editflowUtils.ticksToSeconds(clip.start);
        var endTime = editflowUtils.ticksToSeconds(clip.end);
        var inPoint = editflowUtils.ticksToSeconds(clip.inPoint);
        var outPoint = editflowUtils.ticksToSeconds(clip.outPoint);

        var mediaPath = "";
        try {
            if (clip.projectItem && clip.projectItem.getMediaPath) {
                mediaPath = clip.projectItem.getMediaPath();
            }
        } catch (e) {}

        var speed = 1.0;
        try {
            if (clip.getSpeed) speed = clip.getSpeed();
        } catch (e) {}

        return {
            name: clip.name,
            trackIndex: trackIndex,
            trackType: trackType,
            startTime: startTime,
            endTime: endTime,
            duration: endTime - startTime,
            inPoint: inPoint,
            outPoint: outPoint,
            mediaPath: mediaPath,
            label: getClipLabelName(clip),
            speed: speed
        };
    }

    function getClipLabelName(clip) {
        try {
            // getColorLabel is a ProjectItem method, not TrackItem.
            // Must access via clip.projectItem.getColorLabel().
            if (clip.projectItem && clip.projectItem.getColorLabel) {
                var labelIndex = clip.projectItem.getColorLabel();
                return LABEL_COLORS[labelIndex] || "Default";
            }
        } catch (e) {}
        return "Default";
    }

    function getSeqDuration(seq) {
        if (!seq) return 0;
        var maxEnd = 0;
        for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) {
            var track = seq.videoTracks[vt];
            if (track.clips.numItems > 0) {
                var lastClip = track.clips[track.clips.numItems - 1];
                var end = editflowUtils.ticksToSeconds(lastClip.end);
                if (end > maxEnd) maxEnd = end;
            }
        }
        return maxEnd;
    }

    function isTimeRangeFree(seq, trackIndex, trackType, startTime, endTime) {
        var tracks = (trackType === "video") ? seq.videoTracks : seq.audioTracks;
        if (trackIndex >= tracks.numTracks) return true;

        var track = tracks[trackIndex];
        for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            var clipStart = editflowUtils.ticksToSeconds(clip.start);
            var clipEnd = editflowUtils.ticksToSeconds(clip.end);
            if (startTime < clipEnd && endTime > clipStart) {
                return false; // Overlap found
            }
        }
        return true;
    }

    function getSelectedClips() {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ clips: [] });

        var selected = [];
        // Check video tracks
        for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) {
            var track = seq.videoTracks[vt];
            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                try {
                    if (clip.isSelected && clip.isSelected()) {
                        selected.push(readClip(clip, vt, "video"));
                    }
                } catch (e) {}
            }
        }
        // Check audio tracks
        for (var at = 0; at < seq.audioTracks.numTracks; at++) {
            var track = seq.audioTracks[at];
            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                try {
                    if (clip.isSelected && clip.isSelected()) {
                        selected.push(readClip(clip, at, "audio"));
                    }
                } catch (e) {}
            }
        }

        return JSON.stringify({ clips: selected });
    }

    function verifyTimelineChange(options) {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ verified: false, error: "No active sequence" });

        var expectedCount = editflowUtils.getParam(options, 'expectedClipCount', 'clipCount');
        var actualCount = 0;

        for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) {
            actualCount += seq.videoTracks[vt].clips.numItems;
        }
        for (var at = 0; at < seq.audioTracks.numTracks; at++) {
            actualCount += seq.audioTracks[at].clips.numItems;
        }

        return JSON.stringify({
            verified: expectedCount === undefined || actualCount === expectedCount,
            expectedCount: expectedCount,
            actualCount: actualCount
        });
    }

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
