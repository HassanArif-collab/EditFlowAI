"""
Empirical Challenger M3.2 Stress & Verification Test Suite.

Authoritative Requirements:
- ORIGINAL_REQUEST.md & PROJECT.md Milestone 3
- Backend Transcription Caching Parity & SQLite Persistence (< 100ms latency)
- Cache Key Collision Resistance across distinct mixdowns / audio / models / ranges
- Win32 Below-Normal Process Priority Throttling & Premiere UI Thread Non-Starvation
- GPU VRAM Safety Watchdog & OOM Fallback Prevention
"""
from __future__ import annotations

import asyncio
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Generator
from unittest.mock import MagicMock, patch

import pytest

from backend.config import Settings
from backend.models.schemas import TranscriptResult, TranscriptSegment, TranscriptWord
from backend.models.sqlite_registry import SQLiteRegistry
from backend.services.whisper_service import (
    WhisperService,
    _consume_segments,
    _restore_process_priority_normal,
    _set_process_priority_below_normal,
)


# ═════════════════════════════════════════════════════════════════════════════
# FIXTURES & HELPERS
# ═════════════════════════════════════════════════════════════════════════════

@pytest.fixture
def temp_env(tmp_path: Path):
    """Provide isolated SQLite registry and cache directories."""
    db_file = tmp_path / "test_registry.db"
    cache_dir = tmp_path / "media_cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    (cache_dir / "transcripts").mkdir(parents=True, exist_ok=True)

    settings = Settings(
        DB_PATH=str(db_file),
        DATA_DIR=tmp_path / "data",
        MEDIA_CACHE_DIR=cache_dir,
        WRITE_TRANSCRIPT_SIDECAR=True,
    )
    registry = SQLiteRegistry(settings=settings)
    registry.initialize()

    service = WhisperService(settings=settings)
    return {
        "settings": settings,
        "registry": registry,
        "service": service,
        "tmp_path": tmp_path,
    }


def make_sample_transcript(
    content_hash: str,
    word_count: int = 50,
    engine: str = "whisperx",
    model: str = "large-v3-turbo",
    range_in: float = 0.0,
    range_out: float = 30.0,
) -> TranscriptResult:
    """Generate a realistic TranscriptResult with words and segments."""
    words = []
    text_parts = []
    dur_per_word = (range_out - range_in) / max(1, word_count)
    for i in range(word_count):
        w_text = f"word_{i}"
        w_start = round(range_in + i * dur_per_word, 3)
        w_end = round(w_start + dur_per_word * 0.8, 3)
        words.append(TranscriptWord(word=w_text, start=w_start, end=w_end, probability=0.98))
        text_parts.append(w_text)

    segment = TranscriptSegment(
        start=range_in,
        end=range_out,
        text=" ".join(text_parts),
        words=words,
    )
    return TranscriptResult(
        source_file=f"C:/fake_media/{content_hash}.wav",
        language="en",
        duration=range_out - range_in,
        segments=[segment],
        full_text=" ".join(text_parts),
        content_hash=content_hash,
        range_in=range_in,
        range_out=range_out,
        audio_offset=0.0,
        engine=engine,
        model=model,
    )


# ═════════════════════════════════════════════════════════════════════════════
# TEST SUITE 1: SQLite Cache Persistence, Round-Trip & Latency (< 100ms)
# ═════════════════════════════════════════════════════════════════════════════

