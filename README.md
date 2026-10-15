# EditFlow AI

> **AI-Powered Adobe Premiere Pro Assistant: Captions Studio 3.0 & Intelligent Video Editor**

EditFlow AI is a high-performance, local-first workflow extension for Adobe Premiere Pro (2023–2026). It integrates automated speech transcription, intelligent retake analysis, script-aligned rough cutting, and a modern WYSIWYG animation engine for word-by-word animated captions.

---

## What's New in Version 3.0 (Captions Studio 3.0)

- **Timeline In/Out Scope Selection**: Transcribe and generate captions for specific timeline ranges using Premiere sequence In/Out markers.
- **Section-by-Section Workflow**: Overlays placed on the timeline start at the exact in-point (`tStart`) without leading blank frames, preserving all existing earlier and later captions.
- **Media Offline Protection**: Output video renders are permanently preserved on disk, preventing "Media Offline" issues.
- **Natural Timeline Audio Playback**: In-panel preview plays timeline audio matching the clip volume faders and unmuted tracks set in Premiere Pro.
- **Center-Pinned Box Resizing & Center Snap**: Freely resize both width and vertical height with center-anchored scaling and snap to 50% midpoint.
- **Sequence Video Frame Preview**: Preview captions overlaid directly on top of the actual video frame at your playhead position.
- **Smart Punctuation Controls**: Switch between Full, Soft, None, No-Dots mode, or customize individual punctuation marks.
- **Zero Skipped Sentences**: Speech-accurate sentence grouping eliminates word drops and unnatural pauses.

See the complete release notes in [CHANGELOG.md](file:///C:/Users/Hassan%20Arif/.gemini/antigravity/worktrees/EditFlowAI/fix_transcription_cache_bug/CHANGELOG.md).

---

## Features

### 1. Captions Studio
- **WYSIWYG Real-Time Preview**: Fast 60fps HTML5 Canvas playback with word-by-word highlights.
- **Rich Animation Presets**: Pop, Fade, Bounce, Karaoke, and Classic subtitle animations.
- **Typography & Layout**: Font selection, tracking, leading, stroke/outline, box background, padding, and safe margin zones.
- **Multi-Language Support**: Seamless rendering for Latin scripts, right-to-left (RTL) Arabic, and Urdu Nastaliq typography.
- **ProRes / QuickTime Overlay Export**: One-click export that automatically renders transparent video overlays and places them onto Premiere Pro video tracks without rippling cuts.

### 2. Review & Rough Cut Assistant
- **Local Whisper Transcription**: Powered by `faster-whisper` (CTranslate2) running locally with zero cloud API dependencies.
- **Retake Detection**: Identifies bad takes and repeated phrases using token-containment clustering.
- **Script Matching & EDL Cuts**: Aligns spoken words against your script, generates cut plans, and applies cuts directly to the Premiere Pro timeline.

---

## System Architecture

```
┌─────────────────────────────────┐           ┌────────────────────────────────────┐
│      Adobe Premiere Pro         │    CEP    │  cep-panel/client/  (Vanilla JS)   │
│  (ExtendScript / CSInterface)   │◄─────────►│  ES modules, Canvas, plain CSS     │
└─────────────────────────────────┘           └──────────────┬─────────────────────┘
                                                             │ HTTP + WebSocket
                                                             ▼
                                              ┌────────────────────────────────────┐
                                              │   backend/  (FastAPI + uvicorn)    │
                                              │   - REST API on localhost:8765     │
                                              │   - SQLite registry & cache        │
                                              └──────────────┬─────────────────────┘
                                                             │
                              ┌──────────────────────────────┼──────────────────────────────┐
                              ▼                              ▼                              ▼
                      ┌───────────────┐              ┌────────────────┐              ┌──────────────┐
                      │  faster-      │              │ ffmpeg         │              │ Ollama / LLM │
                      │  whisper      │              │ (video/audio)  │              │ (Optional)   │
                      └───────────────┘              └────────────────┘              └──────────────┘
```

- **Backend**: Python 3.10+ FastAPI service running locally on `localhost:8765`.
- **Panel**: Adobe CEP HTML5 panel (Chromium/Node.js mixed context) with ES modules and no build step.
- **Premiere Bridge**: ExtendScript (`.jsx`) communicating via Adobe's CSInterface API.

---

## Installation & Setup

### Automatic One-Click Setup (Recommended)

1. Double-click **`EditFlowAI.bat`** in the project root.
2. The setup script will:
   - Verify or install Python 3.10+ (via winget if needed).
   - Create a local virtual environment (`.venv`) and install dependencies.
   - Symlink the CEP panel into Adobe's extension folder (`com.editflow.ai`).
   - Enable CEP debugging in Windows Registry.
   - Start the local backend server.
3. Open Adobe Premiere Pro (2023 or newer).
4. Go to **Window > Extensions > EditFlow AI**.

### Manual Installation (Developers)

1. **Set up Python environment**:
   ```bash
   python -m venv .venv
   .\.venv\Scripts\activate
   pip install -r requirements.txt
   ```

2. **Symlink CEP Panel**:
   ```powershell
   New-Item -ItemType SymbolicLink -Path "$env:APPDATA\Adobe\CEP\extensions\com.editflow.ai" -Target (Get-Item ".\cep-panel").FullName
   ```

3. **Enable PlayerDebugMode**:
   ```powershell
   Set-ItemProperty -Path "HKCU:\Software\Adobe\CSXS.11" -Name "PlayerDebugMode" -Value "1" -Force
   ```

4. **Run Backend Server**:
   ```bash
   .\.venv\Scripts\python.exe run.py --prod
   ```

---

## Versioning & Changelog

This project follows [Semantic Versioning](https://semver.org/):
- **v3.0.0** (Current): Captions Studio 3.0 — timeline In/Out scope, natural audio levels, vertical box resize, offline media protection, zero skipped sentences.
- **v2.0.0**: Captions Studio 2.0 — WYSIWYG animation canvas, word-level timing, Review & Cut Assistant.
- **v1.0.0**: Initial release — FastAPI backend, Whisper integration, and Premiere Pro panel.

For detailed changes, refer to [CHANGELOG.md](file:///C:/Users/Hassan%20Arif/.gemini/antigravity/worktrees/EditFlowAI/fix_transcription_cache_bug/CHANGELOG.md).

---

## Roadmap: Performance & Lightweight Footprint

We are actively streamlining EditFlow AI to ensure it runs ultra-fast and lightweight without bogging down system resources:
- Background process memory and CPU consumption throttling.
- Lightweight on-demand Whisper model loading and unloading.
- Streamlined one-click installer and dependency footprint.
