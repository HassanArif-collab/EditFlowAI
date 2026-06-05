# EditFlow AI — Word-Level Transcript Editor (Review v2)

> Status: **PLAN ONLY — not implemented.** Supersedes the segment-level Review
> (which shipped and works) with a word-level editing model. The segment-level
> code stays as a fallback until v2 is proven.

## 1. Why (the core realization)

Segment-level keep/cut is the wrong unit for this footage. One Scribe cue mixes
junk **and** gold:

> `0:16` — `income کو--` *(false start)* `… So میرا نام ہے جاوید` *(clean intro)*

Keeping the cue keeps the false start; cutting it loses the intro. **No model can
fix this at the sentence level** — the unit of editing must be the **word**, with
the human selecting the span. This is the Descript / Premiere Text-Based-Editing
model. MiniMax beat Gemma only because it's a stronger model; the real win is
**word granularity + human control**, not a better model.

## 2. Decisions (from the interview)

| Decision | Choice |
|---|---|
| Word timestamps | **ElevenLabs Scribe (word-level)**. Build UI now with *approximate* word positions; swap to Scribe's exact times when the API key is added. |
| AI toggle | **Keep it.** Drop the word "Gemma" — label shows the **currently active model** (dynamic, e.g. "Use AI (MiniMax)"), driven by Settings. |
| Cut granularity | **Word/phrase ranges**, never whole forced sentences. |
| Primary view | **Word document + waveform strip** (transcript words + a synced waveform under the video for fine scrubbing). |
| Scope | **Everything** — all phases (word editor + AI + Scribe + multi-clip + polish). |
| Take-grouping | **Included** as a 2nd view ("Takes" tab), Phase 5 — turns ~50 manual cuts into ~8 best-take picks. |
| Existing system | Segment-level Review stays as fallback; v2 is additive. |

## 3. The new editing model (what it feels like)

A flowing transcript of **words**, each a clickable span carrying `start`/`end`:

- **Karaoke highlight** — as the video plays, the word being spoken lights up; the
  list auto-scrolls to it.
- **Scrub sync** — dragging the video playhead moves the highlight to the matching
  word (same `timeupdate`/`seeked` hook).
- **Click a word** → video seeks to that word's `start` (and plays).
- **Select a span** (click-drag, or click-start + shift-click-end) → **Cut**
  (strikethrough, greyed) or **Restore**. Double-click a word toggles just it.
- **Play original** (whole clip) vs **Play plan** (kept words only, skipping cut
  spans seamlessly in the proxy).
- **AI "Clean up (<active model>)"** — optional; pre-marks junk as **word/phrase
  cut ranges** with reasons (retake, filler, [non-speech], false-start,
  off-script). You refine by selecting. Reasons show on hover.
- **Live readout** — final runtime, words removed, % tightened.
- **Build sequence** — contiguous kept words merge into cuts
  (`source_in` = first kept word.start, `source_out` = last kept word.end) → the
  existing `/edit/plan/{id}/apply` → `processEDL` path. Zero new timeline code.

Keyboard-first: `Space` play/pause · `←/→` word nav · `Backspace` cut selection ·
`R` restore · `Ctrl+Z/Y` undo/redo · `Enter` play plan.

### 3b. Waveform strip (part of the primary view)
A horizontal waveform under the video, time-aligned to the proxy. Cut spans are
shaded; the playhead and the karaoke word stay in sync with it. Peaks computed
server-side from the proxy audio (ffmpeg → downsampled peaks JSON, cached) and
drawn on a `<canvas>`; click/drag the waveform to scrub. Gives frame-level
scrubbing precision the text alone can't.

### 3c. Optional second view — "Takes" (take-grouping)
A tab over the **same** keep/cut state. Clusters every attempt of a line into one
beat (matched to the script); each beat shows its takes stacked with ▶ A/B play
and a radio "use this take" that auto-cuts the rest, then word-trim inside the
winner. Turns ~50 manual cuts into ~8 best-take picks on retake-heavy footage.
Shows per-beat coverage and flags beats with no clean take. Build order: ships
**after** the word doc + waveform are solid (Phase 5).

## 4. Backend work

### 4a. ElevenLabs Scribe service (new) — `backend/services/scribe_service.py`
Grounded in verified docs (`client.speech_to_text.convert`):
- `POST /v1/speech-to-text/convert`, `model_id="scribe_v2"` (configurable),
  `file=<audio>`, `language_code="ur"`, `timestamps_granularity="word"`,
  `diarize=False`. Returns per-word `{text, start, end, type, speaker_id}`.
- API key read from **Settings** (user enters it; never in code/repo).
- Extract audio via bundled ffmpeg; **cache** the result by content fingerprint
  (reuse `media_fingerprint`) so a clip is billed once.
- **Cost estimate** endpoint: duration → `~N min ≈ $X` shown before the call.
- Normalize → `words[]` + derived `segments[]` (group words on pauses/punct).