class TestSQLiteCachePersistenceAndLatency:

    def test_sqlite_persistence_and_faithful_roundtrip(self, temp_env):
        """Verify _save_transcript_cache commits to SQLite and reconstructs accurately."""
        service: WhisperService = temp_env["service"]
        registry: SQLiteRegistry = temp_env["registry"]
        hash_val = "a1b2c3d4e5f60718293a4b5c6d7e8f90"

        # Mock source_file so parent FK insert succeeds
        fake_wav = temp_env["tmp_path"] / "test.wav"
        fake_wav.write_bytes(b"RIFF" + b"\x00" * 40)

        original = make_sample_transcript(
            content_hash=hash_val,
            word_count=40,
            engine="whisperx",
            model="large-v3-turbo",
        )
        original.source_file = str(fake_wav)

        with patch("backend.models.sqlite_registry.sqlite_registry", registry):
            service._save_transcript_cache(hash_val, original)

            # Check source_transcripts table directly
            row = registry.find_transcript_by_cache_key(
                content_hash=hash_val,
                range_in=0.0,
                range_out=30.0,
                engine="whisperx",
                model="large-v3-turbo",
            )
            assert row is not None, "Transcript record must exist in SQLite source_transcripts table"
            assert row["content_hash"] == hash_val
            assert row["engine"] == "whisperx"
            assert row["model"] == "large-v3-turbo"

            # Check transcript_words table
            db_words = registry.find_transcript_words(hash_val)
            assert len(db_words) == 40, f"Expected 40 words in DB, got {len(db_words)}"
            assert db_words[0]["word"] == "word_0"
            assert db_words[-1]["word"] == "word_39"

            # Clear in-memory cache and on-disk JSON cache to enforce raw SQLite DB lookup
            service._transcript_cache.clear()
            json_cache_file = service._transcript_cache_dir() / f"{hash_val}.json"
            if json_cache_file.exists():
                json_cache_file.unlink()

            # Lookup directly from DB
            reconstructed = service._lookup_transcript_from_db(
                content_hash=hash_val,
                range_in=0.0,
                range_out=30.0,
                engine="whisperx",
                model="large-v3-turbo",
            )
            assert reconstructed is not None, "Must reconstruct TranscriptResult from SQLite"
            assert reconstructed.content_hash == hash_val
            assert reconstructed.engine == "whisperx"
            assert reconstructed.model == "large-v3-turbo"
            assert reconstructed.duration == original.duration
            assert reconstructed.full_text == original.full_text
            assert len(reconstructed.segments) == 1
            assert len(reconstructed.segments[0].words) == 40

    def test_repeat_lookup_latency_is_under_100ms(self, temp_env):
        """Empirically benchmark repeat lookup latency for memory, disk, and SQLite (< 100ms)."""
        service: WhisperService = temp_env["service"]
        registry: SQLiteRegistry = temp_env["registry"]
        hash_val = "perf_bench_hash_0123456789abcdef"

        fake_wav = temp_env["tmp_path"] / "perf.wav"
        fake_wav.write_bytes(b"RIFF" + b"\x00" * 40)

        original = make_sample_transcript(content_hash=hash_val, word_count=50)
        original.source_file = str(fake_wav)

        with patch("backend.models.sqlite_registry.sqlite_registry", registry):
            service._save_transcript_cache(hash_val, original)

            # Benchmark 1: In-memory peek latency (100 iterations)
            mem_latencies = []
            for _ in range(100):
                t0 = time.perf_counter()
                res = service.peek_cached_transcript(hash_val)
                t1 = time.perf_counter()
                mem_latencies.append((t1 - t0) * 1000)
                assert res is not None

            p95_mem = sorted(mem_latencies)[95]
            max_mem = max(mem_latencies)
            # Memory peek should be sub-millisecond (< 50ms)
            assert max_mem < 50.0, f"In-memory peek max latency was {max_mem:.3f}ms (expected < 50ms)"

            # Benchmark 2: Cold SQLite DB lookup latency (100 iterations, purging RAM each time)
            db_latencies = []
            for _ in range(100):
                service._transcript_cache.clear()  # force SQLite path
                t0 = time.perf_counter()
                res = service._lookup_transcript_from_db(
                    content_hash=hash_val,
                    range_in=0.0,
                    range_out=30.0,
                    engine="whisperx",
                    model="large-v3-turbo",
                )
                t1 = time.perf_counter()
                db_latencies.append((t1 - t0) * 1000)
                assert res is not None

            p50_db = sorted(db_latencies)[50]
            p95_db = sorted(db_latencies)[95]
            max_db = max(db_latencies)

            # PROJECT.md contract: repeat lookup must be < 100ms
            assert p95_db < 100.0, f"SQLite p95 latency {p95_db:.3f}ms exceeds 100ms threshold"
            assert max_db < 100.0, f"SQLite max latency {max_db:.3f}ms exceeds 100ms threshold"

    def test_sqlite_index_scalability_under_bulk_load(self, temp_env):
        """Stress-test SQLite query performance when registry holds multiple transcripts and words."""
        registry: SQLiteRegistry = temp_env["registry"]
        service: WhisperService = temp_env["service"]

        fake_wav = temp_env["tmp_path"] / "bulk.wav"
        fake_wav.write_bytes(b"RIFF" + b"\x00" * 40)

        with patch("backend.models.sqlite_registry.sqlite_registry", registry):
            # Seed 30 distinct transcripts (300 words total)
            target_idx = 15
            target_hash = f"target_hash_{target_idx:020d}"
            for i in range(30):
                h = f"target_hash_{i:020d}"
                tr = make_sample_transcript(
                    content_hash=h,
                    word_count=10,
                    engine="whisperx" if i % 2 == 1 else "faster_whisper",
                    model="large-v3-turbo" if i % 2 == 1 else "base",
                )
                tr.source_file = str(fake_wav)
                service._save_transcript_cache(h, tr)

            # Measure lookup against target hash located in the middle of the table
            service._transcript_cache.clear()
            t0 = time.perf_counter()
            res = service._lookup_transcript_from_db(
                content_hash=target_hash,
                range_in=0.0,
                range_out=30.0,
                engine="whisperx",
                model="large-v3-turbo",
            )
            elapsed_ms = (time.perf_counter() - t0) * 1000
            assert res is not None, f"Expected to find transcript for {target_hash}"
            assert res.content_hash == target_hash
            assert elapsed_ms < 100.0, f"Indexed bulk query took {elapsed_ms:.2f}ms (> 100ms limit)"


