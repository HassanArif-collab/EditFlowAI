# Plan — Subtitles & Animated Captions for EditFlow AI

> **Status:** Approved design, ready to implement. Written for a step-by-step
> implementer. Each phase is independently shippable. **Do the phases in order.**
> Read `ARCHITECTURE.md` once before starting — this plan assumes its invariants
> (the cut-apply backbone, the ExtendScript dispatch router, the dynamic-import +
> `BUILD_TAG` view pattern, `ProgressReporter`, the no-store static mounts).

---

## 0. What this is, and what already exists

EditFlow AI already **transcribes** (faster-whisper word timestamps, ElevenLabs
Scribe, Gemini), stores word-level timing, and has a word-level **Review editor**
(`cep-panel/client/src/review-view.js`). This feature does **not** rebuild any of
that. It adds a **subtitle output path**: group transcribed words into cues, then
put them on the Premiere timeline as either a **native caption track** (plain,
editable) or **animated native text** (text-animator + animated background box).

**Hard platform fact (do not fight it):** Premiere Pro has **no ExtendScript API
to create a text graphic from scratch.** The only way to put native, editable
text on the timeline by script is `sequence.importMGT(...)` (import a Motion
Graphics Template) and then edit its **Source Text** parameter. Native caption
*tracks* also have **no scripting API** in ExtendScript. Both facts shape the
engines below. (Confirmed: Adobe forums + PProPanel sample + Captioneer/AutoSubs
behavior.)

