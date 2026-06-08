"""Render an actual playable cut video for a proposer, plus a readable plan.

Runs a proposer on the fixture, merges the kept segments into time ranges, writes
the plan (timecode + beat + text) to a .txt, and uses ffmpeg to cut+concat the
proxy into a real .mp4 you can play. Outputs land in experiments/preview/.

  python -m experiments.render_cut a8_safe --llm
  python -m experiments.render_cut baseline --llm
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import tempfile

from experiments.eval import load_segments, FIXTURES, BEATS, _beat_match
from experiments.proposers import REGISTRY

FFMPEG = os.path.join("data", "tools", "ffmpeg-8.1.1-full_build", "bin", "ffmpeg.exe")
OUT_DIR = os.path.join("experiments", "preview")


def _fmt(t):
    m, s = divmod(int(t), 60)
    return f"{m}:{s:02d}"


def _beat_of(text):
    for b, sigs in BEATS.items():
        if _beat_match(text, sigs):
            return b
    return "—"


def _word_spans(fixture):
    """seg_id -> (first_word_start, last_word_end) — true speech bounds, no silence."""
    words = json.load(open(fixture, encoding="utf-8")).get("words", [])
    spans = {}
    for w in words:
        sid = w.get("segment_id")
        s, e = w.get("start"), w.get("end")
        if sid is None or s is None or e is None:
            continue
        lo, hi = spans.get(sid, (s, e))
        spans[sid] = (min(lo, s), max(hi, e))
    return spans


def merge_ranges(kept, gap=0.4, fixture=None, pad=0.04):
    """Merge time-adjacent kept segments into [in,out] ranges. When `fixture` is
    given, each segment is trimmed to its WORD span (drops leading/trailing
    silence) and a tighter gap is used so silent gaps aren't bridged."""
    wspans = _word_spans(fixture) if fixture else {}
    bounds = []
    for s in kept:
        if s.id in wspans:
            a, b = wspans[s.id]
            a, b = max(0, a - pad), b + pad
        else:
            a, b = (s.tight_in or s.start), (s.tight_out or s.end)
        bounds.append((a, b, s))
    bounds.sort(key=lambda x: x[0])
    g = 0.12 if fixture else gap
    ranges, cur = [], None
    for a, b, s in bounds:
        if cur and a - cur[1] <= g:
            cur[1] = max(cur[1], b)
            cur[2].append(s)
        else:
            if cur:
                ranges.append(cur)
            cur = [a, b, [s]]
    if cur:
        ranges.append(cur)
    return ranges


def render(name, use_llm):
    fixture = FIXTURES[0]
    proxy = json.load(open(fixture, encoding="utf-8")).get("proxy_path")
    segs, script = load_segments(fixture)
    res = REGISTRY[name](segs, script, use_llm=use_llm)
    if asyncio.iscoroutine(res):
        asyncio.run(res)
    kept = [s for s in segs if s.decision == "keep"]
    ranges = merge_ranges(kept, fixture=fixture)   # word-tight: trims silences

    os.makedirs(OUT_DIR, exist_ok=True)
    # plan text
    lines = [f"=== {name}{' +LLM' if use_llm else ''} — {len(kept)} kept, {len(ranges)} ranges, "
             f"runtime {_fmt(sum(b-a for a,b,_ in ranges))} ==="]
    for s in kept:
        lines.append(f"{_fmt(s.tight_in or s.start):>5} | {_beat_of(s.text):<12} | {s.text}")
    plan_path = os.path.join(OUT_DIR, f"{name}_plan.txt")
    open(plan_path, "w", encoding="utf-8").write("\n".join(lines))

    # render: extract each range (re-encode for frame-accurate cuts), then concat
    if not os.path.exists(proxy):
        print(f"proxy missing: {proxy}"); return plan_path, None
    tmp = tempfile.mkdtemp()
    parts = []
    for i, (a, b, _) in enumerate(ranges):
        part = os.path.join(tmp, f"p{i:03d}.mp4")
        subprocess.run([FFMPEG, "-y", "-ss", f"{a:.3f}", "-to", f"{b:.3f}", "-i", proxy,
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                        "-c:a", "aac", "-avoid_negative_ts", "make_zero", part],
                       check=True, capture_output=True)
        parts.append(part)
    listf = os.path.join(tmp, "list.txt")
    open(listf, "w", encoding="utf-8").write("\n".join(f"file '{p}'" for p in parts))
    out_mp4 = os.path.join(OUT_DIR, f"{name}_cut.mp4")
    subprocess.run([FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", listf,
                    "-c", "copy", out_mp4], check=True, capture_output=True)
    return plan_path, out_mp4


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("name")
    ap.add_argument("--llm", action="store_true")
    a = ap.parse_args()
    plan, mp4 = render(a.name, a.llm)
    print("PLAN:", plan)
    print("VIDEO:", mp4)
