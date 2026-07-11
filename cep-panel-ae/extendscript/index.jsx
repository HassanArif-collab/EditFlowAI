/**********************************************************************
 * EditFlow AI AE - ExtendScript host (v3)
 *
 * Rewritten based on deep analysis of TikTalk + AutoCaption patterns.
 * Fixes all 7 bugs identified in the research report:
 *   1. Top-level function declarations (no IIFEs)
 *   2. Correct timing: outPoint BEFORE inPoint
 *   3. Anchor + Position set together via sourceRectAtTime
 *   4. td.resetCharStyle() before styling
 *   5. layer.comment for cleanup (not layer.name)
 *   6. Word grouping: 3-4 words per caption (not 1 per word)
 *   7. Expression-based animation (not per-layer keyframes)
 *
 * Functions exposed to the panel:
 *   ef_ping()               → "pong"
 *   ef_getCompInfo()        → JSON or "ERROR:..."
 *   ef_getAudioPath()       → JSON or "ERROR:..."
 *   ef_createCaptions(json) → JSON or "ERROR:..."
 *   ef_clearCaptions()      → JSON or "ERROR:..."
 *********************************************************************/

var EF_TAG = "EF_CAPTION";

/* ── Helpers ── */

function ef_err(msg) {
    return "ERROR:" + String(msg);
}

function ef_json(obj) {
    // TikTalk pattern: manual JSON stringify (more reliable than JSON.stringify in ES3)
    try {
        if (typeof JSON !== "undefined" && JSON.stringify) {
            return JSON.stringify(obj);
        }
    } catch (e) {}
    // Fallback: simple manual stringify for basic objects
    try {
        var parts = [];
        for (var k in obj) {
            if (obj.hasOwnProperty(k)) {
                var v = obj[k];
                var valStr;
                if (v === null) valStr = "null";
                else if (typeof v === "string") valStr = '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
                else if (typeof v === "number" || typeof v === "boolean") valStr = String(v);
                else if (Array.isArray(v)) valStr = "[]"; // simplified
                else valStr = "{}";
                parts.push('"' + k + '":' + valStr);
            }
        }
        return "{" + parts.join(",") + "}";
    } catch (e2) {
        return '{"error":"json_failed"}';
    }
}

/* Get the active comp or any comp with audio */
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

        return ef_json({
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

        // First: try selected layers (TikTalk pattern)
        if (comp.selectedLayers && comp.selectedLayers.length > 0) {
            var sel = comp.selectedLayers[0];
            try {
                if (sel.source && sel.source instanceof FootageItem &&
                    sel.source.mainSource && sel.source.mainSource.file) {
                    return ef_json({ path: sel.source.mainSource.file.fsName, offset: sel.startTime });
                }
            } catch (e) {}
        }

        // Fallback: any audio layer with a file
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            try {
                if (layer.hasAudio && layer.source) {
                    if (layer.source.mainSource && layer.source.mainSource.file) {
                        return ef_json({ path: layer.source.mainSource.file.fsName, offset: layer.startTime });
                    }
                    if (layer.source.file) {
                        return ef_json({ path: layer.source.file.fsName, offset: layer.startTime });
                    }
                }
            } catch (e) {}
        }
        return ef_err("No audio layer with a file found. Select an audio layer or import an audio file.");
    } catch (e) {
        return ef_err("getAudioPath: " + e.toString());
    }
}

/* ── Expression library (from TikTalk) ── */

// Spring scale: 0 → 100 with overshoot (pop-in effect)
var EF_SPRING_SCALE =
    "f=3.0; d=6.0; t=time-inPoint;\n" +
    "if (t<0){ [0,0] } else { s=100-100*Math.exp(-d*t)*Math.cos(f*2*Math.PI*t); [s,s]; }";

// Reveal opacity: 0 → 100 over 0.1s
var EF_REVEAL_OP = "t=time-inPoint; linear(t,0,0.1,0,100)";

// Bounce position
var EF_BOUNCE_POS =
    "t=time-inPoint;\n" +
    "if (t<0){ value } else {\n" +
    "  d=6.0; f=2.0; o=Math.exp(-d*t)*Math.cos(f*2*Math.PI*t);\n" +
    "  [value[0], value[1]-160*o];\n}";

// Anchor center expression (auto-centers to text bounds)
var EF_ANCHOR_CENTER =
    "r = thisLayer.sourceRectAtTime(time, false);\n" +
    "[r.left + r.width/2, r.top + r.height/2]";

// Fade in: opacity 0 → 100
var EF_FADE_OP = "t=time-inPoint; linear(t,0,0.2,0,100)";

// Typewriter expression
function ef_typewriterExpr(full) {
    var escaped = String(full).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return 'full="' + escaped + '"; t=time-inPoint; cps=22; n=Math.floor(t*cps);\n' +
        '(t<0)?"":full.substr(0,Math.max(0,n));';
}

