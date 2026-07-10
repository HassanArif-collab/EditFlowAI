/*
 * sequence_audio.jsx — Audio extraction for native animated captions.
 *
 * Exports the active sequence's audio between In/Out points to a WAV file,
 * so the backend can transcribe it with Whisper. Uses Premiere's
 * exportAsMediaDirect with a bundled .epr preset (Windows PCM WAV).
 *
 * API:
 *   extractSequenceAudio(options)
 *     options.outPath  (str, required) — output .wav path
 *     options.eprPath  (str, required) — .epr preset path OR a built-in
 *                                        preset name like "WaveAudio"
 *   Returns: JSON string
 *     { success, path, size_bytes, in_ticks, out_ticks,
 *       in_seconds, out_seconds, duration_seconds }
 *     or { success: false, error: "..." }
 *
 * Notes:
 *   - seq.getInPoint()/getOutPoint() return tick STRINGS. When no point is
 *     set, PPro returns "-400000" (the NOT_SET sentinel — same constant
 *     Adobe's PProPanel.jsx uses: `var NOT_SET = "-400000";`). We parseFloat()
 *     and treat <= 0 as unset for safety across PPro versions.
 *   - exportAsMediaDirect returns void; we verify success by checking the
 *     output file exists and is non-empty.
 *   - All external calls are wrapped in try/catch and routed through _err.
 */
