"""
EditFlow AI - Preflight API Routes
Pre-flight checks and ExtendScript capability reporting.

Phase A.1 enhancement: capabilities are persisted to the
`premiere_capabilities` SQLite table keyed by (premiere_version,
panel_version).  This ensures the probe result survives server
restarts and the CEP panel only re-probes when the version pair
changes.
"""
import json
import logging
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter

from ..models.schemas import utc_now
from ..services.preflight import preflight_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/preflight", tags=["preflight"])


def _get_registry():
    """Lazy import to avoid circular imports at module level."""
    from ..models.sqlite_registry import sqlite_registry
    return sqlite_registry


@router.get("")
async def get_preflight():
    """Run all preflight checks and return the result."""
    result = await preflight_service.run_checks()
    return {
        "ready": result.ready,
        "checks": [asdict(c) for c in result.checks],
        "checked_at": result.checked_at,
    }


@router.post("/recheck")
async def recheck_preflight():
    """Force re-run all preflight checks (bypass any caching)."""
    # Currently there is no caching in the preflight service,
    # so this just re-runs all checks. If caching is added later,
    # this endpoint should bypass it.
    result = await preflight_service.run_checks()
    return {
        "ready": result.ready,
        "checks": [asdict(c) for c in result.checks],
        "checked_at": result.checked_at,
    }


@router.get("/capabilities")
async def get_capabilities(
    premiere_version: Optional[str] = None,
    panel_version: Optional[str] = None,
):
    """Return the stored Premiere capabilities.

    If *premiere_version* and *panel_version* are provided, look up the
    exact row.  Otherwise return the most recent probe result regardless
    of version.
    """
    registry = _get_registry()

    if premiere_version and panel_version:
        row = registry.find_capabilities(premiere_version, panel_version)
    else:
        row = registry.find_latest_capabilities()

    if row is None:
        return {"reported": False, "capabilities": {}}

    caps = row.get("capabilities_json", "{}")
    if isinstance(caps, str):
        try:
            caps = json.loads(caps)
        except (json.JSONDecodeError, TypeError):
            caps = {}

    return {
        "reported": True,
        "capabilities": caps,
        "premiere_version": row.get("premiere_version", ""),
        "panel_version": row.get("panel_version", ""),
        "probed_at": row.get("probed_at", ""),
    }


@router.post("/capabilities")
async def report_capabilities(capabilities: Dict[str, Any]):
    """Receive capability probe results from the CEP panel.

    The ExtendScript side runs ``probeCapabilities()`` and posts the
    result here so the backend knows what the host Premiere supports.

    The payload is persisted to the ``premiere_capabilities`` table
    keyed by ``(premiere_version, panel_version)``.  On subsequent
    boots the panel can check whether a re-probe is needed by
    comparing its version pair against the stored row.
    """
    registry = _get_registry()

    # Extract version info from the capability payload.  The ExtendScript
    # probe includes these when available; fall back to "unknown" so the
    # row is still stored.
    premiere_version = capabilities.get("premiere_version", "unknown")
    panel_version = capabilities.get("panel_version", "unknown")
    probed_at = utc_now()

    registry.upsert_capabilities(
        premiere_version=premiere_version,
        panel_version=panel_version,
        capabilities_json=json.dumps(capabilities, ensure_ascii=False),
        probed_at=probed_at,
    )

    logger.info(
        f"Stored Premiere capabilities for "
        f"premiere={premiere_version}, panel={panel_version}: "
        f"{capabilities}"
    )
    return {
        "reported": True,
        "capabilities": capabilities,
        "premiere_version": premiere_version,
        "panel_version": panel_version,
        "probed_at": probed_at,
    }
