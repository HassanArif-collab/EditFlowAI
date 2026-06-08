"""Phrase-level take COMPING — assemble the clean script by stitching the best
verbatim phrases from across takes (good opening from take A + good body from
take B), using word timestamps to cut at phrase boundaries.

  python -m experiments.comp
Outputs experiments/preview/comp_plan.txt + comp_cut.mp4
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import urllib.request

from backend.services.review_service import _normalize

MODEL = os.environ.get("COMP_MODEL", "gemma4:31b-cloud")   # stronger than minimax for comping


def ollama_chat(prompt, model=MODEL, timeout=300):
    body = json.dumps({"model": model, "messages": [{"role": "user", "content": prompt}],
                       "stream": False, "options": {"temperature": 0}}).encode()
    req = urllib.request.Request("http://localhost:11434/api/chat", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read()).get("message", {}).get("content", "")


def extract_json(text):
    """Pull the {...} object out of a reply that may have ```json fences / prose."""
    if not text:
        return None
    t = re.sub(r"```(?:json)?", "", text)
    depth = start = 0
    for i, ch in enumerate(t):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(t[start:i + 1])
                except Exception:
                    pass
    return None

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
    if first is None or k < max(1, len(pt) * 0.5):
        first, last = 0, len(sw) - 1            # fallback: whole segment
    # trim trailing/leading self-interrupt words (Scribe marks cut-offs with '-')
    while last > first and sw[last]["text"].rstrip().endswith("-"):
        last -= 1
    while first < last and sw[first]["text"].lstrip().startswith("-"):
        first += 1
    return sw[first]["start"], sw[last]["end"]


def render_pieces(pieces, name="comp", title="COMP"):
    """pieces: list of {seg,text} dicts or (seg, text) tuples. Locates each phrase
    in its segment's words, writes <name>_plan.txt and renders <name>_cut.mp4."""
    ranges, plan = [], []
    for p in pieces:
        sid = p.get("seg") if isinstance(p, dict) else p[0]
        ph = ((p.get("text") if isinstance(p, dict) else p[1]) or "").strip()
        if sid is None or not ph:
            continue
        loc = locate(ph, sid)
        if loc and loc[1] > loc[0]:
            ranges.append((loc[0] - 0.04, loc[1] + 0.04))
            plan.append((loc[0], int(sid), ph))
    os.makedirs(OUT, exist_ok=True)
    rt = sum(b - a for a, b in ranges)
    lines = [f"=== {title} — {len(plan)} phrases, runtime {int(rt//60)}:{int(rt%60):02d} ==="]
    for st, sid, ph in plan:
        lines.append(f"{int(st//60)}:{int(st%60):02d} | seg{sid:>2} | {ph}")
    open(os.path.join(OUT, f"{name}_plan.txt"), "w", encoding="utf-8").write("\n".join(lines))
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
                    os.path.join(OUT, f"{name}_cut.mp4")], check=True, capture_output=True)
    print(f"PLAN: {OUT}/{name}_plan.txt  VIDEO: {OUT}/{name}_cut.mp4  phrases={len(plan)}")


def main():
    os.makedirs(OUT, exist_ok=True)
    cache = os.path.join(OUT, "_comp_raw.txt")
    if os.environ.get("COMP_CACHE") and os.path.exists(cache):
        text = open(cache, encoding="utf-8").read()
    else:
        text = ollama_chat(build_prompt())
        open(cache, "w", encoding="utf-8").write(text)
    data = extract_json(text)
    pieces = (data.get("cut", []) if data else [])
    render_pieces(pieces, "comp", f"COMP ({MODEL})")


if __name__ == "__main__":
    main()
