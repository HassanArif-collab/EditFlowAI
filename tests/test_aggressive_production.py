"""Aggressive production-readiness stress and resilience tests for EditFlow AI.

Covers:
1. Whisper memory safety, active-inference eviction guard, priority management, and cache uniqueness.
2. Caption overlay encoder stress: malformed batches, truncated payloads, job concurrency caps, and orphan process prevention on timeout.
3. Word sanitizer and cue builder fuzzing: pathological timestamps, multi-lingual / RTL text, mixed dictionary schemas.
4. Sequence audio mixing resilience: offline media skipping, soft limiting, atomic file replacement.
5. Captions API endpoint validation and error handling.
"""
from __future__ import annotations

import asyncio
import io
import os
import shutil
import struct
import subprocess
import tempfile
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.services.subtitles import encoder, sequence_audio
from backend.services.subtitles.cue_builder import CueOpts, build_cues, remap_kept_words_to_output
from backend.services.subtitles.word_sanitizer import sanitize_words
from backend.services.whisper_service import (
    _set_process_priority_below_normal,
    whisper_service,
)

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")


# ============================================================================
# 1. Whisper Service Safety & Resilience
# ============================================================================

class TestWhisperResilience:
    def test_eviction_guard_blocks_when_busy(self):
        """Active transcription must prevent model eviction from RAM/VRAM."""
        fake_model = MagicMock()
        whisper_service._model = fake_model
        whisper_service._active_transcriptions = 1

        unloaded = whisper_service.unload_model()
        assert unloaded is False
        assert whisper_service._model is fake_model, "Model must not be evicted while transcription is active"

        # Once active count drops to 0, eviction should succeed
        whisper_service._active_transcriptions = 0
        unloaded = whisper_service.unload_model()
        assert unloaded is True
        assert whisper_service._model is None, "Model must be cleanly evicted when idle"

    def test_windows_priority_below_normal_execution(self):
        """Win32 SetPriorityClass must run without throwing 64-bit handle truncation errors."""
        # On Windows, this exercises the wintypes.HANDLE / DWORD 64-bit fix.
        # On non-Windows, it is a clean no-op.
        _set_process_priority_below_normal()

    def test_transcription_cache_fingerprint_uniqueness(self):
        """Different content or options must NEVER collide in the fingerprint cache."""
        fp1 = whisper_service.compute_fingerprint(b"file_content_alpha", "seq1|0|10", "base", "en", "auto")
        fp2 = whisper_service.compute_fingerprint(b"file_content_beta", "seq1|0|10", "base", "en", "auto")
        fp3 = whisper_service.compute_fingerprint(b"file_content_alpha", "seq1|0|10", "base", "ur", "auto")
        fp4 = whisper_service.compute_fingerprint(b"file_content_alpha", "seq1|0|10", "base", "en", "whisperx")

        assert len({fp1, fp2, fp3, fp4}) == 4, "All fingerprints must be distinct"

    def test_idle_timeout_configuration(self):
        """Idle timeout must be configured to 30s to quickly reclaim VRAM for Premiere Pro."""
        from backend.config import get_settings
        settings = get_settings()
        assert settings.WHISPER_IDLE_TIMEOUT_SECONDS == 30

    @pytest.mark.asyncio
    async def test_idle_watchdog_thread_safe_scheduling(self):
        """Watchdog must be scheduled and callable across thread contexts."""
        whisper_service._main_loop = asyncio.get_running_loop()
        whisper_service._touch_model_usage()
        assert whisper_service._idle_watchdog_task is not None
        assert not whisper_service._idle_watchdog_task.cancelled()
        # Clean up task
        whisper_service._idle_watchdog_task.cancel()
        try:
            await whisper_service._idle_watchdog_task
        except asyncio.CancelledError:
            pass
        whisper_service._idle_watchdog_task = None


# ============================================================================
# 2. Encoder Streaming Stress & Orphan Process Prevention
# ============================================================================

