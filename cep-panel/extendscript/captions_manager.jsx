/*
 * captions_manager.jsx - Import caption files onto the Premiere Pro timeline.
 *
 * Tier-1 native captions (verified pattern — tmoroney/auto-subs ppro.ts
 * importSRTFile + the official Sequence.createCaptionTrack API):
 *   app.project.importFiles([srt]) -> find the new project item ->
 *   sequence.createCaptionTrack(srtItem, 0).
 *
 * Read-back (readCaptionTimings) and caption-track removal have NO
 * documented ExtendScript API (checked docsforadobe Sequence object —
 * no getter/remover exists), so they are deliberately NOT implemented
 * here. See Phase 4 plan for the probe-first approach.
 */
captionsManager = (function() {
    "use strict";

    function importSRTAsCaptionTrack(options) {
        var srtPath = editflowUtils.getParam(options, 'srt_path', 'srtPath');
        if (!srtPath) {
            srtPath = editflowUtils.getParam(options, 'file', 'path');
        }
        if (!srtPath) {
            return editflowUtils.safeStringify({ success: false, error: "No srt_path provided" });
        }
        if (!app.project) {
            return editflowUtils.safeStringify({ success: false, error: "No project open" });
        }
        var seq = app.project.activeSequence;
        if (!seq) {
            return editflowUtils.safeStringify({ success: false, error: "No active sequence" });
        }

        var rootItem = app.project.rootItem;
        var childCountBefore = rootItem.children.numItems;

        // 1. Import the SRT into the project bin.
        try {
            app.project.importFiles([srtPath], true, rootItem, false);
        } catch (e) {
            return editflowUtils.safeStringify({ success: false, error: "importFiles failed: " + e.toString() });
        }

        // 2. Locate the imported item (new last child, or search by name
        //    when the file was already in the project).
        var srtItem = null;
        try {
            var childCountAfter = rootItem.children.numItems;
            if (childCountAfter > childCountBefore) {
                srtItem = rootItem.children[childCountAfter - 1];
            } else {
                var base = String(srtPath).replace(/\\/g, "/").split("/").pop();
                var dot = base.lastIndexOf(".");
                var stem = dot >= 0 ? base.substring(0, dot) : base;
                for (var i = rootItem.children.numItems - 1; i >= 0; i--) {
                    var child = rootItem.children[i];
                    try {
                        if (child.name && child.name.indexOf(stem) !== -1) {
                            srtItem = child;
                            break;
                        }
                    } catch (ignore1) {}
                }
            }
        } catch (e) {
            return editflowUtils.safeStringify({ success: false, error: "Could not find imported SRT: " + e.toString() });
        }
        if (!srtItem) {
            return editflowUtils.safeStringify({ success: false, error: "Could not find imported SRT in project bin" });
        }

        // 3. Create the caption track. Missing on some builds — fall back to
        //    import-only (still success: the file is in the bin for manual
        //    drag-to-timeline) and say so explicitly.
        var itemName = "";
        try {
            itemName = srtItem.name;
        } catch (ignore2) {}
        try {
            var captionResult = seq.createCaptionTrack(srtItem, 0);
            return editflowUtils.safeStringify({
                success: true,
                method: "createCaptionTrack",
                captionResult: (captionResult !== undefined) ? String(captionResult) : "ok",
                itemName: itemName
            });
        } catch (captionErr) {
            return editflowUtils.safeStringify({
                success: true,
                method: "importOnly",
                warning: "createCaptionTrack failed: " + captionErr.toString(),
                itemName: itemName
            });
        }
    }

    /* ── Caption studio (animated overlay) ───────────────────────────
     * Called through editflowDispatch("callModule", {module:
     * "captionsManager", fn: ...}) so edits hot-reload with no restart.
     * Plain ES3: no let/const, arrow functions, or reserved-word keys.
     */
    var TICKS = 254016000000;
    var OVERLAY_PREFIX = "EditFlow Captions";

    function err(msg) { return { success: false, error: msg }; }

    function ticksToSec(t) {
        var n = parseFloat(t && t.ticks !== undefined ? t.ticks : t);
        return isNaN(n) ? 0 : n / TICKS;
    }

    function timeSec(t) {
        if (!t) return 0;
        if (t.ticks !== undefined) return ticksToSec(t.ticks);
        if (t.seconds !== undefined) return parseFloat(t.seconds) || 0;
        return parseFloat(t) || 0;
    }

    function normPath(p) { return String(p || "").replace(/\\/g, "/").toLowerCase(); }

    /** Facts about the active sequence — cheap (no clip walk). */
    function sequenceInfo(options) {
        var seq = app.project ? app.project.activeSequence : null;
        if (!seq) return err("No active sequence — open the sequence you want to caption.");
        var tb = String(seq.timebase || "");
        var zero = 0;
        try { if (seq.zeroPoint) zero = ticksToSec(seq.zeroPoint); } catch (ez) {}
        var duration = Math.max(0, ticksToSec(seq.end) - zero);
        var playhead = 0;
        try { playhead = Math.max(0, timeSec(seq.getPlayerPosition()) - zero); } catch (e1) {}

        var seqIn = 0, seqOut = duration, hasInOut = false;
        var hasIn = false, hasOut = false;
        try {
            if (seq.getInPoint) {
                var inTk = seq.getInPoint();
                if (inTk !== undefined && inTk !== null && inTk !== "") {
                    var inSec = ticksToSec(inTk) - zero;
                    if (inSec > 0.04) { seqIn = Math.max(0, inSec); hasIn = true; }
                    else if (inSec >= 0) { seqIn = inSec; }
                }
            }
        } catch (eIn) {}
        try {
            if (seq.getOutPoint) {
                var outTk = seq.getOutPoint();
                if (outTk !== undefined && outTk !== null && outTk !== "") {
                    var outSec = ticksToSec(outTk) - zero;
                    if (outSec > 0.04 && outSec < duration - 0.04) {
                        seqOut = Math.max(seqIn + 0.1, outSec);
                        hasOut = true;
                    } else if (outSec > 0) {
                        seqOut = outSec;
                    }
                }
            }
        } catch (eOut) {}
        hasInOut = hasIn || hasOut;

        var out = {
            success: true,
            name: seq.name,
            id: seq.sequenceID,
            width: seq.frameSizeHorizontal,
            height: seq.frameSizeVertical,
            timebase: tb,
            fps: tb ? TICKS / parseFloat(tb) : 0,
            duration: duration,
            zeroPoint: zero,
            playhead: playhead,
            inPoint: seqIn,
            outPoint: seqOut,
            hasInOut: hasInOut,
            videoTracks: seq.videoTracks.numTracks,
            audioTracks: []
        };
        for (var i = 0; i < seq.audioTracks.numTracks; i++) {
            var tr = seq.audioTracks[i];
            var muted = false;
            try { muted = tr.isMuted(); } catch (e2) {}
            out.audioTracks.push({ index: i, name: tr.name || ("A" + (i + 1)), muted: muted,
                                   clips: tr.clips.numItems });
        }
        return out;
    }

    /** Audio clips on UNMUTED tracks, for the backend mixdown. */
    function sequenceAudioClips(options) {
        options = options || {};
        var seq = app.project ? app.project.activeSequence : null;
        if (!seq) return err("No active sequence — open the sequence you want to caption.");

        var zero = 0;
        try { if (seq.zeroPoint) zero = ticksToSec(seq.zeroPoint); } catch (ez) {}
        var duration = Math.max(0, ticksToSec(seq.end) - zero);

        var seqIn = 0, seqOut = duration, hasInOut = false;
        var hasIn = false, hasOut = false;
        try {
            if (seq.getInPoint) {
                var inTk = seq.getInPoint();
                if (inTk !== undefined && inTk !== null && inTk !== "") {
                    var inSec = ticksToSec(inTk) - zero;
                    if (inSec > 0.04) { seqIn = Math.max(0, inSec); hasIn = true; }
                    else if (inSec >= 0) { seqIn = inSec; }
                }
            }
        } catch (eIn) {}
        try {
            if (seq.getOutPoint) {
                var outTk = seq.getOutPoint();
                if (outTk !== undefined && outTk !== null && outTk !== "") {
                    var outSec = ticksToSec(outTk) - zero;
                    if (outSec > 0.04 && outSec < duration - 0.04) {
                        seqOut = Math.max(seqIn + 0.1, outSec);
                        hasOut = true;
                    } else if (outSec > 0) {
                        seqOut = outSec;
                    }
                }
            }
        } catch (eOut) {}
        hasInOut = hasIn || hasOut;

        var useInOut = options.useInOut === true || (options.useInOut !== false && hasInOut);
        var rangeIn = options.inPoint != null ? parseFloat(options.inPoint) : (useInOut ? seqIn : 0);
        var rangeOut = options.outPoint != null ? parseFloat(options.outPoint) : (useInOut ? seqOut : duration);
        if (rangeIn < 0) rangeIn = 0;
        if (rangeOut <= rangeIn) rangeOut = duration;

        var clips = [], nested = 0;
        var seenIntervals = {};
        for (var i = 0; i < seq.audioTracks.numTracks; i++) {
            var tr = seq.audioTracks[i];
            var muted = false;
            try { muted = tr.isMuted(); } catch (e1) {}
            if (muted) continue;
            for (var j = 0; j < tr.clips.numItems; j++) {
                var c = tr.clips[j];
                var off = false;
                try { off = c.disabled === true; } catch (e2) {}
                if (off || !c.projectItem) continue;
                var path = "";
                try { path = c.projectItem.getMediaPath(); } catch (e3) {}
                if (!path) { nested++; continue; }     // nested sequence / synthetic item
                var cStart = timeSec(c.start) - zero, cEnd = timeSec(c.end) - zero;
                var cIn = timeSec(c.inPoint), cOut = timeSec(c.outPoint);

                // If In/Out range is active, filter and trim clips outside/spanning the boundary
                if (cEnd <= rangeIn + 0.001 || cStart >= rangeOut - 0.001) continue;

                var trimStart = Math.max(0, rangeIn - cStart);
                var trimEnd = Math.max(0, cEnd - rangeOut);
                var segStart = Math.max(cStart, rangeIn);
                var segEnd = Math.min(cEnd, rangeOut);
                if (segEnd - segStart < 0.015) continue;

                var durOriginal = Math.max(0.001, cEnd - cStart);
                var speed = (cOut - cIn) / durOriginal;
                var srcIn = cIn + trimStart * speed;
                var srcOut = cOut - trimEnd * speed;
                if (srcOut <= srcIn) continue;

                // De-duplicate ONLY true cloned channels (same media, same timeline range, AND same source in/out)
                // This prevents dropping unique cuts or multi-mic dialogue from the same audio file!
                var key = path + ":" + Math.round(segStart * 100) + ":" + Math.round(segEnd * 100) +
                          ":" + Math.round(srcIn * 100) + ":" + Math.round(srcOut * 100);
                if (seenIntervals[key]) continue;
                seenIntervals[key] = true;

                clips.push({ path: path, track: i,
                             start: segStart - rangeIn,
                             end: segEnd - rangeIn,
                             "in": srcIn, out: srcOut,
                             timelineStart: segStart, timelineEnd: segEnd });
            }
        }
        var effectiveDur = Math.max(0, rangeOut - rangeIn);
        return { success: true, name: seq.name, clips: clips, nested: nested,
                 duration: effectiveDur, totalDuration: duration,
                 rangeIn: rangeIn, rangeOut: rangeOut, hasInOut: hasInOut,
                 zeroPoint: zero };
    }

    function toTimecode(sec, timebase) {
        var tb = parseFloat(timebase);
        var fps = (tb && tb > 0) ? (TICKS / tb) : 30;
        if (fps <= 0) fps = 30;
        var total = Math.max(0, parseFloat(sec) || 0);
        var hh = Math.floor(total / 3600);
        var mm = Math.floor((total % 3600) / 60);
        var ss = Math.floor(total % 60);
        var ff = Math.floor((total - Math.floor(total)) * fps);
        var pad = function(n) { return (n < 10 ? "0" : "") + n; };
        return pad(hh) + ":" + pad(mm) + ":" + pad(ss) + ":" + pad(ff);
    }

    /**
     * Capture frame at playhead or specified time.
     * Tries exportFramePNG, or identifies the top visible video clip for backend extraction.
     */
    function captureSequenceFrame(options) {
        options = options || {};
        var seq = app.project ? app.project.activeSequence : null;
        if (!seq) return err("No active sequence");
        var zero = 0;
        try { if (seq.zeroPoint) zero = ticksToSec(seq.zeroPoint); } catch (ez) {}
        var playhead = 0;
        try { playhead = Math.max(0, timeSec(seq.getPlayerPosition()) - zero); } catch (e1) {}
        var t = options.time != null ? parseFloat(options.time) : playhead;
        var targetTicks = Math.round((zero + t) * TICKS);
        var ticks = String(targetTicks);

        var outDir = "";
        try {
            if (typeof Folder !== "undefined" && Folder.temp) {
                var tf = Folder.temp;
                // Fix Adobe's double-Temp bug on Windows (Folder.temp returning ...\AppData\Local\Temp\Temp)
                if (!tf.exists) {
                    var raw = tf.fsName || "";
                    var fixed = raw.replace(/[\/\\]Temp[\/\\]Temp$/i, "\\Temp");
                    var fAlt = new Folder(fixed);
                    if (fAlt.exists) {
                        tf = fAlt;
                    } else {
                        try { tf.create(); } catch (_) {}
                    }
                }
                if (tf.exists) outDir = tf.fsName;
            }
        } catch (_) {}
        if (!outDir) {
            try {
                if (typeof Folder !== "undefined" && Folder.userData) {
                    var uf = new Folder(Folder.userData.fsName + "/EditFlow");
                    if (!uf.exists) try { uf.create(); } catch (_) {}
                    if (uf.exists) outDir = uf.fsName;
                }
            } catch (_) {}
        }

        var exported = false;
        if (outDir) {
            outDir = outDir.replace(/\\/g, "/");
            try { var chk = new Folder(outDir); if (!chk.exists) chk.create(); } catch (_) {}

            // Premiere's exportFramePNG automatically appends '.png' to the given path.
            // Do NOT include '.png' in basePath to avoid '...png.png'.
            var basePath = outDir + "/editflow_seq_frame";
            var expectedPngPath = basePath + ".png";
            var file = null;
            try { file = new File(expectedPngPath); } catch (_) {}
            if (file && file.exists) { try { file.remove(); } catch (_) {} }

            var tc = toTimecode(zero + t, seq.timebase);

            // Enable QE DOM safely
            try { if (app.enableQE) app.enableQE(); } catch (_) {}

            if (typeof qe !== "undefined" && qe.project) {
                try {
                    var qeSeq = qe.project.getActiveSequence();
                    if (qeSeq && qeSeq.exportFramePNG) {
                        exported = qeSeq.exportFramePNG(tc, basePath);
                    }
                } catch (eQe) {}
            }

            if (!exported) {
                try {
                    if (seq.exportFramePNG) {
                        exported = seq.exportFramePNG(tc, basePath);
                    }
                } catch (ePng) {}
            }

            // Fallback for Premiere versions expecting ticks without extension
            if (!exported && (!file || !file.exists)) {
                try {
                    if (seq.exportFramePNG) {
                        exported = seq.exportFramePNG(ticks, basePath);
                    }
                } catch (ePng2) {}
            }

            if (file && file.exists) {
                return { success: true, path: expectedPngPath, time: t, method: "exportFramePNG" };
            }
        }

        // Fallback: locate top visible video clip under playhead
        for (var v = seq.videoTracks.numTracks - 1; v >= 0; v--) {
            var tr = seq.videoTracks[v];
            var muted = false;
            try { muted = tr.isMuted(); } catch (_) {}
            if (muted) continue;
            for (var k = 0; k < tr.clips.numItems; k++) {
                var clip = tr.clips[k];
                if (clip.disabled || !clip.projectItem) continue;
                if (isOverlayItem(clip.projectItem)) continue; // skip our own overlay
                var cStart = timeSec(clip.start) - zero, cEnd = timeSec(clip.end) - zero;
                if (t >= cStart - 0.001 && t <= cEnd + 0.001) {
                    var p = "";
                    try { p = clip.projectItem.getMediaPath(); } catch (_) {}
                    if (p) {
                        var cIn = timeSec(clip.inPoint);
                        var srcTime = cIn + (t - cStart);
                        return {
                            success: true,
                            method: "sourceClip",
                            clipPath: p,
                            sourceTime: srcTime,
                            time: t,
                            width: seq.frameSizeHorizontal,
                            height: seq.frameSizeVertical
                        };
                    }
                }
            }
        }
        return { success: false, error: "No video clip found at time " + t.toFixed(2) + "s", time: t };
    }

    function isOverlayItem(item) {
        if (!item) return false;
        var name = "";
        try { name = String(item.name || ""); } catch (e1) {}
        if (name.indexOf(OVERLAY_PREFIX) === 0) return true;
        var p = "";
        try { p = normPath(item.getMediaPath()); } catch (e2) {}
        // earlier EditFlow overlays (overlay-*.mov) live in the same folder
        return p.indexOf("/data/output/captions/") !== -1 && /\.mov$/.test(p);
    }

    function findByPath(bin, path) {
        if (!bin) return null;
        var want = normPath(path);
        for (var i = 0; i < bin.children.numItems; i++) {
            var it = bin.children[i];
            if (it.type === ProjectItemType.BIN) {
                var found = findByPath(it, path);
                if (found) return found;
            } else {
                var p = "";
                try { p = it.getMediaPath ? normPath(it.getMediaPath()) : ""; } catch (e) {}
                if (p && p === want) return it;
            }
        }
        return null;
    }

    function trackFree(track, start, end) {
        try { if (track.isLocked && track.isLocked()) return false; } catch (e0) {}
        for (var i = 0; i < track.clips.numItems; i++) {
            var c = track.clips[i];
            if (timeSec(c.start) < end - 0.001 && timeSec(c.end) > start + 0.001) return false;
        }
        return true;
    }

    /**
     * Put the rendered caption overlay on the timeline:
     *   1. import it into the "EditFlow Captions" bin,
     *   2. lift earlier EditFlow caption overlays (no ripple),
     *   3. OVERWRITE it onto the track those used, else the lowest empty
     *      track above V1 — never insertClip, which ripples the edit.
     * options: { path, start (s), duration (s) }
     */
    function placeOverlay(options) {
        var seq = app.project ? app.project.activeSequence : null;
        if (!seq) return err("No active sequence — open the sequence you want to caption.");
        var path = editflowUtils.getParam(options, "path");
        if (!path) return err("No caption file to place.");
        var start = parseFloat(editflowUtils.getParam(options, "start")) || 0;
        var dur = parseFloat(editflowUtils.getParam(options, "duration")) || 0;
        var end = start + dur;

        var root = app.project.rootItem;
        var bin = editflowUtils.findBin(root, OVERLAY_PREFIX);
        if (!bin) {
            try { root.createBin(OVERLAY_PREFIX); } catch (e1) {}
            bin = editflowUtils.findBin(root, OVERLAY_PREFIX) || root;
        }
        var item = findByPath(bin, path);
        if (!item) {
            try { app.project.importFiles([path], true, bin, false); } catch (e2) {
                return err("Premiere could not import the caption file: " + e2.toString());
            }
            item = findByPath(bin, path) || findByPath(root, path);
        }
        if (!item) return err("Imported the caption file but could not find it in the project: " + path);

        if (app.beginUndoGroup) app.beginUndoGroup("EditFlow Place Captions");
        var removed = 0, prefer = -1;
        for (var v = 0; v < seq.videoTracks.numTracks; v++) {
            var tr = seq.videoTracks[v];
            for (var k = tr.clips.numItems - 1; k >= 0; k--) {
                var clip = tr.clips[k];
                if (clip.projectItem && isOverlayItem(clip.projectItem)) {
                    if (prefer < 0) prefer = v;
                    try { clip.remove(false, false); removed++; } catch (e3) {}
                }
            }
        }

        var target = -1;
        if (prefer > 0 && prefer < seq.videoTracks.numTracks && trackFree(seq.videoTracks[prefer], start, end)) {
            target = prefer;
        }
        for (var t = 1; target < 0 && t < seq.videoTracks.numTracks; t++) {
            if (trackFree(seq.videoTracks[t], start, end)) target = t;
        }
        if (target < 0) {
            if (app.endUndoGroup) app.endUndoGroup();
            return err("No empty, unlocked video track above V1 for the captions. " +
                       "Add one (Sequence > Add Tracks) and run it again.");
        }

        var zeroTicks = 0;
        try {
            if (seq.zeroPoint) {
                zeroTicks = parseFloat(seq.zeroPoint.ticks || seq.zeroPoint) || 0;
            }
        } catch (ez) {}

        var targetTicks = zeroTicks + Math.round(start * TICKS);
        var ticks = String(targetTicks);

        var placed = false, how = "";
        try {
            var tm = new Time();
            tm.ticks = ticks;
            seq.videoTracks[target].overwriteClip(item, tm);
            placed = true; how = "track.overwriteClip";
        } catch (e4) {
            try {
                seq.videoTracks[target].overwriteClip(item, ticks);
                placed = true; how = "track.overwriteClip(ticks)";
            } catch (e4b) {
                try {
                    seq.overwriteClip(item, ticks, target, -1);
                    placed = true; how = "sequence.overwriteClip(-1)";
                } catch (e5) {
                    try {
                        seq.overwriteClip(item, ticks, target, 0);
                        placed = true; how = "sequence.overwriteClip(0)";
                    } catch (e6) {
                        if (app.endUndoGroup) app.endUndoGroup();
                        return err("Premiere refused to place the captions: " + e6.toString());
                    }
                }
            }
        }
        if (app.endUndoGroup) app.endUndoGroup();
        return { success: placed, track: target, trackName: "V" + (target + 1), method: how,
                 start: start, end: end, removed: removed, item: String(item.name || "") };
    }

    return {
        importSRTAsCaptionTrack: importSRTAsCaptionTrack,
        sequenceInfo: sequenceInfo,
        sequenceAudioClips: sequenceAudioClips,
        captureSequenceFrame: captureSequenceFrame,
        placeOverlay: placeOverlay
    };
})();

