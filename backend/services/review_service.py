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

from .review_trace import ReviewTrace, cluster_stage, junk_stage, script_stage

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


# ── Word-level model (approximate times now; Scribe exact times later) ──

@dataclass
class Word:
    """One token with a timestamp.

    Phase 1: ``start``/``end`` are interpolated within the parent segment by
    character length. Phase 3 replaces them with ElevenLabs Scribe's exact
    per-word times. ``keep`` drives the final cut.
    """
    id: int
    text: str
    start: float
    end: float
    segment_id: int
    keep: bool = True
    reason: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def words_from_segments(segments: list[Segment]) -> list[Word]:
    """Split each segment into whitespace tokens with interpolated times.

    Each token's span is proportional to its character length within the
    segment's ``[tight_in, tight_out]`` (falling back to raw start/end). Tokens
    are laid contiguously — all the karaoke highlighter needs. Approximate by
    design; exact per-word times arrive with Scribe (phase 3).
    """
    words: list[Word] = []
    wid = 0
    for seg in segments:
        toks = (seg.text or "").split()
        if not toks:
            continue
        s = seg.tight_in if seg.tight_in else seg.start
        e = seg.tight_out if seg.tight_out else seg.end
        span = max(0.001, e - s)
        total = sum(len(t) for t in toks) or 1
        cum = 0
        for t in toks:
            w_start = s + span * (cum / total)
            cum += len(t)
            w_end = s + span * (cum / total)
            words.append(Word(id=wid, text=t, start=round(w_start, 3),
                              end=round(w_end, 3), segment_id=seg.id))
            wid += 1
    return words


def words_to_cuts(
    words_by_id: dict[int, Word],
    kept_ids: list[int],
    source_name: str,
    max_gap: float = 0.35,
) -> list[dict]:
    """Merge kept words (in order) into contiguous cut spans.

    Consecutive kept words within ``max_gap`` seconds merge into one cut; a
    larger gap (a dropped span or inter-line pause) starts a new cut — so cut
    words and dead air never reach the timeline. Pure → unit-testable.
    """
    cuts: list[dict] = []
    cur: Optional[dict] = None
    prev_id: Optional[int] = None
    for wid in kept_ids:
        w = words_by_id.get(wid)
        if w is None:
            continue
        # CRITICAL: only merge with the IMMEDIATELY preceding word (consecutive
        # id). A gap in ids means a CUT word sits between them — merging across it
        # by time would splice that cut word's audio back into the timeline. So a
        # non-consecutive id starts a new cut. (This bug put cut words into the
        # actual built sequence, not just the preview.)
        if (cur is not None and prev_id is not None and w.id == prev_id + 1
                and (w.start - cur["source_out"]) <= max_gap):
            cur["source_out"] = round(w.end, 3)
            cur["beat_text"] = (cur["beat_text"] + " " + w.text)[:120]
        else:
            if cur is not None:
                cuts.append(cur)
            cur = {
                "beat_text": w.text[:120],
                "source_file": source_name,
                "source_in": round(w.start, 3),
                "source_out": round(w.end, 3),
            }
        prev_id = w.id
    if cur is not None:
        cuts.append(cur)
    return cuts


def refine_words(words: list[Word]) -> None:
    """Word-level deterministic cleanup layered on top of segment decisions.

    Cuts individual junk WORDS even inside an otherwise-kept line — the whole
    point of word-level editing. Only ADDS cuts (never restores), so it can't
    undo a human keep. Language-agnostic signals only:
      - whole-word fillers ("haan ji", "umm", "ji"…)
      - bracketed non-speech tokens (``[بچے کی آواز]``)
      - cutoff markers — words ending in ``--`` (Scribe marks restarts this way)
    Mutates ``words`` in place.
    """
    for w in words:
        if not w.keep:
            continue
        t = (w.text or "").strip()
        if not t:
            w.keep, w.reason = False, "empty"
        elif _is_bracketed_nonspeech(t):
            w.keep, w.reason = False, "non_speech"
        elif _is_filler(_normalize(t)):
            w.keep, w.reason = False, "filler"
        elif t.endswith("--"):
            w.keep, w.reason = False, "false_start"


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