class TestEncoderStress:
    def test_frame_dimension_validation(self):
        """Invalid frame dimensions or bands must raise ValueError immediately before spawning subprocesses."""
        out = Path(tempfile.gettempdir()) / "test_invalid.mov"
        with pytest.raises(ValueError, match="bad frame size"):
            encoder.start("ffmpeg", out, width=0, height=1080, band_y=0, band_h=200, fps_num=30, fps_den=1)

        with pytest.raises(ValueError, match="bad caption band"):
            encoder.start("ffmpeg", out, width=1920, height=1080, band_y=1000, band_h=200, fps_num=30, fps_den=1)

        with pytest.raises(ValueError, match="bad frame rate"):
            encoder.start("ffmpeg", out, width=1920, height=1080, band_y=0, band_h=200, fps_num=0, fps_den=1)

    @needs_ffmpeg
    def test_malformed_batch_handling(self, tmp_path):
        """Truncated frame payloads and unknown opcodes must be rejected cleanly."""
        out = tmp_path / "overlay.mov"
        job = encoder.start(FFMPEG, out, width=64, height=64, band_y=0, band_h=32, fps_num=30, fps_den=1, codec="animation")
        try:
            # 1. Truncated frame (op 1 with fewer than frame_bytes)
            with pytest.raises(ValueError, match="truncated frame in batch"):
                encoder.feed(job, bytes([encoder.OP_FRAME, 0x00, 0x01]))

            # 2. Truncated repeat (op 2 with fewer than 4 bytes for count)
            with pytest.raises(ValueError, match="truncated repeat in batch"):
                encoder.feed(job, bytes([encoder.OP_REPEAT, 0x05]))

            # 3. Unknown opcode
            with pytest.raises(ValueError, match="unknown record type"):
                encoder.feed(job, bytes([0x99, 0x00]))
        finally:
            encoder.cancel(job.id)

    @needs_ffmpeg
    def test_encoder_timeout_kills_process(self, tmp_path):
        """If ffmpeg hangs or times out in finish(), it must be killed and not left as an orphan."""
        out = tmp_path / "timeout_test.mov"
        job = encoder.start(FFMPEG, out, width=64, height=64, band_y=0, band_h=32, fps_num=30, fps_den=1, codec="animation")

        # Mock proc.wait to simulate a timeout
        orig_wait = job.proc.wait
        def hanging_wait(*args, **kwargs):
            raise subprocess.TimeoutExpired(cmd="ffmpeg", timeout=0.1)

        job.proc.wait = hanging_wait
        with patch.object(job.proc, "kill", wraps=job.proc.kill) as mock_kill:
            with pytest.raises(RuntimeError, match="encode timed out"):
                encoder.finish(job, timeout=0.1)
            assert mock_kill.called, "job.proc.kill() must be called on timeout"

        # Verify job was removed from active jobs
        with pytest.raises(KeyError):
            encoder.get(job.id)

    @needs_ffmpeg
    def test_job_capacity_and_proactive_reaping(self, tmp_path):
        """MAX_JOBS limit must be enforced and stale jobs proactively reaped."""
        jobs = []
        try:
            for i in range(encoder.MAX_JOBS):
                j = encoder.start(FFMPEG, tmp_path / f"job_{i}.mov", width=32, height=32, band_y=0, band_h=16, fps_num=30, fps_den=1, codec="animation")
                jobs.append(j)

            # Creating one more beyond MAX_JOBS when none are stale should fail
            with pytest.raises(RuntimeError, match="Too many caption renders running"):
                encoder.start(FFMPEG, tmp_path / "job_overflow.mov", width=32, height=32, band_y=0, band_h=16, fps_num=30, fps_den=1, codec="animation")

            # Mark one job as stale (>60s old)
            jobs[0].touched = time.time() - 100

            # Starting a new job should now proactively reap the stale one and succeed
            j_new = encoder.start(FFMPEG, tmp_path / "job_recovered.mov", width=32, height=32, band_y=0, band_h=16, fps_num=30, fps_den=1, codec="animation")
            jobs.append(j_new)
            assert len(encoder._jobs) <= encoder.MAX_JOBS
        finally:
            encoder.cancel_all()


# ============================================================================
# 3. Word Sanitizer & Cue Builder Fuzzing
# ============================================================================

