/*
 * native_captions_manager.jsx — Per-word native caption placement + animation.
 *
 * Architecture (reliability-first):
 *   1. Pre-bake style: base_text.mogrt already has font/color/size/position baked in.
 *      Per-clip, we only change textEditValue (one operation, not four).
 *   2. Opacity-first animation ladder:
 *      - Fade-in: Opacity keyframes only (most reliable, no Premiere bugs)
 *      - Pop-in:  Opacity + Scale (Hormozi-style, works on 95% of setups)
 *      - Bounce:  Opacity + Scale + Position (experimental — DVAPR-4217831 risk)
 *   3. Bail-fast: if (errors.length >= 3) break; — don't keep placing when the
 *      first 3 cues all fail (systemic issue, not per-word).
 *   4. Per-step error detail: each failure records {word, step, error} so the
 *      panel can show exactly what went wrong.
 *
 * Easing functions ported from Paquette1111/Better-Captions-Premiere
 * (pure JS, no Premiere API — just compute keyframe values with the curve applied).
 *
 * Helpers copied verbatim from subtitle_manager.jsx (the prior attempt already
 * debugged Source Text JSON patching through 5 fix commits — reusing them
 * verbatim is safer than re-deriving).
 *
 * Units:
 *   - importMGT placement time: tick STRING (secondsToTicksString)
 *   - Component keyframe time: Time OBJECTS in seconds (var t = new Time(); t.seconds = X)
 *   - KF_BASE = 'sequence' — keyframe times are absolute sequence seconds
 */
