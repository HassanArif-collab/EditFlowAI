/*
 * utils.jsx - Common utility functions for EditFlow AI AE ExtendScript.
 * Provides time conversions, JSON helpers, and safe wrappers.
 */
editflowUtils = (function() {
    "use strict";

    // After Effects uses seconds (not ticks like Premiere)
    // Time conversions are simpler in AE

    function secondsToTime(seconds) {
        return seconds;  // AE uses seconds directly
    }

    function timeToSeconds(time) {
        return time;  // AE uses seconds directly
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

    function ok(obj) {
        obj = obj || {};
        obj.success = true;
        return safeStringify(obj);
    }

    function err(msg) {
        return safeStringify({ success: false, error: String(msg) });
    }

    // Get the active comp (must be a CompItem)
    function getActiveComp() {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return null;
        }
        return comp;
    }

    // Find an audio item in the project by name
    function findAudioItem(name) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item.name === name && item instanceof FootageItem) {
                if (item.hasAudio) {
                    return item;
                }
            }
        }
        return null;
    }

    // Get the main audio file path from the active comp's layers
    function getAudioPathFromComp(comp) {
        if (!comp) return null;
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            try {
                if (layer.hasAudio) {
                    var source = layer.source;
                    if (source && source.file) {
                        return source.file.fsName;
                    }
                }
            } catch (e) {}
        }
        return null;
    }

    // Format a number to a fixed precision
    function fmt(n, decimals) {
        decimals = decimals || 3;
        return Number(n).toFixed(decimals);
    }

    return {
        secondsToTime: secondsToTime,
        timeToSeconds: timeToSeconds,
        getParam: getParam,
        safeStringify: safeStringify,
        ok: ok,
        err: err,
        getActiveComp: getActiveComp,
        findAudioItem: findAudioItem,
        getAudioPathFromComp: getAudioPathFromComp,
        fmt: fmt
    };
})();