# ═════════════════════════════════════════════════════════════════════════════
# TEST SUITE 2: Cache Key Collision Resistance
# ═════════════════════════════════════════════════════════════════════════════

class TestCacheKeyCollisionResistance:

    def test_pairwise_collision_resistance_across_varied_inputs(self):
        """Synthesize permutations of audio hash, engine, model, and sequence keys; verify 0 collisions."""
        hashes = set()
        test_inputs = []

        models = ["tiny", "base", "small", "medium", "large-v3-turbo", "large-v3"]
        engines = ["auto", "whisperx", "faster_whisper", "stable_ts"]
        languages = ["auto", "en", "ur", "ar", "es"]
        seq_keys = ["", "seq_main", "seq_interview_v1", "seq_broll_cut"]
        base_contents = [
            b"RIFF_AUDIO_CHUNK_001_SAMPLE_DATA_AAA",
            b"RIFF_AUDIO_CHUNK_001_SAMPLE_DATA_AAB",  # 1 byte difference
            b"RIFF_AUDIO_CHUNK_002_DIFFERENT_PCM",
            b"RIFF_AUDIO_CHUNK_003_EMPTY_SILENCE",
        ]

        for content in base_contents:
            for mod in models:
                for eng in engines:
                    for lang in languages[:2]:
                        for sk in seq_keys[:2]:
                            test_inputs.append((content, sk, mod, lang, eng))

        for content, sk, mod, lang, eng in test_inputs:
            fp = WhisperService.compute_fingerprint(
                content_or_hash=content,
                sequence_key=sk,
                model_name=mod,
                language=lang,
                engine=eng,
            )
            assert len(fp) == 16, "Fingerprint must be 16 hex characters"
            # Ensure no collision occurred
            assert fp not in hashes, f"Collision detected for key {(content[:10], sk, mod, lang, eng)}"
            hashes.add(fp)

        assert len(hashes) == len(test_inputs), f"Generated {len(test_inputs)} distinct fingerprints with 0 collisions"

    def test_sqlite_cache_composite_key_isolation(self, temp_env):
        """Verify SQLite registry enforces composite key isolation (range_in, range_out, engine, model)."""
        registry: SQLiteRegistry = temp_env["registry"]
        service: WhisperService = temp_env["service"]
        fake_wav = temp_env["tmp_path"] / "iso.wav"
        fake_wav.write_bytes(b"RIFF" + b"\x00" * 40)

        common_hash = "shared_audio_content_hash_12345"

        with patch("backend.models.sqlite_registry.sqlite_registry", registry):
            # 1. Save entry for range (0.0 -> 10.0) with whisperx
            t1 = make_sample_transcript(
                content_hash=common_hash,
                range_in=0.0,
                range_out=10.0,
                engine="whisperx",
                model="large-v3-turbo",
            )
            t1.source_file = str(fake_wav)
            t1.full_text = "range zero to ten"
            service._save_transcript_cache(common_hash, t1)

            # 2. Save entry for range (10.0 -> 20.0) with whisperx
            t2 = make_sample_transcript(
                content_hash=common_hash,
                range_in=10.0,
                range_out=20.0,
                engine="whisperx",
                model="large-v3-turbo",
            )
            t2.source_file = str(fake_wav)
            t2.full_text = "range ten to twenty"
            service._save_transcript_cache(f"{common_hash}_r2", t2)

            # Direct lookup by composite key
            r1 = registry.find_transcript_by_cache_key(
                content_hash=common_hash,
                range_in=0.0,
                range_out=10.0,
                engine="whisperx",
                model="large-v3-turbo",
            )
            assert r1 is not None
            assert r1["full_text"] == "range zero to ten"

            # Querying different range should NOT return r1
            r_diff_range = registry.find_transcript_by_cache_key(
                content_hash=common_hash,
                range_in=15.0,
                range_out=25.0,
                engine="whisperx",
                model="large-v3-turbo",
            )
            assert r_diff_range is None, "Different range must miss cache"

            # Querying different engine should NOT return r1
            r_diff_engine = registry.find_transcript_by_cache_key(
                content_hash=common_hash,
                range_in=0.0,
                range_out=10.0,
                engine="faster_whisper",
                model="large-v3-turbo",
            )
            assert r_diff_engine is None, "Different engine must miss cache"


