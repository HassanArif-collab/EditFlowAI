/**
 * EditFlow AI - Effects Manager
 * Manages video effects, transitions, and color grading.
 */

var effectsManager = (function() {
    "use strict";

    /**
     * Apply a transition between two clips.
     * @param {Sequence} seq
     * @param {number} trackIndex - Video track index
     * @param {string} transitionName - e.g., "Cross Dissolve"
     * @param {number} duration - Transition duration in seconds
     * @returns {Object} Result
     */
    function applyTransition(seq, trackIndex, transitionName, duration) {
        try {
            var track = seq.videoTracks[trackIndex];
            if (!track) return { success: false, error: "Track not found" };

            // Find transition preset
            var transition = findTransition(transitionName);
            if (!transition) return { success: false, error: "Transition not found: " + transitionName };

            // Apply to each clip junction
            var applied = 0;
            for (var c = 1; c < track.clips.numItems; c++) {
                var prevClip = track.clips[c - 1];
                var currClip = track.clips[c];

                // Check if clips are adjacent or overlapping
                var gap = currClip.start.seconds - prevClip.end.seconds;
                if (Math.abs(gap) < 0.5) { // Close enough for a transition
                    currClip.addTransition(transition, true, duration || 0.5);
                    applied++;
                }
            }

            return { success: true, applied: applied };
        } catch(e) {
            return { success: false, error: e.toString() };
        }
    }

    /**
     * Apply Lumetri color preset.
     * @param {TrackItem} clip
     * @param {string} lutPath - Path to .cube LUT file
     * @returns {Object} Result
     */
    function applyLumetriLUT(clip, lutPath) {
        try {
            var components = clip.components;
            var lumetri = null;

            for (var i = 0; i < components.numItems; i++) {
                if (components[i].matchName === "Lumetri Color") {
                    lumetri = components[i];
                    break;
                }
            }

            if (!lumetri) return { success: false, error: "Lumetri component not found" };

            // Set the LUT path in the Lumetri Look properties
            var props = lumetri.properties;
            for (var p = 0; p < props.numItems; p++) {
                if (props[p].displayName === "Look" || props[p].matchName === "Look") {
                    props[p].setValue(lutPath);
                    return { success: true };
                }
            }

            return { success: false, error: "Look property not found in Lumetri" };
        } catch(e) {
            return { success: false, error: e.toString() };
        }
    }

    /**
     * Find a transition by name in Premiere's presets.
     * @param {string} name
     * @returns {Object|null}
     */
    function findTransition(name) {
        try {
            // Premiere Pro exposes transitions via QE DOM
            app.enableQE();
            var transitions = qe.project.getVideoTransitions();
            for (var i = 0; i < transitions.numItems; i++) {
                if (transitions[i].name === name) {
                    return transitions[i];
                }
            }
        } catch(e) {}
        return null;
    }

    /**
     * Get all effects applied to a clip.
     * @param {TrackItem} clip
     * @returns {Array} List of effect info
     */
    function getClipEffects(clip) {
        var effects = [];
        try {
            var components = clip.components;
            for (var i = 0; i < components.numItems; i++) {
                var comp = components[i];
                var effect = {
                    name: comp.displayName,
                    matchName: comp.matchName,
                    properties: []
                };

                var props = comp.properties;
                for (var p = 0; p < props.numItems; p++) {
                    effect.properties.push({
                        name: props[p].displayName,
                        value: props[p].getValue()
                    });
                }

                effects.push(effect);
            }
        } catch(e) {}
        return effects;
    }

    function applyEffectToClip(options) {
        try {
            app.enableQE();
            var seq = app.project.activeSequence;
            if (!seq) return { success: false, error: "No sequence" };
            var qeSeq = qe.project.getActiveSequence();
            var trackIndex = options.trackIndex || options.track_index || 0;
            var clipIndex = options.clipIndex || options.clip_index || 0;
            var effectName = options.effectName || options.effect_name;
            var qeTrack = qeSeq.getVideoTrackAt(trackIndex);
            if (!qeTrack) return { success: false, error: "Track not found" };
            var qeClip = qeTrack.getItemAt(clipIndex);
            if (!qeClip) return { success: false, error: "Clip not found" };
            var effect = qe.project.getVideoEffectByName(effectName);
            if (!effect) return { success: false, error: "Effect not found" };
            qeClip.addVideoEffect(effect);
            return { success: true };
        } catch(e) { return { success: false, error: e.toString() }; }
    }

    function applyTransitionToAll(options) {
        return applyTransition(app.project.activeSequence, options.trackIndex || options.track_index || 0, options.transitionName || options.transition_name || "Cross Dissolve", options.duration || 0.5);
    }

    // Public API
    return {
        applyTransition: applyTransition,
        applyLumetriLUT: applyLumetriLUT,
        getClipEffects: getClipEffects,
        applyEffectToClip: applyEffectToClip,
        applyTransitionToAll: applyTransitionToAll
    };
})();
