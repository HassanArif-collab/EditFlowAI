# Plan 2 — Forced alignment (free, local, keeps the Gemini-paste workflow)

**Status: designed.** Productizes the timing fix without any API.

## Objective
For *every* future video, automatically give Gemini's excellent pasted text
**accurate word-level timestamps on the real timeline**, by force-aligning that
text to the clip's audio — locally, no API keys, preserving your paste habit.

## Why it works
Forced alignment takes **known text + audio** and finds *when* each word is spoken.
It decouples "what was said" (Gemini, excellent) from "when" (acoustic alignment).
Meta's **MMS** alignment model covers **1,130 languages incl. Urdu**, so it aligns
Urdu audio directly.

## Technique
- [`ctc-forced-aligner`](https://github.com/MahmoudAshraf97/ctc-forced-aligner)
  with `MahmoudAshraf/mms-300m-1130-forced-aligner`.
- Input: the prepared 16 kHz mono WAV (already produced by `audio_prepare.py`) +
  the Gemini transcript text. Output: `words[{text, start, end}]` on the true clock.

## Steps
1. `pip install git+https://github.com/MahmoudAshraf97/ctc-forced-aligner` →
   add to `requirements.txt`. Model caches under `data/hf-cache` (HF env already set).
2. `backend/services/forced_align.py`:
   - `align(audio_path, text, language="urd") -> list[Word]` using
     `generate_emissions / preprocess_text / get_alignments / postprocess_results`.
   - Chunk long audio (toolkit supports it) to bound memory.
3. Integrate into the paste flow (new, parallel to the existing one — legacy
   untouched): when the user pastes the **Gemini transcript**, the backend aligns
   it to the clip audio → an accurate-timed transcript that feeds `/cutplan` (so
   the cut-planning model emits real times), or re-times the cut plan post-ingest.
4. **Silence-snap** each cut boundary to the nearest pause (reuse the legacy
   auto-matcher VAD).
5. Frontend: a new `/align` step, or fold alignment into `/cutplan`.

## Files
- `backend/services/forced_align.py` (new)
- route + `orchestrator.js` command (new, additive)
- `requirements.txt`

## Dependencies
`ctc-forced-aligner`, `torch`/`torchaudio`, MMS model (~1 GB one-time download).
CPU works (≈ real-time-ish); GPU faster.

## Tradeoffs
- ✅ Free, local, private; keeps Gemini's text quality and the paste workflow.
- ⚠️ Adds a model download + alignment compute; torch/torchaudio install weight.

## Success criteria
On `IMG_1694.MOV`, aligned word times match Whisper's accurate times within
~0.2 s; cuts land on speech; the 209-vs-322 drift is gone.

## Risks / mitigations
- MMS Urdu alignment quality → validate against Whisper times on the test clip
  before trusting it; fall back to Plan 1's Whisper times if alignment is worse.
- Install/runtime weight → document; make it an opt-in engine, Whisper stays default.
