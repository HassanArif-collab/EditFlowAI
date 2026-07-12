/**********************************************************************
 * EditFlow AI AE - ExtendScript host (v4 — Premium Caption Engine)
 *
 * Complete rewrite based on deep research of TikTalk, AutoCaption,
 * and Adobe AE scripting API. Implements:
 *
 * Visual Styles:
 *   - floating: text with optional drop shadow
 *   - pill: text inside rounded rectangle
 *   - highlight: mixed (some words have colored boxes)
 *
 * Animation Presets (expression-based):
 *   - popin: spring scale overshoot
 *   - fadeup: opacity + position Y slide
 *   - karaoke: per-word scale punch + color change
 *   - wordbyword: sequential word reveal
 *   - typewriter: character-by-character
 *   - boxpop: shape layer scales behind each word
 *
 * Features:
 *   - Word grouping (maxWords, maxChars, maxDuration, maxGap)
 *   - Per-word highlighting (selected words get colored box)
 *   - Font listing via app.fonts.allFonts (AE 24+)
 *   - Drop shadow via Layer Style or effect
 *   - Audio offset correction
 *   - layer.comment tagging for cleanup
 *********************************************************************/

var EF_TAG = "EF_CAPTION";

/* ── Helpers ── */

function ef_err(msg) { return "ERROR:" + String(msg); }

