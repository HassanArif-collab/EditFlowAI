"""ElevenLabs Scribe (speech-to-text) integration — exact per-word timestamps.

WHY: Whisper's Urdu is poor and word-times must be exact for the word-level
editor. Scribe gives per-word (and per-character) timestamps and strong Urdu
accuracy. This is the production transcription path; Whisper stays an offline
fallback.

Grounded in the verified ElevenLabs API:
  POST https://api.elevenlabs.io/v1/speech-to-text/convert   (header: xi-api-key)
  multipart: file=<audio>; form: model_id, language_code, timestamps_granularity,
  diarize. Returns a transcript with a ``words`` array; each item has
  ``text``/``start``/``end`` and a ``type`` ∈ {word, spacing, audio_event}.

The response parser is intentionally TOLERANT (field-name fallbacks, graceful
degradation) so a minor schema difference logs and degrades instead of crashing.
Verify live with a real key; the parser is unit-tested against the documented
shape.

Key handling: read from env ``ELEVENLABS_API_KEY`` or ``data/scribe_config.json``
(gitignored). Never stored in the repo.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Optional

from ..config import get_settings
from ..utils.ffmpeg_utils import extract_audio, get_duration
from .media_fingerprint import fingerprint_short
from .review_service import Segment, Word

logger = logging.getLogger(__name__)

SCRIBE_ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text/convert"
DEFAULT_MODEL = "scribe_v2"
# Pay-as-you-go ≈ $0.22 / hour (user-confirmed). Configurable for plan changes.
USD_PER_MINUTE = 0.22 / 60.0


class ScribeError(RuntimeError):
    """Raised for missing key / API failure, with a user-facing message."""


# ── API key ────────────────────────────────────────────────────

def _key_path() -> Path:
    return get_settings().DATA_DIR / "scribe_config.json"


def get_api_key() -> str:
    env = os.environ.get("ELEVENLABS_API_KEY")
    if env:
        return env.strip()
    p = _key_path()
    if p.exists():
        try:
            return str(json.loads(p.read_text(encoding="utf-8")).get("api_key", "")).strip()
        except Exception:  # noqa: BLE001
            return ""
    return ""


def set_api_key(key: str) -> None:
    p = _key_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"api_key": (key or "").strip()}), encoding="utf-8")


def has_api_key() -> bool:
    return bool(get_api_key())


# ── Cost estimate ──────────────────────────────────────────────

def estimate_cost(duration_seconds: float) -> dict:
    minutes = max(0.0, float(duration_seconds or 0.0)) / 60.0
    return {"minutes": round(minutes, 2), "usd": round(minutes * USD_PER_MINUTE, 4)}


def estimate_for_file(src_path: str | Path) -> dict:
    return estimate_cost(get_duration(src_path))


# ── Response parsing (pure, tolerant, unit-tested) ─────────────

_SENT_END = ("۔", ".", "!", "؟", "?")


def parse_scribe_words(data: dict) -> list[dict]:
    """Extract speech words from a Scribe response.

    Keeps ``type == 'word'`` (and treats ``audio_event`` as bracketed non-speech
    so the editor can flag it); drops ``spacing``. Tolerant of missing fields.
    """
    raw = data.get("words")
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for w in raw:
        if not isinstance(w, dict):
            continue
        wtype = (w.get("type") or "word").lower()
        if wtype == "spacing":
            continue
        text = str(w.get("text") or w.get("word") or "").strip()
        if not text:
            continue
        if wtype == "audio_event" and not (text.startswith("[") or text.startswith("(")):
            text = f"[{text}]"  # normalize so the editor cuts it as non-speech
        try:
            start = float(w.get("start", w.get("start_time", 0.0)) or 0.0)
            end = float(w.get("end", w.get("end_time", start)) or start)
        except (TypeError, ValueError):
            continue
        if end < start:
            end = start
        out.append({"text": text, "start": round(start, 3), "end": round(end, 3),
                    "type": wtype, "speaker": w.get("speaker_id", "")})
    return out


def words_to_segments(words: list[dict], gap: float = 0.6) -> list[dict]:
    """Group exact-timed words into sentence-ish segments (pause or end-punct)."""
    segs: list[dict] = []
    cur: list[dict] = []

    def flush():
        if cur:
            segs.append({"start": cur[0]["start"], "end": cur[-1]["end"],
                         "text": " ".join(x["text"] for x in cur)})

    for i, w in enumerate(words):
        if cur:
            pause = w["start"] - cur[-1]["end"]
            prev_end_punct = cur[-1]["text"].endswith(_SENT_END)
            if pause > gap or prev_end_punct:
                flush()
                cur = []
        cur.append(w)
    flush()
    return segs


def build_segments_and_words(data: dict) -> tuple[list[Segment], list[Word]]:
    """Turn a Scribe response into the editor's Segment + Word dataclasses,
    using Scribe's EXACT per-word times (no interpolation)."""
    sw = parse_scribe_words(data)
    seg_dicts = words_to_segments(sw)
    segments = [Segment(id=i, start=round(s["start"], 3), end=round(s["end"], 3),
                        text=s["text"], tight_in=round(s["start"], 3),
                        tight_out=round(s["end"], 3))
                for i, s in enumerate(seg_dicts)]

    # Assign each word to the segment whose [start,end] contains it.
    words: list[Word] = []
    si = 0
    for wi, w in enumerate(sw):
        while si + 1 < len(segments) and w["start"] >= segments[si + 1].start:
            si += 1
        seg_id = segments[si].id if segments else 0
        words.append(Word(id=wi, text=w["text"], start=w["start"], end=w["end"],
                          segment_id=seg_id))
    return segments, words


