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
        var out = {
            success: true,
            name: seq.name,
            id: seq.sequenceID,
            width: seq.frameSizeHorizontal,
            height: seq.frameSizeVertical,
            timebase: tb,
            fps: tb ? TICKS / parseFloat(tb) : 0,
            duration: ticksToSec(seq.end),
            playhead: 0,
            videoTracks: seq.videoTracks.numTracks,
            audioTracks: []
        };
        try { out.playhead = timeSec(seq.getPlayerPosition()); } catch (e1) {}
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
        var seq = app.project ? app.project.activeSequence : null;
        if (!seq) return err("No active sequence — open the sequence you want to caption.");
        var clips = [], nested = 0;
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
                clips.push({ path: path, track: i, start: timeSec(c.start), end: timeSec(c.end),
                             "in": timeSec(c.inPoint), out: timeSec(c.outPoint) });
            }
        }
        return { success: true, name: seq.name, clips: clips, nested: nested,
                 duration: ticksToSec(seq.end) };
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
        var want = normPath(path);
        for (var i = 0; i < bin.children.numItems; i++) {
            var it = bin.children[i];
            var p = "";
            try { p = it.getMediaPath ? normPath(it.getMediaPath()) : ""; } catch (e) {}
            if (p && p === want) return it;
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

        var removed = 0, prefer = -1;
        for (var v = 0; v < seq.videoTracks.numTracks; v++) {
            var tr = seq.videoTracks[v];
            for (var k = tr.clips.numItems - 1; k >= 0; k--) {
                var clip = tr.clips[k];
                if (clip.projectItem && clip.projectItem !== item && isOverlayItem(clip.projectItem)) {
                    if (prefer < 0) prefer = v;
                    try { clip.remove(false, false); removed++; } catch (e3) {}
                }
            }
        }

        var target = -1;
        if (prefer >= 0 && trackFree(seq.videoTracks[prefer], start, end)) target = prefer;
        for (var t = 1; target < 0 && t < seq.videoTracks.numTracks; t++) {
            if (trackFree(seq.videoTracks[t], start, end)) target = t;
        }
        if (target < 0) {
            return err("No empty, unlocked video track above V1 for the captions. " +
                       "Add one (Sequence > Add Tracks) and run it again.");
        }

        var ticks = String(Math.round(start * TICKS));
        var placed = false, how = "";
        try {
            var tm = new Time();
            tm.ticks = ticks;
            seq.videoTracks[target].overwriteClip(item, tm);
            placed = true; how = "track.overwriteClip";
        } catch (e4) {
            try {
                seq.overwriteClip(item, ticks, target, 0);
                placed = true; how = "sequence.overwriteClip";
            } catch (e5) {
                return err("Premiere refused to place the captions: " + e5.toString());
            }
        }
        return { success: placed, track: target, trackName: "V" + (target + 1), method: how,
                 start: start, end: end, removed: removed, item: String(item.name || "") };
    }

    return {
        importSRTAsCaptionTrack: importSRTAsCaptionTrack,
        sequenceInfo: sequenceInfo,
        sequenceAudioClips: sequenceAudioClips,
        placeOverlay: placeOverlay
    };
})();
