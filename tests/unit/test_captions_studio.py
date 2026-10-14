"""Captions Studio backend: font list, frame encoder, sequence mixdown, routes.

Each test names the user-visible failure it guards against. ffmpeg-backed
tests skip when ffmpeg is not on PATH (they run on the dev box and CI images
that have it).
"""
from __future__ import annotations

import math
import shutil
import struct
import subprocess
import wave
from pathlib import Path

import pytest

from backend.services.review_service import Word, words_to_cuts
from backend.services.subtitles import encoder, sequence_audio, system_fonts
from backend.services.subtitles.cue_builder import remap_kept_words_to_output

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")


# ── post-cut remap ──────────────────────────────────────────────────────

def test_remap_matches_the_cut_after_a_short_filler():
    # WHY: removing a short "uh" (gap <= 0.35 s) used to leave every later
    # caption 0.35 s late — the cut starts a new span at a removed word, the
    # remap merged across it by time. Captions must land where the cut puts
    # the audio.
    src = [("we", 1.00, 1.10), ("uh", 1.15, 1.40), ("build", 1.45, 1.80),
           ("captions", 1.85, 2.40), ("um", 2.45, 2.60), ("properly", 2.62, 3.00)]
    cut = {"uh", "um"}
    words = [Word(id=i, text=t, start=s, end=e, segment_id=0) for i, (t, s, e) in enumerate(src)]
    kept = [w.id for w in words if w.text not in cut]
    spans = words_to_cuts({w.id: w for w in words}, kept, "clip.mov")
    actual, cursor = {}, 0.0
    for sp in spans:
        for w in words:
            if w.id in kept and sp["source_in"] <= w.start and w.end <= sp["source_out"]:
                actual[w.text] = round(cursor + w.start - sp["source_in"], 3)
        cursor += sp["source_out"] - sp["source_in"]
    out = remap_kept_words_to_output([{"text": t, "start": s, "end": e, "keep": t not in cut} for t, s, e in src])
    assert {w["text"]: w["start"] for w in out} == pytest.approx(actual)


# ── installed fonts ─────────────────────────────────────────────────────

def _font_bytes(family: str, weight: int = 400, italic: bool = False, symbol: bool = False,
                typo_family: str | None = None) -> bytes:
    """A minimal sfnt with just the name + OS/2 fields the lister reads."""
    names = [(1, family), (2, "Italic" if italic else "Regular")]
    if typo_family:
        names.append((16, typo_family))
    enc = 0 if symbol else 1
    strings = b""
    records = b""
    for nid, text in names:
        raw = text.encode("utf-16-be")
        records += struct.pack(">HHHHHH", 3, enc, 0x409, nid, len(raw), len(strings))
        strings += raw
    name = struct.pack(">HHH", 0, len(names), 6 + 12 * len(names)) + records + strings
    os2 = bytearray(78)
    struct.pack_into(">H", os2, 4, weight)
    struct.pack_into(">H", os2, 62, 1 if italic else 0)
    tables = [(b"OS/2", bytes(os2)), (b"name", name)]
    head = struct.pack(">IHHHH", 0x00010000, len(tables), 0, 0, 0)
    off = len(head) + 16 * len(tables)
    dirs, body = b"", b""
    for tag, data in tables:
        dirs += struct.pack(">4sIII", tag, 0, off + len(body), len(data))
        body += data + b"\0" * (-len(data) % 4)
    return head + dirs + body


def test_installed_fonts_are_listed_by_family_with_weights(tmp_path, monkeypatch):
    # WHY: the old font picker offered names that the renderer ignored (every
    # caption came out Arial). The picker now lists what is really installed.
    (tmp_path / "MontBold.ttf").write_bytes(_font_bytes("Mont ExtraBold", 800, typo_family="Mont"))
    (tmp_path / "MontReg.otf").write_bytes(_font_bytes("Mont", 400))
    (tmp_path / "MontItalic.ttf").write_bytes(_font_bytes("Mont", 400, italic=True))
    (tmp_path / "Dings.ttf").write_bytes(_font_bytes("Dings", symbol=True))
    (tmp_path / "broken.ttf").write_bytes(b"not a font")
    monkeypatch.setattr(system_fonts, "font_dirs", lambda: [tmp_path])
    fonts = system_fonts.list_system_fonts(refresh=True)
    assert fonts == [{"family": "Mont", "weights": [400, 800]}]


