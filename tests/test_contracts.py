from backend.services.chat_engine import chat_engine


def test_parameter_aliases_are_normalized():
    params = chat_engine._normalize_action_parameters(
        {
            "clip_name": "A001",
            "track_index": 2,
            "output_path": "C:/tmp/out.mp4",
            "rules": [{"bin_name": "B-Roll", "filter": "video"}],
        }
    )

    assert params["clipName"] == "A001"
    assert params["trackIndex"] == 2
    assert params["outputPath"] == "C:/tmp/out.mp4"
    assert params["rules"][0]["binName"] == "B-Roll"


def test_supported_intents_build_premiere_commands():
    expected = {
        "import_files": "importFiles",
        "add_clips": "addAllBinClips",
        "insert_clip": "insertClipAtTime",
        "remove_clips": "removeTimelineClips",
        "clear_labels": "clearTimelineLabels",
        "move_clip": "moveClip",
        "create_sequence": "createSequence",
        "query_project": "scanProject",
        "apply_effect": "applyEffect",
        "apply_transition": "applyTransitionToAll",
        "set_audio": "setAudioLevel",
        "normalize_audio": "normalizeAudio",
        "audio_fade": "audioFade",
        "export": "exportSequence",
        "add_marker": "addMarker",
        "organize": "organizeBin",
        "label_clips": "setClipLabel",
        "set_speed": "modifyClip",
        "set_scale": "modifyClip",
        "undo": "undoAction",
        "manage_tracks": "manageTracks",
    }

    for intent, command in expected.items():
        action = chat_engine._build_action(intent, {})
        assert action["type"] == "premiere_command"
        assert action["command"] == command
