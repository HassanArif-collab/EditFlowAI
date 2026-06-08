"""Phrase-level take COMPING — assemble the clean script by stitching the best
verbatim phrases from across takes (good opening from take A + good body from
take B), using word timestamps to cut at phrase boundaries.

  python -m experiments.comp
Outputs experiments/preview/comp_plan.txt + comp_cut.mp4
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import tempfile

from backend.services.provider_service import provider_service
from backend.services.review_service import _normalize

FIX = os.path.join("experiments", "fixtures", "jawaid_66seg.json")
FF = os.path.join("data", "tools", "ffmpeg-8.1.1-full_build", "bin", "ffmpeg.exe")
OUT = os.path.join("experiments", "preview")

_d = json.load(open(FIX, encoding="utf-8"))
SCRIPT = _d["script"]; PROXY = _d["proxy_path"]; SEGS = _d["segments"]
WORDS_BY_SEG: dict[int, list] = {}
for _w in _d["words"]:
    WORDS_BY_SEG.setdefault(_w["segment_id"], []).append(_w)

HEADER = (
    "You are a video editor assembling a CLEAN FINAL CUT that delivers the SCRIPT.\n"
    "The speaker recorded many retakes. Often the GOOD opening of a sentence is in one take and the\n"
    "GOOD rest is in another take (one take stumbles partway; a later take nails the rest).\n\n"
    "Assemble the cleanest delivery of the SCRIPT by stitching verbatim phrases from the transcript.\n"
    "Rules:\n"
    "- Output pieces IN SCRIPT ORDER.\n"
    "- Each piece = a segment id + the EXACT verbatim phrase copied from that segment's text "
    "(copy the Urdu characters exactly; do NOT paraphrase, translate, or fix).\n"
    "- You MAY split a sentence: take its first half from one take and its second half from another, "
    "to avoid a stumble.\n"
    "- Use each piece of content ONCE — no repeated lines / retakes of the same point.\n"
    "- Skip false starts (phrases with '--'), filler, and [non-speech].\n"
    "- Cover every script line that was actually delivered.\n\n"
    'Output STRICT JSON only: {"cut":[{"seg":<id>,"text":"<verbatim phrase from that segment>"}, ...]}'
)


def build_prompt():
    p = [HEADER, "", "=== SCRIPT ===", SCRIPT, "", "=== TRANSCRIPT (segment_id | text) ==="]
    p += [f"{s['id']} | {s['text']}" for s in SEGS]
    p += ["", "Output only the JSON object."]
    return "\n".join(p)


def locate(phrase, seg_id):
    """Find the time span of `phrase` inside segment `seg_id`'s words (subsequence
    match on normalized tokens; from first to last matched word)."""
    sw = WORDS_BY_SEG.get(int(seg_id), [])
    pt = _normalize(phrase).split()
    if not sw or not pt:
        return None
    wt = [_normalize(w["text"]) for w in sw]
    first = last = None; k = 0
    for idx, tok in enumerate(wt):
        if k < len(pt) and tok == pt[k]:
            if first is None:
                first = idx
            last = idx; k += 1
    if first is not None and k >= max(1, len(pt) * 0.5):
        return sw[first]["start"], sw[last]["end"]
    return sw[0]["start"], sw[-1]["end"]   # fallback: whole segment


async def main():
    raw = await provider_service.chat(
        messages=[{"role": "user", "content": build_prompt()}], temperature=0.0, max_tokens=4000)
    text = (raw or {}).get("response") or ""
    m = re.search(r"\{.*\}", text, re.S)
    pieces = (json.loads(m.group(0)).get("cut", []) if m else [])

    ranges, plan = [], []
    for p in pieces:
        sid, ph = p.get("seg"), (p.get("text") or "").strip()
        if sid is None or not ph:
            continue
        loc = locate(ph, sid)
        if loc and loc[1] > loc[0]:
            ranges.append((loc[0] - 0.04, loc[1] + 0.04))
            plan.append((loc[0], int(sid), ph))

    os.makedirs(OUT, exist_ok=True)
    lines = [f"=== COMP — {len(plan)} phrases, runtime "
             f"{int(sum(b-a for a,b in ranges)//60)}:{int(sum(b-a for a,b in ranges)%60):02d} ==="]
    for st, sid, ph in plan:
        lines.append(f"{int(st//60)}:{int(st%60):02d} | seg{sid:>2} | {ph}")
    open(os.path.join(OUT, "comp_plan.txt"), "w", encoding="utf-8").write("\n".join(lines))

    if not os.path.exists(PROXY):
        print("proxy missing"); return
    tmp = tempfile.mkdtemp(); parts = []
    for i, (a, b) in enumerate(ranges):
        part = os.path.join(tmp, f"p{i:03d}.mp4")
        subprocess.run([FF, "-y", "-ss", f"{max(0,a):.3f}", "-to", f"{b:.3f}", "-i", PROXY,
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                        "-c:a", "aac", "-avoid_negative_ts", "make_zero", part],
                       check=True, capture_output=True)
        parts.append(part)
    listf = os.path.join(tmp, "l.txt")
    open(listf, "w", encoding="utf-8").write("\n".join(f"file '{p}'" for p in parts))
    subprocess.run([FF, "-y", "-f", "concat", "-safe", "0", "-i", listf, "-c", "copy",
                    os.path.join(OUT, "comp_cut.mp4")], check=True, capture_output=True)
    print(f"PLAN: {OUT}/comp_plan.txt  VIDEO: {OUT}/comp_cut.mp4  phrases={len(plan)}")


if __name__ == "__main__":
    asyncio.run(main())
