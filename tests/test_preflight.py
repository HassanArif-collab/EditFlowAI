"""Unit tests for the PreflightService.

Each check is tested in isolation with mocked dependencies so the test
suite requires zero external services (no ffmpeg, no Whisper, no LLM).

Run via:
    python -m unittest tests.test_preflight -v
"""
from __future__ import annotations

import asyncio
import builtins
import shutil
import sys
import unittest
from collections import namedtuple
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
from unittest.mock import AsyncMock, MagicMock, patch

from backend.services.preflight import PreflightCheck, PreflightResult, PreflightService


def _run(coro):
    """Run an async coroutine synchronously in tests."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ── Helper: fake Settings ──

@dataclass
class FakeSettings:
    """Minimal settings stub for preflight tests."""
    FFMPEG_PATH: str = "ffmpeg"
    FFPROBE_PATH: str = "ffprobe"
    WHISPER_MODEL: str = "large-v3-turbo"
    WHISPER_DEVICE: str = "cpu"
    WHISPER_COMPUTE_TYPE: str = "int8"
    WHISPER_LOCAL_DIR: Optional[str] = None
    MEDIA_CACHE_DIR: Path = Path("/tmp/editflow_test_cache")


# ── ffmpeg_available ──

class TestFfmpegAvailable(unittest.TestCase):
    def test_green_when_binary_found_and_works(self):
        svc = PreflightService(settings=FakeSettings())
        with patch("shutil.which", return_value="/usr/bin/ffmpeg"), \
             patch("asyncio.create_subprocess_exec") as mock_exec:
            proc = AsyncMock()
            proc.wait = AsyncMock(return_value=0)
            proc.returncode = 0
            mock_exec.return_value = proc
            result = _run(svc.check_ffmpeg_available())
            self.assertEqual(result.status, "green")
            self.assertEqual(result.name, "ffmpeg_available")

    def test_red_when_binary_not_found(self):
        svc = PreflightService(settings=FakeSettings())
        with patch("shutil.which", return_value=None):
            result = _run(svc.check_ffmpeg_available())
            self.assertEqual(result.status, "red")

    def test_red_when_binary_times_out(self):
        svc = PreflightService(settings=FakeSettings())
        with patch("shutil.which", return_value="/usr/bin/ffmpeg"), \
             patch("asyncio.create_subprocess_exec") as mock_exec:
            proc = AsyncMock()
            proc.kill = MagicMock()
            proc.wait = AsyncMock(return_value=0)
            mock_exec.return_value = proc
            # Simulate wait_for timing out
            with patch("asyncio.wait_for", side_effect=asyncio.TimeoutError()):
                result = _run(svc.check_ffmpeg_available())
            self.assertEqual(result.status, "red")
            self.assertIn("timed out", result.message)

    def test_red_when_binary_nonzero_exit(self):
        svc = PreflightService(settings=FakeSettings())
        with patch("shutil.which", return_value="/usr/bin/ffmpeg"), \
             patch("asyncio.create_subprocess_exec") as mock_exec:
            proc = AsyncMock()
            proc.wait = AsyncMock(return_value=1)
            proc.returncode = 1
            mock_exec.return_value = proc
            result = _run(svc.check_ffmpeg_available())
            self.assertEqual(result.status, "red")


# ── ffprobe_available ──

class TestFfprobeAvailable(unittest.TestCase):
    def test_yellow_when_not_found(self):
        """ffprobe missing is yellow (degraded but usable), not red."""
        svc = PreflightService(settings=FakeSettings())
        with patch("shutil.which", return_value=None):
            result = _run(svc.check_ffprobe_available())
            self.assertEqual(result.status, "yellow")

    def test_green_when_available(self):
        svc = PreflightService(settings=FakeSettings())
        with patch("shutil.which", return_value="/usr/bin/ffprobe"), \
             patch("asyncio.create_subprocess_exec") as mock_exec:
            proc = AsyncMock()
            proc.wait = AsyncMock(return_value=0)
            proc.returncode = 0
            mock_exec.return_value = proc
            result = _run(svc.check_ffprobe_available())
            self.assertEqual(result.status, "green")


# ── whisper_engine ──

class TestWhisperEngine(unittest.TestCase):
    def test_green_when_whisperx_available(self):
        svc = PreflightService(settings=FakeSettings())
        with patch.dict("sys.modules", {"whisperx": MagicMock()}):
            result = _run(svc.check_whisper_engine())
            self.assertEqual(result.status, "green")
            self.assertIn("whisperx", result.message)

    def test_yellow_when_stable_ts_available(self):
        svc = PreflightService(settings=FakeSettings())
        real_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name == "whisperx":
                raise ImportError("no whisperx")
            return real_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=fake_import), \
             patch.dict("sys.modules", {"stable_ts": MagicMock()}):
            result = _run(svc.check_whisper_engine())
            self.assertEqual(result.status, "yellow")
            self.assertIn("stable-ts", result.message)

    def test_yellow_when_only_faster_whisper(self):
        svc = PreflightService(settings=FakeSettings())
        real_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name in ("whisperx", "stable_ts"):
                raise ImportError(f"no {name}")
            return real_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=fake_import), \
             patch.dict("sys.modules", {"faster_whisper": MagicMock()}):
            result = _run(svc.check_whisper_engine())
            self.assertEqual(result.status, "yellow")
            self.assertIn("faster-whisper", result.message)

    def test_red_when_nothing_available(self):
        svc = PreflightService(settings=FakeSettings())
        real_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name in ("whisperx", "stable_ts", "faster_whisper"):
                raise ImportError(f"no {name}")
            return real_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=fake_import):
            result = _run(svc.check_whisper_engine())
            self.assertEqual(result.status, "red")


# ── whisper_model ──

class TestWhisperModel(unittest.TestCase):
    def test_green_when_local_dir_exists(self):
        settings = FakeSettings(WHISPER_LOCAL_DIR="/some/existing/dir")
        svc = PreflightService(settings=settings)
        with patch.object(Path, "exists", return_value=True), \
             patch.object(Path, "iterdir", return_value=[Path("model.bin")]):
            result = _run(svc.check_whisper_model())
            self.assertEqual(result.status, "green")

    def test_red_when_local_dir_missing(self):
        settings = FakeSettings(WHISPER_LOCAL_DIR="/nonexistent/dir")
        svc = PreflightService(settings=settings)
        with patch.object(Path, "exists", return_value=False):
            result = _run(svc.check_whisper_model())
            self.assertEqual(result.status, "red")

    def test_yellow_when_no_local_dir_and_not_cached(self):
        svc = PreflightService(settings=FakeSettings())
        # Make HuggingFace cache dir not exist
        with patch.object(Path, "exists", return_value=False):
            result = _run(svc.check_whisper_model())
            self.assertEqual(result.status, "yellow")
            self.assertIn("download", result.message.lower())

    def test_green_when_hf_cache_exists(self):
        svc = PreflightService(settings=FakeSettings())
        # Simulate HuggingFace cache directory existing
        with patch.object(Path, "home", return_value=Path("/home/user")):
            # The code does: hf_cache = Path.home() / ".cache" / "huggingface" / "hub"
            # Then checks hf_cache.exists() and model_cache_dir.exists()
            # We need the right paths to return True
            def mock_exists(self_path):
                path_str = str(self_path)
                if "huggingface" in path_str:
                    return True
                return False

            with patch.object(Path, "exists", mock_exists):
                result = _run(svc.check_whisper_model())
                self.assertEqual(result.status, "green")


# ── chat_provider ──

class TestChatProvider(unittest.TestCase):
    def _make_service(self):
        return PreflightService(settings=FakeSettings())

    def test_green_when_provider_connected(self):
        mock_ps = MagicMock()
        mock_ps.initialize = AsyncMock()
        mock_ps.get_active_chat.return_value = {"provider_id": "ollama-local", "model": "gemma3:4b"}
        mock_ps.health_check = AsyncMock(return_value={
            "ollama-local": {"connected": True, "error": None}
        })

        svc = self._make_service()
        with patch("backend.services.provider_service.provider_service", mock_ps):
            result = _run(svc.check_chat_provider())
            self.assertEqual(result.status, "green")
            self.assertIn("connected", result.message)

    def test_yellow_when_provider_not_connected(self):
        mock_ps = MagicMock()
        mock_ps.initialize = AsyncMock()
        mock_ps.get_active_chat.return_value = {"provider_id": "ollama-local", "model": "gemma3:4b"}
        mock_ps.health_check = AsyncMock(return_value={
            "ollama-local": {"connected": False, "error": "Connection refused"}
        })

        svc = self._make_service()
        with patch("backend.services.provider_service.provider_service", mock_ps):
            result = _run(svc.check_chat_provider())
            self.assertEqual(result.status, "yellow")

    def test_red_when_no_provider_configured(self):
        mock_ps = MagicMock()
        mock_ps.initialize = AsyncMock()
        mock_ps.get_active_chat.return_value = {"provider_id": None, "model": None}

        svc = self._make_service()
        with patch("backend.services.provider_service.provider_service", mock_ps):
            result = _run(svc.check_chat_provider())
            self.assertEqual(result.status, "red")


# ── embedding_model ──

class TestEmbeddingModel(unittest.TestCase):
    def test_green_when_sentence_transformers_available(self):
        svc = PreflightService(settings=FakeSettings())
        with patch.dict("sys.modules", {"sentence_transformers": MagicMock()}):
            result = _run(svc.check_embedding_model())
            self.assertEqual(result.status, "green")

    def test_yellow_when_not_available(self):
        svc = PreflightService(settings=FakeSettings())
        real_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name == "sentence_transformers":
                raise ImportError("no sentence_transformers")
            return real_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=fake_import):
            result = _run(svc.check_embedding_model())
            self.assertEqual(result.status, "yellow")


# ── disk_space ──

class TestDiskSpace(unittest.TestCase):
    def test_green_when_lots_of_space(self):
        svc = PreflightService(settings=FakeSettings())
        with patch.object(Path, "mkdir", return_value=None), \
             patch.object(PreflightService, "_get_free_space", return_value=10 * 1024**3):
            result = _run(svc.check_disk_space())
            self.assertEqual(result.status, "green")

    def test_yellow_when_moderate_space(self):
        svc = PreflightService(settings=FakeSettings())
        with patch.object(Path, "mkdir", return_value=None), \
             patch.object(PreflightService, "_get_free_space", return_value=3 * 1024**3):
            result = _run(svc.check_disk_space())
            self.assertEqual(result.status, "yellow")

    def test_red_when_low_space(self):
        svc = PreflightService(settings=FakeSettings())
        with patch.object(Path, "mkdir", return_value=None), \
             patch.object(PreflightService, "_get_free_space", return_value=500 * 1024**2):
            result = _run(svc.check_disk_space())
            self.assertEqual(result.status, "red")

    def test_red_when_cannot_create_dir(self):
        svc = PreflightService(settings=FakeSettings())
        with patch.object(Path, "mkdir", side_effect=OSError("permission denied")):
            result = _run(svc.check_disk_space())
            self.assertEqual(result.status, "red")


# ── python_version ──

# Use a namedtuple so the mock has .major, .minor, .micro attributes
VersionInfo = namedtuple("VersionInfo", ["major", "minor", "micro", "releaselevel", "serial"])


class TestPythonVersion(unittest.TestCase):
    def test_green_when_3_10_plus(self):
        svc = PreflightService(settings=FakeSettings())
        with patch.object(sys, "version_info", VersionInfo(3, 11, 0, "final", 0)):
            result = _run(svc.check_python_version())
            self.assertEqual(result.status, "green")

    def test_red_when_older_python(self):
        svc = PreflightService(settings=FakeSettings())
        with patch.object(sys, "version_info", VersionInfo(3, 9, 7, "final", 0)):
            result = _run(svc.check_python_version())
            self.assertEqual(result.status, "red")


# ── Aggregate results ──

class TestPreflightResult(unittest.TestCase):
    def test_ready_when_all_green(self):
        checks = [
            PreflightCheck(name="a", status="green", message="ok"),
            PreflightCheck(name="b", status="green", message="ok"),
        ]
        result = PreflightResult(checks=checks)
        self.assertTrue(result.ready)

    def test_not_ready_when_any_red(self):
        checks = [
            PreflightCheck(name="a", status="green", message="ok"),
            PreflightCheck(name="b", status="red", message="fail"),
        ]
        result = PreflightResult(checks=checks)
        self.assertFalse(result.ready)

    def test_ready_with_yellows(self):
        """Yellow checks don't block readiness."""
        checks = [
            PreflightCheck(name="a", status="green", message="ok"),
            PreflightCheck(name="b", status="yellow", message="degraded"),
            PreflightCheck(name="c", status="green", message="ok"),
        ]
        result = PreflightResult(checks=checks)
        self.assertTrue(result.ready)

    def test_not_ready_with_red_and_yellow(self):
        checks = [
            PreflightCheck(name="a", status="yellow", message="degraded"),
            PreflightCheck(name="b", status="red", message="fail"),
        ]
        result = PreflightResult(checks=checks)
        self.assertFalse(result.ready)

    def test_checked_at_is_set(self):
        result = PreflightResult(checks=[])
        self.assertTrue(len(result.checked_at) > 0)


