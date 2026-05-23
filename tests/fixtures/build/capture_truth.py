"""Run the currently-configured Whisper engine on interview_short.wav and
write the *actual* transcription output as a versioned snapshot.

This script is the bridge between the **canonical** (hand-authored, what we
*intended* the audio to say) and the **snapshot** (machine-generated, what
Whisper *actually* produced on a given machine + engine + model revision).

Phase B+ tests compare:
  * canonical vs snapshot     → tracks transcription accuracy (WER)
  * snapshot vs new run       → tracks engine drift across model upgrades
  * canonical vs deterministic pipeline output → tracks our own bugs

Outputs:
  snapshots/whisper.snapshot.json  — full transcript with word timestamps
  snapshots/vad.snapshot.json      — silero-vad output (if silero-vad installed)
  snapshots/RESULTS.md             — summary numbers (WER, timing drift)

Engine selection:
  1. whisperX        (best timing accuracy, requires pip install whisperx)
  2. stable-ts       (mid)
  3. faster-whisper  (fallback, the engine we already use)

Usage:
    python tests/fixtures/build/capture_truth.py
    python tests/fixtures/build/capture_truth.py --engine faster-whisper
    python tests/fixtures/build/capture_truth.py --model large-v3-turbo

WARNING: First run with a model that hasn't been downloaded will pull
several gigabytes from HuggingFace. Run on a machine that's allowed to.
"""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import sys
import time
from pathlib import Path
from typing import Any, Optional

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_WAV = REPO_ROOT / "tests" / "fixtures" / "short" / "interview_short.wav"
CANONICAL = REPO_ROOT / "tests" / "fixtures" / "short" / "canonical.json"
SNAP_DIR = REPO_ROOT / "tests" / "fixtures" / "snapshots"
WHISPER_SNAP = SNAP_DIR / "whisper.snapshot.json"
VAD_SNAP = SNAP_DIR / "vad.snapshot.json"
RESULTS_MD = SNAP_DIR / "RESULTS.md"


def _engine_whisperx(model_name: str, device: str) -> Optional[dict]:
    try:
        import whisperx
    except ImportError:
        return None
    import torch  # whisperx requires it
    print(f"  engine: whisperx (model={model_name}, device={device})")
    model = whisperx.load_model(model_name, device, compute_type="int8" if device == "cpu" else "float16")
    audio = whisperx.load_audio(str(FIXTURE_WAV))
    t0 = time.time()
    result = model.transcribe(audio, batch_size=8)
    align_model, metadata = whisperx.load_align_model(language_code=result["language"], device=device)
    aligned = whisperx.align(result["segments"], align_model, metadata, audio, device, return_char_alignments=False)
    elapsed = time.time() - t0
    words = []
    for seg in aligned["segments"]:
        for w in seg.get("words", []):
            if "start" not in w or "end" not in w:
                continue
            words.append({
                "text": w["word"].strip(),
                "start": round(float(w["start"]), 3),
                "end": round(float(w["end"]), 3),
                "prob": round(float(w.get("score", 0.0)), 3),
            })
    return {
        "engine": "whisperx",
        "model": model_name,
        "device": device,
        "language": result.get("language", "en"),
        "elapsed_s": round(elapsed, 2),
        "words": words,
    }


def _engine_stable_ts(model_name: str, device: str) -> Optional[dict]:
    try:
        import stable_whisper  # noqa: F401  (package import is stable_whisper)
    except ImportError:
        return None
    import stable_whisper
    print(f"  engine: stable-ts (model={model_name}, device={device})")
    model = stable_whisper.load_faster_whisper(model_name, device=device, compute_type="int8" if device == "cpu" else "float16")
    t0 = time.time()
    result = model.transcribe(str(FIXTURE_WAV), word_timestamps=True, vad=True)
    elapsed = time.time() - t0
    words = []
    for seg in result.segments:
        for w in (seg.words or []):
            words.append({
                "text": w.word.strip(),
                "start": round(float(w.start), 3),
                "end": round(float(w.end), 3),
                "prob": round(float(getattr(w, "probability", 0.0)), 3),
            })
    return {
        "engine": "stable-ts",
        "model": model_name,
        "device": device,
        "language": result.language,
        "elapsed_s": round(elapsed, 2),
        "words": words,
    }