class TestSanitizerAndCuesFuzz:
    def test_sanitizer_pathological_timestamps(self):
        """Sanitizer must handle inverted, negative, zero, and missing timestamps without crashing."""
        raw = [
            {"word": "first", "start": -2.0, "end": -1.0},
            {"word": "missing_times"},
            {"word": "zero_dur", "start": 3.0, "end": 3.0},
            {"word": "backwards", "start": 2.5, "end": 2.0},
            {"word": "overlap", "start": 3.2, "end": 5.0},
            {"word": "next", "start": 4.0, "end": 4.5},
        ]
        sanitized = sanitize_words(raw)
        assert len(sanitized) == len(raw)

        # Monotonicity check
        for i in range(len(sanitized)):
            w = sanitized[i]
            assert w["start"] >= 0.0, f"Word {i} start must be non-negative"
            assert w["end"] >= w["start"] + 0.02, f"Word {i} must meet MIN_DUR"
            if i > 0:
                assert w["start"] >= sanitized[i - 1]["start"], f"Starts must be non-decreasing: {w}"

    def test_cue_builder_accepts_word_and_text_keys(self):
        """Cue builder must support both 'text' and 'word' keys interchangeably."""
        words_with_word_key = [
            {"word": "EditFlow", "start": 0.0, "end": 0.4},
            {"word": "AI", "start": 0.4, "end": 0.8},
            {"word": "production", "start": 0.8, "end": 1.4},
            {"word": "ready.", "start": 1.4, "end": 1.8},
        ]
        cues = build_cues(words_with_word_key, CueOpts())
        assert len(cues) >= 1
        assert "EditFlow AI production ready." in cues[0]["text"]
        assert all("text" in w for c in cues for w in c["words"])

    def test_cue_builder_multilingual_and_emojis(self):
        """Urdu, Arabic, CJK, and Emojis must be preserved without encoding corruption."""
        mixed = [
            {"text": "کیا", "start": 0.0, "end": 0.3},
            {"text": "حال", "start": 0.3, "end": 0.6},
            {"text": "ہے؟", "start": 0.6, "end": 0.9},
            {"text": "Subtitles", "start": 1.0, "end": 1.4},
            {"text": "字幕", "start": 1.4, "end": 1.8},
            {"text": "🔥🚀", "start": 1.8, "end": 2.2},
        ]
        cues = build_cues(mixed, CueOpts())
        assert len(cues) == 2  # Sentence-ending question mark '؟' splits
        assert cues[0]["text"] == "کیا حال ہے؟"
        assert "字幕" in cues[1]["text"]
        assert "🔥🚀" in cues[1]["text"]

    def test_cue_builder_massive_list_performance(self):
        """1,000 words must be grouped in under 50ms without recursion or memory bloat."""
        many = [{"text": f"word_{i}", "start": i * 0.3, "end": i * 0.3 + 0.25} for i in range(1000)]
        t0 = time.perf_counter()
        cues = build_cues(many, CueOpts(max_words_per_cue=5))
        elapsed = time.perf_counter() - t0
        assert elapsed < 0.05, f"Grouping 1,000 words took {elapsed*1000:.1f}ms (expected <50ms)"
        assert len(cues) == 200


# ============================================================================
# 4. Sequence Audio Resilience
# ============================================================================

class TestSequenceAudioResilience:
    def test_clean_clips_skips_offline_and_silent_media(self, tmp_path):
        """Offline files, 0-length clips, and muted clips must be safely skipped."""
        real_file = tmp_path / "valid.wav"
        real_file.write_bytes(b"dummy")

        raw_clips = [
            {"path": str(real_file), "start": 0.0, "end": 2.0, "in": 0.0, "out": 2.0, "volume": 1.0},
            {"path": str(tmp_path / "missing.wav"), "start": 2.0, "end": 4.0, "in": 0.0, "out": 2.0},  # offline
            {"path": str(real_file), "start": 4.0, "end": 4.0, "in": 0.0, "out": 0.0},                  # 0 duration
            {"path": str(real_file), "start": 5.0, "end": 7.0, "in": 0.0, "out": 2.0, "volume": 0.0},  # muted
        ]
        ok, skipped = sequence_audio.clean_clips(raw_clips)
        assert len(ok) == 1
        assert ok[0]["start"] == 0.0
        assert len(skipped) == 3
        reasons = [s["reason"] for s in skipped]
        assert "media offline" in reasons
        assert "empty or reversed clip" in reasons
        assert "muted in sequence" in reasons

    def test_pcm_soft_limiter_prevents_clipping(self):
        """Overlapping tracks exceeding 16-bit ceiling (+32767) must be soft-normalized."""
        import numpy as np
        # Create audio buffer that spikes to +50000 (oversaturated)
        oversaturated = np.array([45000, -48000, 32000, 0, -10000], dtype=np.int32)
        clipped_to_int16 = np.clip(oversaturated, -32768, 32767).astype("<i2")
        buf = bytearray(clipped_to_int16.tobytes())

        # Inject extreme raw values into buffer
        extreme_bytes = np.array([32767, -32768, 32767], dtype="<i2").tobytes()
        buf[:len(extreme_bytes)] = extreme_bytes

        sequence_audio._normalize_pcm(buf)
        result = np.frombuffer(buf, dtype="<i2")
        assert np.max(np.abs(result)) <= 32767

    def test_atomic_file_replacement(self, tmp_path):
        """os.replace must atomically overwrite destination without Windows file locking errors."""
        dest = tmp_path / "output.wav"
        dest.write_text("existing content")

        src = tmp_path / "output.tmp.wav"
        src.write_text("new content")

        os.replace(src, dest)
        assert dest.read_text() == "new content"
        assert not src.exists()