_BRACKET_RE = re.compile(r"[\[\(\{][^\]\)\}]*[\]\)\}]")


def _strip_brackets(text: str) -> str:
    """Drop bracketed cues like ``[بچے کی آواز]`` (and their words). Used before
    clustering so a non-speech marker embedded in a content line can't chain that
    line into the non-speech cluster via the shared bracket words."""
    return _BRACKET_RE.sub(" ", text or "")


def _tokens(text: str) -> list[str]:
    """Normalized whitespace tokens of a segment (language-agnostic)."""
    return _normalize(text).split()


def _token_containment(a: list[str], b: list[str]) -> float:
    """Fraction of the SMALLER token-set that also appears in the larger one.

    This is what makes a short fragment ("income", "میں رہتا ہوں") match the full
    line it was split from, and a rephrased retake match its sibling even when the
    lead-in differs — cases a whole-string char ratio misses. Set-based, so word
    order and repeats don't matter. Pure → unit-testable.
    """
    sa, sb = set(a), set(b)
    if not sa or not sb:
        return 0.0
    smaller, larger = (sa, sb) if len(sa) <= len(sb) else (sb, sa)
    return len(smaller & larger) / len(smaller)


def _is_clean_take(text: str) -> bool:
    """A take is 'clean' if it isn't a cut-off false start, a bracketed non-speech
    cue, or a 1-word fragment. Used to pick the best member of a retake cluster —
    a non-speech segment must never be chosen as the take to keep."""
    t = (text or "").strip()
    if "--" in t:                      # Scribe marks self-interrupts with --
        return False
    if _is_bracketed_nonspeech(t):     # e.g. "[بچے کی آواز]"
        return False
    return len(_tokens(t)) >= 2


