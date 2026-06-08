# Plan 3 — ElevenLabs Scribe (one model: accurate Urdu text + word timestamps)

**Status: designed.** Highest quality / least engineering; needs an API key.

## Objective
Replace the two-step (Gemini text + separate timing) with a **single** transcription
that returns accurate Urdu **text and word-level timestamps** on the real timeline —
removing the drift problem and the bad-Whisper problem at once.

## Why it works
ElevenLabs **Scribe** benchmarks at **~3.1 % WER on Urdu (FLEURS)** — better than both
Gemini and Whisper — and returns **word- and character-level timestamps**. One call
gives everything the cut planner needs.

## Technique
- Scribe STT API (`scribe_v1`/`scribe_v2`): POST the clip's audio → JSON with
  `words[{text, start, end}]`, plus optional diarization/events.
- Audio: reuse the prepared 16 kHz mono WAV from `audio_prepare.py`, or send the
  original.

## Steps
1. **Config:** add `ELEVENLABS_API_KEY` to settings + the panel Settings UI.
2. `backend/services/scribe_transcribe.py`: POST audio to Scribe → parse
   `words[{text,start,end}]` into the project's transcript shape.
3. Register as a **transcription engine** next to `faster_whisper` (the engine
   selector already exists — log line "Selected transcription engine: …"). New id
   `elevenlabs_scribe`; Whisper stays the default.
4. Cut planner consumes Scribe's accurate-timed transcript directly. Gemini becomes
   optional (selection only) or is dropped entirely.
5. **Test:** transcribe `IMG_1694.MOV`; compare text accuracy + timing vs
   Gemini/Whisper; build cuts; verify windows land on speech.

## Files
- `backend/services/scribe_transcribe.py` (new)
- config (`ELEVENLABS_API_KEY`), Settings UI, engine registry

## Dependencies
`elevenlabs` Python SDK (or raw HTTP); network; an API key.

## Cost / access (checked Jun 2026)
- Free tier exists (~10k credits/mo via the UI) — enough to **test** a short clip.
- STT billed per audio-minute; sustained use is paid. **I can't create an account
  or use your payment** — you supply a free/cheap key, I wire it in plug-and-play.
- Could also be tested in-browser (paste workflow) if the web tool exports timestamps.

## Tradeoffs
- ✅ Best Urdu accuracy + simplest pipeline (one call does text *and* time).
- ⚠️ Needs a key + network; audio leaves the machine (privacy); ongoing cost beyond
  the free tier.

## Success criteria
Scribe's Urdu transcript is visibly more accurate than Whisper; word times match the
audio; cuts land cleanly on speech with no drift; pipeline collapses to one step.

## Risks / mitigations
- Cost/limits → free tier for testing; document per-minute cost; opt-in (Whisper
  stays default).
- Privacy → make it explicit and optional; never the default.
