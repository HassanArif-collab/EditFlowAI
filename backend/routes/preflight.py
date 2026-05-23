"""
EditFlow AI - Preflight API Routes
Pre-flight checks and ExtendScript capability reporting.
"""
import logging
from dataclasses import asdict
from typing import Any, Dict, Optional

from fastapi import APIRouter

from ..services.preflight import preflight_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/preflight", tags=["preflight"])

# In-memory store for the last reported Premiere capabilities.
# Populated by the CEP panel via POST /api/preflight/capabilities.
_last_capabilities: Optional[Dict[str, Any]] = None


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
async def get_capabilities():
    """Return the last reported Premiere capabilities from the CEP panel."""
    if _last_capabilities is None:
        return {"reported": False, "capabilities": {}}
    return {"reported": True, "capabilities": _last_capabilities}


@router.post("/capabilities")
async def report_capabilities(capabilities: Dict[str, Any]):
    """Receive capability probe results from the CEP panel.

    The ExtendScript side runs probeCapabilities() and posts the
    result here so the backend knows what the host Premiere supports.
    """
    global _last_capabilities
    _last_capabilities = capabilities
    logger.info(f"Received Premiere capabilities: {capabilities}")
    return {"reported": True, "capabilities": capabilities}
