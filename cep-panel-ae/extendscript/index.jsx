/*
 * index.jsx - Main ExtendScript entry point for EditFlow AI AE.
 * Loads all modules and provides the editflowDispatch() command router.
 */
var editflowModuleNames = [
    "utils.jsx",
    "caption_manager.jsx"
];

var editflowConfiguredScriptDir = "";

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

function editflowGetScriptDir(scriptFile) {
    var slashIndex = scriptFile.lastIndexOf('/');
    var backslashIndex = scriptFile.lastIndexOf('\\');
    var separatorIndex = Math.max(slashIndex, backslashIndex);
    if (separatorIndex >= 0) {
        return scriptFile.substring(0, separatorIndex).replace(/\\/g, '/');
    }
    try {
        return File(scriptFile).parent.fsName.replace(/\\/g, '/');
    } catch (e) {
        return "";
    }
}

function editflowLoadModule(path) {
    try {
        var file = new File(path);
        if (file.exists) {
            $.evalFile(file);
        } else {
            throw new Error("module not found: " + path);
        }
    } catch (e) {
        var message = "Failed to load module " + path + ": " + e.toString();
        $.writeln("EditFlow: " + message);
    }
}

function editflowLoadAllModules(baseDir) {
    var dir = baseDir || editflowConfiguredScriptDir;
    if (!dir) return;
    for (var i = 0; i < editflowModuleNames.length; i++) {
        var path = dir + "/" + editflowModuleNames[i];
        editflowLoadModule(path);
    }
}

function editflowConfigureExtensionRoot(extensionRoot) {
    var root = String(extensionRoot || "").replace(/\\/g, "/").replace(/\/+$/, "");
    var scriptDir = root + "/extendscript";
    editflowConfiguredScriptDir = scriptDir;
    editflowLoadAllModules(scriptDir);
    return editflowUtils.ok({ scriptDir: scriptDir });
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
                result = editflowConfigureExtensionRoot(options.extensionRoot || options);
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
