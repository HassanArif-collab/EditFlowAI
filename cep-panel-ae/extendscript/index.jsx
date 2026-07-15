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
var EF_PREVIEW_TAG = "EF_CAPTION_PREVIEW";
var EF_ACTIVE_TAG = EF_TAG;   // set per run in ef_createCaptions (real vs preview)

/* ── Helpers ── */

function ef_err(msg) { return "ERROR:" + String(msg); }

/* ES3-safe recursive JSON serializer. After Effects ExtendScript has NO native
   JSON object, and several ef_* functions return arrays-of-objects (fonts,
   audio inventory, error lists) that the old flat fallback could not encode —
   it returned {"error":"json_failed"}, which the client surfaced as the
   "JSON error" on timeline transcription. This encoder recurses and avoids
   ES5-only APIs (no Array.isArray). Inbound configs are parsed via eval(). */
function ef_escStr(s) {
    s = String(s);
    var out = "", i, c, code;
    for (i = 0; i < s.length; i++) {
        c = s.charAt(i); code = s.charCodeAt(i);
        if (c === '"') out += '\\"';
        else if (c === "\\") out += "\\\\";
        else if (c === "\n") out += "\\n";
        else if (c === "\r") out += "\\r";
        else if (c === "\t") out += "\\t";
        else if (code < 32) out += "\\u" + ("0000" + code.toString(16)).slice(-4);
        else out += c;
    }
    return out;
}
function ef_isArray(v) { return Object.prototype.toString.call(v) === "[object Array]"; }
function ef_json(v) {
    if (v === null || v === undefined) return "null";
    var t = typeof v, i, k, parts;
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "string") return '"' + ef_escStr(v) + '"';
    if (t === "object") {
        if (ef_isArray(v)) {
            parts = [];
            for (i = 0; i < v.length; i++) parts.push(ef_json(v[i]));
            return "[" + parts.join(",") + "]";
        }
        parts = [];
        for (k in v) {
            if (v.hasOwnProperty(k)) {
                if (typeof v[k] === "function" || v[k] === undefined) continue;
                parts.push('"' + ef_escStr(k) + '":' + ef_json(v[k]));
            }
        }
        return "{" + parts.join(",") + "}";
    }
    return "null";
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
// Uses AE's built-in linear()/ease()/easeIn()/easeOut() with CORRECT 5-arg syntax
function ef_buildFadeUpOp(fadeDur, easing) {
    var d = fadeDur || 0.3;
    var e = easing || "linear";
    if (e === "ease_out") return "t=time-inPoint; t<0?0:(t>=" + d + "?100:easeOut(t,0," + d + ",0,100))";
    if (e === "ease_in") return "t=time-inPoint; t<0?0:(t>=" + d + "?100:easeIn(t,0," + d + ",0,100))";
    if (e === "ease_in_out") return "t=time-inPoint; t<0?0:(t>=" + d + "?100:ease(t,0," + d + ",0,100))";
    return "t=time-inPoint; linear(t,0," + d + ",0,100)";
}

function ef_buildFadeUpPos(fadeDur, slideDist, easing) {
    var d = fadeDur || 0.3;
    var s = slideDist || 40;
    var e = easing || "linear";
    if (e === "ease_out") return "t=time-inPoint; t<0?[value[0],value[1]+" + s + "]:(t>=" + d + "?value:[value[0],value[1]+" + s + "-easeOut(t,0," + d + ",0," + s + ")])";
    if (e === "ease_in") return "t=time-inPoint; t<0?[value[0],value[1]+" + s + "]:(t>=" + d + "?value:[value[0],value[1]+" + s + "-easeIn(t,0," + d + ",0," + s + ")])";
    if (e === "ease_in_out") return "t=time-inPoint; t<0?[value[0],value[1]+" + s + "]:(t>=" + d + "?value:[value[0],value[1]+" + s + "-ease(t,0," + d + ",0," + s + ")])";
    return "t=time-inPoint; [value[0], value[1]+linear(t,0," + d + "," + s + ",0)]";
}

