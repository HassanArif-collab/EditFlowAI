/*
 * track_manager.jsx - Manage tracks in the Premiere Pro sequence.
 */
trackManager = (function() {
    "use strict";

    function ensureTracks(seq, requiredVideoTracks, requiredAudioTracks) {
        var added = 0;
        while (seq.videoTracks.numTracks < requiredVideoTracks) {
            try { seq.createVideoTrack("Video " + (seq.videoTracks.numTracks + 1)); added++; } catch (e) { break; }
        }
        while (seq.audioTracks.numTracks < requiredAudioTracks) {
            try { seq.createAudioTrack("Audio " + (seq.audioTracks.numTracks + 1)); added++; } catch (e) { break; }
        }
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
