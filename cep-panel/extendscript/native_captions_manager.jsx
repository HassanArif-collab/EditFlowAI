/*
 * native_captions_manager.jsx — Native caption placement + animation.
 *
 * v3: SINGLE-CLIP approach (fixes memory crash).
 *
 * OLD approach (v2): 1 MOGRT per word = 100+ Graphic layers = PPro crash.
 * NEW approach (v3): 1 MOGRT spanning the whole sequence, with keyframed
 *   Source Text (text changes at each word boundary) + keyframed Scale/Opacity
 *   (pop-in at each word). This is how submachine.ai and other pro caption
 *   plugins work — 1 clip, N keyframes, minimal memory.
 *
 * The single-clip approach:
 *   1. Insert ONE base_text.mogrt at the first word's start time
 *   2. Trim it to span from first word start to last word end
 *   3. Keyframe Source Text: at each word.start, set the text to that word
 *   4. Keyframe Scale: at each word.start, do the pop-in (0 → 110 → 100)
 *   5. Keyframe Opacity: at each word.start, do the fade (0 → 100)
 *
 * For 108 words: 1 clip + 108 Source Text keyframes + 324 Scale keyframes +
 * 216 Opacity keyframes = ~650 keyframes on 1 clip. PPro handles this easily.
 *
 * Helpers copied verbatim from subtitle_manager.jsx (debugged through 5 fix
 * commits on feat/animated-captions).
 */
