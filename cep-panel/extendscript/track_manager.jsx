/**
 * EditFlow AI - Track Manager
 * Manages video and audio tracks in the sequence.
 */

var trackManager = (function() {
    "use strict";

    /**
     * Ensure the sequence has enough tracks for the EDL.
     * @param {Sequence} seq
     * @param {number} requiredVideoTracks
     * @param {number} requiredAudioTracks
     * @returns {Object} Result
     */
    function ensureTracks(seq, requiredVideoTracks, requiredAudioTracks) {
        var added = { video: 0, audio: 0 };

        // Add video tracks if needed
        while (seq.videoTracks.numTracks < requiredVideoTracks) {
            seq.videoTracks.createVideoTrack("V" + (seq.videoTracks.numTracks + 1));
            added.video++;
        }

        // Add audio tracks if needed
        while (seq.audioTracks.numTracks < requiredAudioTracks) {
            seq.audioTracks.createAudioTrack("A" + (seq.audioTracks.numTracks + 1));
            added.audio++;
        }

        return {
            success: true,
            totalVideoTracks: seq.videoTracks.numTracks,
            totalAudioTracks: seq.audioTracks.numTracks,
            added: added
        };
    }

    /**
     * Clear all clips from a track.
     * @param {Sequence} seq
     * @param {number} trackIndex
     * @param {string} trackType - "video" or "audio"
     * @returns {Object} Result
     */
    function clearTrack(seq, trackIndex, trackType) {
        try {
            var tracks = (trackType === "video") ? seq.videoTracks : seq.audioTracks;
            if (trackIndex >= tracks.numTracks) {
                return { success: false, error: "Track index out of range" };
            }

            var track = tracks[trackIndex];
            var removed = 0;

            // Remove clips from end to start to avoid index shifting
            while (track.clips.numItems > 0) {
                track.clips[track.clips.numItems - 1].remove(false, true);
                removed++;
            }

            return { success: true, removed: removed };
        } catch(e) {
            return { success: false, error: e.toString() };
        }
    }

    /**
     * Mute/unmute a track.
     * @param {Sequence} seq
     * @param {number} trackIndex
     * @param {string} trackType
     * @param {boolean} mute
     */
    function setTrackMute(seq, trackIndex, trackType, mute) {
        try {
            var tracks = (trackType === "video") ? seq.videoTracks : seq.audioTracks;
            if (trackIndex < tracks.numTracks) {
                tracks[trackIndex].setMute(mute ? 1 : 0);
                return { success: true };
            }
            return { success: false, error: "Track not found" };
        } catch(e) {
            return { success: false, error: e.toString() };
        }
    }

    function manageTracks(options) {
        options = options || {};
        try {
            var seq = app.project.activeSequence;
            if (!seq) return { success: false, error: "No active sequence" };
            var action = options.action || "";
            var trackType = options.trackType || options.track_type || "video";
            var trackIndex = options.trackIndex || options.track_index || 0;
            if (action === "add") {
                if (trackType === "audio") {
                    ensureTracks(seq, seq.videoTracks.numTracks, trackIndex + 1);
                } else {
                    ensureTracks(seq, trackIndex + 1, seq.audioTracks.numTracks);
                }
                return { success: true, action: action, trackType: trackType, trackIndex: trackIndex };
            }
            if (action === "clear") {
                return clearTrack(seq, trackIndex, trackType);
            }
            if (action === "mute") {
                return setTrackMute(seq, trackIndex, trackType, options.mute !== false);
            }
            return { success: false, error: "Unsupported track action: " + action };
        } catch(e) {
            return { success: false, error: e.toString(), line: e.line };
        }
    }

    // Public API
    return {
        ensureTracks: ensureTracks,
        clearTrack: clearTrack,
        setTrackMute: setTrackMute,
        manageTracks: manageTracks
    };
})();