def _engine_faster_whisper(model_name: str, device: str) -> Optional[dict]:
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return None
    print(f"  engine: faster-whisper (model={model_name}, device={device})")
    model = WhisperModel(model_name, device=device, compute_type="int8" if device == "cpu" else "float16")
    t0 = time.time()
    segments, info = model.transcribe(str(FIXTURE_WAV), word_timestamps=True, vad_filter=True, beam_size=5)
    words = []
    for seg in segments:
        for w in (seg.words or []):
            words.append({
                "text": w.word.strip(),
                "start": round(float(w.start), 3),
                "end": round(float(w.end), 3),
                "prob": round(float(w.probability or 0.0), 3),
            })
    elapsed = time.time() - t0
    return {
        "engine": "faster-whisper",
        "model": model_name,
        "device": device,
        "language": info.language,
        "elapsed_s": round(elapsed, 2),
        "words": words,
    }


def _vad_silero() -> Optional[dict]:
    try:
        import torch
        import torchaudio
        from silero_vad import load_silero_vad, read_audio, get_speech_timestamps
    except ImportError:
        return None
    print("  vad: silero-vad")
    model = load_silero_vad()
    wav = read_audio(str(FIXTURE_WAV), sampling_rate=16000)
    ts = get_speech_timestamps(wav, model, sampling_rate=16000, return_seconds=True)
    segments = []
    last = 0.0
    for s in ts:
        if s["start"] > last + 0.05:
            segments.append({"kind": "silence", "source_start": round(last, 3),
                             "source_end": round(s["start"], 3)})
        segments.append({"kind": "speech", "source_start": round(s["start"], 3),
                         "source_end": round(s["end"], 3)})
        last = s["end"]
    # tail silence
    # we don't know exact duration here; ffprobe call would be more work — skip closing tail
    return {"engine": "silero-vad", "segments": segments}


# ── WER + timing diff against canonical ──

def _normalize(text: str) -> str:
    return "".join(c.lower() if c.isalnum() else " " for c in text).strip()


def _word_list(canon: dict) -> list[str]:
    out = []
    for take in canon["takes"]:
        for w in take["words"]:
            out.append(_normalize(w["text"]))
    return [w for w in out if w]


def _snap_words(snap: dict) -> list[str]:
    return [_normalize(w["text"]) for w in snap["words"] if _normalize(w["text"])]


def _wer(reference: list[str], hypothesis: list[str]) -> dict:
    """Compute word error rate via classic edit distance."""
    R, H = len(reference), len(hypothesis)
    if R == 0:
        return {"wer": 0.0 if H == 0 else 1.0, "ins": H, "del": 0, "sub": 0, "ref_len": 0, "hyp_len": H}
    dp = [[0] * (H + 1) for _ in range(R + 1)]
    for i in range(R + 1):
        dp[i][0] = i
    for j in range(H + 1):
        dp[0][j] = j
    for i in range(1, R + 1):
        for j in range(1, H + 1):
            if reference[i - 1] == hypothesis[j - 1]:
                dp[i][j] = dp[i - 1][j - 1]
            else:
                dp[i][j] = 1 + min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
    # Walk back to count S/I/D
    i, j = R, H
    s = ins = dele = 0
    while i > 0 and j > 0:
        if reference[i - 1] == hypothesis[j - 1]:
            i -= 1; j -= 1
        elif dp[i][j] == dp[i - 1][j - 1] + 1:
            s += 1; i -= 1; j -= 1
        elif dp[i][j] == dp[i][j - 1] + 1:
            ins += 1; j -= 1
        else:
            dele += 1; i -= 1
    ins += j
    dele += i
    return {
        "wer": round(dp[R][H] / R, 4),
        "ins": ins, "del": dele, "sub": s,
        "ref_len": R, "hyp_len": H,
    }


