"""EditFlow AI — Review service (pure logic for the transcript-first editor).

WHY THIS EXISTS
---------------
The transcription and the timeline-apply pipeline already work. The part that
keeps producing bad cuts is *deciding which spans to keep*. A weak local LLM
can't reliably cluster Urdu/Hindi retakes or tell a script line from filler, and
an opaque list of timestamps is impossible for the user to trust until it's
already on the Premiere timeline.

The Review editor flips the model: the transcript becomes the editing surface
(the Descript / Premiere Text-Based-Editing paradigm). The human edits by reading
and toggling text. The machine only *proposes* keep/cut and *flags* the obvious
junk — the human verifies in seconds before anything touches the timeline.

This module is the brain of that flow and is intentionally **pure** (no FastAPI,
no ffmpeg, no I/O) so every rule is unit-testable in isolation:

  parse_transcript()  — SRT (ElevenLabs Scribe), Gemini JSON, or {segments|words}
                        → a flat list of Segment with sequential ids.
  tighten()           — snap each segment hard onto speech using a silence map
                        (kills the "gaps / looking around" the user hated).
  classify()          — deterministic, language-agnostic keep/cut proposal.
  build_gemma_prompt()/parse_gemma_decisions() — optional LLM refinement layer.

DESIGN NOTE — cross-lingual matching
------------------------------------
The user's footage is Urdu while the script is often English, so fuzzy *text*
similarity cannot match a segment to a script line. We therefore only auto-cut
**language-agnostic** signals deterministically (non-speech brackets, whole-segment
filler like "haan ji", too-short stutters, and same-language retake duplicates).
The risky cross-lingual "not in this script" judgement is left to the optional
Gemma pass and, ultimately, the human's toggles — so the classifier can never
silently delete the whole take.
"""
from __future__ import annotations

import difflib
import json
import logging
import re
import unicodedata
from dataclasses import asdict, dataclass, field
from typing import Iterable, Optional

logger = logging.getLogger(__name__)


class ReviewError(ValueError):
    """Raised when a transcript can't be parsed or a review op is invalid.

    Carries a precise, user-facing reason (surfaced verbatim by the route as the
    HTTP 400 detail) so the panel can tell the user exactly what to fix.
    """


# ── Segment model ──────────────────────────────────────────────────

@dataclass
class Segment:
    """One transcript cue plus its review state.

    ``start``/``end`` are the raw transcript times. ``tight_in``/``tight_out`` are
    the speech-snapped times used to actually cut (set by :func:`tighten`; equal
    to start/end until then). ``decision``/``reason``/``group_id``/``script_line``
    are filled by :func:`classify`.
    """

    id: int
    start: float
    end: float
    text: str
    tight_in: float = 0.0
    tight_out: float = 0.0
    decision: str = "keep"      # "keep" | "cut"
    reason: str = ""            # why it was cut (shown as a chip in the UI)
    group_id: int = -1          # retake-cluster id, -1 = not part of a cluster
    script_line: str = ""       # best-matching script line, if any

    def to_dict(self) -> dict:
        return asdict(self)


def segments_to_dicts(segments: Iterable[Segment]) -> list[dict]:
    return [s.to_dict() for s in segments]


def kept_cuts(
    segments: list[Segment],
    source_name: str,
    kept_ids: Optional[list[int]] = None,
) -> list[dict]:
    """Turn kept segments into the cut dicts the external-plan ingest consumes.

    Pure (no I/O) so the exact in/out math is unit-testable. Uses the tightened
    boundaries (``tight_in``/``tight_out``) so the built cut has no dead air.
    ``kept_ids`` (the panel's explicit, possibly-reordered selection) wins when
    given; otherwise every segment whose ``decision == "keep"`` is used, in id
    order. ``source_name`` is the bare filename the external-plan resolver maps
    back to the absolute clip path.
    """
    by_id = {s.id: s for s in segments}
    if kept_ids is not None:
        chosen = [by_id[i] for i in kept_ids if i in by_id]
    else:
        chosen = [s for s in segments if s.decision == "keep"]
    return [
        {
            "beat_text": (s.script_line or s.text or f"cut {s.id}")[:120],
            "source_file": source_name,
            "source_in": round(s.tight_in or s.start, 3),
            "source_out": round(s.tight_out or s.end, 3),
        }
        for s in chosen
    ]


