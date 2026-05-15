/**
 * EditFlow AI - Audio Manager
 * Manages audio levels, keyframes, and audio clip operations.
 */

var audioManager = (function() {
    "use strict";

    /**
     * Set audio level for a clip.
     * @param {TrackItem} clip - Audio clip
     * @param {number} levelDB - Level in dB (e.g., -3.0)
     * @returns {Object} Result
     */
    function setClipLevel(clip, levelDB) {
        try {
            var components = clip.components;
            for (var i = 0; i < components.numItems; i++) {
                if (components[i].matchName === "audiolevel" || components[i].displayName === "Volume") {
                    var props = components[i].properties;
                    for (var p = 0; p < props.numItems; p++) {
                        if (props[p].displayName === "Level") {
                            props[p].setValue(levelDB);
                            return { success: true };
                        }
                    }
                }
            }
            return { success: false, error: "Volume component not found" };
        } catch(e) {
            return { success: false, error: e.toString() };
        }
    }

    /**
     * Normalize audio levels across all clips in the sequence.
     * @param {Sequence} seq
     * @param {number} targetDB - Target peak level in dB (e.g., -3.0)
     * @returns {Object} Result with count of adjusted clips
     */
    function normalizeAudioLevels(seq, targetDB) {
        var adjusted = 0;
        var targetDB = targetDB || -3.0;

        for (var t = 0; t < seq.audioTracks.numTracks; t++) {
            var track = seq.audioTracks[t];
            for (var c = 0; c < track.clips.numItems; c++) {
                var result = setClipLevel(track.clips[c], targetDB);
                if (result.success) adjusted++;
            }
        }

        return { success: true, adjusted: adjusted };
    }

    /**
     * Fade audio in/out for a clip.
     * @param {TrackItem} clip
     * @param {number} fadeInDuration - Seconds
     * @param {number} fadeOutDuration - Seconds
     * @returns {Object} Result
     */
    function applyAudioFade(clip, fadeInDuration, fadeOutDuration) {
        try {
            var components = clip.components;
            for (var i = 0; i < components.numItems; i++) {
                if (components[i].matchName === "audiolevel" || components[i].displayName === "Volume") {
                    var props = components[i].properties;
                    for (var p = 0; p < props.numItems; p++) {
                        if (props[p].displayName === "Level") {
                            // Add keyframes for fade
                            if (fadeInDuration > 0) {
                                var startTicks = clip.start.ticks;
                                var fadeEndTicks = editflowUtils.addTicks(startTicks, editflowUtils.secondsToTicks(fadeInDuration));
                                props[p].addKey(startTicks);
                                props[p].setValueAtKey(startTicks, -96); // Silence
                                props[p].addKey(fadeEndTicks);
                                props[p].setValueAtKey(fadeEndTicks, 0); // Full volume
                            }
                            if (fadeOutDuration > 0) {
                                var endTicks = clip.end.ticks;
                                var fadeStartTicks = editflowUtils.subTicks(endTicks, editflowUtils.secondsToTicks(fadeOutDuration));
                                props[p].addKey(fadeStartTicks);
                                props[p].setValueAtKey(fadeStartTicks, 0);
                                props[p].addKey(endTicks);
                                props[p].setValueAtKey(endTicks, -96);
                            }
                            return { success: true };
                        }
                    }
                }
            }
            return { success: false, error: "Volume component not found" };
        } catch(e) {
            return { success: false, error: e.toString() };
        }
    }

    /**
     * Convert seconds to ticks.
     * @param {number} seconds
     * @returns {string} Ticks
     */
    function secondsToTicks(seconds) {
        return editflowUtils.secondsToTicks(seconds);
    }


    function setAudioLevelWrapper(options) {
        try {
            var seq = app.project.activeSequence;
            if (!seq) return { success: false, error: "No sequence" };
            var track = seq.audioTracks[options.trackIndex || options.track_index || 0];
            if (!track) return { success: false, error: "Track not found" };
            var clip = track.clips[options.clipIndex || options.clip_index || 0];
            if (!clip) return { success: false, error: "Clip not found" };
            return setClipLevel(clip, options.levelDb || options.level_db || -3.0);
        } catch(e) { return { success: false, error: e.toString() }; }
    }
    
    function normalizeAudioWrapper(options) {
        return normalizeAudioLevels(app.project.activeSequence, options.targetDb || options.target_db || -3.0);
    }

    function audioFadeWrapper(options) {
        try {
            var seq = app.project.activeSequence;
            if (!seq) return { success: false, error: "No sequence" };
            var track = seq.audioTracks[options.trackIndex || options.track_index || 0];
            if (!track) return { success: false, error: "Track not found" };
            var clip = track.clips[options.clipIndex || options.clip_index || 0];
            if (!clip) return { success: false, error: "Clip not found" };
            return applyAudioFade(clip, options.fadeIn || options.fade_in || 1.0, options.fadeOut || options.fade_out || 1.0);
        } catch(e) { return { success: false, error: e.toString() }; }
    }

    // Public API
    return {
        setClipLevel: setClipLevel,
        normalizeAudioLevels: normalizeAudioLevels,
        applyAudioFade: applyAudioFade,
        setAudioLevelWrapper: setAudioLevelWrapper,
        normalizeAudioWrapper: normalizeAudioWrapper,
        audioFadeWrapper: audioFadeWrapper
    };
})();
