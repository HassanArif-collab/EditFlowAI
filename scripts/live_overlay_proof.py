"""Live production-path proof: exercise POST /api/captions/* exactly as the
panel does (same payloads, absolute spaced paths on disk), then verify the
artifacts. Run: python scripts/live_overlay_proof.py (backend must be up).
"""
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8765"


def post(path, payload, timeout=900):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def main():
    d = json.load(open("data/media_cache/mixdowns/0e93d55a92e091de.transcript.json"))
    words = [{"text": w["word"], "start": w["start"], "end": w["end"]}
             for s in d["segments"] for w in s["words"]]
    print("words:", len(words))

    cues = post("/api/captions/cues", {"words": words})["cues"]
    print("cues:", len(cues))

    srt = post("/api/captions/srt", {"cues": cues, "name": "proof"})
    assert Path(srt["srt_path"]).exists(), "srt file missing"
    print("srt ok:", srt["srt_path"])

    ov = post("/api/captions/overlay",
              {"cues": cues, "name": "proof", "preset": "fade"},
              timeout=900)
    mov = Path(ov["mov_path"])
    assert mov.exists() and mov.stat().st_size > 1_000_000, "mov missing/small"
    print("mov ok:", mov, mov.stat().st_size)

    ff = "data/tools/ffmpeg-8.1.1-full_build/bin/ffmpeg.exe"
    out = Path("data/output/captions/proof-frame.png")
    p = subprocess.run(
        [ff, "-hide_banner", "-y", "-ss", "2.0", "-i", str(mov),
         "-frames:v", "1", "-update", "1", str(out)],
        capture_output=True)
    assert p.returncode == 0 and out.exists(), "frame extract failed"
    from PIL import Image
    h = Image.open(out).convert("L").histogram()
    bright = sum(h[200:])
    print("frame bright px:", bright)
    assert bright > 1000, "caption text not visible in rendered frame"
    print("PROOF COMPLETE: cues+srt+overlay+frame all green on live server")


if __name__ == "__main__":
    sys.exit(main() or 0)
