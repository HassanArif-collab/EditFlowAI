/*
 * capability_probe.jsx - ExtendScript capability probe for EditFlow AI v2.
 *
 * Probes Premiere Pro's ExtendScript DOM to discover which APIs are
 * actually available at runtime.  The result is posted to the backend
 * via POST /api/preflight/capabilities so that Python-side code knows
 * what it can rely on.
 *
 * Called from editflowDispatch with command "probeCapabilities".
 */
var capabilityProbe = (function () {
    // ── Helpers ──

    function safeCall(fn) {
        // Returns {ok: true, value: …} or {ok: false, error: …}
        try {
            var result = fn();
            return { ok: true, value: result };
        } catch (e) {
            return { ok: false, error: e.toString() };
        }
    }

    function hasGlobal(name) {
        try {
            return typeof eval(name) !== "undefined";
        } catch (e) {
            return false;
        }
    }

    // ── Individual capability checks ──

    function checkQE() {
        // Does the quality-engine (qe) global exist?
        return hasGlobal("qe");
    }

    function checkQERazor() {
        // Does qe.sequence razor() exist?
        if (!hasGlobal("qe")) return false;
        var r = safeCall(function () {
            return typeof qe.project.getActiveSequence !== "undefined";
        });
        if (!r.ok) return false;
        var seqResult = safeCall(function () {
            return qe.project.getActiveSequence(0);
        });
        if (!seqResult.ok || !seqResult.value) return false;
        return safeCall(function () {
            return typeof seqResult.value.razor === "function";
        }).value || false;
    }

    function checkMarkerSeconds() {
        // Can seq.markers.createMarker accept a seconds value?
        try {
            var seq = app.project.activeSequence;
            if (!seq || !seq.markers) return false;
            // Check if createMarker method exists
            if (typeof seq.markers.createMarker !== "function") return false;
            // We don't actually create a marker — just confirm the API is present.
            return true;
        } catch (e) {
            return false;
        }
    }

    function checkFrameSize() {
        // Does seq.frameSizeHorizontal exist?
        try {
            var seq = app.project.activeSequence;
            if (!seq) return false;
            var r = safeCall(function () {
                return seq.frameSizeHorizontal;
            });
            return r.ok && typeof r.value === "number";
        } catch (e) {
            return false;
        }
    }

    function checkProjectHasPath() {
        // Is a project open and does it have a path on disk?
        try {
            if (!app.project) return false;
            var path = app.project.path;
            return !!path && path.length > 0;
        } catch (e) {
            return false;
        }
    }

    function checkActiveSequence() {
        // Is there an active sequence?
        try {
            return !!app.project.activeSequence;
        } catch (e) {
            return false;
        }
    }

    // ── Main probe function ──

    function probe() {
        var capabilities = {
            qe_available: checkQE(),
            qe_razor: checkQERazor(),
            marker_seconds: checkMarkerSeconds(),
            frame_size: checkFrameSize(),
            project_has_path: checkProjectHasPath(),
            active_sequence: checkActiveSequence()
        };
        return capabilities;
    }

    // Public API
    return {
        probe: probe
    };
})();
