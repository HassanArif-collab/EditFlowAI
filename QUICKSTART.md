# EditFlow AI — Quick Start Guide

## What is this?

EditFlow AI is a panel inside Adobe Premiere Pro that adds **Native Animated Captions** — word-by-word captions that pop in, fade in, or bounce in, like Hormozi-style videos.

---

## Installation (One Click)

### Step 1: Download the installer

Download this file to your computer:

**➡️ [install-editflow.bat](https://raw.githubusercontent.com/HassanArif-collab/EditFlowAI/feat/native-animated-captions/install-editflow.bat)**

(Right-click the link → "Save link as..." → save to your Desktop)

### Step 2: Run the installer

**Double-click** `install-editflow.bat` on your Desktop.

A black window will open and start installing everything automatically. It will:
- Download EditFlow AI
- Set up Python and all dependencies
- Link the panel into Premiere Pro
- Create a desktop shortcut

**This takes 5–10 minutes.** Just wait — don't close the window until it says "Installation Complete!"

### Step 3: Start using it

1. **Double-click the "EditFlow AI" shortcut** on your Desktop
   - A black window opens — leave it running (this is the backend)
2. **Open Adobe Premiere Pro**
3. Go to **Window → Extensions → EditFlow AI**
4. Click the **💬 speech bubble icon** in the panel header

---

## First Time: Download a Whisper Model

The first time you use the captions feature, you need to download a Whisper model (for transcription):

1. In the EditFlow AI panel, click the **⚙️ gear icon** (top right)
2. Go to the **Whisper** section
3. Click **Download** next to one of these:
   - **`small`** — best for English, ~466 MB, fast
   - **`medium`** — best for multilingual, ~1.5 GB, slower
4. Wait for the download to finish (5–15 minutes)
5. Click **Set Active** on the model you downloaded

You only do this once. The model stays on your computer for future use.

---

## Using Native Animated Captions

Once you have a Whisper model installed:

1. Open your sequence in Premiere Pro
2. Position the playhead and press **`I`** (In point) at the start of the section you want captioned
3. Move the playhead and press **`O`** (Out point) at the end
4. In the EditFlow AI panel, click the **💬** icon to open Native Animated Captions
5. Click **"Extract & Transcribe"** — this exports the audio and transcribes it
6. **Wait** — transcription takes 1–5 minutes depending on the length
7. Once words appear, choose an animation preset:
   - **Fade-in** (most reliable — works on all Premiere versions)
   - **Pop-in** (Hormozi style — recommended)
   - **Bounce** (experimental)
8. **Recommended:** Click **"Run Probe"** first to verify your Premiere version supports all the APIs
9. Click **"Smoke Test (1 word)"** to test with one word
10. If the smoke test works, click **"Generate All"** to place all captions

The captions appear as native text layers on your timeline — fully editable in Premiere's Effect Controls!

---

## Troubleshooting

### "Extract & Transcribe" fails

This usually means the audio export preset is missing. See:
```
C:\EditFlowAI\cep-panel\templates\audio\README.md
```
for instructions to create a `.epr` file. OR the fallback `"WaveAudio"` preset may work on your Premiere version — try clicking Extract again.

### Whisper model download is slow

This is normal. The models are 466 MB (small) to 1.5 GB (medium). Once downloaded, they're cached on your computer forever.

### Panel says "Backend not running"

1. Make sure the black "EditFlow AI Backend" window is still open
2. If you closed it, double-click the **EditFlow AI** desktop shortcut again
3. Reload the panel: close and reopen it in Premiere Pro (Window → Extensions → EditFlow AI)

### Captions don't appear on the timeline

1. Run the **Diagnostic Probe** in the Native Captions panel — it will tell you exactly what's wrong
2. Check that the playhead was in an empty area of the timeline when you ran the probe
3. If the probe shows errors, screenshot the report and share it for help

### Panel shows old code after an update

1. Close Premiere Pro
2. In your browser, go to: http://127.0.0.1:8765/api/ping — should say `{"server":"running"}`
3. If not running, double-click the desktop shortcut
4. Reopen Premiere Pro and the panel

---

## Uninstalling

To remove EditFlow AI completely:

1. Close Premiere Pro
2. Go to `C:\EditFlowAI\`
3. Double-click **`uninstall-editflow.bat`**

This removes the panel link, shortcuts, and install directory. Your transcripts and data (in `C:\EditFlowAI\data\`) are preserved in case you reinstall.

---

## Updating

To update to the latest version:

1. Close Premiere Pro and the backend window
2. Re-download and run `install-editflow.bat` — it will back up your old install and set up the new one
3. Your Whisper models and transcripts in `C:\EditFlowAI\data\` are preserved (the installer backs up the whole folder)

---

## Where things live

| What | Path |
|---|---|
| Install directory | `C:\EditFlowAI\` |
| Whisper models | `C:\EditFlowAI\data\hf-cache\` |
| Transcripts cache | `C:\EditFlowAI\data\media_cache\` |
| Audio mixdowns | `C:\EditFlowAI\data\media_cache\mixdowns\` |
| Backend log | `C:\EditFlowAI\data\backend.log` |
| Diagnostic logs | `C:\EditFlowAI\data\logs\` |
| Panel link | `%APPDATA%\Adobe\CEP\extensions\com.editflow.ai\` |
| Desktop shortcut | Desktop → "EditFlow AI.lnk" |

---

## Need help?

If something doesn't work:

1. Run the **Diagnostic Probe** in the Native Captions panel — it tells us exactly what's wrong
2. Take a screenshot of the probe results
3. Take a screenshot of any error messages
4. Check the backend log at `C:\EditFlowAI\data\backend.log`
