"""EditFlow AI — diagnostics routes (panel/ExtendScript log relay + bundle).

  POST /api/diag/log     panel & ExtendScript events → the shared log file.
  POST /api/diag/bundle  write data/logs/diag-<ts>.txt (header + log tail) and
                         open the logs folder; return its path to drag into chat.

Tolerant by design: a diagnostics endpoint must never 500 on junk input.
"""
from __future__ import annotations

import datetime
import json
import logging
import os
import platform
from typing import Any, Optional

from fastapi import APIRouter
from pydantic import BaseModel

from ..utils.logsink import build_bundle_text, log_file, logs_dir, tail_lines

router = APIRouter(prefix="/diag", tags=["diag"])

_client_log = logging.getLogger("editflow.client")
_LEVELS = {"debug": logging.DEBUG, "info": logging.INFO, "warn": logging.WARNING,
           "warning": logging.WARNING, "error": logging.ERROR}


class LogReq(BaseModel):
    events: Optional[list[dict[str, Any]]] = None
    build: Optional[str] = None
    session: Optional[str] = None


@router.post("/log")
async def diag_log(req: LogReq):
    """Append relayed panel/jsx events to the shared log (junk-safe, capped)."""
    pre = f"[{req.build or '?'}/{(req.session or '?')[:8]}]"
    count = 0
    for ev in (req.events or [])[:500]:
        try:
            level = _LEVELS.get(str(ev.get("level", "info")).lower(), logging.INFO)
            src = ev.get("source", "panel")
            msg = ev.get("msg", "")
            data = ev.get("data")
            line = f"{pre} [{src}] {msg}"
            if data is not None:
                line += " :: " + json.dumps(data, default=str)[:1000]
            _client_log.log(level, line)
            count += 1
        except Exception:  # noqa: BLE001 — never let one bad event break the batch
            continue
    return {"ok": True, "count": count}


@router.get("/log/tail")
async def diag_log_tail(n: int = 200):
    """Last n log lines — lets an agent read errors without file access."""
    n = max(1, min(n, 2000))
    try:
        return {"lines": tail_lines(log_file(), n)}
    except Exception as exc:  # noqa: BLE001 — diagnostics must not 500
        return {"lines": [], "error": str(exc)}


class BundleReq(BaseModel):
    build: Optional[str] = None
    premiere: Optional[str] = None
    session: Optional[str] = None


@router.post("/bundle")
async def diag_bundle(req: BundleReq):
    """Write one shareable diagnostics file and open the logs folder."""
    header = {
        "generated": datetime.datetime.utcnow().isoformat() + "Z",
        "build": req.build or "?",
        "premiere": req.premiere or "?",
        "session": req.session or "?",
        "os": platform.platform(),
        "python": platform.python_version(),
    }
    text = build_bundle_text(header, tail_lines(log_file(), 800))
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    out = logs_dir() / f"diag-{stamp}.txt"
    try:
        out.write_text(text, encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        logging.getLogger(__name__).warning("diag bundle write failed: %s", exc)
        return {"path": "", "bytes": 0, "folder_opened": False, "error": str(exc)}

    folder_opened = False
    try:
        os.startfile(str(logs_dir()))  # Windows: reveal the folder in Explorer
        folder_opened = True
    except Exception:  # noqa: BLE001 — non-Windows or headless; non-fatal
        pass
    return {"path": str(out), "bytes": len(text), "folder_opened": folder_opened}
