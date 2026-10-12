"""EditFlow AI — Captions routes (words → cues → SRT + audio transcription).

Endpoints (all under ``/api/captions``):

  POST /cues                words → grouped cues (standalone or post-cut remap)
  POST /srt                 cues → SRT text + a file under data/output/captions/
  GET  /presets             style presets for the panel's picker
  POST /transcribe-mixdown  uploaded WAV → word-level timestamps
  POST /overlay            cues → animated transparent ProRes .mov
  POST /preview             first seconds of the overlay + preview frames

The SRT this produces is what ``captions_manager.jsx`` imports via
project.importFiles + sequence.createCaptionTrack. Words may come from any
existing source (Scribe exact times, Whisper, Review editor) — transcribe
once, use for cuts and captions.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import subprocess
import uuid
from typing import Any, Optional

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel

from ..services.subtitles.cue_builder import (
    CueOpts,
    build_cues,
    remap_kept_words_to_output,
)
from ..services.subtitles.animated_overlay import OverlayStyle, render_overlay
from ..services.subtitles.presets import load_presets
from ..services.subtitles.srt_export import cues_to_srt
from ..services.subtitles.word_sanitizer import sanitize_words
from ..services.whisper_service import whisper_service
from ..utils.progress import ProgressReporter
from .whisper_admin import is_model_installed

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/captions", tags=["captions"])


class CuesReq(BaseModel):
    words: Optional[list[dict]] = None
    source: Optional[str] = "standalone"        # "standalone" | "final_cut"
    opts: Optional[dict[str, Any]] = None       # CueOpts overrides


@router.post("/cues")
async def cues(req: CuesReq):
    if not req.words:
        raise HTTPException(status_code=400, detail="Pass words.")
    words = req.words

    if (req.source or "standalone") == "final_cut":
        words = remap_kept_words_to_output(words)

    try:
        opts = CueOpts(**(req.opts or {}))
    except TypeError as exc:
        raise HTTPException(status_code=400, detail=f"Bad cue option: {exc}") from exc

    built = build_cues(words, opts)
    return {
        "cues": built,
        "summary": {
            "cues": len(built),
            "words": len(words),
            "duration": round(built[-1]["end"] - built[0]["start"], 2) if built else 0.0,
        },
    }


@router.get("/presets")
async def presets():
    """Style presets for the panel's picker (built-ins; graphic imports later)."""
    return {"presets": load_presets()}


class SrtReq(BaseModel):
    cues: list[dict]
    name: Optional[str] = None


@router.post("/srt")
async def srt(req: SrtReq):
    text = cues_to_srt(req.cues)
    if not text:
        raise HTTPException(status_code=400, detail="No non-empty cues to export.")
    srt_path = ""
    try:
        from ..config import get_settings
        out_dir = get_settings().DATA_DIR / "output" / "captions"
        out_dir.mkdir(parents=True, exist_ok=True)
        stem = (req.name or f"captions-{uuid.uuid4().hex[:8]}").rsplit(".", 1)[0]
        # Keep the file inside out_dir even if name contains separators.
        stem = stem.replace("/", "_").replace("\\", "_")
        path = out_dir / f"{stem}.srt"
        path.write_text(text, encoding="utf-8")
        srt_path = str(path)
    except Exception as exc:  # noqa: BLE001
        logger.warning("captions.srt: file write failed: %s", exc)
    return {"srt": text, "srt_path": srt_path}


def _whisperx_model_size(active_model: str) -> str:
    """Map a full model name (e.g. 'Systran/faster-whisper-large-v3') to the
    plain size string WhisperX loads ('large-v3')."""
    name = active_model or "large-v3"
    if "faster-whisper-" in name:
        name = name.split("faster-whisper-")[-1]
    return name


