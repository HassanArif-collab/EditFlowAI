"""Phase 1 read-only source-policy and migration previews; no activation controls."""
import asyncio
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..services.source_registry import source_registry, PolicyConflict
from ..services.source_migration import migration_preview
from ..services.visual_library_service import visual_library_service
from ..services.project_scripts import list_project_scripts

router = APIRouter(prefix='/library-sources', tags=['library-sources'])


class BasicSourceRequest(BaseModel):
    brand: str
    project_folder: str
    folder: Optional[str] = None
    project_path: Optional[str] = None
    bin_path: Optional[str] = None
    items: list[dict] = Field(default_factory=list)
    source_id: Optional[str] = None
    enabled: bool = True
    removed: bool = False


def checked_project(brand, folder):
    info = list_project_scripts(folder)
    if info['brand'].casefold() != brand.casefold():
        raise ValueError('Brand and project do not match.')
    return info['project_folder']


@router.get('/visuals')
def basic_sources(brand: str, project_folder: str):
    from ..services import basic_visual_sources as basic
    try:
        project = checked_project(brand, project_folder)
        rows = basic.sources(brand, project)
        snapshot = source_registry.snapshot()['tables']
        for row in rows:
            ids = {member['asset_id'] for member in snapshot['library_memberships'] if member['source_id'] == row['id']}
            row['paths'] = [item['path'] for item in snapshot['library_media_paths'] if item['asset_id'] in ids]
        return {'success': True, 'sources': rows}
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post('/visuals')
def add_basic_source(req: BasicSourceRequest):
    from ..services import basic_visual_sources as basic
    try:
        project = checked_project(req.brand, req.project_folder)
        if req.source_id:
            return basic.update(req.brand, project, req.source_id, req.enabled, req.removed)
        return basic.register(req.brand, project, req.folder, req.project_path, req.bin_path, req.items)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(400, str(exc)) from exc


class MigrationPreviewRequest(BaseModel):
    brand: str = Field(min_length=1)
    project_folder: Optional[str] = None


class PolicyProbeRequest(MigrationPreviewRequest):
    path: str
    purpose: Literal['raw_dialogue', 'visuals', 'references']
    source_range: Optional[list[float]] = Field(None, min_length=2, max_length=2)


@router.get('/policy')
def policy(brand: str, project_folder: Optional[str] = None):
    try:
        return {'success': True, 'mode': 'preview', 'active': False,
                'policy_revision': source_registry.revision(),
                'sources': source_registry.sources(brand, project_folder)}
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post('/evaluate')
def evaluate(req: PolicyProbeRequest):
    try:
        return {'success': True, 'mode': 'preview', 'active': False,
                'decision': source_registry.resolve(req.brand, req.path, req.purpose,
                                                    req.project_folder, req.source_range)}
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except PolicyConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post('/migration-preview')
async def preview(req: MigrationPreviewRequest):
    try:
        scripts = []
        if req.project_folder:
            project = list_project_scripts(req.project_folder)
            if project['brand'].casefold() != req.brand.casefold():
                raise ValueError('Choose a project belonging to the selected brand.')
            scripts = [row['full_path'] for row in project['scripts']]
        return await asyncio.to_thread(migration_preview, visual_library_service.config_file,
                                       visual_library_service.index_file, req.brand, scripts)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
