/*
 * subtitle_manager.jsx — Built-in animated captions for EditFlow AI.
 *
 * Premiere has no API to CREATE text by script, so each caption is stamped from
 * a STATIC base text graphic (base_text.mogrt — a plain text graphic, no AE
 * animation) via importMGT, then animated by KEYFRAMING the clip's own
 * Motion/Opacity (none/fade/pop/slide/bounce) or, for karaoke, by keyframing a
 * Crop reveal on a stacked highlight copy. No MOGRT animation, no After Effects.
 *
 * Units: importMGT placement time is a tick STRING; component keyframes take a
 * Time object in SECONDS (NOT ticks). Whether keyframe time is sequence- or
 * clip-relative is verified live and controlled by KF_BASE below.
 */
subtitleManager = (function() {
    "use strict";

    // 'sequence' = keyframe times are absolute sequence seconds (cue.start+off);
    // 'clip' = relative to the clip's own start. Flip after the live spike.
    var KF_BASE = 'sequence';

    function _ok(obj)  { obj = obj || {}; obj.success = true;  return editflowUtils.safeStringify(obj); }
    function _err(msg) { return editflowUtils.safeStringify({ success: false, error: String(msg) }); }

    function _time(seconds) { var t = new Time(); t.seconds = seconds; return t; }

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

    // ── Sequence frame (so the panel/backend can size things) ──
    function getSequenceVideoSettings() {
        var seq = app.project.activeSequence;
        if (!seq) return _err("No active sequence.");
        try {
            var s = seq.getSettings();
            return _ok({
                width: s.videoFrameWidth,
                height: s.videoFrameHeight,
                fps: (s.videoFrameRate && s.videoFrameRate.seconds)
                        ? Math.round(1 / s.videoFrameRate.seconds) : 0,
                parNum: s.videoPixelAspectRatio || 1,
                durationSeconds: editflowUtils.getSequenceEnd(seq),
                videoTracks: seq.videoTracks.numTracks
            });
        } catch (e) { return _err(e); }
    }

    // A "Source Text" param is any param whose value parses to JSON carrying a
    // textEditValue field — true regardless of its display name. Premiere-made
    // MOGRTs expose it under the LAYER name, not "Source Text", so probe by shape.
    function _isTextParam(p) {
        try { var o = JSON.parse(p.getValue()); return !!(o && o.textEditValue !== undefined); }
        catch (e) { return false; }
    }
    // Premiere-authored graphics often return null from getMGTComponent(), so
    // search EVERY component's properties — the text param is the one whose value
    // parses to JSON with a textEditValue field, whatever its display name.
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
        // 1) by display name — works on native graphic components, where
        //    getParamForDisplayName is unreliable / the value isn't MOGRT JSON.
        var p = _findByDisplayName(clip, preferredName || "Source Text");
        if (p) return p;
        // 2) fallback: probe for the MOGRT-style {textEditValue} JSON value.
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

    // ── Set the Source Text (+ optional colors) on a placed graphic ──
    function _setText(clip, text, opts) {
        var p = _findSourceTextParam(clip, opts && opts.textParam);
        if (!p) throw new Error("no text param. comps: " + _dumpComps(clip));
        var before = null; try { before = p.getValue(); } catch (e) {}
        var done = false;
        // MOGRT-style structured JSON value (AE-authored templates).
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
        // Native graphic param — try setting the raw string.
        if (!done) { try { p.setValue(text, true); } catch (e) {} }
        // Verify the write took; native Source Text is often read-only to script.
        var after = null; try { after = p.getValue(); } catch (e) {}
        if (!done && String(after) === String(before)) {
            throw new Error("text not settable via script (valType=" + (typeof before) + ", val=" + _short(before) + ")");
        }

        if (opts && opts.textColor) {
            var tc = _findParam(clip, opts.textColorParam || "Text Color");
            if (tc) { try { tc.setValue(_hexRgba(opts.textColor, 1), true); } catch (e) {} }
        }
        if (opts && opts.bgColor) {
            var bc = _findParam(clip, opts.bgColorParam || "Background Color");
            if (bc) { try { bc.setValue(_hexRgba(opts.bgColor, 1), true); } catch (e) {} }
        }
    }

    // ── Keyframe helpers (Time objects in seconds) ──
    function _baseSec(clip, cueStart) {
        if (KF_BASE === 'clip') {
            try { return clip.start.seconds; } catch (e) { return cueStart; }
        }
        return cueStart;  // sequence-absolute
    }

    function _keyNum(prop, t0, pairs) {
        // pairs: [[offsetSec, value], ...]
        prop.setTimeVarying(true);
        for (var i = 0; i < pairs.length; i++) {
            var tm = _time(t0 + pairs[i][0]);
            prop.addKey(tm);
            prop.setValueAtKey(tm, pairs[i][1], true);
            try { prop.setInterpolationTypeAtKey(tm, 5, true); } catch (e) {}  // 5 = Bezier
        }
    }

    function _animate(clip, animation, cueStart, cueEnd) {
        var dur = Math.max(0.05, cueEnd - cueStart);
        var intro = Math.min(0.35, dur * 0.5);
        var t0 = _baseSec(clip, cueStart);
        var motion = _findComponent(clip, "Motion");
        var opacityComp = _findComponent(clip, "Opacity");
        var scale = _param(motion, "Scale");
        var pos = _param(motion, "Position");
        var opacity = _param(opacityComp, "Opacity");

        try {
            if (animation === "fade" && opacity) {
                _keyNum(opacity, t0, [[0, 0], [intro, 100]]);
            } else if (animation === "pop" && scale) {
                _keyNum(scale, t0, [[0, 0], [intro * 0.7, 110], [intro, 100]]);
            } else if (animation === "bounce" && scale) {
                _keyNum(scale, t0, [[0, 0], [intro * 0.5, 120], [intro * 0.8, 90], [intro, 100]]);
            } else if (animation === "slide_up" && pos) {
                var base = pos.getValue();                 // [x,y], normalized 0..1 in PPro
                if (base && base.length >= 2) {
                    _keyNum2(pos, t0, [[0, [base[0], base[1] + 0.08]], [intro, [base[0], base[1]]]]);
                }
                if (opacity) _keyNum(opacity, t0, [[0, 0], [intro, 100]]);
            }
        } catch (e) {}
    }

    function _keyNum2(prop, t0, pairs) {
        prop.setTimeVarying(true);
        for (var i = 0; i < pairs.length; i++) {
            var tm = _time(t0 + pairs[i][0]);
            prop.addKey(tm);
            prop.setValueAtKey(tm, pairs[i][1], true);
        }
    }

    // ── Main: place + animate caption clips ──
    function placeSubtitleClips(options) {
        var seq = app.project.activeSequence;
        if (!seq) return _err("No active sequence — open a sequence first.");

        var mogrt = editflowUtils.getParam(options, 'baseMogrtPath', 'mogrtPath');
        if (!mogrt) return _err("No base graphic path (baseMogrtPath).");
        var mogrtFile = new File(mogrt);
        if (!mogrtFile.exists) return _err("Base graphic not found: " + mogrt);
        // importMGT needs the OS-native path (backslashes on Windows); File.exists
        // accepts forward slashes but the importer returns null for them.
        var nativePath = mogrtFile.fsName;

        var cues = editflowUtils.getParam(options, 'cues') || [];
        if (!cues.length) return _err("No cues to place.");
        var animation = editflowUtils.getParam(options, 'animation') || "none";
        var style = editflowUtils.getParam(options, 'style') || {};
        var trackIndex = editflowUtils.getParam(options, 'trackIndex');
        if (trackIndex === undefined || trackIndex === null) {
            // Add a fresh empty video track on top so captions never overwrite
            // existing clips, then target it. importMGT needs a REAL track index
            // (0-based); numTracks itself is out of range and returns null.
            try { trackManager.ensureTracks(seq, seq.videoTracks.numTracks + 1, 0); } catch (e) {}
            trackIndex = seq.videoTracks.numTracks - 1;
        }
        if (trackIndex < 0) trackIndex = 0;
        if (trackIndex > seq.videoTracks.numTracks - 1) trackIndex = seq.videoTracks.numTracks - 1;

        var textOpts = {
            textParam: editflowUtils.getParam(options, 'textParam') || "Source Text",
            textColor: style.textColor, bgColor: style.bgColor
        };

        var placed = 0, errors = [];
        for (var i = 0; i < cues.length; i++) {
            var cue = cues[i];
            try {
                var clip = seq.importMGT(nativePath, editflowUtils.secondsToTicksString(cue.start), trackIndex, 0);
                if (!clip) { errors.push("cue " + i + ": importMGT null (track=" + trackIndex + ", path=" + nativePath + ")"); continue; }
                _setText(clip, cue.text, textOpts);
                try { clip.end = _time(cue.end); } catch (e) {}
                if (animation !== "none") _animate(clip, animation, cue.start, cue.end);
                placed++;
            } catch (e) {
                errors.push("cue " + i + ": " + e.toString());
                if (errors.length >= 3) break;   // bail fast on a systemic failure
            }
        }
        return _ok({ placed: placed, total: cues.length, errors: errors });
    }

    return {
        getSequenceVideoSettings: getSequenceVideoSettings,
        placeSubtitleClips: placeSubtitleClips
    };
})();
