"""EditFlow AI — dev file watcher (agent loop, dev-only).

Polls cep-panel-ae/ mtimes and pushes {"type": "dev_reload"} over the panel
WebSocket when files change; the panel re-evals index.jsx and reloads
itself. Zero-click reload: agent edits code → panel is current ~2s later.

stdlib polling instead of a watcher dependency on purpose.
ponytail: 2s mtime scan over a few hundred files — swap for watchfiles if
the scan ever shows up in profiles.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from ..utils.progress import manager

logger = logging.getLogger(__name__)

_WATCH_EXTS = {".js", ".jsx", ".html", ".css"}
_POLL_SECONDS = 2.0


def _scan(root: Path) -> dict[str, float]:
    out: dict[str, float] = {}
    for p in root.rglob("*"):
        if p.suffix.lower() in _WATCH_EXTS:
            try:
                out[str(p)] = p.stat().st_mtime
            except OSError:
                continue
    return out


async def watch_panel_files(repo_root: Path) -> None:
    """Run forever; cancelled at shutdown. Broadcasts dev_reload on change."""
    root = repo_root / "cep-panel-ae"
    if not root.exists():
        logger.warning("dev_watch: %s missing, watcher disabled", root)
        return
    logger.info("dev_watch: watching %s (poll %.1fs)", root, _POLL_SECONDS)
    known = _scan(root)
    while True:
        await asyncio.sleep(_POLL_SECONDS)
        try:
            now = _scan(root)
        except Exception as exc:  # noqa: BLE001 — a scan hiccup must not kill the loop
            logger.debug("dev_watch scan failed: %s", exc)
            continue
        changed = [
            p for p, m in now.items() if known.get(p) != m
        ] + [p for p in known if p not in now]
        if changed:
            known = now
            logger.info("dev_watch: %d change(s), pushing dev_reload", len(changed))
            try:
                await manager.broadcast(
                    {"type": "dev_reload", "files": [Path(p).name for p in changed[:10]]}
                )
            except Exception as exc:  # noqa: BLE001
                logger.debug("dev_watch broadcast failed: %s", exc)
