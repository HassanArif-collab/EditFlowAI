"""Tests for the diagnostics log sink.

WHY: the whole point of the sink is that a failure lands in ONE shareable file
without copy-paste. If the bundle drops the header, mis-tails the log, or the
relay 500s on a junk event, the user is back to pasting bugs. These pin the pure
builders and the route contracts.
"""
from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from backend.main import app
from backend.utils.logsink import build_bundle_text, init_file_logging, tail_lines


def test_tail_lines_bounded_and_missing_safe(tmp_path: Path):
    assert tail_lines(tmp_path / "nope.log", 50) == []      # missing file → []
    p = tmp_path / "x.log"
    p.write_text("\n".join(f"line{i}" for i in range(100)), encoding="utf-8")
    last = tail_lines(p, 10)
    assert len(last) == 10
    assert last[-1].strip() == "line99"


def test_build_bundle_text_has_header_and_tail():
    text = build_bundle_text({"build": "review-12", "os": "Windows"},
                             ["2026-06-13 [INFO] x: hello", "[jsx] placeSubtitleClips :: {ok:false}"])
    assert "build: review-12" in text
    assert "os: Windows" in text
    assert "placeSubtitleClips" in text
    # the log tail is clearly delimited from the header
    assert "editflow.log" in text


def test_init_file_logging_is_idempotent():
    import logging
    before = list(logging.getLogger().handlers)
    init_file_logging()
    init_file_logging()
    after = logging.getLogger().handlers
    # exactly one rotating file handler was added across both calls
    from logging.handlers import RotatingFileHandler
    rfh = [h for h in after if isinstance(h, RotatingFileHandler)]
    assert len(rfh) == 1


def test_diag_log_accepts_batch_and_is_junk_safe():
    c = TestClient(app)
    r = c.post("/api/diag/log", json={"build": "review-12", "events": [
        {"level": "error", "source": "jsx", "msg": "placeSubtitleClips", "data": {"ok": False, "error": "importMGT returned null"}},
        {"level": "warn", "source": "panel", "msg": "something"},
        {"bogus": "no level/msg"},          # must not crash
    ]})
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_diag_bundle_writes_file_and_returns_path():
    c = TestClient(app)
    r = c.post("/api/diag/bundle", json={"build": "review-12", "premiere": "23.0"})
    assert r.status_code == 200
    body = r.json()
    assert body["path"].endswith(".txt")
    assert Path(body["path"]).exists()
    assert Path(body["path"]).read_text(encoding="utf-8").find("review-12") >= 0
