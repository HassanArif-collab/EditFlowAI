from backend.services.chat_engine import ChatEngine


def test_label_clear_command_routes_to_premiere_action():
    engine = ChatEngine()
    parsed = engine._deterministic_command(
        "remove mango label color from the whole sequence of WhatsApp Video 2026-04-15"
    )
    action = engine._build_action(parsed["intent"], parsed["parameters"])

    assert parsed["intent"] == "clear_labels"
    assert parsed["parameters"]["labelName"] == "Mango"
    assert action["command"] == "clearTimelineLabels"
    assert "already" not in parsed["response"].lower()


def test_unknown_copy_selected_clip_does_not_fake_execution():
    engine = ChatEngine()
    parsed = engine._deterministic_command("copy the selected clip and paste it to V2")

    assert parsed["intent"] == "chat"
    assert "not wired" in parsed["response"]


def test_folder_sequence_request_routes_to_v2_planning():
    engine = ChatEngine()
    parsed = engine._deterministic_command(
        "take the videos of folder 6 that is in the raw folder and make a polished version with a new sequence"
    )
    action = engine._build_action(parsed["intent"], parsed["parameters"])

    assert parsed["intent"] == "v2_folder_sequence"
    assert parsed["parameters"]["rootAlias"] == "raw"
    assert parsed["parameters"]["folderName"] == "6"
    assert action["type"] == "v2_folder_sequence"


def test_explicit_bin_sequence_request_routes_to_v2_planning():
    engine = ChatEngine()
    parsed = engine._deterministic_command("take videos from @bin:Raw/6 and make a new sequence")
    action = engine._build_action(parsed["intent"], parsed["parameters"])

    assert parsed["intent"] == "v2_folder_sequence"
    assert parsed["parameters"]["kind"] == "bin"
    assert parsed["parameters"]["binPath"] == "Raw/6"
    assert action["type"] == "v2_folder_sequence"
