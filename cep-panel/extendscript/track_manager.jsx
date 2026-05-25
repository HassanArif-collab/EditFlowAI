/*
 * track_manager.jsx - Manage tracks in the Premiere Pro sequence.
 */
trackManager = (function() {
    "use strict";

    function ensureTracks(seq, requiredVideoTracks, requiredAudioTracks) {
        /* Add video/audio tracks until the sequence has the required count.
         *
         * IMPORTANT: The standard ExtendScript Sequence object has NO
         * createVideoTrack() / createAudioTrack() methods — those do not
         * exist in the API (confirmed by ppro-scripting.docsforadobe.dev
         * and Adobe Community).  The only way to add tracks is via the
         * undocumented QE DOM.  If QE is unavailable, we return 0 and
         * the caller must handle the shortfall.
         */
        var added = 0;

        // Try QE DOM for track creation
        var qeAvailable = false;
        try {
            if (typeof qe !== 'undefined') {
                qeAvailable = true;
            }
        } catch (e) {}

        if (qeAvailable) {
            try {
                var qeSeq = qe.project.getActiveSequence();
                while (seq.videoTracks.numTracks < requiredVideoTracks) {
                    try { qeSeq.addTracks(); added++; } catch (e) { break; }
                }
                while (seq.audioTracks.numTracks < requiredAudioTracks) {
                    try { qeSeq.addTracks(); added++; } catch (e) { break; }
                }
            } catch (e) {
                // QE sequence not available — cannot add tracks
            }
        }

        // If QE not available, we simply cannot add tracks — return what we have
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
        // setMute() expects an Integer (0 or 1), not a Boolean.
        // JS coerces true→1 / false→0, but the documented API is Integer.
        tracks[trackIndex].setMute(mute ? 1 : 0);
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
