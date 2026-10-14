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

    function parseSequencePoint(val, seqZero) {
        if (val === undefined || val === null || val === "") return null;
        var sec = null;
        if (typeof val === "object") {
            if (val.seconds !== undefined) {
                sec = parseFloat(val.seconds);
            } else if (val.ticks !== undefined) {
                sec = parseFloat(val.ticks) / TICKS;
            }
        } else {
            var num = parseFloat(val);
            if (!isNaN(num)) {
                if (num > 100000000) {
                    sec = num / TICKS;
                } else {
                    sec = num;
                }
            }
        }
        if (sec === null || isNaN(sec)) return null;
        if (seqZero > 0 && sec >= seqZero) {
            sec = sec - seqZero;
        }
        return Math.max(0, sec);
    }

    function getSequenceInOut(seq, zero, duration) {
        var seqIn = 0, seqOut = duration;
        var rawIn = null, rawOut = null;
        try {
            if (seq.getInPointAsTime) rawIn = seq.getInPointAsTime();
            else if (seq.getInPoint) rawIn = seq.getInPoint();
        } catch (_) {}
        try {
            if (seq.getOutPointAsTime) rawOut = seq.getOutPointAsTime();
            else if (seq.getOutPoint) rawOut = seq.getOutPoint();
        } catch (_) {}

        var inSec = parseSequencePoint(rawIn, zero);
        var outSec = parseSequencePoint(rawOut, zero);

        var hasIn = false;
        if (inSec !== null) {
            if (inSec > 0.04) {
                seqIn = inSec;
                hasIn = true;
            } else {
                seqIn = Math.max(0, inSec);
            }
        }

        var hasOut = false;
        if (outSec !== null && outSec > 0.04) {
            if (duration > 0 && outSec < duration - 0.04) {
                seqOut = outSec;
                hasOut = true;
            } else if (duration > 0 && outSec >= duration - 0.04) {
                seqOut = duration;
            } else {
                seqOut = outSec;
                hasOut = true;
            }
        } else {
            seqOut = duration;
        }

        if (seqOut <= seqIn) {
            seqOut = duration;
            hasOut = false;
        }

        return {
            inPoint: seqIn,
            outPoint: seqOut,
            hasInOut: hasIn || hasOut,
            hasIn: hasIn,
            hasOut: hasOut
        };
    }

    function getClipVolume(clip) {
        try {
            if (!clip || !clip.components) return 1.0;
            for (var i = 0; i < clip.components.numItems; i++) {
                var comp = clip.components[i];
                var mName = "", dName = "";
                try { mName = String(comp.matchName || ""); } catch (_) {}
                try { dName = String(comp.displayName || ""); } catch (_) {}
                if (mName === "AE.ADBE Audio Volume" || dName === "Volume" || mName.indexOf("Volume") !== -1 || dName.indexOf("Volume") !== -1) {
                    if (comp.properties) {
                        for (var j = 0; j < comp.properties.numItems; j++) {
                            var prop = comp.properties[j];
                            var pName = "";
                            try { pName = String(prop.displayName || prop.name || ""); } catch (_) {}
                            if (pName === "Level" || pName === "Volume" || pName.indexOf("Level") !== -1) {
                                var val = prop.getValue();
                                if (val !== undefined && val !== null) {
                                    var num = parseFloat(val);
                                    if (!isNaN(num)) {
                                        if (num <= -50) return 0.0;
                                        if (num < 0) return Math.pow(10, num / 20);
                                        if (num <= 0.0001) return 0.0;
                                        var mult = num / 0.17782794;
                                        return Math.max(0.0, mult);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch (_) {}
        return 1.0;
    }

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

        var inOut = getSequenceInOut(seq, zero, duration);

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
            inPoint: inOut.inPoint,
            outPoint: inOut.outPoint,
            hasInOut: inOut.hasInOut,
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

        var inOut = getSequenceInOut(seq, zero, duration);

        var useInOut = options.useInOut === true || (options.useInOut !== false && inOut.hasInOut);
        var rangeIn = options.inPoint != null ? parseFloat(options.inPoint) : (useInOut ? inOut.inPoint : 0);
        var rangeOut = options.outPoint != null ? parseFloat(options.outPoint) : (useInOut ? inOut.outPoint : duration);
        if (rangeIn < 0) rangeIn = 0;
        if (rangeOut <= rangeIn) rangeOut = duration;

        var trackFilter = null;
        if (options.tracks && options.tracks.length) {
            trackFilter = {};
            for (var ti = 0; ti < options.tracks.length; ti++) {
                trackFilter[String(options.tracks[ti])] = true;
            }
        }

        var clips = [], nested = 0;
        var seenIntervals = {};
        for (var i = 0; i < seq.audioTracks.numTracks; i++) {
            if (trackFilter && !trackFilter[String(i)]) continue;
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

                var clipVol = getClipVolume(c);
                if (clipVol <= 0.005) continue; // effectively muted/silent in Premiere

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
                             volume: Math.round(clipVol * 10000) / 10000,
                             timelineStart: segStart, timelineEnd: segEnd });
            }
        }
        var effectiveDur = Math.max(0, rangeOut - rangeIn);
        return { success: true, name: seq.name, clips: clips, nested: nested,
                 duration: effectiveDur, totalDuration: duration,
                 rangeIn: rangeIn, rangeOut: rangeOut, hasInOut: inOut.hasInOut,
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

    var VIDEO_EXTS = {
        "mp4": 1, "mov": 1, "m4v": 1, "mkv": 1, "webm": 1, "avi": 1,
        "mts": 1, "m2ts": 1, "mxf": 1, "prores": 1, "r3d": 1, "braw": 1
    };

    function isVideoFile(p) {
        if (!p) return false;
        var dot = String(p).lastIndexOf(".");
        if (dot === -1) return false;
        var ext = String(p).substring(dot + 1).toLowerCase();
        return !!VIDEO_EXTS[ext];
    }

    /**
     * Capture frame at playhead or specified time.
     * Tries exportFramePNG (QE DOM), or identifies the top visible video clip for backend extraction.
     */
    function captureSequenceFrame(options) {
        options = options || {};
        var seq = app.project ? app.project.activeSequence : null;
        if (!seq) return err("No active sequence");
        var zero = 0;
        try { if (seq.zeroPoint) zero = ticksToSec(seq.zeroPoint); } catch (ez) {}
        var playhead = 0;
        try { playhead = Math.max(0, timeSec(seq.getPlayerPosition()) - zero); } catch (e1) {}

        var usePlayhead = options.usePlayhead === true || (options.time == null);
        var t = usePlayhead ? playhead : parseFloat(options.time);
        if (isNaN(t) || t < 0) t = playhead;

        var targetTicks = Math.round((zero + t) * TICKS);
        var ticks = String(targetTicks);

        var origTicks = "";
        try { origTicks = String(seq.getPlayerPosition().ticks); } catch (_) {}

        // Enable QE DOM safely
        try { if (app.enableQE) app.enableQE(); } catch (_) {}

        var qeSeq = null;
        try {
            if (typeof qe !== "undefined" && qe && qe.project) {
                qeSeq = qe.project.getActiveSequence();
                if (!qeSeq && qe.project.getSequenceAt && qe.project.numSequences) {
                    for (var sIdx = 0; sIdx < qe.project.numSequences; sIdx++) {
                        var s = qe.project.getSequenceAt(sIdx);
                        if (s && s.name === seq.name) {
                            qeSeq = s;
                            break;
                        }
                    }
                }
            }
        } catch (eQe) {}

        var didMovePlayhead = false;
        if (!usePlayhead && seq.setPlayerPosition) {
            try {
                seq.setPlayerPosition(ticks);
                didMovePlayhead = true;
            } catch (eSeek) {}
        }

        // Exact timecode string from QE CTI or calculate
        var tc = "";
        try {
            if (qeSeq && qeSeq.CTI && qeSeq.CTI.timecode) {
                tc = String(qeSeq.CTI.timecode);
            }
        } catch (eTc) {}
        if (!tc) {
            tc = toTimecode(zero + t, seq.timebase);
        }

        var outDir = "";
        try {
            if (typeof Folder !== "undefined" && Folder.temp) {
                var tf = Folder.temp;
                // Fix Adobe's double-Temp bug on Windows
                if (!tf.exists) {
                    var raw = tf.fsName || "";
                    var fixed = raw.replace(/[\/\\]Temp[\/\\]Temp$/i, "\\Temp");
                    var fAlt = new Folder(fixed);
                    if (fAlt.exists) tf = fAlt;
                    else try { tf.create(); } catch (_) {}
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

        if (outDir) {
            var targetFolder = new Folder(outDir);
            if (!targetFolder.exists) try { targetFolder.create(); } catch (_) {}

            var cleanDir = targetFolder.fsName.replace(/\\/g, "/");
            var basePath = cleanDir + "/editflow_seq_frame";
            var uniqueBasePath = cleanDir + "/editflow_frame_" + (new Date().getTime());

            function findPng(stem) {
                var checkList = [
                    stem + ".png",
                    stem + ".png.png",
                    stem,
                    stem.replace(/\//g, "\\") + ".png",
                    stem.replace(/\//g, "\\") + ".png.png",
                    stem.replace(/\//g, "\\")
                ];
                for (var ci = 0; ci < checkList.length; ci++) {
                    try {
                        var cf = new File(checkList[ci]);
                        if (cf && cf.exists) {
                            var sz = -1;
                            try { if (typeof cf.length !== "undefined") sz = cf.length; } catch (_) {}
                            if (sz !== 0) return cf;
                        }
                    } catch (_) {}
                }
                return null;
            }

            // Remove any old frame at basePath.png
            try {
                var oldF = new File(basePath + ".png");
                if (oldF && oldF.exists) oldF.remove();
            } catch (_) {}

            var exportedFile = null;

            // 1. Try qeSeq.exportFramePNG
            if (qeSeq && qeSeq.exportFramePNG) {
                try { qeSeq.exportFramePNG(tc, uniqueBasePath); } catch (_) {}
                exportedFile = findPng(uniqueBasePath);

                if (!exportedFile) {
                    try { qeSeq.exportFramePNG(tc, uniqueBasePath.replace(/\//g, "\\")); } catch (_) {}
                    exportedFile = findPng(uniqueBasePath);
                }
                if (!exportedFile) {
                    try { qeSeq.exportFramePNG(tc, basePath); } catch (_) {}
                    exportedFile = findPng(basePath);
                }
            }

            // 2. Try seq.exportFramePNG
            if (!exportedFile && seq && seq.exportFramePNG) {
                try { seq.exportFramePNG(tc, basePath); } catch (_) {}
                exportedFile = findPng(basePath);
                if (!exportedFile) {
                    try { seq.exportFramePNG(ticks, basePath); } catch (_) {}
                    exportedFile = findPng(basePath);
                }
            }

            // Restore playhead if moved
            if (didMovePlayhead && origTicks && seq.setPlayerPosition) {
                try { seq.setPlayerPosition(origTicks); } catch (_) {}
            }

            if (exportedFile) {
                return {
                    success: true,
                    path: exportedFile.fsName.replace(/\\/g, "/"),
                    time: t,
                    method: "exportFramePNG"
                };
            }
        }

        // Restore playhead if moved
        if (didMovePlayhead && origTicks && seq.setPlayerPosition) {
            try { seq.setPlayerPosition(origTicks); } catch (_) {}
        }

        // Fallback: Locate video clip under playhead.
        // We prioritize true VIDEO files (.mp4, .mov, etc.) over still image graphics (.png, .jpg, etc.)
        // so that overlays/logos/watermarks on higher tracks don't hijack the frame!
        var topVideoClip = null;
        var topImageClip = null;

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
                        var durOrig = Math.max(0.001, cEnd - cStart);
                        var durSrc = timeSec(clip.outPoint) - cIn;
                        var spd = (durSrc > 0) ? (durSrc / durOrig) : 1;
                        var srcTime = cIn + (t - cStart) * spd;
                        var clipInfo = {
                            success: true,
                            method: "sourceClip",
                            clipPath: p,
                            sourceTime: Math.max(0, srcTime),
                            time: t,
                            track: v,
                            width: seq.frameSizeHorizontal,
                            height: seq.frameSizeVertical
                        };
                        if (isVideoFile(p)) {
                            if (!topVideoClip) topVideoClip = clipInfo;
                        } else {
                            if (!topImageClip) topImageClip = clipInfo;
                        }
                    }
                }
            }
            if (topVideoClip) break; // found topmost video clip!
        }

        var chosen = topVideoClip || topImageClip;
        if (chosen) {
            return chosen;
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