# ── Time helpers ───────────────────────────────────────────────────

_TC = re.compile(
    r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*"
    r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})"
)


def _tc_to_seconds(h: str, m: str, s: str, ms: str) -> float:
    ms3 = (ms + "000")[:3]
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms3) / 1000.0


# ── SRT parsing (ElevenLabs Scribe & friends) ──────────────────────

def parse_srt(text: str) -> list[Segment]:
    """Parse standard SRT into Segments.

    Tolerant by design — real exports vary:
      - optional numeric index line before each cue,
      - ``,`` or ``.`` millisecond separators,
      - multi-line cue text (joined with a space),
      - UTF-8 / BOM, CRLF or LF, Windows or Unix,
      - RTL Urdu text (just bytes to us — preserved verbatim),
      - bracketed non-speech cues like ``[بچے کی آواز]`` (kept; classify cuts them).

    Cues are returned sorted by start time with fresh sequential ids.
    """
    text = (text or "").lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    raw: list[tuple[float, float, str]] = []
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = block.split("\n")
        m = None
        tc_idx = -1
        for i, ln in enumerate(lines):
            found = _TC.search(ln)
            if found:
                m, tc_idx = found, i
                break
        if m is None:
            continue
        start = _tc_to_seconds(m.group(1), m.group(2), m.group(3), m.group(4))
        end = _tc_to_seconds(m.group(5), m.group(6), m.group(7), m.group(8))
        cue_text = " ".join(ln.strip() for ln in lines[tc_idx + 1:] if ln.strip())
        if end <= start:
            end = start + 0.05  # guard against zero/negative cues
        raw.append((start, end, cue_text))

    if not raw:
        raise ReviewError(
            "No SRT cues found. Expected lines like "
            "'00:00:01,000 --> 00:00:04,120'."
        )
    raw.sort(key=lambda r: r[0])
    return [
        Segment(id=i, start=round(s, 3), end=round(e, 3), text=t,
                tight_in=round(s, 3), tight_out=round(e, 3))
        for i, (s, e, t) in enumerate(raw)
    ]


# ── JSON parsing (Gemini / generic segments / words) ───────────────