// Build pill scale expression: 0 → 100 over scaleDur
function ef_buildPillScale(scaleDur, easing) {
    var d = scaleDur || 0.3;
    var e = easing || "linear";
    if (e === "ease_out") return "t=time-inPoint; t<0?[0,0]:(t>=" + d + "?[100,100]:[easeOut(t,0," + d + ",0,100),easeOut(t,0," + d + ",0,100)])";
    if (e === "ease_in") return "t=time-inPoint; t<0?[0,0]:(t>=" + d + "?[100,100]:[easeIn(t,0," + d + ",0,100),easeIn(t,0," + d + ",0,100)])";
    if (e === "ease_in_out") return "t=time-inPoint; t<0?[0,0]:(t>=" + d + "?[100,100]:[ease(t,0," + d + ",0,100),ease(t,0," + d + ",0,100)])";
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

// Per-word-layer entrance expressions. Word layers live for the whole group
// (to avoid flicker), so the entrance is keyed to the word's OWN spoken start
// time (ws), not the layer inPoint. Returns opacity 0→100 over fadeDur.
// Manual easing (no AE ease() call) for ES3 safety.
function ef_wordFadeUpOpExpr(ws, fadeDur, easing) {
    var ws3 = Math.round(ws * 1000) / 1000;
    var d = fadeDur || 0.3;
    var e = easing || "linear";
    var easeBody;
    if (e === "ease_out") easeBody = "var ev=1-Math.pow(1-p,3);";
    else if (e === "ease_in") easeBody = "var ev=p*p*p;";
    else if (e === "ease_in_out") easeBody = "var ev=(p<0.5)?4*p*p*p:1-Math.pow(-2*p+2,3)/2;";
    else easeBody = "var ev=p;";
    return "var t=time-" + ws3 + ";var p=t/" + d + ";if(p<0)p=0;if(p>1)p=1;" +
        easeBody + "ev*100;";
}
// Per-word-layer position: starts slideDist below, settles to centerY at ws+fadeDur.
// Bakes centerY so the expression is self-contained (not relative to value).
function ef_wordFadeUpPosExpr(ws, fadeDur, slideDist, easing, centerY) {
    var ws3 = Math.round(ws * 1000) / 1000;
    var d = fadeDur || 0.3;
    var s = slideDist || 40;
    var e = easing || "linear";
    var cy = Math.round(centerY * 1000) / 1000;
    var easeBody;
    if (e === "ease_out") easeBody = "var ev=1-Math.pow(1-p,3);";
    else if (e === "ease_in") easeBody = "var ev=p*p*p;";
    else if (e === "ease_in_out") easeBody = "var ev=(p<0.5)?4*p*p*p:1-Math.pow(-2*p+2,3)/2;";
    else easeBody = "var ev=p;";
    return "var t=time-" + ws3 + ";var p=t/" + d + ";if(p<0)p=0;if(p>1)p=1;" +
        easeBody + "[value[0]," + cy + "+(1-ev)*" + s + "];";
}

/* ══ Word Grouping ══ */

function ef_endsSentence(t) { return /[.?!]["')\]]?\s*$/.test(String(t)); }

function ef_groupWords(words, cfg) {
    var maxWords = Math.max(1, cfg.maxWordsPerSegment || 4);
    var maxChars = cfg.maxCharsPerSegment || 30;
    var maxDur = cfg.maxDurationPerSegment || 3;
    var maxGap = (cfg.maxGap != null) ? cfg.maxGap : 0.5;   // balanced: breaks real pauses, avoids false per-word splits

    var groups = [], cur = [];
    for (var w = 0; w < words.length; w++) {
        var wordText = words[w].word || words[w].text || "";
        var normalizedWord = { text: wordText, start: parseFloat(words[w].start), end: parseFloat(words[w].end), idx: w, pill: !!words[w].pill };

        if (cur.length === 0) { cur.push(normalizedWord); continue; }

        var prev = cur[cur.length - 1];
        var gap = normalizedWord.start - prev.end;
        var dur = normalizedWord.end - cur[0].start;
        var totalChars = 0;
        for (var ci = 0; ci < cur.length; ci++) totalChars += cur[ci].text.length + 1;
        totalChars += wordText.length;

        var prevEnds = ef_endsSentence(prev.text);
        var currEnds = ef_endsSentence(wordText);

        if (gap > maxGap || cur.length >= maxWords || dur > maxDur || totalChars > maxChars || prevEnds || currEnds) {
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
    // Set font — try fontPS (PostScript name), then fontName. Log if fails.
    if (cfg.fontPS) {
        try { td.font = cfg.fontPS; } catch (e) {
            // Font not found — try fontName as fallback
            if (cfg.fontName) { try { td.font = cfg.fontName; } catch (e2) {} }
        }
    } else if (cfg.fontName) {
        try { td.font = cfg.fontName; } catch (e) {}
    }
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
    layer.inPoint = start;      // inPoint first, then outPoint
    layer.outPoint = end + 0.3;
}

/* Like ef_setTiming, but never lets a caption linger into the NEXT caption's
   start — fixes consecutive sentences showing on top of each other.
   Enforces a fixed 50ms minimum gap so captions never visually overlap. */
function ef_setTimingCapped(layer, start, end, nextStart) {
    var out = end + 0.3;
    if (nextStart != null) {
        var capOut = nextStart - 0.05;  // 50ms hard gap
        if (capOut < out) out = capOut;
    }
    if (out <= start) out = start + 0.1;
    layer.inPoint = start;   // MUST set inPoint first, then outPoint;
    layer.outPoint = out;    // otherwise AE preserves old duration and shifts outPoint.
}

function ef_centerAnchor(layer, comp, cfg, atTime) {
    var r = layer.sourceRectAtTime(atTime, false);
    layer.property("Anchor Point").setValue([r.left + r.width / 2, r.top + r.height / 2]);
    layer.property("Position").setValue([
        comp.width * (cfg.posX || 50) / 100,
        comp.height * (cfg.posY || 85) / 100
    ]);
}

function ef_removeOldCaptions(comp, tag) {
    tag = tag || EF_TAG;
    var removed = 0;
    for (var i = comp.numLayers; i >= 1; i--) {
        var L = comp.layer(i);
        try { if (L.comment === tag) { L.remove(); removed++; } } catch (e) {}
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
        shapeLayer.comment = EF_ACTIVE_TAG;

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
        shapeLayer.inPoint = wordStart;      // inPoint first, then outPoint
        shapeLayer.outPoint = wordEnd + 0.3;

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

/* ── ONE text layer for the whole sentence. The full caption appears at once
   with a fade-in (no word-by-word HOLD keyframes, which caused word-shifting
   as the dynamic anchor recalculated for each new text length). ── */
function ef_buildSingleReveal(comp, g, cfg, nextStart) {
    var allCaps = cfg.allCaps !== false;
    var fullText = allCaps ? String(g.text).toUpperCase() : g.text;
    var layer = comp.layers.addText(fullText);
    layer.name = "Caption: " + String(fullText).substr(0, 24);
    layer.comment = EF_ACTIVE_TAG;
    ef_styleDoc(layer, cfg);

    // Measure full text and set STATIC anchor (prevents word-shifting)
    var measureAt = g.start + 0.05;
    var r = layer.sourceRectAtTime(measureAt, false);
    layer.property("Anchor Point").setValue([r.left + r.width / 2, r.top + r.height / 2]);
    layer.property("Position").setValue([
        comp.width * (cfg.posX || 50) / 100,
        comp.height * (cfg.posY || 85) / 100
    ]);

    // Whole-layer entrance (fade + slight rise) using the proven expressions.
    try {
        var fadeDur = cfg.fadeDur || 0.3;
        var easing = cfg.wordEasing || "linear";
        layer.property("Opacity").expression = ef_buildFadeUpOp(fadeDur, easing);
        if ((cfg.slideDist || 0) > 0) {
            layer.property("Position").expression = ef_buildFadeUpPos(fadeDur, cfg.slideDist, easing);
        }
    } catch (eE) {}

    ef_setTimingCapped(layer, g.start, g.end, nextStart);
    if (cfg.dropShadow) ef_applyDropShadow(layer, cfg);
    return 1;
}

/* ── Build a caption group — per-word layers with fade-up ── */
function ef_buildGroup(comp, g, cfg, nextStart) {
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
        // No pills → ONE text layer for the whole sentence with a word-by-word
        // reveal (the requested "one sentence = one layer"). Pill captions still
        // use per-word layers below, because each pill wraps specific words.
        var anyPillWord = false;
        for (var apw = 0; apw < g.words.length; apw++) if (g.words[apw].pill) { anyPillWord = true; break; }
        if (!anyPillWord) { return ef_buildSingleReveal(comp, g, cfg, nextStart); }

        // First pass: determine which words have pills
        var wordHasPill = [];
        for (var wi0 = 0; wi0 < g.words.length; wi0++) {
            wordHasPill.push(!!g.words[wi0].pill);
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

        // Phase 1: Create text layers for each word (NO positioning yet —
        // we measure first, then lay out horizontally like TikTalk buildKaraoke).
        // All word layers live for the WHOLE GROUP duration so earlier words
        // don't vanish mid-caption (fixes flicker). Per-word reveal is driven
        // by the opacity expression keyed to each word's own start time.
        var fadeDur = cfg.fadeDur || 0.3;
        var slideDist = cfg.slideDist || 40;
        var wordEasing = cfg.wordEasing || "linear";
        var wordLayers = [];
        for (var wi = 0; wi < g.words.length; wi++) {
            var w = g.words[wi];
            var wordText = allCaps ? w.text.toUpperCase() : w.text;

            try {
                var textLayer = comp.layers.addText(wordText);
                textLayer.name = "Caption: " + wordText.substr(0, 20);
                textLayer.comment = EF_ACTIVE_TAG;

                ef_styleDoc(textLayer, cfg);
                // Whole-group lifetime (not per-word) — prevents flicker.
                ef_setTimingCapped(textLayer, g.start, g.end, nextStart);

                if (cfg.dropShadow) {
                    ef_applyDropShadow(textLayer, cfg);
                }

                wordLayers.push(textLayer);
                placed++;
            } catch (e) {
                wordLayers.push(null);
            }
        }

        // Phase 2: Measure each word + lay out horizontally, centered on posX.
        // This is the fix for "overlapping" — previously ef_centerAnchor put
        // every word at the same point. Now we measure + accumulate X like
        // TikTalk's buildKaraoke (host.jsx:319-355).
        var measureAt = g.start + 0.05;
        var n = g.words.length;
        var rects = [], widths = [], totalW = 0;
        var space = (cfg.fontSize || 80) * 0.32;   // inter-word gap
        for (var mi = 0; mi < n; mi++) {
            if (!wordLayers[mi]) { rects.push(null); widths.push(0); continue; }
            var r = wordLayers[mi].sourceRectAtTime(measureAt, false);
            rects.push(r); widths.push(r.width); totalW += r.width;
        }
        totalW += space * Math.max(0, n - 1);

        var accX = (comp.width * posX / 100) - totalW / 2;
        var centerY = comp.height * posY / 100;
        var wordCenters = [];  // store per-word X edges for pill sizing
        for (var li = 0; li < n; li++) {
            var L = wordLayers[li];
            if (!L || !rects[li]) { wordCenters.push(null); accX += widths[li] + space; continue; }
            var rr = rects[li];
            // Center each word's anchor on its own glyph box, then place
            // at the accumulated X cursor + the group's Y.
            L.property("Anchor Point").setValue([rr.left + rr.width / 2, rr.top + rr.height / 2]);
            L.property("Position").setValue([accX + widths[li] / 2, centerY]);
            wordCenters.push({ left: accX, right: accX + widths[li], height: rr.height });
            // Per-word entrance keyed to THIS word's spoken start time.
            var ws = g.words[li].start;
            L.property("Opacity").expression = ef_wordFadeUpOpExpr(ws, fadeDur, wordEasing);
            L.property("Position").expression = ef_wordFadeUpPosExpr(ws, fadeDur, slideDist, wordEasing, centerY);
            accX += widths[li] + space;
        }

        // Create merged pills for adjacent pill words — sized to span ALL
        // words in the group (not just the first word's width).
        for (var pg = 0; pg < pillGroups.length; pg++) {
            var pgStart = pillGroups[pg].startIdx;
            var pgEnd = pillGroups[pg].endIdx;
            // Compute pill width from layout data
            var pillLeft = Infinity, pillRight = -Infinity, pillH = 0;
            for (var pi = pgStart; pi <= pgEnd; pi++) {
                if (wordCenters[pi]) {
                    if (wordCenters[pi].left < pillLeft) pillLeft = wordCenters[pi].left;
                    if (wordCenters[pi].right > pillRight) pillRight = wordCenters[pi].right;
                    if (wordCenters[pi].height > pillH) pillH = wordCenters[pi].height;
                }
            }
            if (pillLeft >= pillRight) continue;
            var padX = (cfg.fontSize || 80) * 0.28, padY = (cfg.fontSize || 80) * 0.16;
            var pw = (pillRight - pillLeft) + padX * 2;
            var ph = pillH + padY * 2;
            var pcx = (pillLeft + pillRight) / 2;
            var pillStart = g.words[pgStart].start;
            try {
                var shape = comp.layers.addShape();
                shape.name = "EF Pill";
                shape.comment = EF_ACTIVE_TAG;
                var vec = shape.property("ADBE Root Vectors Group")
                    .addProperty("ADBE Vector Group").property("ADBE Vectors Group");
                var rect = vec.addProperty("ADBE Vector Shape - Rect");
                rect.property("ADBE Vector Rect Size").setValue([pw, ph]);
                rect.property("ADBE Vector Rect Roundness").setValue(ph / 2 * (cfg.pillRadius || 0.5));
                var fill = vec.addProperty("ADBE Vector Graphic - Fill");
                var pc = cfg.pillColor || [0.04, 0.1, 0.18];
                fill.property("ADBE Vector Fill Color").setValue([pc[0], pc[1], pc[2]]);
                if (cfg.pillOpacity != null) fill.property("ADBE Vector Fill Opacity").setValue(cfg.pillOpacity);
                if ((cfg.pillStrokeWidth || 0) > 0) {
                    var stroke = vec.addProperty("ADBE Vector Graphic - Stroke");
                    stroke.property("ADBE Vector Stroke Color").setValue(cfg.pillStrokeColor || [1, 1, 1]);
                    stroke.property("ADBE Vector Stroke Width").setValue(cfg.pillStrokeWidth);
                }
                shape.property("Position").setValue([pcx, centerY]);
                ef_setTimingCapped(shape, g.start, g.end, nextStart);
                shape.property("Scale").expression = ef_buildPillScale(cfg.pillScaleDur || 0.3, cfg.pillEasing || "linear");
                shape.property("Opacity").expression = ef_buildFadeUpOp(cfg.pillScaleDur || 0.3, cfg.pillEasing || "linear");
                // Move behind ALL word layers (wordLayers[0] is deepest)
                shape.moveAfter(wordLayers[0]);
                placed++;
            } catch (ePill) {}
        }
    } else {
        // Other presets: one text layer per group (original behavior)
        var text = allCaps ? g.text.toUpperCase() : g.text;
        var layer = comp.layers.addText(text);
        layer.name = text.substr(0, 28);
        layer.comment = EF_ACTIVE_TAG;

        ef_styleDoc(layer, cfg);
        ef_setTimingCapped(layer, g.start, g.end, nextStart);
        ef_centerAnchor(layer, comp, cfg, g.start + 0.05);
        ef_applyPreset(layer, cfg, g);

        if (cfg.dropShadow) {
            ef_applyDropShadow(layer, cfg);
        }

        placed = 1;
    }

    return placed;
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
            if (cfg.nextBatchStart != null) cfg.nextBatchStart += off;
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
        // Tighter gap default (0.35s) — forces sentence breaks on real pauses,
        // avoids fusing sentences that then overlap in time.
        cfg.maxGap = cfg.maxGap != null ? cfg.maxGap : 0.35;
        cfg.visualStyle = cfg.visualStyle || "floating";
        cfg.allCaps = cfg.allCaps !== false;

        // Preview runs tag their layers separately and must NEVER delete the
        // user's real captions — that was the "Preview button wiped my captions"
        // bug. Real runs replace real captions; both clear any stale preview.
        EF_ACTIVE_TAG = cfg.previewOnly ? EF_PREVIEW_TAG : EF_TAG;
        app.beginUndoGroup(cfg.previewOnly ? "EditFlow: Caption Preview" : "EditFlow: Create Captions");
        started = true;

        ef_removeOldCaptions(comp, EF_PREVIEW_TAG);
        if (!cfg.previewOnly && cfg.replace !== false) ef_removeOldCaptions(comp, EF_TAG);

        var groups = ef_groupWords(cfg.words, cfg);
        var created = 0, failed = 0, errors = [];

        for (var i = 0; i < groups.length; i++) {
            try {
                var nextStart = (i + 1 < groups.length) ? groups[i + 1].start
                                : (cfg.nextBatchStart != null ? cfg.nextBatchStart : null);
                created += ef_buildGroup(comp, groups[i], cfg, nextStart);
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
        var removed = ef_removeOldCaptions(comp, EF_TAG) + ef_removeOldCaptions(comp, EF_PREVIEW_TAG);
        app.endUndoGroup();
        return ef_json({ removed: removed });
    } catch (e) { return ef_err("clearCaptions: " + e.toString()); }
}

/* ── Remove only the temporary preview layers ── */
function ef_removePreview() {
    try {
        var comp = ef_getComp();
        if (!comp) return ef_err("No composition found.");
        app.beginUndoGroup("EditFlow: Remove Preview");
        var removed = ef_removeOldCaptions(comp, EF_PREVIEW_TAG);
        app.endUndoGroup();
        return ef_json({ removed: removed });
    } catch (e) { return ef_err("removePreview: " + e.toString()); }
}
