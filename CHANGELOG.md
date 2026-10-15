# Changelog

All notable changes to the EditFlow AI project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [3.0.0] - 2026-10-15

### Major Release: Captions Studio 3.0

Captions Studio 3.0 introduces section-by-section timeline workflow, speech-accurate sentence grouping, natural timeline audio playback, and production-grade stability for timeline caption overlays.

### Added
- **Sequence In/Out Scope Selection**:
  - Automatically detect and display sequence In and Out points from the active Premiere Pro sequence (`seq.getInPoint()`, `seq.getOutPoint()`).
  - Added dedicated In/Out scope toggle in the Captions panel to transcribe and generate captions only for the selected region.
  - Section-by-section captions render and place directly at the timeline in-point (`tStart`) without leading transparent frames.
- **Natural Timeline Audio Playback**:
  - Synchronized audio preview playback that respects Premiere Pro timeline clip volume faders and unmuted audio tracks.
  - Mixes timeline audio directly from active speech tracks so background music and SFX at low volume levels do not overpower the dialogue.
- **Vertical Text Box Resizing & Center Snap**:
  - Resizable bounding box handles for vertical height (`n`, `s`, `ne`, `nw`, `se`, `sw`) in addition to width.
  - Center-pinned anchoring preventing horizontal or vertical box drift when dragging handles.
  - Dedicated "Center 50%" quick action and visual snap guideline at stage midpoint.
- **Sequence Video Frame Preview**:
  - Captures actual Premiere Pro sequence video frame at playhead position (`CTI`) as the canvas background preview.
  - Prioritizes underlying video clips over graphics/captions for a genuine WYSIWYG editing experience.
- **Granular Punctuation Controls**:
  - Added "No-Dots" mode (keeps question marks, exclamation marks, and commas; strips ending periods).
  - Added granular toggle switches for individual punctuation marks (comma, period, exclamation, question mark).
- **Content-Addressed Mixdown Caching**:
  - Hash-based caching of sequence audio extraction to avoid redundant audio re-rendering across repeated turns.
  - Added one-click transcript clear and reset functionality.
- **Resizable Stage & Zoom Presets**:
  - Stage zoom levels: 25%, 50%, 75%, 100%, and Fit-to-Window for high-precision word positioning and typography inspection.

### Fixed
- **Prevent Media Offline Bug**:
  - Disabled automatic disk pruning of production `.mov` caption video files in output directories.
  - Changed temporary file cleanup pattern from `*.mov` to `*.wav`, ensuring Premiere Pro never loses links to rendered overlays.
- **Protect Non-Overlapping Timeline Captions**:
  - Rewrote ExtendScript `placeOverlay` track selection and placement algorithm.
  - Existing caption clips outside the rendered range on the target track are 100% preserved.
  - Overwrites only caption clips that directly overlap the newly rendered `[start, end]` window.
- **Sequence Timecode In/Out 0-0 Bug**:
  - Fixed time conversion bug where sequence In/Out markers were incorrectly read as `0 - 0` in certain Premiere Pro timebases.
- **Zero Skipped Sentences**:
  - Fixed Whisper boundary dropping and segment alignment to ensure zero dropped words or sentences across silence gaps.
- **Speech-Accurate Sentence Timing**:
  - Eliminated artificial gaps between continuous speech phrases while ensuring clean clearing during natural pauses.
- **Horizontal Position Drift**:
  - Fixed bug where resizing caption box width caused `box_x` to shift unexpectedly off-center.
- **Low Disk Space & Failure Handling**:
  - Added proactive disk-space checks, non-destructive fallback warnings, and sanitized temporary path generation for frame exports.

---

## [2.0.0] - 2026-10-12

### Captions Studio 2.0 & Review Assistant

### Added
- **WYSIWYG Captions Canvas**:
  - Real-time HTML5 Canvas renderer with word-level highlight tracking and smooth bezier interpolation.
  - Support for multi-line balanced typography, word wrapping, safe zones, and custom aspect ratios (16:9, 9:16, 1:1, 4:5).
- **Animation Presets**:
  - Added Pop, Fade, Bounce, Karaoke, and Classic subtitle animations with customizable speed and easing.
- **Multi-Language & Bidi Support**:
  - Full RTL layout and Nastaliq typography support for Urdu and Arabic script rendering.
- **Review & Cut Assistant**:
  - Token-containment clustering and retake detection.
  - Script-aligned rough cut planner and EDL export into Premiere Pro.
- **One-Click Installer (`EditFlowAI.bat`)**:
  - Automated PowerShell/Batch bootstrap script that configures Python, installs dependencies, and symlinks the CEP panel.

---

## [1.0.0] - 2026-06-01

### Initial Release

- Core FastAPI backend server running on `localhost:8765`.
- Premiere Pro CEP panel extension integration via CSInterface bridge.
- Local faster-whisper transcription engine integration.
- ExtendScript automation for project item inspection, cut planning, and track placement.