### Locked decisions (already agreed — do not re-litigate)
| Topic | Decision |
|---|---|
| Output | Caption track (default) **and** animated native text (on demand) |
| Source | **Both** — subtitle the *final cut* (Review kept words) **and** *standalone* (any sequence/file, fresh transcribe) |
| Transcription | **Both Whisper (local) and Scribe (cloud) selectable in the panel** — see §4.1 |
| Animation depth | Cue-level **and** word-level (word-by-word; karaoke highlight is a stretch) |
| Animation engines | (a) **Built-in** code-keyframed presets I ship + (b) **Imported** rich AE-authored `.mogrt` presets |
| UI | A **dedicated Subtitles view**, sibling to the Review editor |
| Dropped | ❌ No baked ffmpeg/ASS video overlay. ❌ No Premiere-authored MOGRTs for text (they don't expose the text param to scripting). |

---

## 1. Architecture & data flow

```
WORDS[]  ──►  cue_builder  ──►  CUES[]  ──►  style + preset  ──►  render engine  ──►  ExtendScript placement
(source)     (grouping)       (interchange)   (user, in view)     (routed by preset)   (subtitle_manager.jsx)

source of WORDS[]:
  • FINAL CUT  → Review session kept words, REMAPPED to output-sequence time (§3)
  • STANDALONE → fresh transcribe via Whisper OR Scribe (§4, §4.1)

render engines (routed by the chosen preset's "engine" field):
  • caption  → write .srt → ExtendScript places a caption track (or SRT-import fallback)
  • builtin  → per cue: importMGT(base_text.mogrt) → set Source Text → keyframe Motion (Scale/Opacity/Position)
  • mogrt    → per cue: importMGT(<preset>.mogrt) → set Source Text (+ colors); animation is baked in the template
```

Everything is **additive**, like `review.py`. A failure in subtitles must never
mutate Review / agent / cut state.

---

## 2. The cue model (the one interchange shape)

Every engine consumes the same list. Times are in **seconds, in the TARGET
sequence's timeline** (after remap for the final-cut path).

```jsonc
{
  "cues": [
    {
      "index": 0,
      "start": 0.50,            // seconds, target-sequence time
      "end": 2.10,
      "text": "Hello world",    // full cue text (already line-wrapped if needed)
      "words": [                // word-level timing inside the cue (for karaoke / word-by-word)
        { "text": "Hello", "start": 0.50, "end": 1.20 },
        { "text": "world", "start": 1.20, "end": 2.10 }
      ]
    }
  ]
}
```

---

## 3. Source A — subtitle the FINAL CUT (time remapping)

After cuts are applied, the output sequence is a **contiguous concatenation of
the kept spans**. Subtitle times must be in **output** time, not source time.

**Algorithm (put in `cue_builder.remap_kept_words_to_output`):**
1. Take the Review session's `words` (from `_reviews[review_id]["words"]`), the
   list ordered as on the source.
2. Keep only `w.keep == True`, preserving order.
3. Walk them; maintain `out_cursor = 0.0`. For each maximal run of contiguous
   kept words (contiguous = `w[i].start ≈ w[i-1].end`, i.e. the same kept span),
   map each word: `out_start = out_cursor + (w.start - run_source_start)`,
   `out_end = out_cursor + (w.end - run_source_start)`. After the run, advance
   `out_cursor += (run_source_end - run_source_start)`.
4. The result is `words_out[]` with output-time stamps. Feed those into the cue
   builder (§5).

> This mirrors how `words_to_cuts()` (in `review_service.py`) already merges
> contiguous kept words into cuts — reuse its contiguity logic. Unit-test this
> against a known kept/cut pattern (Rule 7: encode *why* — wrong remap = captions
> drift out of sync after the cut).

For Phase 0/1 you may ship the **standalone** path first (no remap) and add the
final-cut remap when wiring the "Subtitle this cut" button.

---

## 4. Source B — standalone (any sequence/file)

Reuse what exists; do **not** add a new transcription engine — just expose the two
that exist (§4.1).
- **Scribe:** `POST /api/review/transcribe` already returns `{words[], media_url, ...}`.
- **Whisper:** `whisper_service.transcribe_fingerprinted(...)` (faster-whisper) → adapt to the same `words[]` shape (§4.1).

The Subtitles view's "Transcribe a sequence/file" action calls the transcribe
endpoint with the chosen engine, gets `words[]`, then runs the cue builder. Source
resolution reuses `review.py::_resolve_source` (basename / path / bin / project scan).

---

## 4.1 Transcription engine choice — Whisper (local) **and** Scribe (cloud) in the panel

**Goal:** the panel lets the user pick the engine for the no-paste transcribe.
Today the no-paste path (`POST /api/review/transcribe`) is **Scribe-only**;
Whisper exists in the backend but isn't offered in that UI. Add Whisper as a
sibling option, in **both** the existing Review setup screen and the new Subtitles
view.

### Backend — one endpoint, an `engine` switch
Edit `backend/routes/review.py`:
1. `TranscribeReq`: add `engine: Optional[str] = "scribe"  # "scribe" | "whisper"`.
2. In `transcribe_clip()`, branch on `req.engine`:
   - `"scribe"` → existing path (`scribe_service.transcribe` → `build_segments_and_words`).
   - `"whisper"` → call the Whisper service and adapt its result (below). No API
     key, no cost estimate. Set `rev["transcript_source"] = "whisper"`.
3. Keep the **identical return shape** (`review_id, words, segments, summary,
   word_summary, media_url, …`) so the frontend is engine-agnostic after the call.

**Whisper → editor adapter** (add to `review_service.py` or a small helper):
```python
from .review_service import Segment, Word, words_from_segments

def build_segments_and_words_from_whisper(result) -> tuple[list[Segment], list[Word]]:
    """TranscriptResult (faster-whisper) → editor Segment/Word, matching Scribe's shape.
    result.segments[i] = TranscriptSegment(start, end, text, words=[TranscriptWord(word,start,end)])"""
    segments, words, wid = [], [], 0
    for i, seg in enumerate(result.segments):
        s, e = round(seg.start, 3), round(seg.end, 3)
        segments.append(Segment(id=i, start=s, end=e, text=(seg.text or "").strip(),
                                tight_in=s, tight_out=e))
        for w in (seg.words or []):
            words.append(Word(id=wid, text=(w.word or "").strip(),
                              start=round(w.start, 3), end=round(w.end, 3), segment_id=i))
            wid += 1
    if not words:                       # word_timestamps missing → interpolate
        words = words_from_segments(segments)
    return segments, words
```
Call site (whisper branch in `transcribe_clip`):
```python
from ..services.whisper_service import whisper_service          # process-global singleton
reporter = ProgressReporter(task_type="transcribe", client_id=req.client_id)
result = await whisper_service.transcribe_fingerprinted(
    source_path, language=(req.language_code or None),
    word_timestamps=True, progress=reporter)
segments, words = build_segments_and_words_from_whisper(result)
```
(Confirm the exact singleton import name used elsewhere — `grep -n "whisper_service" backend/services/agent/tools.py`. Model selection already lives in Settings / `whisper_admin`; don't add a second model picker here.)

### Frontend — an engine toggle in the setup screen
Edit `cep-panel/client/src/review-view.js` setup screen (`_renderSetup`, ~line 90):
- Add `S._engine = 'scribe'` to state (default).
- Add a small segmented toggle above the transcribe button:
  `[ Scribe (cloud · exact) ] [ Whisper (local · free) ]` (reuse `rv-btn`/`rv-tab` styling).
- The **API-key row + cost estimate/confirm are Scribe-only** — hide them when
  Whisper is selected.
- Generalize `_transcribeScribe()` → `_transcribe(engine)`:
  - **Scribe:** keep the estimate → confirm → POST flow (unchanged).
  - **Whisper:** skip estimate/key; button reads "Transcribe with Whisper (local)";
    directly `POST /api/review/transcribe { source_file, script, engine:'whisper', language_code }`.
    Show a "this can take a while on CPU" hint; listen for WS `progress`
    (`task_type:"transcribe"`) for the bar.
- After either call, the existing `_applyReviewResp(resp, script)` handles the
  result unchanged (engine-agnostic).

The **Subtitles view** (§13) reuses the same toggle + endpoint for its
"Transcribe a sequence/file" action.

> Verification note: this is a CEP panel (runs inside Premiere) — it can't be
> exercised by the web-preview harness. Verify by: (a) `py_compile` the edited
> Python; (b) a quick unit test of `build_segments_and_words_from_whisper` against
> a fake `TranscriptResult`; (c) manual test in Premiere (pick Whisper, transcribe,
> confirm words land in the editor). Bump `BUILD_TAG` (§13) for the JS change.

---

## 5. cue_builder — words[] → cues[]

**File:** `backend/services/subtitles/cue_builder.py` (pure functions, no I/O).

```python
def build_cues(words: list[dict], opts: CueOpts) -> list[dict]:
    """Group words into subtitle cues. Pure + deterministic."""
```

`CueOpts` fields (with defaults):
- `max_words_per_cue: int = 7`
- `max_chars_per_line: int = 42`
- `max_lines: int = 2`
- `max_cue_duration: float = 6.0` (seconds)
- `max_gap: float = 0.8` (split a cue if the silence between two words exceeds this)
- `split_on_sentence_end: bool = True` (break after `. ? !` and sentence-final punctuation; language-agnostic — also treat Urdu `۔` per existing bidi handling)

**Rules (apply in order, start a new cue when any trips):**
1. Adding the next word would exceed `max_words_per_cue`, **or**
2. would exceed `max_chars_per_line * max_lines` total chars, **or**
3. would make `(word.end - cue.start) > max_cue_duration`, **or**
4. the gap `word.start - prev_word.end > max_gap`, **or**
5. the previous word ended a sentence (and `split_on_sentence_end`).

Each cue's `text` is the words joined by spaces, **line-wrapped** greedily into at
most `max_lines` lines of ≤ `max_chars_per_line`. `cue.start = first word.start`,
`cue.end = last word.end`. Keep the per-word array for karaoke/word-by-word.

**Word-by-word mode** (`opts.word_mode == "word"`): emit **one cue per word**
(or per 1–3 word chunk if `chunk_size` set). This is the Submagic "each word pops
in" look and is what the built-in/MOGRT word-level presets place.

Unit tests: empty input → `[]`; a single long sentence → multiple cues obeying
every cap; a big gap → forced split; word mode → one cue per word with matching
times.

---

## 6. Styling model

**File:** `backend/services/subtitles/style.py`

```python
@dataclass
class SubtitleStyle:
    font_family: str = "Inter"
    font_size: int = 64           # px at 1080p reference; scaled to seq height
    text_color: str = "#FFFFFF"
    bg_color: str = "#000000"     # background box behind text
    bg_opacity: float = 0.6       # 0..1 ; 0 = no box
    outline_color: str = "#000000"
    outline_width: int = 4
    position: str = "bottom"      # top | middle | bottom
    safe_margin: float = 0.10     # fraction of frame height kept clear at edges
    align: str = "center"
    highlight_color: str = "#FFE600"  # karaoke active-word color (stretch)
```

- **Caption track** uses what it can of this (font/size/color/position) via the
  SRT/caption styling Premiere supports — limited; document what survives.
- **Built-in** path: the base template exposes Text Color / BG Color params we set
  from this; size/position handled by Motion scale + the template anchor.
- **MOGRT** path: we set whatever params the preset exposes (mapped via manifest).

The **dedicated view renders a live HTML/CSS preview** of a cue using these values
so the user sees the look instantly **without** a Premiere round-trip. (Pure CSS:
text + a box div with `background: rgba(bg_color, bg_opacity)`, outline via
`text-shadow`/`-webkit-text-stroke`, positioned in a 16:9 preview frame.)

---

## 7. Render engine — CAPTION TRACK (plain, default)

**Goal:** generate cues → SRT → place a native caption track. Fully editable in PPro.

1. **SRT export** — `backend/services/subtitles/srt_export.py::cues_to_srt(cues) -> str`.
   Reuse the existing Review SRT logic if present (`tests/unit/test_review_srt.py`
   exists — find and reuse the producer it tests). Format: `idx\nHH:MM:SS,mmm --> HH:MM:SS,mmm\ntext\n\n`.
2. Write the SRT to a temp path (under `data/output/subtitles/<id>.srt`).
3. **ExtendScript placement — CAPABILITY SPIKE FIRST** (Phase 1). Native caption
   *track* creation via ExtendScript is historically unreliable. Spike using the
   existing `capability_probe.jsx` pattern. Two outcomes:
   - **If scriptable:** `subtitle_manager.placeCaptionTrack(srtPath)` imports the
     SRT as a caption project item (`app.project.importFiles([srtPath])`) and adds
     it to a caption track on the active sequence.
   - **If not reliable (likely):** **fallback** — return the SRT path to the panel
     and show a one-click "Import this SRT" handoff (open the folder / copy path),
     OR route plain captions through the **built-in engine** with the `none`
     animation preset (static text clips). Pick the fallback the spike proves works.

> Be honest in the UI about which path is active. Do not claim caption-track
> scripting works until the spike proves it on the target PPro version.

---

## 8. Render engine — BUILT-IN animations (I ship these)

These need **one** trivial **base text template** (`base_text.mogrt`, authored in
AE per §10.1). Everything else is **code** — ExtendScript keyframes on the placed
clip. This is the original plan doc's `addScaleKeyframes`/`addOpacityKeyframes`
approach.

**Per cue:**
1. `clip = seq.importMGT(baseMogrtPath, startTicks, vidTrackOffset, audTrackOffset)`
2. Set Source Text (and Text/BG color params) — see §9 for the exact JSON dance.
3. Fit duration: trim the clip so `clip.end == cueEndTicks` (set out point / end).
4. Apply the chosen built-in animation by keyframing the clip's **Motion** /
   **Opacity** components.

**Built-in presets (ship all of these):**

| Preset id | What it does | Keyframes |
|---|---|---|
| `none` | static | none |
| `fade` | fade in (+ optional fade out) | Opacity 0→100 over `introFrames`; 100→0 over last `outroFrames` |
| `pop` | scale pop-in | Scale 0→110→100 over introFrames |
| `slide_up` | rises into place | Position.y `start+offset → start`; pair with `fade` |
| `bounce` | overshoot pop | Scale 0→120→90→100 |
| `rise_bg` | background box wipes/scales in behind text | keyframe the base template's BG layer Scale/Opacity (base template must expose a BG group — see §10.1) |

**Exact keyframing pattern (ExtendScript):**
```javascript
// motionComp is the "Motion" component; find Scale/Position/Opacity props by display name.
function addScaleKeyframes(clip, startTicks, popTicks, endScale) {
    var motion = _findComponent(clip, "Motion");           // see §11 helper
    var scale = motion.properties.getParamForDisplayName("Scale");
    scale.setTimeVarying(true);
    scale.addKey(startTicks);  scale.setValueAtKey(startTicks, 0, true);
    scale.addKey(popTicks);    scale.setValueAtKey(popTicks, endScale, true);
}
```
Opacity lives on the **Opacity** component; Position on **Motion → Position**.
Convert seconds→ticks with `254016000000 ticks per second` (Premiere's tick rate).
Keyframe times are **absolute sequence ticks**, not clip-relative.

> Performance: built-ins place 1 clip per cue (a few hundred for a long video).
> `importMGT` + JSON set is ~seconds each → show a `ProgressReporter`
> (`task_type="subtitles"`) and a count, and warn if `len(cues) > 400`.

---

## 9. Setting MOGRT text & params (the exact API — used by §8 and §10)

After `clip = seq.importMGT(...)`:
```javascript
var comp = clip.getMGTComponent();
var p = comp.properties.getParamForDisplayName("Source Text");  // exact display name
var v = JSON.parse(p.getValue());
v.textEditValue = newText;
v.fontTextRunLength = [newText.length];   // REQUIRED or PPro mis-renders
p.setValue(JSON.stringify(v), true);      // 2nd arg true = forceUpdate

// colors (only if the template exposes them):
var c = comp.properties.getParamForDisplayName("Text Color");
if (c) c.setValue([r, g, b, 1], true);    // 0..1 floats, RGBA
```
**Gotcha (confirmed):** this works on **After Effects-authored** MOGRTs.
Premiere-authored text MOGRTs frequently **don't** expose the component — that's
why §10 requires AE authoring.

---

## 10. Render engine — MOGRT import (rich, user-authored) + the authoring spec

The code is **template-agnostic**: it reads a **manifest** that maps a preset to a
`.mogrt` file and its exposed param display-names. The plugin ships an **import
preset** UI: the user drops a `.mogrt`, the importer reads its exposed params
(by display name) and writes a manifest entry; the user maps unknown names to our
standard roles (sourceText / textColor / bgColor / highlightColor).

**Placement** is identical to §8 steps 1–3 (importMGT → set Source Text + colors →
fit duration). **No ExtendScript keyframing** — the animation is baked into the AE
template's text animators + background layers.

### 10.1 Authoring spec — the BASE TEXT template (`base_text.mogrt`)
For the built-in engine. Build in **After Effects** (Essential Graphics → Export
Motion Graphics Template). Requirements:
- **Comp size:** 1920×1080 reference (we Motion-scale to other sequence sizes).
- **One text layer**, single style run (do **not** mix multiple character styles —
  it breaks the `fontTextRunLength = [len]` trick).
- **Anchor** the text (and its parent group) to **bottom-center**, sitting inside
  the lower ~10% safe margin.
- **A background group** behind the text (a shape layer: rounded rect that
  auto-sizes to the text via expressions, or a fixed pill). Built-ins keyframe its
  Scale/Opacity for `rise_bg`, so it must be a distinct group.
- **Expose in Essential Graphics, with these exact display names:**
  - `Source Text` (the text layer's Source Text) — **required**
  - `Text Color` (text fill) — recommended
  - `Background Color` (bg shape fill) — recommended
  - `Background Opacity` (bg shape opacity, 0–100) — optional
- **No baked-in animation** in the base template (built-ins add it via keyframes).
- Keep it light (no heavy effects) so preview renders fast.

### 10.2 Authoring spec — RICH animated presets (user makes many)
Same exposed-param contract as above (so they're interchangeable), **plus**:
- Bake the **text-animator** in/out animation into the template (AE text
  animators: position/scale/opacity per-character or per-word, etc.).
- Bake the **animated background** (box/pill/highlight that wipes or scales in
  behind the text).
- **Timing convention so trimming works:** put the **intro** animation in the
  **first `introFrames`** of the comp and the **outro** in the **last
  `outroFrames`**, with a **hold** in the middle (use a long comp / loop or
  time-remap hold). Document `introFrames` / `outroFrames` per preset in the
  manifest so the placer can keep cues longer than the comp from cutting the hold.
- Optional extra exposed params: `Highlight Color`, `Font Size`/`Scale` slider.
- **File naming:** `<presetId>.mogrt`, dropped in `cep-panel/templates/subtitles/`.

### 10.3 Manifest format
**File:** `cep-panel/templates/subtitles/presets.json`
```jsonc
{
  "presets": [
    {
      "id": "pop",                 // built-in (engine="builtin") — no mogrtFile needed beyond base
      "label": "Pop In",
      "engine": "builtin",
      "animation": "pop",          // maps to a §8 keyframe routine
      "wordMode": "line"           // "line" | "word"
    },
    {
      "id": "neo-karaoke",
      "label": "Neon Karaoke",
      "engine": "mogrt",
      "mogrtFile": "neo-karaoke.mogrt",
      "wordMode": "word",
      "introFrames": 6,
      "outroFrames": 6,
      "params": {                  // role -> exact display name in THIS template
        "sourceText": "Source Text",
        "textColor": "Text Color",
        "bgColor": "Background Color",
        "highlightColor": "Highlight Color"
      }
    }
  ]
}
```
The **import UI** appends entries here; built-ins are seeded at first run.

### 10.4 Word-level & karaoke
- **Word-by-word** (`wordMode: "word"`): cue builder emits one cue per word; placer
  stamps one clip per word. Works for built-in (pop/fade each word) **and** mogrt.
  This is the reliable, default "word-level" look.
- **True karaoke highlight** (full line, current word recolors) = **STRETCH
  (Phase 3b)**. Needs an AE template that reads per-word timing via an expression
  driven by a keyframed slider param we set per word, OR overlapping per-word
  colored clips. Ship word-by-word first; attempt karaoke only after.

---

## 11. ExtendScript — `cep-panel/extendscript/subtitle_manager.jsx`

New module, same shape as the other managers (an object literal of functions,
returns `editflowUtils.safeStringify({...})`). Functions:

| Function | Args (from JSON payload) | Does |
|---|---|---|
| `getSequenceVideoSettings()` | — | returns `{width, height, fps, par, durationTicks}` (read from `app.project.activeSequence`) so the backend/view know the target frame |
| `placeCaptionTrack(opts)` | `{srtPath}` | Phase 1 spike result — native caption track or documented fallback |
| `placeSubtitleClips(opts)` | `{mogrtPath, baseMogrtPath, trackIndex, cues:[...], style, animation, params}` | loops cues: importMGT → set Source Text (+colors) → fit duration → (builtin) keyframe Motion. Returns count placed + any per-cue errors |

Helpers (private): `_findComponent(clip, name)`, `_setMogrtText(clip, text, params, style)`,
`_addScaleKeyframes`, `_addOpacityKeyframes`, `_addPositionKeyframes`, `_secToTicks`.

**Wire-up (3 edits, mirror existing patterns):**
1. `cep-panel/extendscript/index.jsx`: add `"subtitle_manager.jsx"` to
   `editflowModuleNames` (after `effects_manager.jsx`).
2. Same file, in `editflowDispatch`'s `switch`: add cases
   `getSequenceVideoSettings`, `placeCaptionTrack`, `placeSubtitleClips` →
   `subtitleManager.<fn>(options)`. Add the two placement commands to the
   `modifyingCommands` array (for undo counting).
3. `cep-panel/client/src/extendscript.js`: add the three command names to the
   dispatch allowlist in `_buildScript` (the `[...].includes(fnName)` array) so
   they route through `editflowDispatch`.

> Placement is the ONE timeline-writing operation here. It does **not** go through
> the cut-apply backbone (that's for cuts, not captions) — captions are additive
> graphics, so a dedicated path is correct. Wrap all DOM access in try/catch and
> return `{success:false,error}` per the "tools never raise" convention.

---

## 12. Backend — files & endpoints

**New package:** `backend/services/subtitles/`
- `cue_builder.py` (§5, §3 remap)
- `style.py` (§6)
- `srt_export.py` (§7)
- `presets.py` — load/merge `presets.json`, seed built-ins, append imported entries.

**New route:** `backend/routes/subtitles.py` (prefix `/api/subtitles`), register in
`backend/main.py` next to the other routers. Endpoints:

| Method/Path | Body | Returns |
|---|---|---|
| `POST /cues` | `{review_id?, words?, source:"final_cut"\|"standalone", opts}` | `{cues, summary}` — builds cues (remaps if `final_cut`) |
| `POST /srt` | `{cues}` | `{srt_path, srt}` |
| `GET /presets` | — | `{presets}` (from manifest) |
| `POST /presets/import` | `{mogrt_path, exposed_params, mapping, label, wordMode, frames}` | appends manifest entry → `{preset}` |
| `POST /placement-payload` | `{cues, style, preset_id}` | `{command, payload}` ready for the panel to hand to ExtendScript (resolves base/preset mogrt absolute paths, maps params) |

The panel calls `/placement-payload`, then calls ExtendScript `placeSubtitleClips`
with the returned payload (only the frontend can drive ExtendScript — same rule as
the scan/cut flow). Use `ProgressReporter(task_type="subtitles", client_id=...)`.

---

## 13. Frontend — `cep-panel/client/src/subtitles-view.js` (the dedicated view)

**Mirror `review-view.js` exactly:**
- Export `openSubtitles(opts)` and `closeSubtitles()`.
- In `main.js`: dynamic-import it with the `BUILD_TAG` cache-buster, assign
  `openSubtitles`, expose `window.__editflowOpenSubtitles = openSubtitles`
  (copy the `review-view.js` import block at `main.js:81`). **Bump `BUILD_TAG`**.
- Self-inject `styles/subtitles.css` with a `?v=<timestamp>` link (copy the
  review.css self-injection in `review-view.js`).
- Build the view as `<div id="subtitles-view" class="hidden">` appended to
  `#app-main` (copy the `#review-view` creation pattern).
- Add a header button to open it (next to the 📝 Review button) and a
  **"Subtitle this cut"** button **inside Review** that calls
  `window.__editflowOpenSubtitles({ reviewId, source:'final_cut' })`.

**View contents:**
- **Source panel:** "From current cut (Review)" | "Transcribe a sequence/file"
  — the latter shows the **Whisper | Scribe** engine toggle (§4.1) and reuses
  `/api/review/transcribe` + source resolution.
- **Cue list:** editable list of cues (text + in/out); reuses the word/segment
  rendering ideas from `review-view.js`.
- **Style panel:** the §6 fields with a **live CSS preview** of one cue.
- **Animation panel:** preset picker (from `GET /api/subtitles/presets`), grouped
  Built-in vs Imported; an **"Import .mogrt preset"** button (file pick →
  `POST /presets/import`).
- **Actions:** `Add captions to timeline` (plain → caption engine),
  `Add animated subtitles` (→ builtin/mogrt engine), `Export SRT`.
- Listen to WS `progress` (`task_type:"subtitles"`) to render the placement bar.

---

## 14. Phasing (do in order; each ships value)

### Phase 0 — Foundation (no timeline writes; zero PPro risk)
- `cue_builder.py` (+ remap) + unit tests.
- `style.py`, `srt_export.py` (+ reuse Review SRT) + tests.
- `subtitles.py` route: `/cues`, `/srt`.
- `subtitles-view.js` shell + live CSS preview + cue list edit + **Export SRT**.
- Wire the view into `main.js` (BUILD_TAG bump) + header button + "Subtitle this cut".
- **Success:** from a Review session OR a standalone transcribe, generate cues,
  edit/style them, see a live preview, export a correct SRT. No Premiere writes.

### Phase 0.5 — Whisper/Scribe engine toggle (§4.1)  ← small, do early
- Backend `engine` param on `/api/review/transcribe` + Whisper→editor adapter + test.
- Frontend engine toggle in the Review setup screen and the Subtitles view.
- **Success:** user picks Whisper or Scribe in the panel; either lands words in the editor.

### Phase 1 — Caption track
- `capability_probe`-style spike for native caption insertion on the target PPro.
- `subtitle_manager.jsx` (`getSequenceVideoSettings`, `placeCaptionTrack`) + wire-up (§11).
- Implement the proven path or the documented fallback (§7).
- **Success:** "Add captions to timeline" produces an editable caption track (or
  the honest fallback) synced to the video.

### Phase 2 — Built-in animated captions
- Author `base_text.mogrt` per §10.1 (the only template needed here).
- `placeSubtitleClips` (builtin branch) + the §8 keyframe routines + duration fit.
- `presets.json` seeded with built-ins; preset picker in the view.
- `ProgressReporter` + >400-cue warning.
- **Success:** "Add animated subtitles" with `pop`/`fade`/`slide`/`bounce`/`rise_bg`
  places native, animated, editable text clips synced to the cues. Word-by-word
  mode works (one clip per word).

### Phase 3 — Rich MOGRT presets + import
- Manifest loader + `POST /presets/import` + import UI.
- `placeSubtitleClips` (mogrt branch) reads param mapping from manifest.
- Author 1–2 example rich presets in AE per §10.2 to validate the contract.
- **Success:** user drops a `.mogrt`, maps its params, and places animated
  captions using their own template.

### Phase 3b — Karaoke highlight (stretch)
- AE template with per-word timing (expression-driven slider we keyframe) OR
  overlapping per-word colored clips. Attempt only after 0–3 are solid.

---

## 15. Risks & open questions (flag, don't paper over)
- **Caption-track scripting** may be unreliable → Phase 1 spike + fallback. Don't
  claim it works until proven on the user's PPro version.
- **MOGRT text-set requires AE-authored templates** (Premiere-authored often fail
  to expose the param). Base + rich templates must be AE-built.
- **Preview render cost:** AE-MOGRT animated captions make PPro render the graphics
  layer (slow preview vs plain graphics — tools claim ~20–40×). Mitigate: keep
  templates light, render work-area only. State it in the UI.
- **Time remap** (final cut) is the subtle correctness risk → unit-test hard.
- **Per-cue placement speed:** `importMGT` is ~seconds/clip → progress + cap warning.
- **Whisper on CPU is slow** (no NVIDIA GPU): the toggle must warn + recommend a
  smaller model; the Scribe path stays the fast default.
- **Tick math:** 254016000000 ticks/sec; keyframe times are absolute sequence ticks.
- **Open:** does the target PPro version expose `Text Color` on AE MOGRTs reliably?
  Verify during Phase 2 template authoring; if not, drop color params to "set via
  template default" and restyle by swapping presets.

---

## 16. Verification
- **Unit (pytest):** `cue_builder` grouping + the kept-words→output-time remap;
  `srt_export` timestamp formatting; `presets` manifest merge/seed;
  `build_segments_and_words_from_whisper` against a fake `TranscriptResult`.
- **Spikes:** caption insertion (Phase 1) and MOGRT text-set (Phase 2) verified in
  PPro before building on them (use `capability_probe.jsx`).
- **Manual (in Premiere — the panel can't be run by the web-preview harness):**
  place on a real sequence; scrub and confirm captions/animations are in sync;
  confirm the final-cut path matches the cut timeline; confirm word-by-word timing;
  confirm Whisper vs Scribe both land words; confirm import of a user `.mogrt`.
- **Regression:** Review / agent / cut flows untouched (this is additive).

---

## 17. Exact integration touch-points (where to wire in)
- Transcribe engine param: `backend/routes/review.py` (`TranscribeReq`, `transcribe_clip`); adapter in `backend/services/review_service.py`; whisper singleton import per `backend/services/agent/tools.py`.
- Transcribe engine toggle (UI): `cep-panel/client/src/review-view.js` `_renderSetup` (~line 90) + `_transcribeScribe` (~line 158) → generalize to `_transcribe(engine)`.
- New view registration & BUILD_TAG: `cep-panel/client/src/main.js` (~line 81; copy the review-view import block; bump `BUILD_TAG` at line 7).
- ExtendScript module list & dispatch: `cep-panel/extendscript/index.jsx` (`editflowModuleNames` ~line 11; `switch` in `editflowDispatch` ~line 190; `modifyingCommands` ~line 360).
- ExtendScript dispatch allowlist: `cep-panel/client/src/extendscript.js` `_buildScript` (the `.includes(fnName)` array ~line 92).
- Router registration: `backend/main.py` (where other routers are `include_router`'d).
- Source resolution / transcribe reuse: `backend/routes/review.py::_resolve_source`, `POST /api/review/transcribe`.
- SRT producer to reuse: whatever `tests/unit/test_review_srt.py` exercises.
- Progress: `backend/utils/progress.py::ProgressReporter` with `task_type="subtitles"` (placement) / `"transcribe"` (whisper); render via the panel's WS `progress` handler.
- Static serving of the new JS/CSS: already covered by `_NoCacheStatic` in `backend/main.py` — no change needed.
