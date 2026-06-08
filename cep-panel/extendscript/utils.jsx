/*
 * utils.jsx - Common utility functions for EditFlow AI ExtendScript modules.
 * Provides tick/time conversions and helpers for working with Premiere's DOM.
 */
editflowUtils = (function() {
    "use strict";

    // Premiere Pro uses ticks internally (254016000000 ticks per second)
    var TICKS_PER_SECOND = 254016000000;

    function secondsToTicks(seconds) {
        return Math.round(seconds * TICKS_PER_SECOND);
    }

    function secondsToTicksString(seconds) {
        /* String form of ticks for Premiere attribute setters
         * (clip.inPoint, clip.outPoint, etc.) which require strings
         * to avoid JS number precision loss at large tick values. */
        return String(Math.round(seconds * TICKS_PER_SECOND));
    }

    function ticksToSeconds(ticks) {
        if (!ticks) return 0;
        // ticks may come as a string or as a .ticks property
        var t = (typeof ticks === 'object' && ticks.ticks) ? parseFloat(ticks.ticks) : parseFloat(ticks);
        return t / TICKS_PER_SECOND;
    }

    function addTicks(t1, t2) {
        return { ticks: String(parseFloat(t1.ticks || t1) + parseFloat(t2.ticks || t2)) };
    }

    function subTicks(t1, t2) {
        return { ticks: String(parseFloat(t1.ticks || t1) - parseFloat(t2.ticks || t2)) };
    }

    function getSequenceEnd(seq) {
        if (!seq) return 0;
        try {
            // seq.end is a STRING (ticks), not a Time object — confirmed by
            // ppro-scripting.docsforadobe.dev: "Type: String; read-only"
            // Strings don't have .ticks, so the old seq.end.ticks check was
            // always undefined and this function always returned 0.
            if (seq.end) return ticksToSeconds(seq.end);
        } catch (e) {}
        return 0;
    }

    function getMediaPath(item) {
        try {
            return item && item.getMediaPath ? String(item.getMediaPath() || "") : "";
        } catch (e) {
            return "";
        }
    }

    function hasVideo(item) {
        try {
            if (item && typeof item.hasVideo === "function") {
                return !!item.hasVideo();
            }
        } catch (e) {}

        var path = getMediaPath(item).toLowerCase();
        return /\.(mov|mp4|m4v|avi|mxf|mts|m2ts|mpg|mpeg|webm)$/i.test(path);
    }

    function hasAudio(item) {
        try {
            if (item && typeof item.hasAudio === "function") {
                return !!item.hasAudio();
            }
        } catch (e) {}

        var path = getMediaPath(item).toLowerCase();
        return /\.(mov|mp4|m4v|avi|mxf|mts|m2ts|mpg|mpeg|webm|wav|mp3|aac|m4a|aif|aiff)$/i.test(path);
    }

    function findBin(parent, binName) {
        if (!parent) return null;
        for (var i = 0; i < parent.children.numItems; i++) {
            var child = parent.children[i];
            if (child.type === ProjectItemType.BIN && child.name === binName) {
                return child;
            }
        }
        return null;
    }

    function getParam(options, primaryKey, secondaryKey) {
        if (!options) return undefined;
        if (options[primaryKey] !== undefined) return options[primaryKey];
        if (secondaryKey && options[secondaryKey] !== undefined) return options[secondaryKey];
        return undefined;
    }

    function safeStringify(obj) {
        try { return JSON.stringify(obj); } catch (e) { return '{}'; }
    }

    return {
        TICKS_PER_SECOND: TICKS_PER_SECOND,
        secondsToTicks: secondsToTicks,
        secondsToTicksString: secondsToTicksString,
        ticksToSeconds: ticksToSeconds,
        addTicks: addTicks,
        subTicks: subTicks,
        getSequenceEnd: getSequenceEnd,
        getMediaPath: getMediaPath,
        hasVideo: hasVideo,
        hasAudio: hasAudio,
        findBin: findBin,
        getParam: getParam,
        safeStringify: safeStringify
    };
})();
