"""The correction pass must fix mishearings WITHOUT touching timestamps or
rewriting speech. Every test here defends one of those two properties,
because losing either makes the transcript useless for captions and for
syncing visuals to the voiceover."""
from backend.services.subtitles.transcript_corrector import (
    apply_corrections, build_prompt, chunk_words, parse_corrections,
)


def words(*pairs):
    return [{"word": w, "start": s, "end": s + 0.3} for w, s in pairs]


# ── parsing a model reply ──────────────────────────────────────────

def test_a_clean_json_array_is_parsed():
    out = parse_corrections('[{"i": 2, "to": "روپے"}]', 5)
    assert out == [{"i": 2, "to": "روپے"}]


def test_prose_and_code_fences_around_the_json_are_tolerated():
    raw = 'Sure! Here are the fixes:\n```json\n[{"i": 1, "to": "گنا"}]\n```\nHope that helps.'
    assert parse_corrections(raw, 5) == [{"i": 1, "to": "گنا"}]


def test_a_reply_with_no_json_yields_nothing_rather_than_crashing():
    assert parse_corrections("I could not find any errors.", 5) == []
    assert parse_corrections("", 5) == []
    assert parse_corrections("[not valid json", 5) == []


def test_an_index_outside_the_transcript_is_dropped():
    # a model that invents index 99 on a 3-word transcript must not corrupt it
    assert parse_corrections('[{"i": 99, "to": "x"}, {"i": -1, "to": "y"}]', 3) == []


def test_a_multi_word_replacement_is_refused():
    # "روپے کروڑ" would change the word count and break every later timestamp
    assert parse_corrections('[{"i": 0, "to": "روپے کروڑ"}]', 3) == []


def test_duplicate_indices_keep_only_the_first():
    out = parse_corrections('[{"i": 1, "to": "a"}, {"i": 1, "to": "b"}]', 3)
    assert out == [{"i": 1, "to": "a"}]


# ── applying corrections ───────────────────────────────────────────

def test_timestamps_survive_a_correction_untouched():
    w = words(("کروڑ", 1.0), ("پے", 1.4), ("جو", 2.0))
    res = apply_corrections(w, [{"i": 1, "to": "روپے"}])
    assert res["words"][1]["word"] == "روپے"
    assert res["words"][1]["start"] == 1.4, "the whole point: timing is preserved"
    assert res["words"][1]["end"] == 1.7


def test_word_count_is_invariant():
    w = words(("دس", 0.0), ("گناہ", 0.5), ("کر", 1.0))
    res = apply_corrections(w, [{"i": 1, "to": "گنا"}])
    assert len(res["words"]) == len(w), "a changed word count desyncs every caption"


def test_changes_are_reported_so_the_user_can_see_what_the_model_did():
    w = words(("کروڑ", 1.0), ("پے", 1.4))
    res = apply_corrections(w, [{"i": 1, "to": "روپے"}])
    assert res["applied"] == 1
    assert res["changes"][0] == {"i": 1, "from": "پے", "to": "روپے", "start": 1.4}


def test_a_correction_identical_to_the_original_is_not_counted():
    w = words(("ٹھیک", 0.0))
    res = apply_corrections(w, [{"i": 0, "to": "ٹھیک"}])
    assert res["applied"] == 0


def test_the_input_list_is_never_mutated():
    w = words(("پے", 1.0))
    apply_corrections(w, [{"i": 0, "to": "روپے"}])
    assert w[0]["word"] == "پے"


def test_both_word_and_text_keys_stay_in_sync():
    # the panel reads either key depending on where the words came from
    w = [{"word": "پے", "text": "پے", "start": 1.0, "end": 1.2}]
    res = apply_corrections(w, [{"i": 0, "to": "روپے"}])
    assert res["words"][0]["word"] == "روپے"
    assert res["words"][0]["text"] == "روپے"


# ── prompt ─────────────────────────────────────────────────────────

def test_the_prompt_forbids_rewriting_and_numbers_every_word():
    p = build_prompt(words(("تو", 0.0), ("اب", 0.4)), language="ur",
                     vocab="روپے، کروڑ", context="A documentary about income.")
    assert "0\tتو" in p and "1\tاب" in p
    assert "ONE word in, ONE word out" in p
    assert "Do NOT fix grammar" in p, "retakes and stumbles must be preserved"
    assert "روپے، کروڑ" in p
    assert "documentary about income" in p


