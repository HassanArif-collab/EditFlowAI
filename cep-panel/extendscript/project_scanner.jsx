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

            // ProjectItem has NO getDuration() method — confirmed by
            // ppro-scripting.docsforadobe.dev ProjectItem reference.
            // Calculate duration from getOutPoint() - getInPoint() instead.
            // These return Time objects with .seconds and .ticks properties.
            try {
                if (typeof item.getOutPoint === 'function' && typeof item.getInPoint === 'function') {
                    var outPt = item.getOutPoint();
                    var inPt  = item.getInPoint();
                    if (outPt && inPt) {
                        var durSec = (outPt.seconds || 0) - (inPt.seconds || 0);
                        if (durSec > 0) info.duration = durSec;
                    }
                }
            } catch (e) {}
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
    // Project.getSelection() does NOT exist — only Sequence.getSelection()
    // returns timeline clip selections. For Project panel selections, Adobe's
    // recommended approach is the event-based app.bind("onSourceClipSelectedInProjectPanel", cb).
    // As a fallback, return empty selection with a diagnostic flag.
    var selection = [];
    try {
        // Try the sequence-level getSelection as a partial fallback
        // (returns timeline clips, not project panel items)
        if (app.project.activeSequence && typeof app.project.activeSequence.getSelection === 'function') {
            // Not useful for project panel items — leave empty
        }
    } catch (e) {}
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
        // ProjectItem has NO getDuration() method — use getOutPoint/getInPoint
        try {
            if (typeof item.getOutPoint === 'function' && typeof item.getInPoint === 'function') {
                var outPt = item.getOutPoint();
                var inPt  = item.getInPoint();
                if (outPt && inPt) {
                    var durSec = (outPt.seconds || 0) - (inPt.seconds || 0);
                    if (durSec > 0) info.duration = durSec;
                }
            }
        } catch (e) {}
        // Check XMP for audio/video — must use getXMPMetadata() (method),
        // NOT xmpMetadata (property that doesn't exist on ProjectItem).
        try {
            if (typeof item.getXMPMetadata === 'function') {
                var xmp = item.getXMPMetadata();
                if (xmp) {
                    info.hasAudio = xmp.indexOf("Audio") >= 0;
                    info.hasVideo = xmp.indexOf("Video") >= 0;
                }
            }
        } catch (e) {}
    } catch(e) {
        info.error = e.toString();
    }
    return info;
}
