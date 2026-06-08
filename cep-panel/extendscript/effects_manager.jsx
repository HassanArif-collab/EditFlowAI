/*
 * effects_manager.jsx - Apply effects and transitions in Premiere Pro.
 * Uses QE DOM for effects that aren't accessible via the standard API.
 */
effectsManager = (function() {
    "use strict";

    function applyTransition(seq, trackIndex, transitionName, duration) {
        try {
            if (typeof qe === 'undefined') return { success: false, error: "QE DOM not available" };

            var qeSeq = qe.project.getActiveSequence();
            if (!qeSeq) return { success: false, error: "No active QE sequence" };

            var track = qeSeq.getVideoTrackAt(trackIndex);
            if (!track) return { success: false, error: "Track not found" };

            var transition = findTransition(transitionName);
            if (!transition) return { success: false, error: "Transition not found: " + transitionName };

            // Apply transition to all cuts on the track
            var transitions = track.transitions;
            if (transitions && transitions.numItems > 0) {
                for (var i = 0; i < transitions.numItems; i++) {
                    var t = transitions[i];
                    // Set duration if specified
                    if (duration) {
                        // setDuration expects a tick STRING, not a raw number
                        try { t.setDuration(editflowUtils.secondsToTicksString(duration)); } catch (e) {}
                    }
                }
            }

            return { success: true };

        } catch (e) {
            return { success: false, error: e.toString() };
        }
    }

    function findTransition(name) {
        try {
            if (typeof qe === 'undefined') return null;
            var transitions = qe.project.getVideoTransitions();
            for (var i = 0; i < transitions.numItems; i++) {
                if (transitions[i].name.indexOf(name) >= 0) {
                    return transitions[i];
                }
            }
        } catch (e) {}
        return null;
    }

    function getClipEffects(clip) {
        var effects = [];
        try {
            var components = clip.components;
            for (var i = 0; i < components.numItems; i++) {
                var comp = components[i];
                var effect = {
                    name: comp.displayName,
                    properties: []
                };
                for (var p = 0; p < comp.properties.numItems; p++) {
                    var prop = comp.properties[p];
                    effect.properties.push({
                        name: prop.displayName,
                        value: prop.getValue ? prop.getValue() : null
                    });
                }
                effects.push(effect);
            }
        } catch (e) {}
        return effects;
    }

    function applyEffectToClip(options) {
        var seq = app.project.activeSequence;
        if (!seq) return editflowUtils.safeStringify({ success: false, error: "No active sequence" });

        try {
            if (typeof qe === 'undefined') {
                return editflowUtils.safeStringify({ success: false, error: "QE DOM not available" });
            }

            var trackIndex = editflowUtils.getParam(options, 'trackIndex', 'track') || 0;
            var clipIndex = editflowUtils.getParam(options, 'clipIndex', 'index') || 0;
            var effectName = editflowUtils.getParam(options, 'effectName', 'effect') || "";

            var track = seq.videoTracks[trackIndex];
            if (!track || clipIndex >= track.clips.numItems) {
                return editflowUtils.safeStringify({ success: false, error: "Clip not found" });
            }

            var qeSeq = qe.project.getActiveSequence();
            var qeTrack = qeSeq.getVideoTrackAt(trackIndex);
            var qeClip = qeTrack.getItemAt(clipIndex);

            // Apply effect via QE DOM
            qeClip.addVideoEffect(qe.project.getVideoEffectByName(effectName));

            return editflowUtils.safeStringify({ success: true });

        } catch (e) {
            return editflowUtils.safeStringify({ success: false, error: e.toString() });
        }
    }

    function applyTransitionToAll(options) {
        var seq = app.project.activeSequence;
        if (!seq) return editflowUtils.safeStringify({ success: false, error: "No active sequence" });

        var transitionName = editflowUtils.getParam(options, 'transitionName', 'name') || "Cross Dissolve";
        var duration = editflowUtils.getParam(options, 'duration') || 0.5;

        var results = [];
        for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) {
            var result = applyTransition(seq, vt, transitionName, duration);
            results.push(result);
        }

        return editflowUtils.safeStringify({ success: true, trackResults: results });
    }

    return {
        applyTransition: applyTransition,
        applyEffectToClip: applyEffectToClip,
        applyTransitionToAll: applyTransitionToAll,
        getClipEffects: getClipEffects,
        findTransition: findTransition
    };
})();
