/*
 * index.jsx - Main ExtendScript entry point for EditFlow AI AE.
 * Provides the editflowDispatch() command router.
 * Modules are loaded by the panel via evalScript('$.evalFile()') to ensure
 * correct $.fileName resolution (manifest-loaded JSX has broken $.fileName).
 */

function editflowEscapeJSON(value) {
    return String(value)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, "\\\"")
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n");
}

function editflowErrorResult(error, command) {
    var message = error && error.toString ? error.toString() : String(error);
    var cmd = command || "";
    try {
        if (typeof editflowUtils !== "undefined" && editflowUtils.safeStringify) {
            return editflowUtils.safeStringify({
                success: false,
                error: message,
                command: cmd
            });
        }
    } catch (ignore) {}
    return '{"success":false,"error":"' + editflowEscapeJSON(message) + '","command":"' + editflowEscapeJSON(cmd) + '"}';
}

function editflowDispatch(command, payloadData) {
    try {
        var options = {};
        if (payloadData) {
            try {
                options = JSON.parse(payloadData);
            } catch (e) {
                options = {};
            }
        }

        var result;

        switch (command) {
            // ── Extension Configuration ──
            case "editflowConfigureExtensionRoot":
                // No-op: modules already loaded by panel via $.evalFile()
                result = editflowUtils.ok({ status: "ready" });
                break;

            // ── Comp Info ──
            case "getCompInfo":
                result = captionManager.getCompInfo();
                break;

            // ── Audio Path ──
            case "getAudioPath":
                result = captionManager.getAudioPath();
                break;

            // ── Create Captions ──
            case "createCaptions":
                result = captionManager.createCaptions(options);
                break;

            // ── Clear Captions ──
            case "clearCaptions":
                result = captionManager.clearCaptions();
                break;

            default:
                result = editflowUtils.safeStringify({
                    success: false,
                    error: "Unknown command: " + command
                });
        }

        return result;
    } catch (e) {
        return editflowErrorResult(e, command);
    }
}
