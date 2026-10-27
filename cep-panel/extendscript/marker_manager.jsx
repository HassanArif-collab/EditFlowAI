/*
 * marker_manager.jsx - Manage sequence markers in Premiere Pro.
 */
markerManager = (function() {
    "use strict";

    function addMarkerToSequence(options) {
        var seq = app.project.activeSequence;
        if (!seq) return editflowUtils.safeStringify({ success: false, error: "No active sequence" });

        var time = editflowUtils.getParam(options, 'time', 'startTime') || 0;
        var name = editflowUtils.getParam(options, 'name') || "EditFlow Marker";
        var comment = editflowUtils.getParam(options, 'comment') || "";
        var color = editflowUtils.getParam(options, 'color') || 0; // Green

        try {
            // createMarker takes seconds (number) in modern Premiere Pro (>= v11).
            // Earlier "fix" to tick string caused 'Illegal Parameter type' rejections
            // on every marker creation.
            var marker = seq.markers.createMarker(time);
            if (name) marker.name = name;
            if (comment) marker.comments = comment;
            try { marker.setColorByIndex(color); } catch (e) {}

            return editflowUtils.safeStringify({ success: true, time: time, name: name });
        } catch (e) {
            return editflowUtils.safeStringify({ success: false, error: e.toString() });
        }
    }

    function addPhraseRangeMarkers(options) {
        var seq = app.project.activeSequence;
        if (!seq) {
            return editflowUtils.safeStringify({ success: false, error: "No active sequence" });
        }

        var ranges = editflowUtils.getParam(options, "ranges") || [];
        var phrase = editflowUtils.getParam(options, "phrase") || "phrase";

        if (!ranges.length) {
            return editflowUtils.safeStringify({
                success: false,
                error: "No phrase ranges supplied"
            });
        }

        var created = 0;
        var failed = 0;
        for (var i = 0; i < ranges.length; i++) {
            var range = ranges[i];
            var start = parseFloat(range.start || 0);
            var end = parseFloat(range.end || 0);
            try {
                // createMarker takes seconds (number) in modern Premiere Pro (>= v11).
                var marker = seq.markers.createMarker(start);
                if (marker) {
                    try { marker.name = "EditFlow remove: " + phrase; } catch (e) {}
                    try {
                        marker.comments = "Remove '" + phrase + "' (" +
                            start.toFixed(3) + "s → " + end.toFixed(3) + "s)";
                    } catch (e) {}
                    // Convert point marker into a range marker. PPro versions vary —
                    // wrap in try/catch so a single failure doesn't kill the loop.
                    // marker.end also takes seconds in modern PPro.
                    try { marker.end = end; } catch (e) {}
                    try { marker.setColorByIndex(2); } catch (e) {} // red-ish
                    created++;
                } else {
                    failed++;
                }
            } catch (e) {
                failed++;
            }
        }

        return editflowUtils.safeStringify({
            success: true,
            markers: created,
            failed: failed,
            total: ranges.length,
            phrase: phrase
        });
    }

    function getSequenceMarkers() {
        var seq = app.project.activeSequence;
        if (!seq) return editflowUtils.safeStringify({ success: false, markers: [] });

        var markers = [];
        try {
            var marker = seq.markers.getFirstMarker();
            while (marker) {
                var t = 0;
                if (marker.start !== undefined && marker.start !== null) {
                    if (typeof marker.start === 'object' && marker.start.seconds !== undefined) {
                        t = marker.start.seconds;
                    } else if (typeof marker.start === 'object' && marker.start.ticks !== undefined) {
                        t = editflowUtils.ticksToSeconds(marker.start.ticks);
                    } else {
                        var num = parseFloat(marker.start);
                        if (num > 10000000) {
                            t = editflowUtils.ticksToSeconds(num);
                        } else {
                            t = num;
                        }
                    }
                }
                markers.push({
                    name: marker.name || "",
                    time: Math.round(t * 100) / 100,
                    comment: marker.comments || "",
                    type: marker.type || ""
                });
                marker = seq.markers.getNextMarker(marker);
            }
        } catch (e) {}

        return editflowUtils.safeStringify({ success: true, markers: markers });
    }

    function setChapterMarkers(options) {
        var seq = app.project.activeSequence;
        if (!seq) return editflowUtils.safeStringify({ success: false, error: "No active sequence" });

        var chapters = editflowUtils.getParam(options, 'chapters') || [];
        var clearExisting = editflowUtils.getParam(options, 'clearExisting');
        if (clearExisting === undefined) clearExisting = false;
        var color = editflowUtils.getParam(options, 'color');
        if (color === undefined || color === null) color = 4; // Cyan/Blue default for chapter markers

        if (!chapters.length) {
            return editflowUtils.safeStringify({ success: false, error: "No chapters supplied" });
        }

        try {
            if (clearExisting && seq.markers) {
                var toDelete = [];
                var cur = seq.markers.getFirstMarker();
                while (cur) {
                    var shouldDelete = false;
                    try {
                        if (cur.type === "Chapter") shouldDelete = true;
                    } catch (e0) {}
                    try {
                        if (cur.name && cur.name.indexOf("Chapter") !== -1) shouldDelete = true;
                        if (cur.comments && cur.comments.indexOf("EditFlow") !== -1) shouldDelete = true;
                    } catch (e1) {}
                    if (shouldDelete) {
                        toDelete.push(cur);
                    }
                    cur = seq.markers.getNextMarker(cur);
                }
                for (var d = 0; d < toDelete.length; d++) {
                    try { seq.markers.deleteMarker(toDelete[d]); } catch (e2) {}
                }
            }

            var created = 0;
            var failed = 0;
            for (var i = 0; i < chapters.length; i++) {
                var ch = chapters[i];
                var t = parseFloat(ch.time || 0);
                if (isNaN(t) || t < 0) t = 0;
                var title = ch.title || ch.name || ("Chapter " + (i + 1));
                var comment = ch.comment || "EditFlow Chapter";

                try {
                    var marker = seq.markers.createMarker(t);
                    if (marker) {
                        try { marker.name = title; } catch (e3) {}
                        try { marker.comments = comment; } catch (e4) {}
                        try { marker.setColorByIndex(color); } catch (e5) {}
                        try { marker.setTypeAsChapter(); } catch (e6) {}
                        created++;
                    } else {
                        failed++;
                    }
                } catch (e7) {
                    failed++;
                }
            }

            return editflowUtils.safeStringify({
                success: true,
                count: created,
                created: created,
                failed: failed,
                total: chapters.length
            });
        } catch (e) {
            return editflowUtils.safeStringify({ success: false, error: e.toString() });
        }
    }

    return {
        addMarkerToSequence: addMarkerToSequence,
        addPhraseRangeMarkers: addPhraseRangeMarkers,
        getSequenceMarkers: getSequenceMarkers,
        setChapterMarkers: setChapterMarkers
    };
})();
