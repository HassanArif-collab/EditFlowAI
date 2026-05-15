/**
 * EditFlow AI - Shared Utilities
 * Common functions for Premiere Pro scripting.
 */

var editflowUtils = (function() {
    "use strict";

    var TICKS_PER_SECOND = 254016000000;

    /**
     * Convert seconds to ticks as a string.
     */
    function secondsToTicks(seconds) {
        if (seconds === undefined || seconds === null || seconds === "") return "0";
        var s = Number(seconds);
        if (isNaN(s)) return "0";
        return Math.round(s * TICKS_PER_SECOND).toString();
    }

    /**
     * Convert Premiere ticks to seconds.
     */
    function ticksToSeconds(ticks) {
        if (ticks === undefined || ticks === null || ticks === "") return 0;
        var t = Number(ticks);
        if (isNaN(t)) return 0;
        return t / TICKS_PER_SECOND;
    }

    /**
     * Add two tick strings/numbers safely.
     */
    function addTicks(t1, t2) {
        return (Number(t1 || 0) + Number(t2 || 0)).toString();
    }

    /**
     * Subtract two tick strings/numbers safely.
     */
    function subTicks(t1, t2) {
        return (Number(t1 || 0) - Number(t2 || 0)).toString();
    }

    /**
     * Safely get the end time of a sequence.
     */
    function getSequenceEnd(seq) {
        if (!seq) return "0";
        try {
            if (seq.getEnd) return seq.getEnd().ticks;
            if (seq.end) return seq.end.ticks || seq.end;
        } catch(e) {}
        return "0";
    }

    /**
     * Safely check if a project item has video.
     */
    function hasVideo(item) {
        if (!item) return false;
        try {
            if (typeof item.hasVideo === 'function') return item.hasVideo() === 1 || item.hasVideo() === true;
            if (item.hasVideo !== undefined) return item.hasVideo === true;
        } catch(e) {}
        return false;
    }

    /**
     * Safely check if a project item has audio.
     */
    function hasAudio(item) {
        if (!item) return false;
        try {
            if (typeof item.hasAudio === 'function') return item.hasAudio() === 1 || item.hasAudio() === true;
            if (item.hasAudio !== undefined) return item.hasAudio === true;
        } catch(e) {}
        return false;
    }

    /**
     * Find a bin (folder) recursively by name.
     */
    function findBin(parent, binName) {
        if (!parent || !binName) return null;
        for (var i = 0; i < parent.children.numItems; i++) {
            var item = parent.children[i];
            if (item.type === ProjectItemType.BIN) {
                if (item.name === binName) return item;
                var found = findBin(item, binName);
                if (found) return found;
            }
        }
        return null;
    }

    /**
     * Standardize property names from payload.
     */
    function getParam(options, primaryKey, secondaryKey) {
        if (!options) return undefined;
        if (options[primaryKey] !== undefined) return options[primaryKey];
        if (secondaryKey && options[secondaryKey] !== undefined) return options[secondaryKey];
        return undefined;
    }

    return {
        secondsToTicks: secondsToTicks,
        ticksToSeconds: ticksToSeconds,
        getSequenceEnd: getSequenceEnd,
        hasVideo: hasVideo,
        hasAudio: hasAudio,
        findBin: findBin,
        getParam: getParam
    };
})();