# ── The API call ───────────────────────────────────────────────

async def transcribe(
    source_path: str | Path,
    *,
    language_code: Optional[str] = None,
    model_id: str = DEFAULT_MODEL,
    force: bool = False,
) -> dict:
    """Transcribe a clip with Scribe; cache by content fingerprint.

    Returns the raw Scribe JSON (parse with build_segments_and_words). Extracts a
    small 16 kHz mono wav first so we upload audio, not the whole HEVC video.
    Raises :class:`ScribeError` (missing key / HTTP failure) with a clear message.
    """
    src = Path(source_path)
    if not src.exists():
        raise ScribeError(f"Source clip not found: {src}")

    key = get_api_key()
    if not key:
        raise ScribeError(
            "No ElevenLabs API key set. Add it in Settings (or set the "
            "ELEVENLABS_API_KEY environment variable)."
        )

    cache_dir = get_settings().DATA_DIR / "review" / "scribe"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache = cache_dir / f"{fingerprint_short(src, 16)}_{model_id}.json"
    if cache.exists() and not force:
        try:
            return json.loads(cache.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            pass

    # Extract a compact wav for upload (audio-only; cheap, codec-agnostic).
    wav = cache_dir / f"{fingerprint_short(src, 16)}.wav"
    try:
        if not wav.exists():
            extract_audio(src, wav, sample_rate=16000)
    except Exception as exc:  # noqa: BLE001
        raise ScribeError(f"Couldn't extract audio for Scribe: {exc}") from exc

    try:
        import httpx
    except Exception as exc:  # noqa: BLE001
        raise ScribeError(f"httpx not available: {exc}") from exc

    form = {"model_id": model_id, "timestamps_granularity": "word", "diarize": "false"}
    if language_code:
        form["language_code"] = language_code

    try:
        async with httpx.AsyncClient(timeout=1800) as client:
            with open(wav, "rb") as fh:
                resp = await client.post(
                    SCRIBE_ENDPOINT,
                    headers={"xi-api-key": key},
                    data=form,
                    files={"file": (wav.name, fh, "audio/wav")},
                )
    except Exception as exc:  # noqa: BLE001
        raise ScribeError(f"Scribe request failed: {exc}") from exc

    if resp.status_code != 200:
        raise ScribeError(f"Scribe API {resp.status_code}: {resp.text[:300]}")

    try:
        data = resp.json()
    except Exception as exc:  # noqa: BLE001
        raise ScribeError(f"Scribe returned non-JSON: {exc}") from exc

    # Multi-channel responses wrap transcripts in a list — take the first.
    if isinstance(data, dict) and "transcripts" in data and isinstance(data["transcripts"], list) and data["transcripts"]:
        data = data["transcripts"][0]

    try:
        cache.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        logger.debug("scribe: cache write failed: %s", exc)
    return data
