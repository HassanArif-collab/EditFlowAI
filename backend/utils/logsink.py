"""Persistent diagnostics log sink.

One file on disk (`data/logs/editflow.log`) collects backend logs + relayed panel
and ExtendScript events, so a failure can be shared as a single bundle instead of
copy-pasted. See docs/plans/diagnostics-log-sink.md.
"""
from __future__ import annotations

import logging
import logging.handlers
from pathlib import Path

_FILE_HANDLER: logging.Handler | None = None
_FMT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"


def logs_dir() -> Path:
    from ..config import get_settings
    d = get_settings().DATA_DIR / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def log_file() -> Path:
    return logs_dir() / "editflow.log"


def init_file_logging() -> None:
    """Attach a rotating file handler to the root logger (idempotent)."""
    global _FILE_HANDLER
    if _FILE_HANDLER is not None:
        return
    try:
        handler = logging.handlers.RotatingFileHandler(
            log_file(), maxBytes=5_000_000, backupCount=3, encoding="utf-8"
        )
        handler.setLevel(logging.INFO)
        handler.setFormatter(logging.Formatter(_FMT))
        logging.getLogger().addHandler(handler)
        _FILE_HANDLER = handler
    except Exception:  # noqa: BLE001 — logging must never break startup
        logging.getLogger(__name__).warning("Could not attach file log handler", exc_info=True)


def tail_lines(path: Path, n: int) -> list[str]:
    """Last ``n`` lines of ``path`` (``[]`` if missing). Simple + robust."""
    if not path.exists():
        return []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.readlines()[-n:]
    except Exception:  # noqa: BLE001
        return []


def build_bundle_text(header: dict, tail: list[str]) -> str:
    """Assemble the shareable bundle: header block + delimited log tail. Pure."""
    lines = ["==== EditFlow diagnostics bundle ===="]
    for key, val in header.items():
        lines.append(f"{key}: {val}")
    lines.append("")
    lines.append("==== editflow.log (tail) ====")
    lines.extend(str(x).rstrip("\n") for x in tail)
    return "\n".join(lines) + "\n"
