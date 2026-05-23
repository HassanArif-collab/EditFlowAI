"""Pytest fixtures + helpers for the take-based editor test suite.

Import-only (no I/O at import time). Tests opt into specific fixtures and the
loader caches them lazily so multiple tests sharing a fixture pay the JSON
parse cost once.

Usage in a test file:

    from tests.fixtures.conftest import load_fixture, wer

    def test_segmenter_matches_expected_takes():
        fx = load_fixture("short")
        actual = segmenter.segment(fx.canonical["takes"][0]["words"])
        assert actual == fx.expected_takes["takes"]
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

FIXTURES_DIR = Path(__file__).resolve().parent


@dataclass(frozen=True)
class Fixture:
    name: str
    base_dir: Path
    spec_md: str
    canonical: dict
    expected_takes: dict
    expected_plans: dict[str, dict]  # script_id -> plan
    scripts: dict[str, str]          # script_id -> text
    wav_path: Optional[Path]
    whisper_snapshot: Optional[dict]
    vad_snapshot: Optional[dict]


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@lru_cache(maxsize=8)
def load_fixture(name: str) -> Fixture:
    """Load every artifact for a named fixture (e.g. 'short')."""
    base = FIXTURES_DIR / name
    if not base.is_dir():
        raise FileNotFoundError(f"no such fixture directory: {base}")

    canonical = _load_json(base / "canonical.json")
    expected_takes = _load_json(base / "takes.expected.json")

    expected_plans: dict[str, dict] = {}
    scripts: dict[str, str] = {}
    for plan_path in sorted(base.glob("plan_*.expected.json")):
        plan = _load_json(plan_path)
        expected_plans[plan["script_id"]] = plan
    for script_path in sorted(base.glob("script_*.txt")):
        scripts[script_path.stem] = script_path.read_text(encoding="utf-8")

    wav_path = base / f"interview_{name}.wav"
    if not wav_path.exists():
        # try the alternate (structural) wav name
        alt = base / f"interview_{name}_structural.wav"
        wav_path = alt if alt.exists() else None

    snap_dir = FIXTURES_DIR / "snapshots"
    whisper_snap_path = snap_dir / "whisper.snapshot.json"
    vad_snap_path = snap_dir / "vad.snapshot.json"
    whisper_snap = _load_json(whisper_snap_path) if whisper_snap_path.exists() else None
    vad_snap = _load_json(vad_snap_path) if vad_snap_path.exists() else None

    spec_md = (base / "spec.md").read_text(encoding="utf-8") if (base / "spec.md").exists() else ""

    return Fixture(
        name=name,
        base_dir=base,
        spec_md=spec_md,
        canonical=canonical,
        expected_takes=expected_takes,
        expected_plans=expected_plans,
        scripts=scripts,
        wav_path=wav_path,
        whisper_snapshot=whisper_snap,
        vad_snapshot=vad_snap,
    )


# ── WER / timing helpers shared between capture_truth.py and tests ──

def normalize_word(s: str) -> str:
    return "".join(c.lower() if c.isalnum() else "" for c in s)


def flatten_canonical_words(canonical: dict) -> list[dict]:
    """Get the canonical's word list, sorted by source_start."""
    out = []
    for take in canonical["takes"]:
        for w in take["words"]:
            out.append({
                "text": normalize_word(w["text"]),
                "start": float(w["start"]),
                "end": float(w["end"]),
                "is_filler": bool(w.get("is_filler", False)),
            })
    out.sort(key=lambda w: w["start"])
    return [w for w in out if w["text"]]


def wer(reference: list[str], hypothesis: list[str]) -> dict:
    """Levenshtein-based WER. Returns dict with wer, sub, ins, del, ref_len, hyp_len."""
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
        "wer": dp[R][H] / R,
        "ins": ins, "del": dele, "sub": s,
        "ref_len": R, "hyp_len": H,
    }


def timing_drift_ms(canonical: dict, snapshot: dict) -> list[float]:
    """Aligned timing drifts between canonical and snapshot, in ms.
    Sequential match by normalised word."""
    canon = flatten_canonical_words(canonical)
    snap = [
        {"text": normalize_word(w["text"]), "start": float(w["start"])}
        for w in snapshot.get("words", [])
        if normalize_word(w["text"])
    ]
    drifts: list[float] = []
    i = j = 0
    while i < len(canon) and j < len(snap):
        if canon[i]["text"] == snap[j]["text"]:
            drifts.append(abs(canon[i]["start"] - snap[j]["start"]) * 1000)
            i += 1; j += 1
        else:
            j += 1
    return drifts
