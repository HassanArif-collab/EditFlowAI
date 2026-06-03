# Plan 1 — PROOF: Re-time the Gemini plan with Whisper's word timestamps

**Status: implementing now.** Goal is *proof*, not product.

## Objective
On `IMG_1694.MOV`, prove the bad cuts are purely a **timing** problem by re-timing
the *existing* 8-cut Gemini plan using Whisper's already-accurate word timestamps —
**without changing Gemini's content choices**. Success = the same 8 lines now land
on real speech (no dead air, no retake tails), verified objectively (audio levels)
and visually (in the Premiere panel).

## Why it works
- Gemini's **text is correct**; only its **times drift** (silence-collapse).
- Whisper's **word timestamps are accurate** across the full 1.6–322.4 s (proven).
- So for each Gemini cut, find the same words in Whisper → use Whisper's real times.

## Technique — cross-transcript re-alignment
1. Load the Whisper sidecar word list `[(start, end, word)]` (accurate clock).
   Path: `…/TestingEditFlow/IMG_1694.transcript.json` (859 segs, ~1407 words).
2. Load the 8 Gemini cut beats (Urdu text + drifted in/out, in script order):
   `data/inputs/gemini_cutplan.json`.
3. **Normalize** Urdu for matching: map Eastern-Arabic digits ۰-۹ → 0-9, strip
   punctuation/diacritics/tatweel, collapse whitespace, lowercase ASCII.
4. **Monotonic fuzzy alignment**: keep a cursor into the Whisper words. For each
   beat (in order), slide a window over Whisper words from the cursor, score
   `difflib.SequenceMatcher.ratio()` of the window's normalized text vs the beat,
   take the best span `[first.start, last.end]`, advance the cursor past it. Monotonic
   order disambiguates the many retakes (picks the take in sequence, not at random).
5. **Trim to speech**: use exact word boundaries; pad slightly (+0.06 s in, +0.12 s
   out) so words aren't clipped; never extend into a >0.4 s inter-word gap (silence).
6. Emit `data/proof/corrected_cutplan.json` — same beats, corrected in/out.

## Files / artifacts
- `data/proof/retime_with_whisper.py` — the re-timing script (stdlib only).
- `data/inputs/gemini_cutplan.json` — input (8 beats).
- `data/proof/corrected_cutplan.json` — output (corrected plan).
- `data/proof/verify_levels.py` — audio-level check (bundled ffmpeg).

## Dependencies
None new — Python stdlib `difflib`/`json` + the existing Whisper sidecar.
Bundled ffmpeg for the audio-level check.

## Test / success criteria
1. **Sanity**: printed match for each beat — the Whisper span text resembles the
   Gemini beat (numbers/anchors line up).
2. **Audio levels** (objective): every corrected window has **mean > −34 dB and
   max > −12 dB** (real speech) vs. the −41/−21 dB silence we measured on cut 5.
3. **Speech coverage** ≥ ~80 % of each window (little edge silence), using Whisper
   words.
4. **Computer-use (in Premiere)**: paste `corrected_cutplan.json` via `/paste-plan`
   → Build sequence → confirm the new clips sit on speech (timeline waveforms,
   spot playback), and compare against the old drifted sequence.

## Risks / mitigations
- Whisper Urdu text is rough → a beat may mis-match. *Mitigation*: print every
  match for inspection; numbers/English terms ("F-6", "پرسنٹ", "کروڑ") anchor it;
  monotonic order constrains; nudge any single outlier by hand.
- Retake ambiguity → monotonic + similarity picks the in-order take. (Exact
  "last clean take" selection is **Problem 2**, out of scope for the proof.)

## Scope boundary
- **No product code changes.** Offline script + manual paste only. Legacy untouched.
- If the proof validates (cuts land on speech), productize via Plan 2 or Plan 3.
