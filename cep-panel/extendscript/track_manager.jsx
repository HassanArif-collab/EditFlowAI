/*
 * track_manager.jsx - Manage tracks in the Premiere Pro sequence.
 */
trackManager = (function() {
    "use strict";

    function ensureTracks(seq, requiredVideoTracks, requiredAudioTracks) {
        var added = 0;
        try {
            if (typeof app.enableQE === 'function') app.enableQE();
            var qs = (typeof qe !== 'undefined' && qe.project) ? qe.project.getActiveSequence() : null;
            if (qs && typeof qs.addTracks === 'function') {
                while (seq.videoTracks.numTracks < requiredVideoTracks) {
                    var curV = seq.videoTracks.numTracks;
                    qs.addTracks(1, curV, 0, 0, 0);
                    added++;
                }
                while (seq.audioTracks.numTracks < requiredAudioTracks) {
                    var curA = seq.audioTracks.numTracks;
                    qs.addTracks(0, 0, 1, 2, curA);
                    added++;
                }
            }
        } catch (e) {}
        return added;
    }

    function clearTrack(seq, trackIndex, trackType) {
        var tracks = (trackType === "audio") ? seq.audioTracks : seq.videoTracks;
        if (trackIndex >= tracks.numTracks) return 0;

        var track = tracks[trackIndex];
        var removed = 0;
        while (track.clips.numItems > 0) {
            track.clips[track.clips.numItems - 1].remove(false, true);
            removed++;
        }
        return removed;
    }

    function setTrackMute(seq, trackIndex, trackType, mute) {
        var tracks = (trackType === "audio") ? seq.audioTracks : seq.videoTracks;
        if (trackIndex >= tracks.numTracks) return false;
        tracks[trackIndex].setMute(mute);
        return true;
    }

    function manageTracks(options) {
        var seq = app.project.activeSequence;
        if (!seq) return editflowUtils.safeStringify({ success: false, error: "No active sequence" });

        var action = editflowUtils.getParam(options, 'action') || "add";

        switch (action) {
            case "add":
                var videoCount = editflowUtils.getParam(options, 'videoCount') || 1;
                var audioCount = editflowUtils.getParam(options, 'audioCount') || 0;
                var added = ensureTracks(seq, videoCount, audioCount);
                return editflowUtils.safeStringify({ success: true, tracksAdded: added });

            case "clear":
                var trackIdx = editflowUtils.getParam(options, 'trackIndex', 'track') || 0;
                var trackType = editflowUtils.getParam(options, 'trackType', 'type') || "video";
                var removed = clearTrack(seq, trackIdx, trackType);
                return editflowUtils.safeStringify({ success: true, clipsRemoved: removed });

            case "mute":
                var trackIdx = editflowUtils.getParam(options, 'trackIndex', 'track') || 0;
                var trackType = editflowUtils.getParam(options, 'trackType', 'type') || "video";
                var mute = editflowUtils.getParam(options, 'mute') !== false;
                setTrackMute(seq, trackIdx, trackType, mute);
                return editflowUtils.safeStringify({ success: true, muted: mute });

            default:
                return editflowUtils.safeStringify({ success: false, error: "Unknown track action: " + action });
        }
    }

    return {
        ensureTracks: ensureTracks,
        clearTrack: clearTrack,
        setTrackMute: setTrackMute,
        manageTracks: manageTracks
    };
})();
