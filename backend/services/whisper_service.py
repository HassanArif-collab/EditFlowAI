"""
EditFlow AI - Whisper Transcription Service
Local transcription using faster-whisper with VAD and word timestamps.

Phase B enhancement: transcribe-once-per-source-file.  Before running
Whisper, the service checks the audio cache (keyed by file fingerprint)
for an existing transcript.  If found, the cached result is returned
immediately, avoiding the expensive re-transcription of the same file.

v2 enhancements:
  - Engine selection cascade (whisperx > stable-ts > faster-whisper)
  - DB persistence via sqlite_registry (source_transcripts + transcript_words)
  - audio_offset correction for range-based extractions
  - Real silero-vad integration (best-effort, never blocks transcription)
  - model_revision population from model metadata
"""
import asyncio
import hashlib
import json
import logging
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ..config import Settings, get_settings
from ..models.schemas import TranscriptResult, TranscriptSegment, TranscriptWord, VADSegment
from ..services.media_fingerprint import compute_file_fingerprint
from ..utils.ffmpeg_utils import extract_audio
from ..utils.progress import ProgressReporter, manager as _ws_manager

logger = logging.getLogger(__name__)


def _setup_windows_cuda_dll_paths() -> None:
    """Ensure Windows can locate NVIDIA CUDA/cuBLAS/cuDNN DLLs installed via pip."""
    if os.name != "nt":
        return
    import sys
    try:
        for p in sys.path:
            if "site-packages" in p:
                nvidia_dir = Path(p) / "nvidia"
                if nvidia_dir.is_dir():
                    for sub in nvidia_dir.iterdir():
                        for bin_name in ("bin", "lib"):
                            bin_dir = sub / bin_name
                            if bin_dir.is_dir():
                                bin_str = str(bin_dir)
                                if bin_str not in os.environ.get("PATH", ""):
                                    os.environ["PATH"] = bin_str + os.pathsep + os.environ.get("PATH", "")
                                try:
                                    os.add_dll_directory(bin_str)
                                except Exception:
                                    pass
    except Exception as e:
        logger.debug(f"_setup_windows_cuda_dll_paths error: {e}")


_setup_windows_cuda_dll_paths()


def _set_process_priority_below_normal() -> bool:
    """Lower process priority on Windows during CPU-heavy transcription so Premiere Pro and the OS stay 100% fluid."""
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes
            k32 = ctypes.windll.kernel32
            k32.GetCurrentProcess.restype = wintypes.HANDLE
            k32.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            k32.SetPriorityClass.restype = wintypes.BOOL
            # BELOW_NORMAL_PRIORITY_CLASS = 0x00004000
            return bool(k32.SetPriorityClass(k32.GetCurrentProcess(), 0x00004000))
        except Exception:
            return False
    return False


def _restore_process_priority_normal() -> None:
    """Restore normal process priority."""
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes
            k32 = ctypes.windll.kernel32
            k32.GetCurrentProcess.restype = wintypes.HANDLE
            k32.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            k32.SetPriorityClass.restype = wintypes.BOOL
            # NORMAL_PRIORITY_CLASS = 0x00000020
            k32.SetPriorityClass(k32.GetCurrentProcess(), 0x00000020)
        except Exception:
            pass


def _audio_cache_key(video_path: Path) -> str:
    """Hash the full resolved path so videos with the same filename in
    different folders never share a cache entry."""
    try:
        full = str(video_path.resolve()).encode("utf-8")
    except OSError:
        full = str(video_path).encode("utf-8")
    return hashlib.sha1(full).hexdigest()[:16]


def _consume_segments(
    segments_iter,
    word_timestamps: bool,
    progress_state: Optional[Dict[str, Any]] = None,
    throttle_cpu: bool = False,
) -> Tuple[List[TranscriptSegment], List[str]]:
    """Drain the faster-whisper segment generator. CPU-bound; call via to_thread.

    If ``progress_state`` is provided it is mutated in place after every segment
    so an async ticker can publish progress updates. The dict-write is safe
    under the GIL — no extra locking needed.
    """
    if throttle_cpu:
        _set_process_priority_below_normal()
    try:
        result_segments: List[TranscriptSegment] = []
        full_text_parts: List[str] = []

        for segment in segments_iter:
            words: List[TranscriptWord] = []
            if word_timestamps and segment.words:
                for w in segment.words:
                    words.append(TranscriptWord(
                        word=w.word.strip(),
                        start=round(w.start, 3),
                        end=round(w.end, 3),
                        probability=round(w.probability, 3),
                    ))

            result_segments.append(TranscriptSegment(
                start=round(segment.start, 3),
                end=round(segment.end, 3),
                text=segment.text.strip(),
                words=words,
                no_speech_prob=getattr(segment, 'no_speech_prob', 0.0) or 0.0,
                compression_ratio=getattr(segment, 'compression_ratio', 1.0) or 1.0,
                avg_logprob=getattr(segment, 'avg_logprob', 0.0) or 0.0,
            ))
            full_text_parts.append(segment.text.strip())

            if progress_state is not None:
                progress_state["count"] = len(result_segments)
                progress_state["last_end"] = float(segment.end)

        return result_segments, full_text_parts
    finally:
        if throttle_cpu:
            _restore_process_priority_normal()


