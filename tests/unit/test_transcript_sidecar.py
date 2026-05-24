"""Unit tests for transcript sidecar writing in whisper_service.py.

Verifies that _save_transcript_cache also writes a human-readable
{video}.transcript.json next to the source video, and that it
gracefully handles read-only mounts, missing source_file, and
the WRITE_TRANSCRIPT_SIDECAR=False flag.
"""
import json
import pytest
from pathlib import Path
from unittest.mock import patch

from backend.models.schemas import TranscriptResult, TranscriptSegment, TranscriptWord
from backend.services.whisper_service import WhisperService


def _make_result(source_file: str = "", full_text: str = "Hello world") -> TranscriptResult:
    """Build a minimal TranscriptResult for testing."""
    return TranscriptResult(
        source_file=source_file,
        language="en",
        duration=5.0,
        segments=[
            TranscriptSegment(
                start=0.0,
                end=5.0,
                text=full_text,
                words=[
                    TranscriptWord(word="Hello", start=0.0, end=0.5, probability=0.99),
                    TranscriptWord(word="world", start=0.6, end=1.0, probability=0.98),
                ],
            ),
        ],
        full_text=full_text,
    )


def _make_service(tmp_path: Path, write_sidecar: bool = True) -> WhisperService:
    """Create a WhisperService with a temp MEDIA_CACHE_DIR and controlled settings."""
    from backend.config import Settings

    settings = Settings(
        DATA_DIR=tmp_path / "data",
        MEDIA_CACHE_DIR=tmp_path / "data" / "media_cache",
        WRITE_TRANSCRIPT_SIDECAR=write_sidecar,
    )
    # Ensure cache dirs exist
    settings.MEDIA_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return WhisperService(settings=settings)


class TestTranscriptSidecar:
    """Test transcript sidecar file writing."""

    def test_sidecar_written_next_to_source(self, tmp_path: Path):
        """After _save_transcript_cache, a sidecar file exists next to the source video."""
        # Create a fake source video path (doesn't need to exist as a file,
        # but its parent directory must exist)
        video_dir = tmp_path / "footage"
        video_dir.mkdir()
        video_path = video_dir / "IMG_1694.MOV"
        video_path.write_text("fake video")  # create the file so parent.exists() works

        result = _make_result(source_file=str(video_path))
        svc = _make_service(tmp_path, write_sidecar=True)

        svc._save_transcript_cache("test_fp_123", result)

        sidecar = video_dir / "IMG_1694.transcript.json"
        assert sidecar.exists(), f"Sidecar not found at {sidecar}"

        data = json.loads(sidecar.read_text(encoding="utf-8"))
        assert data["full_text"] == "Hello world"
        assert data["language"] == "en"
        assert len(data["segments"]) == 1
        assert data["segments"][0]["text"] == "Hello world"

    def test_sidecar_skipped_when_flag_disabled(self, tmp_path: Path):
        """When WRITE_TRANSCRIPT_SIDECAR=False, no sidecar is written."""
        video_dir = tmp_path / "footage"
        video_dir.mkdir()
        video_path = video_dir / "IMG_1694.MOV"
        video_path.write_text("fake video")

        result = _make_result(source_file=str(video_path))
        svc = _make_service(tmp_path, write_sidecar=False)

        svc._save_transcript_cache("test_fp_456", result)

        sidecar = video_dir / "IMG_1694.transcript.json"
        assert not sidecar.exists(), "Sidecar should NOT be written when flag is disabled"

        # In-memory cache should still be populated
        assert "test_fp_456" in svc._transcript_cache

    def test_sidecar_skipped_when_source_missing(self, tmp_path: Path):
        """When source_file is empty, no sidecar is created and no exception raised."""
        result = _make_result(source_file="")
        svc = _make_service(tmp_path, write_sidecar=True)

        # Should not raise
        svc._save_transcript_cache("test_fp_789", result)

        # Verify no sidecar files were created anywhere in tmp_path
        sidecar_files = list(tmp_path.rglob("*.transcript.json"))
        assert len(sidecar_files) == 0, f"Unexpected sidecar files: {sidecar_files}"

        # In-memory cache should still be populated
        assert "test_fp_789" in svc._transcript_cache

    def test_sidecar_handles_readonly_parent_gracefully(self, tmp_path: Path):
        """When write_text raises PermissionError, _save_transcript_cache
        returns without raising and the in-memory cache is still populated."""
        video_dir = tmp_path / "footage"
        video_dir.mkdir()
        video_path = video_dir / "IMG_1694.MOV"
        video_path.write_text("fake video")

        result = _make_result(source_file=str(video_path))
        svc = _make_service(tmp_path, write_sidecar=True)

        # Patch Path.write_text to raise PermissionError for the sidecar path
        original_write_text = Path.write_text
        sidecar_path = video_dir / "IMG_1694.transcript.json"

        def _mock_write_text(self, content, **kwargs):
            if str(self) == str(sidecar_path):
                raise PermissionError("Read-only filesystem")
            return original_write_text(self, content, **kwargs)

        with patch.object(Path, "write_text", _mock_write_text):
            # Should NOT raise
            svc._save_transcript_cache("test_fp_ro", result)

        # In-memory cache should still be populated
        assert "test_fp_ro" in svc._transcript_cache
        assert svc._transcript_cache["test_fp_ro"].full_text == "Hello world"

        # Sidecar should NOT exist
        assert not sidecar_path.exists()
