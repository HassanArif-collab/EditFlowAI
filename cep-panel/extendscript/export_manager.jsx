/*
 * export_manager.jsx - Export sequences via Adobe Media Encoder.
 */
exportManager = (function() {
    "use strict";

    function exportCurrentSequence(options) {
        var seq = app.project.activeSequence;
        if (!seq) return editflowUtils.safeStringify({ success: false, error: "No active sequence" });

        var outputPreset = editflowUtils.getParam(options, 'preset', 'presetPath') || "";
        var outputPath = editflowUtils.getParam(options, 'outputPath', 'path') || "";

        try {
            if (app.encoder) {
                // Use AME for background encoding
                var presetPath = outputPreset || findDefaultExportPreset();
                app.encoder.launchEncoder();
                app.encoder.encodeSequence(
                    seq,
                    outputPath || (seq.name + "_export.mp4"),
                    presetPath,
                    0, // WorkAreaType
                    true // Remove on completion
                );
                return editflowUtils.safeStringify({ success: true, queued: true });
            }
            return editflowUtils.safeStringify({ success: false, error: "Encoder not available" });
        } catch (e) {
            return editflowUtils.safeStringify({ success: false, error: e.toString() });
        }
    }

    function findDefaultExportPreset() {
        // Try to find a suitable H.264 preset
        try {
            var appData = Folder.myDocuments.fsName;
            var presetDir = new Folder(appData + "/Adobe/Premiere Pro/Profile");
            if (presetDir.exists) {
                var files = presetDir.getFiles("*.epr");
                if (files.length > 0) return files[0].fsName;
            }
        } catch (e) {}
        return "";
    }

    return {
        exportCurrentSequence: exportCurrentSequence
    };
})();
