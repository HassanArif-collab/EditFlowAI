/*
 * caption_importer.jsx - Import a ProRes 4444 caption video into Premiere Pro.
 *
 * This is the "Apply" step of the ProRes technique:
 *   1. Import the .mov file into the project bin
 *   2. Create a new video track on top (if needed)
 *   3. Place the clip on that track at time 0
 *
 * The video has an alpha channel (ProRes 4444) so it overlays cleanly
 * on top of the existing video. One clip = smooth playback, no memory crash.
 */
captionImporter = (function() {
    "use strict";

    function _ok(obj)  { obj = obj || {}; obj.success = true;  return editflowUtils.safeStringify(obj); }
    function _err(msg) { return editflowUtils.safeStringify({ success: false, error: String(msg) }); }

    // ── Get sequence settings ──
    function getSequenceSettings() {
        var seq = app.project.activeSequence;
        if (!seq) return _err("No active sequence — open a sequence first.");
        try {
            var s = seq.getSettings();
            return _ok({
                width: s.videoFrameWidth,
                height: s.videoFrameHeight,
                fps: (s.videoFrameRate && s.videoFrameRate.seconds)
                        ? Math.round(1 / s.videoFrameRate.seconds) : 0,
                durationSeconds: editflowUtils.getSequenceEnd(seq),
                videoTracks: seq.videoTracks.numTracks,
                name: seq.name
            });
        } catch (e) {
            return _err(e);
        }
    }

    // ── Import + place caption video ──
    function importCaptionVideo(options) {
        var seq = app.project.activeSequence;
        if (!seq) return _err("No active sequence — open a sequence first.");

        var videoPath = editflowUtils.getParam(options, 'videoPath');
        if (!videoPath) return _err("No videoPath provided.");
        var videoFile = new File(videoPath);
        if (!videoFile.exists) return _err("Caption video not found: " + videoPath);

        app.beginUndoGroup("EditFlow: Import Caption Video");

        try {
            // 1. Import the .mov file into the project bin
            //    importFiles returns boolean; the imported item ends up in the
            //    currently-selected bin (or root bin if none selected).
            var imported = false;
            try {
                // Try importing to the root project bin
                imported = app.project.importFiles(
                    [videoFile.fsName],  // array of paths
                    true,                // suppressUI
                    app.project.rootItem, // target bin
                    false                // importAsNumberedStills
                );
            } catch (e) {
                return _err("importFiles failed: " + e.toString());
            }

            if (!imported) {
                return _err("importFiles returned false — file may already be imported or format unsupported.");
            }

            // 2. Find the imported ProjectItem (search root bin for our file)
            var captionItem = null;
            for (var i = 0; i < app.project.rootItem.children.numItems; i++) {
                var child = app.project.rootItem.children[i];
                if (child.name === videoFile.name || child.name === videoFile.name.replace(/\.[^.]+$/, "")) {
                    captionItem = child;
                    break;
                }
            }
            if (!captionItem) {
                return _err("Imported file not found in project bin: " + videoFile.name);
            }

            // 3. Create a new video track on top (so captions never overwrite existing clips)
            //    Only create if there isn't already an empty track on top.
            var trackIndex = seq.videoTracks.numTracks;  // 0-based, so this is the next track
            try {
                // ensureTracks(sequence, numVideoTracks, numAudioTracks)
                if (typeof trackManager !== 'undefined' && trackManager.ensureTracks) {
                    trackManager.ensureTracks(seq, seq.videoTracks.numTracks + 1, 0);
                }
            } catch (e) {
                // Non-fatal — we'll try to use the topmost existing track
            }
            // Use the topmost track (newly created or existing)
            trackIndex = seq.videoTracks.numTracks - 1;
            if (trackIndex < 0) trackIndex = 0;

            // 4. Place the clip on the track at time 0
            var track = seq.videoTracks[trackIndex];
            if (!track) {
                return _err("Could not access video track " + trackIndex);
            }

            // insertClip(projectItem, time, vidTrack, audTrack) — but this is for
            // the older API. The modern way is to use overwriteClip or insertClip.
            var placed = false;
            try {
                // Try overwriteClip (places at given time, overwrites nothing if track is empty)
                // Time is in ticks (string)
                var startTicks = editflowUtils.secondsToTicksString(0);
                track.overwriteClip(captionItem, startTicks);
                placed = true;
            } catch (e) {
                // Fallback: try insertClip
                try {
                    track.insertClip(captionItem, startTicks);
                    placed = true;
                } catch (e2) {
                    return _err("Could not place clip: overwriteClip=" + e.toString() + " | insertClip=" + e2.toString());
                }
            }

            if (!placed) {
                return _err("Failed to place caption video on track.");
            }

            // 5. Find the placed clip and verify
            var placedClip = null;
            for (var j = 0; j < track.clips.numItems; j++) {
                var c = track.clips[j];
                if (c.projectItem && c.projectItem.nodeId === captionItem.nodeId) {
                    placedClip = c;
                    break;
                }
            }

            return _ok({
                imported: true,
                placed: true,
                project_item: captionItem.name,
                track_index: trackIndex,
                clip_name: placedClip ? placedClip.name : "unknown",
                clip_start: placedClip ? editflowUtils.ticksToSeconds(placedClip.start.ticks) : 0,
                clip_end: placedClip ? editflowUtils.ticksToSeconds(placedClip.end.ticks) : 0,
                video_path: videoFile.fsName
            });

        } finally {
            app.endUndoGroup();
        }
    }

    // ── Remove existing caption clips (for re-applying) ──
    function clearCaptionClips() {
        var seq = app.project.activeSequence;
        if (!seq) return _err("No active sequence.");

        var removed = 0;
        app.beginUndoGroup("EditFlow: Clear Caption Clips");
        try {
            // Look for clips named "captions_*" on all video tracks
            for (var i = 0; i < seq.videoTracks.numTracks; i++) {
                var track = seq.videoTracks[i];
                var toRemove = [];
                for (var j = 0; j < track.clips.numItems; j++) {
                    var clip = track.clips[j];
                    if (clip.name && clip.name.indexOf("captions_") === 0) {
                        toRemove.push(clip);
                    }
                }
                // Remove in reverse order (indices shift on removal)
                for (var k = toRemove.length - 1; k >= 0; k--) {
                    toRemove[k].remove();
                    removed++;
                }
            }
        } finally {
            app.endUndoGroup();
        }
        return _ok({ removed: removed });
    }

    return {
        getSequenceSettings: getSequenceSettings,
        importCaptionVideo: importCaptionVideo,
        clearCaptionClips: clearCaptionClips
    };
})();
