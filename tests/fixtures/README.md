# Test Fixtures

These fixtures are the **ground truth** the new take-based editor pipeline tests against. They are the most important artifact in the rebuild — without them, we cannot tell when a code change has silently broken the math.

Read the foundation plan for the full design context:
`docs/superpowers/plans/foundation-rebuild-take-based-editor.md`
(also at `C:\Users\hp739\.claude\plans\foundation-rebuild-take-based-editor.md`)

---

## What's in here

```
tests/fixtures/
├── README.md                  ← you are here
├── short/                     ← the canonical "30-second / 3-take" fixture
│   ├── spec.md                  Narrative spec — what the speaker says, where the gaps are
│   ├── canonical.json           Hand-authored ground truth (words + timing)
│   ├── takes.expected.json      What stage-4 (segmenter) must produce
│   ├── script_v1_literal.txt    Test script #1 — close to actual spoken text
│   ├── script_v2_paraphrased.txt Test script #2 — different wording, same meaning
│   ├── plan_v1.expected.json    Expected plan for script v1 (stage-6 output)
│   ├── plan_v2.expected.json    Expected plan for script v2
│   └── interview_short.wav      (Generated — see build/build_short_tts.py)
├── build/
│   ├── build_short_tts.py       Synthesises interview_short.wav via edge-tts
│   ├── build_short_silence.py   Structural-only fallback (no TTS dependency)
│   └── capture_truth.py         Runs Whisper, writes snapshots/whisper.snapshot.json
├── snapshots/                  ← machine-generated, regenerated on engine change
│   ├── whisper.snapshot.json
│   ├── vad.snapshot.json
│   └── RESULTS.md               Latest WER and timing-drift numbers
└── conftest.py                  Pytest helpers — loads canonical and snapshots by name
```

---

## What's *canonical* vs what's *snapshot*

This distinction is the heart of Phase A.

### Canonical (hand-authored, committed, ground truth)

- `short/canonical.json` — what the speaker says, with the timing we *designed* into the fixture.
- `short/takes.expected.json` — the exact stage-4 output we expect from the canonical transcript.
- `short/plan_v*.expected.json` — the exact stage-6 output we expect for each test script.
- All `*.txt` scripts.

These files are the source of truth. If you change them, you are changing the test contract — review carefully.

### Snapshot (machine-generated, committed, drift detector)

- `snapshots/whisper.snapshot.json` — what Whisper *actually* produces on this fixture, with the engine version baked in.
- `snapshots/vad.snapshot.json` — what silero-vad produces.
- `snapshots/RESULTS.md` — WER, timing drift, summary numbers.

These files are byproducts of running `build/capture_truth.py`. If they change, it means either Whisper's behaviour changed (usually a version bump) or we broke something. A diff requires explanation.

---

## How tests use these fixtures

Three tiers of tests, in order of how brittle they are:

### Tier 1: pure-math snapshot tests (least brittle, run in CI)
Feed the **canonical** transcript directly to stage 4, 5, 6 — bypassing Whisper. Assert the output matches the expected JSON snapshot to the byte.

These tests do not need ffmpeg, Whisper, or a GPU. They run in milliseconds. They catch any regression in segmenter / matcher / planner logic.

### Tier 2: Whisper drift tests (medium-brittle, run on machines that have Whisper)
Run Whisper on the WAV, compare to `whisper.snapshot.json`. Tolerate small differences below a configurable threshold (WER < 5%, timing drift < 100ms p95). Fail loudly above the threshold.

These tests detect Whisper version upgrades that change accuracy, and detect environmental drift (different CPU rounding, different audio codec path).

### Tier 3: end-to-end on the WAV (most brittle, manual only)
Run the full pipeline from `@bin reference` → Whisper → segment → match → plan. Compare *that* plan to the expected plans. Only run by hand because it depends on the configured chat provider for the LLM rerank.

---

## Regenerating the fixture WAV

The WAV is generated, not hand-recorded — so it's reproducible across machines.

```bash
# Preferred: edge-tts (Microsoft Edge's free TTS, requires internet on first run)
pip install edge-tts soundfile
python tests/fixtures/build/build_short_tts.py

# Fallback: structural-only (silence + tones; for testing VAD math but NOT Whisper)
python tests/fixtures/build/build_short_silence.py
```

The generated `tests/fixtures/short/interview_short.wav` is intentionally NOT in `.gitignore` — commit it after running so CI doesn't need TTS.

---

## Regenerating the snapshots

```bash
python tests/fixtures/build/capture_truth.py
```

This runs the currently-configured Whisper engine (whisperX preferred, stable-ts second, faster-whisper third) against the fixture WAV, writes:

- `snapshots/whisper.snapshot.json` — full word-level transcript
- `snapshots/vad.snapshot.json` — silero-vad silence/speech ranges if available
- `snapshots/RESULTS.md` — summary: WER vs canonical, timing drift, model + engine + revision

Commit the new snapshots if they look reasonable. Diff is reviewable.

---

## Why this matters

Previous attempts at this codebase declared "all green" based on syntactic checks — that the code parsed, that imports resolved, that route tables registered the right paths. None of those tests actually exercised the pipeline against real audio. So every time you hit a real button in Premiere, something broke that the test suite had no idea about.

This fixture is the antidote. If a future change to stage 4, 5, 6 breaks the math, the snapshot tests fail at the byte level. If a Whisper upgrade silently degrades accuracy, the Tier-2 tests catch it. If something subtle drifts, `RESULTS.md` shows the regression in a number you can argue about.

This is the foundation. Everything else in the rebuild assumes these files are honest.

---

## Adding a new fixture

When future phases need a richer fixture (e.g. multi-speaker, longer takes, accented English, mixed-language) — don't replace `short/`. Add a sibling folder:

```
tests/fixtures/
├── short/        ← keep, stays the smoke fixture
├── mixed_lang/   ← new
├── multi_speaker/
└── ...
```

Each fixture follows the same shape (spec.md + canonical.json + scripts + expected plans + snapshots).