def test_font_collections_list_every_face(tmp_path):
    faces = [_font_bytes("Sans A", 400), _font_bytes("Sans A", 700)]
    hdr = struct.pack(">4sHHI", b"ttcf", 1, 0, len(faces))
    offs, blob = [], b""
    base = len(hdr) + 4 * len(faces)
    for f in faces:
        offs.append(base + len(blob))
        blob += f
    # each face's table offsets are relative to the file start: shift them
    fixed = b""
    for f, o in zip(faces, offs):
        n = struct.unpack_from(">H", f, 4)[0]
        g = bytearray(f)
        for i in range(n):
            pos = 12 + 16 * i + 8
            struct.pack_into(">I", g, pos, struct.unpack_from(">I", g, pos)[0] + o)
        fixed += bytes(g)
    p = tmp_path / "pair.ttc"
    p.write_bytes(hdr + struct.pack(">" + "I" * len(offs), *offs) + fixed)
    assert [f["weight"] for f in system_fonts.read_font_faces(p)] == [400, 700]


# ── frame encoder ───────────────────────────────────────────────────────

def test_encoder_command_keeps_exact_rate_and_alpha():
    # WHY: the old overlay was always 30 fps; NTSC sequences need 30000/1001.
    cmd = encoder.build_command("ffmpeg", 1080, 1920, 1200, 400, 30000, 1001, Path("o.mov"))
    assert cmd[cmd.index("-framerate") + 1] == "30000/1001"
    assert "prores_ks" in cmd and "4444" in cmd and "yuva444p10le" in cmd
    anim = encoder.build_command("ffmpeg", 1080, 1920, 0, 1920, 25, 1, Path("o.mov"), "animation")
    # Premiere only decodes Animation without delta frames: every frame a keyframe
    assert anim[anim.index("-c:v") + 1] == "qtrle" and anim[anim.index("-g") + 1] == "1"


def test_encoder_rejects_bad_geometry_and_codecs(tmp_path):
    for kw in ({"band_y": 1900, "band_h": 40}, {"fps_num": 0}, {"codec": "h264"}):
        args = dict(width=64, height=64, band_y=0, band_h=64, fps_num=30, fps_den=1, codec="prores")
        args.update(kw)
        with pytest.raises(ValueError):
            encoder.start("ffmpeg", tmp_path / "x.mov", **args)


def _frame(w, h, rgba):
    return bytes([encoder.OP_FRAME]) + bytes(rgba) * (w * h)


@needs_ffmpeg
def test_encoder_writes_repeats_and_exact_frame_count(tmp_path):
    job = encoder.start(FFMPEG, tmp_path / "cap.mov", 64, 64, 16, 32, 25, 1)
    payload = _frame(64, 32, (255, 255, 255, 255)) + bytes([encoder.OP_REPEAT]) + struct.pack("<I", 9)
    assert encoder.feed(job, payload) == 10
    assert encoder.feed(job, _frame(64, 32, (0, 0, 0, 0))) == 11
    res = encoder.finish(job)
    assert res["frames"] == 11 and res["seconds"] == pytest.approx(0.44)
    probe = subprocess.run([FFMPEG, "-v", "error", "-i", res["path"], "-map", "0:v", "-f", "null", "-"],
                           capture_output=True, text=True)
    assert probe.returncode == 0


@needs_ffmpeg
def test_encoder_rejects_a_truncated_batch_and_cancel_cleans_up(tmp_path):
    job = encoder.start(FFMPEG, tmp_path / "bad.mov", 64, 64, 0, 64, 30, 1)
    with pytest.raises(ValueError):
        encoder.feed(job, bytes([encoder.OP_FRAME]) + b"\0" * 100)
    assert encoder.cancel(job.id) is True
    assert not (tmp_path / "bad.mov").exists()
    with pytest.raises(KeyError):
        encoder.get(job.id)


# ── sequence mixdown ────────────────────────────────────────────────────