# ── chunking ───────────────────────────────────────────────────────

def test_chunking_keeps_absolute_indices_so_corrections_map_back():
    w = words(*[(f"w{i}", i * 0.5) for i in range(500)])
    chunks = chunk_words(w, 220)
    assert [c[0] for c in chunks] == [0, 220, 440]
    assert len(chunks[-1][1]) == 60
    assert sum(len(c[1]) for c in chunks) == 500


# ── the hallucination guard ────────────────────────────────────────
# A 4B model, asked to correct this transcript live, returned the words
# SHIFTED by an index — valid JSON, plausible shape, every "correction"
# an unrelated word. These tests encode that failure so it can't return.

def test_real_mishearings_are_accepted():
    from backend.services.subtitles.transcript_corrector import is_plausible_correction
    assert is_plausible_correction("پے", "روپے")        # insert 2
    assert is_plausible_correction("گناہ", "گنا")        # delete 1
    assert is_plausible_correction("بیشنے", "بیچنے")     # substitute 1
    assert is_plausible_correction("chek", "check")


def test_an_unrelated_word_is_refused():
    from backend.services.subtitles.transcript_corrector import is_plausible_correction
    # the exact failure observed from nemotron-3-nano:4b
    assert not is_plausible_correction("ہزار", "کروڑ")
    assert not is_plausible_correction("income", "startup")


def test_a_shifted_transcript_is_rejected_wholesale():
    w = words(("اب", 0.0), ("میری", 0.4), ("ہزار", 0.8), ("کروڑ", 1.2))
    # model echoes the NEXT word at each index — the observed garbage pattern
    shifted = [{"i": 1, "to": "ہزار"}, {"i": 2, "to": "کروڑ"}, {"i": 3, "to": "کی"}]
    res = apply_corrections(w, shifted)
    assert res["applied"] == 0, "a shifted echo must not overwrite the transcript"
    assert len(res["rejected"]) == 3
    assert [x["word"] for x in res["words"]] == ["اب", "میری", "ہزار", "کروڑ"]


def test_rejections_are_reported_not_hidden():
    w = words(("ہزار", 0.0))
    res = apply_corrections(w, [{"i": 0, "to": "کروڑ"}])
    assert res["rejected"][0] == {"i": 0, "from": "ہزار", "to": "کروڑ"}


# ── the vocabulary box widens the guard, but does not disable it ───
# Measured on the real large-v3 Urdu transcript: `پہ` → `روپے` is a genuine
# fix the plain distance rule refuses. The user typed روپے into the vocab
# box, and that is better evidence than the model's say-so.

def test_a_word_the_user_asked_for_gets_more_room():
    from backend.services.subtitles.transcript_corrector import (
        is_plausible_correction, vocab_set,
    )
    v = vocab_set("روپے، کروڑ، لاکھ")
    assert not is_plausible_correction("پہ", "روپے")       # 3 edits, no vocab
    assert is_plausible_correction("پہ", "روپے", v)        # …but it's expected


def test_vocab_is_not_a_blank_cheque():
    from backend.services.subtitles.transcript_corrector import (
        is_plausible_correction, vocab_set,
    )
    v = vocab_set("روپے، کروڑ، لاکھ")
    # کروڑ is in the vocab and STILL cannot replace an unrelated word —
    # otherwise the vocab box would just re-open the hallucination hole
    assert not is_plausible_correction("ہزار", "کروڑ", v)
    assert not is_plausible_correction("تنخواہ", "لاکھ", v)


def test_the_vocab_box_is_parsed_the_way_users_type_it():
    from backend.services.subtitles.transcript_corrector import vocab_set
    # commas, Urdu commas, newlines — the panel's box accepts all three
    assert vocab_set("روپے، کروڑ\nلاکھ, ہزار") == {"روپے", "کروڑ", "لاکھ", "ہزار"}
    assert vocab_set("") == set()


def test_the_endpoints_vocab_reaches_the_guard():
    w = words(("پہ", 4.0))
    assert apply_corrections(w, [{"i": 0, "to": "روپے"}])["applied"] == 0
    res = apply_corrections(w, [{"i": 0, "to": "روپے"}], vocab="روپے، کروڑ")
    assert res["applied"] == 1
    assert res["words"][0]["start"] == 4.0