@router.post("/transcribe-mixdown")
async def transcribe_mixdown(
    file: UploadFile = File(...),
    client_id: Optional[str] = Form(None),
    sequence_name: Optional[str] = Form(None),
    in_seconds: float = Form(0.0),
    out_seconds: float = Form(0.0),
    language: Optional[str] = Form(None),
    force: bool = Form(False),
    engine: str = Form("auto"),
):
    """Receive a WAV (sequence audio export) from the panel, transcribe it.

    Returns word-level timestamps for cue grouping + caption import.
    Returns 409 with body {error: "no_model", ...} if no Whisper model is
    installed — the frontend uses this signal to pop the Whisper download UI.
    """
    from ..config import get_settings

    try:
        # 1. Read the uploaded file bytes and compute a content-addressed hash.
        content = await file.read()
        await file.close()
        file_content_hash = hashlib.sha256(content).hexdigest()[:16]

        # 2. Resolve the active model + compute a deterministic fingerprint
        #    incorporating the file content hash. Different files will never
        #    share a fingerprint or return each other's cached transcripts.
        active_model = whisper_service.get_active_model_name()
        lang_key = (language or "auto").strip().lower()
        seq_key = (
            f"{sequence_name}|{in_seconds}|{out_seconds}"
            if sequence_name
            else (file.filename or "upload").strip()
        )
        fingerprint = hashlib.sha256(
            f"{file_content_hash}|{seq_key}|{active_model}|{lang_key}|{engine}".encode("utf-8")
        ).hexdigest()[:16]

        # 3. Persist the uploaded media under data/media_cache/mixdowns/ with its true extension.
        mixdowns_dir = get_settings().DATA_DIR / "media_cache" / "mixdowns"
        mixdowns_dir.mkdir(parents=True, exist_ok=True)
        ext = (file.filename or "").rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else ""
        file_ext = f".{ext}" if ext else ".wav"
        wav_path = mixdowns_dir / f"{fingerprint}{file_ext}"
        wav_path.write_bytes(content)
        # 2b. If the upload itself is a video, keep one frame as the
        # preview background (AE frame-capture parity, source-side).
        # Never breaks transcription.
        bg_url = None
        try:
            ext = (file.filename or "").rsplit(".", 1)[-1].lower()
            if ext in ("mp4", "mov", "m4v", "mkv", "webm", "avi"):
                from ..utils import ffmpeg_utils
                probe = ffmpeg_utils.probe_media(str(wav_path)) if hasattr(
                    ffmpeg_utils, "probe_media") else None
                dur_v = 2.0
                try:
                    dur_v = float((probe or {}).get("duration", 2.0)) or 2.0
                except (TypeError, ValueError):
                    pass
                frames = await asyncio.to_thread(
                    ffmpeg_utils.extract_frames, str(wav_path),
                    max(2.0, dur_v), None, 1, "540x960", 5,
                ) if hasattr(ffmpeg_utils, "extract_frames") else []
                if frames:
                    import base64 as _b64
                    from ..config import get_settings as _gs
                    _out = _gs().DATA_DIR / "output" / "captions"
                    _out.mkdir(parents=True, exist_ok=True)
                    bg_path = _out / f"{fingerprint}.bg.jpg"
                    bg_path.write_bytes(_b64.b64decode(frames[0]))
                    bg_url = f"/api/captions/file/{bg_path.name}"
        except Exception as exc:  # noqa: BLE001
            logger.debug("caption bg frame skipped: %s", exc)

        # 3. Transcribe (shared with /transcribe-sequence).
        out = await _transcribe_wav(wav_path, fingerprint, language, engine, force, client_id)
        out["bg_url"] = bg_url
        return out

    except HTTPException:
        # Re-raise 409 (and any other deliberate HTTPException) unchanged
        # so the try/except below doesn't mask it as a 500.
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("captions.transcribe_mixdown failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


async def _transcribe_wav(wav_path, fingerprint: str, language: Optional[str], engine: str,
                          force: bool, client_id: Optional[str]) -> dict:
    """Shared transcription core for uploads and sequence mixdowns: cache
    peek → WhisperX (forced alignment) → Whisper fallback → sanitized words."""
    active_model = whisper_service.get_active_model_name()
    # Model-availability short-circuit. 409 (not 422/500) so the frontend
    # can distinguish "install a model first" from a real error.
    if not is_model_installed(active_model):
        raise HTTPException(
            status_code=409,
            detail={
                "error": "no_model",
                "available": [],
                "download_hint": "open_settings_whisper",
            },
        )

    # range_in/range_out=0 → whole file (the caller already trimmed).
    reporter = ProgressReporter(task_type="transcribe", client_id=client_id)
    lang = language if language and language != 'auto' else None

    # Cache peek BEFORE any model load: repeat runs of the same range return
    # instantly instead of re-running WhisperX (which on CPU can take
    # minutes or OOM before the whisper fallback would hit the same cache).
    result = (whisper_service.peek_cached_transcript(fingerprint)
              if not force else None)
    engine_used = None
    if result is not None:
        engine_used = (result.engine or "cached") + "+cache"
        logger.info("captions: transcript cache hit, skipping models")
    # WhisperX forced alignment on a MISS only (~50ms word boundaries). Any
    # failure falls back to the whisper path below and the response
    # `engine` says which ran.
    if result is None and engine in ("auto", "whisperx"):
        try:
            from ..services.transcribe.whisperx_engine import WhisperXEngine
            wx = WhisperXEngine(model_size=_whisperx_model_size(active_model))
            if wx.is_available():
                result = await wx.transcribe(
                    str(wav_path), language=lang, word_timestamps=True,
                )
                engine_used = "whisperx"
        except Exception as wx_exc:  # noqa: BLE001
            logger.warning("whisperx failed, falling back to whisper: %s", wx_exc)
            result = None

    if result is None:
        result = await whisper_service.transcribe_fingerprinted(
            source_path=str(wav_path),
            file_fingerprint=fingerprint,
            language=lang,
            word_timestamps=True,
            vad_filter=True,
            progress=reporter,
            force=force,
            range_in=0.0,
            range_out=0.0,
        )
        engine_used = result.engine

    # Flatten segments → word list. sanitize_words guards against overlaps,
    # zero durations and missing timestamps.
    words_out: list[dict] = []
    for seg in result.segments:
        for w in seg.words:
            words_out.append({
                "word": w.word,
                "start": w.start,
                "end": w.end,
                "confidence": w.probability,
            })
    words_out = sanitize_words(words_out)

    return {
        "words": words_out,
        "fingerprint": fingerprint,
        "duration": result.duration,
        "model": result.model or active_model,
        "engine": engine_used or result.engine,
    }


class SequenceTranscribeReq(BaseModel):
    clips: list[dict]                 # [{path, start, end, in, out}] from captionsManager.sequenceAudioClips
    sequence_name: Optional[str] = None
    duration: Optional[float] = None
    language: Optional[str] = None
    engine: str = "auto"
    force: bool = False
    client_id: Optional[str] = None


@router.post("/transcribe-sequence")
async def transcribe_sequence(req: SequenceTranscribeReq):
    """Transcribe the active sequence's own audio (unmuted tracks, as cut).

    Word times come back in SEQUENCE time, so captions line up with the edit
    with no re-timing — the reliable replacement for remapping source-time
    words after a cut.
    """
    from ..config import get_settings
    from ..services.subtitles.sequence_audio import clean_clips, fingerprint as clips_fp, mix_sequence_audio
    from ..services.subtitles.animated_overlay import _ffmpeg_path

    clips, skipped = clean_clips(req.clips)
    if not clips:
        detail = "No audio to transcribe on unmuted tracks."
        if skipped:
            detail += f" Skipped {len(skipped)} clip(s): {skipped[0]['reason']} ({skipped[0]['path']})."
        raise HTTPException(status_code=400, detail=detail)
    try:
        active_model = whisper_service.get_active_model_name()
        lang_key = (req.language or "auto").strip().lower()
        fp = clips_fp(clips, f"{active_model}|{lang_key}|{req.engine}")
        wav_path = get_settings().DATA_DIR / "media_cache" / "mixdowns" / f"seq-{fp}.wav"
        info = {"duration": req.duration, "clips": len(clips), "overlaps": 0}
        if not wav_path.exists() or req.force:
            info = await asyncio.to_thread(mix_sequence_audio, _ffmpeg_path(), clips, wav_path, req.duration)
        out = await _transcribe_wav(wav_path, f"seq-{fp}", req.language, req.engine, req.force, req.client_id)
        out["mixdown"] = info
        out["skipped"] = skipped
        return out
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("captions.transcribe_sequence failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


# ── Fonts + frame encoder (the WYSIWYG render path) ─────────────────────

@router.get("/fonts")
async def fonts(refresh: bool = False):
    """Fonts installed on this machine, for the caption font picker."""
    from ..services.subtitles.system_fonts import list_system_fonts
    return {"fonts": await asyncio.to_thread(list_system_fonts, refresh)}


class EncodeStartReq(BaseModel):
    width: int
    height: int
    band_y: int = 0
    band_h: Optional[int] = None
    fps_num: int = 30
    fps_den: int = 1
    name: Optional[str] = None
    codec: str = "prores"


@router.post("/encode/start")
async def encode_start(req: EncodeStartReq):
    """Open a render job; the panel then streams frames to /encode/{id}/frames."""
    import time as _time
    import uuid as _uuid

    from ..config import get_settings
    from ..services.subtitles import encoder
    from ..services.subtitles.animated_overlay import _ffmpeg_path

    stem = "".join(ch if ch.isalnum() or ch in " -_" else "_" for ch in (req.name or "Captions")).strip()[:60]
    out = (get_settings().DATA_DIR / "output" / "captions" /
           f"EditFlow Captions - {stem or 'Captions'} - {_time.strftime('%Y%m%d-%H%M%S')}-{_uuid.uuid4().hex[:6]}.mov")
    try:
        job = await asyncio.to_thread(
            encoder.start, _ffmpeg_path(), out, req.width, req.height, req.band_y,
            req.band_h if req.band_h is not None else req.height, req.fps_num, req.fps_den, req.codec)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"job_id": job.id, "path": str(job.path), "frame_bytes": job.frame_bytes}


def _job(job_id: str):
    from ..services.subtitles import encoder
    try:
        return encoder.get(job_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Render job not found (cancelled or finished).")


@router.post("/encode/{job_id}/frames")
async def encode_frames(job_id: str, request: Request):
    """A batch of frame records (see services/subtitles/encoder.py)."""
    from ..services.subtitles import encoder
    job = _job(job_id)
    body = await request.body()
    try:
        frames = await asyncio.to_thread(encoder.feed, job, body)
    except (ValueError, RuntimeError) as exc:
        encoder.cancel(job_id)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"frames": frames}


@router.post("/encode/{job_id}/finish")
async def encode_finish(job_id: str):
    from ..services.subtitles import encoder
    job = _job(job_id)
    try:
        return await asyncio.to_thread(encoder.finish, job)
    except Exception as exc:  # noqa: BLE001
        encoder.cancel(job_id)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/encode/{job_id}/cancel")
async def encode_cancel(job_id: str):
    from ..services.subtitles import encoder
    return {"cancelled": await asyncio.to_thread(encoder.cancel, job_id)}


class CorrectReq(BaseModel):
    words: list[dict]
    language: str = "ur"
    vocab: str = ""
    context: str = ""
    model: Optional[str] = None       # None = the panel's active chat model


@router.post("/correct")
async def correct_transcript(req: CorrectReq):
    """AI pass over a transcript: fix mishearings, keep every timestamp.

    The model may only return indexed 1:1 word replacements, so the word
    count — and therefore the timing of every later word — cannot change.
    Anything malformed is dropped rather than applied.
    """
    from ..services.provider_service import provider_service
    from ..services.subtitles.transcript_corrector import (
        apply_corrections, build_prompt, chunk_words, parse_corrections,
    )

    words = req.words or []
    if not words:
        raise HTTPException(status_code=400, detail="No words to correct.")

    all_corrections: list[dict] = []
    failures: list[str] = []
    for offset, chunk in chunk_words(words, 220):
        prompt = build_prompt(chunk, language=req.language, vocab=req.vocab,
                              context=req.context)
        try:
            resp = await provider_service.chat(
                messages=[{"role": "user", "content": prompt}],
                model=req.model,
                temperature=0,          # corrections are not a creative task
                max_tokens=2048,
            )
        except Exception as exc:  # noqa: BLE001 — one bad chunk must not lose the rest
            failures.append(f"words {offset}-{offset + len(chunk)}: {exc}")
            continue
        if resp.get("error"):
            failures.append(f"words {offset}-{offset + len(chunk)}: {resp['error']}")
            continue
        for c in parse_corrections(resp.get("response", ""), len(chunk)):
            all_corrections.append({"i": c["i"] + offset, "to": c["to"]})

    result = apply_corrections(words, all_corrections, vocab=req.vocab)
    if result["rejected"]:
        # a model that mostly gets refused is the wrong model for this job —
        # say so in the log so the failure isn't silent
        logger.warning("captions.correct: rejected %d implausible correction(s), "
                       "applied %d — e.g. %s",
                       len(result["rejected"]), result["applied"],
                       result["rejected"][:3])
    try:
        active_model = (provider_service.get_active_chat() or {}).get("model")
    except Exception:  # noqa: BLE001
        active_model = None
    return {
        "words": result["words"],
        "applied": result["applied"],
        "changes": result["changes"],
        "rejected": result["rejected"],
        "failures": failures,
        "model": active_model if not req.model else req.model,
    }


class OverlayReq(BaseModel):
    cues: list[dict]
    name: Optional[str] = None
    width: int = 1080
    height: int = 1920
    fps: int = 30
    font_size: int = 96
    all_caps: bool = False
    rise_ms: int = 280
    preset: str = "slide_up"
    pos_y_ratio: float = 0.78
    pos_x_ratio: float = 0.5
    box_width_ratio: float = 0.9
    pill_color: str = "#0a1a2e"
    pill_opacity: float = 0.85
    pill_outline: bool = True
    animate_preset: str = "fadeup_words"
    easing: str = "expo_out"
    intensity: float = 1.0
    slide_px: int = 60
    font_family: str = "Arial"
    font_bold: bool = True
    text_color: str = "#ffffff"
    stroke_color: str = "#000000"
    stroke_width: int = 0
    shadow_enabled: bool = True
    shadow_color: str = "#000000"
    shadow_opacity: float = 0.6
    shadow_distance: int = 4
    shadow_blur: int = 5
    pill_stroke_color: str = "#5c8cf0"
    pill_stroke_width: int = 2
    pill_radius: float = 0.5


def _build_style(req) -> "OverlayStyle":
    """Shared style builder for /overlay and /preview (one mapping)."""
    from ..services.subtitles.animated_overlay import ANIM_MOTION, OverlayStyle
    anim = dict(ANIM_MOTION.get(req.animate_preset or "fadeup_words",
                                ANIM_MOTION["fadeup_words"]))
    style_kw: dict = dict(
        width=max(320, min(req.width, 3840)),
        height=max(320, min(req.height, 3840)),
        fps=30 if req.fps not in (24, 25, 30, 50, 60) else req.fps,
        font_size=max(24, min(req.font_size, 400)),
        all_caps=req.all_caps,
        pos_y_ratio=max(0.1, min(req.pos_y_ratio, 0.95)),
        pos_x_ratio=max(0.0, min(req.pos_x_ratio, 1.0)),
        box_width_ratio=max(0.3, min(req.box_width_ratio, 1.0)),
        pill_color=req.pill_color or "#0a1a2e",
        pill_opacity=max(0.0, min(req.pill_opacity, 1.0)),
        pill_outline=bool(req.pill_outline),
        pill_stroke_color=req.pill_stroke_color or "#5c8cf0",
        pill_stroke_width=max(0, min(req.pill_stroke_width, 10)),
        pill_radius=max(0.0, min(req.pill_radius, 1.0)),
        easing=req.easing or "expo_out",
        intensity=max(0.1, min(req.intensity or 1.0, 3.0)),
        slide_px=max(0, min(req.slide_px if req.slide_px is not None else 60, 400)),
        font_family=req.font_family or "Arial",
        font_bold=bool(req.font_bold),
        text_color=req.text_color or "#ffffff",
        stroke_color=req.stroke_color or "#000000",
        stroke_width=max(0, min(req.stroke_width, 10)),
        shadow_enabled=bool(req.shadow_enabled),
        shadow_color=req.shadow_color or "#000000",
        shadow_opacity=max(0.0, min(req.shadow_opacity, 1.0)),
        shadow_distance=max(0, min(req.shadow_distance, 50)),
        shadow_blur=max(0, min(req.shadow_blur, 50)),
        caption_level=bool(anim.get("caption_level", False)),
        motion=anim.get("motion", "rise"),
    )
    # The preset owns its rise time (pop/squash snap); an explicit rise_ms
    # applies only when the preset doesn't define one — passing both to
    # OverlayStyle raises "multiple values" (seen live).
    if "rise_ms" in anim:
        style_kw["rise_ms"] = anim["rise_ms"]
    elif req.rise_ms:
        style_kw["rise_ms"] = max(50, min(req.rise_ms, 2000))
    return OverlayStyle(**style_kw)


@router.post("/overlay")
async def overlay(req: OverlayReq):
    """Render cues as an animated transparent overlay .mov (fade-up words).

    Each word rises + fades in at its timestamp (the AE fadeup_words look),
    encoded ProRes 4444 with alpha. The panel drops the .mov on V2 via the
    existing import + insertClip ops. Renders take minutes for long reels
    (CPU pixel loop); the file lands under data/output/captions/.
    """
    from ..config import get_settings

    words = sum(len(c.get("words") or []) for c in req.cues)
    if not words:
        raise HTTPException(status_code=400, detail="No words to render.")
    try:
        style = _build_style(req)
        duration = max(
            float(w.get("end", 0) or 0)
            for c in req.cues for w in (c.get("words") or [])
        )
        out_dir = get_settings().DATA_DIR / "output" / "captions"
        out_dir.mkdir(parents=True, exist_ok=True)
        stem = (req.name or f"overlay-{uuid.uuid4().hex[:8]}").rsplit(".", 1)[0]
        stem = stem.replace("/", "_").replace("\\", "_")
        # Unique file per render: repeat clicks (or a still-running render)
        # must never share an output path — on Windows the second ffmpeg
        # dies with "Error opening output file" on the locked file.
        stem = f"{stem}-{uuid.uuid4().hex[:8]}"
        mov_path = await render_overlay(req.cues, duration, style, out_dir / f"{stem}.mov")
        return {
            "mov_path": str(mov_path),
            "duration": round(duration, 2),
            "cues": len(req.cues),
            "words": words,
            "width": style.width,
            "height": style.height,
        }
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("captions.overlay failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


class PreviewReq(OverlayReq):
    seconds: float = 6.0


@router.post("/preview")
async def preview(req: PreviewReq):
    """Render the first ``seconds`` of the overlay + return preview frames.

    The AE panel's canvas preview, Premiere-flavored: real rendered pixels
    (same code path as the final .mov), shown as a thumbnail strip so style
    mistakes are visible BEFORE a multi-minute full render.
    """
    import base64
    from ..config import get_settings
    from ..services.subtitles.animated_overlay import _ffmpeg_path, render_overlay

    words = sum(len(c.get("words") or []) for c in req.cues)
    if not words:
        raise HTTPException(status_code=400, detail="No words to render.")
    try:
        style = _build_style(req)
        span = max(1.0, min(float(req.seconds or 6.0), 12.0))
        head = [c for c in req.cues
                if min(float(w.get("start", 0) or 0) for w in (c.get("words") or [{}])) < span]
        if not head:
            raise HTTPException(status_code=400, detail="No cues in the preview span.")
        out_dir = get_settings().DATA_DIR / "output" / "captions"
        out_dir.mkdir(parents=True, exist_ok=True)
        mov = out_dir / f"preview-{uuid.uuid4().hex[:8]}.mov"
        await render_overlay(head, span, style, mov)
        # Playable preview: composite the transparent overlay over dark
        # gray → h264 MP4 the panel <video> can actually play (browsers
        # don't alpha-composite ProRes). Same pixels, same timing.
        mp4 = mov.with_suffix(".mp4")
        proc = await asyncio.to_thread(
            subprocess.run,
            [_ffmpeg_path(), "-hide_banner", "-y",
             "-f", "lavfi",
             "-i", (f"color=c=0x1a1a1a:s={style.width}x{style.height}"
                    f":r={style.fps}:d={span}"),
             "-i", str(mov),
             "-filter_complex",
             "[0:v][1:v]overlay=0:0,format=yuv420p",
             "-c:v", "libx264", "-crf", "20", "-preset", "veryfast",
             "-pix_fmt", "yuv420p", "-movflags", "+faststart",
             "-r", str(style.fps), str(mp4)],
            capture_output=True, text=False, timeout=300,
        )
        mp4_url = None
        if proc.returncode == 0 and mp4.exists():
            mp4_url = f"/api/captions/file/{mp4.name}"
        times = sorted({round(span * f, 2) for f in (0.15, 0.5, 0.85)})
        frames = []
        for t in times:
            png = mov.with_name(f"{mov.stem}-f{int(t * 10)}.png")
            proc = await asyncio.to_thread(
                subprocess.run,
                [_ffmpeg_path(), "-hide_banner", "-y",
                 "-ss", str(t), "-i", str(mov),
                 "-frames:v", "1", "-update", "1", str(png)],
                capture_output=True, text=False, timeout=120,
            )
            if proc.returncode != 0 or not png.exists():
                continue
            frames.append({
                "t": t,
                "png": "data:image/png;base64," + base64.b64encode(
                    png.read_bytes()).decode("ascii"),
            })
            try:
                png.unlink()
            except OSError:
                pass
        return {"mov_path": str(mov), "seconds": span, "frames": frames,
                "preview_mp4": mp4_url,
                "width": style.width, "height": style.height}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("captions.preview failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/file/{name}")
async def caption_file(name: str):
    """Serve a rendered caption artifact (preview mp4/mov, SRT).

    Path-guarded to data/output/captions/ — names only, no separators.
    """
    from fastapi.responses import FileResponse

    from ..config import get_settings
    if not name or "/" in name or "\\" in name or ".." in name:
        raise HTTPException(status_code=400, detail="Bad file name.")
    if not name.endswith((".mp4", ".mov", ".srt", ".ass", ".jpg", ".png")):
        raise HTTPException(status_code=400, detail="Unsupported file type.")
    path = get_settings().DATA_DIR / "output" / "captions" / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Not found.")
    return FileResponse(path)