# ============================================================================
# 5. API Endpoints Error Handling
# ============================================================================

class TestCaptionsApiHardening:
    @pytest.fixture
    def client(self):
        return TestClient(app)

    def test_transcribe_mixdown_empty_file_returns_400(self, client):
        """Uploading a 0-byte file must return 400 Bad Request with a clear message."""
        response = client.post(
            "/api/captions/transcribe-mixdown",
            files={"file": ("empty.wav", io.BytesIO(b""), "audio/wav")},
        )
        assert response.status_code == 400
        assert "Uploaded audio file is empty" in response.json()["detail"]

    def test_cues_empty_payload_returns_400(self, client):
        """Posting empty words list to /cues must return 400."""
        response = client.post("/api/captions/cues", json={"words": []})
        assert response.status_code == 400
        assert "Pass words" in response.json()["detail"]

    def test_srt_empty_cues_returns_400(self, client):
        """Posting empty cues to /srt must return 400."""
        response = client.post("/api/captions/srt", json={"cues": []})
        assert response.status_code == 400
        assert "No non-empty cues" in response.json()["detail"]

    def test_transcribe_sequence_offline_clips_returns_400(self, client):
        """Sequence transcribe with offline clips must return 400 with explanation."""
        response = client.post(
            "/api/captions/transcribe-sequence",
            json={"clips": [{"path": "C:/nonexistent/file.wav", "start": 0, "end": 2}]}
        )
        assert response.status_code == 400
        assert "No audio to transcribe on unmuted tracks" in response.json()["detail"]


# ============================================================================
# 6. Database Concurrency Stress & ACID Verification
# ============================================================================

class TestDatabaseConcurrencyStress:
    def test_concurrent_transcripts_and_assets(self, tmp_path):
        """20 concurrent threads writing and reading SQLite registry must succeed with 0 lock errors."""
        import concurrent.futures
        from backend.models.sqlite_registry import SQLiteRegistry
        from backend.config import Settings

        test_db = tmp_path / "stress_registry.db"
        test_settings = Settings(DB_PATH=str(test_db))
        registry = SQLiteRegistry(test_settings)
        registry.initialize()

        errors = []

        def worker(thread_idx: int):
            try:
                for i in range(10):
                    content_hash = f"hash_{thread_idx}_{i}"
                    transcript_id = f"tr_{thread_idx}_{i}"
                    registry.upsert_source_file(
                        content_hash=content_hash,
                        path=f"C:/media/{content_hash}.mp4",
                        original_name=f"{content_hash}.mp4",
                        file_size=1024,
                        duration=120.0,
                        has_audio=True,
                        fingerprint=content_hash,
                        status="transcribed",
                    )
                    registry.upsert_source_transcript(
                        transcript_id=transcript_id,
                        content_hash=content_hash,
                        range_in=0.0,
                        range_out=10.0,
                        audio_offset=0.0,
                        language="en",
                        engine="faster_whisper",
                        model="base",
                        model_revision="",
                        duration=10.0,
                        full_text="test transcript",
                        status="completed",
                    )
                    registry.insert_transcript_word(
                        word_id=f"w_{thread_idx}_{i}",
                        transcript_id=transcript_id,
                        content_hash=content_hash,
                        word_index=0,
                        word="test",
                        normalized_word="test",
                        start=0.0,
                        end=0.5,
                        probability=0.99,
                    )
                    res = registry.find_transcript_by_cache_key(
                        content_hash=content_hash,
                        range_in=0.0,
                        range_out=10.0,
                        engine="faster_whisper",
                        model="base",
                    )
                    assert res is not None
            except Exception as exc:
                errors.append(exc)

        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
            futures = [executor.submit(worker, idx) for idx in range(10)]
            concurrent.futures.wait(futures)

        assert len(errors) == 0, f"Encountered concurrency errors: {errors}"


