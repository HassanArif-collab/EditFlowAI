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

/* ── Capture current playhead frame to PNG ── */
/* PRIMARY: CompItem.saveFrameToPng(time, file) — available in modern AE
   (feature-detected below), renders the frame straight to a real PNG with no
   render queue, no output-module templates, no ffmpeg and no
   displayStartTime range math.
   FALLBACK (older builds): Render Queue single-frame render (this install
   only ships Photoshop/TIFF/H.264 templates — no PNG), then ffmpeg converts
   to PNG. Every step is numbered ([1]..[N]) and written to debug.log. */
function ef_getCurrentFrame() {
    var logLines = [];
    function log(m) { logLines.push(String(m)); }
    function writeLog() {
        try {
            var tf = new Folder(Folder.temp.fsName + "/EditFlowAE_Frames");
            if (!tf.exists) { try { tf.create(); } catch (e2) {} }
            var lf = new File(Folder.temp.fsName + "/EditFlowAE_Frames/debug.log");
            try { if (lf.exists) lf.remove(); } catch (e3) {}
            lf.open("w");
            lf.write(logLines.join("\r\n"));
            lf.close();
        } catch (e) {}
    }
    function escStr(s) {
        s = String(s); var out = "", i, c;
        for (i = 0; i < s.length; i++) {
            c = s.charAt(i);
            if (c === '"') out += '\\"';
            else if (c === "\\") out += "\\\\";
            else if (c === "\n") out += "\\n";
            else if (c === "\r") out += "\\r";
            else out += c;
        }
        return out;
    }
    try {
        log("[1] start getCurrentFrame");

        // [2] active comp — typeof guards avoid throwing on missing props
        var comp = null;
        try { comp = app.project.activeItem; } catch (e) { log("[2] ERR activeItem: " + e.toString()); }
        if (!comp) { log("[2] no active item"); writeLog(); return ef_err("No active composition. Click inside a comp first."); }
        var isComp = false;
        try { isComp = (comp instanceof CompItem); } catch (e) { log("[2] instanceof ERR: " + e.toString()); }
        if (!isComp) { log("[2] active item is not a comp"); writeLog(); return ef_err("Active item is not a composition."); }
        log("[2] ok comp");

        // [3] read comp timing properties defensively (some props may be missing
        // in older AE builds — each wrapped so one missing prop can't abort all).
        var currentTime = 0, dispStart = 0, compDur = 0, frameDur = 0.04;
        try { currentTime = comp.time; } catch (e) { log("[3] ERR comp.time: " + e.toString()); }
        try { dispStart = comp.displayStartTime || 0; } catch (e) { log("[3] ERR displayStartTime: " + e.toString()); dispStart = 0; }
        try { compDur = comp.duration || 0; } catch (e) { log("[3] ERR duration: " + e.toString()); compDur = 0; }
        try { frameDur = comp.frameDuration || 0.04; } catch (e) { log("[3] ERR frameDuration: " + e.toString()); frameDur = 0.04; }

        // Compute the absolute timeSpanStart the Render Queue expects. When a
        // comp has a non-zero displayStartTime (timeline offset to match a
        // source clip), the RQ rejects values below it and renders a BLACK
        // frame with a "frames outside of range" warning. Shift & clamp.
        var spanStart = currentTime;
        if (currentTime < dispStart) spanStart = currentTime + dispStart;
        var lo = dispStart;
        var hi = dispStart + compDur - frameDur;
        if (spanStart < lo) spanStart = lo;
        if (hi > lo && spanStart > hi) spanStart = hi;
        log("[3] time=" + currentTime + " displayStart=" + dispStart + " dur=" + compDur + " frameDur=" + frameDur + " spanStart=" + spanStart + " range=[" + lo + "," + hi + "]");

        // [4] temp folder
        var tempFolder = new Folder(Folder.temp.fsName + "/EditFlowAE_Frames");
        if (!tempFolder.exists && !tempFolder.create()) {
            log("[4] folder create failed: " + tempFolder.fsName); writeLog();
            return ef_err("Could not create temp folder: " + tempFolder.fsName);
        }
        log("[4] ok folder");

        // [5] output path
        var baseName = "frame_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
        var outBase = tempFolder.fsName + "/" + baseName;
        var outFile = new File(outBase + ".png");
        try { if (outFile.exists) outFile.remove(); } catch (e) {}
        log("[5] outBase=" + outBase);

        // [5d] PRIMARY: direct PNG export — comp.saveFrameToPng(time, file).
        // time is plain comp time (same space as comp.time), so no
        // displayStartTime shifting is needed here at all.
        var hasDirect = false;
        try { hasDirect = (typeof comp.saveFrameToPng === "function"); } catch (e) {}
        log("[5d] saveFrameToPng available=" + hasDirect);
        if (hasDirect) {
            try {
                comp.saveFrameToPng(currentTime, outFile);
                var chk = new File(outFile.fsName);
                var chkLen = 0;
                try { chkLen = chk.length; } catch (e) {}
                log("[5d] direct result exists=" + chk.exists + " size=" + chkLen);
                if (chk.exists && chkLen > 4096) {
                    var compNameD = "";
                    try { compNameD = comp.name || ""; } catch (e) {}
                    var cwD = 0, chD = 0;
                    try { cwD = comp.width || 0; } catch (e) {}
                    try { chD = comp.height || 0; } catch (e) {}
                    log("[OK] (direct) path=" + chk.fsName + " size=" + chkLen);
                    writeLog();
                    return '{"path":"' + escStr(chk.fsName) + '","time":' + Number(currentTime) +
                           ',"compName":"' + escStr(compNameD) + '","width":' + Number(cwD) +
                           ',"height":' + Number(chD) + ',"method":"saveFrameToPng"}';
                }
                log("[5d] direct produced no/tiny file — falling back to Render Queue");
            } catch (eD) {
                log("[5d] direct ERR: " + eD.toString() + " — falling back to Render Queue");
            }
        }

        // [6] render queue + output module
        var rq = app.project.renderQueue;
        var rqItem = rq.items.add(comp);
        var om = rqItem.outputModule(1);
        log("[6] ok rq item added");

        // [7] pick an image-capable output template (inline, no nested fn —
        // ExtendScript ES3 scoping of nested function decls can be unreliable).
        var templates = [];
        try { templates = om.templates; } catch (e) { log("[7] ERR templates: " + e.toString()); }
        if (!templates) templates = [];
        log("[7] templates=" + templates.join(" | "));
        var preferred = [];
        var subs = ["PNG", "PHOTOSHOP", "TIFF", "LOSSLESS", "HIGH QUALITY"];
        for (var si = 0; si < subs.length; si++) {
            var sub = subs[si];
            for (var ti = 0; ti < templates.length; ti++) {
                if (String(templates[ti]).toUpperCase().indexOf(sub) >= 0) preferred.push(templates[ti]);
            }
        }
        if (preferred.length === 0) preferred = templates.slice();
        var applied = null;
        for (var ci = 0; ci < preferred.length; ci++) {
            try { om.applyTemplate(preferred[ci]); applied = preferred[ci]; break; }
            catch (e) { log("[7] template fail " + preferred[ci] + ": " + e.toString()); }
        }
        if (!applied) {
            try { rqItem.remove(); } catch (e) {}
            log("[7] no usable template"); writeLog();
            return ef_err("No output template found in Render Queue.");
        }
        log("[7] ok template=" + applied);

        // [8] re-fetch OM (applyTemplate can invalidate the ref) + set file
        om = rqItem.outputModule(1);
        om.file = outFile;
        log("[8] ok output file set");

        // [9] single-frame span (clamped above so AE never renders blank)
        rqItem.timeSpanStart = spanStart;
        rqItem.timeSpanDuration = frameDur;
        log("[9] ok span set");

        // [10] render only our item
        for (var k = 1; k <= rq.numItems; k++) {
            try { rq.item(k).render = (rq.item(k) === rqItem); } catch (e) {}
        }
        log("[10] ok render flags set, rendering…");
        rq.render(); // blocking
        log("[10] ok render done");

        try { rqItem.remove(); } catch (e) {}

        // [11] locate produced file (render may change extension / add suffix)
        var exts = [".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".psd"];
        var produced = null;
        var producedFile = new File(outBase + ".png");
        if (producedFile.exists && producedFile.length > 0) produced = producedFile;
        if (!produced) {
            var folder = new Folder(tempFolder.fsName);
            var files = folder.getFiles(baseName + "*");
            for (var fi = 0; fi < files.length; fi++) {
                var f = files[fi];
                var lower = String(f.name).toLowerCase();
                var okExt = false;
                for (var ei = 0; ei < exts.length; ei++) {
                    if (lower.length >= exts[ei].length &&
                        lower.indexOf(exts[ei]) === lower.length - exts[ei].length) { okExt = true; break; }
                }
                var isFile = false;
                try { isFile = (f instanceof File); } catch (e) {}
                var fLen = 0;
                try { fLen = f.length; } catch (e) {}
                if (okExt && isFile && fLen > 0) { produced = f; break; }
            }
        }
        if (!produced || produced.length === 0) {
            log("[11] file missing after render"); writeLog();
            return ef_err("Frame export failed — no image file produced at " + outBase);
        }
        log("[11] ok produced=" + produced.fsName + " size=" + produced.length);

        // [12] convert non-png (.psd/.tif) to .png via FFmpeg for browser display
        var finalPng = new File(outBase + ".png");
        var producedName = String(produced.name).toLowerCase();
        var isPng = producedName.length >= 4 &&
                    producedName.indexOf(".png") === producedName.length - 4;
        if (!isPng) {
            try { if (finalPng.exists) finalPng.remove(); } catch (e) {}
            // -frames:v 1 -update 1 are OUTPUT options and MUST come after -i;
            // placed before -i, ffmpeg rejects the whole command ("cannot be
            // applied to input url"). Without them the image2 muxer treats the
            // output path as a sequence pattern and writes a broken stub PNG.
            var ffmpeg = "ffmpeg -y -i \"" + produced.fsName + "\" -frames:v 1 -update 1 \"" + finalPng.fsName + "\"";
            log("[12] ffmpeg: " + ffmpeg);
            var rc = -1;
            try { rc = system.callSystem ? system.callSystem(ffmpeg) : system(ffmpeg); } catch (e) { log("[12] ffmpeg ERR: " + e.toString()); }
            log("[12] ffmpeg rc=" + rc);
        }

        var outResult = isPng ? produced : finalPng;
        var rExists = false, rLen = 0;
        try { rExists = outResult.exists; rLen = outResult.length; } catch (e) {}
        // A tiny PNG (< 4KB) is a broken stub from a failed conversion. Never
        // hand back the .psd/.tif instead — Chromium cannot display those, so
        // the panel would show a black frame. A clear error beats black.
        if (!rExists || rLen < 4096) {
            log("[12] PNG conversion failed (exists=" + rExists + " size=" + rLen + ")"); writeLog();
            return ef_err("Frame rendered but PNG conversion failed (is ffmpeg on PATH?). Click 📋 Log for the step trace.");
        }
        log("[12] ok outResult=" + outResult.fsName + " size=" + rLen);

        // [13] build JSON manually (do NOT use ef_json — its
        // Object.prototype.toString.call path triggers "Function Object is
        // undefined" on some ExtendScript builds).
        var compNameStr = "";
        try { compNameStr = comp.name || ""; } catch (e) {}
        var cw = 0, ch = 0;
        try { cw = comp.width || 0; } catch (e) {}
        try { ch = comp.height || 0; } catch (e) {}
        var resultPath = "";
        try { resultPath = outResult.fsName; } catch (e) {}
        log("[13] OK path=" + resultPath + " size=" + rLen);
        writeLog();
        var json = '{"path":"' + escStr(resultPath) + '","time":' + Number(currentTime) +
                   ',"compName":"' + escStr(compNameStr) + '","width":' + Number(cw) +
                   ',"height":' + Number(ch) + '}';
        return json;
    } catch (e) {
        var emsg = e.toString();
        log("[!] EXCEPTION " + emsg + "  line=" + (e.line || "?") + "  name=" + (e.name || "?"));
        writeLog();
        return ef_err("getCurrentFrame: " + emsg + " (see debug.log — click 📋 Log)");
    }
}

/* ── Read the debug log (so the CEP panel can show WHERE a capture failed) ── */
function ef_readDebugLog() {
    try {
        var lf = new File(Folder.temp.fsName + "/EditFlowAE_Frames/debug.log");
        if (!lf.exists) return ef_err("No debug log yet. Click 🖼 Frame first.");
        lf.open("r");
        var contents = lf.read();
        lf.close();
        // Manual JSON to avoid ef_json's Object.prototype.toString path.
        var esc = "";
        for (var i = 0; i < contents.length; i++) {
            var c = contents.charAt(i);
            if (c === '"') esc += '\\"';
            else if (c === "\\") esc += "\\\\";
            else if (c === "\n") esc += "\\n";
            else if (c === "\r") esc += "";
            else if (c === "\t") esc += "\\t";
            else esc += c;
        }
        return '{"log":"' + esc + '","path":"' + lf.fsName.replace(/\\/g, "/") + '"}';
    } catch (e) {
        return ef_err("readDebugLog: " + e.toString());
    }
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

function ef_endsSentence(t) { return /[.?!؟۔।؛。！？…]["')\]]?\s*$/.test(String(t)); }

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

/* Panel-supplied groups carry exact in/out (tIn/tOut, hold-until-next +
   overlap). Legacy groups fall back to the capped 50ms-gap rule. */
function ef_setGroupTiming(layer, g, nextStart) {
    if (g.tIn != null && g.tOut != null) {
        layer.inPoint = g.tIn;   // inPoint first, then outPoint
        layer.outPoint = (g.tOut > g.tIn) ? g.tOut : g.tIn + 0.1;
    } else {
        ef_setTimingCapped(layer, g.start, g.end, nextStart);
    }
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

/* ══ Single-layer word-by-word engine (expression selector, Based On: Words) ══ */

/* Can this AE build add an Expression Selector to a text animator?
   Probed once per run with a throwaway layer; falls back to legacy paths. */
function ef_probeExpressionSelector(comp) {
    var L = null, ok = false;
    try {
        L = comp.layers.addText("probe");
        var anim = L.property("ADBE Text Properties").property("ADBE Text Animators")
            .addProperty("ADBE Text Animator");
        ok = anim.property("ADBE Text Selectors").canAddProperty("ADBE Text Expressible Selector");
    } catch (e) { ok = false; }
    if (L) { try { L.remove(); } catch (e2) {} }
    return ok;
}

/* Amount expression for an expression selector (Based On: Words).
   Returns 100 while the word hasn't started (animator fully applied →
   opacity 0 / offset down) and eases to 0 as the word enters. Times are
   relative to layer inPoint. ES3-safe for legacy expression engines. */
function ef_wordProgressExpr(relTimes, dur, easing) {
    var ts = [];
    for (var i = 0; i < relTimes.length; i++) ts.push(Math.round(relTimes[i] * 1000) / 1000);
    var easeBody;
    if (easing === "ease_out") easeBody = "e=1-Math.pow(1-p,3);";
    else if (easing === "ease_in") easeBody = "e=p*p*p;";
    else if (easing === "ease_in_out") easeBody = "e=(p<0.5)?4*p*p*p:1-Math.pow(-2*p+2,3)/2;";
    else easeBody = "e=p;";
    return "var ts=[" + ts.join(",") + "];" +
        "var i=textIndex-1;if(i>=ts.length)i=ts.length-1;if(i<0)i=0;" +
        "var p=(time-thisLayer.inPoint-ts[i])/" + (dur || 0.3) + ";" +
        "if(p<0)p=0;if(p>1)p=1;var e;" + easeBody +
        "var a=(1-e)*100;[a,a,a];";
}

function ef_addWordSelector(animator, expr) {
    var sel = animator.property("ADBE Text Selectors").addProperty("ADBE Text Expressible Selector");
    // Based On = Words (enum 3: Characters, Chars-excl-spaces, Words, Lines)
    try { sel.property("ADBE Text Range Type2").setValue(3); } catch (e) {}
    sel.property("ADBE Text Expressible Amount").expression = expr;
}

/* fadeup_words on ONE layer: Opacity animator (0) + Position animator
   (down slideDist), each weighted per word by the same selector expression. */
function ef_applyWordAnimators(layer, relTimes, cfg) {
    var expr = ef_wordProgressExpr(relTimes, cfg.fadeDur || 0.3, cfg.wordEasing || "linear");
    var animators = layer.property("ADBE Text Properties").property("ADBE Text Animators");
    var fadeAnim = animators.addProperty("ADBE Text Animator");
    fadeAnim.name = "EF Word Fade";
    fadeAnim.property("ADBE Text Animator Properties").addProperty("ADBE Text Opacity").setValue(0);
    ef_addWordSelector(fadeAnim, expr);
    var slide = (cfg.slideDist != null) ? cfg.slideDist : 40;
    if (slide > 0) {
        var riseAnim = animators.addProperty("ADBE Text Animator");
        riseAnim.name = "EF Word Rise";
        var posProp = riseAnim.property("ADBE Text Animator Properties").addProperty("ADBE Text Position 3D");
        try { posProp.setValue([0, slide]); } catch (e3) { posProp.setValue([0, slide, 0]); }
        ef_addWordSelector(riseAnim, expr);
    }
}

function ef_groupHasPill(g) {
    for (var i = 0; i < g.words.length; i++) if (g.words[i].pill) return true;
    return false;
}

/* Caption box: max width as a fraction of comp width (panel boxWidthPct,
   default 94%). Wrapping already keeps lines inside; this is the last-resort
   shrink so nothing ever renders outside the composition. */
function ef_boxMaxWidth(comp, cfg) {
    var pct = (cfg.boxWidthPct != null) ? cfg.boxWidthPct : 94;
    return comp.width * pct / 100;
}

function ef_fitToBox(layer, comp, cfg, atTime) {
    try {
        var r = layer.sourceRectAtTime(atTime, false);
        var maxW = ef_boxMaxWidth(comp, cfg);
        if (r.width > maxW) {
            var sc = maxW / r.width * 100;
            layer.property("Scale").setValue([sc, sc]);
            return sc / 100;
        }
    } catch (e) {}
    return 1;
}

/* Measure word geometry for a caption with the caption's exact style:
   one temp text layer, width read per line / per word-prefix / per word.
   Returns {lineWidths[], prefixW[], selfW[]} in comp px (allCaps applied);
   prefixW/selfW are indexed by word index into g.words. */
function ef_measureWordSpans(comp, g, cfg, lines, lineTexts) {
    var allCaps = cfg.allCaps !== false;
    var lineWidths = [], prefixW = [], selfW = [];
    var temp = null;
    try {
        temp = comp.layers.addText("m");
        ef_styleDoc(temp, cfg);
        var st = temp.property("Source Text");
        for (var li = 0; li < lines.length; li++) {
            var lt = allCaps ? String(lineTexts[li]).toUpperCase() : String(lineTexts[li]);
            st.setValue(lt);
            lineWidths.push(temp.sourceRectAtTime(0, false).width);
            var prefix = "";
            for (var wi = lines[li].startIdx; wi <= lines[li].endIdx; wi++) {
                var wt = String(g.words[wi].text);
                if (allCaps) wt = wt.toUpperCase();
                prefix += (wi > lines[li].startIdx ? " " : "") + wt;
                st.setValue(prefix);
                prefixW[wi] = temp.sourceRectAtTime(0, false).width;
                st.setValue(wt);
                selfW[wi] = temp.sourceRectAtTime(0, false).width;
            }
        }
    } finally {
        if (temp) { try { temp.remove(); } catch (eT) {} }
    }
    return { lineWidths: lineWidths, prefixW: prefixW, selfW: selfW };
}

/* Pure geometry (node-tested): word spans in comp coords from measured
   widths. Lines are centered on centerX; line Y spreads about centerY at
   1.2em leading (AE auto-leading = panel preview). shrink scales the whole
   block about (centerX, centerY) — must match ef_fitToBox's layer Scale. */
function ef_pillSpanMath(lines, meas, opts) {
    var s = opts.shrink || 1;
    var lh = (opts.fontSize || 80) * 1.2;
    var spans = [];
    for (var li = 0; li < lines.length; li++) {
        var lineLeft = opts.centerX - meas.lineWidths[li] / 2;
        var y = opts.centerY + (li - (lines.length - 1) / 2) * lh;
        for (var wi = lines[li].startIdx; wi <= lines[li].endIdx; wi++) {
            var right = lineLeft + meas.prefixW[wi];
            var left = right - meas.selfW[wi];
            spans[wi] = {
                left: opts.centerX + (left - opts.centerX) * s,
                right: opts.centerX + (right - opts.centerX) * s,
                y: opts.centerY + (y - opts.centerY) * s,
                line: li
            };
        }
    }
    return spans;
}

/* Pill shapes for a single-layer caption: one rounded rect per run of
   adjacent pill words (within a line), sized from measured spans, timed to
   ITS first word, behind the text layer. */
function ef_addPillsToCaption(comp, textLayer, g, cfg, lines, lineTexts, fit) {
    var meas = ef_measureWordSpans(comp, g, cfg, lines, lineTexts);
    var spans = ef_pillSpanMath(lines, meas, {
        centerX: comp.width * (cfg.posX || 50) / 100,
        centerY: comp.height * (cfg.posY || 85) / 100,
        fontSize: cfg.fontSize || 80,
        shrink: fit
    });
    var tOut = (g.tOut != null) ? g.tOut : g.end + 0.3;
    var padX = (cfg.fontSize || 80) * 0.28 * fit;
    var padY = (cfg.fontSize || 80) * 0.16 * fit;
    var pillH = (cfg.fontSize || 80) * fit + padY * 2;
    var placed = 0;
    for (var li = 0; li < lines.length; li++) {
        var i = lines[li].startIdx;
        while (i <= lines[li].endIdx) {
            if (!g.words[i].pill || !spans[i]) { i++; continue; }
            var a = i, b = i;
            while (b + 1 <= lines[li].endIdx && g.words[b + 1].pill) b++;
            var left = spans[a].left, right = spans[b].right;
            if (right > left) {
                try {
                    var pw = (right - left) + padX * 2;
                    var pcx = (left + right) / 2;
                    var shape = comp.layers.addShape();
                    shape.name = "EF Pill";
                    shape.comment = EF_ACTIVE_TAG;
                    var vec = shape.property("ADBE Root Vectors Group")
                        .addProperty("ADBE Vector Group").property("ADBE Vectors Group");
                    var rect = vec.addProperty("ADBE Vector Shape - Rect");
                    rect.property("ADBE Vector Rect Size").setValue([pw, pillH]);
                    rect.property("ADBE Vector Rect Roundness").setValue(pillH / 2 * (cfg.pillRadius || 0.5));
                    var fill = vec.addProperty("ADBE Vector Graphic - Fill");
                    var pc = cfg.pillColor || [0.04, 0.1, 0.18];
                    fill.property("ADBE Vector Fill Color").setValue([pc[0], pc[1], pc[2]]);
                    if (cfg.pillOpacity != null) fill.property("ADBE Vector Fill Opacity").setValue(cfg.pillOpacity);
                    if ((cfg.pillStrokeWidth || 0) > 0) {
                        var stroke = vec.addProperty("ADBE Vector Graphic - Stroke");
                        stroke.property("ADBE Vector Stroke Color").setValue(cfg.pillStrokeColor || [1, 1, 1]);
                        stroke.property("ADBE Vector Stroke Width").setValue(cfg.pillStrokeWidth);
                    }
                    shape.property("Position").setValue([pcx, spans[a].y]);
                    shape.inPoint = g.words[a].start;   // pill pops in with ITS word
                    shape.outPoint = (tOut > g.words[a].start) ? tOut : g.words[a].start + 0.1;
                    shape.property("Scale").expression = ef_buildPillScale(cfg.pillScaleDur || 0.3, cfg.pillEasing || "linear");
                    shape.property("Opacity").expression = ef_buildFadeUpOp(cfg.pillScaleDur || 0.3, cfg.pillEasing || "linear");
                    shape.moveAfter(textLayer);
                    placed++;
                } catch (ePill) {}
            }
            i = b + 1;
        }
    }
    return placed;
}

/* ONE text layer per caption (panel-supplied group): lines joined by \r,
   static anchor, exact tIn/tOut, per-word reveal via expression selectors,
   auto-shrink to comp width. */
function ef_buildCaptionLayer(comp, g, cfg) {
    var allCaps = cfg.allCaps !== false;
    var lines = (g.lines && g.lines.length) ? g.lines
        : [{ startIdx: 0, endIdx: g.words.length - 1 }];
    var lineTexts = [];
    for (var li = 0; li < lines.length; li++) {
        var seg = [];
        for (var wi = lines[li].startIdx; wi <= lines[li].endIdx; wi++) seg.push(g.words[wi].text);
        lineTexts.push(seg.join(" "));
    }
    var fullText = lineTexts.join("\r");
    if (allCaps) fullText = fullText.toUpperCase();

    var layer = comp.layers.addText(fullText);
    layer.name = "Caption: " + fullText.substr(0, 24);
    layer.comment = EF_ACTIVE_TAG;
    ef_styleDoc(layer, cfg);
    ef_setGroupTiming(layer, g, null);

    // Anchor/position/shrink BEFORE animators so the measure isn't skewed
    // by mid-fade position offsets.
    var tIn = (g.tIn != null) ? g.tIn : g.start;
    var r = layer.sourceRectAtTime(tIn + 0.05, false);
    layer.property("Anchor Point").setValue([r.left + r.width / 2, r.top + r.height / 2]);
    layer.property("Position").setValue([
        comp.width * (cfg.posX || 50) / 100,
        comp.height * (cfg.posY || 85) / 100
    ]);
    var fit = ef_fitToBox(layer, comp, cfg, tIn + 0.05);

    var relTimes = [];
    for (var ri = 0; ri < g.words.length; ri++) {
        var rel = g.words[ri].start - tIn;
        relTimes.push(rel > 0 ? rel : 0);
    }
    ef_applyWordAnimators(layer, relTimes, cfg);

    if (cfg.dropShadow) ef_applyDropShadow(layer, cfg);

    var placed = 1;
    if (ef_groupHasPill(g)) {
        try { placed += ef_addPillsToCaption(comp, layer, g, cfg, lines, lineTexts, fit); }
        catch (eP) {}
    }
    return placed;
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

    ef_fitToBox(layer, comp, cfg, measureAt);
    ef_setGroupTiming(layer, g, nextStart);
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
                ef_setGroupTiming(textLayer, g, nextStart);

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

        // Caption box: shrink the whole word row when it would overflow.
        var boxW = ef_boxMaxWidth(comp, cfg);
        var fit = totalW > boxW ? boxW / totalW : 1;

        var accX = (comp.width * posX / 100) - (totalW * fit) / 2;
        var centerY = comp.height * posY / 100;
        var wordCenters = [];  // store per-word X edges for pill sizing
        for (var li = 0; li < n; li++) {
            var L = wordLayers[li];
            if (!L || !rects[li]) { wordCenters.push(null); accX += (widths[li] + space) * fit; continue; }
            var rr = rects[li];
            // Center each word's anchor on its own glyph box, then place
            // at the accumulated X cursor + the group's Y.
            L.property("Anchor Point").setValue([rr.left + rr.width / 2, rr.top + rr.height / 2]);
            L.property("Position").setValue([accX + (widths[li] * fit) / 2, centerY]);
            if (fit < 1) L.property("Scale").setValue([fit * 100, fit * 100]);
            wordCenters.push({ left: accX, right: accX + widths[li] * fit, height: rr.height * fit });
            // Per-word entrance keyed to THIS word's spoken start time.
            var ws = g.words[li].start;
            L.property("Opacity").expression = ef_wordFadeUpOpExpr(ws, fadeDur, wordEasing);
            L.property("Position").expression = ef_wordFadeUpPosExpr(ws, fadeDur, slideDist, wordEasing, centerY);
            accX += (widths[li] + space) * fit;
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
            var padX = (cfg.fontSize || 80) * 0.28 * fit, padY = (cfg.fontSize || 80) * 0.16 * fit;
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
                // Pill pops in with ITS word, not the caption start.
                var pillOut;
                if (g.tOut != null) { pillOut = g.tOut; }
                else {
                    pillOut = g.end + 0.3;
                    if (nextStart != null && nextStart - 0.05 < pillOut) pillOut = nextStart - 0.05;
                }
                if (pillOut <= pillStart) pillOut = pillStart + 0.1;
                shape.inPoint = pillStart;   // inPoint first, then outPoint
                shape.outPoint = pillOut;
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
        ef_setGroupTiming(layer, g, nextStart);
        ef_centerAnchor(layer, comp, cfg, g.start + 0.05);
        ef_fitToBox(layer, comp, cfg, g.start + 0.05);
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
        var usingPanelGroups = !!(cfg.groups && cfg.groups.length);
        if (!usingPanelGroups && (!cfg.words || !cfg.words.length)) return ef_err("No words supplied.");

        // Apply offset
        var off = cfg.offset || 0;
        if (off) {
            if (usingPanelGroups) {
                for (var ogi = 0; ogi < cfg.groups.length; ogi++) {
                    var og = cfg.groups[ogi];
                    og.start += off; og.end += off;
                    if (og.tIn != null) og.tIn += off;
                    if (og.tOut != null) og.tOut += off;
                    for (var ow = 0; ow < og.words.length; ow++) {
                        og.words[ow].start += off;
                        og.words[ow].end += off;
                    }
                }
            } else {
                for (var oi = 0; oi < cfg.words.length; oi++) {
                    cfg.words[oi].start += off;
                    cfg.words[oi].end += off;
                }
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

        var groups = usingPanelGroups ? cfg.groups : ef_groupWords(cfg.words, cfg);

        // Word-by-word on ONE layer needs the expression selector; probe once.
        // Pill captions ride the same layer (pill shapes from measured word
        // spans); the per-word-layer path survives only as the probe-failure
        // fallback (user decision 2026-07-18: single layer even with pills).
        var useSelector = usingPanelGroups && cfg.preset === "fadeup_words" &&
            !cfg.forceLegacy && ef_probeExpressionSelector(comp);

        var created = 0, failed = 0, errors = [];

        for (var i = 0; i < groups.length; i++) {
            try {
                var nextStart = (i + 1 < groups.length) ? groups[i + 1].start
                                : (cfg.nextBatchStart != null ? cfg.nextBatchStart : null);
                if (useSelector) {
                    created += ef_buildCaptionLayer(comp, groups[i], cfg);
                } else {
                    created += ef_buildGroup(comp, groups[i], cfg, nextStart);
                }
            } catch (ge) {
                failed++;
                errors.push("group " + i + ": " + ge.toString());
                if (errors.length >= 5) break;
            }
        }

        app.endUndoGroup();

        return ef_json({
            placed: created,
            total: usingPanelGroups ? groups.length : cfg.words.length,
            groups: groups.length, wordSelector: useSelector,
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

/* ══ Agent dev-loop tools (used via /api/ae-bridge; harmless otherwise) ══ */

/* Machine-readable inventory of every layer in the comp — the agent's eyes
   for structural assertions (one layer per caption, animator wiring,
   selector expressions, in/out points, pill timing). */
function ef_dumpLayers() {
    try {
        var comp = ef_getComp();
        if (!comp) return ef_err("No comp");
        var out = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            var d = { index: i, name: String(L.name), comment: String(L.comment || ""),
                      inPoint: L.inPoint, outPoint: L.outPoint };
            try { d.position = L.property("Position").value; } catch (e1) {}
            try { d.scale = L.property("Scale").value; } catch (e2) {}
            try { d.anchor = L.property("Anchor Point").value; } catch (e3) {}
            try { d.text = String(L.property("Source Text").value.text); } catch (e4) {}
            try {
                var anims = L.property("ADBE Text Properties").property("ADBE Text Animators");
                if (anims && anims.numProperties > 0) {
                    d.animators = [];
                    for (var a = 1; a <= anims.numProperties; a++) {
                        var an = anims.property(a);
                        var ad = { name: String(an.name), selectors: [] };
                        try {
                            var sels = an.property("ADBE Text Selectors");
                            for (var s = 1; s <= sels.numProperties; s++) {
                                var sel = sels.property(s);
                                var sd = { matchName: String(sel.matchName) };
                                try { sd.basedOn = sel.property("ADBE Text Range Type2").value; } catch (e5) {}
                                try {
                                    var ex = sel.property("ADBE Text Expressible Amount").expression;
                                    sd.expr = String(ex).substr(0, 300);
                                } catch (e6) {}
                                ad.selectors.push(sd);
                            }
                        } catch (e7) {}
                        d.animators.push(ad);
                    }
                }
            } catch (e8) {}
            out.push(d);
        }
        return ef_json({ comp: comp.name, width: comp.width, height: comp.height,
                         frameRate: comp.frameRate, duration: comp.duration, layers: out });
    } catch (e) { return ef_err("dumpLayers: " + e.toString()); }
}

/* Render the active comp at time t straight to outPath (PNG). Uses the
   saveFrameToPng path already verified in this install (see
   ef_getCurrentFrame [5d]); no Render Queue fallback here — the bridge
   surfaces the error and the agent falls back to ef_getCurrentFrame. */
function ef_renderFrameAt(t, outPath) {
    try {
        var comp = ef_getComp();
        if (!comp) return ef_err("No comp");
        var hasDirect = false;
        try { hasDirect = (typeof comp.saveFrameToPng === "function"); } catch (e0) {}
        if (!hasDirect) return ef_err("saveFrameToPng not available in this AE build");
        var tt = Number(t) || 0;
        if (tt < 0) tt = 0;
        if (tt > comp.duration) tt = comp.duration;
        var f = new File(String(outPath));
        try { if (f.exists) f.remove(); } catch (e1) {}
        comp.saveFrameToPng(tt, f);
        var chk = new File(f.fsName);
        var len = 0;
        try { len = chk.length; } catch (e2) {}
        if (!chk.exists || len < 1024) return ef_err("render produced no/tiny file: " + f.fsName);
        return ef_json({ path: chk.fsName, time: tt, comp: comp.name, bytes: len });
    } catch (e) { return ef_err("renderFrameAt: " + e.toString()); }
}

/* Bootstrap a deterministic test comp on a fresh AE: imports the given
   audio file, creates (or reuses) a 1080x1920 30fps comp with the audio
   as its only layer, opens it in the viewer. Idempotent by comp name. */
function ef_setupTestComp(audioPath) {
    try {
        var NAME = "EF Smoke 1080x1920";
        var existing = null;
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof CompItem && it.name === NAME) { existing = it; break; }
        }
        if (existing) {
            existing.openInViewer();
            return ef_json({ comp: existing.name, width: existing.width,
                             height: existing.height, duration: existing.duration, reused: true });
        }
        var af = new File(String(audioPath));
        if (!af.exists) return ef_err("audio file not found: " + String(audioPath));
        var io = new ImportOptions(af);
        var footage = app.project.importFile(io);
        var dur = 3;
        try { if (footage.duration > 0) dur = footage.duration + 1; } catch (eD) {}
        var comp = app.project.items.addComp(NAME, 1080, 1920, 1.0, dur, 30);
        comp.layers.add(footage);
        comp.openInViewer();
        return ef_json({ comp: comp.name, width: comp.width, height: comp.height,
                         duration: comp.duration, reused: false });
    } catch (e) { return ef_err("setupTestComp: " + e.toString()); }
}