# ── run_checks integration ──

class TestRunChecks(unittest.TestCase):
    """Test the full run_checks with all checks mocked."""

    def test_returns_eight_checks(self):
        svc = PreflightService(settings=FakeSettings())
        green = PreflightCheck(name="test", status="green", message="ok")
        with patch.object(svc, "check_ffmpeg_available", new=AsyncMock(return_value=green)), \
             patch.object(svc, "check_ffprobe_available", new=AsyncMock(return_value=green)), \
             patch.object(svc, "check_whisper_engine", new=AsyncMock(return_value=green)), \
             patch.object(svc, "check_whisper_model", new=AsyncMock(return_value=green)), \
             patch.object(svc, "check_chat_provider", new=AsyncMock(return_value=green)), \
             patch.object(svc, "check_embedding_model", new=AsyncMock(return_value=green)), \
             patch.object(svc, "check_disk_space", new=AsyncMock(return_value=green)), \
             patch.object(svc, "check_premiere_project", new=AsyncMock(return_value=green)), \
             patch.object(svc, "check_python_version", new=AsyncMock(return_value=green)):
            result = _run(svc.run_checks())
            self.assertEqual(len(result.checks), 9)
            self.assertTrue(result.ready)

    def test_ready_false_when_one_red(self):
        svc = PreflightService(settings=FakeSettings())
        green = PreflightCheck(name="test", status="green", message="ok")
        red = PreflightCheck(name="test", status="red", message="fail")
        check_mocks = {
            "check_ffmpeg_available": AsyncMock(return_value=red),
            "check_ffprobe_available": AsyncMock(return_value=green),
            "check_whisper_engine": AsyncMock(return_value=green),
            "check_whisper_model": AsyncMock(return_value=green),
            "check_chat_provider": AsyncMock(return_value=green),
            "check_embedding_model": AsyncMock(return_value=green),
            "check_disk_space": AsyncMock(return_value=green),
            "check_premiere_project": AsyncMock(return_value=green),
            "check_python_version": AsyncMock(return_value=green),
        }
        with patch.multiple(svc, **check_mocks):
            result = _run(svc.run_checks())
            self.assertFalse(result.ready)