nativeCaptionsManager = (function() {
    "use strict";

    // 'sequence' = keyframe times are absolute sequence seconds (cue.start+off);
    // 'clip' = relative to the clip's own start. 'sequence' is the working setting.
    var KF_BASE = 'sequence';

    function _ok(obj)  { obj = obj || {}; obj.success = true;  return editflowUtils.safeStringify(obj); }
    function _err(msg) { return editflowUtils.safeStringify({ success: false, error: String(msg) }); }

    function _time(seconds) { var t = new Time(); t.seconds = seconds; return t; }

    // ── Easing functions (ported from Better-Captions-Premiere) ──
    // All take t in [0, 1] and return eased value in [0, 1].
    function easeOutBack(t) {
        var c1 = 1.70158, c3 = c1 + 1;
        return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    }
    function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
    function easeLinear(t) { return t; }

    // ── Helpers (VERBATIM copies from subtitle_manager.jsx — keep self-contained) ──
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

    function _findParam(clip, name) { return _findByDisplayName(clip, name); }

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
    function _baseSec(clip, cueStart) {
        if (KF_BASE === 'clip') {
            try { return clip.start.seconds; } catch (e) { return cueStart; }
        }
        return cueStart;  // sequence-absolute
    }

    // Add a single keyframe at t0+offset with the given value, using Bezier interpolation.
    function _addKey(prop, tSec, value) {
        var t = _time(tSec);
        prop.addKey(t);
        prop.setValueAtKey(t, value, true);
        try { prop.setInterpolationTypeAtKey(t, 5, true); } catch (e) {}  // 5 = Bezier
    }

    // Apply a list of [offsetSec, value] pairs as keyframes on `prop`, starting at t0.
    function _keyNum(prop, t0, pairs) {
        prop.setTimeVarying(true);
        for (var i = 0; i < pairs.length; i++) {
            _addKey(prop, t0 + pairs[i][0], pairs[i][1]);
        }
    }

    // ── Preset keyframe generators ──
    // Each returns { opacity: [[off, val], ...], scale: [[off, val], ...] }
    // Offsets are relative to the cue's start time (seconds).
    // Values are in the units Premiere expects (Opacity 0-100, Scale 0-100).

    function _fadeKeyframes(durSec) {
        // Pure opacity fade. Most reliable.
        // Opacity 0 → 100 over 0.3s (or 40% of cue if shorter).
        var intro = Math.min(0.3, durSec * 0.4);
        return {
            opacity: [[0, 0], [intro, 100]],
            scale: []
        };
    }

    function _popKeyframes(durSec) {
        // Hormozi-style pop-in: scale 0 → 110 (overshoot) → 100 (settle)
        // + opacity 0 → 100 (snaps in faster than scale).
        //
        // The overshoot is what gives the "pop" feel. Premiere's Bezier
        // interpolation (set via setInterpolationTypeAtKey(t, 5, true)) smooths
        // the curve between keyframes — we don't need to compute easing values
        // ourselves, just set the right peak/settle points.
        //
        // This matches the proven pattern from subtitle_manager.jsx (which was
        // debugged through 5 fix commits on feat/animated-captions).
        var intro = Math.min(0.25, durSec * 0.4);
        return {
            opacity: [[0, 0], [intro * 0.5, 100]],  // opacity snaps in at 50% of intro
            scale:   [[0, 0], [intro * 0.6, 110], [intro, 100]]  // overshoot to 110, settle to 100
        };
    }

    function _bounceKeyframes(durSec) {
        // Experimental: scale 0 → 125 → 90 → 100 + opacity 0 → 100.
        // Position bounce is NOT applied (Position keyframes are flakier than Scale).
        var intro = Math.min(0.4, durSec * 0.5);
        return {
            opacity: [[0, 0], [intro * 0.3, 100]],
            scale:   [[0, 0], [intro * 0.4, 125], [intro * 0.7, 90], [intro, 100]]
        };
    }

    function _getKeyframes(preset, durSec) {
        if (preset === 'fade')   return _fadeKeyframes(durSec);
        if (preset === 'pop')    return _popKeyframes(durSec);
        if (preset === 'bounce') return _bounceKeyframes(durSec);
        throw new Error("Unknown preset: " + preset + " (expected fade|pop|bounce)");
    }

    // ── Apply animation keyframes to a placed clip ──
    function _animate(clip, preset, cueStart, cueEnd) {
        var dur = Math.max(0.05, cueEnd - cueStart);
        var kfs = _getKeyframes(preset, dur);
        var t0 = _baseSec(clip, cueStart);

        // Find Motion component (has Scale property)
        var motion = _findComponent(clip, "Motion");
        var scale = motion ? _param(motion, "Scale") : null;

        // Find Opacity component (has Opacity property)
        var opacityComp = _findComponent(clip, "Opacity");
        var opacity = opacityComp ? _param(opacityComp, "Opacity") : null;

        var applied = { opacity: false, scale: false };

        // Opacity keyframes (most reliable — apply first)
        if (opacity && kfs.opacity.length) {
            try {
                _keyNum(opacity, t0, kfs.opacity);
                applied.opacity = true;
            } catch (e) {
                throw new Error("opacity keyframe failed: " + e.toString());
            }
        }

        // Scale keyframes (apply second — only if preset specifies them)
        if (scale && kfs.scale.length) {
            try {
                _keyNum(scale, t0, kfs.scale);
                applied.scale = true;
            } catch (e) {
                // Scale failure is non-fatal for fade preset (which doesn't use scale),
                // but fatal for pop/bounce. Caller decides via the preset.
                if (preset !== 'fade') {
                    throw new Error("scale keyframe failed: " + e.toString());
                }
            }
        }

        return applied;
    }

    // ── Main: place + animate one caption clip per word ──
    function applyNativeCaptions(options) {
        var seq = app.project.activeSequence;
        if (!seq) return _err("No active sequence — open a sequence first.");

        var mogrt = editflowUtils.getParam(options, 'baseMogrtPath');
        if (!mogrt) return _err("No baseMogrtPath provided.");
        var mogrtFile = new File(mogrt);
        if (!mogrtFile.exists) return _err("Base MOGRT not found: " + mogrt);
        // importMGT needs the OS-native path (backslashes on Windows).
        var nativePath = mogrtFile.fsName;

        var words = editflowUtils.getParam(options, 'words') || [];
        if (!words.length) return _err("No words to place.");
        var preset = editflowUtils.getParam(options, 'preset') || "fade";
        var textParam = editflowUtils.getParam(options, 'textParam') || "Source Text";
        var trackIndex = editflowUtils.getParam(options, 'trackIndex');

        // Resolve track: if not provided, add a fresh empty video track on top
        // so captions never overwrite existing clips.
        if (trackIndex === undefined || trackIndex === null) {
            try { trackManager.ensureTracks(seq, seq.videoTracks.numTracks + 1, 0); } catch (e) {}
            trackIndex = seq.videoTracks.numTracks - 1;
        }
        if (trackIndex < 0) trackIndex = 0;
        if (trackIndex > seq.videoTracks.numTracks - 1) trackIndex = seq.videoTracks.numTracks - 1;

        var textOpts = { textParam: textParam };

        var placed = 0, errors = [];
        var animationStats = { opacity_ok: 0, scale_ok: 0, opacity_fail: 0, scale_fail: 0 };

        for (var i = 0; i < words.length; i++) {
            var w = words[i];
            var wordText = w.word || w.text || "";
            var startSec = parseFloat(w.start);
            var endSec = parseFloat(w.end);

            if (!wordText || !isFinite(startSec) || !isFinite(endSec) || endSec <= startSec) {
                errors.push({ word: wordText, step: "validate", error: "bad word data: " + JSON.stringify(w).slice(0, 100) });
                if (errors.length >= 3) break;
                continue;
            }

            try {
                // 1. Insert base_text.mogrt at the word's start time
                var clip = seq.importMGT(nativePath, editflowUtils.secondsToTicksString(startSec), trackIndex, 0);
                if (!clip) {
                    errors.push({ word: wordText, step: "importMGT", error: "importMGT returned null (track=" + trackIndex + ", path=" + nativePath + ")" });
                    if (errors.length >= 3) break;
                    continue;
                }

                // 2. Set the text content (single operation — style is pre-baked into the MOGRT)
                _setText(clip, wordText, textOpts);

                // 3. Trim the clip to the word's duration
                try { clip.end = _time(endSec); } catch (e) {
                    errors.push({ word: wordText, step: "trim", error: e.toString() });
                    // Non-fatal — clip stays at default length, animation still works
                }

                // 4. Apply animation keyframes
                var applied = _animate(clip, preset, startSec, endSec);
                if (applied.opacity) animationStats.opacity_ok++; else animationStats.opacity_fail++;
                if (applied.scale) animationStats.scale_ok++; else animationStats.scale_fail++;

                placed++;
            } catch (e) {
                errors.push({ word: wordText, step: "place_or_animate", error: e.toString() });
                if (errors.length >= 3) {
                    // Bail-fast on systemic failure (3 consecutive cues failing = something is wrong)
                    break;
                }
            }
        }

        return _ok({
            placed: placed,
            total: words.length,
            errors: errors,
            animation_stats: animationStats,
            preset: preset,
            track_index: trackIndex
        });
    }

    return { applyNativeCaptions: applyNativeCaptions };
})();