def _timing_drift_p95(canonical: dict, snap: dict) -> Optional[dict]:
    """Match snapshot words to canonical words by sequential alignment (after
    normalising). Return absolute timing drift in ms, p50/p95/max."""
    canon_words = []
    for take in canonical["takes"]:
        for w in take["words"]:
            canon_words.append((_normalize(w["text"]), w["start"], w["end"]))
    snap_words = [(_normalize(w["text"]), w["start"], w["end"]) for w in snap["words"]]
    canon_words = [c for c in canon_words if c[0]]
    snap_words = [s for s in snap_words if s[0]]
    if not canon_words or not snap_words:
        return None
    # naive sequential align: walk both lists, match where words are equal
    drifts = []
    i = j = 0
    while i < len(canon_words) and j < len(snap_words):
        if canon_words[i][0] == snap_words[j][0]:
            drifts.append(abs(canon_words[i][1] - snap_words[j][1]) * 1000)
            i += 1; j += 1
        else:
            # try to skip ahead in snapshot
            j += 1
    if not drifts:
        return None
    drifts.sort()
    n = len(drifts)
    return {
        "p50_ms": round(drifts[n // 2], 1),
        "p95_ms": round(drifts[min(int(n * 0.95), n - 1)], 1),
        "max_ms": round(drifts[-1], 1),
        "matched_words": n,
        "ref_words": len(canon_words),
    }


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--engine", choices=["auto", "whisperx", "stable-ts", "faster-whisper"], default="auto")
    p.add_argument("--model", default="large-v3-turbo")
    p.add_argument("--device", default="cpu", help="cpu | cuda")
    args = p.parse_args()

    if not FIXTURE_WAV.exists():
        print(f"missing fixture: {FIXTURE_WAV}", file=sys.stderr)
        print("run `python tests/fixtures/build/build_short_tts.py` first", file=sys.stderr)
        return 1

    SNAP_DIR.mkdir(parents=True, exist_ok=True)

    print(f"capturing snapshot for {FIXTURE_WAV.name}")

    engines = (
        ["whisperx", "stable-ts", "faster-whisper"] if args.engine == "auto"
        else [args.engine]
    )
    transcript = None
    for eng in engines:
        if eng == "whisperx":
            transcript = _engine_whisperx(args.model, args.device)
        elif eng == "stable-ts":
            transcript = _engine_stable_ts(args.model, args.device)
        elif eng == "faster-whisper":
            transcript = _engine_faster_whisper(args.model, args.device)
        if transcript is not None:
            break

    if transcript is None:
        print("no transcription engine available. Install one of:", file=sys.stderr)
        print("  pip install whisperx", file=sys.stderr)
        print("  pip install stable-ts", file=sys.stderr)
        print("  pip install faster-whisper", file=sys.stderr)
        return 2

    # Add provenance
    try:
        engine_version = importlib.metadata.version(transcript["engine"].replace("-", "_"))
    except importlib.metadata.PackageNotFoundError:
        engine_version = "unknown"
    transcript["engine_version"] = engine_version

    WHISPER_SNAP.write_text(json.dumps(transcript, indent=2), encoding="utf-8")
    print(f"wrote {WHISPER_SNAP}")

    vad = _vad_silero()
    if vad is not None:
        VAD_SNAP.write_text(json.dumps(vad, indent=2), encoding="utf-8")
        print(f"wrote {VAD_SNAP}")
    else:
        print("silero-vad not installed; skipping vad snapshot")

    # WER + timing drift vs canonical
    canonical = json.loads(CANONICAL.read_text(encoding="utf-8"))
    wer = _wer(_word_list(canonical), _snap_words(transcript))
    drift = _timing_drift_p95(canonical, transcript)

    lines = [
        f"# Snapshot Results (auto-generated by capture_truth.py)",
        "",
        f"- Fixture: `{FIXTURE_WAV.name}`",
        f"- Engine: `{transcript['engine']}` v{transcript['engine_version']}",
        f"- Model: `{transcript['model']}` on {transcript['device']}",
        f"- Detected language: `{transcript['language']}`",
        f"- Transcription wall time: {transcript['elapsed_s']} s",
        f"- Word count (ref / hyp): {wer['ref_len']} / {wer['hyp_len']}",
        f"- **WER: {wer['wer'] * 100:.2f} %** ({wer['sub']} sub, {wer['ins']} ins, {wer['del']} del)",
    ]
    if drift:
        lines += [
            f"- **Timing drift** p50/p95/max: {drift['p50_ms']} / {drift['p95_ms']} / {drift['max_ms']} ms",
            f"  (over {drift['matched_words']}/{drift['ref_words']} matched words)",
        ]
    if vad:
        lines.append(f"- VAD segments: {len(vad['segments'])}")
    lines += [
        "",
        "## Thresholds",
        "",
        "Phase B tests will fail if any of these are exceeded:",
        "- WER > 5.00 %",
        "- Timing drift p95 > 200 ms (whisperX), 350 ms (stable-ts), 500 ms (faster-whisper)",
        "",
        "If a threshold is exceeded, either:",
        "1. The audio fixture changed (run `build_short_tts.py` and re-capture).",
        "2. Whisper/whisperX/etc. accuracy regressed in a new release.",
        "3. The system is genuinely broken (most actionable case).",
    ]
    RESULTS_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {RESULTS_MD}")
    print()
    print(f"summary: WER={wer['wer'] * 100:.2f}%", end="")
    if drift:
        print(f", drift p95={drift['p95_ms']:.1f}ms", end="")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