class WhisperService:
    """Local Whisper transcription service using faster-whisper.

    Supports transcribe-once-per-source-file: each unique source file
    (identified by content fingerprint) is only transcribed once.  The
    result is cached on disk and in the SQLite registry, and returned on
    subsequent calls.

    Engine selection cascade:
        whisperx (best, ~50ms) > stable-ts (~100ms) > faster-whisper (~200-300ms)
    """

    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()
        self._model = None
        self._model_info: Dict = {}
        self._detected_gpu: Optional[str] = None
        self._last_used: float = 0.0
        self._idle_watchdog_task: Optional[asyncio.Task] = None
        self._main_loop: Optional[Any] = None
        self._transcript_cache: Dict[str, TranscriptResult] = {}  # file_fp -> result (in-memory)

        # Serializes concurrent _load_model() calls.  Without this, every
        # parallel transcribe_clips request triggered its own 770 MB HF
        # download — none of them finished because they competed for
        # bandwidth.  With the lock, the first caller does the download;
        # everyone else waits, then finds self._model already set and returns.
        self._model_load_lock: Optional[Any] = None
        self._model_load_lock_loop: Optional[Any] = None
        self._active_transcriptions: int = 0

        # Engine selection cascade — resolved lazily on first use
        self._engine_name: Optional[str] = None
        self._engine_module: Optional[Any] = None
        self._engine_boundary_window_ms: int = 500  # default for faster-whisper

        # Model revision — populated after model load
        self._model_revision: str = ""

        # Runtime model override — set via set_active_model() (POST /api/whisper/set-model).
        # Persisted to data/whisper_config.json so the choice survives restart.
        self._active_model_name: Optional[str] = None
        self._load_active_model_from_disk()

    # ── Runtime model switching ──

    def _whisper_config_path(self) -> Path:
        return Path(self.settings.DATA_DIR) / "whisper_config.json"

    def _load_active_model_from_disk(self) -> None:
        """Load the user's preferred Whisper model and compute device from disk."""
        self._device_preference: str = "auto"
        path = self._whisper_config_path()
        if not path.exists():
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            name = data.get("active_model")
            if isinstance(name, str) and name:
                self._active_model_name = name
                logger.info(f"Whisper active model loaded from disk: {name}")
            dev_pref = data.get("device_preference")
            if isinstance(dev_pref, str) and dev_pref in ("auto", "cpu", "cuda"):
                self._device_preference = dev_pref
        except Exception as e:
            logger.warning(f"Failed to load whisper_config.json: {e}")

    def _save_active_model_to_disk(self) -> None:
        """Persist the current active-model choice and device preference to disk."""
        path = self._whisper_config_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                json.dumps({
                    "active_model": self._active_model_name or "",
                    "device_preference": getattr(self, "_device_preference", "auto") or "auto",
                }, indent=2),
                encoding="utf-8",
            )
        except Exception as e:
            logger.warning(f"Failed to save whisper_config.json: {e}")

    def get_device_preference(self) -> str:
        return getattr(self, "_device_preference", "auto") or "auto"

    def set_device_preference(self, pref: str) -> None:
        pref = (pref or "auto").strip().lower()
        if pref not in ("auto", "cpu", "cuda"):
            pref = "auto"
        self._device_preference = pref
        self._save_active_model_to_disk()
        if self._model is not None:
            self.unload_model()

    def get_active_model_name(self) -> str:
        """The Whisper model that will actually be used for transcription.

        Falls back to settings.WHISPER_MODEL if no runtime override is set.
        """
        return self._active_model_name or self.settings.WHISPER_MODEL

    def set_active_model(self, name: str) -> Dict[str, Any]:
        """Switch the active Whisper model at runtime.

        Unloads the current model so the next transcribe call loads the new one.
        faster-whisper auto-downloads from HuggingFace on first use, so the
        first transcribe after switching may include a one-time download
        (~150 MB for `base`, ~1.5 GB for `medium`, ~1.6 GB for `large-v3-turbo`).

        Persists the choice so it survives restart.
        """
        name = (name or "").strip()
        allowed = {"tiny", "base", "small", "medium", "large-v3-turbo", "large-v3"}
        if name not in allowed:
            raise ValueError(f"Unsupported Whisper model: {name!r}. Allowed: {sorted(allowed)}")

        previous = self.get_active_model_name()
        self._active_model_name = name
        self._save_active_model_to_disk()

        # If the user re-selected the SAME model that's already loaded in
        # memory, don't discard it. Doing so would force a redundant re-load
        # (and re-download check) on the next transcribe — wasting 5-30
        # seconds and producing confusing 'Loading Whisper model' log spam
        # like we saw in the user's last run: medium -> tiny -> tiny -> medium
        # all reloaded back-to-back because each click triggered a discard.
        already_loaded = (
            self._model is not None
            and self._model_info.get("model") == name
        )
        if not already_loaded:
            self._model = None
            self._model_revision = ""
            self._model_info = {}
            logger.info(f"Whisper active model: {previous} -> {name} (will load on next transcribe)")
        else:
            logger.info(f"Whisper active model: {previous} -> {name} (already loaded, reusing)")

        return {"previous": previous, "active": name, "persisted": True}

    # ── Engine Selection Cascade ──

    @staticmethod
    def _select_engine() -> Tuple[str, Any, int]:
        """Select the best available transcription engine.

        Priority: whisperx > stable-ts > faster-whisper.

        Returns:
            Tuple of (engine_name, engine_module, boundary_window_ms).

        Raises:
            RuntimeError: If no engine's dependencies are importable.
        """
        # Try the transcribe package's select_engine first — it returns
        # a TranscribeEngine instance with name + boundary_window_ms.
        try:
            from .transcribe import select_engine
            engine = select_engine()
            # Import the corresponding module for reference
            module = None
            if engine.name == "whisperx":
                try:
                    import whisperx
                    module = whisperx
                except ImportError:
                    pass
            elif engine.name == "stable_ts":
                try:
                    import stable_ts
                    module = stable_ts
                except ImportError:
                    pass
            elif engine.name == "faster_whisper":
                try:
                    import faster_whisper
                    module = faster_whisper
                except ImportError:
                    pass
            return engine.name, module, engine.boundary_window_ms
        except Exception:
            pass

        # Manual cascade if the transcribe package is unavailable
        # 1. Try whisperx
        try:
            import whisperx
            return "whisperx", whisperx, 200
        except ImportError:
            pass

        # 2. Try stable-ts
        try:
            import stable_ts
            return "stable_ts", stable_ts, 350
        except ImportError:
            pass

        # 3. Fall back to faster-whisper
        try:
            import faster_whisper
            return "faster_whisper", faster_whisper, 500
        except ImportError:
            raise RuntimeError("No transcription engine available (need whisperx, stable-ts, or faster-whisper)")

    def _resolve_engine(self) -> Tuple[str, Any, int]:
        """Resolve the engine selection once and cache the result."""
        if self._engine_name is None:
            self._engine_name, self._engine_module, self._engine_boundary_window_ms = self._select_engine()
            logger.info(
                f"Selected transcription engine: {self._engine_name} "
                f"(boundary_window_ms={self._engine_boundary_window_ms})"
            )
        return self._engine_name, self._engine_module, self._engine_boundary_window_ms

    # ── Model Loading ──

    # Expected on-disk sizes (MB) for each Whisper variant, used for download
    # progress percentage. Kept in sync with the panel's _MODEL_CATALOG in
    # whisper_admin.py — these are CT2-converted faster-whisper sizes,
    # NOT the original OpenAI PT sizes which were smaller.
    _EXPECTED_SIZE_MB = {
        "tiny": 75, "base": 145, "small": 466,
        "medium": 1500, "large-v3-turbo": 1600, "large-v3": 3100,
    }

    # Minimum FREE VRAM (in MiB) required before loading a model on CUDA.
    # Includes safety headroom so Premiere Pro's DirectX swapchain and
    # Mercury Playback Engine never hit WDDM PCIe memory paging or TDR 0x141 resets.
    _MIN_FREE_VRAM_MB = {
        "tiny": 900,
        "base": 1100,
        "small": 1500,
        "medium": 2500,
        "large-v3-turbo": 2400,
        "large-v3": 4200,
    }

    @staticmethod
    def _query_gpu_vram_mb() -> Tuple[int, int]:
        """Return (free_vram_mb, total_vram_mb) for GPU 0, or (0, 0) if unavailable."""
        try:
            import torch
            if torch.cuda.is_available():
                free_b, total_b = torch.cuda.mem_get_info(0)
                return int(free_b // (1024 * 1024)), int(total_b // (1024 * 1024))
        except Exception:
            pass
        try:
            import subprocess
            p = subprocess.run(
                ["nvidia-smi", "--query-gpu=memory.free,memory.total", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=2,
            )
            if p.returncode == 0 and p.stdout.strip():
                line = p.stdout.strip().splitlines()[0]
                parts = [int(x.strip()) for x in line.split(",")]
                if len(parts) >= 2:
                    return parts[0], parts[1]
        except Exception:
            pass
        return 0, 0

    @staticmethod
    def _largest_incomplete_blob_mb(cache_dir: Path, model_name: str) -> float:
        """Return the size of the largest .incomplete blob for `model_name`.

        HuggingFace's chunked downloader writes partial files as
        `blobs/<sha>.incomplete` while a download is in progress; renamed to
        the final hash on completion. Polling this size is the simplest way
        to track real download progress without monkey-patching hf_hub.
        """
        if not cache_dir.exists():
            return 0.0
        # Match by the model name fragment (e.g. 'faster-whisper-medium').
        fragment = f"faster-whisper-{model_name}".lower()
        largest = 0
        for entry in cache_dir.iterdir():
            if not entry.is_dir() or not entry.name.startswith("models--"):
                continue
            if fragment not in entry.name.lower():
                continue
            blobs = entry / "blobs"
            if not blobs.exists():
                continue
            try:
                for blob in blobs.iterdir():
                    if blob.name.endswith(".incomplete"):
                        try:
                            largest = max(largest, blob.stat().st_size)
                        except OSError:
                            continue
            except OSError:
                continue
        return round(largest / (1024 * 1024), 1)

    async def _load_model_with_progress(self) -> None:
        """Run _load_model in a worker thread while polling .incomplete blob
        size and broadcasting whisper_download_progress events.

        Called from every code path that loads a model — transcribe(), the
        preload endpoint, etc. — so the user sees a progress bar regardless
        of which surface triggered the load. The polling is a no-op for cached
        models (no .incomplete file exists), so warm loads stay silent.
        """
        if self._model is not None:
            return  # already loaded — short-circuit before spinning up any tasks

        model_name = self.get_active_model_name()
        expected_mb = self._EXPECTED_SIZE_MB.get(model_name, 0)
        cache_dir = Path(os.environ.get("HF_HUB_CACHE")
                         or (Path.home() / ".cache" / "huggingface" / "hub"))

        stop_event = asyncio.Event()
        emitted_any = False  # only emit 'complete' if we saw a real download

        async def _poller():
            nonlocal emitted_any
            # Do NOT emit a 'started' event up front. Previously we sent
            # status='started' at 0% before checking for an .incomplete file,
            # which meant warm loads (model already in cache) showed a bar at
            # 0% that never advanced — because no .incomplete file ever
            # appeared, no 'downloading' or 'complete' events followed, and
            # the bar got stuck at "medium  0.0 / 1500 MB (0.0%)" forever.
            #
            # Now we wait until we actually see byte-1 of an .incomplete
            # file. If the load completes without one appearing (warm load),
            # the poller emits nothing and the UI stays silent — correct.
            last_mb = -1.0
            while not stop_event.is_set():
                size_mb = self._largest_incomplete_blob_mb(cache_dir, model_name)
                if size_mb > 0 and size_mb != last_mb:
                    pct = min(99.9, round(100.0 * size_mb / expected_mb, 1)) if expected_mb else 0.0
                    if not emitted_any:
                        # First real bytes: now we tell the UI to make the bar visible.
                        await _ws_manager.broadcast({
                            "type": "whisper_download_progress",
                            "payload": {
                                "status": "started",
                                "model": model_name,
                                "downloaded_mb": size_mb,
                                "total_mb": expected_mb,
                                "percent": pct,
                            },
                        })
                        emitted_any = True
                    else:
                        await _ws_manager.broadcast({
                            "type": "whisper_download_progress",
                            "payload": {
                                "status": "downloading",
                                "model": model_name,
                                "downloaded_mb": size_mb,
                                "total_mb": expected_mb,
                                "percent": pct,
                            },
                        })
                    last_mb = size_mb
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue

        poll_task = asyncio.create_task(_poller())
        try:
            await asyncio.to_thread(self._load_model)
            # On success: emit 'complete' so the UI fills the bar to 100%.
            # Only emit if we actually saw download activity — for warm loads
            # (model already in cache) the bar shouldn't flash up just to
            # close again.
            if emitted_any:
                await _ws_manager.broadcast({
                    "type": "whisper_download_progress",
                    "payload": {
                        "status": "complete",
                        "model": model_name,
                        "downloaded_mb": expected_mb,
                        "total_mb": expected_mb,
                        "percent": 100.0,
                    },
                })
        except Exception as e:
            await _ws_manager.broadcast({
                "type": "whisper_download_progress",
                "payload": {
                    "status": "failed",
                    "model": model_name,
                    "error": str(e),
                },
            })
            raise
        finally:
            stop_event.set()
            try:
                await poll_task
            except Exception:
                pass

    @staticmethod
    def detect_device_and_compute(
        requested_device: Optional[str] = "auto",
        requested_compute_type: Optional[str] = "auto",
    ) -> Tuple[str, str, Optional[str]]:
        """Probe for GPU (CUDA) availability; returns (device, compute_type, gpu_name)."""
        if requested_device and requested_device != "auto":
            dev = requested_device
            ct = (
                requested_compute_type
                if requested_compute_type and requested_compute_type != "auto"
                else ("float16" if dev == "cuda" else "int8")
            )
            return dev, ct, ("GPU" if dev == "cuda" else None)

        # 1. Probe ctranslate2 for CUDA devices
        try:
            import ctranslate2
            if hasattr(ctranslate2, "get_cuda_device_count") and ctranslate2.get_cuda_device_count() > 0:
                gpu_name = None
                try:
                    import torch
                    if torch.cuda.is_available():
                        gpu_name = torch.cuda.get_device_name(0)
                except Exception:
                    pass
                if not gpu_name:
                    import subprocess
                    try:
                        p = subprocess.run(
                            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
                            capture_output=True, text=True, timeout=2,
                        )
                        if p.returncode == 0 and p.stdout.strip():
                            gpu_name = p.stdout.strip().splitlines()[0]
                    except Exception:
                        pass
                ct = "float16" if (not requested_compute_type or requested_compute_type == "auto") else requested_compute_type
                logger.info("NVIDIA CUDA GPU detected (%s). Using GPU acceleration (%s).", gpu_name or "CUDA", ct)
                return "cuda", ct, gpu_name or "NVIDIA CUDA GPU"
        except Exception:
            pass

        # 2. Probe torch CUDA
        try:
            import torch
            if torch.cuda.is_available():
                gpu_name = torch.cuda.get_device_name(0)
                ct = "float16" if (not requested_compute_type or requested_compute_type == "auto") else requested_compute_type
                logger.info("NVIDIA CUDA GPU detected via Torch (%s). Using GPU acceleration (%s).", gpu_name, ct)
                return "cuda", ct, gpu_name
        except Exception:
            pass

        logger.info("No CUDA GPU detected or available. Using CPU (int8) with thread limits.")
        return "cpu", "int8", None

    def _load_model(self):
        """Lazy-load the Whisper model. Sync, intended to run via to_thread."""
        if self._model is not None:
            self._touch_model_usage()
            return

        try:
            from faster_whisper import WhisperModel

            model_name = self.get_active_model_name()
            dev_pref = getattr(self, "_device_preference", "auto") or "auto"
            target_device = getattr(self.settings, "WHISPER_DEVICE", "auto") or "auto"
            if dev_pref in ("cpu", "cuda"):
                target_device = dev_pref
            target_compute = getattr(self.settings, "WHISPER_COMPUTE_TYPE", "auto") or "auto"

            best_device, best_compute, detected_gpu = self.detect_device_and_compute(
                target_device, target_compute
            )
            self._detected_gpu = detected_gpu

            # Query available VRAM to guard against NVIDIA TDR (0x141) resets
            free_vram_mb, total_vram_mb = self._query_gpu_vram_mb()
            min_free_needed = self._MIN_FREE_VRAM_MB.get(model_name, 2400)

            if best_device == "cuda" and free_vram_mb > 0 and free_vram_mb < min_free_needed:
                logger.warning(
                    "Insufficient free GPU VRAM for %s (%d MiB free < %d MiB required). "
                    "Premiere Pro is utilizing GPU memory. Auto-falling back to CPU (int8) to prevent NVIDIA driver TDR crash.",
                    model_name, free_vram_mb, min_free_needed,
                )
                best_device = "cpu"
                best_compute = "int8"
            elif best_device == "cuda" and 0 < total_vram_mb <= 8192 and model_name in ("medium", "large-v3-turbo", "large-v3"):
                # On <= 8GB GPUs, int8_float16 cuts memory by 45% and eliminates WDDM PCIe paging stalls
                if target_compute == "auto":
                    best_compute = "int8_float16"

            attempts = []
            if self.settings.WHISPER_LOCAL_DIR:
                attempts.append(
                    (self.settings.WHISPER_LOCAL_DIR, best_device, best_compute)
                )

            attempts.append((model_name, best_device, best_compute))

            if best_device == "cuda":
                if best_compute != "int8_float16":
                    attempts.append((model_name, "cuda", "int8_float16"))
                # Always fall back to CPU int8 if CUDA runs out of memory or lacks cuDNN
                attempts.append((model_name, "cpu", "int8"))
            elif best_device != "cpu" or best_compute != "int8":
                attempts.append((model_name, "cpu", "int8"))

            # Smaller-model fallback is OFF by default — silent downgrade to "tiny"
            # would otherwise destroy transcript quality without warning.
            auto_fallback = os.getenv("EDITFLOW_WHISPER_AUTO_FALLBACK", "").strip().lower() in {"1", "true", "yes", "on"}
            if auto_fallback:
                for small_model in ["base", "tiny"]:
                    if small_model != model_name:
                        attempts.append((small_model, "cpu", "int8"))

            last_error: Optional[Exception] = None
            for model_spec, device, compute_type in attempts:
                try:
                    logger.info(f"Loading Whisper model: {model_spec} ({device}/{compute_type})")
                    is_cpu = (device == "cpu")
                    # Cap CPU threads to cores//2 (max 4) so multicore CPUs do not freeze the OS
                    cpu_threads = max(1, min(4, (os.cpu_count() or 4) // 2)) if is_cpu else 2
                    self._model = WhisperModel(
                        model_spec,
                        device=device,
                        compute_type=compute_type,
                        cpu_threads=cpu_threads,
                        num_workers=1,
                        local_files_only=bool(
                            self.settings.WHISPER_LOCAL_DIR
                            and Path(self.settings.WHISPER_LOCAL_DIR).exists()
                        ),
                    )
                    if device == "cuda":
                        # Validate that CUDA libraries actually work before declaring success
                        try:
                            import ctranslate2
                            import numpy as np
                            dummy = np.zeros((1, 80, 300), dtype=np.float32)
                            sv = ctranslate2.StorageView.from_array(dummy)
                            self._model.model.encode(sv)
                        except Exception as val_err:
                            logger.warning(f"CUDA forward validation failed for {model_spec}: {val_err}")
                            raise val_err

                    self._model_info = {
                        "model": str(model_spec),
                        "device": device,
                        "compute_type": compute_type,
                        "gpu_name": self._detected_gpu if device == "cuda" else None,
                        "cpu_threads": cpu_threads,
                        "total_vram_mb": total_vram_mb if device == "cuda" else 0,
                        "free_vram_mb": free_vram_mb if device == "cuda" else 0,
                    }
                    if model_spec != model_name and str(model_spec) != self.settings.WHISPER_LOCAL_DIR:
                        logger.warning(
                            f"Whisper fell back to {model_spec} (requested: {model_name}). "
                            "Set EDITFLOW_WHISPER_AUTO_FALLBACK=true to allow smaller-model downgrades."
                        )
                    logger.info(f"Whisper loaded: {model_spec} ({device}/{compute_type})")

                    # Populate model_revision from model metadata
                    self._populate_model_revision()
                    self._touch_model_usage()
                    return
                except Exception as e:
                    last_error = e
                    logger.warning(f"Failed to load Whisper {model_spec} ({device}/{compute_type}): {e}")
                    continue

            raise RuntimeError(
                f"Could not load any Whisper model variant. Last error: {last_error}"
            )

        except ImportError:
            raise RuntimeError("faster-whisper not installed. Run: pip install faster-whisper")

    def _get_model_load_lock(self) -> asyncio.Lock:
        """Return an asyncio.Lock bound to the currently running event loop."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if self._model_load_lock is None or getattr(self, "_model_load_lock_loop", None) is not loop:
            self._model_load_lock = asyncio.Lock()
            self._model_load_lock_loop = loop
        return self._model_load_lock

    def _touch_model_usage(self) -> None:
        """Update last used timestamp and ensure idle watchdog is active."""
        self._last_used = time.time()
        try:
            loop = None
            try:
                loop = asyncio.get_running_loop()
                self._main_loop = loop
            except RuntimeError:
                loop = getattr(self, "_main_loop", None)

            if loop and loop.is_running():
                if self._idle_watchdog_task is None or self._idle_watchdog_task.done():
                    try:
                        running = asyncio.get_running_loop()
                        if running is loop:
                            self._idle_watchdog_task = loop.create_task(self._idle_watchdog())
                        else:
                            loop.call_soon_threadsafe(self._ensure_watchdog_task, loop)
                    except RuntimeError:
                        loop.call_soon_threadsafe(self._ensure_watchdog_task, loop)
        except Exception as e:
            logger.debug(f"Could not schedule idle watchdog: {e}")

    def _ensure_watchdog_task(self, loop: asyncio.AbstractEventLoop) -> None:
        if self._idle_watchdog_task is None or self._idle_watchdog_task.done():
            self._idle_watchdog_task = loop.create_task(self._idle_watchdog())

    async def _idle_watchdog(self) -> None:
        """Periodic background task that unloads the model after inactivity."""
        timeout = getattr(self.settings, "WHISPER_IDLE_TIMEOUT_SECONDS", 30)
        if timeout <= 0:
            return
        check_interval = max(3.0, min(10.0, float(timeout) / 3))
        while True:
            await asyncio.sleep(check_interval)
            if self._model is None:
                return
            if getattr(self, "_active_transcriptions", 0) > 0:
                self._touch_model_usage()
                continue
            if time.time() - self._last_used >= timeout:
                logger.info(f"Whisper model inactive for >{timeout}s. Evicting from memory to reclaim GPU VRAM for Premiere Pro.")
                self.unload_model()
                return

    def unload_model(self) -> bool:
        """Evict the loaded Whisper model from RAM and VRAM."""
        if self._model is None:
            return False
        if getattr(self, "_active_transcriptions", 0) > 0:
            logger.info("Cannot unload Whisper model: transcription actively in progress.")
            return False
        self._model = None
        self._model_info = {}
        import gc
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                if hasattr(torch.cuda, "ipc_collect"):
                    torch.cuda.ipc_collect()
        except Exception:
            pass
        logger.info("Whisper model evicted from memory.")
        return True

    def get_hardware_status(self) -> Dict[str, Any]:
        """Return current GPU and model memory status."""
        loaded = (self._model is not None)
        active_device = self._model_info.get("device", "cpu") if loaded else "none"
        compute_type = self._model_info.get("compute_type", "int8") if loaded else "none"
        free_vram_mb, total_vram_mb = self._query_gpu_vram_mb()
        if not self._detected_gpu and total_vram_mb > 0:
            try:
                _, _, det = self.detect_device_and_compute(self.get_device_preference(), "auto")
                self._detected_gpu = det
            except Exception:
                pass
        gpu_name = self._model_info.get("gpu_name") or self._detected_gpu

        return {
            "model_loaded": loaded,
            "active_model": self.get_active_model_name(),
            "active_device": active_device,
            "compute_type": compute_type,
            "device_preference": self.get_device_preference(),
            "gpu_name": gpu_name,
            "gpu_available": bool(self._detected_gpu or active_device == "cuda"),
            "free_vram_mb": free_vram_mb,
            "total_vram_mb": total_vram_mb,
            "idle_seconds": round(time.time() - self._last_used, 1) if (loaded and self._last_used > 0) else 0.0,
        }

    def _populate_model_revision(self) -> None:
        """Try to extract the model revision from the loaded model's metadata.

        For faster-whisper, the model stores its path and optionally version
        info that we can extract.
        """
        if self._model is None:
            return

        try:
            # faster-whisper stores the model path; try to extract a revision
            # from a version file or the model directory name.
            model_path = getattr(self._model, 'model_path', None)
            if model_path:
                path = Path(model_path)
                # Check for a VERSION or revision file
                for version_file in ["VERSION", "revision.txt", ".git/HEAD"]:
                    vf = path / version_file
                    if vf.exists():
                        self._model_revision = vf.read_text(encoding="utf-8").strip()[:64]
                        return

                # Try reading the config to get a model version / revision
                config_path = path / "config.json"
                if config_path.exists():
                    config = json.loads(config_path.read_text(encoding="utf-8"))
                    # Some models store a "revision" or "version" in their config
                    rev = config.get("revision") or config.get("version") or config.get("model_version")
                    if rev:
                        self._model_revision = str(rev)[:64]
                        return

            # Fallback: use device/compute_type as a pseudo-revision so
            # the cache key differentiates between CPU-int8 and CUDA-fp16 runs.
            device = self._model_info.get("device", "cpu")
            compute_type = self._model_info.get("compute_type", "int8")
            self._model_revision = f"{device}/{compute_type}"

        except Exception as e:
            logger.debug(f"Could not determine model revision: {e}")
            self._model_revision = ""

    # ── Silero-VAD Integration ──

    def _run_silero_vad(self, audio_path: str) -> List[VADSegment]:
        """Run silero-vad on an audio file. Best-effort — returns [] on failure.

        This is a separate pass from transcription. The plan specifies that
        we don't trust Whisper's internal VAD for boundary detection, so
        we run silero-vad independently to get speech timestamps that Stage 6
        can use for VAD-boundary snapping.

        Args:
            audio_path: Path to the audio file (WAV preferred).

        Returns:
            List of VADSegment with speech timestamps, or empty list on error.
        """
        try:
            import torch
            model, utils = torch.hub.load(
                repo_or_dir="snakers4/silero-vad",
                model="silero_vad",
                trust_repo=True,
            )
            (get_speech_timestamps, _, read_audio, _, _) = utils
            wav = read_audio(audio_path)
            speech_timestamps = get_speech_timestamps(wav, model)

            # Convert sample-offset timestamps to seconds (silero-vad uses
            # 16 kHz sample rate by default)
            segments = []
            for ts in speech_timestamps:
                segments.append(VADSegment(
                    start=round(ts["start"] / 16000, 3),
                    end=round(ts["end"] / 16000, 3),
                    is_speech=True,
                    confidence=1.0,
                ))
            logger.debug(f"Silero-VAD detected {len(segments)} speech segments in {audio_path}")
            return segments

        except Exception as e:
            logger.debug(f"Silero-VAD failed: {e}")
            return []

    # ── DB Persistence ──

    def _persist_transcript_to_db(
        self,
        result: TranscriptResult,
        content_hash: str,
    ) -> None:
        """Persist a TranscriptResult to the SQLite registry.

        Writes to source_files (parent row required by FK), source_transcripts
        (one row), and transcript_words (one row per word). Best-effort —
        failures are logged but never raise.
        """
        try:
            from ..models.sqlite_registry import sqlite_registry

            # Ensure the parent source_files row exists. The FK constraint on
            # source_transcripts.content_hash references source_files.content_hash,
            # so without this row the INSERT silently fails with IntegrityError
            # and is swallowed by the outer try/except, leaving NO transcripts
            # in the DB — every restart re-transcribes from scratch.
            existing_source = sqlite_registry.find_source_file(content_hash)
            if existing_source is None:
                source_path = Path(result.source_file) if result.source_file else None
                file_size = 0
                if source_path and source_path.exists():
                    try:
                        file_size = source_path.stat().st_size
                    except OSError:
                        file_size = 0
                sqlite_registry.upsert_source_file(
                    content_hash=content_hash,
                    path=str(source_path) if source_path else "",
                    original_name=source_path.name if source_path else "",
                    file_size=file_size,
                    duration=result.duration,
                    has_audio=True,
                    fingerprint=content_hash,
                    status="transcribed",
                )

            transcript_id = str(uuid.uuid4())[:12]

            sqlite_registry.upsert_source_transcript(
                transcript_id=transcript_id,
                content_hash=content_hash,
                range_in=result.range_in,
                range_out=result.range_out,
                audio_offset=result.audio_offset,
                language=result.language,
                engine=result.engine,
                model=result.model,
                model_revision=result.model_revision,
                duration=result.duration,
                full_text=result.full_text,
                status="completed",
                warnings=json.dumps(result.warnings, ensure_ascii=False),
            )

            # Insert individual words for fast word-level lookup
            word_index = 0
            for segment in result.segments:
                for w in segment.words:
                    normalized = re.sub(r'[^\w]', '', w.word.lower())
                    sqlite_registry.insert_transcript_word(
                        word_id=f"{transcript_id}_{word_index:06d}",
                        transcript_id=transcript_id,
                        content_hash=content_hash,
                        word_index=word_index,
                        word=w.word,
                        normalized_word=normalized,
                        start=w.start,
                        end=w.end,
                        probability=w.probability,
                    )
                    word_index += 1

            logger.info(
                f"Persisted transcript to DB: {transcript_id} "
                f"({word_index} words, engine={result.engine})"
            )

        except Exception as e:
            # Upgraded from debug → warning. Silent DB-persist failures meant
            # transcripts disappeared after restart, forcing a full re-transcribe
            # every session. Now the user (and the log) see it.
            logger.warning(f"Failed to persist transcript to DB: {e}", exc_info=True)

    def _lookup_transcript_from_db(
        self,
        content_hash: str,
        range_in: float,
        range_out: float,
        engine: str,
        model: str,
    ) -> Optional[TranscriptResult]:
        """Check the DB for a previously persisted transcript.

        If found, reconstruct a TranscriptResult from the DB row and the
        associated transcript_words. Returns None if not found.
        """
        try:
            from ..models.sqlite_registry import sqlite_registry

            row = sqlite_registry.find_transcript_by_cache_key(
                content_hash=content_hash,
                range_in=range_in,
                range_out=range_out,
                engine=engine,
                model=model,
            )
            if row is None:
                return None

            # Reconstruct segments from transcript_words
            db_words = sqlite_registry.find_transcript_words(content_hash)
            segments: List[TranscriptSegment] = []
            current_words: List[TranscriptWord] = []
            current_text_parts: List[str] = []
            seg_start = 0.0
            seg_end = 0.0

            # Group words into segments by proximity (gap > 1s = new segment)
            SEGMENT_GAP_S = 1.0
            for i, w_row in enumerate(db_words):
                w = TranscriptWord(
                    word=w_row["word"],
                    start=round(float(w_row["start"]), 3),
                    end=round(float(w_row["end"]), 3),
                    probability=round(float(w_row.get("probability", 0)), 3),
                )
                if current_words and (w.start - current_words[-1].end) > SEGMENT_GAP_S:
                    # Flush current segment
                    segments.append(TranscriptSegment(
                        start=round(seg_start, 3),
                        end=round(seg_end, 3),
                        text=" ".join(current_text_parts),
                        words=current_words,
                    ))
                    current_words = []
                    current_text_parts = []
                    seg_start = w.start

                if not current_words:
                    seg_start = w.start
                seg_end = w.end
                current_words.append(w)
                current_text_parts.append(w.word)

            # Flush the last segment
            if current_words:
                segments.append(TranscriptSegment(
                    start=round(seg_start, 3),
                    end=round(seg_end, 3),
                    text=" ".join(current_text_parts),
                    words=current_words,
                ))

            warnings = json.loads(row.get("warnings", "[]")) if row.get("warnings") else []

            result = TranscriptResult(
                source_file="",  # not stored per-transcript in DB
                language=row.get("language", ""),
                duration=round(float(row.get("duration", 0)), 2),
                segments=segments,
                full_text=row.get("full_text", ""),
                content_hash=content_hash,
                range_in=round(float(row.get("range_in", 0)), 3),
                range_out=round(float(row.get("range_out", 0)), 3),
                audio_offset=round(float(row.get("audio_offset", 0)), 3),
                engine=row.get("engine", "faster_whisper"),
                model=row.get("model", ""),
                model_revision=row.get("model_revision", ""),
                warnings=warnings,
            )

            logger.info(
                f"DB transcript cache hit for content_hash={content_hash[:16]}... "
                f"engine={engine} ({len(segments)} segments)"
            )
            return result

        except Exception as e:
            logger.debug(f"DB transcript lookup failed: {e}")
            return None

    # ── Core Transcription (non-fingerprinted) ──

    async def transcribe(
        self,
        video_path: str,
        language: Optional[str] = None,
        word_timestamps: bool = True,
        vad_filter: bool = True,
        progress: Optional[ProgressReporter] = None,
    ) -> TranscriptResult:
        """Transcribe a video file.

        This is the original (non-fingerprinted) transcription method.
        It remains unchanged for backward compatibility.

        Args:
            video_path: Path to video or audio file
            language: Language hint (None for auto-detect)
            word_timestamps: Whether to include word-level timestamps
            vad_filter: Whether to use Voice Activity Detection
            progress: Optional progress reporter

        Returns:
            TranscriptResult with segments and word timestamps
        """
        if progress:
            await progress.start("Loading Whisper model...")

        self._active_transcriptions = getattr(self, "_active_transcriptions", 0) + 1
        # Load model in a worker thread — first call downloads weights, slow.
        # Lock serializes concurrent callers so only ONE big HF download happens.
        async with self._get_model_load_lock():
            await self._load_model_with_progress()

        if progress:
            await progress.update(0.1, "Extracting audio...")

        video_path_obj = Path(video_path)
        audio_path: Optional[Path] = None

        if video_path_obj.suffix.lower() in [".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm"]:
            tmp_dir = self.settings.MEDIA_CACHE_DIR
            tmp_dir.mkdir(parents=True, exist_ok=True)
            cache_suffix = _audio_cache_key(video_path_obj)
            audio_path = tmp_dir / f"{video_path_obj.stem}_{cache_suffix}.wav"

            # Regenerate when the source video is newer than the cached audio.
            regenerate = True
            if audio_path.exists():
                try:
                    if audio_path.stat().st_mtime >= video_path_obj.stat().st_mtime:
                        regenerate = False
                except OSError:
                    regenerate = True

            if regenerate:
                await asyncio.to_thread(extract_audio, video_path_obj, audio_path)
        elif video_path_obj.suffix.lower() in [".wav", ".mp3", ".flac", ".ogg", ".m4a"]:
            audio_path = video_path_obj
        else:
            return TranscriptResult(
                source_file=str(video_path_obj),
                language="",
                duration=0.0,
                segments=[],
                full_text="",
            )

        if progress:
            await progress.update(0.2, "Transcribing audio...")

        try:
            # The generator returned by transcribe() is lazy — pulling segments out
            # of it is the CPU-bound work. Both the call and the iteration must run
            # off the event loop.
            def _transcribe_call():
                # On <=8GB GPUs or int8_float16, beam_size=2 avoids >2s single-kernel stalls
                # that trigger Windows WDDM TDR 0x141 driver resets, while retaining high accuracy.
                is_cuda = bool(self._model_info.get("device") == "cuda")
                tot_vram = int(self._model_info.get("total_vram_mb", 0) or 0)
                beam = 2 if (is_cuda and (tot_vram <= 8192 or self._model_info.get("compute_type") == "int8_float16")) else 5

                kwargs: Dict[str, Any] = {
                    "task": "transcribe",
                    "language": language,
                    "vad_filter": vad_filter,
                    "word_timestamps": word_timestamps,
                    "beam_size": beam,
                    "condition_on_previous_text": False,
                }
                if vad_filter:
                    kwargs["vad_parameters"] = dict(
                        threshold=0.35,              # sensitive to quiet speech
                        min_speech_duration_ms=100,  # capture quick one-word phrases
                        min_silence_duration_ms=500, # prevent cutting natural pauses
                        speech_pad_ms=400,           # pad edges so words aren't cut off
                    )
                return self._model.transcribe(str(audio_path), **kwargs)

            segments_iter, info = await asyncio.to_thread(_transcribe_call)

            expected = float(getattr(info, "duration", 0) or 0)
            if progress:
                await progress.update(
                    0.3, f"Transcribing {expected:.1f}s of audio..."
                )

            # Shared between the consumer thread and the async ticker below.
            progress_state: Dict[str, Any] = {"count": 0, "last_end": 0.0}

            async def _ticker():
                """Emit a progress update roughly every 2 seconds."""
                while True:
                    try:
                        await asyncio.sleep(2.0)
                    except asyncio.CancelledError:
                        return
                    if progress is None:
                        continue
                    last_end = float(progress_state.get("last_end", 0.0))
                    count = int(progress_state.get("count", 0))
                    if expected > 0:
                        pct = 0.3 + 0.6 * min(1.0, last_end / expected)
                    else:
                        pct = 0.4  # unknown duration — show "in progress"
                    try:
                        await progress.update(
                            pct,
                            f"Transcribed {count} segments ({last_end:.1f}s / {expected:.1f}s)",
                        )
                    except Exception:
                        # Don't let a websocket failure kill the transcription
                        return

            ticker_task: Optional[asyncio.Task] = (
                asyncio.create_task(_ticker()) if progress else None
            )
            try:
                is_cpu = bool(self._model_info.get("device", "cpu") == "cpu")
                result_segments, full_text_parts = await asyncio.to_thread(
                    _consume_segments, segments_iter, word_timestamps, progress_state, is_cpu
                )
            finally:
                self._touch_model_usage()
                if ticker_task is not None:
                    ticker_task.cancel()
                    try:
                        await ticker_task
                    except asyncio.CancelledError:
                        pass

            if progress:
                await progress.complete(f"Transcription complete: {len(result_segments)} segments")

            return TranscriptResult(
                source_file=str(video_path_obj),
                language=info.language,
                duration=round(info.duration, 2),
                segments=result_segments,
                full_text=" ".join(full_text_parts),
            )

        except Exception as e:
            logger.error(f"Transcription error: {e}")
            if progress:
                try:
                    await progress.fail(f"Transcription failed: {e}")
                except Exception:
                    pass
            raise
        finally:
            self._active_transcriptions = max(0, getattr(self, "_active_transcriptions", 1) - 1)
            self._touch_model_usage()


    # ── Phase B: Transcribe-once-per-source-file ──

    def _transcript_cache_dir(self) -> Path:
        """Directory for on-disk transcript cache (keyed by fingerprint)."""
        d = Path(self.settings.MEDIA_CACHE_DIR) / "transcripts"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _get_cached_transcript(self, file_fingerprint: str) -> Optional[TranscriptResult]:
        """Look up a cached transcript by file fingerprint.

        Checks in-memory cache first, then on-disk JSON cache.
        Returns None if no cached transcript exists.
        """
        # In-memory cache
        if file_fingerprint in self._transcript_cache:
            return self._transcript_cache[file_fingerprint]

        # On-disk cache
        cache_path = self._transcript_cache_dir() / f"{file_fingerprint}.json"
        if cache_path.exists():
            try:
                data = json.loads(cache_path.read_text(encoding="utf-8"))
                result = TranscriptResult(**data)
                self._transcript_cache[file_fingerprint] = result
                return result
            except Exception as e:
                logger.warning(f"Failed to load cached transcript for {file_fingerprint[:16]}...: {e}")
        return None

    @staticmethod
    def compute_fingerprint(
        content_or_hash: bytes | str,
        sequence_key: str = "",
        model_name: str = "",
        language: str = "auto",
        engine: str = "auto",
    ) -> str:
        """Deterministic, content-addressed 16-hex fingerprint for transcript caching."""
        if isinstance(content_or_hash, bytes):
            content_hash = hashlib.sha256(content_or_hash).hexdigest()[:16]
        else:
            content_hash = str(content_or_hash)[:16]
        raw_key = f"{content_hash}|{sequence_key}|{model_name}|{(language or 'auto').strip().lower()}|{engine}"
        return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()[:16]

    def peek_cached_transcript(self, file_fingerprint: str) -> Optional[TranscriptResult]:
        """Return a cached transcript for ``file_fingerprint`` without
        transcribing (memory → on-disk JSON). Any engine accepted — a
        previously accepted transcript is reused as-is so repeat uploads
        never re-run models. Returns None on miss.
        """
        try:
            return self._get_cached_transcript(file_fingerprint)
        except Exception as e:  # noqa: BLE001 — peek must never break the flow
            logger.debug(f"peek_cached_transcript failed: {e}")
            return None

    def _write_transcript_sidecar(self, result: TranscriptResult) -> None:
        """Write a human-readable transcript sidecar next to the source video.

        This is extracted so it can be called from both the cache-miss path
        (inside _save_transcript_cache) and the cache-hit paths so the
        sidecar is recreated if the user deleted it.
        """
        if not self.settings.WRITE_TRANSCRIPT_SIDECAR:
            return
        src = result.source_file
        if not src:
            return
        try:
            src_path = Path(src)
            if not src_path.parent.exists():
                return
            sidecar = src_path.with_name(src_path.stem + ".transcript.json")
            sidecar.write_text(
                result.model_dump_json(indent=2),
                encoding="utf-8",
            )
            logger.info(f"Wrote transcript sidecar: {sidecar}")
        except (OSError, PermissionError) as e:
            logger.debug(f"Skipped transcript sidecar for {src}: {e}")

    def _save_transcript_cache(self, file_fingerprint: str, result: TranscriptResult) -> None:
        """Save a transcript result to both in-memory and on-disk cache."""
        self._transcript_cache[file_fingerprint] = result
        cache_path = self._transcript_cache_dir() / f"{file_fingerprint}.json"
        try:
            cache_path.write_text(
                result.model_dump_json(indent=2),
                encoding="utf-8",
            )
        except Exception as e:
            logger.warning(f"Failed to cache transcript for {file_fingerprint[:16]}...: {e}")

        self._write_transcript_sidecar(result)

    async def transcribe_fingerprinted(
        self,
        source_path: str,
        file_fingerprint: Optional[str] = None,
        language: Optional[str] = None,
        word_timestamps: bool = True,
        vad_filter: bool = True,
        progress: Optional[ProgressReporter] = None,
        force: bool = False,
        range_in: float = 0.0,
        range_out: float = 0.0,
    ) -> TranscriptResult:
        """Transcribe a media file with content-addressed deduplication.

        This is the Phase B entry point.  Before running Whisper, it checks
        the transcript cache (keyed by content hash + range + engine + model)
        in the following order:

        1. In-memory cache (fastest)
        2. On-disk JSON cache
        3. SQLite registry (source_transcripts + transcript_words)

        If a cached transcript exists and ``force`` is False, the cached
        result is returned immediately — the same source file is never
        transcribed twice.

        After transcription:
        - audio_offset is applied when range_in > 0
        - Engine info is stamped into the result
        - VAD pass is run (best-effort silero-vad)
        - Result is persisted to JSON cache and SQLite registry

        Args:
            source_path: Path to the source media file.
            file_fingerprint: Pre-computed fingerprint (computed if not provided).
            language: Language hint for Whisper.
            word_timestamps: Whether to request word-level timestamps.
            vad_filter: Whether to use VAD filtering.
            progress: Optional progress reporter.
            force: If True, bypass cache and re-transcribe.
            range_in: Start of audio range (seconds, default 0 = whole file).
            range_out: End of audio range (seconds, default 0 = whole file).

        Returns:
            TranscriptResult with segments, word timestamps, engine info,
            and audio_offset applied.
        """
        # ── Step 1: Resolve the engine ──
        engine_name, engine_module, boundary_window_ms = self._resolve_engine()
        model_name = self.get_active_model_name()
        model_revision = self._model_revision  # may be "" until model is loaded

        # ── Step 2: Compute fingerprint if not provided ──
        if file_fingerprint is None:
            try:
                file_fingerprint = await asyncio.to_thread(
                    compute_file_fingerprint, source_path
                )
            except FileNotFoundError:
                raise
            except Exception as e:
                logger.warning(f"Fingerprint computation failed for {source_path}: {e}")
                file_fingerprint = ""

        # ── Step 3: Check caches (unless force=True) ──
        if file_fingerprint and not force:
            # 3a. Check in-memory / on-disk JSON cache
            cached = self._get_cached_transcript(file_fingerprint)
            if cached is not None:
                # Check if engine/model match — if not, this is a stale cache
                if (getattr(cached, 'engine', '') == engine_name and
                    getattr(cached, 'model', '') == model_name):
                    logger.info(
                        f"Transcript cache hit for {Path(source_path).name} "
                        f"(fp={file_fingerprint[:16]}..., engine={engine_name})"
                    )
                    # Stamp source_file: JSON cache may have a stale/empty
                    # value (e.g. promoted from DB which doesn't store it).
                    cached.source_file = str(Path(source_path))
                    # Re-ensure sidecar on cache hit: user may have deleted it
                    self._write_transcript_sidecar(cached)
                    return cached
                else:
                    logger.info(
                        f"Transcript cache stale for {Path(source_path).name} "
                        f"(cached engine={getattr(cached, 'engine', '?')}, "
                        f"current={engine_name}). Re-transcribing."
                    )

            # 3b. Check SQLite registry DB
            db_result = self._lookup_transcript_from_db(
                content_hash=file_fingerprint,
                range_in=range_in,
                range_out=range_out,
                engine=engine_name,
                model=model_name,
            )
            if db_result is not None:
                # Stamp source_file: the DB doesn't store it per-transcript,
                # so _lookup_transcript_from_db always returns source_file="".
                # The caller (transcribe_fingerprinted) always knows the real
                # source_path, so stamp it here before returning.
                db_result.source_file = str(Path(source_path))
                # Also store in the faster caches for next time
                self._save_transcript_cache(file_fingerprint, db_result)
                # Re-ensure sidecar on cache hit: user may have deleted it
                self._write_transcript_sidecar(db_result)
                return db_result

        # ── Step 4: Cache miss — run transcription ──
        result = await self.transcribe(
            video_path=source_path,
            language=language,
            word_timestamps=word_timestamps,
            vad_filter=vad_filter,
            progress=progress,
        )

        # After model is loaded, refresh model_revision
        if not model_revision and self._model_revision:
            model_revision = self._model_revision

        # ── Step 5: Compute and apply audio_offset ──
        # When range_in > 0, the audio was extracted from a specific position
        # in the source file.  The extraction starts at
        #   seek_time = max(0, range_in - padding)
        # so all word timestamps are relative to seek_time.
        # We need to add audio_offset = seek_time back to get absolute times.
        audio_offset = 0.0
        if range_in > 0:
            # Match the padding logic from audio_prepare.py
            padding = 1.0  # _RANGE_PADDING_S
            seek_time = max(0.0, range_in - padding)
            audio_offset = seek_time

            # Apply offset to all word and segment timestamps
            for segment in result.segments:
                segment.start = round(segment.start + audio_offset, 3)
                segment.end = round(segment.end + audio_offset, 3)
                for w in segment.words:
                    w.start = round(w.start + audio_offset, 3)
                    w.end = round(w.end + audio_offset, 3)

        # ── Step 6: Stamp engine info and metadata into result ──
        result.content_hash = file_fingerprint
        result.engine = engine_name
        result.model = model_name
        result.model_revision = model_revision
        result.range_in = range_in
        result.range_out = range_out
        result.audio_offset = audio_offset

        # ── Step 7: Run silero-vad as a best-effort pass ──
        try:
            # Use the prepared audio path if available, otherwise source
            audio_path_for_vad = result.source_file
            if not audio_path_for_vad:
                audio_path_for_vad = source_path

            vad_segments = await asyncio.to_thread(self._run_silero_vad, audio_path_for_vad)
            if vad_segments:
                result.warnings.append(
                    f"VAD: {len(vad_segments)} speech segments detected"
                )
                # Persist VAD segments to DB for stage 6
                self._persist_vad_segments(
                    file_fingerprint, range_in, range_out, vad_segments
                )
        except Exception as e:
            logger.debug(f"VAD pass skipped: {e}")

        # ── Step 8: Persist to JSON cache ──
        if file_fingerprint:
            self._save_transcript_cache(file_fingerprint, result)

        # ── Step 9: Persist to SQLite registry ──
        if file_fingerprint:
            self._persist_transcript_to_db(result, file_fingerprint)

        return result

    async def transcribe_directory(
        self,
        directory: str,
        extensions: Optional[List[str]] = None,
        language: Optional[str] = None,
        progress: Optional[ProgressReporter] = None,
    ) -> List[TranscriptResult]:
        """Transcribe all video files in a directory.

        Args:
            directory: Directory containing video files
            extensions: Video file extensions to include
            language: Language hint
            progress: Progress reporter

        Returns:
            List of TranscriptResult objects
        """
        from ..utils.ffmpeg_utils import scan_directory

        files = scan_directory(directory, extensions)
        results: List[TranscriptResult] = []

        for i, file_path in enumerate(files):
            if progress:
                await progress.step(i + 1, len(files), f"Transcribing {file_path.name}...")

            try:
                result = await self.transcribe(
                    str(file_path),
                    language=language,
                    progress=None,  # Don't create nested progress
                )
                results.append(result)
            except Exception as e:
                logger.error(f"Failed to transcribe {file_path}: {e}")
                continue

        if progress:
            await progress.complete(f"Batch transcription complete: {len(results)}/{len(files)} files")

        return results

    def _persist_vad_segments(
        self,
        content_hash: str,
        range_in: float,
        range_out: float,
        vad_segments: List[VADSegment],
    ) -> None:
        """Persist VAD segments to the transcript_vad DB table."""
        try:
            from ..models.sqlite_registry import sqlite_registry
            for i, seg in enumerate(vad_segments):
                sqlite_registry.insert_vad_segment(
                    segment_id=str(uuid.uuid4())[:12],
                    content_hash=content_hash,
                    range_in=range_in,
                    range_out=range_out,
                    segment_index=i,
                    start=seg.start,
                    end=seg.end,
                    is_speech=seg.is_speech,
                    confidence=seg.confidence,
                )
        except Exception as e:
            logger.debug(f"Failed to persist VAD segments: {e}")

    @property
    def model_info(self) -> Dict:
        """Get information about the loaded model."""
        return self._model_info

    @property
    def engine_name(self) -> Optional[str]:
        """Get the resolved engine name (None if not yet resolved)."""
        return self._engine_name

    @property
    def engine_boundary_window_ms(self) -> int:
        """Get the boundary window (ms) for the selected engine."""
        return self._engine_boundary_window_ms


# Global service instance
whisper_service = WhisperService()


# ── MVP Task M2: Junk filter ──


def filter_junk_segments(
    result: TranscriptResult,
    *,
    no_speech_prob_max: float = 0.5,
    compression_ratio_max: float = 2.4,
    avg_logprob_min: float = -1.0,
) -> tuple[TranscriptResult, list[dict]]:
    """Drop hallucinated / looping / very-low-confidence segments.

    Returns a copy of ``result`` with the bad segments removed AND a list of
    ``{reason, start, end, text}`` describing what was dropped.  The reasons
    list is surfaced in plan warnings so the author knows why content was
    skipped.

    MVP Task M2.
    """
    reasons: list[dict] = []
    good_segments: list[TranscriptSegment] = []

    for seg in result.segments:
        drop_reason: str | None = None

        if seg.no_speech_prob > no_speech_prob_max:
            drop_reason = f"no_speech_prob={seg.no_speech_prob:.2f} > {no_speech_prob_max}"
        elif seg.compression_ratio > compression_ratio_max:
            drop_reason = f"compression_ratio={seg.compression_ratio:.2f} > {compression_ratio_max}"
        elif seg.avg_logprob < avg_logprob_min:
            drop_reason = f"avg_logprob={seg.avg_logprob:.2f} < {avg_logprob_min}"

        if drop_reason:
            reasons.append({
                "reason": drop_reason,
                "start": seg.start,
                "end": seg.end,
                "text": seg.text[:100],
            })
        else:
            good_segments.append(seg)

    if not reasons:
        return result, reasons

    # Rebuild the result with only good segments
    filtered = TranscriptResult(
        source_file=result.source_file,
        language=result.language,
        duration=result.duration,
        segments=good_segments,
        full_text=" ".join(seg.text for seg in good_segments),
        content_hash=result.content_hash,
        range_in=result.range_in,
        range_out=result.range_out,
        audio_offset=result.audio_offset,
        engine=result.engine,
        model=result.model,
        model_revision=result.model_revision,
        warnings=result.warnings + [
            f"Junk filter dropped {len(reasons)} segment(s): " +
            "; ".join(r["reason"] for r in reasons[:5])
        ],
    )
    return filtered, reasons
