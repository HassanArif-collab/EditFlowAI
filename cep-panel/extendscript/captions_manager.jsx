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

    return {
        importSRTAsCaptionTrack: importSRTAsCaptionTrack
    };
})();