def _loads_lenient(text: str):
    """json.loads, but salvage the first balanced {...} or [...] from prose."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Find the first balanced object or array, tracking string state.
    for opener, closer in (("{", "}"), ("[", "]")):
        start = text.find(opener)
        if start < 0:
            continue
        depth = 0
        in_str = False
        esc = False
        for j in range(start, len(text)):
            ch = text[j]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
            else:
                if ch == '"':
                    in_str = True
                elif ch == opener:
                    depth += 1
                elif ch == closer:
                    depth -= 1
                    if depth == 0:
                        try:
                            return json.loads(text[start:j + 1])
                        except json.JSONDecodeError:
                            break
    raise ReviewError("Couldn't parse the transcript as SRT or JSON.")


def _f(d: dict, *keys: str, default: float = 0.0) -> float:
    """First present numeric key (handles start vs start_seconds)."""
    for k in keys:
        if k in d and d[k] is not None:
            try:
                return float(d[k])
            except (TypeError, ValueError):
                return default
    return default


def _segments_from_dicts(items: list[dict]) -> list[Segment]:
    out: list[tuple[float, float, str]] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        start = _f(it, "start", "start_seconds", "from")
        end = _f(it, "end", "end_seconds", "to")
        txt = str(it.get("text") or it.get("word") or "").strip()
        if end <= start:
            end = start + 0.05
        out.append((start, end, txt))
    if not out:
        raise ReviewError("Transcript JSON had no usable segments.")
    out.sort(key=lambda r: r[0])
    return [
        Segment(id=i, start=round(s, 3), end=round(e, 3), text=t,
                tight_in=round(s, 3), tight_out=round(e, 3))
        for i, (s, e, t) in enumerate(out)
    ]


def _words_to_segments(words: list[dict], gap: float = 0.6) -> list[Segment]:
    """Group a flat word list into segments, splitting on pauses >= ``gap``."""
    norm = []
    for w in words:
        if not isinstance(w, dict):
            continue
        norm.append((
            _f(w, "start", "start_seconds"),
            _f(w, "end", "end_seconds"),
            str(w.get("word") or w.get("text") or ""),
        ))
    norm.sort(key=lambda r: r[0])
    groups: list[list[tuple[float, float, str]]] = []
    cur: list[tuple[float, float, str]] = []
    for w in norm:
        if cur and w[0] - cur[-1][1] > gap:
            groups.append(cur)
            cur = []
        cur.append(w)
    if cur:
        groups.append(cur)
    items = [
        {"start": g[0][0], "end": g[-1][1], "text": " ".join(x[2] for x in g).strip()}
        for g in groups if g
    ]
    return _segments_from_dicts(items)


def parse_transcript(text: str, fmt: str = "auto") -> list[Segment]:
    """Normalize any supported transcript into a flat list of Segments.

    fmt: ``"auto"`` (default), ``"srt"``, ``"gemini"``/``"json"``, ``"words"``.
    Detection for ``auto``: presence of ``-->`` ⇒ SRT, else JSON.
    """
    text = (text or "").strip()
    if not text:
        raise ReviewError("Transcript is empty — paste an SRT or JSON transcript.")

    if fmt == "srt" or (fmt == "auto" and "-->" in text):
        return parse_srt(text)

    data = _loads_lenient(text)
    if isinstance(data, list):
        return _segments_from_dicts(data)
    if isinstance(data, dict):
        if isinstance(data.get("segments"), list) and data["segments"]:
            return _segments_from_dicts(data["segments"])
        if isinstance(data.get("words"), list) and data["words"]:
            return _words_to_segments(data["words"])
    raise ReviewError(
        "Unrecognized transcript JSON. Expected a 'segments' array "
        "(each with start/end/text) or a 'words' array."
    )


# ── Tightening (snap to speech) ────────────────────────────────────

def _region_containing(t: float, regions: list[tuple[float, float]]) -> Optional[tuple[float, float]]:
    for s, e in regions:
        if s <= t <= e:
            return (s, e)
        if s > t:
            break
    return None


def tighten(
    segments: list[Segment],
    silence_regions: list[tuple[float, float]],
    pad: float = 0.0,
) -> list[Segment]:
    """Snap each segment's in/out onto real speech using a silence map.

    The user's #1 complaint was dead air and "looking around" between lines.
    ``silence_regions`` is a sorted list of (start, end) silence spans (from
    ffmpeg ``silencedetect`` in the route). For each segment:

      - if the IN boundary sits inside a silence span → move it to the span's
        END (the speech onset);
      - if the OUT boundary sits inside a silence span → move it to the span's
        START (the speech offset, trimming the trailing pause);
      - ``pad`` (seconds) nudges the boundary back outward a hair so a hard
        "very tight" cut never clips a word edge. Default 0.0 (the apply
        pipeline already adds 15 ms audio fades).

    We never extend a boundary *across* a silence into a neighbouring take —
    only the boundary's own enclosing silence is consulted. Mutates and returns
    ``segments``. Pure: no ffmpeg here, so it's fully unit-testable.
    """
    regions = sorted(silence_regions)
    for seg in segments:
        ti = seg.start
        r_in = _region_containing(seg.start, regions)
        if r_in:
            ti = r_in[1]
        to = seg.end
        r_out = _region_containing(seg.end, regions)
        if r_out:
            to = r_out[0]
        ti = max(0.0, ti - pad)
        to = to + pad
        if to <= ti:
            ti, to = seg.start, seg.end  # pathological (segment all-silence) → keep raw
        seg.tight_in = round(ti, 3)
        seg.tight_out = round(to, 3)
    return segments


# ── Classification (deterministic keep/cut) ────────────────────────

# Whole-segment filler tokens. Matched against the *entire* normalized segment
# text (never as a substring) so a real line that merely contains "ji" survives.
_FILLER_TOKENS = {
    # English
    "um", "umm", "uh", "uhh", "ah", "ahh", "hmm", "mhm", "er", "erm", "okay", "ok",
    # Urdu / Hindi affirmations & throat fillers the user explicitly flagged
    "haan", "han", "haan ji", "han ji", "hanji", "ji", "ji haan", "ji han",
    "acha", "achha", "theek", "theek hai",
    "ہاں", "ہاں جی", "ہانجی", "جی", "جی ہاں", "اچھا", "ٹھیک", "ٹھیک ہے",
    "ہممم", "ہمم", "اہ", "ام",
}

_PUNCT = re.compile(r"[^\w\s]", re.UNICODE)
_WS = re.compile(r"\s+")


def _normalize(text: str) -> str:
    """Lowercase, strip punctuation (incl. Urdu ؟،۔), collapse whitespace."""
    t = unicodedata.normalize("NFKC", text or "").lower()
    t = _PUNCT.sub(" ", t)
    return _WS.sub(" ", t).strip()


def _is_bracketed_nonspeech(text: str) -> bool:
    t = (text or "").strip()
    return bool(t) and (
        (t.startswith("[") and t.endswith("]"))
        or (t.startswith("(") and t.endswith(")"))
        or (t.startswith("{") and t.endswith("}"))
    )


# Pre-normalize the filler set with the SAME pipeline used on segment text, so
# matching is robust to Unicode form / punctuation / casing differences.
_FILLER_NORM = frozenset(_normalize(t) for t in _FILLER_TOKENS)


def _is_filler(normalized: str) -> bool:
    return normalized in _FILLER_NORM


def _dominant_script(text: str) -> str:
    """Coarse writing-system of the dominant character class of ``text``."""
    counts: dict[str, int] = {}
    for ch in text or "":
        if not ch.isalpha():
            continue
        try:
            name = unicodedata.name(ch)
        except ValueError:
            continue
        if name.startswith("ARABIC"):
            key = "arabic"
        elif name.startswith("DEVANAGARI"):
            key = "devanagari"
        elif name.startswith("LATIN"):
            key = "latin"
        else:
            key = "other"
        counts[key] = counts.get(key, 0) + 1
    if not counts:
        return "none"
    return max(counts, key=counts.get)


def _ratio(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a, b).ratio()


def _cluster_retakes(segments: list[Segment], threshold: float) -> list[list[int]]:
    """Union-find clustering of near-duplicate segment texts (retakes).

    Compares *normalized* text with a char-level ratio, which is language-
    agnostic (works on Urdu code points just as well as Latin). Returns clusters
    as lists of segment indices, each sorted ascending; singletons included.
    """
    n = len(segments)
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    norms = [_normalize(s.text) for s in segments]
    for i in range(n):
        if len(norms[i]) < 3:
            continue
        for j in range(i + 1, n):
            if len(norms[j]) < 3:
                continue
            # Cheap length guard before the O(k) ratio.
            shorter, longer = sorted((len(norms[i]), len(norms[j])))
            if longer and shorter / longer < 0.5:
                continue
            if _ratio(norms[i], norms[j]) >= threshold:
                union(i, j)

    clusters: dict[int, list[int]] = {}
    for i in range(n):
        clusters.setdefault(find(i), []).append(i)
    return [sorted(v) for v in clusters.values()]


def _script_lines(script: str) -> list[str]:
    if not script:
        return []
    lines = re.split(r"[\n\.!?؟۔]+", script)
    return [ln.strip() for ln in lines if len(ln.strip()) >= 3]


def classify(
    segments: list[Segment],
    script: str = "",
    *,
    retake_threshold: float = 0.72,
    script_threshold: float = 0.5,
    min_duration: float = 0.4,
) -> list[Segment]:
    """Deterministic keep/cut proposal. Mutates and returns ``segments``.

    Order matters — cheap, certain signals first, fuzzy signals last:
      1. non-speech bracketed cues  → cut (reason ``non_speech``)
      2. whole-segment filler        → cut (reason ``filler``)
      3. too-short stutters          → cut (reason ``too_short``)
      4. retake clusters             → keep the LAST member, cut earlier ones
                                       (reason ``retake_of:#<kept id>``)
      5. script match (SAME-LANGUAGE only) → cut non-matching (``not_in_script``)

    Step 5 is skipped entirely when the transcript and script are in different
    writing systems (e.g. Urdu video + English script), because char similarity
    is meaningless across languages and would wrongly cut everything. That call
    is deferred to the optional Gemma pass and the human's toggles.
    """
    # Reset state (idempotent — endpoint may re-run with different params).
    for seg in segments:
        seg.decision, seg.reason, seg.group_id, seg.script_line = "keep", "", -1, ""

    # 1–3: language-agnostic base pass.
    for seg in segments:
        t = seg.text.strip()
        dur = (seg.tight_out or seg.end) - (seg.tight_in or seg.start)
        if not t:
            seg.decision, seg.reason = "cut", "empty"
        elif _is_bracketed_nonspeech(t):
            seg.decision, seg.reason = "cut", "non_speech"
        elif _is_filler(_normalize(t)):
            seg.decision, seg.reason = "cut", "filler"
        elif dur < min_duration:
            seg.decision, seg.reason = "cut", "too_short"

    # 4: retakes — keep the last clean member of each cluster.
    for gid, members in enumerate(_cluster_retakes(segments, retake_threshold)):
        if len(members) < 2:
            continue
        kept = members[-1]
        for m in members:
            segments[m].group_id = gid
        for m in members[:-1]:
            if segments[m].decision == "keep":
                segments[m].decision = "cut"
                segments[m].reason = f"retake_of:#{kept}"

    # 5: script match — same-language only.
    lines = _script_lines(script)
    if lines:
        transcript_blob = " ".join(s.text for s in segments)
        same_language = _dominant_script(transcript_blob) == _dominant_script(script)
        if same_language:
            norm_lines = [_normalize(ln) for ln in lines]
            for seg in segments:
                if seg.decision != "keep":
                    continue
                ns = _normalize(seg.text)
                best_i, best_score = -1, 0.0
                for i, nl in enumerate(norm_lines):
                    sc = _ratio(ns, nl)
                    if sc > best_score:
                        best_i, best_score = i, sc
                if best_score >= script_threshold:
                    seg.script_line = lines[best_i]
                else:
                    seg.decision, seg.reason = "cut", "not_in_script"
        else:
            logger.info(
                "review.classify: transcript/script differ in writing system "
                "(%s vs %s) — skipping deterministic script match; leaving it to "
                "Gemma/human.",
                _dominant_script(transcript_blob), _dominant_script(script),
            )
    return segments


# ── Optional Gemma refinement ──────────────────────────────────────

_GEMMA_HEADER = (
    "You are reviewing a video transcript to decide which segments to KEEP in the "
    "final cut and which to CUT. CUT a segment if it is: a repeated/retake of "
    "another segment (keep only the cleanest, usually the LAST take), a false "
    "start, filler ('haan ji', 'umm'), throat-clearing/non-speech, or content that "
    "is NOT part of the provided script. KEEP clean segments that belong to the "
    "script.\n\n"
    "Return STRICT JSON and nothing else:\n"
    '{ \"decisions\": [ { \"id\": <int>, \"keep\": <true|false>, \"reason\": \"<short>\" } ] }\n'
)


def build_gemma_prompt(segments: list[Segment], script: str = "") -> str:
    """Build the refinement prompt for the local model (provider_service.chat).

    Gemma is a *refiner*, not the source of truth: the route only lets it CUT
    segments the deterministic pass kept (it can never resurrect a reliable cut),
    and any parse failure leaves the deterministic result untouched.
    """
    parts = [_GEMMA_HEADER, ""]
    parts.append("=== SCRIPT ===")
    parts.append((script or "(no script provided — judge by clean delivery / repeats)").strip())
    parts.append("")
    parts.append("=== SEGMENTS (id | seconds | text) ===")
    for s in segments:
        parts.append(f"{s.id} | {s.start:.2f}-{s.end:.2f} | {s.text}")
    parts.append("")
    parts.append("Output only the JSON object.")
    return "\n".join(parts)


def parse_gemma_decisions(raw: str, valid_ids: set[int]) -> dict[int, tuple[bool, str]]:
    """Parse the model's JSON into ``{id: (keep, reason)}``; tolerant of junk.

    Returns an empty dict on any failure so the caller falls back to the
    deterministic result rather than corrupting it.
    """
    try:
        data = _loads_lenient(raw or "")
    except ReviewError:
        return {}
    decisions = data.get("decisions") if isinstance(data, dict) else data
    if not isinstance(decisions, list):
        return {}
    out: dict[int, tuple[bool, str]] = {}
    for d in decisions:
        if not isinstance(d, dict) or "id" not in d:
            continue
        try:
            sid = int(d["id"])
        except (TypeError, ValueError):
            continue
        if sid not in valid_ids:
            continue
        keep = bool(d.get("keep", True))
        out[sid] = (keep, str(d.get("reason", "")).strip()[:80])
    return out
