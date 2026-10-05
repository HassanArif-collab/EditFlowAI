"""AI correction pass over a Whisper transcript.

Whisper mishears words that a reader would catch instantly from context —
in Urdu it wrote `کروڑ پے` for `کروڑ روپے` and `دس گناہ` ("ten sins") for
`دس گنا` ("ten times"). A language model reading the surrounding sentence
fixes those trivially.

The danger is that the same model will happily "improve" the transcript:
tidy the grammar, drop the retakes, merge the stumbles. That destroys the
record of what was actually said AND breaks the word-level timings that
caption and shot-sync both depend on.

So the model is never allowed to rewrite the transcript. It may only
propose **1:1 word replacements**, which are applied by index. Word count
is invariant, so every timestamp survives untouched.
"""
from __future__ import annotations

import json
import re
from typing import Any


def build_prompt(words: list[dict], language: str = "ur", vocab: str = "",
                 context: str = "") -> str:
    """Prompt asking for indexed word replacements — never a rewrite."""
    numbered = "\n".join(
        f"{i}\t{w.get('word', w.get('text', ''))}" for i, w in enumerate(words)
    )
    lines = [
        "You are correcting a speech-to-text transcript.",
        "",
        "The transcript is one word per line, prefixed by its index.",
        "Some words were misheard by the speech recogniser. Using the",
        "surrounding sentence, identify ONLY those and give the correction.",
        "",
        "STRICT RULES:",
        "1. Return ONLY a JSON array. No prose, no explanation.",
        '2. Each item: {"i": <index>, "to": "<corrected word>"}',
        "3. ONE word in, ONE word out. Never split a word into two, never",
        "   merge two into one, never insert or delete a word.",
        "4. Do NOT fix grammar, do NOT remove repetitions, do NOT tidy up",
        "   false starts or stutters. The speaker really said those. You are",
        "   fixing MISHEARINGS only.",
        "5. If a word is already correct, leave it out of your answer.",
        "6. Keep the same script/alphabet the transcript uses.",
        "",
        f"Language: {language}",
    ]
    if vocab:
        lines += ["", "Known correct spellings (prefer these):", vocab]
    if context:
        lines += ["", "What this recording is about:", context[:600]]
    lines += ["", "TRANSCRIPT:", numbered, "", "JSON array of corrections:"]
    return "\n".join(lines)


def _edit_distance(a: str, b: str) -> int:
    """Levenshtein distance. Small enough to inline; no dependency needed."""
    if a == b:
        return 0
    if not a or not b:
        return max(len(a), len(b))
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def vocab_set(vocab: str) -> set[str]:
    """The words the user typed into the vocabulary box, as a lookup set."""
    return {t for t in re.split(r"[,،\s]+", vocab or "") if t}


def is_plausible_correction(before: str, after: str,
                            vocab: set[str] | None = None) -> bool:
    """Is this a fixed mishearing, or the model inventing a different word?

    A weak model asked to correct a transcript will happily return the
    transcript shifted by an index or two — valid JSON, plausible shape,
    and every 'correction' replaces a word with an unrelated one. Observed
    live: a 4B model turned `ہزار` into `کروڑ`.

    A genuine mishearing fix is a small edit: `پے` → `روپے` (insert 2),
    `گناہ` → `گنا` (delete 1), `بیشنے` → `بیچنے` (substitute 1). So we
    accept only corrections close to the original, scaled by word length.

    A word the user typed into the vocabulary box gets a wider budget —
    they have told us it belongs in this recording, which is better
    evidence than anything the model can offer. Wider, not unlimited:
    `ہزار` → `کروڑ` stays refused even with both words in the vocab.
    """
    if not before or not after:
        return False
    if before == after:
        return False
    dist = _edit_distance(before, after)
    if vocab and after in vocab:
        # e.g. پہ → روپے: 3 edits on a 4-letter word, and the user asked
        # for روپے by name. Still bounded, so an unrelated word is refused.
        return dist <= max(3, len(after) // 2)
    # allow one edit for short words, proportionally more for longer ones
    budget = max(2, (max(len(before), len(after)) + 2) // 3)
    if dist > budget:
        return False
    # a shared prefix or suffix is strong evidence it's the same word
    if before[0] == after[0] or before[-1] == after[-1]:
        return True
    return dist <= 1


def parse_corrections(raw: str, word_count: int) -> list[dict]:
    """Pull the JSON array out of a model reply, tolerating prose and fences.

    Anything malformed, out of range, or not a 1:1 replacement is dropped
    silently — a bad suggestion must never corrupt a good transcript.
    """
    if not raw:
        return []
    text = str(raw)
    match = re.search(r"\[[\s\S]*\]", text)
    if not match:
        return []
    try:
        data = json.loads(match.group(0))
    except Exception:
        return []
    if not isinstance(data, list):
        return []

    out: list[dict] = []
    seen: set[int] = set()
    for item in data:
        if not isinstance(item, dict):
            continue
        try:
            idx = int(item.get("i"))
        except (TypeError, ValueError):
            continue
        to = item.get("to")
        if not isinstance(to, str):
            continue
        to = to.strip()
        if not to or idx < 0 or idx >= word_count or idx in seen:
            continue
        # a replacement containing whitespace would change the word count
        if re.search(r"\s", to):
            continue
        seen.add(idx)
        out.append({"i": idx, "to": to})
    return out


def apply_corrections(words: list[dict], corrections: list[dict],
                      vocab: str = "") -> dict[str, Any]:
    """Apply indexed replacements. Timestamps are never touched.

    Returns {words, applied, changes, rejected} — `changes` so the panel can
    show what the model did, `rejected` so a model talking nonsense is
    visible rather than silently doing nothing.
    """
    out = [dict(w) for w in words]
    known = vocab_set(vocab)
    changes = []
    rejected = []
    for c in corrections:
        i = c["i"]
        if i >= len(out):
            continue
        before = out[i].get("word", out[i].get("text", ""))
        after = c["to"]
        if before == after:
            continue
        # last line of defence: a "correction" that isn't a near-miss of the
        # original is the model hallucinating, not fixing
        if not is_plausible_correction(before, after, known):
            rejected.append({"i": i, "from": before, "to": after})
            continue
        # keep both key spellings in sync — the panel reads either
        if "word" in out[i]:
            out[i]["word"] = after
        if "text" in out[i]:
            out[i]["text"] = after
        if "word" not in out[i] and "text" not in out[i]:
            out[i]["word"] = after
        changes.append({"i": i, "from": before, "to": after,
                        "start": out[i].get("start")})
    return {"words": out, "applied": len(changes), "changes": changes,
            "rejected": rejected}


def chunk_words(words: list[dict], size: int = 220) -> list[tuple[int, list[dict]]]:
    """Split into chunks a model can actually hold, keeping absolute indices.

    Returns [(offset, chunk_words)] so corrections can be mapped back.
    """
    if size <= 0:
        size = 220
    return [(i, words[i:i + size]) for i in range(0, len(words), size)]