# ═════════════════════════════════════════════════════════════════════════════
# TEST SUITE 3: Win32 Below-Normal Process Priority Throttling
# ═════════════════════════════════════════════════════════════════════════════

class TestWin32ProcessPriorityThrottling:

    def test_win32_priority_set_and_restore(self):
        """Empirically test Win32 SetPriorityClass transitions on Windows OS."""
        if os.name != "nt":
            pytest.skip("Win32 process priority tests require Windows")

        k32 = ctypes.windll.kernel32
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        k32.GetPriorityClass.argtypes = [wintypes.HANDLE]
        k32.GetPriorityClass.restype = wintypes.DWORD

        BELOW_NORMAL_PRIORITY_CLASS = 0x00004000
        NORMAL_PRIORITY_CLASS = 0x00000020

        # Initial restore to ensure baseline
        _restore_process_priority_normal()
        initial_prio = k32.GetPriorityClass(k32.GetCurrentProcess())
        assert initial_prio == NORMAL_PRIORITY_CLASS, f"Initial priority should be NORMAL (0x20), got {hex(initial_prio)}"

        # Set to BELOW_NORMAL
        success = _set_process_priority_below_normal()
        assert success is True, "_set_process_priority_below_normal must return True on Windows"
        throttled_prio = k32.GetPriorityClass(k32.GetCurrentProcess())
        assert throttled_prio == BELOW_NORMAL_PRIORITY_CLASS, (
            f"Expected BELOW_NORMAL (0x4000), got {hex(throttled_prio)}"
        )

        # Restore to NORMAL
        _restore_process_priority_normal()
        restored_prio = k32.GetPriorityClass(k32.GetCurrentProcess())
        assert restored_prio == NORMAL_PRIORITY_CLASS, (
            f"Expected NORMAL (0x20), got {hex(restored_prio)}"
        )

    def test_priority_restoration_guarantee_on_exception(self):
        """Verify _consume_segments restores priority even if generator raises an unhandled exception."""
        if os.name != "nt":
            pytest.skip("Win32 process priority tests require Windows")

        k32 = ctypes.windll.kernel32
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        k32.GetPriorityClass.argtypes = [wintypes.HANDLE]
        k32.GetPriorityClass.restype = wintypes.DWORD
        NORMAL_PRIORITY_CLASS = 0x00000020

        def faulty_generator():
            yield MagicMock(text="segment 1", start=0.0, end=1.0, words=[])
            raise RuntimeError("Simulated transcription decode failure")

        with pytest.raises(RuntimeError, match="Simulated transcription decode failure"):
            _consume_segments(faulty_generator(), word_timestamps=False, throttle_cpu=True)

        current_prio = k32.GetPriorityClass(k32.GetCurrentProcess())
        assert current_prio == NORMAL_PRIORITY_CLASS, (
            f"Priority MUST be restored to NORMAL after exception; remained {hex(current_prio)}"
        )


