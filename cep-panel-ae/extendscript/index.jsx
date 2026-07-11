/**********************************************************************
 * EditFlow AI AE - ExtendScript host
 *
 * Pattern based on TikTalk (https://github.com/mickeyperry/TikTalk)
 * which is a proven working AE CEP caption extension.
 *
 * KEY DIFFERENCES from our previous approach:
 *   1. Top-level function declarations (NOT IIFEs, NOT var namespaces)
 *   2. Direct function calls from the panel (NOT through a dispatcher)
 *   3. Returns plain strings (NOT JSON) — simpler, no parse errors
 *   4. Explicit $.evalFile() loading from the client (NOT relying on
 *      <ScriptPath> alone)
 *
 * Functions exposed to the panel:
 *   ef_getCompInfo()        → JSON string or "ERROR:..."
 *   ef_getAudioPath()       → JSON string or "ERROR:..."
 *   ef_createCaptions(json) → "Created N captions" or "ERROR:..."
 *   ef_clearCaptions()      → "Removed N" or "ERROR:..."
 *   ef_ping()               → "pong" (verify JSX is loaded)
 *********************************************************************/

var EF_TAG = "EF_CAPTION";  // layer.comment marker for cleanup

/* ── Helpers ── */

function ef_trim(s) { return String(s).replace(/^\s+|\s+$/g, ""); }

function ef_err(msg) {
    return "ERROR:" + String(msg);
}

function ef_ok(obj) {
    try { return JSON.stringify(obj); } catch (e) { return '{"error":"stringify failed"}'; }
}

/* Get the active comp or any comp with audio */
function ef_getComp() {
    var comp = app.project.activeItem;
    if (comp && comp instanceof CompItem) return comp;

    // Fallback: any comp with audio
    for (var i = 1; i <= app.project.numItems; i++) {
        var item = app.project.item(i);
        if (item instanceof CompItem) {
            for (var j = 1; j <= item.numLayers; j++) {
                try { if (item.layer(j).hasAudio) return item; } catch (e) {}
            }
        }
    }
    return null;
}

/* ── Ping (verify JSX loaded) ── */
function ef_ping() {
    return "pong";
}

/* ── Get comp info ── */
function ef_getCompInfo() {
    try {
        var comp = ef_getComp();
        if (!comp) return ef_err("No composition with audio found. Create a comp, add audio, and open it.");

        var hasAudio = false;
        for (var i = 1; i <= comp.numLayers; i++) {
            try { if (comp.layer(i).hasAudio) { hasAudio = true; break; } } catch (e) {}
        }

        return ef_ok({
            name: comp.name,
            width: comp.width,
            height: comp.height,
            duration: comp.duration,
            frameRate: comp.frameRate,
            numLayers: comp.numLayers,
            hasAudio: hasAudio
        });
    } catch (e) {
        return ef_err("getCompInfo: " + e.toString());
    }
}

/* ── Get audio file path from comp ── */
function ef_getAudioPath() {
    try {
        var comp = ef_getComp();
        if (!comp) return ef_err("No composition with audio found.");

        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            try {
                if (layer.hasAudio) {
                    var source = layer.source;
                    if (source && source.file) {
                        return ef_ok({ path: source.file.fsName });
                    }
                }
            } catch (e) {}
        }
        return ef_err("No audio layer with a file found. Import an audio file and add it to the comp.");
    } catch (e) {
        return ef_err("getAudioPath: " + e.toString());
    }
}

/* ── Style a text layer ── */
function ef_styleDoc(layer, fontSize, fontName, fillColor) {
    var tp = layer.property("Source Text");
    var td = tp.value;
    td.resetCharStyle();
    td.fontSize = fontSize;
    try { if (fontName) td.font = fontName; } catch (e) {}
    td.applyFill = true;
    td.fillColor = fillColor;
    td.applyStroke = false;
    td.justification = ParagraphJustification.CENTER_JUSTIFY;
    tp.setValue(td);
}

/* ── Apply animation keyframes ── */
function ef_animateLayer(layer, preset, startSec, endSec) {
    var dur = Math.max(0.05, endSec - startSec);
    var intro = Math.min(0.25, dur * 0.4);
    var transform = layer.property("ADBE Transform Group");

    if (preset === 'fade') {
        var opacity = transform.property("ADBE Opacity");
        opacity.setValueAtTime(startSec, 0);
        opacity.setValueAtTime(startSec + intro, 100);

    } else if (preset === 'pop') {
        var scale = transform.property("ADBE Scale");
        scale.setValueAtTime(startSec, [0, 0]);
        scale.setValueAtTime(startSec + intro * 0.6, [110, 110]);
        scale.setValueAtTime(startSec + intro, [100, 100]);

        var opacityPop = transform.property("ADBE Opacity");
        opacityPop.setValueAtTime(startSec, 0);
        opacityPop.setValueAtTime(startSec + intro * 0.5, 100);

    } else if (preset === 'bounce') {
        var scaleBounce = transform.property("ADBE Scale");
        scaleBounce.setValueAtTime(startSec, [0, 0]);
        scaleBounce.setValueAtTime(startSec + intro * 0.4, [125, 125]);
        scaleBounce.setValueAtTime(startSec + intro * 0.7, [90, 90]);
        scaleBounce.setValueAtTime(startSec + intro, [100, 100]);

        var opacityBounce = transform.property("ADBE Opacity");
        opacityBounce.setValueAtTime(startSec, 0);
        opacityBounce.setValueAtTime(startSec + intro * 0.3, 100);
    }
}

