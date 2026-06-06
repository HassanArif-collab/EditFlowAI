# Review Panel Redesign — Design Spec

> Status: **approved design, pre-implementation.** Visual reference (open with the
> mockups server, `python -m http.server --directory docs/superpowers/mockups`):
> `index.html` (layout), `2-editing.html` (selection), `3-font.html` (font),
> `4-panel.html` (full Edit panel), `5-takes.html` (Takes tab).

## 1. Context

The word-level Review editor (shipped) works functionally, but the UI is clunky
and has real bugs. User feedback + a UI/UX audit surfaced: no pause button; two
play buttons with no empty-plan handling; poor Urdu font; the promised "fold the
repeats" view never built; a fragile selection (only starts when the cursor is
pixel-on a word, and forces a trip to a Cut/Keep button); the Clean-up buttons do
nothing; the AI model name is stale until restart; "Play plan" plays content
that isn't in the plan; a cluttered toolbar; an immovable video. This spec
redesigns the panel to be **simple, good-looking, and correct**, and pins the
root-cause fixes.

## 2. Decisions (from the brainstorm)

| Area | Decision |
|---|---|
| Video | Flexible viewer: **docked + resizable** default · **Hide** toggle · **Pop-out → draggable floating PiP**. (User: "all three") |
| Single tap | Tap a word = **seek there + play** (not toggle). |
| Cut / keep | **Only via selection.** Native text selection — start anywhere, even in gaps. On release, every word the selection touched **flips**; the **first word sets the direction** (kept→cut, cut→restore). No buttons, no double-tap. |
| Font | **Noto Nastaliq Urdu** (bundled), tall line-height; cut = **faded red** (no strikethrough); now-playing = soft highlight. |
| Transport | **One Play/Pause.** Separate **"Preview cut"** — disabled until ≥1 word is cut; plays **only** kept words. |
| Toolbar | Declutter to: **Suggest · ‹live model›** + **Clean up ▾** menu (remove fillers / [non-speech] / repeated takes / restore all) + live **readout** (kept · runtime). |
| AI | Suggest shows **progress + Cancel**; model name read **live** from Settings. |
| Header | **Edit / Takes / Chat** tabs; Edit is default. |
| Takes tab | Beats = retake clusters; **pick best take per beat** (others auto-cut); per-take tag + ▶ A/B; coverage badges; "fine-trim in Edit"; shares keep/cut state with Edit. |

## 3. Layout

Fixed chrome, always present (top→bottom): **header (tabs)** · **transport bar**
· **waveform strip** · **toolbar**. The **transcript** fills the rest.

The **video is the one flexible element**:
- **Docked** (default): sits between header and transport, with a 6px drag handle
  to resize its height. Buttons: `⤢ pop out`, `✕ hide`.
- **Floating**: pop-out makes it an absolutely-positioned, **draggable**,
  resizable PiP overlaying the transcript; `✕` closes.
- **Hidden**: gone; transcript gets the full height; a small "show video" affordance returns it.

State persists for the session. The waveform + transport stay put regardless of
video state (so the playhead is always reachable).

## 4. Transcript & editing (the core interaction)

- The transcript is a flow of `<span class="w" data-id>` words inside `.doc`
  with `user-select: text` and a styled `::selection`.
- **Selection → edit (on `mouseup`):** if the native selection is non-collapsed,
  collect the `.w` spans it intersects (`range.intersectsNode`), set the edit
  **mode** from the first covered word (`kept → cut`, else `restore`), flip all
  covered words, push an undo snapshot, then clear the selection.
- **Tap (collapsed selection):** seek the video to the tapped word's `start` and
  play; update the karaoke highlight.
- **Karaoke + scrub:** on `timeupdate`/`seeked`, highlight the word containing
  `currentTime` (binary search), auto-scroll; mirror the playhead on the waveform.
- **Keyboard:** `Space` play/pause · `Ctrl+Z`/`Ctrl+Y` undo/redo · `Esc` clear.
- **On-screen undo/redo** (`↶ ↷`) because Ctrl+Z is invisible today.

## 5. Font & styling (Nastaliq)

