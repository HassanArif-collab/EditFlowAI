# Cutting-quality improvement — plans

## The problem (diagnosed, confirmed on `IMG_1694.MOV`)
The auto-cut is bad for two independent reasons:

1. **Timing drift (the big one).** Gemini transcribes Urdu *text* excellently, but
   when it timestamps video it **collapses the silences**, so its timeline runs
   short and drifts. Measured: real speech spans **1.6 → 322.4 s** (Whisper,
   accurate), but Gemini's cut plan ends at **209 s**. The ~113 s gap ≈ the
   ~110 s of real silence in the video — Gemini deleted the dead air from its
   clock. Result: cuts land on **silence** (cut 5 measured −41 dB / −21 dB, dead
   air) and on **retake tails**.
2. **Cut selection.** Run with no script, the model guessed "cleanest takes" and
   skipped lines. Retake-heavy footage needs *content-aware* take selection.

Whisper's word **timestamps are accurate** (proven), but its Urdu **text is poor**.
Gemini's **text is great** but its **timing is broken**. The fixes below all aim to
get **accurate Urdu text + accurate word-level timestamps**, by different means.

## Three independent techniques (separate, not one workflow)
| # | Plan | Technique | Cost | New deps | Status |
|---|------|-----------|------|----------|--------|
| 1 | [Whisper re-time PROOF](./plan-1-whisper-retime-proof.md) | Re-time the existing Gemini plan against Whisper's accurate word times | free | none | **implementing now** |
| 2 | [Forced alignment (local)](./plan-2-forced-alignment-local.md) | Force-align Gemini's pasted text to the audio (MMS/Urdu) | free/local | ctc-forced-aligner | designed |
| 3 | [ElevenLabs Scribe](./plan-3-elevenlabs-scribe.md) | One API gives accurate Urdu text + word timestamps | API (free tier) | elevenlabs | designed |

Plan 1 proves the *timing fix* works with zero new tools. Plans 2 and 3 are the two
ways to **productize** it for every future video (local vs. API). They are
deliberately separate techniques — pick one to productize after the proof.

## Cut-selection (Problem 2) — applies to all three
Provide the **script**; the model matches each line to its cleanest final take
instead of guessing. Addressed once timing is trustworthy.
