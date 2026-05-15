var exportManager = (function() {
    "use strict";

    /**
     * Export the active sequence using Adobe Media Encoder.
     * @param {Object} options
     *   - outputPath: string — Full output file path
     *   - presetPath: string — Full path to .epr preset file (optional)
     *   - workArea: number — 0=Entire, 1=InToOut, 2=WorkArea (default 0)
     *   - removeOnComplete: boolean — Remove from AME queue when done (default true)
     * @returns {Object} { success, outputPath, error }
     */
    function exportCurrentSequence(options) {
        try {
            var seq = app.project.activeSequence;
            if (!seq) return { success: false, error: "No active sequence" };

            var outputPath = options.outputPath || options.output_path || "";
            if (!outputPath) {
                // Default to project folder
                var projPath = app.project.path;
                if (!projPath) {
                    return { success: false, error: "Project must be saved before exporting without explicit path." };
                }
                // Handle both Mac and Windows paths
                var separator = projPath.indexOf("\\") > -1 ? "\\" : "/";
                var projFolder = projPath.substring(0, projPath.lastIndexOf(separator));
                outputPath = projFolder + separator + seq.name + ".mp4";
            }

            var presetPath = options.presetPath || options.preset_path || "";
            // If no preset, try to find a default H.264 preset
            if (!presetPath) {
                presetPath = findDefaultExportPreset();
            }

            if (!presetPath) {
                return { success: false, error: "No export preset found. Provide a .epr preset path." };
            }

            var workArea = options.workArea || 0;
            var removeOnComplete = (options.removeOnComplete !== false) ? 1 : 0;

            // Launch encoder if not running
            app.encoder.launchEncoder();

            // Send to encoder
            var jobId = app.encoder.encodeSequence(
                seq, outputPath, presetPath, workArea, removeOnComplete
            );

            return {
                success: true,
                outputPath: outputPath,
                sequenceName: seq.name,
                jobId: jobId || "",
                warning: "Export was queued in Adobe Media Encoder. Check AME for final completion or errors."
            };
        } catch(e) {
            return { success: false, error: e.toString() };
        }
    }

    function findDefaultExportPreset() {
        // Common preset locations on Windows
        var commonPaths = [
            Folder.appData.fsName + "/Adobe/Common/AME/SystemPresets",
            Folder.appData.fsName + "/Adobe/Adobe Media Encoder"
        ];
        // Try to find any .epr file
        for (var i = 0; i < commonPaths.length; i++) {
            var folder = new Folder(commonPaths[i]);
            if (folder.exists) {
                var files = folder.getFiles("*.epr");
                if (files && files.length > 0) return files[0].fsName;
            }
        }
        return "";
    }

    return {
        exportCurrentSequence: exportCurrentSequence
    };
})();