### 4b. Word model + word-level classify — extend `review_service.py`
- `Word{ id, text, start, end, keep:bool, reason, group_id, conf }`.
- Deterministic word-level marks (model-free, reliable):
  - filler tokens (`haan ji`, `umm`) → cut those words;
  - `[non-speech]` tokens → cut;
  - **repeated-n-gram retakes**: find the longest repeated word runs; keep the
    last clean run, cut the earlier ones;
  - false-starts: word/phrase ending in `--` → cut the fragment.
- AI marks: prompt returns **cut ranges** `[{start_word, end_word, reason}]`
  (word indices), not sentence keep/cut. Layered: AI may only *add* cuts on top of
  the deterministic base; human override wins.

### 4c. Build from word spans — extend `routes/review.py`
- `POST /api/review/build` accepts kept word-ids (in order) → merge contiguous
  kept words into cuts → reuse `external_plan.build_plan_from_pasted_json` →
  `plan_id` → existing apply. Adds a tiny epsilon at joins; snaps to word edges.

### 4d. Interim approximate word times (no API)
- For a pasted segment-SRT, distribute each cue's words across its `[start,end]`
  proportional to character length → approximate `word.start/end`. Lets the whole
  word UI run **today**; Scribe replaces it with exact times later.

### 4e. Dynamic active-model name
- Expose / reuse `provider_service.get_active_chat()` (see `/api/status`) so the
  toggle label reflects the live model; refresh when Settings change.

## 5. Frontend work — rewrite the transcript area of `review-view.js`
- Render words as spans (`data-id/start/end`) inside paragraphs; selection layer;
  karaoke highlighter; scrub/seek sync; cut/restore; play original vs plan;
  dynamic-model toggle; "remove all fillers / retakes / [non-speech]" quick
  actions; undo/redo; live readout. New CSS in `review.css` (word spans, cut
  str-through, highlight, selection).
- Perf: ~1k–5k word spans render fine; virtualize only for very long clips.

## 6. Bugs to fix (found in your test)
- **`/paste-plan` "not building":** likely (a) the plan-card shows `""` / `0:00`
  because `_extractBeats` reads `beat.text`/`beat.start` but external cuts use
  `beat_text`/`source_in` (display-only bug); and/or (b) "Build sequence" fired
  `processEDL` but the **"New Sequence" preset dialog** needs an OK click, or
  import/createSequence errored. → Fix `_extractBeats` mapping for external cuts;
  verify `processEDL` apply end-to-end and surface any host error in the panel.

## 7. Feature menu — pick what you want (✓ = my v1 pick)

**Core editing**
- ✓ Word select + cut/restore (Descript-style)
- ✓ Karaoke highlight synced to play **and** scrub
- ✓ Click word → seek · double-click → toggle cut
- ✓ Play original / Play plan
- ✓ Undo/redo
- ✓ "Remove all fillers / retakes / [non-speech]" one-click cleanups

**Retake intelligence**
- ✓ Retake grouping: stacked takes, one-click "use this take" (auto-cuts others)
- A/B compare takes; auto-pick best (last clean / highest Scribe confidence)
- ✓ Script-beat mapping: color words by script line; flag missing beats (gaps)

**Precision & polish**
- Waveform strip under the video; cut regions shaded
- ✓ Dead-air auto-trim between kept words ("very tight") with a per-gap nudge
- ✓ Snap cuts to word boundaries (never mid-word) + audio-fade at joins
- Confidence shading (low-conf Scribe words lighter → review them)
- Keep-small-breaths option for natural rhythm

**Model / AI**
- ✓ Dynamic active-model label on the toggle (your ask)
- ✓ AI returns word-range cut marks + hover-to-see reason
- Paste-an-external-model marks (run in MiniMax etc., paste back) as alt path
- Aggressive vs conservative cleanup presets

**Workflow & output**
- ✓ Multi-clip: clip selector + "all clips" aggregate (your earlier ask)
- Export EDL / final SRT / cleaned transcript, alongside Build sequence
- ✓ Save/resume a review session
- Quick proxy "preview render" of the plan before building in Premiere
- Keep multiple cut versions (radio cut vs full)

**Scribe**
- ✓ Transcribe button + cost estimate + fingerprint cache
- Language auto/Urdu setting · speaker diarization filter (multi-speaker)

## 8. Phasing
1. **Word UI on approximate times** — render words, karaoke, scrub/seek, manual
   cut/restore, play original/plan, live readout. *(See & feel it, no API.)*
2. **Word-level cleanup** — deterministic junk + AI cut-ranges with dynamic model
   label; quick cleanups; undo/redo.
3. **Scribe integration** — exact word times, transcribe button, cost, cache, key
   in Settings.
4. **Build from word spans** + fix `/paste-plan`; **multi-clip** selector +
   aggregate.
5. **Polish** — retake grouping, script-beat coloring, waveform, exports.

## 9. Risks
- Scribe word-time accuracy (high) · per-minute cost (cache + estimate) · API key
  (user-entered) · CEP DOM perf on huge transcripts (virtualize if needed) ·
  approximate-times drift in phase 1 (expected; Scribe fixes it).
