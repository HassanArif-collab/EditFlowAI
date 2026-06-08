# Platform Notes

EditFlow runs on the developer's **Windows** machine (Premiere Pro is the integration target). Code is often written and tested on **Linux** (CI, cloud dev environments, GLM). This document is the cheat sheet for keeping both working.

The fundamental rule: **everything that touches the filesystem, processes, or HuggingFace cache must work on both**. The CEP/Premiere integration is Windows-only by definition (Adobe ships CEP on macOS too, but this project hasn't been verified there) — so anything explicitly under `cep-panel/`, the install scripts, and the ExtendScript layer can assume Windows.

---

## What's Windows-only (don't run on Linux)

| Path / artifact | Why |
|---|---|
| `install_cep.sh`, `install_cep_junction.ps1`, `deploy_cep_admin.ps1` | Install the CEP panel into Adobe's extension directory. PowerShell calls + Windows registry. |
| `data/tools/ffmpeg-*/bin/ffmpeg.exe` | The bundled ffmpeg the user downloaded. Linux installs `ffmpeg` system-wide. |
| `cep-panel/host/index.html` ExtendScript path resolution | Maps Premiere project URIs via Windows path conventions. |
| `backend/config.py::_resolve_ffmpeg_path()` checks under `LOCALAPPDATA`, `C:/Program Files/ffmpeg/bin`, `C:/ProgramData/chocolatey/bin` | Windows-specific install location probes. |

Tests that touch these MUST be marked `@pytest.mark.skipif(os.name != 'nt', reason="windows-only")`.

---

## Linux-friendly patterns (use these by default)

These rules cover ~95% of real cases. Code following them runs on both platforms unchanged.

### Filesystem

```python
# YES
from pathlib import Path
data_dir = Path(__file__).resolve().parent.parent / "data"
config_path = data_dir / "whisper_config.json"

# NO
data_dir = "G:\\Tech\\...\\EditFlowAI\\data"
config_path = data_dir + "\\whisper_config.json"
```

`pathlib.Path` handles separators correctly on both OSes. Never concatenate path strings with `+` or use raw `\\`. If you absolutely need a string for a third-party lib that requires it, `str(my_path)` at the call site.

### Process / binary lookup

```python
# YES — checks PATH first, returns None if missing
import shutil
ffmpeg = shutil.which("ffmpeg")

# NO — hardcoded Windows-style invocation
subprocess.run(["C:\\ffmpeg\\bin\\ffmpeg.exe", ...])
```

For ffmpeg specifically, use `settings.FFMPEG_PATH` (the auto-resolved path from `config.py`) — never spawn ffmpeg directly. This way the project's bundled binary works the same as a system install.

### Subprocess

```python
# YES
import subprocess
result = subprocess.run([cmd, "-arg", str(value)], capture_output=True, text=True, check=False)

# NO — shell=True is a footgun on both OSes and especially Windows
result = subprocess.run(f"{cmd} -arg {value}", shell=True)
```

`shell=True` invokes `cmd.exe` on Windows and `sh` on Linux. Different quoting rules, different built-ins. Pass an argv list and skip the shell.

### Environment variables

```python
# YES
import os
cache = os.environ.get("HF_HUB_CACHE", str(default_path))

# NO — PowerShell syntax leaks
cache = "$env:HF_HUB_CACHE"
```

### Line endings

`.gitattributes` enforces LF for `*.py`, `*.js`, `*.css`, `*.md`. Don't fight it. The git client may show CRLF warnings on Windows checkout; that's normal and harmless because the working tree gets CRLF while the repo stores LF.

---

## HuggingFace cache — the trap we've already fallen into

`huggingface_hub` reads `HF_HUB_CACHE` and `HF_HOME` **at import time** and caches them in module-level constants. Any later `os.environ["HF_HUB_CACHE"] = ...` is silently ignored. This bit us hard — the redirect was in `backend/config.py`, but a transitively-imported module pulled `huggingface_hub` first, locking the cache to `~/.cache/huggingface` (C:\ drive on Windows, which was 99% full).

**The fix is in `run.py`:** set both env vars at the top of the file before any backend import. Don't break this ordering. If you add a new entry point, copy the same prologue verbatim.

```python
# CORRECT (this is run.py)
import os
from pathlib import Path
os.environ["HF_HUB_CACHE"] = str(_HF_CACHE)
os.environ.setdefault("HF_HOME", str(_HF_CACHE.parent))
# ... THEN imports that may trigger huggingface_hub
from backend.main import run_server
```

Symlink behavior also differs:
- **Linux**: HF uses symlinks in `data/hf-cache/.../snapshots/` pointing at `blobs/`. Fast.
- **Windows without developer mode**: HF logs a warning and falls back to copying files. Models take 2× the disk space because `model.bin` exists in both `snapshots/<rev>/` and `blobs/`. We tolerate this; don't try to "fix" it without enabling Windows developer mode globally.

`_is_model_installed()` in `whisper_admin.py` handles both layouts (it checks `snapshots/<rev>/model.bin` directly).

---

## CEF cache — the OTHER trap

The CEP panel runs inside Premiere's CEF (Chromium Embedded Framework). CEF aggressively caches HTTP responses, including ES module fetches. **Without cache-busting, fixes to panel JS silently fail to ship — the cached old version keeps running for hours.**

Two defenses, both required:

1. **`Cache-Control: no-store` headers on all `/panel/*` responses.** Implemented as `_NoCacheStatic` in `backend/main.py`. Don't remove it. New responses get the header, but existing cache entries retain whatever Cache-Control they were originally served with (which was the default ≈ "cache forever").

2. **Cache-buster on the dynamic orchestrator import.** `main.js` does `await import('./agent-client.js?v=' + BUILD_TAG)`. Every panel-affecting change MUST bump `BUILD_TAG` in `main.js` AND the `?v=` query in `cep-loader.html`. Without both, CEF serves the cached module without even hitting the server (it doesn't appear in the backend log at all — only way to detect this trap).

Static imports (`import { foo } from './state.js'` at the top of a file) don't get the query string and remain cached. This is fine for stable modules; if you ever change `state.js` or `api.js`, the user needs to clear CEF cache manually. The no-store header prevents this from recurring — after one cycle, subsequent fetches always revalidate.

If GLM is testing the panel via a regular browser at `http://localhost:8765/panel/cep-loader.html`, the same caching rules apply. Hard-refresh (Ctrl+Shift+R) bypasses everything.

---

## Path separator pitfalls in JSON / API payloads

Premiere's ExtendScript hands back paths in OS-native form. On Windows that means `G:\YT Videos\...\IMG_1694.MOV` with backslashes. When this goes into JSON, the backslashes serialize fine. When the backend reads it and passes it to ffmpeg, it works because ffmpeg accepts both separators on Windows.

The trap: **don't manually do `replace('\\', '/')` "to normalize"**. It breaks UNC paths (`\\server\share\file`) and is unnecessary. `pathlib.Path` handles all this correctly when you let it.

The agent's `_recover_clip_path()` does compare path suffixes case-insensitively because Windows filesystems are usually case-insensitive but the JSON casing isn't guaranteed.

---

## Ollama on different OSes

The Ollama daemon listens on `http://localhost:11434` on both platforms. The model storage location differs but `provider_service.py` doesn't care — it just talks HTTP to `/api/tags` and `/api/chat`. No platform-specific code needed.

Cloud-suffixed models (`gemma4:31b-cloud`) require an Ollama account; they fail with 404 if the user isn't logged in. `_resolve_model_for_provider()` filters these out by default — see commit `5bdfb87`.

---

## Quick "does this run on Linux?" mental checklist

Before opening a PR, ask:

1. Any hardcoded `C:\` or `\\` in the diff? (`grep -r 'C:\\\\\|\\\\\\\\' your_changes`)
2. Any `.exe` suffix outside `data/tools/`?
3. Any `subprocess` call with `shell=True`?
4. Any `pathlib` operation chained against a string? (`"foo" + path`)
5. Any new `huggingface_hub`-using import above `run.py`'s env-var setup?
6. Any change to a panel JS module without a `BUILD_TAG` bump?

If "no" to all six, the change is likely cross-platform clean. If "yes" to any, add a test (or a `pytest.skipif`) before merging.

---

## Reference: where each platform truth lives in code

| Concept | File / line |
|---|---|
| ffmpeg path resolution (PATH → bundled → winget → choco) | `backend/config.py::_resolve_ffmpeg_path` |
| HF cache env-var redirect | `run.py` lines 10–25, `backend/config.py` lines 18–32 |
| CEF no-store headers | `backend/main.py` `_NoCacheStatic` class |
| Module cache-buster | `cep-panel/client/src/main.js::_loadOrchestrator` |
| OS-aware path suffix matching | `backend/services/agent/tools.py::_recover_clip_path` |
| Windows-only install scripts | `install_cep_junction.ps1`, `deploy_cep_admin.ps1` |
| Linux-only install script | `install_cep.sh` (largely a stub; CEP doesn't run on Linux) |
