"""
EditFlow AI - Pipeline API Routes
Video analysis, script-based cutting, and visual placement endpoints.
"""
import logging
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, HTTPException, UploadFile

from ..config import get_settings
from ..models.schemas import (
    CuttingResult, ScriptMatchRequest,
    VideoAnalysisRequest, VisualMapRequest, VisualPlacementResult,
)
from ..services.cutting_pipeline import cutting_pipeline
from ..utils.path_safety import safe_dir_path, safe_output_path
from ..utils.progress import ProgressReporter

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/pipeline", tags=["pipeline"])


@router.post("/analyze")
async def analyze_videos(
    request: VideoAnalysisRequest,
    client_id: Optional[str] = None,
):
    """Analyze all videos in a folder: transcribe, detect fillers/pauses, create speech candidates.

    This is the first step in the pipeline. Point it at a folder of video files
    (e.g., your raw Urdu recordings) and it will transcribe everything and
    identify the best takes.
    """
    folder = safe_dir_path(request.folder_path, label="folder_path")

    progress = ProgressReporter(task_type="analyze", client_id=client_id)
    try:
        results = await cutting_pipeline.analyze_videos(
            folder_path=str(folder),
            language=request.language,
            recursive=request.recursive,
            progress=progress,
        )
        return {
            "success": True,
            "total": len(results),
            "results": results,
        }
    except Exception as e:
        logger.error(f"Video analysis error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/cut", response_model=CuttingResult)
async def match_and_cut_video(
    request: ScriptMatchRequest,
    client_id: Optional[str] = None,
):
    """Match an English script against Urdu video transcripts and produce a clean cut.

    Given videos that have been analyzed (via /pipeline/analyze) and an English script,
    this endpoint:
    1. Parses the script into lines
    2. Cross-lingually matches each English script line to Urdu speech segments
    3. Selects the best takes (highest delivery score, fewest fillers/pauses)
    4. Returns a cutting plan with matched segments

    The video is in Urdu, the script is in English. The AI understands both
    languages and matches by semantic meaning.
    """
    if not request.script_content.strip():
        raise HTTPException(status_code=400, detail="Script content cannot be empty")

    progress = ProgressReporter(task_type="cutting", client_id=client_id)
    try:
        result = await cutting_pipeline.match_and_cut(request, progress)
        return result
    except Exception as e:
        logger.error(f"Cutting error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/cut/execute")
async def execute_cut(
    cuts_json: str,
    output_path: str,
    client_id: Optional[str] = None,
):
    """Execute a cutting plan using FFmpeg to produce the final clean video.

    Takes the cuts from a /pipeline/cut response and produces the actual video file.
    """
    import json
    from ..models.schemas import CutSegment

    try:
        cuts_data = json.loads(cuts_json)
        cuts = [CutSegment(**c) for c in cuts_data]
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid cuts JSON: {e}")

    if not cuts:
        raise HTTPException(status_code=400, detail="No cuts provided")

    resolved_output = safe_output_path(output_path, get_settings().OUTPUT_DIR)

    progress = ProgressReporter(task_type="execute_cut", client_id=client_id)
    try:
        result_path = await cutting_pipeline.execute_cut(cuts, str(resolved_output), progress)
        return {"success": True, "output_path": result_path}
    except Exception as e:
        logger.error(f"Cut execution error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/visuals", response_model=VisualPlacementResult)
async def place_visuals(
    request: VisualMapRequest,
    client_id: Optional[str] = None,
):
    """Place visuals on a cut video based on a mapping document.

    Given a mapping document (from docx/txt) that specifies which script line
    should have which visual, along with a folder of visual assets, this endpoint
    places those visuals at the correct positions in the cut video.

    The mapping document format can be:
    - Pipe-delimited: 1|image.png|overlay
    - Line format: Line 1: image.png (overlay)
    - Dash format: 1 - image.png (full_frame)
    """
    progress = ProgressReporter(task_type="visuals", client_id=client_id)
    try:
        result = await cutting_pipeline.place_visuals(request, progress)
        return result
    except Exception as e:
        logger.error(f"Visual placement error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/visuals/upload-map")