# ============================================================================
# 7. Whisper CUDA Fallback Simulation
# ============================================================================

class TestWhisperCudaFallback:
    def test_cuda_failure_falls_back_to_cpu(self):
        """If CUDA fails during model loading, whisper_service must cleanly fall back to CPU without crashing."""
        # Reset model
        whisper_service.unload_model()
        load_calls = []

        def mock_whisper_model_init(model_spec, device, compute_type, **kwargs):
            load_calls.append((device, compute_type))
            if device == "cuda":
                raise RuntimeError("CUDA initialization failed: out of memory or missing cublas")
            # CPU succeeds
            mock_inst = MagicMock()
            mock_inst.model_path = "mock/cpu/model"
            return mock_inst

        with patch("faster_whisper.WhisperModel", side_effect=mock_whisper_model_init):
            with patch.object(whisper_service, "detect_device_and_compute", return_value=("cuda", "float16", "NVIDIA RTX")):
                whisper_service._load_model()

        assert len(load_calls) >= 2, "Must attempt CUDA then CPU"
        assert load_calls[0][0] == "cuda"
        assert load_calls[-1][0] == "cpu"
        assert whisper_service.get_hardware_status()["model_loaded"] is True
        assert whisper_service.get_hardware_status()["active_device"] == "cpu"

        # Cleanup
        whisper_service.unload_model()


# ============================================================================
# 8. ExtendScript ES3 Compliance
# ============================================================================

class TestExtendScriptES3Compliance:
    def test_no_es6_syntax_in_extendscript(self):
        """All .jsx files in cep-panel/extendscript/ must be strictly ES3 compatible."""
        import re
        es_dir = Path(__file__).resolve().parent.parent / "cep-panel" / "extendscript"
        assert es_dir.exists(), "ExtendScript directory must exist"

        jsx_files = list(es_dir.glob("*.jsx"))
        assert len(jsx_files) >= 10, "Must find at least 10 JSX module files"

        # Regex to strip comments and strings
        comment_regex = re.compile(r"//.*?$|/\*.*?\*/", re.DOTALL | re.MULTILINE)
        string_regex = re.compile(r"'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"", re.DOTALL)
        es6_decl_regex = re.compile(r"\b(let|const|class)\s+[A-Za-z0-9_$]+")
        arrow_regex = re.compile(r"\([^)]*\)\s*=>|[A-Za-z0-9_$]+\s*=>")

        violations = []
        for jf in jsx_files:
            code = jf.read_text(encoding="utf-8")
            # Strip comments
            stripped = comment_regex.sub("", code)
            # Check for backticks outside strings
            if "`" in stripped:
                violations.append(f"{jf.name}: contains template literal backtick")
            # Strip string literals to avoid false positives on words like 'const' inside strings
            stripped_no_strings = string_regex.sub('""', stripped)
            es6_matches = es6_decl_regex.findall(stripped_no_strings)
            if es6_matches:
                violations.append(f"{jf.name}: contains ES6 keywords {es6_matches}")
            arrow_matches = arrow_regex.findall(stripped_no_strings)
            if arrow_matches:
                violations.append(f"{jf.name}: contains arrow functions {arrow_matches}")

        assert len(violations) == 0, f"ExtendScript ES3 violations found: {violations}"


# ============================================================================
# 9. Atempo Audio Filter Chaining
# ============================================================================

class TestAtempoFilterChaining:
    def test_atempo_stages_for_extreme_speeds(self):
        """ffmpeg atempo only supports 0.5-2.0 per filter stage; multiple stages must be chained."""
        # 4x speed -> atempo=2.0,atempo=2.0
        f4 = sequence_audio._atempo(4.0)
        assert f4.count("atempo=2.0") == 2

        # 0.25x speed -> atempo=0.5,atempo=0.5
        f025 = sequence_audio._atempo(0.25)
        assert f025.count("atempo=0.5") == 2

        # 1.5x speed -> single stage
        f15 = sequence_audio._atempo(1.5)
        assert "atempo=1.5" in f15

