# Testing

The test suite exists for two reasons: (1) you can run it on Linux without Whisper models or ffmpeg installed, and (2) the developer running it on Windows with Premiere can layer integration verification on top. The tiers below are what makes that work.

---

## The four tiers

| Tier | Where it runs | Models? | FFmpeg? | Premiere? | Command |
|---|---|---|---|---|---|
| **unit** | Linux / Windows / CI | No | No | No | `pytest tests/unit -v` |
| **integration-mock** | Linux / Windows / CI | No (mocked) | No | No | `pytest tests/integration -v -m "not real_models"` |
| **integration-real** | Windows (or Linux with installed deps) | Yes (`tiny`) | Yes | No | `pytest tests/integration -v -m real_models` |
| **manual** | Windows + Premiere | Yes | Yes | Yes | See checklist in this doc |

**GLM should make tiers 1 + 2 pass before pushing.** The repo owner runs tier 3 locally and the manual checklist before merging anything panel-facing.

---

## Tier 1 — Unit

Pure functions. No I/O. No network. No subprocess. Should run in < 5 seconds for the whole tier.

**What goes here:**
- Parser logic (`backend/services/agent/parser.py`)
- Path / fingerprint helpers (`backend/services/media_fingerprint.py`)
- Envelope shape validation in tools
- Session state mutations (`backend/services/agent/session.py`)
- Cut planner math (`backend/services/cut_planner.py`)
- Script matcher math (`backend/services/script_matcher.py`)
- Bin resolver string matching

**What does NOT go here:**
- Anything that imports `faster_whisper`, `httpx`, `subprocess`, or `huggingface_hub`
- Anything that reads `data/` or `~/.cache/`
- Anything that needs a running FastAPI app