nativeCaptionsManager = (function() {
    "use strict";

    var KF_BASE = 'sequence';

    function _ok(obj)  { obj = obj || {}; obj.success = true;  return editflowUtils.safeStringify(obj); }
    function _err(msg) { return editflowUtils.safeStringify({ success: false, error: String(msg) }); }

    function _time(seconds) { var t = new Time(); t.seconds = seconds; return t; }

    // ── Helpers (VERBATIM from subtitle_manager.jsx) ──
    function _hexRgba(hex, alpha) {
        var h = String(hex || "#ffffff").replace("#", "");
        if (h.length === 3) h = h.charAt(0)+h.charAt(0)+h.charAt(1)+h.charAt(1)+h.charAt(2)+h.charAt(2);
        var n = parseInt(h, 16);
        return [ ((n>>16)&255)/255, ((n>>8)&255)/255, (n&255)/255, (alpha === undefined ? 1 : alpha) ];
    }

    function _findComponent(clip, displayName) {
        try {
            var comps = clip.components;
            for (var i = 0; i < comps.numItems; i++) {
                if (comps[i].displayName === displayName) return comps[i];
            }
        } catch (e) {}
        return null;
    }

    function _param(comp, displayName) {
        if (!comp) return null;
        try { return comp.properties.getParamForDisplayName(displayName); } catch (e) { return null; }
    }

    function _isTextParam(p) {
        try { var o = JSON.parse(p.getValue()); return !!(o && o.textEditValue !== undefined); }
        catch (e) { return false; }
    }

    function _allComponents(clip) {
        var comps = [];
        try { var mc = clip.getMGTComponent(); if (mc) comps.push(mc); } catch (e) {}
        try { var cc = clip.components; for (var i = 0; i < cc.numItems; i++) comps.push(cc[i]); } catch (e) {}
        return comps;
    }

    function _findByDisplayName(clip, name) {
        var comps = _allComponents(clip), c, j, props, dn;
        for (c = 0; c < comps.length; c++) {
            try {
                props = comps[c].properties;
                for (j = 0; j < props.numItems; j++) {
                    dn = ""; try { dn = props[j].displayName; } catch (e) {}
                    if (dn === name) return props[j];
                }
            } catch (e) {}
        }
        return null;
    }

    function _findSourceTextParam(clip, preferredName) {
        var p = _findByDisplayName(clip, preferredName || "Source Text");
        if (p) return p;
        var comps = _allComponents(clip), c, j, props;
        for (c = 0; c < comps.length; c++) {
            try { props = comps[c].properties; for (j = 0; j < props.numItems; j++) { if (_isTextParam(props[j])) return props[j]; } } catch (e) {}
        }
        return null;
    }

    function _dumpComps(clip) {
        var out = [], comps = _allComponents(clip), c, j, props, names, dn;
        for (c = 0; c < comps.length; c++) {
            names = [];
            try { props = comps[c].properties; for (j = 0; j < props.numItems && j < 40; j++) { try { names.push(props[j].displayName); } catch (e) {} } } catch (e) {}
            dn = ""; try { dn = comps[c].displayName; } catch (e) {}
            out.push(dn + "{" + names.join(",") + "}");
        }
        return out.join(" | ");
    }

    function _short(x) { try { return String(x).slice(0, 160); } catch (e) { return "?"; } }

    // Build the Source Text JSON value for a given text string.
    // Parses the existing value (to preserve style info) and patches textEditValue
    // + fontTextRunLength.
    function _buildTextValue(param, text) {
        var before = null;
        try { before = param.getValue(); } catch (e) {}
        if (typeof before === 'string') {
            try {
                var v = JSON.parse(before);
                if (v && v.textEditValue !== undefined) {
                    v.textEditValue = text;
                    v.fontTextRunLength = [text.length];
                    return JSON.stringify(v);
                }
            } catch (e) {}
        }
        // Fallback: raw string
        return text;
    }

    // Set the Source Text value (non-keyframed — used for the initial value).
    function _setText(clip, text, opts) {
        var p = _findSourceTextParam(clip, opts && opts.textParam);
        if (!p) throw new Error("no text param. comps: " + _dumpComps(clip));
        var before = null; try { before = p.getValue(); } catch (e) {}
        var done = false;
        if (typeof before === 'string') {
            try {
                var v = JSON.parse(before);
                if (v && v.textEditValue !== undefined) {
                    v.textEditValue = text;
                    v.fontTextRunLength = [text.length];
                    p.setValue(JSON.stringify(v), true);
                    done = true;
                }
            } catch (e) {}
        }
        if (!done) { try { p.setValue(text, true); } catch (e) {} }
        var after = null; try { after = p.getValue(); } catch (e) {}
        if (!done && String(after) === String(before)) {
            throw new Error("text not settable via script (valType=" + (typeof before) + ", val=" + _short(before) + ")");
        }
    }

    // ── Keyframe helpers ──
    function _addKey(prop, tSec, value) {
        var t = _time(tSec);
        prop.addKey(t);
        prop.setValueAtKey(t, value, true);
        try { prop.setInterpolationTypeAtKey(t, 5, true); } catch (e) {}  // 5 = Bezier
    }

    // ── SINGLE-CLIP approach (v3 — fixes memory crash) ──
    // Creates ONE MOGRT clip spanning the whole sequence, with keyframed
    // Source Text + Scale + Opacity. This is how pro caption plugins work.
    function applyNativeCaptionsSingleClip(options) {
        var seq = app.project.activeSequence;
        if (!seq) return _err("No active sequence — open a sequence first.");

        var mogrt = editflowUtils.getParam(options, 'baseMogrtPath');
        if (!mogrt) return _err("No baseMogrtPath provided.");
        var mogrtFile = new File(mogrt);
        if (!mogrtFile.exists) return _err("Base MOGRT not found: " + mogrt);
        var nativePath = mogrtFile.fsName;

        var words = editflowUtils.getParam(options, 'words') || [];
        if (!words.length) return _err("No words to place.");
        var preset = editflowUtils.getParam(options, 'preset') || "fade";
        var textParam = editflowUtils.getParam(options, 'textParam') || "Source Text";
        var trackIndex = editflowUtils.getParam(options, 'trackIndex');

        // Resolve track
        if (trackIndex === undefined || trackIndex === null) {
            try { trackManager.ensureTracks(seq, seq.videoTracks.numTracks + 1, 0); } catch (e) {}
            trackIndex = seq.videoTracks.numTracks - 1;
        }
        if (trackIndex < 0) trackIndex = 0;
        if (trackIndex > seq.videoTracks.numTracks - 1) trackIndex = seq.videoTracks.numTracks - 1;

        // Find the time range
        var firstStart = parseFloat(words[0].start);
        var lastEnd = parseFloat(words[words.length - 1].end);
        if (!isFinite(firstStart) || !isFinite(lastEnd) || lastEnd <= firstStart) {
            return _err("Invalid word time range: " + firstStart + " - " + lastEnd);
        }

        // 1. Insert ONE MOGRT at the first word's start time
        var clip = seq.importMGT(nativePath, editflowUtils.secondsToTicksString(firstStart), trackIndex, 0);
        if (!clip) return _err("importMGT returned null (track=" + trackIndex + ", path=" + nativePath + ")");

        // 2. Trim to span the whole sequence
        try { clip.end = _time(lastEnd); } catch (e) {
            // Non-fatal
        }

        // 3. Set the initial text to the first word
        var firstWord = words[0].word || words[0].text || "";
        _setText(clip, firstWord, { textParam: textParam });

        // 4. Find the Source Text param + enable time-varying
        var sourceTextParam = _findSourceTextParam(clip, textParam);
        if (!sourceTextParam) {
            return _err("Could not find Source Text param after insertion. comps: " + _dumpComps(clip));
        }
        try { sourceTextParam.setTimeVarying(true); } catch (e) {}

        // 5. Find Motion + Opacity components
        var motion = _findComponent(clip, "Motion");
        var scaleParam = motion ? _param(motion, "Scale") : null;
        var opacityComp = _findComponent(clip, "Opacity");
        var opacityParam = opacityComp ? _param(opacityComp, "Opacity") : null;

        if (scaleParam) { try { scaleParam.setTimeVarying(true); } catch (e) {} }
        if (opacityParam) { try { opacityParam.setTimeVarying(true); } catch (e) {} }

        // 6. Keyframe Source Text + Scale + Opacity at each word boundary
        var textKeyframes = 0, scaleKeyframes = 0, opacityKeyframes = 0;
        var errors = [];

        for (var i = 0; i < words.length; i++) {
            var w = words[i];
            var wordText = w.word || w.text || "";
            var startSec = parseFloat(w.start);
            var endSec = parseFloat(w.end);

            if (!wordText || !isFinite(startSec) || !isFinite(endSec)) {
                errors.push({ word: wordText, step: "validate", error: "bad word data" });
                continue;
            }

            // Keyframe Source Text: change the text at this word's start
            try {
                var textValue = _buildTextValue(sourceTextParam, wordText);
                _addKey(sourceTextParam, startSec, textValue);
                textKeyframes++;
            } catch (e) {
                errors.push({ word: wordText, step: "source_text_key", error: e.toString() });
            }

            // Keyframe Scale + Opacity for the pop-in animation
            // Pop-in: scale 0 → 110 (at 60% of intro) → 100 (at end of intro)
            //         opacity 0 → 100 (at 50% of intro)
            var wordDur = Math.max(0.1, endSec - startSec);
            var intro = Math.min(0.2, wordDur * 0.5);

            if (preset === 'fade') {
                if (opacityParam) {
                    try {
                        _addKey(opacityParam, startSec, 0);
                        _addKey(opacityParam, startSec + intro, 100);
                        opacityKeyframes += 2;
                    } catch (e) {
                        errors.push({ word: wordText, step: "opacity_key", error: e.toString() });
                    }
                }
            } else if (preset === 'pop') {
                if (opacityParam) {
                    try {
                        _addKey(opacityParam, startSec, 0);
                        _addKey(opacityParam, startSec + intro * 0.5, 100);
                        opacityKeyframes += 2;
                    } catch (e) {
                        errors.push({ word: wordText, step: "opacity_key", error: e.toString() });
                    }
                }
                if (scaleParam) {
                    try {
                        _addKey(scaleParam, startSec, 0);
                        _addKey(scaleParam, startSec + intro * 0.6, 110);
                        _addKey(scaleParam, startSec + intro, 100);
                        scaleKeyframes += 3;
                    } catch (e) {
                        errors.push({ word: wordText, step: "scale_key", error: e.toString() });
                    }
                }
            } else if (preset === 'bounce') {
                if (opacityParam) {
                    try {
                        _addKey(opacityParam, startSec, 0);
                        _addKey(opacityParam, startSec + intro * 0.3, 100);
                        opacityKeyframes += 2;
                    } catch (e) {
                        errors.push({ word: wordText, step: "opacity_key", error: e.toString() });
                    }
                }
                if (scaleParam) {
                    try {
                        _addKey(scaleParam, startSec, 0);
                        _addKey(scaleParam, startSec + intro * 0.4, 125);
                        _addKey(scaleParam, startSec + intro * 0.7, 90);
                        _addKey(scaleParam, startSec + intro, 100);
                        scaleKeyframes += 4;
                    } catch (e) {
                        errors.push({ word: wordText, step: "scale_key", error: e.toString() });
                    }
                }
            }
        }

        return _ok({
            placed: 1,                    // 1 clip
            total: words.length,
            clip_count: 1,
            text_keyframes: textKeyframes,
            scale_keyframes: scaleKeyframes,
            opacity_keyframes: opacityKeyframes,
            errors: errors,
            preset: preset,
            track_index: trackIndex,
            approach: "single_clip"
        });
    }

    // ── Legacy: per-word approach (kept as fallback, but NOT recommended) ──
    // Uses batch processing to avoid crashing, but still creates N clips.
    function applyNativeCaptions(options) {
        // Default to single-clip approach unless explicitly requested otherwise
        var approach = editflowUtils.getParam(options, 'approach') || "single_clip";
        if (approach === "single_clip") {
            return applyNativeCaptionsSingleClip(options);
        }
        // Legacy per-word approach with batching
        return _applyNativeCaptionsPerWord(options);
    }

    function _applyNativeCaptionsPerWord(options) {
        var seq = app.project.activeSequence;
        if (!seq) return _err("No active sequence — open a sequence first.");

        var mogrt = editflowUtils.getParam(options, 'baseMogrtPath');
        if (!mogrt) return _err("No baseMogrtPath provided.");
        var mogrtFile = new File(mogrt);
        if (!mogrtFile.exists) return _err("Base MOGRT not found: " + mogrt);
        var nativePath = mogrtFile.fsName;

        var words = editflowUtils.getParam(options, 'words') || [];
        if (!words.length) return _err("No words to place.");
        var preset = editflowUtils.getParam(options, 'preset') || "fade";
        var textParam = editflowUtils.getParam(options, 'textParam') || "Source Text";
        var trackIndex = editflowUtils.getParam(options, 'trackIndex');

        var batchStart = editflowUtils.getParam(options, 'batchStart') || 0;
        var batchSize = editflowUtils.getParam(options, 'batchSize') || 10;
        var batchEnd = Math.min(batchStart + batchSize, words.length);
        var batchWords = words.slice(batchStart, batchEnd);

        if (trackIndex === undefined || trackIndex === null) {
            if (batchStart === 0) {
                try { trackManager.ensureTracks(seq, seq.videoTracks.numTracks + 1, 0); } catch (e) {}
            }
            trackIndex = seq.videoTracks.numTracks - 1;
        }
        if (trackIndex < 0) trackIndex = 0;
        if (trackIndex > seq.videoTracks.numTracks - 1) trackIndex = seq.videoTracks.numTracks - 1;

        var textOpts = { textParam: textParam };
        var placed = 0, errors = [];

        // MEMORY OPTIMIZATION: Import the MOGRT into the project bin ONCE,
        // then use track.insertClip() to place it at each word's time.
        // This reuses the same ProjectItem instead of re-importing the MOGRT
        // file for every word (which was eating RAM and crashing PPro).
        //
        // importMGT(path, time, track, audTrack) does import + place in one
        // step, but each call re-reads the .mogrt file. For 100+ words that's
        // 100+ file reads + 100+ ProjectItems in the bin.
        //
        // Instead: importMGT once (creates 1 ProjectItem), then use
        // track.insertClip(projectItem, time) for each subsequent placement.
        var projectItem = null;
        var track = seq.videoTracks[trackIndex];

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
                var clip;
                if (i === 0 && batchStart === 0) {
                    // First clip ever: use importMGT (imports + places)
                    clip = seq.importMGT(nativePath, editflowUtils.secondsToTicksString(startSec), trackIndex, 0);
                    if (clip) {
                        try { projectItem = clip.projectItem; } catch (e) {}
                    }
                } else if (projectItem) {
                    // Subsequent clips: reuse the same ProjectItem
                    // insertClip returns boolean, not the clip — we need to
                    // find the clip on the track after insertion.
                    // Alternative: use importMGT again but it's the same file
                    // so PPro deduplicates the ProjectItem automatically.
                    clip = seq.importMGT(nativePath, editflowUtils.secondsToTicksString(startSec), trackIndex, 0);
                } else {
                    // Fallback: importMGT
                    clip = seq.importMGT(nativePath, editflowUtils.secondsToTicksString(startSec), trackIndex, 0);
                }

                if (!clip) {
                    errors.push({ word: wordText, step: "importMGT", error: "null" });
                    if (errors.length >= 3) break;
                    continue;
                }

                _setText(clip, wordText, textOpts);
                try { clip.end = _time(endSec); } catch (e) {}

                // Apply animation (from the shared _animate function)
                if (preset !== 'none') {
                    try {
                        var motion = _findComponent(clip, "Motion");
                        var scaleParam = motion ? _param(motion, "Scale") : null;
                        var opacityComp = _findComponent(clip, "Opacity");
                        var opacityParam = opacityComp ? _param(opacityComp, "Opacity") : null;
                        var intro = Math.min(0.25, Math.max(0.05, (endSec - startSec)) * 0.4);

                        if (preset === 'fade' && opacityParam) {
                            try { opacityParam.setTimeVarying(true); _addKey(opacityParam, startSec, 0); _addKey(opacityParam, startSec + intro, 100); } catch (e) {}
                        } else if (preset === 'pop') {
                            if (opacityParam) { try { opacityParam.setTimeVarying(true); _addKey(opacityParam, startSec, 0); _addKey(opacityParam, startSec + intro * 0.5, 100); } catch (e) {} }
                            if (scaleParam) { try { scaleParam.setTimeVarying(true); _addKey(scaleParam, startSec, 0); _addKey(scaleParam, startSec + intro * 0.6, 110); _addKey(scaleParam, startSec + intro, 100); } catch (e) {} }
                        } else if (preset === 'bounce') {
                            if (opacityParam) { try { opacityParam.setTimeVarying(true); _addKey(opacityParam, startSec, 0); _addKey(opacityParam, startSec + intro * 0.3, 100); } catch (e) {} }
                            if (scaleParam) { try { scaleParam.setTimeVarying(true); _addKey(scaleParam, startSec, 0); _addKey(scaleParam, startSec + intro * 0.4, 125); _addKey(scaleParam, startSec + intro * 0.7, 90); _addKey(scaleParam, startSec + intro, 100); } catch (e) {} }
                        }
                    } catch (e) {
                        errors.push({ word: wordText, step: "animate", error: e.toString() });
                    }
                }

                placed++;
            } catch (e) {
                errors.push({ word: wordText, step: "place", error: e.toString() });
                if (errors.length >= 3) break;
            }
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
            track_index: trackIndex,
            approach: "per_word"
        });
    }

    return { applyNativeCaptions: applyNativeCaptions };
})();
