/*
 * diagnostic_probe.jsx — Pre-flight check for native animated captions.
 *
 * Before the panel lets the user Generate captions, it runs this probe to
 * verify that importMGT, Source Text patching, and Motion/Opacity keyframes
 * all work on the user's specific Premiere version. Returns a JSON report
 * the panel renders in a collapsible drawer.
 *
 * The probe:
 *   1. Inserts one test MOGRT at the playhead
 *   2. Dumps all components + properties (displayName + matchName)
 *   3. Tests Source Text JSON patch + verify
 *   4. Tests Motion.Scale keyframe (setTimeVarying + addKey + setValueAtKey)
 *   5. Tests Opacity.Opacity keyframe (same)
 *   6. Cleans up (removes the test clip)
 *   7. Returns { steps: [...], passed: N, failed: N, summary: "..." }
 *
 * Helpers below are copied VERBATIM from subtitle_manager.jsx so the probe
 * stays self-contained — subtitle_manager.jsx does not export them.
 */
diagnosticProbe = (function() {
    "use strict";

    function _ok(obj)  { obj = obj || {}; obj.success = true;  return editflowUtils.safeStringify(obj); }
    function _err(msg) { return editflowUtils.safeStringify({ success: false, error: String(msg) }); }

    function _time(seconds) { var t = new Time(); t.seconds = seconds; return t; }

    // ── Helpers copied verbatim from subtitle_manager.jsx ──
    // (_hexRgba + _findParam are dependencies of _setText; they are copied
    //  unchanged so _setText compiles and behaves identically.)

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

    // ── Probe-only helpers ──

    function _step(name, fn) {
        try {
            var result = fn();
            return { step: name, ok: true, details: result || null };
        } catch (e) {
            return { step: name, ok: false, error: e.toString(), details: null };
        }
    }

    // Read the value of a keyframed param at a Time. Per docsforadobe.dev the
    // canonical API is getValueAtTime(time, allowInterpolation); older builds
    // only expose getValueAtKey(time). Try both and report which one worked so
    // the panel can show the user exactly what their Premiere supports.
    function _readKeyVal(prop, t) {
        var out = { value: null, method: "none", error: null };
        try {
            if (typeof prop.getValueAtTime === 'function') {
                try {
                    out.value = prop.getValueAtTime(t, true);
                    out.method = "getValueAtTime(t,true)";
                    return out;
                } catch (e1) {
                    try {
                        out.value = prop.getValueAtTime(t);
                        out.method = "getValueAtTime(t)";
                        return out;
                    } catch (e2) { out.error = "getValueAtTime threw: " + e2.toString(); }
                }
            } else {
                out.error = "getValueAtTime not a function";
            }
        } catch (e) { out.error = "getValueAtTime probe threw: " + e.toString(); }
        // Fallback to getValueAtKey
        try {
            if (typeof prop.getValueAtKey === 'function') {
                out.value = prop.getValueAtKey(t);
                out.method = "getValueAtKey(t)";
                out.error = null;
            }
        } catch (e3) {
            out.error = (out.error ? out.error + " | " : "") + "getValueAtKey threw: " + e3.toString();
        }
        return out;
    }

    // ── Main entry point ──

    function runProbe(options) {
        var report = {
            steps: [],
            passed: 0,
            failed: 0,
            premiere_version: "",
            qe_available: false,
            mogrt_path: "",
            trackIndex: -1,
            playhead_sec: 0,
            summary: ""
        };

        try { report.premiere_version = app.version; } catch (e) {}
        try { report.qe_available = (typeof qe !== 'undefined'); } catch (e) {}

        var seq = app.project.activeSequence;
        if (!seq) return _err("No active sequence — open a sequence first.");

        var mogrtPath = editflowUtils.getParam(options, 'baseMogrtPath', 'mogrtPath');
        if (!mogrtPath) return _err("No baseMogrtPath provided.");
        var mogrtFile = new File(mogrtPath);
        if (!mogrtFile.exists) return _err("Base MOGRT not found: " + mogrtPath);
        report.mogrt_path = mogrtFile.fsName;

        // Pick a track index (use the top video track; create one if needed).
        var trackIndex = seq.videoTracks.numTracks - 1;
        if (trackIndex < 0) trackIndex = 0;
        report.trackIndex = trackIndex;

        // Use the current playhead time as the insertion point.
        var playheadTicks = null;
        try { playheadTicks = seq.getPlayerPosition(); } catch (e) {}
        if (playheadTicks === null) return _err("seq.getPlayerPosition() failed — open a sequence first.");
        var playheadSec = editflowUtils.ticksToSeconds(playheadTicks);
        report.playhead_sec = playheadSec;

        var textParamName = editflowUtils.getParam(options, 'textParam') || "Source Text";

        var testClip = null;

        // ── Step 1: Insert test MOGRT ──
        report.steps.push(_step("insert_mogrt", function() {
            // importMGT needs the OS-native path (fsName) and a tick STRING.
            testClip = seq.importMGT(
                mogrtFile.fsName,
                editflowUtils.secondsToTicksString(playheadSec),
                trackIndex,
                0
            );
            if (!testClip) {
                throw new Error(
                    "importMGT returned null (track=" + trackIndex +
                    ", path=" + mogrtFile.fsName +
                    "). Place the playhead in an empty area of the top video track."
                );
            }
            return {
                trackIndex: trackIndex,
                start_sec: playheadSec,
                clipName: (function() { try { return testClip.name; } catch (e) { return "?"; } })()
            };
        }));

        // ── Step 2: Dump components + properties ──
        report.steps.push(_step("dump_components", function() {
            if (!testClip) throw new Error("testClip is null (step 1 failed)");
            var comps = _allComponents(testClip);
            var dump = [];
            for (var i = 0; i < comps.length; i++) {
                var c = comps[i];
                var names = [];
                var matchName = "";
                try {
                    var props = c.properties;
                    for (var j = 0; j < props.numItems && j < 40; j++) {
                        try { names.push(props[j].displayName); } catch (e) {}
                    }
                } catch (e) {}
                var dn = ""; try { dn = c.displayName; } catch (e) {}
                try { matchName = c.matchName; } catch (e) {}
                dump.push({ displayName: dn, matchName: matchName, properties: names });
            }
            return { componentCount: comps.length, components: dump, raw: _dumpComps(testClip) };
        }));

        // ── Step 3: Test Source Text patch ──
        report.steps.push(_step("source_text_patch", function() {
            if (!testClip) throw new Error("testClip is null (step 1 failed)");
            var p = _findSourceTextParam(testClip, textParamName);
            if (!p) throw new Error(
                "No Source Text param found (searched displayName='" + textParamName +
                "' + JSON shape probe). comps: " + _dumpComps(testClip)
            );
            var before = null;
            try { before = p.getValue(); } catch (e) { throw new Error("p.getValue() threw: " + e.toString()); }

            // Use the verbatim _setText from subtitle_manager.jsx — it does the
            // JSON-patch (textEditValue + fontTextRunLength) AND the raw-string
            // fallback AND the read-back verification. Throws on read-only.
            _setText(testClip, "PROBE", { textParam: textParamName });

            var after = null; try { after = p.getValue(); } catch (e) {}
            if (String(after) === String(before)) {
                throw new Error("setValue did not change the value (read-only Source Text)");
            }
            return {
                before_length: String(before).length,
                after_length: String(after).length,
                before_preview: _short(before),
                after_preview: _short(after)
            };
        }));

        // ── Step 4: Test Motion.Scale keyframe ──
        report.steps.push(_step("motion_scale_keyframe", function() {
            if (!testClip) throw new Error("testClip is null (step 1 failed)");
            var motion = _findComponent(testClip, "Motion");
            if (!motion) throw new Error("No 'Motion' component found. comps: " + _dumpComps(testClip));
            var scale = _param(motion, "Scale");
            if (!scale) throw new Error("Motion component has no 'Scale' param. motion props: " + _dumpComps(testClip));

            // The canonical keyframe pattern per Adobe's Bruce Bullis:
            //   setTimeVarying(true) -> addKey(t) -> setValueAtKey(t, v, true)
            scale.setTimeVarying(true);
            var t1 = _time(playheadSec);
            var t2 = _time(playheadSec + 0.1);
            scale.addKey(t1);
            scale.setValueAtKey(t1, 50, true);
            scale.addKey(t2);
            scale.setValueAtKey(t2, 100, true);

            // Verify: read values back. Try getValueAtTime(t, true) first;
            // fall back to getValueAtKey(t). Report which method worked.
            var r1 = _readKeyVal(scale, t1);
            var r2 = _readKeyVal(scale, t2);
            if (r1.value === null || r2.value === null) {
                throw new Error(
                    "Could not read keyframe values back. r1=" + JSON.stringify(r1) +
                    " r2=" + JSON.stringify(r2)
                );
            }
            return {
                first_key:  r1.value,
                second_key: r2.value,
                read_method: r1.method,
                read_errors: (r1.error || r2.error) ? [r1.error, r2.error] : null
            };
        }));

        // ── Step 5: Test Opacity.Opacity keyframe ──
        report.steps.push(_step("opacity_keyframe", function() {
            if (!testClip) throw new Error("testClip is null (step 1 failed)");
            var opacityComp = _findComponent(testClip, "Opacity");
            if (!opacityComp) throw new Error("No 'Opacity' component found. comps: " + _dumpComps(testClip));
            var opacity = _param(opacityComp, "Opacity");
            if (!opacity) throw new Error("Opacity component has no 'Opacity' param. comps: " + _dumpComps(testClip));

            opacity.setTimeVarying(true);
            var t1 = _time(playheadSec);
            var t2 = _time(playheadSec + 0.1);
            opacity.addKey(t1);
            opacity.setValueAtKey(t1, 0, true);
            opacity.addKey(t2);
            opacity.setValueAtKey(t2, 100, true);

            var r1 = _readKeyVal(opacity, t1);
            var r2 = _readKeyVal(opacity, t2);
            if (r1.value === null || r2.value === null) {
                throw new Error(
                    "Could not read opacity keyframe values back. r1=" + JSON.stringify(r1) +
                    " r2=" + JSON.stringify(r2)
                );
            }
            return {
                first_key:  r1.value,
                second_key: r2.value,
                read_method: r1.method,
                read_errors: (r1.error || r2.error) ? [r1.error, r2.error] : null
            };
        }));

        // ── Step 6: Cleanup — remove the test clip ──
        // The probe MUST clean up after itself. This step never throws so a
        // cleanup that requires manual deletion does NOT mark the probe as
        // failed — Generate stays enabled if all API tests passed.
        //
        // Premiere 26 removed qe.project.undoAction(). We try multiple strategies:
        //   1. TrackItem.remove() (exists on some PPro versions)
        //   2. qe.project.undoAction() (older PPro versions)
        //   3. Remove via track.clips collection + QE DOM clip.remove()
        //   4. Fallback: warn user to delete manually
        report.steps.push(_step("cleanup", function() {
            var methods = [];

            // Strategy 1: TrackItem.remove() (newer Premiere versions)
            if (testClip) {
                try {
                    if (typeof testClip.remove === 'function') {
                        testClip.remove();
                        return { method: "clip.remove", manualCleanupNeeded: false };
                    }
                    methods.push("clip.remove: not a function");
                } catch (e) {
                    methods.push("clip.remove threw: " + e.toString());
                }
            }

            // Strategy 2: qe.project.undoAction() (older PPro — removed in PPro 26)
            if (typeof qe !== 'undefined') {
                try {
                    if (typeof qe.project.undoAction === 'function') {
                        qe.project.undoAction();
                        return { method: "undo", manualCleanupNeeded: false };
                    }
                    methods.push("qe.project.undoAction: not a function (PPro 26+)");
                } catch (e) {
                    methods.push("undo threw: " + e.toString());
                }
            }

            // Strategy 3: Find the clip on the track and remove it via QE DOM
            if (typeof qe !== 'undefined' && testClip) {
                try {
                    var qeSeq = qe.project.getActiveSequence();
                    if (qeSeq) {
                        var qeTrack = qeSeq.getVideoTrackAt(trackIndex);
                        if (qeTrack) {
                            var clipRemoved = false;
                            try {
                                var qeClips = qeTrack.clips;
                                if (qeClips && qeClips.numItems !== undefined) {
                                    for (var ci = 0; ci < qeClips.numItems; ci++) {
                                        var qeClip = qeClips[ci];
                                        if (qeClip && Math.abs(parseFloat(qeClip.start.ticks || 0) - playheadTicks) < 254016000000) {
                                            if (typeof qeClip.remove === 'function') {
                                                qeClip.remove();
                                                clipRemoved = true;
                                                break;
                                            }
                                        }
                                    }
                                }
                            } catch (e2) {
                                methods.push("qeClips iteration: " + e2.toString());
                            }
                            if (clipRemoved) {
                                return { method: "qeClip.remove", manualCleanupNeeded: false };
                            }
                        }
                    }
                } catch (e) {
                    methods.push("qe track clip removal: " + e.toString());
                }
            }

            // Strategy 4: Fallback — warn user
            return {
                method: "manual",
                manualCleanupNeeded: true,
                message: "Could not auto-remove the test clip. Please select the 'Graphic' clip on track " + trackIndex + " at " + playheadSec.toFixed(1) + "s and press Delete.",
                methods_tried: methods
            };
        }));

        // ── Aggregate ──
        for (var i = 0; i < report.steps.length; i++) {
            if (report.steps[i].ok) report.passed++;
            else report.failed++;
        }
        report.summary = report.passed + "/" + report.steps.length + " steps passed";

        return _ok(report);
    }

    return { runProbe: runProbe };
})();
