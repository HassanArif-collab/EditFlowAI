/*
 * index.jsx - SINGLE-FILE ExtendScript for EditFlow AI AE.
 *
 * This file contains ALL ExtendScript code in one file to eliminate
 * module load order issues. The CEP manifest's <ScriptPath> loads this
 * file directly — no $.evalFile() needed, no race conditions.
 *
 * Contains:
 *   1. Utility functions (editflowUtils namespace)
 *   2. Caption manager (captionManager namespace)
 *   3. Dispatcher (editflowDispatch)
 *
 * Uses native AE text layer API (NOT MOGRTs):
 *   - comp.layers.addText("word") creates a native text layer
 *   - property("Source Text") is directly settable
 *   - property("Scale") + property("Opacity") for transform animation
 */

// ============================================================================
// 1. UTILITIES
// ============================================================================
var editflowUtils = (function() {
    "use strict";

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

    function getActiveComp() {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) return null;
        return comp;
    }

    function getBestComp() {
        var active = getActiveComp();
        if (active) {
            for (var j = 1; j <= active.numLayers; j++) {
                try { if (active.layer(j).hasAudio) return active; } catch (e) {}
            }
        }
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof CompItem) {
                for (var k = 1; k <= item.numLayers; k++) {
                    try { if (item.layer(k).hasAudio) return item; } catch (e) {}
                }
            }
        }
        return null;
    }

    function getAudioPathFromComp(comp) {
        if (!comp) return null;
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            try {
                if (layer.hasAudio) {
                    var source = layer.source;
                    if (source && source.file) return source.file.fsName;
                }
            } catch (e) {}
        }
        return null;
    }

    return {
        getParam: getParam,
        safeStringify: safeStringify,
        ok: ok,
        err: err,
        getActiveComp: getActiveComp,
        getBestComp: getBestComp,
        getAudioPathFromComp: getAudioPathFromComp
    };
})();

