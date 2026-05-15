/**
 * EditFlow AI - Project Scanner
 * Scans the Premiere Pro project for all media items.
 */

var projectScanner = (function() {
    "use strict";

    /**
     * Scan all project items recursively.
     * @returns {Object} Scanned media info
     */
    function scanAll() {
        var result = {
            success: true,
            items: [],
            sequences: [],
            bins: []
        };

        var project = app.project;
        if (!project) {
            result.success = false;
            result.error = "No project open";
            return result;
        }

        var root = project.rootItem;
        scanBin(root, result, 0, "");

        return result;
    }

    /**
     * Recursively scan a bin (folder) for media items.
     * @param {ProjectItem} bin - The bin to scan
     * @param {Object} result - Result accumulator
     * @param {number} depth - Current depth
     * @param {string} binPath - Current bin path
     */
    function scanBin(bin, result, depth, binPath) {
        for (var i = 0; i < bin.children.numItems; i++) {
            var item = bin.children[i];

            if (item.type === ProjectItemType.BIN) {
                var childPath = binPath ? (binPath + "/" + item.name) : item.name;
                result.bins.push({
                    name: item.name,
                    itemId: item.nodeId,
                    path: childPath,
                    binPath: childPath,
                    bin_path: childPath,
                    parentPath: binPath || "",
                    parent_path: binPath || "",
                    childCount: item.children.numItems,
                    depth: depth
                });
                scanBin(item, result, depth + 1, childPath);
            }
            else if (item.type === ProjectItemType.CLIP ||
                     item.type === ProjectItemType.FILE) {
                result.items.push(getItemInfo(item, binPath));
            }
            else if (item.type === ProjectItemType.SEQUENCE) {
                result.sequences.push({
                    name: item.name,
                    itemId: item.nodeId,
                    sequenceId: item.sequenceID,
                    binPath: binPath,
                    bin_path: binPath
                });
            }
        }
    }

    /**
     * Get detailed info about a project item.
     * @param {ProjectItem} item
     * @param {string} binPath
     * @returns {Object} Item info
     */
    function getItemInfo(item, binPath) {
        var info = {
            name: item.name,
            itemId: item.nodeId,
            type: item.type,
            mediaPath: "",
            binPath: binPath || "",
            bin_path: binPath || ""
        };

        // Get media path
        try {
            var mediaPath = item.getMediaPath();
            info.mediaPath = mediaPath || "";
        } catch(e) {
            info.mediaPath = "";
        }

        try {
            info.mediaType = item.mediaType || "";
        } catch(e2) {
            info.mediaType = "";
        }

        try {
            info.has_video = (item.hasVideo && (item.hasVideo() === 1 || item.hasVideo() === true));
            info.has_audio = (item.hasAudio && (item.hasAudio() === 1 || item.hasAudio() === true));
            info.hasVideo = info.has_video;
            info.hasAudio = info.has_audio;
        } catch(e3) {}

        // Get clip properties if available
        try {
            var xmp = item.getXMPMetadata();
            if (xmp) {
                info.hasXMP = true;
            }
        } catch(e) {}

        // Get duration from source
        try {
            if (item.getInPoint && item.getOutPoint) {
                var inPoint = item.getInPoint();
                var outPoint = item.getOutPoint();
                info.inPoint = inPoint.seconds;
                info.outPoint = outPoint.seconds;
                info.duration = outPoint.seconds - inPoint.seconds;
            }
        } catch(e) {}


        return info;
    }

    /**
     * Find project items that match a path.
     * @param {string} path - File path to search for
     * @returns {Array} Matching items
     */
    function findByPath(path) {
        var matches = [];
        var project = app.project;
        if (!project) return matches;

        searchByPath(project.rootItem, path, matches);
        return matches;
    }

    function searchByPath(bin, path, matches) {
        for (var i = 0; i < bin.children.numItems; i++) {
            var item = bin.children[i];

            if (item.type === ProjectItemType.BIN) {
                searchByPath(item, path, matches);
            }
            else if (item.type === ProjectItemType.CLIP ||
                     item.type === ProjectItemType.FILE) {
                try {
                    var mediaPath = item.getMediaPath();
                    if (mediaPath && mediaPath.toLowerCase() === path.toLowerCase()) {
                        matches.push({
                            name: item.name,
                            itemId: item.nodeId,
                            mediaPath: mediaPath
                        });
                    }
                } catch(e) {}
            }
        }
    }

    // Public API
    return {
        scanAll: scanAll,
        findByPath: findByPath,
        getItemInfo: getItemInfo
    };
})();