def test_clean_clips_skips_offline_and_reversed_media(tmp_path):
    real = tmp_path / "a.wav"
    real.write_bytes(b"x")
    ok, skipped = sequence_audio.clean_clips([
        {"path": str(real), "start": 4, "end": 6, "in": 10, "out": 12},
        {"path": str(real), "start": 0, "end": 2, "in": 0, "out": 4},          # 2x speed
        {"path": str(tmp_path / "gone.mov"), "start": 0, "end": 1, "in": 0, "out": 1},
        {"path": str(real), "start": 1, "end": 2, "in": 5, "out": 5},          # empty
    ])
    assert [c["start"] for c in ok] == [0, 4]                                # sorted by timeline
    assert ok[0]["speed"] == pytest.approx(2.0)
    assert [s["reason"] for s in skipped] == ["media offline", "empty or reversed clip"]


def test_extract_command_trims_source_and_handles_speed():
    cmd = sequence_audio.extract_command("ffmpeg", {"path": "a.mov", "start": 0, "end": 1, "in": 3.5, "out": 6.5, "speed": 3.0})
    assert cmd[cmd.index("-ss") + 1] == "3.500" and cmd[cmd.index("-t") + 1] == "3.000"
    assert cmd[cmd.index("-af") + 1] == "atempo=2.0,atempo=1.500000"
    plain = sequence_audio.extract_command("ffmpeg", {"path": "a.mov", "start": 0, "end": 1, "in": 0, "out": 1, "speed": 1.0})
    assert "-af" not in plain


def test_fingerprint_changes_when_the_edit_changes(tmp_path):
    f = tmp_path / "a.wav"
    f.write_bytes(b"x")
    a = [{"path": str(f), "start": 0.0, "end": 1.0, "in": 0.0}]
    b = [{"path": str(f), "start": 0.5, "end": 1.5, "in": 0.0}]
    assert sequence_audio.fingerprint(a) == sequence_audio.fingerprint(a)
    assert sequence_audio.fingerprint(a) != sequence_audio.fingerprint(b)


def test_fingerprint_changes_when_out_point_changes(tmp_path):
    f = tmp_path / "a.wav"
    f.write_bytes(b"x")
    a = [{"path": str(f), "start": 0.0, "end": 1.0, "in": 0.0, "out": 1.0}]
    b = [{"path": str(f), "start": 0.0, "end": 1.0, "in": 0.0, "out": 1.5}]
    assert sequence_audio.fingerprint(a) != sequence_audio.fingerprint(b)


def _tone(path: Path, seconds: float, freq: float, rate: int = 16000) -> None:
    n = int(seconds * rate)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", int(12000 * math.sin(2 * math.pi * freq * i / rate))) for i in range(n)))


def _rms(samples: list[int]) -> float:
    return math.sqrt(sum(s * s for s in samples) / max(1, len(samples)))


@needs_ffmpeg
def test_mixdown_places_each_clip_at_its_timeline_position(tmp_path):
    # WHY: word times must be SEQUENCE times so captions line up with the cut
    # without any re-timing; a clip used from mid-source starts at its in-point.
    _tone(tmp_path / "a.wav", 2.0, 440)
    _tone(tmp_path / "b.wav", 2.0, 880)
    clips, _ = sequence_audio.clean_clips([
        {"path": str(tmp_path / "a.wav"), "start": 0.5, "end": 1.5, "in": 0.0, "out": 1.0},
        {"path": str(tmp_path / "b.wav"), "start": 2.0, "end": 2.5, "in": 1.0, "out": 1.5},
    ])
    out = tmp_path / "mix.wav"
    info = sequence_audio.mix_sequence_audio(FFMPEG, clips, out)
    assert info["clips"] == 2 and info["overlaps"] == 0
    with wave.open(str(out)) as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1
        data = struct.unpack(f"<{w.getnframes()}h", w.readframes(w.getnframes()))
    at = lambda t0, t1: _rms(list(data[int(t0 * 16000):int(t1 * 16000)]))
    assert at(0.0, 0.45) < 50                      # silence before the first clip
    assert at(0.6, 1.4) > 4000                     # clip A
    assert at(1.6, 1.95) < 50                      # gap
    assert at(2.05, 2.45) > 4000                   # clip B
    assert at(2.6, 3.0) < 50


# ── routes ──────────────────────────────────────────────────────────────

