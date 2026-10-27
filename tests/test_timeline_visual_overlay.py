"""
Unit tests for EditFlow AI Timeline Visual Overlay Service
Tests:
1. Transcribed sequence segment alignment with script beats.
2. Autonomous speech concept extraction when no script is provided.
3. Micro-slot B-roll placement on Track V2 with face anchors.
4. Strict zero-repetition across sequence.
5. Single-undo EDL operations generation for Premiere Pro.
"""
import pytest
from backend.services.broll_placement_engine import BrollPlacementEngine
from backend.services.timeline_visual_service import TimelineVisualService


def test_align_segments_with_script():
    service = TimelineVisualService()

    sample_script = """
# Script 07 — Test Script
#### 0:00.00–0:06.42 | ACT 1: THE ESTABLISHMENT — MASJID AR-RAHMAN
- **Visual:** Handheld selfie perspective on the grounds of the campus.
- **Audio — Youth Speaker (`WhatsApp Video`):**
  > "Right now we are at Masjid Ar-Rahman which is also a full-time academy"

#### 0:06.42–0:15.50 | ACT 2: THE FRIDAY SURGE — 200 TO 300 WORSHIPPERS
- **Visual:** Cut to Senior Elder founder. Bold Friday counter animation.
- **Audio — Senior Elder Speaker (`C1307 07`):**
  > "especially the Friday when there are more than 200 and around 300 people big problem of parking"
"""

    transcribed_segments = [
        {
            "start": 0.0,
            "end": 6.4,
            "duration": 6.4,
            "text": "Right now we are at Masjid Ar-Rahman which is also a full-time academy",
            "speaker": "Speaker",
            "cue": ""
        },
        {
            "start": 6.4,
            "end": 15.5,
            "duration": 9.1,
            "text": "especially the Friday when there are more than 200 and around 300 people big problem of parking",
            "speaker": "Speaker",
            "cue": ""
        }
    ]

    aligned = service.align_segments_with_script(transcribed_segments, script_content=sample_script)

    assert len(aligned) == 2
    # Verify alignment picked up speaker and cues
    assert aligned[0]["speaker"] == "Youth Speaker"
    assert "campus" in aligned[0]["cue"].lower()
    assert aligned[1]["speaker"] == "Senior Elder Speaker"
    assert "friday" in aligned[1]["cue"].lower() or "parking" in aligned[1]["text"].lower()


def test_autonomous_speech_concept_matching_and_v2_placement():
    """
    Test that even without a script, spoken clauses are assigned to concepts,
    sliced into micro-visuals on Track V2, face-anchored on V1, and 100% unique.
    """
    segments = [
        {
            "start": 0.0,
            "end": 6.6,
            "duration": 6.6,
            "text": "Our parking lot is completely broken and full of potholes and mud condition",
            "speaker": "Speaker 1",
            "cue": ""
        },
        {
            "start": 6.6,
            "end": 14.5,
            "duration": 7.9,
            "text": "Vehicles and cars are overflowing on the grass and driveway outside",
            "speaker": "Speaker 2",
            "cue": ""
        },
        {
            "start": 14.5,
            "end": 22.0,
            "duration": 7.5,
            "text": "We need to establish our planned 77 parking spots layout and blueprint",
            "speaker": "Speaker 3",
            "cue": ""
        },
        {
            "start": 22.0,
            "end": 28.5,
            "duration": 6.5,
            "text": "When the heavy winter snow and cold weather hits Buffalo elders cannot come inside",
            "speaker": "Speaker 4",
            "cue": ""
        }
    ]

    placements, cuts = BrollPlacementEngine.place_broll_for_timeline_segments(
        segments=segments,
        aspect_ratio="9:16",
        pacing_style="editorial",
        target_track=1,  # Track V2
    )

    # 1. High density micro-visuals: 4 cuts of 6.5-7.9s should generate at least 8 micro-visuals
    assert len(placements) >= 8, f"Expected >= 8 micro-visuals, got {len(placements)}"

    # 2. Track V2 assignment
    for p in placements:
        assert p.track == 1, f"Placement track should be 1 (V2), got {p.track}"
        assert p.duration >= 1.0, f"Micro-visual duration should be >= 1.0s, got {p.duration}"

    # 3. 100% Unique assets across sequence (strict zero repetition)
    stems = [p.name for p in placements]
    assert len(stems) == len(set(stems)), f"Duplicate B-rolls detected across timeline: {stems}"

    # 4. Face anchor verification:
    # First placement in each cut must start >= 0.8s after cut's timeline start
    for cut in cuts:
        if cut.broll_placements:
            first_broll = cut.broll_placements[0]
            anchor = first_broll["timeline_start"] - cut.timeline_start
            assert anchor >= 0.79, f"Cut {cut.cut_index} face anchor too short: {anchor}s"


def test_timeline_edl_ops_generation():
    service = TimelineVisualService()

    segments = [
        {
            "start": 0.0,
            "end": 6.0,
            "duration": 6.0,
            "text": "our parking lot is completely broken and muddy",
            "speaker": "Speaker",
            "cue": ""
        }
    ]

    placements, cuts = BrollPlacementEngine.place_broll_for_timeline_segments(
        segments=segments,
        pacing_style="editorial",
        target_track=1,
    )

    ops = service.generate_timeline_edl_ops(placements, target_track=1, sequence_name="Test Timeline")

    assert len(ops) >= 3
    # Check single-undo wrapping
    assert ops[0]["action"] == "beginUndoGroup"
    assert "V2" in ops[0]["name"]
    assert ops[-1]["action"] == "endUndoGroup"

    # Check add operations
    add_ops = [op for op in ops if op.get("action") == "add"]
    assert len(add_ops) == len(placements)
    for add_op in add_ops:
        assert add_op["video_track_index"] == 1  # Track V2
        assert add_op["audio_track_index"] in ("auto", -1)  # Preserves timeline dialogue on A1/A2
        assert add_op["startTime"] >= 0.0
        assert add_op["outPoint"] > add_op["inPoint"]