def _cluster_retakes(
    segments: list[Segment],
    threshold: float,
    pairs: Optional[list[dict]] = None,
    *,
    containment: float = 0.8,
    min_contain_tokens: int = 3,
) -> list[list[int]]:
    """Union-find clustering of near-duplicate segment texts (retakes).

    Two signals, either one groups a pair:
      1. whole-string char ratio >= ``threshold`` (length-guarded) — catches
         near-identical takes.
      2. token containment >= ``containment`` (NOT length-guarded) — catches a
         shorter fragment or a rephrased retake whose words are mostly a subset
         of the other, which the char ratio misses (e.g. "income کو دس گنا…"
         said three different ways, or the bare fragment "میں رہتا ہوں").
    Requires the smaller side to have >= ``min_contain_tokens`` tokens so tiny
    fragments don't over-group (those are handled by the fragment rule instead).

    Returns clusters as lists of segment indices (ascending; singletons included).
    When ``pairs`` is given, appends notable comparisons for the debug drawer.
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

    def record(i: int, j: int, score: Optional[float], clustered: bool, skipped: Optional[str]) -> None:
        pairs.append({
            "a_id": segments[i].id, "a_text": segments[i].text[:50],
            "b_id": segments[j].id, "b_text": segments[j].text[:50],
            "score": (round(score, 3) if score is not None else None),
            "clustered": clustered, "skipped": skipped,
        })

    norms = [_normalize(_strip_brackets(s.text)) for s in segments]
    toks = [n.split() for n in norms]
    for i in range(n):
        if len(norms[i]) < 3:
            continue
        for j in range(i + 1, n):
            if len(norms[j]) < 3:
                continue
            # Signal 2: token containment (not length-guarded — this is the one
            # that catches fragments and rephrasings of different lengths).
            smaller_n = min(len(set(toks[i])), len(set(toks[j])))
            cont = _token_containment(toks[i], toks[j]) if smaller_n >= min_contain_tokens else 0.0
            cont_ok = cont >= containment

            # Signal 1: whole-string char ratio (length-guarded for cost).
            shorter, longer = sorted((len(norms[i]), len(norms[j])))
            char_score: Optional[float] = None
            if not (longer and shorter / longer < 0.5):
                char_score = _ratio(norms[i], norms[j])
            char_ok = char_score is not None and char_score >= threshold

            grouped = char_ok or cont_ok
            if grouped:
                union(i, j)
            if pairs is not None:
                si, li = (i, j) if len(norms[i]) <= len(norms[j]) else (j, i)
                contained = bool(norms[si]) and norms[si] in norms[li]
                if grouped:
                    shown = char_score if char_score is not None else round(cont, 3)
                    record(i, j, shown, True, None)
                elif char_score is None and contained:
                    # length-guard skipped a contained fragment — show why it didn't group
                    record(i, j, None, False, "length_guard")
                elif (char_score is not None and char_score >= 0.4) or cont >= 0.5:
                    record(i, j, char_score if char_score is not None else round(cont, 3), False, None)

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
    trace: ReviewTrace | None = None,
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

    if trace is not None:
        trace.add(junk_stage(segments))

    # 4: retakes — keep the last CLEAN member of each cluster, cut the rest.
    _pairs: list[dict] | None = [] if trace is not None else None
    for gid, members in enumerate(_cluster_retakes(segments, retake_threshold, _pairs)):
        if len(members) < 2:
            continue
        for m in members:
            segments[m].group_id = gid
        # The winner can only be a still-KEPT member (never a non-speech/filler one
        # already cut in steps 1-3); prefer the last CLEAN take, else the last kept.
        eligible = [m for m in members if segments[m].decision == "keep"]
        if not eligible:
            continue
        clean = [m for m in eligible if _is_clean_take(segments[m].text)]
        kept = clean[-1] if clean else eligible[-1]
        for m in eligible:
            if m != kept:
                segments[m].decision = "cut"
                segments[m].reason = f"retake_of:#{kept}"

    if trace is not None:
        trace.add(cluster_stage(_pairs or [], segments))

    # 4b: orphan fragments — a short kept line that's just a piece of a longer kept
    # line (e.g. "دس ہزار،" / "مجھے۔") is a split-off tail. Cut it as ``fragment``.
    _toks_all = [set(_tokens(s.text)) for s in segments]
    for idx, seg in enumerate(segments):
        if seg.decision != "keep":
            continue
        st = _toks_all[idx]
        if not st or len(st) > 3:
            continue
        # A lone short word ("مجھے۔", "گے۔") is a split-off grammatical tail.
        if len(st) == 1 and len(next(iter(st))) <= 4:
            seg.decision, seg.reason = "cut", "fragment"
            continue
        # Its words are a subset of a substantially longer kept line → it's a piece
        # of that line, not its own take.
        for j, other in enumerate(_toks_all):
            if j == idx or segments[j].decision != "keep":
                continue
            if len(other) >= 2 * len(st) and len(st & other) / len(st) >= 0.8:
                seg.decision, seg.reason = "cut", "fragment"
                break

    # 5: script match — same-language only.
    lines = _script_lines(script)
    _matches: list[dict] = []
    _same_language: bool | None = None
    if lines:
        transcript_blob = " ".join(s.text for s in segments)
        _same_language = _dominant_script(transcript_blob) == _dominant_script(script)
        if _same_language:
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
                cut = best_score < script_threshold
                if not cut:
                    seg.script_line = lines[best_i]
                else:
                    seg.decision, seg.reason = "cut", "not_in_script"
                if trace is not None:
                    _matches.append({
                        "id": seg.id,
                        "best_line": (lines[best_i] if best_i >= 0 else ""),
                        "score": round(best_score, 3),
                        "cut": cut,
                    })
        else:
            logger.info(
                "review.classify: transcript/script differ in writing system "
                "(%s vs %s) — skipping deterministic script match; leaving it to "
                "Gemma/human.",
                _dominant_script(transcript_blob), _dominant_script(script),
            )
    if trace is not None:
        trace.add(script_stage(bool(lines), _same_language, _matches))
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