/* ── Style a text layer ── */
function ef_styleDoc(layer, cfg) {
    var tp = layer.property("Source Text");
    var td = tp.value;
    td.resetCharStyle();  // CRITICAL: reset before styling
    td.fontSize = cfg.fontSize || 80;
    try { if (cfg.fontName) td.font = cfg.fontName; } catch (e) {}
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

/* ── Set timing: outPoint BEFORE inPoint (TikTalk pattern) ── */
function ef_setTiming(layer, start, end) {
    var tail = 0.3;
    // Set outPoint first so inPoint never temporarily exceeds it
    layer.outPoint = end + tail;
    layer.inPoint = start;
}

/* ── Center anchor + position (TikTalk pattern) ── */
function ef_centerAnchor(layer, comp, cfg, atTime) {
    var r = layer.sourceRectAtTime(atTime, false);
    layer.property("Anchor Point").setValue([r.left + r.width / 2, r.top + r.height / 2]);
    layer.property("Position").setValue([
        comp.width * (cfg.posX || 50) / 100,
        comp.height * (cfg.posY || 85) / 100
    ]);
    return r;
}

/* ── Remove old caption layers (backward iteration, TikTalk pattern) ── */
function ef_removeOldCaptions(comp) {
    var removed = 0;
    for (var i = comp.numLayers; i >= 1; i--) {
        var L = comp.layer(i);
        try { if (L.comment === EF_TAG) { L.remove(); removed++; } } catch (e) {}
    }
    return removed;
}

/* ── Group words into captions (TikTalk pattern) ── */
function ef_endsSentence(t) { return /[.?!]["')\]]?\s*$/.test(String(t)); }

function ef_segToGroup(seg) {
    var txt = "";
    for (var k = 0; k < seg.length; k++) txt += (k ? " " : "") + seg[k].text;
    return { words: seg, start: seg[0].start, end: seg[seg.length - 1].end, text: txt };
}

function ef_groupWords(words, cfg) {
    var maxWords = Math.max(1, cfg.wordsPerLine || 4);
    var maxGap = (cfg.maxGap != null) ? cfg.maxGap : 0.6;
    var maxDur = (cfg.maxDur != null) ? cfg.maxDur : 5;

    var groups = [], cur = [];
    for (var w = 0; w < words.length; w++) {
        var word = words[w];
        // Normalize: accept both {word: "..."} and {text: "..."}
        var wordText = word.word || word.text || "";
        var normalizedWord = { text: wordText, start: parseFloat(word.start), end: parseFloat(word.end) };

        if (cur.length === 0) { cur.push(normalizedWord); continue; }

        var prev = cur[cur.length - 1];
        var gap = normalizedWord.start - prev.end;
        var dur = normalizedWord.end - cur[0].start;

        if (gap > maxGap || cur.length >= maxWords || dur > maxDur || ef_endsSentence(prev.text)) {
            groups.push(ef_segToGroup(cur));
            cur = [normalizedWord];
        } else {
            cur.push(normalizedWord);
        }
    }
    if (cur.length) groups.push(ef_segToGroup(cur));
    return groups;
}

/* ── Apply animation preset (expression-based, TikTalk pattern) ── */
function ef_applyPreset(layer, cfg, g) {
    var scale = layer.property("Scale");
    var opacity = layer.property("Opacity");
    var pos = layer.property("Position");
    var src = layer.property("Source Text");

    var preset = cfg.preset || "popin";

    if (preset === "popin" || preset === "pop") {
        scale.expression = EF_SPRING_SCALE;
        opacity.expression = EF_REVEAL_OP;
    } else if (preset === "bounce") {
        pos.expression = EF_BOUNCE_POS;
        opacity.expression = EF_REVEAL_OP;
    } else if (preset === "fade") {
        opacity.expression = EF_FADE_OP;
    } else if (preset === "typewriter") {
        var full = cfg.allCaps ? g.text.toUpperCase() : g.text;
        src.expression = ef_typewriterExpr(full);
        opacity.expression = EF_REVEAL_OP;
    }

    // Custom expression override
    if (cfg.customExpr && String(cfg.customExpr).replace(/^\s+|\s+$/g, "").length) {
        scale.expression = cfg.customExpr;
    }
}

/* ── Build a single caption group (multi-layer mode) ── */
function ef_buildGroup(comp, g, cfg) {
    var text = cfg.allCaps ? g.text.toUpperCase() : g.text;
    var layer = comp.layers.addText(text);
    layer.name = text.substr(0, 28);
    layer.comment = EF_TAG;
    ef_styleDoc(layer, cfg);
    ef_setTiming(layer, g.start, g.end);
    ef_centerAnchor(layer, comp, cfg, g.start + 0.05);
    ef_applyPreset(layer, cfg, g);
    return 1;
}

/* ── Create captions (main entry point) ── */
function ef_createCaptions(jsonStr) {
    var started = false;
    try {
        var cfg = eval("(" + jsonStr + ")");

        var comp = ef_getComp();
        if (!comp) return ef_err("No composition with audio found. Create a comp, add audio, and open it.");
        if (!cfg.words || !cfg.words.length) return ef_err("No words supplied.");

        // Apply offset (audio may not start at comp time 0)
        var off = cfg.offset || 0;
        if (off) {
            for (var oi = 0; oi < cfg.words.length; oi++) {
                cfg.words[oi].start += off;
                cfg.words[oi].end += off;
            }
        }

        // Set defaults
        cfg.fontSize = cfg.fontSize || 80;
        cfg.fontName = cfg.fontName || "Arial";
        cfg.fillColor = cfg.fillColor || [1, 1, 1];
        cfg.posX = cfg.posX || 50;
        cfg.posY = cfg.posY || 85;
        cfg.preset = cfg.preset || "popin";
        cfg.wordsPerLine = cfg.wordsPerLine || 4;

        app.beginUndoGroup("EditFlow: Create Captions");
        started = true;

        // Remove old captions
        if (cfg.replace !== false) ef_removeOldCaptions(comp);

        // Group words into caption phrases (3-4 words per line)
        var groups = ef_groupWords(cfg.words, cfg);

        var created = 0, failed = 0;
        var errors = [];

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
            placed: created,
            total: cfg.words.length,
            groups: groups.length,
            errors: errors,
            preset: cfg.preset,
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

        return ef_json({ removed: removed });
    } catch (e) {
        return ef_err("clearCaptions: " + e.toString());
    }
}
