/*
 * marker_manager.jsx - Manage sequence markers in Premiere Pro.
 */
var markerManager = (function() {
    "use strict";

    function addMarkerToSequence(options) {
        var seq = app.project.activeSequence;
        if (!seq) return editflowUtils.safeStringify({ success: false, error: "No active sequence" });

        var time = editflowUtils.getParam(options, 'time', 'startTime') || 0;
        var name = editflowUtils.getParam(options, 'name') || "EditFlow Marker";
        var comment = editflowUtils.getParam(options, 'comment') || "";
        var color = editflowUtils.getParam(options, 'color') || 0; // Green

        try {
            var marker = seq.markers.createMarker(time);
            if (name) marker.name = name;
            if (comment) marker.comments = comment;
            try { marker.setColorByIndex(color); } catch (e) {}

            return editflowUtils.safeStringify({ success: true, time: time, name: name });
        } catch (e) {
            return editflowUtils.safeStringify({ success: false, error: e.toString() });
        }
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
        getSequenceMarkers: getSequenceMarkers
    };
})();