if __name__ == "__main__":
    unittest.main()


# ── Phase A.1: Capability DB persistence ──

class TestPremiereCapabilitiesDB(unittest.TestCase):
    """Test the premiere_capabilities table and helper methods."""

    def setUp(self):
        import tempfile
        from backend.models.sqlite_registry import SQLiteRegistry
        from backend.config import Settings

        self.tmpdir = tempfile.mkdtemp()
        db_path = Path(self.tmpdir) / "test.sqlite3"
        self.settings = Settings(
            DATA_DIR=Path(self.tmpdir),
            MEDIA_CACHE_DIR=Path(self.tmpdir) / "cache",
            OUTPUT_DIR=Path(self.tmpdir) / "output",
            DB_PATH=db_path,
        )
        self.registry = SQLiteRegistry(settings=self.settings)
        self.registry.initialize()

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_premiere_capabilities_table_exists(self):
        """The premiere_capabilities table should be created during initialization."""
        rows = self.registry.fetch_all(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='premiere_capabilities'"
        )
        self.assertEqual(len(rows), 1, "premiere_capabilities table not found")

    def test_upsert_and_find_capabilities(self):
        """Insert and retrieve capabilities by (premiere_version, panel_version)."""
        import json
        caps = {"qe_available": True, "qe_razor": True, "active_sequence": True}
        self.registry.upsert_capabilities(
            premiere_version="25.0",
            panel_version="2",
            capabilities_json=json.dumps(caps),
            probed_at="2026-05-23T00:00:00+00:00",
        )
        result = self.registry.find_capabilities("25.0", "2")
        self.assertIsNotNone(result)
        self.assertEqual(result["premiere_version"], "25.0")
        self.assertEqual(result["panel_version"], "2")
        stored_caps = json.loads(result["capabilities_json"])
        self.assertTrue(stored_caps["qe_available"])

    def test_find_capabilities_returns_none_for_unknown(self):
        result = self.registry.find_capabilities("99.0", "1")
        self.assertIsNone(result)

    def test_find_latest_capabilities(self):
        """find_latest_capabilities returns the most recently probed row."""
        import json

        # Insert two entries with different timestamps
        self.registry.upsert_capabilities(
            premiere_version="24.0",
            panel_version="1",
            capabilities_json=json.dumps({"qe_available": False}),
            probed_at="2026-05-22T00:00:00+00:00",
        )
        self.registry.upsert_capabilities(
            premiere_version="25.0",
            panel_version="2",
            capabilities_json=json.dumps({"qe_available": True}),
            probed_at="2026-05-23T00:00:00+00:00",
        )
        result = self.registry.find_latest_capabilities()
        self.assertIsNotNone(result)
        self.assertEqual(result["premiere_version"], "25.0")

    def test_upsert_replaces_existing(self):
        """Second upsert for same key should replace the first."""
        import json

        self.registry.upsert_capabilities(
            premiere_version="25.0",
            panel_version="2",
            capabilities_json=json.dumps({"qe_available": False}),
            probed_at="2026-05-22T00:00:00+00:00",
        )
        self.registry.upsert_capabilities(
            premiere_version="25.0",
            panel_version="2",
            capabilities_json=json.dumps({"qe_available": True, "qe_razor": True}),
            probed_at="2026-05-23T12:00:00+00:00",
        )
        result = self.registry.find_capabilities("25.0", "2")
        stored_caps = json.loads(result["capabilities_json"])
        self.assertTrue(stored_caps["qe_available"])
        self.assertTrue(stored_caps["qe_razor"])
        self.assertEqual(result["probed_at"], "2026-05-23T12:00:00+00:00")

    def test_multiple_version_pairs_coexist(self):
        """Different (premiere_version, panel_version) pairs are separate rows."""
        import json

        self.registry.upsert_capabilities(
            premiere_version="24.0",
            panel_version="2",
            capabilities_json=json.dumps({"qe_available": False}),
            probed_at="2026-05-22T00:00:00+00:00",
        )
        self.registry.upsert_capabilities(
            premiere_version="25.0",
            panel_version="2",
            capabilities_json=json.dumps({"qe_available": True}),
            probed_at="2026-05-23T00:00:00+00:00",
        )
        r1 = self.registry.find_capabilities("24.0", "2")
        r2 = self.registry.find_capabilities("25.0", "2")
        self.assertIsNotNone(r1)
        self.assertIsNotNone(r2)
        self.assertNotEqual(
            json.loads(r1["capabilities_json"]),
            json.loads(r2["capabilities_json"]),
        )
