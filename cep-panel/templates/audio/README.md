# Audio Export Presets

This directory holds bundled Premiere Pro export preset (`.epr`) files used by
the Native Animated Captions feature.

## Required: `audio_mixdown_wav.epr`

Used by `cep-panel/extendscript/sequence_audio.jsx::extractSequenceAudio()`
to export the active sequence's audio between In/Out points to a WAV file
for Whisper transcription.

### How to create this file

1. Open Premiere Pro (any version 2022+)
2. File → Export → Media
3. Set Format to **Wave**
4. Configure audio settings:
   - Sample Rate: **48000 Hz**
   - Sample Size: **16 bit**
   - Channels: **Stereo**
   - Interleave: 1 frame
5. Click the **Preset** dropdown → **Save Preset** → name it `audio_mixdown_wav`
6. Find the `.epr` file on disk:
   - **Windows:** `%APPDATA%\Adobe\Premiere Pro\<version>\Presets\audio_mixdown_wav.epr`
   - **macOS:** `~/Library/Application Support/Adobe/Premiere Pro/<version>/Presets/audio_mixdown_wav.epr`
7. Copy it to this directory: `cep-panel/templates/audio/audio_mixdown_wav.epr`

### Fallback if the .epr is missing

`sequence_audio.jsx` will fall back to trying the literal string `"WaveAudio"`
as the preset name, which works on some Premiere versions. If that also fails,
the panel will show an error asking the user to create the .epr file.
