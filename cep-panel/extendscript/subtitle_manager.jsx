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
    function _findSourceTextParam(comp, preferredName) {
        var p = _param(comp, preferredName || "Source Text");
        if (p && _isTextParam(p)) return p;
        try {
            var props = comp.properties;
            for (var i = 0; i < props.numItems; i++) {
                if (_isTextParam(props[i])) return props[i];
            }
        } catch (e) {}
        return null;
    }

    // ── Set the Source Text (+ optional colors) on a placed graphic ──
    function _setText(clip, text, opts) {
        var comp = clip.getMGTComponent();
        if (!comp) throw new Error("Clip has no MOGRT component (base graphic must expose an editable text param).");
        var p = _findSourceTextParam(comp, opts && opts.textParam);
        if (!p) throw new Error("Base graphic exposes no editable text param (textEditValue).");
        var v = JSON.parse(p.getValue());
        v.textEditValue = text;
        v.fontTextRunLength = [text.length];
        p.setValue(JSON.stringify(v), true);

        if (opts && opts.textColor) {
            var tc = _param(comp, opts.textColorParam || "Text Color");
            if (tc) { try { tc.setValue(_hexRgba(opts.textColor, 1), true); } catch (e) {} }
        }
        if (opts && opts.bgColor) {
            var bc = _param(comp, opts.bgColorParam || "Background Color");
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
        if (!(new File(mogrt)).exists) return _err("Base graphic not found: " + mogrt);

        var cues = editflowUtils.getParam(options, 'cues') || [];
        if (!cues.length) return _err("No cues to place.");
        var animation = editflowUtils.getParam(options, 'animation') || "none";
        var style = editflowUtils.getParam(options, 'style') || {};
        var trackIndex = editflowUtils.getParam(options, 'trackIndex');
        if (trackIndex === undefined || trackIndex === null) trackIndex = seq.videoTracks.numTracks; // new top track

        var textOpts = {
            textParam: editflowUtils.getParam(options, 'textParam') || "Source Text",
            textColor: style.textColor, bgColor: style.bgColor
        };

        var placed = 0, errors = [];
        for (var i = 0; i < cues.length; i++) {
            var cue = cues[i];
            try {
                var clip = seq.importMGT(mogrt, editflowUtils.secondsToTicksString(cue.start), trackIndex, 0);
                if (!clip) { errors.push("cue " + i + ": importMGT returned null"); continue; }
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