Bundle **Noto Nastaliq Urdu** (woff2) in the panel — do **not** depend on the
Google Fonts CDN at runtime (CEP may be offline). `line-height: ~3.0`,
`font-size: ~15–16px`, `direction: rtl`. **Cut** word = `color: faded red,
opacity .4` (no strikethrough — it's messy on Nastaliq). **Now-playing** = soft
`--warning` background or accent underline. English tokens render in Inter/system,
`unicode-bidi: isolate`, LTR.

## 6. Transport, toolbar, Clean up, AI

- **Play/Pause** — one round button; controls the in-panel `<video>` (original).
- **Preview cut** — secondary; **disabled (greyed + tooltip "make some cuts
  first") when there are no cuts**; otherwise plays only kept ranges, hopping the
  cut spans. Uses the corrected merge (see §8).
- **Build** — primary; runs the existing build → apply backbone.
- **Suggest · ‹model›** — runs `/api/review/suggest`; the label shows the **live**
  active model (`/api/status` → `active_chat`), refreshed when the toolbar mounts
  and on a lightweight poll/visibility refresh. Running state: spinner +
  "Suggesting with ‹model›…" + progress + **Cancel** (frontend `AbortController`;
  backend best-effort).
- **Clean up ▾** — menu: Remove fillers · Remove [non-speech] · Remove repeated
  takes · Restore all. These run the word-level deterministic logic and **must
  actually mutate + re-render** (they're broken today — fix in §8).
- **Readout** — `kept/total words · M:SS` final runtime, always current.

## 7. Takes tab

- **Beats** = retake clusters, derived **client-side** from the `group_id` that
  `classify` already sets on each segment (returned in the suggest response) — **no
  new endpoint.** A beat = the segments sharing a `group_id`; a take = one of those
  segments; a take's words = the words whose `segment_id` is that segment.
  Singleton lines (`group_id = -1`) are trivial 1-take beats. Each beat's label =
  its matched script line, else the take text.
- **Each take row:** winner radio · ▶ (A/B play) · timecode · Nastaliq snippet
  (single-line, ellipsis) · **quality tag**: `clean` · `false start` (ends with
  `--`) · `stumble` (very short / stuttered) · `repeat`. Default winner = the last
  clean take (existing keep-last rule).
- **Pick a winner:** that take's words become **kept**, every other take's words in
  the beat become **cut** — same word state the Edit tab uses.
- **Coverage badges:** green "picked" · amber "pick one / no clean take".
- **Fine-trim in Edit →** switches to the Edit tab scrolled to that take's words.
- **Build · M:SS** reflects the picks. Edit ↔ Takes always agree.

## 8. Bugs to fix (root causes)

1. **Clean-up buttons do nothing** — the quick-cut handlers don't reliably mutate
   word state / re-render (binding + the filler-match regex). Rewire to the
   word-level deterministic actions; unit-test each.
2. **Model name stale** — it's fetched once at load. Refetch live (mount + poll /
   on settings change) so switching models updates the label immediately.
3. **Preview/Build plays or includes cut content** — `_mergedKeptRanges` (and the
   backend `words_to_cuts`) merge two kept words across a small **time** gap that
   can contain a **cut** word, so the cut word's span is included. **Fix: merge
   only words that are consecutive by index (no dropped word between them)**, not
   by time gap. Apply to both the client preview and the server build.
4. **"New Sequence" preset dialog** interrupts Build — create the output sequence
   from the source clip's settings/preset (`preset_from_clip_path`) so no modal pops.
5. **/paste-plan card** empty text/0:00 — already fixed (`_extractBeats`); verify.

## 9. States & errors

- **Empty / first-run:** "Transcribe with Scribe or paste a transcript to begin."
- **Loading:** proxy build + Scribe stream progress; panel stays responsive.
- **AI failure / cancel:** inline message; keep the deterministic result.
- Global uncaught-error banner already exists.

## 10. Code structure (isolate the growing file)

`review-view.js` has grown large. Split into focused modules with clear
interfaces, each independently understandable/testable:
- `review/shell.js` — open/close, tabs, state container, wiring.
- `review/video.js` — the flexible video (dock/float/hide/resize) + transport.
- `review/transcript.js` — word render, native-selection editing, karaoke.
- `review/waveform.js` — canvas peaks + playhead + cut shading + click-seek.
- `review/takes.js` — the Takes tab.
- `review/api.js` — review endpoints + the live-model + AI-cancel helpers.
Pure helpers (selection→ids, merge-by-index, beats-from-clusters) live in small
testable functions.

## 11. Testing

- **Unit (backend + pure JS helpers):** merge-by-index (no cut content), beats
  from clusters, selection-coverage→ids, each Clean-up action, quality tagging.
- **Visual:** the mockups are the reference; verify in the browser preview, then
  in the real Premiere panel.

## 12. Out of scope (separate work)

Multi-clip sessions, the installable-app/bootstrap, and the broader production
roadmap (`docs/plans/production-roadmap.md`). This spec is the **Review panel
UI/UX redesign + its bug fixes** only.
