"""
EditFlow AI - Catalog API Routes
"""
import logging
from typing import List, Optional

from fastapi import APIRouter, HTTPException

from ..models.schemas import CatalogResult
from ..services.catalog_service import catalog_service
from ..utils.progress import ProgressReporter

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/catalog", tags=["catalog"])


@router.get("/search")
async def search_catalog(
    query: str,
    catalog_name: str = "default",
    max_results: int = 20,
):
    """Search catalog entries by keywords/description."""
    results = await catalog_service.search_catalog(
        query=query,
        catalog_name=catalog_name,
        max_results=max_results,
    )
    return {
        "query": query,
        "count": len(results),
        "results": [r.dict() for r in results],
    }


@router.get("/{catalog_name}", response_model=CatalogResult)
async def get_catalog(catalog_name: str = "default"):
    """Get a B-roll catalog."""
    result = await catalog_service.get_catalog(catalog_name)
    return result


@router.post("/build")
async def build_catalog(
    directories: List[str],
    catalog_name: str = "default",
    model: Optional[str] = None,
    force_reanalyze: bool = False,
    client_id: Optional[str] = None,
):
    """Build a B-roll catalog by analyzing videos with AI vision."""
    progress = ProgressReporter(task_type="catalog", client_id=client_id)
    try:
        result = await catalog_service.build_catalog(
            directories=directories,
            catalog_name=catalog_name,
            model=model,
            force_reanalyze=force_reanalyze,
            progress=progress,
        )
        return result.dict()
    except Exception as e:
        logger.error(f"Catalog build error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

