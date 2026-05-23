"""
Route: POST /api/v2/scripts/extract

Accepts a multipart file upload (.pdf, .docx, .txt, .md),
extracts raw text, and returns it for the frontend to process.
This is the ONLY new endpoint added during the single-chat rewrite.
"""
from __future__ import annotations

import logging
from pathlib import Path
from tempfile import NamedTemporaryFile

from fastapi import APIRouter, File, HTTPException, UploadFile

from ..services.script_extractor_service import script_extractor_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/scripts", tags=["scripts"])


@router.post("/extract")
async def extract_script(file: UploadFile = File(...)):
    """Extract text from an uploaded document.

    Accepts PDF, DOCX, TXT, and MD files.
    Returns {success, filename, full_text, pages, page_count}.
    """
    filename = file.filename or ""
    suffix = Path(filename).suffix.lower()

    if suffix not in {".pdf", ".docx", ".txt", ".md"}:
        raise HTTPException(400, f"Unsupported file type: {suffix}. Supported: .pdf, .docx, .txt, .md")

    tmp_path = None
    try:
        # Write upload to a temp file
        content = await file.read()
        with NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(content)
            tmp_path = Path(tmp.name)

        # Extract text
        result = script_extractor_service.extract(tmp_path)
        return {
            "success": True,
            "filename": filename,
            **result,
        }
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        logger.error(f"Script extraction failed for {filename}: {e}")
        raise HTTPException(500, f"Extraction failed: {e}")
    finally:
        # Clean up temp file
        if tmp_path and tmp_path.exists():
            try:
                tmp_path.unlink()
            except Exception:
                pass
