# AE Animated Captions — Fixes + Rebuild (Design)

Date: 2026-07-17 · Branch: `feat/ae-animated-captions` · Status: approved by user

## Problem

The AE captions panel (`cep-panel-ae/`) has WYSIWYG and generation defects:

1. Preview canvas ignores the animation preset — always draws fade-up.
2. Preview font scale uses a `×1.5` fudge (`captions-view.js:1495`); slide/stroke/shadow
   use different ad-hoc scale bases. Text size on 9:16 comps doesn't match AE output.
3. Preview font mapping guesses a CSS family from the PostScript name and silently
   falls back to sans-serif for most fonts (`_fontFamilyFromPS`), so style changes
   appear dead.
4. Pill highlight in AE starts at the caption's first word, not its own word
   (`index.jsx:1092` — pill gets group lifetime; `pillStart` computed but unused).
5. Layer structure is inconsistent: captions with a pill → per-word layers;
   without → one layer with whole-sentence fade. Wanted: **one text layer per
   caption, word-by-word animation**.
6. Captions flash: `ef_setTimingCapped` enforces a 50 ms gap before the next
   caption. Wanted: hold until next caption + slight overlap (user's manual fix).
7. Panel grouping (`maxGap 0.4`) ≠ jsx grouping (`0.35` default) — AE output can
   split differently than preview.
8. Sentence-break detection only knows `.?!` — Urdu/Arabic/Hindi punctuation
   never breaks. Word timestamps come from plain faster-whisper (~200–300 ms
   error), noticeable in word-by-word animation.
9. "Max Lines" control does nothing; long captions can overflow 9:16 comps.
10. `cep-panel-ae/extendscript/caption_manager.jsx` + `utils.jsx` are dead code
    (only `index.jsx` is ever loaded).

## Decisions (user-confirmed)

- **Per-word mechanism**: one text layer per caption + Text Animator with
  **Expression Selector** (Based On: Words). Amount expression bakes each word's
  start time (relative to `inPoint`) and easing. Feature-probe
  `canAddProperty("ADBE Text Expressible Selector")` at generation time; fall
  back to the existing per-word-layers path if unavailable.
  - Verified match names: `ADBE Text Animators` / `ADBE Text Animator` /
    `ADBE Text Animator Properties` / `ADBE Text Opacity` / `ADBE Text Position 3D` /
    `ADBE Text Scale 3D` / `ADBE Text Selectors` / `ADBE Text Expressible Selector` /
    `ADBE Text Expressible Amount` / Based On = `ADBE Text Range Type2`.
    Sources: ae-scripting.docsforadobe.dev matchnames + PropertyGroup.addProperty;
    Adobe community validated sample; helpx.adobe.com (textIndex/textTotal/selectorValue).
- **Transcription**: local-only (no cloud engines). Whisper large-v3 stays.
  Phase 4 adds **WhisperX forced alignment** (arXiv 2303.00747): wav2vec2 phoneme
  alignment ⇒ ~50 ms word boundaries, VAD cut & merge. Toggle
  "accurate (WhisperX) / fast (Whisper)", default WhisperX when importable,
  graceful fallback otherwise. `stable-ts` is the documented middle option if
  WhisperX deps are a problem on this machine.
- **Language target**: English with transliterated Arabic terms. Captions stay
  Latin-script; a custom-vocabulary box feeds faster-whisper `hotwords` +
  `initial_prompt` (both verified present in installed faster-whisper 1.2.1)
  for consistent spelling of recurring Arabic phrases. True Arabic-script
  mid-sentence rendering (RTL/bidi in animators) is explicitly out of scope v1.
- **Line wrap**: real 2-line wrapping, decided by **character budget**
  (deterministic; preview and AE always agree). jsx measures after build and
  auto-shrinks the layer if it would overflow comp width (safety for 9:16).
- **Timing**: caption `outPoint = next caption's inPoint + overlap`
  (default 2 frames, slider 0–10), minimum display duration, tail hold on the
  last caption. Delete the 50 ms-gap rule.
- Overlap default 2 frames; typewriter preset = per-word staggered reveal in v1.

## Architecture

```
cep-panel-ae/client/src/caption-model.js   ← NEW single source of truth
  - groupWords(words, opts)      grouping incl. multilingual sentence-end punct
  - wrapLines(group, opts)       char-budget 2-line wrap (word→line assignment)
  - wordAnim(preset, t, word)    per-preset animation math {opacity, dy, scale}
  - easing functions             (same cubic forms the jsx expressions use)
  - timing (overlap/minDur)      caption in/out computation

captions-view.js                 imports caption-model for preview + grouping;
                                 canvas draws with ONE pxScale = canvasW/compW;
                                 fonts resolved via S.fonts family/style.

_buildConfig() → cfg.groups      panel sends FINAL groups (+line assignments,
                                 per-word times, timing); jsx stops re-grouping.

extendscript/index.jsx           builds: 1 text layer per caption; animator +
                                 expression selector per-word; pill shapes timed
                                 to their words; overlap timing; auto-shrink.

backend /api/subtitles/transcribe-mixdown
  + engine=whisperx|whisper      (Phase 4) alignment toggle + timestamp sanity
  + hotwords/initial_prompt      custom vocab pass-through
  + sanitize_words()             monotonic, non-overlapping, min 20 ms duration,
                                 interpolate missing/zero timestamps
```

Tests: `tests/` Node tests (pattern of `cep-bridge-regression.test.js`) for
caption-model + **evaluating generated jsx expressions** with mocked
`time`/`inPoint`/`textIndex`; pytest for backend changes.

## Phases & success criteria

1. **Shared caption model + test rig** — extract model, Node tests green,
   panel runs in a plain browser at `http://127.0.0.1:8765/panel-ae/` with a
   pasted transcript.
2. **WYSIWYG preview** — uniform scale (kill ×1.5), AE-fonts-driven canvas
   font, per-preset preview animation, 2-line render, content-list refresh on
   segment changes. Verified live in browser at 16:9 and 9:16 with screenshots.
3. **AE engine rebuild** — single-layer captions via expression selector, pill
   timing fix, overlap timing, auto-shrink, panel-supplied groups, delete dead
   jsx files. Verified by expression-eval tests + jsx syntax parse; final in-AE
   confirmation via runbook (user, when AE available).
4. **Transcription quality (local-only)** — multilingual punctuation set,
   custom vocab (hotwords/initial_prompt), WhisperX engine wiring behind
   toggle with fallback, timestamp sanity guards. pytest green; live local test
   against `tests/fixtures/short/interview_short.wav`.
5. **In-AE runbook** — numbered checklist (smoke caption, pill-on-word-3,
   9:16 font size, overlap, preset sweep) for the user to run in AE.

## Error handling

- jsx feature-probe fallback (expression selector → per-word layers).
- WhisperX unavailable/failed → faster-whisper path, surfaced in response `engine`.
- Alignment gaps (numbers, unalignable tokens) → interpolated timestamps in
  `sanitize_words()` (WhisperX adapter currently defaults them to 0 — guarded).
- Panel with no AE (browser) → CSInterface absent; preview fully functional,
  generation buttons error clearly.

## Out of scope (v1)

Arabic-script mixed rendering (RTL/bidi), per-character typewriter, Scribe/Gemini
cloud engines, MOGRTs, multi-comp batch.
