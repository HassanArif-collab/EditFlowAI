/*
 * project_scanner.jsx - Scan the Premiere Pro project tree.
 * Recursively walks bins, items, and sequences for full project context.
 */
var projectScanner = (function() {
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

            info.mediaPath = item.getMediaPath ? item.getMediaPath() : "";
            info.hasVideo = editflowUtils.hasVideo(item);
            info.hasAudio = editflowUtils.hasAudio(item);

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
