"""Cut-plan evaluation harness.

Scores a 'proposer' (a function that sets keep/cut on segments) against a fixture,
using TASTE-LIGHT metrics anchored on the user's English script (the ground truth
of *intended* content). No human labels needed, so it runs unattended.

Metrics (per fixture):
  - beat_coverage : of the script's beats, how many are covered by >=1 kept seg  (want all)
  - redundancy    : beats covered by >=2 kept segs  (repetitions — want 0)
  - orphans       : kept segs that match NO beat     (junk/fragments/off-topic — want low)
  - fragments     : kept segs that are <=2 content words, or contain '--', or are
                    bracketed non-speech  (want 0)
  - dup_pairs     : kept pairs with token-containment >= 0.6  (near-duplicates — want 0)
  - kept / runtime: count + total kept seconds (info)
  - composite     : single comparable number (higher = better); weights documented below.

Usage:
  python experiments/eval.py                 # score every registered proposer, print table
  python experiments/eval.py --proposer NAME # score one
  python experiments/eval.py --llm --runs 3  # include the LLM stage, average N runs
"""
from __future__ import annotations

import argparse
import asyncio
import glob
import json
import os
import re
import time
from itertools import combinations

from backend.services.review_service import Segment, _tokens, _token_containment, _is_bracketed_nonspeech

FIXTURES = sorted(glob.glob(os.path.join(os.path.dirname(__file__), "fixtures", "*.json")))

# ── Script beats: each must be delivered ONCE by a clean kept take. A beat is
# "matched" by a segment when ALL of its `need` substrings appear in the segment
# text. Keywords drawn from BOTH the Urdu transcript and the English script, so
# the check is language-aware without needing cross-lingual embeddings. ──
BEATS = {
    "income_10x":   [["دس گنا"]],                              # "10x the income"
    "intro_invest": [["جاوید"], ["invest"], ["startup", "tech"]],  # "I'm Javed / invested in a tech startup"
    "wealth":       [["ہزار کروڑ", "پاس"], ["ہزار کروڑ", "بیچنے"]],  # "now worth N-thousand crore"
    "loan_tax":     [["loan", "فیصد"], ["loan", "ٹیکس"]],       # "2% loan / tax-free"
    "growth":       [["percent"], ["growth"], ["بڑھتے"]],        # "portfolio grows faster"
    "house":        [["کنال"], ["bedroom"], ["بنگلہ"]],          # "four-kanal estate / six bedrooms"
    "amenities":    [["pool"], ["garden"], ["basement"]],       # "pool, garden, basement"
    "seven_homes":  [["سات گھر"], ["دبئی"], ["seven"]],          # "one of seven homes / Dubai"
}


def _beat_match(text: str, sigs: list[list[str]]) -> bool:
    """A beat matches if ANY of its signatures fully matches (all substrings present)."""
    t = text or ""
    return any(all(s in t for s in sig) for sig in sigs)


def _is_fragment(text: str) -> bool:
    t = (text or "").strip()
    if "--" in t:
        return True
    if _is_bracketed_nonspeech(t):
        return True
    # leading bracket cue + little else, or very few content words
    stripped = re.sub(r"[\[\(\{][^\]\)\}]*[\]\)\}]", " ", t)
    return len(_tokens(stripped)) <= 2


def score(segments: list[Segment], elapsed_ms: float) -> dict:
    kept = [s for s in segments if s.decision == "keep"]
    beat_hits = {b: 0 for b in BEATS}
    for s in kept:
        for b, sigs in BEATS.items():
            if _beat_match(s.text, sigs):
                beat_hits[b] += 1
    covered = sum(1 for b in beat_hits if beat_hits[b] >= 1)
    redundancy = sum(1 for b in beat_hits if beat_hits[b] >= 2)
    matched_any = [s for s in kept if any(_beat_match(s.text, sigs) for sigs in [BEATS[b] for b in BEATS])]
    orphans = len(kept) - len(matched_any)
    fragments = sum(1 for s in kept if _is_fragment(s.text))
    dup_pairs = 0
    for a, b in combinations(kept, 2):
        ta, tb = _tokens(a.text), _tokens(b.text)
        if min(len(set(ta)), len(set(tb))) >= 3 and _token_containment(ta, tb) >= 0.6:
            dup_pairs += 1
    runtime = sum((s.tight_out or s.end) - (s.tight_in or s.start) for s in kept)
    # Composite (higher is better). Weights documented; consistent across approaches.
    composite = (covered * 10) - (redundancy * 12) - (orphans * 6) - (fragments * 6) - (dup_pairs * 8)
    return {
        "kept": len(kept), "covered_beats": covered, "total_beats": len(BEATS),
        "redundancy": redundancy, "orphans": orphans, "fragments": fragments,
        "dup_pairs": dup_pairs, "runtime_s": round(runtime, 1),
        "elapsed_ms": round(elapsed_ms, 1), "composite": composite,
        "missing_beats": [b for b in beat_hits if beat_hits[b] == 0],
    }


def load_segments(fixture: str) -> tuple[list[Segment], str]:
    d = json.load(open(fixture, encoding="utf-8"))
    segs = [Segment(id=s["id"], start=s["start"], end=s["end"], text=s["text"],
                    tight_in=s.get("tight_in", 0), tight_out=s.get("tight_out", 0))
            for s in d["segments"]]
    return segs, d.get("script", "") or ""


async def run_proposer(prop, fixture: str, use_llm: bool, runs: int) -> dict:
    """Run a proposer (sync or async) `runs` times; average the numeric scores.
    Deterministic proposers are stable, so they run once."""
    n = runs if use_llm else 1
    numeric: dict[str, list] = {}
    last: dict = {}
    for _ in range(n):
        segs, script = load_segments(fixture)
        s0 = time.time()
        res = prop(segs, script, use_llm=use_llm)
        if asyncio.iscoroutine(res):
            await res
        sc = score(segs, (time.time() - s0) * 1000)
        last = sc
        for k, v in sc.items():
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                numeric.setdefault(k, []).append(v)
    out = dict(last)  # keep non-numeric fields (e.g. missing_beats) from the last run
    for k, vals in numeric.items():
        out[k] = round(sum(vals) / len(vals), 2)
    out["_runs"] = n
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--proposer", default=None)
    ap.add_argument("--llm", action="store_true")
    ap.add_argument("--runs", type=int, default=3)
    args = ap.parse_args()

    from experiments.proposers import REGISTRY
    names = [args.proposer] if args.proposer else list(REGISTRY)
    rows = []
    for name in names:
        prop = REGISTRY[name]
        for fx in FIXTURES:
            res = asyncio.run(run_proposer(prop, fx, args.llm, args.runs))
            res["proposer"] = name
            res["fixture"] = os.path.basename(fx)
            rows.append(res)
            tag = "+LLM" if args.llm else "det"
            print(f"[{name} {tag}] {os.path.basename(fx)}: composite={res['composite']} "
                  f"kept={res['kept']} cov={res['covered_beats']}/{res['total_beats']} "
                  f"redun={res['redundancy']} orphan={res['orphans']} frag={res['fragments']} "
                  f"dup={res['dup_pairs']} miss={res.get('missing_beats')}")
    out_path = os.path.join(os.path.dirname(__file__), "results",
                            f"_last_{'llm' if args.llm else 'det'}.json")
    json.dump(rows, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"\nwrote {out_path}")


if __name__ == "__main__":
    main()