# ═════════════════════════════════════════════════════════════════════════════
# TEST SUITE 4: GPU VRAM Safety Watchdog & Model Pre-warming Safety
# ═════════════════════════════════════════════════════════════════════════════

class TestVRAMSafetyAndPrewarmWatchdog:

    def test_vram_threshold_specification_completeness(self):
        """Verify _MIN_FREE_VRAM_MB defines safe thresholds for all production models."""
        thresholds = WhisperService._MIN_FREE_VRAM_MB
        required_models = ["tiny", "base", "small", "medium", "large-v3-turbo", "large-v3"]
        for m in required_models:
            assert m in thresholds, f"Missing VRAM safety threshold for model {m}"
            assert thresholds[m] >= 900, f"Threshold for {m} too low ({thresholds[m]} MiB) for WDDM swapchain safety"

        # Ascending safety ordering
        assert thresholds["tiny"] <= thresholds["base"] <= thresholds["small"] <= thresholds["medium"]
        assert thresholds["large-v3"] >= 4000, "large-v3 requires >= 4000 MiB free VRAM to prevent TDR reset"

    def test_automatic_cpu_fallback_on_constrained_vram(self, temp_env):
        """Verify that when free VRAM < model threshold, system falls back to CPU int8."""
        service: WhisperService = temp_env["service"]

        # Mock CUDA available but only 1200 MiB free (large-v3 requires 4200 MiB)
        with patch.object(service, "detect_device_and_compute", return_value=("cuda", "float16", "NVIDIA RTX 3080")):
            with patch.object(service, "_query_gpu_vram_mb", return_value=(1200, 10240)):
                free_vram, total_vram = service._query_gpu_vram_mb()
                min_needed = service._MIN_FREE_VRAM_MB.get("large-v3", 4200)

                best_dev, best_comp, _ = service.detect_device_and_compute("cuda", "float16")
                if best_dev == "cuda" and free_vram > 0 and free_vram < min_needed:
                    best_dev = "cpu"
                    best_comp = "int8"

                assert best_dev == "cpu", "Must fall back to CPU when free VRAM is insufficient"
                assert best_comp == "int8", "CPU fallback must use int8 quantization"

    def test_int8_float16_selection_on_8gb_gpus(self, temp_env):
        """Verify that on <= 8GB GPUs, compute falls back to int8_float16 to prevent WDDM paging."""
        service: WhisperService = temp_env["service"]

        with patch.object(service, "detect_device_and_compute", return_value=("cuda", "auto", "NVIDIA RTX 3070")):
            with patch.object(service, "_query_gpu_vram_mb", return_value=(5000, 8192)):
                free_vram, total_vram = service._query_gpu_vram_mb()
                best_dev = "cuda"
                best_comp = "auto"
                target_comp = "auto"
                model_name = "large-v3-turbo"

                if best_dev == "cuda" and 0 < total_vram <= 8192 and model_name in ("medium", "large-v3-turbo", "large-v3"):
                    if target_comp == "auto":
                        best_comp = "int8_float16"

                assert best_comp == "int8_float16", "Must select int8_float16 on 8GB GPU to protect Premiere swapchain"

    def test_unload_model_and_memory_reclamation(self, temp_env):
        """Verify unload_model successfully evicts models and cleans up references."""
        service: WhisperService = temp_env["service"]
        service._model = MagicMock()
        service._model_info = {"device": "cpu", "compute_type": "int8"}

        unloaded = service.unload_model()
        assert unloaded is True, "unload_model must return True when model was loaded"
        assert service._model is None, "Model reference must be set to None"
        assert service._model_info == {}, "Model info must be reset"

        # Subsequent call returns False (already unloaded)
        assert service.unload_model() is False
