/*
 * caption_manager.jsx - Native AE caption creation + animation.
 *
 * Uses After Effects' native text layer API (NOT MOGRTs):
 *   - comp.layers.addText("word") creates a native text layer
 *   - property("Source Text") is directly settable (no JSON patching!)
 *   - property("Scale") + property("Opacity") for transform animation
 *   - Text Animators for per-character animation (optional, advanced)
 *
 * AE handles 100+ text layers easily — no memory crashes like Premiere.
 *
 * Animation presets:
 *   fade  - Opacity 0->100 per word
 *   pop   - Scale 0->110->100 + Opacity 0->100 (Hormozi style)
 *   bounce- Scale 0->125->90->100 + Opacity 0->100
 *
 * All text layers are placed at the same position (bottom-center by default)
 * so words appear in the same spot as they're spoken.
 */
captionManager = (function() {
    "use strict";

    function _ok(obj)  { obj = obj || {}; obj.success = true;  return editflowUtils.safeStringify(obj); }
    function _err(msg) { return editflowUtils.safeStringify({ success: false, error: String(msg) }); }

    // ── Easing functions ──
    function easeOutBack(t) {
        var c1 = 1.70158, c3 = c1 + 1;
        return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    }
    function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

    // ── Get or create a text style ──
    // Returns a TextDocument object with the specified font/size/color
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

    // ── Apply animation keyframes to a text layer ──
    function _animateLayer(layer, preset, startSec, endSec) {
        var dur = Math.max(0.05, endSec - startSec);
        var intro = Math.min(0.25, dur * 0.4);

        // Transform group
        var transform = layer.property("ADBE Transform Group");

        if (preset === 'fade') {
            // Opacity: 0 -> 100 over intro
            var opacity = transform.property("ADBE Opacity");
            opacity.setValueAtTime(startSec, 0);
            opacity.setValueAtTime(startSec + intro, 100);
            try {
                opacity.setInterpolationTypeAtKey(1, KeyframeInterpolationType.BEZIER_INTERPOLATION);
                opacity.setInterpolationTypeAtKey(2, KeyframeInterpolationType.BEZIER_INTERPOLATION);
            } catch (e) {}

        } else if (preset === 'pop') {
            // Scale: 0 -> 110 (at 60%) -> 100 (at end of intro)
            var scale = transform.property("ADBE Scale");
            scale.setValueAtTime(startSec, [0, 0]);
            scale.setValueAtTime(startSec + intro * 0.6, [110, 110]);
            scale.setValueAtTime(startSec + intro, [100, 100]);
            try {
                for (var k = 1; k <= 3; k++) {
                    scale.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER_INTERPOLATION);
                }
            } catch (e) {}

            // Opacity: 0 -> 100 at 50% of intro
            var opacity = transform.property("ADBE Opacity");
            opacity.setValueAtTime(startSec, 0);
            opacity.setValueAtTime(startSec + intro * 0.5, 100);
            try {
                opacity.setInterpolationTypeAtKey(1, KeyframeInterpolationType.BEZIER_INTERPOLATION);
                opacity.setInterpolationTypeAtKey(2, KeyframeInterpolationType.BEZIER_INTERPOLATION);
            } catch (e) {}

        } else if (preset === 'bounce') {
            // Scale: 0 -> 125 -> 90 -> 100
            var scale = transform.property("ADBE Scale");
            scale.setValueAtTime(startSec, [0, 0]);
            scale.setValueAtTime(startSec + intro * 0.4, [125, 125]);
            scale.setValueAtTime(startSec + intro * 0.7, [90, 90]);
            scale.setValueAtTime(startSec + intro, [100, 100]);
            try {
                for (var k = 1; k <= 4; k++) {
                    scale.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER_INTERPOLATION);
                }
            } catch (e) {}

            // Opacity
            var opacity = transform.property("ADBE Opacity");
            opacity.setValueAtTime(startSec, 0);
            opacity.setValueAtTime(startSec + intro * 0.3, 100);
            try {
                opacity.setInterpolationTypeAtKey(1, KeyframeInterpolationType.BEZIER_INTERPOLATION);
                opacity.setInterpolationTypeAtKey(2, KeyframeInterpolationType.BEZIER_INTERPOLATION);
            } catch (e) {}
        }

        // Add a slight scale-down at the end of the word (optional, gives a "settle" feel)
        // Skip this for very short words
        if (dur > 0.3) {
            var scale = transform.property("ADBE Scale");
            var currentVal = scale.valueAtTime(endSec - 0.05, false);
            try {
                scale.setValueAtTime(endSec - 0.05, currentVal);
                scale.setValueAtTime(endSec, [currentVal[0] * 0.95, currentVal[1] * 0.95]);
            } catch (e) {}
        }
    }

    // ── Main: create caption text layers ──
    // Creates 1 text layer per word, trimmed to the word's duration,
    // with animation keyframes. All layers are positioned at the same spot.
    function createCaptions(options) {
        try {
            var comp = editflowUtils.getBestComp();
            if (!comp) return _err("No composition with audio found. Create a comp, add audio to it, and make sure it's open.");

            var words = editflowUtils.getParam(options, 'words') || [];
            if (!words.length) return _err("No words to place.");

        var preset = editflowUtils.getParam(options, 'preset') || "pop";
        var fontSize = editflowUtils.getParam(options, 'fontSize') || 80;
        var fontName = editflowUtils.getParam(options, 'fontName') || "Arial";
        var position = editflowUtils.getParam(options, 'position');  // [x, y] or null for default
        var fillColor = editflowUtils.getParam(options, 'fillColor');  // [r, g, b] 0-1

        // Default position: bottom-center of the comp
        if (!position) {
            position = [comp.width / 2, comp.height - (comp.height * 0.1)];
        }

        // Default color: white
        if (!fillColor) {
            fillColor = [1, 1, 1];  // white
        }

        // Create a folder for the caption layers (keeps the comp clean)
        var captionFolder = comp.layers.addNull();
        captionFolder.name = "EditFlow Captions";
        captionFolder.enabled = false;  // null layer is invisible
        // Actually AE doesn't have layer folders in the timeline like Premiere.
        // Instead, we'll just name all layers with a prefix.
        captionFolder.remove();  // remove the null, we don't need it

        var placed = 0;
        var errors = [];

        // Batch processing: process in chunks to avoid UI freeze
        var batchStart = editflowUtils.getParam(options, 'batchStart') || 0;
        var batchSize = editflowUtils.getParam(options, 'batchSize') || 20;
        var batchEnd = Math.min(batchStart + batchSize, words.length);
        var batchWords = words.slice(batchStart, batchEnd);

        // Begin undo group
        app.beginUndoGroup("EditFlow: Create Captions");

        try {
            for (var i = 0; i < batchWords.length; i++) {
                var w = batchWords[i];
                var wordText = w.word || w.text || "";
                var startSec = parseFloat(w.start);
                var endSec = parseFloat(w.end);

                if (!wordText || !isFinite(startSec) || !isFinite(endSec) || endSec <= startSec) {
                    errors.push({ word: wordText, step: "validate", error: "bad word data" });
                    if (errors.length >= 3) break;
                    continue;
                }

                try {
                    // 1. Create a native text layer (NO MOGRT!)
                    var textLayer = comp.layers.addText(wordText);
                    textLayer.name = "Caption: " + wordText;

                    // 2. Set the text style
                    var sourceText = textLayer.property("ADBE Text Properties").property("ADBE Text Document");
                    var textDoc = _createTextDocument(wordText, fontSize, fontName, fillColor);
                    sourceText.setValue(textDoc);

                    // 3. Position the layer
                    var transform = textLayer.property("ADBE Transform Group");
                    transform.property("ADBE Position").setValue(position);

                    // 4. Set the anchor point to center (for proper scaling)
                    // AE text layers default anchor to left-baseline; move to center
                    var sourceRect = textLayer.sourceRectAtTime(startSec, false);
                    var anchorX = sourceRect.left + sourceRect.width / 2;
                    var anchorY = sourceRect.top + sourceRect.height / 2;
                    transform.property("ADBE Anchor Point").setValue([anchorX, anchorY]);

                    // 5. Trim the layer to the word's duration
                    textLayer.startTime = startSec;
                    textLayer.outPoint = endSec;

                    // 6. Apply animation keyframes
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
        } catch (e) {
            $.writeln('[EditFlow] createCaptions error: ' + e.toString());
            return _err('createCaptions failed: ' + e.toString());
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
    }

    // ── Get comp info (for the panel UI) ──
    function getCompInfo() {
        try {
            var comp = editflowUtils.getBestComp();
            if (!comp) return _err("No composition with audio found.");
            return _ok({
                name: comp.name,
                width: comp.width,
                height: comp.height,
                duration: comp.duration,
                frameRate: comp.frameRate,
                numLayers: comp.numLayers,
                hasAudio: (function() {
                    for (var i = 1; i <= comp.numLayers; i++) {
                        try {
                            if (comp.layer(i).hasAudio) return true;
                        } catch (e) {}
                    }
                    return false;
                })()
            });
        } catch (e) {
            $.writeln('[EditFlow] getCompInfo error: ' + e.toString());
            return _err('getCompInfo failed: ' + e.toString());
        }
    }

    // ── Get audio file path from the active comp ──
    function getAudioPath() {
        try {
            var comp = editflowUtils.getBestComp();
            if (!comp) return _err("No composition with audio found.");

            var audioPath = editflowUtils.getAudioPathFromComp(comp);
            if (!audioPath) {
                return _err("No audio layer found in the comp. Import an audio file and add it to the comp.");
            }
            return _ok({ path: audioPath });
        } catch (e) {
            $.writeln('[EditFlow] getAudioPath error: ' + e.toString());
            return _err('getAudioPath failed: ' + e.toString());
        }
    }

    // ── Clear all existing caption layers ──
    function clearCaptions() {
        try {
            var comp = editflowUtils.getBestComp();
            if (!comp) return _err("No composition with audio found.");

            var removed = 0;
            app.beginUndoGroup("EditFlow: Clear Captions");
            try {
                // Collect layers to remove (iterate backwards since we're modifying)
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
            $.writeln('[EditFlow] clearCaptions error: ' + e.toString());
            return _err('clearCaptions failed: ' + e.toString());
        }
    }

    return {
        createCaptions: createCaptions,
        getCompInfo: getCompInfo,
        getAudioPath: getAudioPath,
        clearCaptions: clearCaptions
    };
})();