@pytest.fixture()
def client(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from backend.config import get_settings
    from backend.routes import captions

    monkeypatch.setattr(get_settings(), "DATA_DIR", tmp_path)
    app = FastAPI()
    app.include_router(captions.router, prefix="/api")
    return TestClient(app)


def test_fonts_route_returns_the_installed_list(client, monkeypatch):
    monkeypatch.setattr(system_fonts, "list_system_fonts", lambda refresh=False: [{"family": "X", "weights": [700]}])
    assert client.get("/api/captions/fonts").json() == {"fonts": [{"family": "X", "weights": [700]}]}


def test_transcribe_sequence_explains_when_there_is_no_audio(client, tmp_path):
    r = client.post("/api/captions/transcribe-sequence",
                    json={"clips": [{"path": str(tmp_path / "offline.mov"), "start": 0, "end": 2, "in": 0, "out": 2}]})
    assert r.status_code == 400
    assert "media offline" in r.json()["detail"]


@needs_ffmpeg
def test_encode_routes_round_trip(client, tmp_path, monkeypatch):
    from backend.services.subtitles import animated_overlay
    monkeypatch.setattr(animated_overlay, "_ffmpeg_path", lambda: FFMPEG)
    start = client.post("/api/captions/encode/start", json={
        "width": 64, "height": 64, "band_y": 0, "band_h": 64, "fps_num": 24000, "fps_den": 1001, "name": "My Seq"})
    assert start.status_code == 200, start.text
    job = start.json()
    assert job["frame_bytes"] == 64 * 64 * 4
    assert Path(job["path"]).parent == tmp_path / "output" / "captions"
    assert Path(job["path"]).name.startswith("EditFlow Captions - My Seq - ")
    body = _frame(64, 64, (255, 0, 0, 128)) + bytes([encoder.OP_REPEAT]) + struct.pack("<I", 23)
    assert client.post(f"/api/captions/encode/{job['job_id']}/frames", content=body,
                       headers={"Content-Type": "application/octet-stream"}).json() == {"frames": 24}
    fin = client.post(f"/api/captions/encode/{job['job_id']}/finish").json()
    assert fin["frames"] == 24 and fin["seconds"] == pytest.approx(1.001)
    assert client.post(f"/api/captions/encode/{job['job_id']}/frames", content=b"\x01").status_code == 404


def test_transcribe_mixdown_distinct_files_distinct_fingerprints(client, monkeypatch):
    calls = []

    async def fake_transcribe(wav_path, fingerprint, language, engine, force, client_id):
        calls.append({"path": str(wav_path), "fp": fingerprint, "force": force})
        return {"words": [{"word": "hello", "start": 0.0, "end": 0.5}]}

    from backend.routes import captions
    monkeypatch.setattr(captions, "_transcribe_wav", fake_transcribe)

    # Upload file 1
    r1 = client.post(
        "/api/captions/transcribe-mixdown",
        files={"file": ("file1.wav", b"unique_audio_content_one", "audio/wav")},
    )
    assert r1.status_code == 200

    # Upload file 2 with different content
    r2 = client.post(
        "/api/captions/transcribe-mixdown",
        files={"file": ("file2.wav", b"unique_audio_content_two", "audio/wav")},
    )
    assert r2.status_code == 200

    assert len(calls) == 2
    assert calls[0]["fp"] != calls[1]["fp"]
    assert calls[0]["path"] != calls[1]["path"]


def test_transcribe_mixdown_force_passes_through(client, monkeypatch):
    calls = []

    async def fake_transcribe(wav_path, fingerprint, language, engine, force, client_id):
        calls.append({"force": force})
        return {"words": []}

    from backend.routes import captions
    monkeypatch.setattr(captions, "_transcribe_wav", fake_transcribe)

    r = client.post(
        "/api/captions/transcribe-mixdown",
        data={"force": "true"},
        files={"file": ("test.wav", b"audio_content", "audio/wav")},
    )
    assert r.status_code == 200
    assert len(calls) == 1
    assert calls[0]["force"] is True


@needs_ffmpeg
def test_encode_start_rapid_calls_generate_unique_paths(client, monkeypatch):
    from backend.services.subtitles import animated_overlay
    monkeypatch.setattr(animated_overlay, "_ffmpeg_path", lambda: FFMPEG)

    req = {"width": 64, "height": 64, "band_y": 0, "band_h": 64, "fps_num": 30, "fps_den": 1, "name": "Rapid"}
    r1 = client.post("/api/captions/encode/start", json=req)
    r2 = client.post("/api/captions/encode/start", json=req)
    assert r1.status_code == 200 and r2.status_code == 200
    p1 = r1.json()["path"]
    p2 = r2.json()["path"]
    assert p1 != p2, f"Rapid encode/start calls must not produce identical paths: {p1}"
    client.post(f"/api/captions/encode/{r1.json()['job_id']}/cancel")
    client.post(f"/api/captions/encode/{r2.json()['job_id']}/cancel")


def test_transcribe_sequence_offsets_words_when_range_in_provided(client, monkeypatch, tmp_path):
    from backend.routes import captions

    async def fake_transcribe(wav_path, fingerprint, language, engine, force, client_id):
        return {"words": [{"text": "hello", "start": 1.0, "end": 2.0}]}

    monkeypatch.setattr(captions, "_transcribe_wav", fake_transcribe)

    dummy_audio = tmp_path / "clip.wav"
    dummy_audio.write_bytes(b"dummy")

    req = {
        "clips": [{"path": str(dummy_audio), "start": 0, "end": 10, "in": 0}],
        "duration": 10.0,
        "range_in": 5.5,
        "range_out": 15.5,
    }
    resp = client.post("/api/captions/transcribe-sequence", json=req)
    assert resp.status_code == 200
    data = resp.json()
    assert data["range_in"] == 5.5
    assert len(data["words"]) == 1
    assert data["words"][0]["start"] == 6.5
    assert data["words"][0]["end"] == 7.5


def test_sequence_frame_invalid_request_returns_400(client):
    resp = client.post("/api/captions/sequence-frame", json={})
    assert resp.status_code == 400
    assert "No valid frame path" in resp.json()["detail"]


@needs_ffmpeg
def test_sequence_frame_direct_frame_converts_and_serves(client, tmp_path, monkeypatch):
    from backend.services.subtitles import animated_overlay
    monkeypatch.setattr(animated_overlay, "_ffmpeg_path", lambda: FFMPEG)

    frame = tmp_path / "frame.png"
    # Create a 10x10 test image via ffmpeg
    subprocess.run([FFMPEG, "-y", "-f", "lavfi", "-i", "color=c=blue:s=10x10:d=1", "-vframes", "1", str(frame)], check=True)

    resp = client.post("/api/captions/sequence-frame", json={"frame_path": str(frame), "width": 10, "height": 10})
    assert resp.status_code == 200
    url = resp.json()["url"]
    assert "/api/captions/file/preview_frame.jpg" in url

    # Verify the served file endpoint works
    get_resp = client.get("/api/captions/file/preview_frame.jpg")
    assert get_resp.status_code == 200
    assert len(get_resp.content) > 0


def test_transcribe_sequence_returns_audio_url_and_serves_wav(client, monkeypatch, tmp_path):
    from backend.routes import captions

    async def fake_transcribe(wav_path, fingerprint, language, engine, force, client_id):
        return {"words": [{"text": "sound", "start": 0.5, "end": 1.5}]}

    monkeypatch.setattr(captions, "_transcribe_wav", fake_transcribe)

    dummy_audio = tmp_path / "clip.wav"
    dummy_audio.write_bytes(b"dummy audio data")

    req = {
        "clips": [{"path": str(dummy_audio), "start": 0, "end": 5, "in": 0}],
        "duration": 5.0,
        "range_in": 2.0,
        "range_out": 7.0,
    }
    resp = client.post("/api/captions/transcribe-sequence", json=req)
    assert resp.status_code == 200
    data = resp.json()
    assert "audio_url" in data
    assert data["audio_url"].startswith("/api/captions/file/")
    assert data["range_in"] == 2.0

    # Ensure the served WAV endpoint returns 200
    wav_name = data["audio_url"].replace("/api/captions/file/", "")
    file_resp = client.get(f"/api/captions/file/{wav_name}")
    assert file_resp.status_code == 200


@pytest.mark.asyncio
async def test_transcribe_wav_interpolates_unaligned_segments(monkeypatch, tmp_path):
    from backend.routes import captions
    from backend.services.whisper_service import whisper_service

    # Simulate whisper result where forced alignment dropped words but segment text exists
    class FakeSegment:
        def __init__(self, text, start, end, words):
            self.text = text
            self.start = start
            self.end = end
            self.words = words

    class FakeResult:
        def __init__(self):
            self.segments = [
                FakeSegment("This whole sentence was quiet and skipped by aligner", 1.0, 4.0, [])
            ]
            self.duration = 5.0
            self.model = "base"
            self.engine = "whisper"

    async def fake_tf(**kwargs):
        return FakeResult()

    monkeypatch.setattr(captions, "is_model_installed", lambda m: True)
    monkeypatch.setattr(whisper_service, "peek_cached_transcript", lambda fp: None)
    monkeypatch.setattr(whisper_service, "transcribe_fingerprinted", fake_tf)

    dummy_wav = tmp_path / "test.wav"
    dummy_wav.write_bytes(b"RIFFdummyWAVE")

    res = await captions._transcribe_wav(dummy_wav, "fp123", "en", "whisper", True, None)
    words = res["words"]
    # All 9 words in the sentence should be preserved with interpolated timestamps
    assert len(words) == 9
    assert words[0]["word"] == "This"
    assert words[-1]["word"] == "aligner"
    assert words[0]["start"] >= 1.0
    assert words[-1]["end"] <= 4.0


def test_clean_clips_handles_clip_volume(tmp_path):
    f = tmp_path / "audio.wav"
    f.write_bytes(b"dummy")

    clips = [
        {"path": str(f), "start": 0, "end": 5, "in": 0, "volume": 1.0},
        {"path": str(f), "start": 5, "end": 10, "in": 0, "volume": 0.15},
        {"path": str(f), "start": 10, "end": 15, "in": 0, "volume": 0.001},  # muted
    ]
    ok, skipped = sequence_audio.clean_clips(clips)
    assert len(ok) == 2
    assert ok[0]["volume"] == 1.0
    assert ok[1]["volume"] == 0.15
    assert len(skipped) == 1
    assert "muted" in skipped[0]["reason"]


def test_extract_command_applies_volume_filter():
    clip_normal = {"path": "test.wav", "in": 0, "out": 5, "speed": 1.0, "volume": 1.0}
    cmd_normal = sequence_audio.extract_command("ffmpeg", clip_normal)
    assert "-af" not in cmd_normal

    clip_quiet = {"path": "test.wav", "in": 0, "out": 5, "speed": 1.0, "volume": 0.10}
    cmd_quiet = sequence_audio.extract_command("ffmpeg", clip_quiet)
    assert "-af" in cmd_quiet
    af_idx = cmd_quiet.index("-af")
    assert "volume=0.1000" in cmd_quiet[af_idx + 1]

    clip_both = {"path": "test.wav", "in": 0, "out": 5, "speed": 1.5, "volume": 0.25}
    cmd_both = sequence_audio.extract_command("ffmpeg", clip_both)
    assert "-af" in cmd_both
    af_idx = cmd_both.index("-af")
    assert "atempo=1.500000,volume=0.2500" in cmd_both[af_idx + 1]


@needs_ffmpeg
def test_encoder_does_not_prune_mov_files(tmp_path, monkeypatch):
    calls = []
    def mock_prune(target_dir, min_mb=250, auto_prune=True, **kwargs):
        calls.append({"target_dir": target_dir, "min_mb": min_mb, "auto_prune": auto_prune})

    monkeypatch.setattr(encoder, "check_and_prune_disk_space", mock_prune)
    out_mov = tmp_path / "test.mov"
    (tmp_path / "old1.mov").write_bytes(b"mov1")
    (tmp_path / "old2.mov").write_bytes(b"mov2")
    job = encoder.start(FFMPEG, out_mov, 64, 64, 0, 64, 30, 1)
    try:
        assert len(calls) == 1
        assert calls[0]["auto_prune"] is False, "encoder must NEVER auto_prune .mov files"
        assert (tmp_path / "old1.mov").exists()
        assert (tmp_path / "old2.mov").exists()
    finally:
        encoder.cancel(job.id)

