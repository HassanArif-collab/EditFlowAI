/*
 * project_scanner.jsx - Scan the Premiere Pro project tree.
 * Recursively walks bins, items, and sequences for full project context.
 */
projectScanner = (function() {
    "use strict";

    function scanAll() {
        var project = app.project;
        if (!project) return JSON.stringify({ error: "No project open" });

        var result = {
            name: project.name,
            path: project.path,
            bins: [],
            items: [],
            sequences: []
        };

        var root = project.rootItem;
        scanBin(root, result, 0, "");

        // Also collect sequence names
        for (var i = 0; i < project.sequences.numSequences; i++) {
            var seq = project.sequences[i];
            result.sequences.push({
                name: seq.name,
                id: seq.sequenceID
            });
        }

        return JSON.stringify(result);
    }

    function scanBin(bin, result, depth, binPath) {
        var currentPath = binPath ? (binPath + "/" + bin.name) : bin.name;

        result.bins.push({
            name: bin.name,
            path: currentPath,
            itemCount: bin.children.numItems,
            depth: depth
        });

        for (var i = 0; i < bin.children.numItems; i++) {
            var item = bin.children[i];

            if (item.type === ProjectItemType.BIN) {
                scanBin(item, result, depth + 1, currentPath);
            } else {
                var itemInfo = getItemInfo(item, currentPath);
                result.items.push(itemInfo);
            }
        }
    }

    function getItemInfo(item, binPath) {
        var info = {
            name: item.name,
            binPath: binPath,
            type: "unknown",
            mediaPath: "",
            hasVideo: false,
            hasAudio: false,
            duration: 0
        };

        try {
            if (item.type === ProjectItemType.CLIP || item.type === ProjectItemType.FILE) {
                info.type = "clip";
            } else if (item.type === ProjectItemType.SEQUENCE) {
                info.type = "sequence";
            }

            info.mediaPath = editflowUtils.getMediaPath(item);
            info.hasVideo = !!editflowUtils.hasVideo(item);
            info.hasAudio = !!editflowUtils.hasAudio(item);

            if (item.getDuration) {
                info.duration = editflowUtils.ticksToSeconds({ ticks: String(item.getDuration()) });
            }
        } catch (e) {
            info.error = e.toString();
        }

        return info;
    }

    function findByPath(path) {
        var project = app.project;
        if (!project) return JSON.stringify({ found: false });

        var items = [];
        var root = project.rootItem;
        findItemsByPath(root, path, items);

        return JSON.stringify({ found: items.length > 0, items: items });
    }

    function findItemsByPath(bin, path, results) {
        for (var i = 0; i < bin.children.numItems; i++) {
            var item = bin.children[i];

            if (item.type === ProjectItemType.BIN) {
                findItemsByPath(item, path, results);
            } else {
                try {
                    var mediaPath = item.getMediaPath ? item.getMediaPath() : "";
                    if (mediaPath === path || mediaPath.indexOf(path) >= 0) {
                        results.push({
                            name: item.name,
                            mediaPath: mediaPath,
                            binPath: bin.name
                        });
                    }
                } catch (e) {}
            }
        }
    }

    return {
        scanAll: scanAll,
        findByPath: findByPath,
        getItemInfo: getItemInfo
    };
})();

/**
 * getSelectedProjectItems — Return the currently selected project items.
 *
 * Used by the CEP panel's drag-and-drop and selection-chip features.
 * When the user drags from Premiere's project panel into the CEP panel,
 * Premiere selects the items, so we can read the selection at drop time.
 * This function does NOT modify scanProjectMedia or any existing code.
 */
function getSelectedProjectItems() {
    if (!app || !app.project || !app.project.rootItem) {
        return JSON.stringify({success: false, error: "No project open"});
    }
    var selection = (app.project.getSelection) ? app.project.getSelection() : [];
    var items = [];
    for (var i = 0; i < selection.length; i++) {
        var item = selection[i];
        // Use the same getItemInfo helper from projectScanner if available
        if (typeof projectScanner !== 'undefined' && projectScanner.getItemInfo) {
            var binPath = _getBinPath(item);
            var itemInfo = projectScanner.getItemInfo(item, binPath);
            itemInfo.isBin = (item.type === ProjectItemType.BIN);
            items.push(itemInfo);
        } else {
            // Inline minimal description if helper not available
            items.push(_describeItemMinimal(item));
        }
    }
    return JSON.stringify({success: true, items: items, count: items.length});
}

function _getBinPath(item) {
    // Walk up the parent chain to build a bin path
    var parts = [];
    var current = item.parent;
    while (current) {
        if (current.name) parts.unshift(current.name);
        current = current.parent;
    }
    return parts.join("/");
}

function _describeItemMinimal(item) {
    var info = {
        name: item.name || "",
        binPath: _getBinPath(item),
        mediaPath: "",
        hasAudio: false,
        hasVideo: false,
        duration: 0,
        isBin: (item.type === ProjectItemType.BIN)
    };
    try {
        info.mediaPath = item.getMediaPath ? item.getMediaPath() : "";
        if (item.getDuration) {
            var ticks = String(item.getDuration());
            info.duration = parseFloat(ticks) / 254016000000; // Premiere ticks to seconds
        }
        // Check XMP for audio/video
        if (item.xmpMetadata) {
            var xmp = item.xmpMetadata;
            info.hasAudio = xmp.indexOf("Audio") >= 0;
            info.hasVideo = xmp.indexOf("Video") >= 0;
        }
    } catch(e) {
        info.error = e.toString();
    }
    return info;
}
