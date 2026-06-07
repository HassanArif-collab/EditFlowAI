"""A5-LLM — SCRIPT-DRIVEN selection using the LLM as a cross-lingual MATCHER.

The LLM is bad at "decide what to cut" (it drops beats), but it's good at
cross-lingual understanding. So we use it for a grounded matching task: for each
SCRIPT line, which transcript segment(s) deliver it as a clean complete take?
Keep exactly those, in time order. The script grounds the model — every script
line must get a take, nothing off-script survives. Far more precise than the
384-dim embedding model.
"""
from __future__ import annotations

import json
import re

from backend.services.review_service import classify
from backend.services.provider_service import provider_service

_HEADER = (
    "You are assembling a clean final cut. Below is the intended SCRIPT (English) and "
    "the actual TRANSCRIPT of the recording (Urdu, with retakes, false starts marked '--', "
    "filler, and [non-speech]).\n"
    "For EACH numbered script line, choose the transcript segment id(s) that deliver that "
    "line as the CLEANEST, MOST COMPLETE take:\n"
    "- prefer a complete take over one cut off with '--';\n"
    "- if the line is spoken across consecutive segments, list them in order;\n"
    "- pick only ONE take per line (no repeated/retake duplicates);\n"
    "- if a script line was never delivered, use an empty list.\n"
    "Return STRICT JSON only: {\"matches\":[{\"line\":<int>,\"segments\":[<int>,...]}]}"
)


def script_lines(script: str) -> list[str]:
    return [s.strip() for s in re.split(r"[.\n]+", script or "") if s.strip()]


def _prompt(lines, segments) -> str:
    p = [_HEADER, "", "=== SCRIPT LINES ==="]
    p += [f"{i}: {ln}" for i, ln in enumerate(lines)]
    p += ["", "=== TRANSCRIPT SEGMENTS (id | text) ==="]
    p += [f"{s.id} | {s.text}" for s in segments]
    p += ["", "Output only the JSON object."]
    return "\n".join(p)


def parse_matches(text: str, valid_ids: set) -> tuple[set, dict]:
    """Return (chosen_ids, {line: [ids]})."""
    m = re.search(r"\{.*\}", text or "", re.S)
    chosen, per_line = set(), {}
    if not m:
        return chosen, per_line
    try:
        data = json.loads(m.group(0))
    except Exception:
        return chosen, per_line
    for item in data.get("matches", []):
        try:
            line = int(item.get("line"))
        except (TypeError, ValueError):
            continue
        ids = [int(x) for x in (item.get("segments") or []) if int(x) in valid_ids]
        per_line[line] = ids
        chosen.update(ids)
    return chosen, per_line


async def _run(segments, script):
    lines = script_lines(script)
    valid = {s.id for s in segments}
    raw = await provider_service.chat(
        messages=[{"role": "user", "content": _prompt(lines, segments)}],
        temperature=0.0, max_tokens=4000,
    )
    text = (raw or {}).get("response") or ""
    chosen, _ = parse_matches(text, valid)
    if not chosen:                       # parse/LLM failure → safe deterministic fallback
        classify(segments, script)
        return
    for s in segments:
        s.decision, s.reason = ("keep", "") if s.id in chosen else ("cut", "off_script")


def a5_llm_script(segments, script, use_llm=True):
    return _run(segments, script)        # always LLM-matched (coroutine)
