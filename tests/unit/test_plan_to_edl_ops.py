"""Unit tests for plan_to_edl_ops in cut_planner.py.

Verifies the data contract between the Python backend and the
ExtendScript processEDLOps handler in clip_manager.jsx.

Key invariant: one 'add' op per cut (not two) with both
video_track_index and audio_track_index present.

Regression test for the bug where the backend emitted TWO 'add' ops
per cut (one for video, one for audio) but the ExtendScript handler
used videoTracks[trackIndex] for all ops — silently dropping audio
onto a non-existent second video track.
"""
import pytest

from backend.services.cut_planner import Cut, Plan, plan_to_edl_ops


def _make_plan(num_cuts=3):
    """Build a minimal Plan with the given number of cuts."""
    cuts = []
    for i in range(num_cuts):
        cuts.append(Cut(
            beat_index=i,
            beat_text=f"Beat {i}",
            take_source_file="C:/Videos/source.mov",
            source_in=float(i * 10),
            source_out=float(i * 10 + 8),
            duration=8.0,
            timeline_position=float(i * 8),
            audio_fade_in_ms=15,
            audio_fade_out_ms=15,
            take_id=f"source.mov::take_0",
            confidence=0.85,
        ))
    return Plan(
        plan_id="test123",
        created_at="2026-01-01T00:00:00+00:00",
        bin_reference="Test Bin",
        script="test script",
        user_hint=None,
        matcher_model="test-model",
        cuts=cuts,
        gaps=[],
        summary={},
    )


class TestPlanToEdlOps:
    """Test plan_to_edl_ops data contract."""

    def test_one_add_op_per_cut(self):
        """Each cut produces exactly ONE 'add' op, not two.

        The old code emitted separate video and audio add ops;
        the new code uses insertClip's 4-arg form which handles
        both in one call.
        """
        plan = _make_plan(num_cuts=3)
        ops = plan_to_edl_ops(plan, "Test Sequence")
        add_ops = [o for o in ops if o["action"] == "add"]
        assert len(add_ops) == 3, (
            f"Expected 1 add op per cut (3 cuts → 3 ops), got {len(add_ops)}"
        )

    def test_add_op_has_both_track_indices(self):
        """Each 'add' op must include video_track_index and audio_track_index.

        The ExtendScript addClipToSequence reads these to call
        seq.insertClip(item, ticks, videoTrackIndex, audioTrackIndex).
        """
        plan = _make_plan(num_cuts=3)
        ops = plan_to_edl_ops(plan, "Test Sequence")
        add_ops = [o for o in ops if o["action"] == "add"]

        for op in add_ops:
            assert "video_track_index" in op, (
                f"Missing video_track_index in add op: {op}"
            )
            assert "audio_track_index" in op, (
                f"Missing audio_track_index in add op: {op}"
            )

    def test_add_op_track_indices_default_to_zero(self):
        """Default track indices are V1 (0) and A1 (0)."""
        plan = _make_plan(num_cuts=1)
        ops = plan_to_edl_ops(plan, "Test Sequence")
        add_op = next(o for o in ops if o["action"] == "add")

        assert add_op["video_track_index"] == 0
        assert add_op["audio_track_index"] == 0

    def test_create_sequence_op_has_name(self):
        """The create_sequence op carries the target sequence name."""
        plan = _make_plan(num_cuts=1)
        ops = plan_to_edl_ops(plan, "My Cut Sequence")
        create_op = next(o for o in ops if o["action"] == "create_sequence")

        assert create_op["name"] == "My Cut Sequence"

    def test_in_out_points_match_cut(self):
        """Each add op's inPoint/outPoint match the cut's source range."""
        plan = _make_plan(num_cuts=1)
        ops = plan_to_edl_ops(plan, "Test Sequence")
        add_op = next(o for o in ops if o["action"] == "add")
        cut = plan.cuts[0]

        assert add_op["inPoint"] == cut.source_in
        assert add_op["outPoint"] == cut.source_out

    def test_legacy_trackIndex_not_in_add_ops(self):
        """The old 'trackIndex' key should NOT appear in add ops.

        It was ambiguous (0 for video, 1 for audio) and caused the
        ExtendScript handler to route audio to videoTracks[1].
        The new keys are video_track_index and audio_track_index.
        """
        plan = _make_plan(num_cuts=1)
        ops = plan_to_edl_ops(plan, "Test Sequence")
        add_op = next(o for o in ops if o["action"] == "add")

        assert "trackIndex" not in add_op, (
            f"Legacy 'trackIndex' key found in add op — should use "
            f"video_track_index/audio_track_index instead. Op: {add_op}"
        )

    def test_undo_group_wraps_all_ops(self):
        """First op is beginUndoGroup, last is endUndoGroup."""
        plan = _make_plan(num_cuts=1)
        ops = plan_to_edl_ops(plan, "Test Sequence")

        assert ops[0]["action"] == "beginUndoGroup"
        assert ops[-1]["action"] == "endUndoGroup"

    def test_import_file_ops_include_source(self):
        """import_file ops reference the source file from cuts."""
        plan = _make_plan(num_cuts=2)
        ops = plan_to_edl_ops(plan, "Test Sequence")
        import_ops = [o for o in ops if o["action"] == "import_file"]

        assert len(import_ops) >= 1
        assert all(o["mediaPath"] == "C:/Videos/source.mov" for o in import_ops)
