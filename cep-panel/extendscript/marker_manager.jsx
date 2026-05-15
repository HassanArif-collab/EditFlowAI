var markerManager = (function() {
    "use strict";

    /**
     * Add a marker to the active sequence.
     * @param {Object} options
     *   - time: number — Time in seconds
     *   - name: string — Marker name
     *   - comment: string — Marker comment (optional)
     *   - color: number — Color index 0-7 (optional)
     *   - duration: number — Duration in seconds (default 0 = point marker)
     * @returns {Object} { success, markerName, time }
     */
    function addMarkerToSequence(options) {
        try {
            var seq = app.project.activeSequence;
            if (!seq) return { success: false, error: "No active sequence" };

            var timeSeconds = parseFloat(options.time || 0);
            var marker = seq.markers.createMarker(timeSeconds);

            marker.name = options.name || "Marker";
            if (options.comment) marker.comments = options.comment;
            if (options.duration) {
                marker.end = timeSeconds + parseFloat(options.duration);
            }


            return {
                success: true,
                markerName: marker.name,
                time: timeSeconds
            };
        } catch(e) {
            return { success: false, error: e.toString() };
        }
    }

    /**
     * Get all markers from the active sequence.
     * @returns {Object} { success, markers[] }
     */
    function getSequenceMarkers() {
        try {
            var seq = app.project.activeSequence;
            if (!seq) return { success: false, error: "No active sequence" };

            var markers = [];
            var m = seq.markers.getFirstMarker();
            while (m) {
                markers.push({
                    name: m.name || "",
                    comment: m.comments || "",
                    time: m.start.seconds,
                    duration: m.end ? (m.end.seconds - m.start.seconds) : 0,
                    type: m.type || "comment"
                });
                m = seq.markers.getNextMarker(m);
            }

            return { success: true, markers: markers };
        } catch(e) {
            return { success: false, error: e.toString() };
        }
    }

    return {
        addMarkerToSequence: addMarkerToSequence,
        getSequenceMarkers: getSequenceMarkers
    };
})();