async def upload_visual_map(
    visual_folder: str,
    video_output_path: str,
    script_id: str = "",
    file: UploadFile = File(...),
    client_id: Optional[str] = None,
):
    """Upload a docx/txt file as the visual mapping document.

    Accepts a file upload (docx, txt, or pdf) that contains the visual mapping.
    The document should specify which script line number gets which visual file
    from the visual_folder.
    """
    # Read the uploaded file content
    content_bytes = await file.read()
    filename = file.filename or "unknown"

    # Parse based on file type
    content = ""
    if filename.endswith(".docx"):
        try:
            import docx
            import io
            doc = docx.Document(io.BytesIO(content_bytes))
            content = "\n".join(para.text for para in doc.paragraphs if para.text.strip())
        except ImportError:
            # Fallback: try to read as plain text
            try:
                content = content_bytes.decode("utf-8")
            except UnicodeDecodeError:
                raise HTTPException(status_code=400, detail="Cannot parse docx file. Install python-docx.")
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to parse docx: {e}")
    elif filename.endswith(".pdf"):
        try:
            import io
            # Try pdfplumber
            try:
                import pdfplumber
                with pdfplumber.open(io.BytesIO(content_bytes)) as pdf:
                    content = "\n".join(page.extract_text() or "" for page in pdf.pages)
            except ImportError:
                # Fallback: try PyPDF2
                try:
                    from PyPDF2 import PdfReader
                    reader = PdfReader(io.BytesIO(content_bytes))
                    content = "\n".join(page.extract_text() or "" for page in reader.pages)
                except ImportError:
                    raise HTTPException(status_code=400, detail="Cannot parse PDF. Install pdfplumber or PyPDF2.")
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to parse PDF: {e}")
    else:
        # Plain text
        try:
            content = content_bytes.decode("utf-8")
        except UnicodeDecodeError:
            try:
                content = content_bytes.decode("latin-1")
            except Exception:
                raise HTTPException(status_code=400, detail="Cannot decode file content")

    if not content.strip():
        raise HTTPException(status_code=400, detail="No content found in the uploaded file")

    request = VisualMapRequest(
        script_id=script_id,
        video_output_path=video_output_path,
        visual_folder=visual_folder,
        document_content=content,
    )

    progress = ProgressReporter(task_type="visuals_upload", client_id=client_id)
    try:
        result = await cutting_pipeline.place_visuals(request, progress)
        return result
    except Exception as e:
        logger.error(f"Visual placement error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/status")
async def pipeline_status():
    """Get the current status of the cutting pipeline - analyzed videos, scripts, etc."""
    from ..models.sqlite_registry import sqlite_registry

    try:
        assets = sqlite_registry.fetch_all(
            "SELECT COUNT(*) as count, status FROM assets GROUP BY status"
        )
        transcripts = sqlite_registry.fetch_all(
            "SELECT COUNT(*) as count FROM transcripts"
        )
        candidates = sqlite_registry.fetch_all(
            "SELECT COUNT(*) as count FROM speech_candidates"
        )
        scripts = sqlite_registry.fetch_all(
            "SELECT id, title, created_at FROM scripts ORDER BY created_at DESC LIMIT 5"
        )
        cutting_results = sqlite_registry.fetch_all(
            "SELECT id, status, matched_segments, total_segments, created_at FROM cutting_results ORDER BY created_at DESC LIMIT 5"
        )

        return {
            "assets": {a.get("status", "unknown"): a.get("count", 0) for a in assets},
            "transcripts_count": transcripts[0].get("count", 0) if transcripts else 0,
            "speech_candidates_count": candidates[0].get("count", 0) if candidates else 0,
            "recent_scripts": scripts,
            "recent_cuts": cutting_results,
        }
    except Exception as e:
        return {"error": str(e)}
