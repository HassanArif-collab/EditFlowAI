# Fixture: `interview_short`

## Purpose

A 33-second mono audio file with **three deliberate takes** of the same idea, separated by long silences. Each take has different quality characteristics so the segmenter and matcher have something to discriminate against.

## What the audio contains (narrative)

A speaker is doing camera-direct takes for a YouTube intro. They speak in English. They restart twice before nailing it on the third try.

```
[00:00.0 - 00:02.0]  silence (room tone leader)

[00:02.0 - 00:09.0]  TAKE 1 (~7 s)
  "Hello and welcome back to my channel.
   Today I want to, uh, talk about something really cool."

[00:09.0 - 00:11.0]  silence (1.5 s — speaker pauses, decides to restart)

[00:11.0 - 00:18.0]  TAKE 2 (~7 s)
  "Today I want to talk about something interesting,
   uh, something that I think you'll find fascinating."

[00:18.0 - 00:20.0]  silence (1.5 s — another restart)

[00:20.0 - 00:31.5]  TAKE 3 (~11 s)
  "Welcome back to the channel. Today I want to discuss
   a fascinating topic that I think you'll really enjoy."

[00:31.5 - 00:33.0]  silence (tail)
```

Total duration: **33.0 s**.

## Why these takes specifically

The three takes are designed to exercise concrete pieces of the pipeline:

| Take | Quality signal exercised | Notes |
|------|--------------------------|-------|
| 1 | One filler word (`uh`) | Quality score moderate; should match v1 script "literally" |
| 2 | One filler word + restart-style opening | Same content as 3 but lower quality |
| 3 | No fillers, complete thought, paraphrased | Highest quality; best match for v2 script |

The matcher must:
- Choose **take 1** when the script literally says "Hello and welcome back to my channel" (script v1 line 1).
- Choose **take 3** when the script says "Welcome back to the channel" (script v2 line 1, paraphrase).
- For "Today I want to talk about something interesting", **take 2** is the literal match but **take 3** is the quality match — the LLM rerank should choose 3.

## Why pre-leader and trailer silence

Two reasons:
1. **VAD verification**: silero-vad must detect them as `silence`. Stage 4 must not produce a take row for them.
2. **Padding behavior** in stage 2: when a clip uses only `source_in=2.0 → source_out=31.5`, we add 1 s padding on each side. The prepared WAV's `audio_offset` must correctly map back to source time. Having silence to spare lets the test verify this.

## Why English not Urdu

Phase A is about the pipeline's structural correctness — segmenter math, snapping, matching algorithm. Language quality of Whisper on Urdu is a separate variable. English keeps the variance low so test thresholds are tight.

A future `mixed_lang/` fixture will add Urdu audio + English script (the user's actual workflow).

## How the WAV is generated

By `tests/fixtures/build/build_short_tts.py` using **edge-tts** (Microsoft Edge TTS, free, deterministic per voice).

Voice: `en-US-AriaNeural` (clear female voice; widely tested with Whisper).
Rate: default. Pitch: default.

The build script:
1. Synthesises each take as a separate WAV.
2. Concatenates with silence padding via ffmpeg `concat` demuxer.
3. Loudness-normalises to -23 LUFS (broadcast standard).
4. Writes mono 16 kHz PCM to `tests/fixtures/short/interview_short.wav`.

The structural-fallback script (`build_short_silence.py`) replaces TTS with sine-wave bursts of equivalent duration — useful for testing VAD math when TTS is unavailable but USELESS for testing Whisper itself.

## Whisper expectations

When we run our preferred engine (whisperX) on this fixture:

- Word count: ~50 ± 3
- Detected language: `en` with high confidence
- Word-level timing accuracy: ±50 ms (whisperX claim; verified by `capture_truth.py`)
- Word error rate (WER) vs canonical: should be **< 5 %** for English TTS audio

For vanilla faster-whisper (`large-v3-turbo`):
- WER: ≤ 5 %
- Timing accuracy: ±200-300 ms

These are baselines for the snapshot test thresholds.