The existing `tests/test_mvp_*.py` files are in unit-tier shape already. They live at `tests/` root rather than `tests/unit/` for historical reasons — when you add new ones, put them in `tests/unit/` and we can migrate the rest gradually (Rule 3 — don't refactor what works).

**Pattern:**
```python
# tests/unit/test_session_context.py
from backend.services.agent.session import AgentSession

def test_update_context_from_tool_handles_data_none():
    """Regression test for the AttributeError on init.
    
    When scan_project_tool returns data=None (the actual scan happens
    on the frontend), _update_context_from_tool used to crash on
    result.get('data', {}).get('scan') because dict.get returns the
    stored None, not the default. See commit 21647f7.
    """
    s = AgentSession(id='test')
    result = {'tool': 'scan_project', 'success': True, 'data': None}
    s.append_tool_call('scan_project', {}, result)  # must not raise
    assert s.context.get('scan_result') is None
```

Each unit test should reference the commit / bug it documents in the docstring. This turns the test file into a working catalog of "things we've broken before."

---

## Tier 2 — Integration-mock

The backend running, routes wired, but external systems (Ollama, Whisper, ffmpeg, Premiere) are mocked. Tests use `httpx.AsyncClient` against the FastAPI app via ASGI transport.

**What goes here:**
- End-to-end agent turns: scan_completed → list_bins → resolve_clips → transcribe (with mocked whisper)
- Whisper admin endpoints (`/api/whisper/status`, `/api/whisper/set-model`) against a tmp HF cache directory with fake snapshot files
- Provider service routing (mock the LLM HTTP, verify request shape)
- The WS broadcast contract — assert that the panel receives the expected events

**Setup pattern:**
```python
# tests/integration/conftest.py
import pytest
from unittest.mock import AsyncMock
from backend.services.whisper_service import whisper_service

@pytest.fixture(autouse=True, scope="function")
def mock_whisper(monkeypatch):
    """Replace whisper_service.transcribe_fingerprinted with an AsyncMock
    that returns a deterministic TranscriptResult. Use this for any test
    that walks the agent path through transcribe_clips_tool."""
    from backend.models.schemas import TranscriptResult
    fake = TranscriptResult(
        source_file="test.wav", language="en", duration=10.0,
        segments=[], full_text="hello world",
    )
    monkeypatch.setattr(
        whisper_service, "transcribe_fingerprinted",
        AsyncMock(return_value=fake),
    )
```

**The agent pipeline test that would have caught half the bugs in this branch:**
```python
# tests/integration/test_agent_pipeline.py
import pytest
from httpx import AsyncClient, ASGITransport
from backend.main import app

@pytest.mark.asyncio
async def test_full_agent_flow_with_mock_whisper(mock_whisper):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # 1. POST premiere context (fake bins/clips)
        await ac.post("/api/premiere/context", json={
            "items": [{"name": "IMG.MOV", "path": "/tmp/test.mov", ...}],
            "bins": [{"name": "B", "items": ["IMG.MOV"]}],
            "sequences": [],
        })

        # 2. Init turn — agent should emit a scan request
        r = await ac.post("/api/agent/turn", json={
            "session_id": "test-session", "event": "init", "payload": {},
        })
        assert r.status_code == 200
        # Assert the agent_text mentions scanning
        # ...
```

Set a `@pytest.mark.asyncio` and `pytest-asyncio` will drive it. Add `pytest-asyncio` to dev deps if not already.

**Markers:** Anything in `tests/integration/` that does NOT need real models is the default. Tests that DO need them are marked `@pytest.mark.real_models` (see Tier 3).

---

## Tier 3 — Integration-real

Real Whisper, real ffmpeg, real audio file. Heavy. Slow. Doesn't run in CI by default. Use the smallest model (`tiny`, 75 MB) so the download is tolerable.

**What goes here:**
- One smoke test that transcribes `tests/fixtures/short_speech.wav` (5-10 sec audio) with `tiny` and asserts segments came out non-empty
- ffmpeg path detection on a system with ffmpeg installed
- The `_largest_incomplete_blob_mb` polling helper against a real (small) download

**The fixture builder is already in place:** `tests/fixtures/build/build_short_tts.py` synthesizes test audio from a TTS backend. The output WAV checks into `tests/fixtures/`. Re-running the builder is rare; the WAV is the artifact tests consume.

**Marker:**
```python
import pytest

@pytest.mark.real_models
def test_tiny_transcribe_smoke():
    """End-to-end transcribe with the tiny model. ~30 s on CPU."""
    from backend.services.whisper_service import whisper_service
    whisper_service.set_active_model("tiny")
    # ...
```

Register the marker in `pytest.ini`:
```ini
[pytest]
markers =
    real_models: requires Whisper model + ffmpeg on disk (slow)
asyncio_mode = auto
```

**How CI handles this:** default `pytest` invocation filters out `real_models` via `-m "not real_models"`. A separate (manual or nightly) job runs `-m real_models` on a runner that has the deps cached.

---

## Tier 4 — Manual checklist

Things only a human in front of Premiere can verify. **Run before merging anything panel-facing.**

### Smoke (every PR)
- [ ] Backend starts cleanly: `python run.py` shows `Provider 'ollama-local': connected` and a real ffmpeg path in the logs
- [ ] Panel opens in Premiere, header shows the new `BUILD_TAG`
- [ ] Settings opens, dropdown lists Whisper models, picking one updates the help text without snap-back
- [ ] Chat: typing "hello" gets a real LLM reply (proves provider routing + WS)
- [ ] No console errors in the panel dev tools

### Transcribe path (any change to whisper/agent/tools)
- [ ] Open the test Premiere project (`TestingOfEditFlow.prproj`)
- [ ] Type "yes please" → agent calls scan, lists the bin, resolves the clip
- [ ] Progress card renders in chat with the right clip count
- [ ] Progress card ticks (the `detail` text updates from "Starting..." to "Transcribing... XX%")
- [ ] Transcript appears in chat after completion
- [ ] Transcript file shows up in `data/media_cache/transcripts/<fingerprint>.json`
- [ ] Second transcribe of the same clip is instant (cache hit logged)

### Settings (any change to whisper_admin or settings.js)
- [ ] Switching models persists across backend restart (check `data/whisper_config.json`)
- [ ] "Set & preload" on an uninstalled model shows a download progress bar
- [ ] "Set & preload" on an installed model: NO progress bar (silence is correct)
- [ ] Adding a provider works, can be tested, persists across restart

### Cuts (any change to cut planner / apply)
- [ ] Plan card renders with proposed cuts, durations, source file paths
- [ ] "Approve" button triggers ExtendScript dispatch
- [ ] Premiere timeline reflects the cuts (visual check)
- [ ] "Regenerate" with a hint produces a new plan

---

## What to write for a new feature

When adding a feature, the test debt looks like this:

| Layer | Tests required |
|---|---|
| A pure function / helper | 1 unit test (happy + 1 edge case) |
| A new tool in `agent/tools.py` | 1 unit test of the envelope shape + 1 integration-mock test through `/api/agent/turn` |
| A new HTTP route | 1 integration-mock test per status code branch (200, 4xx, 5xx) |
| A new WS event type | 1 integration-mock test asserting the event is broadcast, + manual verification on the panel |
| A behavior change to Whisper | 1 unit test + 1 tier-3 smoke if the change affects loading / inference |

This is the floor, not the ceiling. Don't add 12 tests for a 10-line change — diminishing returns. Rule 7: tests verify INTENT. A test that can't fail when the business logic changes is wrong.

---

## Running tests locally

```bash
# All tiers 1 + 2 (fast, no models)
pytest -m "not real_models" -v

# Just unit
pytest tests/unit -v
pytest tests/test_mvp_*.py -v   # legacy unit-style tests

# Including tier 3 (slow, needs model download on first run)
pytest -m "real_models" -v

# A single file
pytest tests/integration/test_agent_pipeline.py -v

# With coverage
pytest --cov=backend --cov-report=term-missing -m "not real_models"
```

On Windows from PowerShell, prefix with `python -m`:
```powershell
python -m pytest -m "not real_models" -v
```

---

## Test data hygiene

- Test fixtures (WAVs, fake Premiere project JSON, sample transcripts) live in `tests/fixtures/`.
- **Generated** fixtures (synthesized audio) go into `tests/fixtures/build/` — those scripts produce the WAV files checked into `tests/fixtures/`.
- Tests must NOT write to `data/` — use `tempfile.TemporaryDirectory()` for any disk-touching test. The fixture-mode env var (`EDITFLOW_TEST_MODE=true`) is set inside `tests/test_phase_b.py` for the same reason; if a test needs to bypass a safety guard, prefer setting that env var via `monkeypatch.setenv` rather than touching globals.

---

## What GLM should NOT do

- **Don't add tests just to inflate coverage.** A test that passes for the wrong reason is worse than no test (Rule 7).
- **Don't mock things that are easy to use real.** If a function takes a `Path` and reads from it, use a `tmp_path` fixture. Mock the layer above only when the real dependency is slow or external.
- **Don't introduce `pytest-mock`, `responses`, or other "fake" libraries** unless an existing test already uses them. Stick with `unittest.mock` + `monkeypatch` to keep the test deps minimal.
- **Don't write integration tests that depend on test order.** Use `tmp_path` and clean fixtures so any test can run in isolation.
- **Don't add a test that requires a specific machine's directory layout.** Use relative paths from the repo root or `tmp_path`.

---

## CI (when it exists)

There's no CI configured yet. When we add GitHub Actions:

```yaml
# .github/workflows/test.yml
name: tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: pip install -r requirements.txt pytest pytest-asyncio
      - run: pytest -m "not real_models" -v
```

The `ubuntu-latest` runner can't run Premiere or test the panel JS. That's fine — the unit + mock tiers catch ~80% of backend bugs without it. Real-model tests stay off the default CI path; if we want them, add a manual workflow trigger.

---

## Reference: which bugs each tier would have caught

Real bugs from this branch's history, mapped to the tier that would have prevented them.

| Bug | Tier that would have caught it |
|---|---|
| `ProgressReporter("transcribe", client_id=...)` set `task_id` not `task_type` (5b58a4f) | Unit: assert `ProgressReporter("foo").task_type == "generic"` |
| `result.get("data", {}).get("scan")` crashed on `data=None` (21647f7) | Unit: feed `data=None` to `_update_context_from_tool` |
| Bare-filename `clip_paths` failed FileNotFoundError (177dd6e) | Unit: `_recover_clip_path("IMG.MOV", session)` |
| `set_active_chat(model="")` silently cleared the active model (5bdfb87) | Unit: assert empty-string rejected |
| Agent loop 500s on unhandled exception in tool dispatch (fe137c7) | Integration-mock: assert `/api/agent/turn` returns 200 with `agent_text` |
| Whisper progress events have wrong `task_type` (5b58a4f) | Integration-mock: subscribe to WS, assert event shape |
| `_is_model_installed` reports True for metadata-only dir (ff004f8) | Unit: feed a tmp_path with only metadata files, expect False |
| Selector reverted to medium on dropdown change (f47eec4) | Manual checklist (this one is real frontend behavior) |
| Cache redirect not taking effect (f47eec4) | Unit: assert `HF_HUB_CACHE` env var is set before importing backend |
| CEF caches stale `agent-client.js` (8996478) | Manual checklist + the cache-busting convention in PLATFORM.md |

Eleven bugs. **Seven could have been caught by Tier 1 unit tests** that take <100 LOC total to write. That's the single highest-leverage thing GLM can do as a first task.