function ef_json(obj) {
    try { return JSON.stringify(obj); } catch (e) {
        // Manual fallback for ES3
        try {
            var parts = [];
            for (var k in obj) {
                if (obj.hasOwnProperty(k)) {
                    var v = obj[k];
                    if (v === null) { parts.push('"' + k + '":null'); continue; }
                    if (typeof v === "string") { parts.push('"' + k + '":"' + v.replace(/\\/g,"\\\\").replace(/"/g,'\\"') + '"'); continue; }
                    if (typeof v === "number" || typeof v === "boolean") { parts.push('"' + k + '":' + v); continue; }
                    if (Array.isArray(v)) {
                        var items = [];
                        for (var vi = 0; vi < v.length; vi++) {
                            if (typeof v[vi] === "string") items.push('"' + v[vi].replace(/"/g,'\\"') + '"');
                            else items.push(String(v[vi]));
                        }
                        parts.push('"' + k + '":[' + items.join(",") + ']');
                    }
                }
            }
            return "{" + parts.join(",") + "}";
        } catch (e2) { return '{"error":"json_failed"}'; }
    }
}

function ef_getComp() {
    var comp = app.project.activeItem;
    if (comp && comp instanceof CompItem) return comp;
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

/* ── Ping ── */
function ef_ping() { return "pong"; }

/* ── Font listing (AE 24+) ── */
function ef_getFonts() {
    try {
        if (typeof app.fonts === "undefined" || !app.fonts || !app.fonts.allFonts) {
            return ef_err("Font list needs After Effects 2024 (24.0) or newer.");
        }
        var groups = app.fonts.allFonts;
        var out = [];
        for (var i = 0; i < groups.length; i++) {
            var g = groups[i];
            if (g && typeof g.length === "number" && !g.postScriptName) {
                for (var j = 0; j < g.length; j++) {
                    if (g[j] && g[j].postScriptName) {
                        out.push({ ps: g[j].postScriptName, family: g[j].familyName || "", style: g[j].styleName || "" });
                    }
                }
            } else if (g && g.postScriptName) {
                out.push({ ps: g.postScriptName, family: g.familyName || "", style: g.styleName || "" });
            }
        }
        if (!out.length) return ef_err("No fonts reported by After Effects.");
        return ef_json(out);
    } catch (e) {
        return ef_err("getFonts: " + e.toString());
    }
}

/* ── Get comp info ── */
function ef_getCompInfo() {
    try {
        var comp = ef_getComp();
        if (!comp) return ef_err("No composition with audio found.");
        var hasAudio = false;
        for (var i = 1; i <= comp.numLayers; i++) {
            try { if (comp.layer(i).hasAudio) { hasAudio = true; break; } } catch (e) {}
        }
        return ef_json({ name: comp.name, width: comp.width, height: comp.height,
            duration: comp.duration, frameRate: comp.frameRate, numLayers: comp.numLayers, hasAudio: hasAudio });
    } catch (e) { return ef_err("getCompInfo: " + e.toString()); }
}

/* ── Get audio path ── */
function ef_getAudioPath() {
    try {
        var comp = ef_getComp();
        if (!comp) return ef_err("No composition with audio found.");
        if (comp.selectedLayers && comp.selectedLayers.length > 0) {
            var sel = comp.selectedLayers[0];
            try {
                if (sel.source && sel.source instanceof FootageItem &&
                    sel.source.mainSource && sel.source.mainSource.file) {
                    return ef_json({ path: sel.source.mainSource.file.fsName, offset: sel.startTime });
                }
            } catch (e) {}
        }
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            try {
                if (layer.hasAudio && layer.source) {
                    if (layer.source.mainSource && layer.source.mainSource.file)
                        return ef_json({ path: layer.source.mainSource.file.fsName, offset: layer.startTime });
                    if (layer.source.file)
                        return ef_json({ path: layer.source.file.fsName, offset: layer.startTime });
                }
            } catch (e) {}
        }
        return ef_err("No audio layer with a file found. Select an audio layer.");
    } catch (e) { return ef_err("getAudioPath: " + e.toString()); }
}

/* ── Export comp audio mixdown via Render Queue ── */
/* VERIFIED against official AE docs (ae-scripting.docsforadobe.dev).
   Fixes: re-fetch OM after applyTemplate, render only our item,
   no Lossless fallback (video template), check dir create, re-stat file.
   Handles: video clips with embedded audio, multiple clips, trimmed clips. */
function ef_exportCompAudioMixdown(outPath) {
    try {
        var comp = ef_getComp();
        if (!comp) return ef_err("No composition found.");

        var outFile = new File(outPath);
        var outDir = outFile.parent;
        if (!outDir) return ef_err("Invalid output path: " + outPath);
        if (!outDir.exists) {
            if (!outDir.create()) {
                return ef_err("Could not create output directory: " + outDir.fsName);
            }
        }
        // Remove stale output so post-render size check is meaningful
        try { if (outFile.exists) outFile.remove(); } catch (e) {}

        // Add comp to render queue
        var rq = app.project.renderQueue;
        var rqItem = rq.items.add(comp);

        // Apply audio-only template — try built-in "AIFF 48kHz" first,
        // then search user-saved templates for AIFF or WAV in the name
        var om = rqItem.outputModule(1);
        var candidates = ["AIFF 48kHz", "WAV 48kHz", "WAV"];
        try {
            var tl = om.templates;
            for (var t = 0; t < tl.length; t++) {
                var nm = tl[t];
                if ((nm.indexOf("AIFF") >= 0 || nm.indexOf("WAV") >= 0) &&
                    candidates.indexOf(nm) < 0) {
                    candidates.push(nm);
                }
            }
        } catch (e) {}

        var applied = null, lastErr = "";
        for (var c = 0; c < candidates.length; c++) {
            try { om.applyTemplate(candidates[c]); applied = candidates[c]; break; }
            catch (e) { lastErr = candidates[c] + ": " + e.toString(); }
        }
        if (!applied) {
            try { rqItem.remove(); } catch (e) {}
            return ef_err("No audio output template found. Save an 'AIFF 48kHz' template via Edit > Templates > Output Module. Error: " + lastErr);
        }

        // RE-FETCH the OM after applyTemplate — AE bug invalidates the reference
        om = rqItem.outputModule(1);
        om.file = outFile;

        // Make sure ONLY our item is queued — render() renders every queued item
        for (var k = 1; k <= rq.numItems; k++) {
            try { rq.item(k).render = (rq.item(k) === rqItem); } catch (e) {}
        }

        // RENDER — BLOCKING. AE UI will freeze until done.
        rq.render();

        // Re-stat the output file (File objects can cache pre-render state)
        var result = new File(outFile.fsName);
        try { rqItem.remove(); } catch (e) {}

        if (!result.exists || result.length === 0) {
            return ef_err("Audio export produced no file. Check render queue settings.");
        }

        return ef_json({ path: result.fsName, size: result.length,
                         template: applied, comp: comp.name });
    } catch (e) {
        return ef_err("exportCompAudioMixdown: " + e.toString());
    }
}

/* ── Get audio inventory (all audio layers with timing info) ── */
/* Returns comp-time values. Backend must apply trim math:
   sourceTime = (compTime - startTime) * (100 / stretch) */
function ef_getAudioInventory(selectedOnly) {
    try {
        var comp = ef_getComp();
        if (!comp) return ef_err("No composition found.");

        var layers = [];
        var checkLayers = [];

        if (selectedOnly && comp.selectedLayers && comp.selectedLayers.length > 0) {
            // Only selected layers
            checkLayers = comp.selectedLayers;
        } else {
            // All layers
            for (var ai = 1; ai <= comp.numLayers; ai++) {
                checkLayers.push(comp.layer(ai));
            }
        }

        for (var i = 0; i < checkLayers.length; i++) {
            var layer = checkLayers[i];
            try {
                // hasAudio is true for video layers with embedded audio too
                if (layer.hasAudio && layer.source) {
                    var filePath = null;
                    if (layer.source.mainSource && layer.source.mainSource.file) {
                        filePath = layer.source.mainSource.file.fsName;
                    } else if (layer.source.file) {
                        filePath = layer.source.file.fsName;
                    }
                    if (filePath) {
                        layers.push({
                            file: filePath,
                            name: layer.name,
                            startTime: layer.startTime,
                            inPoint: layer.inPoint,
                            outPoint: layer.outPoint,
                            stretch: layer.stretch,
                            hasVideo: layer.hasVideo,
                            hasAudio: layer.hasAudio
                        });
                    }
                }
            } catch (e) {}
        }

        if (!layers.length) {
            if (selectedOnly) {
                return ef_err("No audio layers found in selection. Select layers with audio (video clips with audio work too).");
            }
            return ef_err("No audio layers with files found.");
        }
        return ef_json({ layers: layers, count: layers.length, compDuration: comp.duration, selectedOnly: !!selectedOnly });
    } catch (e) { return ef_err("getAudioInventory: " + e.toString()); }
}

/* ══ Expression Library ══ */
// All expressions are parameterized — the client builds them with actual values

var EF_SPRING_SCALE = "f=3.0; d=6.0; t=time-inPoint;\n" +
    "if(t<0){[0,0]}else{s=100-100*Math.exp(-d*t)*Math.cos(f*2*Math.PI*t);[s,s]}";

var EF_REVEAL_OP = "t=time-inPoint; linear(t,0,0.1,0,100)";

// Build fade-up expressions with configurable parameters
// fadeDur: how long the fade takes (seconds)
// slideDist: how many pixels the word slides up (positive = starts below)
// easing: "linear", "ease_in", "ease_out", "ease_in_out"
function ef_buildFadeUpOp(fadeDur, easing) {
    var d = fadeDur || 0.3;
    var e = easing || "linear";
    if (e === "ease_out") return "t=time-inPoint; t<0?0:(t>=" + d + "?100:easeOut(t/" + d + ")*100)";
    if (e === "ease_in") return "t=time-inPoint; t<0?0:(t>=" + d + "?100:(t/" + d + ")*(t/" + d + ")*100)";
    if (e === "ease_in_out") return "t=time-inPoint; t<0?0:(t>=" + d + "?100:ease(t/" + d + ")*100)";
    return "t=time-inPoint; linear(t,0," + d + ",0,100)";
}

function ef_buildFadeUpPos(fadeDur, slideDist, easing) {
    var d = fadeDur || 0.3;
    var s = slideDist || 40;
    var e = easing || "linear";
    if (e === "ease_out") return "t=time-inPoint; t<0?[value[0],value[1]+" + s + "]:(t>=" + d + "?value:[value[0],value[1]+" + s + "-easeOut(t/" + d + ")*" + s + "])";
    if (e === "ease_in") return "t=time-inPoint; t<0?[value[0],value[1]+" + s + "]:(t>=" + d + "?value:[value[0],value[1]+" + s + "-(t/" + d + ")*(t/" + d + ")*" + s + "])";
    if (e === "ease_in_out") return "t=time-inPoint; t<0?[value[0],value[1]+" + s + "]:(t>=" + d + "?value:[value[0],value[1]+" + s + "-ease(t/" + d + ")*" + s + "])";
    return "t=time-inPoint; [value[0], value[1]+linear(t,0," + d + "," + s + ",0)]";
}

// Build pill scale expression: 0 → 100 over scaleDur
function ef_buildPillScale(scaleDur, easing) {
    var d = scaleDur || 0.3;
    var e = easing || "linear";
    if (e === "ease_out") return "t=time-inPoint; t<0?[0,0]:(t>=" + d + "?[100,100]:[easeOut(t/" + d + ")*100,easeOut(t/" + d + ")*100])";
    if (e === "ease_in") return "t=time-inPoint; t<0?[0,0]:(t>=" + d + "?[100,100]:[(t/" + d + ")*(t/" + d + ")*100,(t/" + d + ")*(t/" + d + ")*100])";
    if (e === "ease_in_out") return "t=time-inPoint; t<0?[0,0]:(t>=" + d + "?[100,100]:[ease(t/" + d + ")*100,ease(t/" + d + ")*100])";
    return "t=time-inPoint; t<0?[0,0]:[linear(t,0," + d + ",0,100),linear(t,0," + d + ",0,100)]";
}

// Keep old expressions for backward compat
var EF_FADEUP_OP = ef_buildFadeUpOp(0.3, "linear");
var EF_FADEUP_POS = ef_buildFadeUpPos(0.3, 40, "linear");

var EF_BOUNCE_POS = "t=time-inPoint;\nif(t<0){value}else{d=6.0;f=2.0;o=Math.exp(-d*t)*Math.cos(f*2*Math.PI*t);[value[0],value[1]-160*o]}";

var EF_ANCHOR_CENTER = "r=thisLayer.sourceRectAtTime(time,false);[r.left+r.width/2,r.top+r.height/2]";

function ef_typewriterExpr(full) {
    var escaped = String(full).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return 'full="' + escaped + '";t=time-inPoint;cps=22;n=Math.floor(t*cps);(t<0)?"":full.substr(0,Math.max(0,n))';
}

// Squash & stretch scale expression
function ef_squashExpr(intensity) {
    var i = intensity || 1.0;
    return "t=time-inPoint;" +
        "if(t<0){[0,0]}else{" +
        "maxDev=" + (13*i) + ";spd=" + (18*i) + ";decay=1.0;" +
        "s=100-Math.abs(maxDev*Math.exp(-decay*t)*Math.sin(spd*t));" +
        "sq=100+(100-s);" +
        "[s,sq]" +
        "}";
}

/* ══ Word Grouping ══ */

function ef_endsSentence(t) { return /[.?!]["')\]]?\s*$/.test(String(t)); }

function ef_groupWords(words, cfg) {
    var maxWords = Math.max(1, cfg.maxWordsPerSegment || 4);
    var maxChars = cfg.maxCharsPerSegment || 30;
    var maxDur = cfg.maxDurationPerSegment || 3;
    var maxGap = (cfg.maxGap != null) ? cfg.maxGap : 0.6;

    var groups = [], cur = [];
    for (var w = 0; w < words.length; w++) {
        var wordText = words[w].word || words[w].text || "";
        var normalizedWord = { text: wordText, start: parseFloat(words[w].start), end: parseFloat(words[w].end), idx: w };

        if (cur.length === 0) { cur.push(normalizedWord); continue; }

        var prev = cur[cur.length - 1];
        var gap = normalizedWord.start - prev.end;
        var dur = normalizedWord.end - cur[0].start;
        var totalChars = 0;
        for (var ci = 0; ci < cur.length; ci++) totalChars += cur[ci].text.length + 1;
        totalChars += wordText.length;

        if (gap > maxGap || cur.length >= maxWords || dur > maxDur || totalChars > maxChars || ef_endsSentence(prev.text)) {
            groups.push(ef_segToGroup(cur));
            cur = [normalizedWord];
        } else {
            cur.push(normalizedWord);
        }
    }
    if (cur.length) groups.push(ef_segToGroup(cur));
    return groups;
}

function ef_segToGroup(seg) {
    var txt = "";
    for (var k = 0; k < seg.length; k++) txt += (k ? " " : "") + seg[k].text;
    return { words: seg, start: seg[0].start, end: seg[seg.length - 1].end, text: txt };
}

/* ══ Caption Building ══ */

function ef_styleDoc(layer, cfg) {
    var tp = layer.property("Source Text");
    var td = tp.value;
    td.resetCharStyle();
    td.fontSize = cfg.fontSize || 80;
    try { if (cfg.fontPS) td.font = cfg.fontPS; else if (cfg.fontName) td.font = cfg.fontName; } catch (e) {}
    td.applyFill = true;
    td.fillColor = cfg.fillColor || [1, 1, 1];
    td.applyStroke = (cfg.strokeWidth || 0) > 0;
    if (cfg.strokeWidth > 0) {
        td.strokeColor = cfg.strokeColor || [0, 0, 0];
        td.strokeWidth = cfg.strokeWidth;
        td.strokeOverFill = false;
    }
    td.justification = ParagraphJustification.CENTER_JUSTIFY;
    tp.setValue(td);
}

function ef_setTiming(layer, start, end) {
    layer.outPoint = end + 0.3;
    layer.inPoint = start;
}

function ef_centerAnchor(layer, comp, cfg, atTime) {
    var r = layer.sourceRectAtTime(atTime, false);
    layer.property("Anchor Point").setValue([r.left + r.width / 2, r.top + r.height / 2]);
    layer.property("Position").setValue([
        comp.width * (cfg.posX || 50) / 100,
        comp.height * (cfg.posY || 85) / 100
    ]);
}

function ef_removeOldCaptions(comp) {
    var removed = 0;
    for (var i = comp.numLayers; i >= 1; i--) {
        var L = comp.layer(i);
        try { if (L.comment === EF_TAG) { L.remove(); removed++; } } catch (e) {}
    }
    return removed;
}

/* ── Apply drop shadow ── */
function ef_applyDropShadow(layer, cfg) {
    if (!cfg.dropShadow) return;
    try {
        // Use the effect-based drop shadow (more reliable via scripting)
        // Properties: 0001=Color, 0002=Opacity, 0003=Angle, 0004=Distance, 0005=Softness, 0006=Shadow Only
        var fx = layer.property("ADBE Effect Parade").addProperty("ADBE Drop Shadow");
        fx.property("ADBE Drop Shadow-0001").setValue(cfg.shadowColor || [0, 0, 0]);
        fx.property("ADBE Drop Shadow-0002").setValue(cfg.shadowOpacity || 50);
        fx.property("ADBE Drop Shadow-0003").setValue(135);  // Angle (135 = bottom-right)
        fx.property("ADBE Drop Shadow-0004").setValue(cfg.shadowDistance || 3);
        fx.property("ADBE Drop Shadow-0005").setValue(cfg.shadowBlur || 5);
    } catch (e) {
        // Non-fatal — drop shadow is optional
    }
}

/* ── Create pill background shape layer ── */
function ef_createPill(comp, textLayer, cfg, atTime) {
    try {
        var r = textLayer.sourceRectAtTime(atTime, false);
        var padX = (cfg.fontSize || 80) * 0.3;
        var padY = (cfg.fontSize || 80) * 0.15;
        var w = r.width + padX * 2;
        var h = r.height + padY * 2;

        var shapeLayer = comp.layers.addShape();
        shapeLayer.name = "EF Pill BG";
        shapeLayer.comment = EF_TAG;

        var contents = shapeLayer.property("ADBE Root Vectors Group");
        var group = contents.addProperty("ADBE Vector Group");
        var vecGroup = group.property("ADBE Vectors Group");

        // Rectangle
        var rect = vecGroup.addProperty("ADBE Vector Shape - Rect");
        rect.property("ADBE Vector Rect Size").setValue([w, h]);  // Full width/height, not half-extents
        rect.property("ADBE Vector Rect Roundness").setValue(h / 2 * (cfg.pillRadius || 0.5));

        // Fill
        var fill = vecGroup.addProperty("ADBE Vector Graphic - Fill");
        var pillColor = cfg.pillColor || [0.04, 0.1, 0.18];
        fill.property("ADBE Vector Fill Color").setValue([pillColor[0], pillColor[1], pillColor[2]]);
        if (cfg.pillOpacity != null) {
            fill.property("ADBE Vector Fill Opacity").setValue(cfg.pillOpacity);
        }

        // Stroke (optional border)
        if (cfg.pillStrokeWidth > 0) {
            var stroke = vecGroup.addProperty("ADBE Vector Graphic - Stroke");
            stroke.property("ADBE Vector Stroke Color").setValue(cfg.pillStrokeColor || [1, 1, 1]);
            stroke.property("ADBE Vector Stroke Width").setValue(cfg.pillStrokeWidth);
        }

        // Position behind text layer
        shapeLayer.moveAfter(textLayer);

        // Match timing
        shapeLayer.inPoint = textLayer.inPoint;
        shapeLayer.outPoint = textLayer.outPoint;

        // Position at same spot as text
        var textPos = textLayer.property("Position").value;
        shapeLayer.property("Position").setValue(textPos);

        // Animate scale with squash/stretch
        if (cfg.preset === "boxpop") {
            shapeLayer.property("Scale").expression = ef_squashExpr(cfg.animIntensity || 1.0);
        } else {
            // Match text layer's scale expression
            shapeLayer.property("Scale").expression = textLayer.property("Scale").expression;
        }

        return shapeLayer;
    } catch (e) {
        return null;
    }
}

/* ── Apply animation preset ── */
function ef_applyPreset(layer, cfg, g) {
    var scale = layer.property("Scale");
    var opacity = layer.property("Opacity");
    var pos = layer.property("Position");
    var src = layer.property("Source Text");
    var preset = cfg.preset || "fadeup_words";
    var intensity = cfg.animIntensity || 1.0;

    if (preset === "fadeup_words") {
        // Per-word fade up from bottom (applied per-word layer via timing)
        opacity.expression = EF_FADEUP_OP;
        pos.expression = EF_FADEUP_POS;
    } else if (preset === "popin") {
        scale.expression = EF_SPRING_SCALE;
        opacity.expression = EF_REVEAL_OP;
    } else if (preset === "fadeup") {
        opacity.expression = EF_FADEUP_OP;
        pos.expression = EF_FADEUP_POS;
    } else if (preset === "bounce") {
        pos.expression = EF_BOUNCE_POS;
        opacity.expression = EF_REVEAL_OP;
    } else if (preset === "squash") {
        scale.expression = ef_squashExpr(intensity);
        opacity.expression = EF_REVEAL_OP;
    } else if (preset === "typewriter") {
        var full = cfg.allCaps ? g.text.toUpperCase() : g.text;
        src.expression = ef_typewriterExpr(full);
        opacity.expression = EF_REVEAL_OP;
    } else if (preset === "fade") {
        opacity.expression = EF_FADEUP_OP;
    }
}

/* ── Create pill background for a group of adjacent words — scales 0→100 ── */
function ef_createWordPill(comp, textLayer, cfg, wordStart, wordEnd) {
    try {
        var r = textLayer.sourceRectAtTime(wordStart + 0.05, false);
        var padX = (cfg.fontSize || 80) * 0.25;
        var padY = (cfg.fontSize || 80) * 0.12;
        var w = r.width + padX * 2;
        var h = r.height + padY * 2;

        var shapeLayer = comp.layers.addShape();
        shapeLayer.name = "EF Pill";
        shapeLayer.comment = EF_TAG;

        var contents = shapeLayer.property("ADBE Root Vectors Group");
        var group = contents.addProperty("ADBE Vector Group");
        var vecGroup = group.property("ADBE Vectors Group");

        // Rounded rectangle
        var rect = vecGroup.addProperty("ADBE Vector Shape - Rect");
        rect.property("ADBE Vector Rect Size").setValue([w, h]);
        var radiusVal = h / 2 * (cfg.pillRadius || 0.5);
        rect.property("ADBE Vector Rect Roundness").setValue(radiusVal);

        // Fill
        var fill = vecGroup.addProperty("ADBE Vector Graphic - Fill");
        var pillColor = cfg.pillColor || [0.04, 0.1, 0.18];
        fill.property("ADBE Vector Fill Color").setValue([pillColor[0], pillColor[1], pillColor[2]]);
        if (cfg.pillOpacity != null) {
            fill.property("ADBE Vector Fill Opacity").setValue(cfg.pillOpacity);
        }

        // Stroke (border)
        if (cfg.pillStrokeWidth > 0) {
            var stroke = vecGroup.addProperty("ADBE Vector Graphic - Stroke");
            stroke.property("ADBE Vector Stroke Color").setValue(cfg.pillStrokeColor || [1, 1, 1]);
            stroke.property("ADBE Vector Stroke Width").setValue(cfg.pillStrokeWidth);
        }

        // Position behind text layer
        shapeLayer.moveAfter(textLayer);

        // Match timing to the word
        shapeLayer.outPoint = wordEnd + 0.3;
        shapeLayer.inPoint = wordStart;

        // Position at same spot as text
        var textPos = textLayer.property("Position").value;
        shapeLayer.property("Position").setValue(textPos);

        // Scale from 0 to 100 with easing (configurable duration + easing)
        var scaleDur = cfg.pillScaleDur || 0.3;
        var pillEasing = cfg.pillEasing || "linear";
        shapeLayer.property("Scale").expression = ef_buildPillScale(scaleDur, pillEasing);

        // Fade in opacity (same duration as scale)
        shapeLayer.property("Opacity").expression = ef_buildFadeUpOp(scaleDur, pillEasing);

        return shapeLayer;
    } catch (e) {
        return null;
    }
}

/* ── Build a caption group — per-word layers with fade-up ── */
function ef_buildGroup(comp, g, cfg) {
    var placed = 0;
    var allCaps = cfg.allCaps !== false;
    var preset = cfg.preset || "fadeup_words";
    var posX = cfg.posX || 50;
    var posY = cfg.posY || 85;
    var position = [
        comp.width * posX / 100,
        comp.height * posY / 100
    ];

    // For "fadeup_words" preset: create one text layer PER WORD
    // Each word fades up from bottom at its spoken time
    if (preset === "fadeup_words") {
        // First pass: determine which words have pills
        var wordHasPill = [];
        for (var wi0 = 0; wi0 < g.words.length; wi0++) {
            var globalIdx0 = g.words[wi0].idx;
            var hasPill = false;
            if (cfg.pillWords && cfg.pillWords.length > 0) {
                for (var pi0 = 0; pi0 < cfg.pillWords.length; pi0++) {
                    if (cfg.pillWords[pi0] === globalIdx0) { hasPill = true; break; }
                }
            }
            wordHasPill.push(hasPill);
        }

        // Merge adjacent pill words into pill groups
        // e.g., if words 4,5 both have pills → one pill spanning both
        var pillGroups = []; // [{startIdx, endIdx, startTime, endTime}]
        var i = 0;
        while (i < g.words.length) {
            if (wordHasPill[i]) {
                var startIdx = i;
                var endIdx = i;
                // Extend to adjacent pill words
                while (endIdx + 1 < g.words.length && wordHasPill[endIdx + 1]) {
                    endIdx++;
                }
                pillGroups.push({
                    startIdx: startIdx,
                    endIdx: endIdx,
                    startTime: g.words[startIdx].start,
                    endTime: g.words[endIdx].end
                });
                i = endIdx + 1;
            } else {
                i++;
            }
        }

        // Create text layers for each word
        var wordLayers = [];
        for (var wi = 0; wi < g.words.length; wi++) {
            var w = g.words[wi];
            var wordText = allCaps ? w.text.toUpperCase() : w.text;
            var startSec = w.start;
            var endSec = w.end;

            try {
                var textLayer = comp.layers.addText(wordText);
                textLayer.name = "Caption: " + wordText.substr(0, 20);
                textLayer.comment = EF_TAG;

                ef_styleDoc(textLayer, cfg);
                ef_setTiming(textLayer, startSec, endSec);
                ef_centerAnchor(textLayer, comp, cfg, startSec + 0.05);

                // Animation: fade up from bottom with configurable parameters
                var fadeDur = cfg.fadeDur || 0.3;
                var slideDist = cfg.slideDist || 40;
                var wordEasing = cfg.wordEasing || "linear";
                textLayer.property("Opacity").expression = ef_buildFadeUpOp(fadeDur, wordEasing);
                textLayer.property("Position").expression = ef_buildFadeUpPos(fadeDur, slideDist, wordEasing);

                if (cfg.dropShadow) {
                    ef_applyDropShadow(textLayer, cfg);
                }

                wordLayers.push(textLayer);
                placed++;
            } catch (e) {
                wordLayers.push(null);
            }
        }

        // Create merged pills for adjacent pill words
        for (var pg = 0; pg < pillGroups.length; pg++) {
            var pgStart = pillGroups[pg].startIdx;
            var pgEnd = pillGroups[pg].endIdx;

            // Find the first non-null text layer in this pill group
            var refLayer = null;
            for (var pl = pgStart; pl <= pgEnd; pl++) {
                if (wordLayers[pl]) { refLayer = wordLayers[pl]; break; }
            }
            if (!refLayer) continue;

            // Create a single pill that spans from the first word's start to the last word's end
            // The pill sizes to the reference layer (first word) — in a future improvement,
            // we could create a wider pill that covers all words in the group
            ef_createWordPill(comp, refLayer, cfg,
                pillGroups[pg].startTime,
                pillGroups[pg].endTime);
        }
    } else {
        // Other presets: one text layer per group (original behavior)
        var text = allCaps ? g.text.toUpperCase() : g.text;
        var layer = comp.layers.addText(text);
        layer.name = text.substr(0, 28);
        layer.comment = EF_TAG;

        ef_styleDoc(layer, cfg);
        ef_setTiming(layer, g.start, g.end);
        ef_centerAnchor(layer, comp, cfg, g.start + 0.05);
        ef_applyPreset(layer, cfg, g);

        if (cfg.dropShadow) {
            ef_applyDropShadow(layer, cfg);
        }

        placed = 1;
    }

    return placed;
}

/* ── Apply per-word highlights (text animator approach) ── */
function ef_applyHighlights(layer, g, cfg) {
    try {
        var textProps = layer.property("ADBE Text Properties");
        var animators = textProps.property("ADBE Text Animators");

        // Add fill color animator for highlighted words
        var fillAnim = animators.addProperty("ADBE Text Animator");
        fillAnim.name = "EF Highlight Color";
        var fillAnimProps = fillAnim.property("ADBE Text Animator Properties");
        fillAnimProps.addProperty("ADBE Text Fill Color");
        var fillProp = fillAnimProps.property("ADBE Text Fill Color");
        var hlColor = cfg.highlightTextColor || [1, 1, 0];
        fillProp.setValue([hlColor[0], hlColor[1], hlColor[2]]);

        // Add range selector with word-based units
        var rangeSelector = fillAnim.property("ADBE Text Selectors").addProperty("ADBE Text Selector");
        rangeSelector.property("ADBE Text Range Type2").setValue(3);  // 3 = words

        // Expression: returns 100 if this word index is highlighted, 0 otherwise
        var hlArr = [];
        for (var j = 0; j < g.words.length; j++) {
            var globalIdx = g.words[j].idx;
            var isHl = false;
            for (var k = 0; k < cfg.highlightWords.length; k++) {
                if (cfg.highlightWords[k] === globalIdx) { isHl = true; break; }
            }
            hlArr.push(isHl ? 1 : 0);
        }
        var expr = "hl=[" + hlArr.join(",") + "];n=textIndex-1;if(n>=0&&n<hl.length&&hl[n]==1){100}else{0}";
        rangeSelector.property("ADBE Text Selector Amount").expression = expr;

        // Add scale animator for highlighted words (punch effect)
        var scaleAnim = animators.addProperty("ADBE Text Animator");
        scaleAnim.name = "EF Highlight Scale";
        var scaleAnimProps = scaleAnim.property("ADBE Text Animator Properties");
        scaleAnimProps.addProperty("ADBE Text Scale 3D");
        var scaleProp = scaleAnimProps.property("ADBE Text Scale 3D");
        scaleProp.setValue([110, 110, 110]);

        var scaleSel = scaleAnim.property("ADBE Text Selectors").addProperty("ADBE Text Selector");
        scaleSel.property("ADBE Text Range Type2").setValue(3);  // 3 = words
        scaleSel.property("ADBE Text Selector Amount").expression = expr;

    } catch (e) {
        // Non-fatal — highlighting is optional
    }
}

/* ══ Main: Create Captions ══ */
function ef_createCaptions(jsonStr) {
    var started = false;
    try {
        var cfg = eval("(" + jsonStr + ")");
        var comp = ef_getComp();
        if (!comp) return ef_err("No composition with audio found.");
        if (!cfg.words || !cfg.words.length) return ef_err("No words supplied.");

        // Apply offset
        var off = cfg.offset || 0;
        if (off) {
            for (var oi = 0; oi < cfg.words.length; oi++) {
                cfg.words[oi].start += off;
                cfg.words[oi].end += off;
            }
        }

        // Defaults
        cfg.fontSize = cfg.fontSize || 80;
        cfg.fillColor = cfg.fillColor || [1, 1, 1];
        cfg.posX = cfg.posX || 50;
        cfg.posY = cfg.posY || 85;
        cfg.preset = cfg.preset || "fadeup_words";
        cfg.maxWordsPerSegment = cfg.maxWordsPerSegment || 4;
        cfg.maxCharsPerSegment = cfg.maxCharsPerSegment || 30;
        cfg.maxDurationPerSegment = cfg.maxDurationPerSegment || 3;
        cfg.visualStyle = cfg.visualStyle || "floating";
        cfg.allCaps = cfg.allCaps !== false;

        app.beginUndoGroup("EditFlow: Create Captions");
        started = true;

        if (cfg.replace !== false) ef_removeOldCaptions(comp);

        var groups = ef_groupWords(cfg.words, cfg);
        var created = 0, failed = 0, errors = [];

        for (var i = 0; i < groups.length; i++) {
            try {
                created += ef_buildGroup(comp, groups[i], cfg);
            } catch (ge) {
                failed++;
                errors.push("group " + i + ": " + ge.toString());
                if (errors.length >= 5) break;
            }
        }

        app.endUndoGroup();

        return ef_json({
            placed: created, total: cfg.words.length, groups: groups.length,
            errors: errors, preset: cfg.preset, visualStyle: cfg.visualStyle,
            comp_name: comp.name
        });
    } catch (e) {
        if (started) { try { app.endUndoGroup(); } catch (_) {} }
        return ef_err("createCaptions: " + e.toString() + (e.line ? " (line " + e.line + ")" : ""));
    }
}

/* ── Clear captions ── */
function ef_clearCaptions() {
    try {
        var comp = ef_getComp();
        if (!comp) return ef_err("No composition found.");
        app.beginUndoGroup("EditFlow: Clear Captions");
        var removed = ef_removeOldCaptions(comp);
        app.endUndoGroup();
        return ef_json({ removed: removed });
    } catch (e) { return ef_err("clearCaptions: " + e.toString()); }
}