/* ── Remove old caption layers ── */
function ef_removeOldCaptions(comp) {
    var removed = 0;
    for (var i = comp.numLayers; i >= 1; i--) {
        var L = comp.layer(i);
        try { if (L.comment === EF_TAG) { L.remove(); removed++; } } catch (e) {}
    }
    return removed;
}

/* ── Create captions (main entry point) ── */
function ef_createCaptions(jsonStr) {
    var started = false;
    try {
        var cfg = eval("(" + jsonStr + ")");

        var comp = ef_getComp();
        if (!comp) return ef_err("No composition with audio found. Create a comp, add audio, and open it.");
        if (!cfg.words || !cfg.words.length) return ef_err("No words supplied.");

        var preset = cfg.preset || "pop";
        var fontSize = cfg.fontSize || 80;
        var fontName = cfg.fontName || "Arial";
        var fillColor = cfg.fillColor || [1, 1, 1];
        var position = cfg.position || [comp.width / 2, comp.height - (comp.height * 0.1)];

        app.beginUndoGroup("EditFlow: Create Captions");
        started = true;

        // Remove old captions first
        if (cfg.replace !== false) ef_removeOldCaptions(comp);

        var placed = 0;
        var errors = [];
        var batchStart = cfg.batchStart || 0;
        var batchSize = cfg.batchSize || 20;
        var batchEnd = Math.min(batchStart + batchSize, cfg.words.length);
        var batchWords = cfg.words.slice(batchStart, batchEnd);

        for (var i = 0; i < batchWords.length; i++) {
            var w = batchWords[i];
            var wordText = w.word || w.text || "";
            var startSec = parseFloat(w.start);
            var endSec = parseFloat(w.end);

            if (!wordText || !isFinite(startSec) || !isFinite(endSec) || endSec <= startSec) {
                errors.push("word " + (batchStart + i) + ": bad data");
                if (errors.length >= 3) break;
                continue;
            }

            try {
                // 1. Create native text layer
                var textLayer = comp.layers.addText(wordText);
                textLayer.name = "Caption: " + wordText.substr(0, 28);
                textLayer.comment = EF_TAG;

                // 2. Style
                ef_styleDoc(textLayer, fontSize, fontName, fillColor);

                // 3. Position + anchor
                var transform = textLayer.property("ADBE Transform Group");
                transform.property("ADBE Position").setValue(position);
                try {
                    var r = textLayer.sourceRectAtTime(startSec + 0.05, false);
                    transform.property("ADBE Anchor Point").setValue([r.left + r.width / 2, r.top + r.height / 2]);
                } catch (e) {}

                // 4. Trim
                textLayer.startTime = startSec;
                textLayer.outPoint = endSec + 0.3;

                // 5. Animate
                ef_animateLayer(textLayer, preset, startSec, endSec);

                placed++;
            } catch (e) {
                errors.push("word " + (batchStart + i) + ": " + e.toString());
                if (errors.length >= 3) break;
            }
        }

        app.endUndoGroup();

        var hasMore = batchEnd < cfg.words.length;
        return ef_ok({
            placed: placed,
            total: cfg.words.length,
            batch_start: batchStart,
            batch_end: batchEnd,
            total_placed: batchStart + placed,
            has_more: hasMore,
            next_batch_start: hasMore ? batchEnd : null,
            errors: errors,
            preset: preset,
            comp_name: comp.name
        });
    } catch (e) {
        if (started) { try { app.endUndoGroup(); } catch (_) {} }
        return ef_err("createCaptions: " + e.toString() + (e.line ? " (line " + e.line + ")" : ""));
    }
}

/* ── Clear all caption layers ── */
function ef_clearCaptions() {
    try {
        var comp = ef_getComp();
        if (!comp) return ef_err("No composition found.");

        app.beginUndoGroup("EditFlow: Clear Captions");
        var removed = ef_removeOldCaptions(comp);
        app.endUndoGroup();

        return ef_ok({ removed: removed });
    } catch (e) {
        return ef_err("clearCaptions: " + e.toString());
    }
}
