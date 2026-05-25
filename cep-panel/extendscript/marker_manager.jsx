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
        if (!seq) return editflowUtils.safeStringify({ markers: [] });

        var markers = [];
        try {
            var marker = seq.markers.getFirstMarker();
            while (marker) {
                markers.push({
                    name: marker.name,
                    time: editflowUtils.ticksToSeconds(marker.start),
                    comment: marker.comments || "",
                    type: marker.type || ""
                });
                marker = seq.markers.getNextMarker(marker);
            }
        } catch (e) {}

        return editflowUtils.safeStringify({ markers: markers });
    }

    return {
        addMarkerToSequence: addMarkerToSequence,
        addPhraseRangeMarkers: addPhraseRangeMarkers,
        getSequenceMarkers: getSequenceMarkers
    };
})();
