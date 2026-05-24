/*
 * audio_manager.jsx - Audio level and fade management for EditFlow AI.
 * Controls clip volume, normalization, and fade in/out keyframes.
 */
audioManager = (function() {
    "use strict";

    function setClipLevel(clip, levelDB) {
        try {
            var components = clip.components;
            for (var i = 0; i < components.numItems; i++) {
                if (components[i].displayName === "Volume") {
                    var levelProp = components[i].properties;
                    for (var p = 0; p < levelProp.numItems; p++) {
                        if (levelProp[p].displayName === "Level") {
                            levelProp[p].setValue(levelDB, true);
                            return true;
                        }
                    }
                }
            }
        } catch (e) {}
        return false;
    }

    function normalizeAudioLevels(seq, targetDB) {
        if (!seq) return 0;
        targetDB = targetDB || -3;

        var normalized = 0;
        for (var at = 0; at < seq.audioTracks.numTracks; at++) {
            var track = seq.audioTracks[at];
            for (var c = 0; c < track.clips.numItems; c++) {
                if (setClipLevel(track.clips[c], targetDB)) {
                    normalized++;
                }
            }
        }
        return normalized;
    }

    function applyAudioFade(clip, fadeInDuration, fadeOutDuration) {
        try {
            var components = clip.components;
            for (var i = 0; i < components.numItems; i++) {
                if (components[i].displayName === "Volume") {
                    var levelProp = null;
                    for (var p = 0; p < components[i].properties.numItems; p++) {
                        if (components[i].properties[p].displayName === "Level") {
                            levelProp = components[i].properties[p];
                            break;
                        }
                    }

                    if (levelProp && levelProp.addKey) {
                        var clipStart = editflowUtils.ticksToSeconds(clip.start);
                        var clipEnd = editflowUtils.ticksToSeconds(clip.end);

                        // addKey / setValueAtKey require Time OBJECTS (not raw
                        // numbers).  Create new Time() and set .ticks — matching
                        // the premiere-pro-mcp reference implementation.
                        function _makeTime(seconds) {
                            var t = new Time();
                            t.ticks = editflowUtils.secondsToTicksString(seconds);
                            return t;
                        }

                        // Fade In: from -96dB to 0dB
                        if (fadeInDuration > 0) {
                            var tFadeInStart = _makeTime(clipStart);
                            var tFadeInEnd = _makeTime(clipStart + fadeInDuration);
                            levelProp.addKey(tFadeInStart);
                            levelProp.setValueAtKey(tFadeInStart, -96, true);
                            levelProp.addKey(tFadeInEnd);
                            levelProp.setValueAtKey(tFadeInEnd, 0, true);
                        }

                        // Fade Out: from 0dB to -96dB
                        if (fadeOutDuration > 0) {
                            var tFadeOutStart = _makeTime(clipEnd - fadeOutDuration);
                            var tFadeOutEnd = _makeTime(clipEnd);
                            levelProp.addKey(tFadeOutStart);
                            levelProp.setValueAtKey(tFadeOutStart, 0, true);
                            levelProp.addKey(tFadeOutEnd);
                            levelProp.setValueAtKey(tFadeOutEnd, -96, true);
                        }
                    }
                    break;
                }
            }
        } catch (e) {}
    }

    function setAudioLevelWrapper(options) {
        var seq = app.project.activeSequence;
        if (!seq) return editflowUtils.safeStringify({ success: false, error: "No active sequence" });

        var trackIndex = editflowUtils.getParam(options, 'trackIndex', 'track') || 0;
        var clipIndex = editflowUtils.getParam(options, 'clipIndex', 'index') || 0;
        var levelDB = editflowUtils.getParam(options, 'levelDB', 'level') || 0;

        try {
            var track = seq.audioTracks[trackIndex];
            if (!track || clipIndex >= track.clips.numItems) {
                return editflowUtils.safeStringify({ success: false, error: "Clip not found" });
            }
            var clip = track.clips[clipIndex];
            setClipLevel(clip, levelDB);
            return editflowUtils.safeStringify({ success: true });
        } catch (e) {
            return editflowUtils.safeStringify({ success: false, error: e.toString() });
        }
    }

    function normalizeAudioWrapper(options) {
        var seq = app.project.activeSequence;
        if (!seq) return editflowUtils.safeStringify({ success: false, error: "No active sequence" });

        var targetDB = editflowUtils.getParam(options, 'targetDB', 'level') || -3;
        var count = normalizeAudioLevels(seq, targetDB);
        return editflowUtils.safeStringify({ success: true, normalized: count });
    }

    function audioFadeWrapper(options) {
        var seq = app.project.activeSequence;
        if (!seq) return editflowUtils.safeStringify({ success: false, error: "No active sequence" });

        var trackIndex = editflowUtils.getParam(options, 'trackIndex', 'track') || 0;
        var clipIndex = editflowUtils.getParam(options, 'clipIndex', 'index') || 0;
        var fadeIn = editflowUtils.getParam(options, 'fadeIn', 'fadeInDuration') || 0;
        var fadeOut = editflowUtils.getParam(options, 'fadeOut', 'fadeOutDuration') || 0;

        try {
            var track = seq.audioTracks[trackIndex];
            if (!track || clipIndex >= track.clips.numItems) {
                return editflowUtils.safeStringify({ success: false, error: "Clip not found" });
            }
            var clip = track.clips[clipIndex];
            applyAudioFade(clip, fadeIn, fadeOut);
            return editflowUtils.safeStringify({ success: true });
        } catch (e) {
            return editflowUtils.safeStringify({ success: false, error: e.toString() });
        }
    }

    return {
        setClipLevel: setClipLevel,
        normalizeAudioLevels: normalizeAudioLevels,
        applyAudioFade: applyAudioFade,
        setAudioLevelWrapper: setAudioLevelWrapper,
        normalizeAudioWrapper: normalizeAudioWrapper,
        audioFadeWrapper: audioFadeWrapper
    };
})();