// ============================================================================
// 2. CAPTION MANAGER
// ============================================================================
var captionManager = (function() {
    "use strict";

    function _ok(obj)  { obj = obj || {}; obj.success = true;  return editflowUtils.safeStringify(obj); }
    function _err(msg) { return editflowUtils.safeStringify({ success: false, error: String(msg) }); }

    function _createTextDocument(text, fontSize, fontName, fillColor) {
        var td = new TextDocument(text);
        if (fontSize) td.fontSize = fontSize;
        if (fontName) td.font = fontName;
        if (fillColor) td.fillColor = fillColor;
        td.applyFill = true;
        td.applyStroke = false;
        td.justification = ParagraphJustification.CENTER_JUSTIFY;
        return td;
    }

    function _animateLayer(layer, preset, startSec, endSec) {
        var dur = Math.max(0.05, endSec - startSec);
        var intro = Math.min(0.25, dur * 0.4);
        var transform = layer.property("ADBE Transform Group");

        if (preset === 'fade') {
            var opacity = transform.property("ADBE Opacity");
            opacity.setValueAtTime(startSec, 0);
            opacity.setValueAtTime(startSec + intro, 100);
            try {
                opacity.setInterpolationTypeAtKey(1, KeyframeInterpolationType.BEZIER_INTERPOLATION);
                opacity.setInterpolationTypeAtKey(2, KeyframeInterpolationType.BEZIER_INTERPOLATION);
            } catch (e) {}

        } else if (preset === 'pop') {
            var scale = transform.property("ADBE Scale");
            scale.setValueAtTime(startSec, [0, 0]);
            scale.setValueAtTime(startSec + intro * 0.6, [110, 110]);
            scale.setValueAtTime(startSec + intro, [100, 100]);
            try {
                for (var k = 1; k <= 3; k++) {
                    scale.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER_INTERPOLATION);
                }
            } catch (e) {}

            var opacityPop = transform.property("ADBE Opacity");
            opacityPop.setValueAtTime(startSec, 0);
            opacityPop.setValueAtTime(startSec + intro * 0.5, 100);
            try {
                opacityPop.setInterpolationTypeAtKey(1, KeyframeInterpolationType.BEZIER_INTERPOLATION);
                opacityPop.setInterpolationTypeAtKey(2, KeyframeInterpolationType.BEZIER_INTERPOLATION);
            } catch (e) {}

        } else if (preset === 'bounce') {
            var scaleBounce = transform.property("ADBE Scale");
            scaleBounce.setValueAtTime(startSec, [0, 0]);
            scaleBounce.setValueAtTime(startSec + intro * 0.4, [125, 125]);
            scaleBounce.setValueAtTime(startSec + intro * 0.7, [90, 90]);
            scaleBounce.setValueAtTime(startSec + intro, [100, 100]);
            try {
                for (var k2 = 1; k2 <= 4; k2++) {
                    scaleBounce.setInterpolationTypeAtKey(k2, KeyframeInterpolationType.BEZIER_INTERPOLATION);
                }
            } catch (e) {}

            var opacityBounce = transform.property("ADBE Opacity");
            opacityBounce.setValueAtTime(startSec, 0);
            opacityBounce.setValueAtTime(startSec + intro * 0.3, 100);
            try {
                opacityBounce.setInterpolationTypeAtKey(1, KeyframeInterpolationType.BEZIER_INTERPOLATION);
                opacityBounce.setInterpolationTypeAtKey(2, KeyframeInterpolationType.BEZIER_INTERPOLATION);
            } catch (e) {}
        }
    }

    function createCaptions(options) {
        try {
            var comp = editflowUtils.getBestComp();
            if (!comp) return _err("No composition with audio found. Create a comp, add audio, and open it.");

            var words = editflowUtils.getParam(options, 'words') || [];
            if (!words.length) return _err("No words to place.");

            var preset = editflowUtils.getParam(options, 'preset') || "pop";
            var fontSize = editflowUtils.getParam(options, 'fontSize') || 80;
            var fontName = editflowUtils.getParam(options, 'fontName') || "Arial";
            var position = editflowUtils.getParam(options, 'position');
            var fillColor = editflowUtils.getParam(options, 'fillColor');

            if (!position) {
                position = [comp.width / 2, comp.height - (comp.height * 0.1)];
            }
            if (!fillColor) {
                fillColor = [1, 1, 1];
            }

            var placed = 0;
            var errors = [];

            var batchStart = editflowUtils.getParam(options, 'batchStart') || 0;
            var batchSize = editflowUtils.getParam(options, 'batchSize') || 20;
            var batchEnd = Math.min(batchStart + batchSize, words.length);
            var batchWords = words.slice(batchStart, batchEnd);

            app.beginUndoGroup("EditFlow: Create Captions");

            try {
                for (var i = 0; i < batchWords.length; i++) {
                    var w = batchWords[i];
                    var wordText = w.word || w.text || "";
                    var startSec = parseFloat(w.start);
                    var endSec = parseFloat(w.end);

                    if (!wordText || !isFinite(startSec) || !isFinite(endSec) || endSec <= startSec) {
                        errors.push({ word: wordText, step: "validate", error: "bad word data: start=" + startSec + " end=" + endSec });
                        if (errors.length >= 3) break;
                        continue;
                    }

                    try {
                        // 1. Create native text layer
                        var textLayer = comp.layers.addText(wordText);
                        textLayer.name = "Caption: " + wordText;

                        // 2. Set text style
                        var sourceText = textLayer.property("ADBE Text Properties").property("ADBE Text Document");
                        var textDoc = _createTextDocument(wordText, fontSize, fontName, fillColor);
                        sourceText.setValue(textDoc);

                        // 3. Position
                        var transform = textLayer.property("ADBE Transform Group");
                        transform.property("ADBE Position").setValue(position);

                        // 4. Set anchor point to center (for proper scaling)
                        try {
                            var sourceRect = textLayer.sourceRectAtTime(startSec, false);
                            var anchorX = sourceRect.left + sourceRect.width / 2;
                            var anchorY = sourceRect.top + sourceRect.height / 2;
                            transform.property("ADBE Anchor Point").setValue([anchorX, anchorY]);
                        } catch (e) {
                            // sourceRectAtTime can fail — use position as anchor
                        }

                        // 5. Trim to word duration
                        textLayer.startTime = startSec;
                        textLayer.outPoint = endSec;

                        // 6. Animate
                        _animateLayer(textLayer, preset, startSec, endSec);

                        placed++;
                    } catch (e) {
                        errors.push({ word: wordText, step: "create", error: e.toString() });
                        if (errors.length >= 3) break;
                    }
                }
            } finally {
                app.endUndoGroup();
            }

            var totalPlaced = batchStart + placed;
            var hasMore = batchEnd < words.length;

            return _ok({
                placed: placed,
                total: words.length,
                batch_start: batchStart,
                batch_end: batchEnd,
                total_placed: totalPlaced,
                has_more: hasMore,
                next_batch_start: hasMore ? batchEnd : null,
                errors: errors,
                preset: preset,
                comp_name: comp.name,
                comp_duration: comp.duration
            });
        } catch (e) {
            return _err("createCaptions failed: " + e.toString());
        }
    }

    function getCompInfo() {
        try {
            var comp = editflowUtils.getBestComp();
            if (!comp) return _err("No composition with audio found. Create a comp, add audio, and open it.");
            return _ok({
                name: comp.name,
                width: comp.width,
                height: comp.height,
                duration: comp.duration,
                frameRate: comp.frameRate,
                numLayers: comp.numLayers,
                hasAudio: (function() {
                    for (var i = 1; i <= comp.numLayers; i++) {
                        try { if (comp.layer(i).hasAudio) return true; } catch (e) {}
                    }
                    return false;
                })()
            });
        } catch (e) {
            return _err("getCompInfo failed: " + e.toString());
        }
    }

    function getAudioPath() {
        try {
            var comp = editflowUtils.getBestComp();
            if (!comp) return _err("No composition with audio found.");
            var audioPath = editflowUtils.getAudioPathFromComp(comp);
            if (!audioPath) return _err("No audio layer found in the comp. Import an audio file and add it to the comp.");
            return _ok({ path: audioPath });
        } catch (e) {
            return _err("getAudioPath failed: " + e.toString());
        }
    }

    function clearCaptions() {
        try {
            var comp = editflowUtils.getBestComp();
            if (!comp) return _err("No composition with audio found.");
            var removed = 0;
            app.beginUndoGroup("EditFlow: Clear Captions");
            try {
                var layersToRemove = [];
                for (var i = 1; i <= comp.numLayers; i++) {
                    var layer = comp.layer(i);
                    if (layer.name && layer.name.indexOf("Caption: ") === 0) {
                        layersToRemove.push(layer);
                    }
                }
                for (var j = 0; j < layersToRemove.length; j++) {
                    layersToRemove[j].remove();
                    removed++;
                }
            } finally {
                app.endUndoGroup();
            }
            return _ok({ removed: removed });
        } catch (e) {
            return _err("clearCaptions failed: " + e.toString());
        }
    }

    return {
        createCaptions: createCaptions,
        getCompInfo: getCompInfo,
        getAudioPath: getAudioPath,
        clearCaptions: clearCaptions
    };
})();

// ============================================================================
// 3. DISPATCHER
// ============================================================================
function editflowErrorResult(error, command) {
    var message = error && error.toString ? error.toString() : String(error);
    var cmd = command || "";
    return '{"success":false,"error":"' + message.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + '","command":"' + cmd + '"}';
}

function editflowDispatch(command, payloadData) {
    try {
        var options = {};
        if (payloadData) {
            try { options = JSON.parse(payloadData); } catch (e) { options = {}; }
        }

        var result;

        switch (command) {
            case "editflowConfigureExtensionRoot":
                // No-op: all modules are already loaded (single-file bundle)
                result = editflowUtils.ok({ status: "ready" });
                break;

            case "getCompInfo":
                result = captionManager.getCompInfo();
                break;

            case "getAudioPath":
                result = captionManager.getAudioPath();
                break;

            case "createCaptions":
                result = captionManager.createCaptions(options);
                break;

            case "clearCaptions":
                result = captionManager.clearCaptions();
                break;

            default:
                result = editflowUtils.safeStringify({
                    success: false,
                    error: "Unknown command: " + command
                });
        }

        return result;
    } catch (e) {
        return editflowErrorResult(e, command);
    }
}