sequenceAudio = (function() {
    "use strict";

    function _ok(obj)  { obj = obj || {}; obj.success = true;  return editflowUtils.safeStringify(obj); }
    function _err(msg) { return editflowUtils.safeStringify({ success: false, error: String(msg) }); }

    // Sentinel returned by seq.getInPoint()/getOutPoint() when no point is set.
    // Adobe's PProPanel.jsx defines `var NOT_SET = "-400000";` (ticks ≈ -1.57µs).
    // Coerce via parseFloat and treat anything <= 0 as "not set" for safety
    // across PPro versions (some return "0" instead of the sentinel).
    var NOT_SET_TICKS = -400000;

    function _readInOutTicks(seq) {
        // Returns { inTicks, outTicks, inSeconds, outSeconds }.
        // Never throws — falls back to NOT_SET_TICKS on any error.
        var inRaw, outRaw;
        try { inRaw  = seq.getInPoint(); } catch (e) { inRaw  = NOT_SET_TICKS; }
        try { outRaw = seq.getOutPoint(); } catch (e) { outRaw = NOT_SET_TICKS; }
        var inTicks  = parseFloat(inRaw);
        var outTicks = parseFloat(outRaw);
        if (!isFinite(inTicks))  inTicks  = NOT_SET_TICKS;
        if (!isFinite(outTicks)) outTicks = NOT_SET_TICKS;
        return {
            inTicks: inTicks,
            outTicks: outTicks,
            inSeconds:  editflowUtils.ticksToSeconds(inTicks),
            outSeconds: editflowUtils.ticksToSeconds(outTicks)
        };
    }

    function _fileSize(fsName) {
        try {
            var f = new File(fsName);
            if (f.exists) return f.length;
        } catch (e) {}
        return 0;
    }

    function _ensureParentDir(fsName) {
        try {
            var f = new File(fsName);
            var parent = f.parent;
            if (!parent) return false;
            if (parent.exists) return true;
            // Folder.create() creates intermediate dirs as needed; returns
            // true on success (or if the folder already existed).
            return !!parent.create();
        } catch (e) {
            return false;
        }
    }

    function extractSequenceAudio(options) {
        // 1. Active sequence
        var seq;
        try { seq = app.project.activeSequence; } catch (e) { seq = null; }
        if (!seq) return _err("No active sequence — open a sequence first.");

        // 2. In/Out points (returned as tick strings; "-400000" = NOT_SET)
        var io = _readInOutTicks(seq);
        // In point at tick 0 (start of sequence) is VALID — only reject negative
        // (NOT_SET sentinel) or out <= in. The old check (inTicks <= 0) rejected
        // a valid In point at the very start of the sequence.
        if (io.inTicks < 0 || io.outTicks <= io.inTicks) {
            return _err(
                "No valid In/Out range set on the active sequence. " +
                "Position the playhead and press I (in) and O (out) in Premiere, " +
                "then retry. (inTicks=" + io.inTicks + ", outTicks=" + io.outTicks + ")"
            );
        }

        // 3. Validate paths from options
        var outPath = editflowUtils.getParam(options, 'outPath', 'outputPath');
        var eprPath = editflowUtils.getParam(options, 'eprPath', 'presetPath');
        if (!outPath) return _err("Missing required option 'outPath' (output WAV path).");
        if (!eprPath) return _err("Missing required option 'eprPath' (path to .epr preset, or a built-in preset name like 'WaveAudio').");

        var outFile = new File(outPath);
        var outFsName = outFile.fsName;

        // 4. Create parent directory if missing
        if (!_ensureParentDir(outFsName)) {
            return _err("Could not create output directory for: " + outFsName);
        }

        // Remove any stale output so the post-export size check is meaningful.
        try { if (outFile.exists) outFile.remove(); } catch (e) {}

        // 5. Resolve work-area enum. ENCODE_IN_TO_OUT (1) respects In/Out points.
        //    Fall back to ENCODE_WORK_AREA (2) on older PPro versions.
        var workAreaEnum = null;
        try {
            if (app.encoder && app.encoder.ENCODE_IN_TO_OUT !== undefined) {
                workAreaEnum = app.encoder.ENCODE_IN_TO_OUT;
            }
        } catch (e) {}
        if (workAreaEnum === null) {
            try {
                if (app.encoder && app.encoder.ENCODE_WORK_AREA !== undefined) {
                    workAreaEnum = app.encoder.ENCODE_WORK_AREA;
                }
            } catch (e) {}
        }
        if (workAreaEnum === null) {
            return _err("app.encoder.ENCODE_IN_TO_OUT / ENCODE_WORK_AREA not available on this Premiere version.");
        }

        // 6. Run the export, trying preset candidates in order:
        //    a. the bundled .epr file (if it exists at eprPath)
        //    b. the eprPath verbatim as a built-in preset name (e.g. "WaveAudio")
        //    c. the literal "WaveAudio" string as a final fallback
        //
        // exportAsMediaDirect returns void — file existence & size are our only
        // success signals. Every attempt is wrapped in try/catch.
        var eprFile = new File(eprPath);
        var eprExists = false;
        try { eprExists = eprFile.exists; } catch (e) {}

        var presetAttempts = [];
        if (eprExists) presetAttempts.push(eprFile.fsName);
        if (typeof eprPath === 'string' && eprPath.length > 0) presetAttempts.push(eprPath);
        if (eprPath !== "WaveAudio") presetAttempts.push("WaveAudio");

        var ok = false;
        var lastErr = "";
        for (var i = 0; i < presetAttempts.length; i++) {
            var presetArg = presetAttempts[i];
            try {
                seq.exportAsMediaDirect(outFsName, presetArg, workAreaEnum);
                if (_fileSize(outFsName) > 0) { ok = true; break; }
                lastErr = "preset '" + presetArg + "': export returned no file.";
            } catch (e) {
                lastErr = "preset '" + presetArg + "': " + e.toString();
            }
        }

        // 7. Verify the output file exists and is non-empty.
        var size = _fileSize(outFsName);
        if (!ok || size <= 0) {
            return _err(
                "Audio export failed or produced an empty file. " + lastErr +
                " | outFile=" + outFsName + " | size=" + size
            );
        }

        // 8. Success
        return _ok({
            path: outFsName,
            size_bytes: size,
            in_ticks: String(io.inTicks),
            out_ticks: String(io.outTicks),
            in_seconds: io.inSeconds,
            out_seconds: io.outSeconds,
            duration_seconds: io.outSeconds - io.inSeconds
        });
    }

    return { extractSequenceAudio: extractSequenceAudio };
})();
